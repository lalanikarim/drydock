// Phase 2 battery — Gate G4: evidence complete on the PR; exactly-once merge
// across a mid-approval SIGKILL (production entrypoint).
//
// The factory runs as a CHILD PROCESS of this battery (factory/main.ts, via
// gates/lib.ts spawnInstance) so the battery can SIGKILL it and restart it
// over the same durable store. The battery is the human driver: it reads
// pending approval keys from GET /approvals and records decisions via
// POST /approvals/<key> (same durable-decision mechanism as Telegram buttons).
//
//   T1 happy    — merge directive -> review gate -> evidence on PR -> merge_pr
//                 blocks -> approve -> retry -> merged; verify exactly one merge
//                 commit landed and the durable decision is recorded.
//   T2 crash    — same flow, but SIGKILL while the merge approval is pending ->
//                 restart over the SAME store -> pending key survives -> approve
//                 -> retry -> merged exactly once.
//
// D2 note: single-use consumption was dropped upstream (per-arg keys + verified
// PR-state idempotency). The old "approvalConsumed" check is replaced by a
// durable-decision record check (GET /approvals/<key>); exactly-once is proven
// by verifySingleMerge.
//
// #47 adds a second assertion on the same mechanism: because approval keys hash the tool
// arguments, merge_pr's headSha argument makes the human decision byte-scoped. This battery now
// fails if the pending approval does not name the commit whose evidence was verified — previously
// the only protection against approving H1 and landing H2 lived here, in the harness, and covered
// nothing outside it.
//
// Targets existing draft PRs from G2/G3 (no worker re-run): by default issue #4
// (PR #9) for T1 and issue #2 (PR #7) for T2; override with G4_T1_ISSUE /
// G4_T2_ISSUE. NOTE: passing this gate MERGES the target PRs on the fixture
// repo — retarget once a default has already been merged by an earlier run.
//
// G4_MODE=work re-runs the full chain (worker -> review -> draft PR -> merge)
// instead of targeting an existing branch directly; use it when the target
// branch is stale/conflicting with main. Default: merge.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, api, postTask, waitForApproval, decideApproval } from "./lib.ts";
import { checkEvidenceBody, REVIEW_PASS_RE, VERIFICATION_PASS_RE } from "../factory/pr-evidence.ts";


const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

loadFactoryEnv();

const REPO = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const GH_ENV = { ...process.env, GH_TOKEN: process.env.FACTORY_GITHUB_TOKEN ?? "" };
const T1_ISSUE = Number(process.env.G4_T1_ISSUE ?? 4);
const T2_ISSUE = Number(process.env.G4_T2_ISSUE ?? 2);
const MODE = process.env.G4_MODE === "work" ? "work" : "merge";
const WAIT_APPROVAL_MS = 25 * 60 * 1000;
const WAIT_MERGED_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function prInfo(n) {
  const out = await sh("gh", ["pr", "view", String(n), "--repo", REPO, "--json", "number,state,isDraft,url,mergeCommit,headRefOid,body"], { env: GH_ENV });
  return JSON.parse(out);
}

/** The PR currently tracking a head branch (merged preferred, else open).
 *  Tracking by branch — not number — because rework replaces the branch tip
 *  and may create a new PR for the same head. */
async function prForHead(branch) {
  const out = await sh("gh", ["pr", "list", "--repo", REPO, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url,headRefOid,mergeCommit,body"], { env: GH_ENV });
  const list = JSON.parse(out || "[]");
  return list.find((p) => p.state === "MERGED") ?? list.find((p) => p.state === "OPEN") ?? null;
}

async function waitMergedForHead(branch, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await prForHead(branch);
    if (pr && pr.state === "MERGED") return pr;
    await sleep(10_000);
  }
  throw new Error(`no merged PR for ${branch} within ${timeoutMs / 1000}s`);
}

/** Exactly-once merge verification on a fresh clone: between preMainSha and the
 *  new origin/main there must be exactly one merge commit and exactly one
 *  non-merge commit, which must be the PR's head. */
async function verifySingleMerge({ preMainSha, expectedHeadSha }) {
  const tmp = mkdtempSync(join(tmpdir(), "g4-verify-"));
  try {
    const authUrl = process.env.FACTORY_GITHUB_TOKEN
      ? `https://x-access-token:${process.env.FACTORY_GITHUB_TOKEN}@github.com/${REPO}.git`
      : `https://github.com/${REPO}.git`;
    await sh("git", ["clone", "--quiet", authUrl, tmp]);
    const merges = (await sh("git", ["-C", tmp, "rev-list", "--merges", `${preMainSha}..origin/main`])).split("\n").filter(Boolean);
    const nonMerges = (await sh("git", ["-C", tmp, "rev-list", "--no-merges", `${preMainSha}..origin/main`])).split("\n").filter(Boolean);
    return {
      ok: merges.length === 1 && nonMerges.length === 1 && nonMerges[0] === expectedHeadSha,
      mergeCommits: merges.length,
      nonMergeShas: nonMerges,
      expectedHeadSha,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}


// Evidence sections and pass regexes come from factory/pr-evidence.ts — production's contract, not a copy
// kept in sync by hand. A local list here drifted from the emitted heading and turned three completed,
// correctly-merged runs into red gates on 2026-11-02.
async function checkEvidence(pr) {
  const body = pr.body ?? "";
  const { ok, missing } = checkEvidenceBody(body);
  return {
    ok,
    missing,
    reviewPass: REVIEW_PASS_RE.test(body),
    testCounts: VERIFICATION_PASS_RE.test(body),
  };
}

async function preflight() {
  const problems = [];
  // gh auth; in merge mode both targets must have an open draft PR.
  try {
    await sh("gh", ["pr", "list", "--repo", REPO, "--state", "open", "--json", "number"], { env: GH_ENV });
  } catch (e) {
    problems.push(`gh access failed: ${e.message}`);
  }
  if (MODE === "merge") {
    // --skip-crash means T2 never runs, so its target must not be validated (it used to fail
    // preflight with the default issue #2 even when the crash test was skipped).
    const targets = process.argv.includes("--skip-crash") ? [T1_ISSUE] : [T1_ISSUE, T2_ISSUE];
    for (const issue of new Set(targets)) {
      try {
        const out = await sh("gh", ["pr", "list", "--repo", REPO, "--state", "open", "--head", `agent/issue-${issue}`, "--json", "number"], { env: GH_ENV });
        if (JSON.parse(out || "[]").length === 0) problems.push(`no open draft PR for agent/issue-${issue} — run G2/G3 first`);
      } catch (e) {
        problems.push(`gh access failed: ${e.message}`);
      }
    }
  }
  // Podman + sandbox image (the review gate runs tests in the sandbox).
  try {
    const images = await sh("podman", ["images", "--format", "{{.Repository}}"]);
    if (!images.split("\n").some((l) => l.includes("factory-sandbox"))) problems.push("factory-sandbox image missing — podman build -t factory-sandbox:latest factory/sandbox-image/");
  } catch (e) {
    problems.push(`podman unavailable: ${e.message}`);
  }
  // Inference endpoint reachable.
  try {
    const res = await fetch(`${process.env.OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` } });
    if (!res.ok) problems.push(`inference endpoint unhealthy: HTTP ${res.status}`);
  } catch (e) {
    problems.push(`inference endpoint unreachable: ${e.message}`);
  }
  return problems;
}

async function runMergeFlow({ label, issue, crashAfterPending, mode = "merge" }) {
  const started = Date.now();
  const result = { label, issue, wallSecs: 0, events: [] };
  const ev = (name, extra = {}) => { result.events.push({ at: now(), name, ...extra }); console.log(`[${label}] ${name} ${Object.keys(extra).length ? JSON.stringify(extra) : ""}`); };

  const branch = `agent/issue-${issue}`;
  let instance = await spawnInstance({ repo: REPO, configPath: defaultConfigPath(REPO) });
  try {
    ev("factory-up", { base: instance.base, root: instance.root });

    // Baseline: main sha before the merge; the PR tracking this head branch at
    // start (informational — rework may replace it with a new PR number).
    const prePr = await prForHead(branch);
    result.prNumberAtStart = prePr?.number ?? null;
    const preMainSha = (await sh("gh", ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"], { env: GH_ENV }));
    ev("baseline", { prNumberAtStart: result.prNumberAtStart, preMainSha });

    const directive = mode === "work"
      ? `Work on GitHub issue number: ${issue}.`
      : `Merge pull request for issue number: ${issue}. Read its current head sha with pr_status first, then call merge_pr with that headSha.`;
    await postTask(instance.base, instance.token, directive, `g4-${label}-${mode}`);
    ev(`submitted-${mode}-directive`);

    const pending = await waitForApproval(instance.base, instance.token, "merge_pr", WAIT_APPROVAL_MS);
    result.approvalKey = pending.key;
    ev("approval-pending", { key: pending.key });

    // Evidence must already be on the PR (open_draft_pr refreshed it before the
    // merge gate could block). Resolved by head branch at this point: in work
    // mode the branch was re-pushed on top of current main, so this PR's head
    // is the commit that will land.
    const prNow = await prForHead(branch);
    if (!prNow || prNow.state !== "OPEN") throw new Error(`no open PR for ${branch} after open_draft_pr`);
    result.prNumber = prNow.number;
    result.evidence = await checkEvidence(prNow);
    result.expectedHeadSha = prNow.headRefOid;
    ev("evidence-checked", { prNumber: prNow.number, ok: result.evidence.ok, missing: result.evidence.missing });

    // #47: the pending approval must name the commit whose evidence we just checked. Approval keys
    // hash the tool arguments, so a headSha in args is what turns a human "approve" into "merge THIS
    // commit" instead of "merge whatever this PR points at when the retry finally runs".
    const approvedSha = pending.args?.headSha ?? null;
    if (approvedSha !== result.expectedHeadSha) {
      throw new Error(
        `approval is not bound to the verified commit: pending args headSha=${JSON.stringify(approvedSha)} != verified head ${result.expectedHeadSha}`,
      );
    }
    ev("approval-bound-to-commit", { headSha: approvedSha, key: pending.key });

    if (crashAfterPending) {
      // G4 crash test: SIGKILL while the merge approval is pending.
      const dead = instance;
      dead.child.kill("SIGKILL");
      await new Promise((resolve) => dead.child.once("exit", resolve));
      ev("sigkill-while-pending");

      // Release the killed instance's handles BEFORE re-spawning: its 2 s log-flush interval is
      // only cleared in close(), and an abandoned handle keeps the whole battery process alive —
      // G4 printed "GATE G4: PASS" and then hung for over an hour on 2026-10-28 because of this.
      await dead.close();

      // Restart over the SAME durable store with the same token.
      instance = await spawnInstance({ repo: REPO, configPath: defaultConfigPath(REPO), root: dead.root, token: dead.token });
      ev("factory-restarted", { base: instance.base });

      const survived = await waitForApproval(instance.base, instance.token, "merge_pr", 5 * 60 * 1000);
      if (survived.key !== pending.key) throw new Error(`pending key changed across restart: ${pending.key} -> ${survived.key}`);
      result.crashSurvived = true;
      ev("approval-state-survived-restart", { key: survived.key });
    }

    // Fail CLOSED before approving: the commit whose evidence we verified must still be the PR head.
    // Our own open_draft_pr force-pushes onto current main, so a draft left open while main moves
    // gets rewritten between verification and merge — observed 2026-10-28 on stale drafts for
    // issues #35/#18: exactly-once merge held, but the commit that landed was NOT the one whose
    // evidence had been checked (the old head is now unreferenced). Approving a rewrite we never
    // verified would make the approval meaningless, so refuse and require re-verification.
    const preApprove = await prForHead(branch);
    if (!preApprove || preApprove.headRefOid !== result.expectedHeadSha) {
      throw new Error(
        `PR head changed after evidence verification (${result.expectedHeadSha} -> ${preApprove?.headRefOid ?? "no open PR"}): `
        + `the branch was rewritten (open_draft_pr rebases onto main). Not approving — re-run G2 against the new head first.`,
      );
    }
    ev("head-still-verified", { headRefOid: result.expectedHeadSha });

    const decided = await decideApproval(instance.base, instance.token, pending.key, "approved", "g4-battery");
    if (decided.status !== 200) throw new Error(`approve failed: ${decided.status} ${JSON.stringify(decided.json)}`);
    ev("approved");

    await postTask(
      instance.base,
      instance.token,
      `The human has APPROVED merge approval key ${pending.key}. Call merge_pr again with exactly { issueNumber: ${issue} } and report the result.`,
      `g4-${label}-retry`,
    );
    ev("submitted-retry");

    const mergedPr = await waitMergedForHead(branch, WAIT_MERGED_MS);
    result.mergeCommit = mergedPr.mergeCommit?.oid ?? null;
    ev("merged", { mergeCommit: result.mergeCommit });

    result.singleMerge = await verifySingleMerge({ preMainSha, expectedHeadSha: result.expectedHeadSha });
    ev("single-merge-verified", { ok: result.singleMerge.ok, ...result.singleMerge });

    if (!crashAfterPending) {
      // Durable-decision check (D2: no single-use consumption — the decision
      // record itself must be durably recorded for this key).
      const a = api(instance.base, instance.token);
      const rec = await a.get(`/approvals/${pending.key}`);
      result.decisionRecorded = rec.status === 200 && rec.json.decision === "approved" && !!rec.json.decidedBy;
      ev("decision-recorded", { ok: result.decisionRecorded, record: rec.json });
    }

    result.pass =
      result.evidence.ok &&
      result.singleMerge.ok &&
      (crashAfterPending ? result.crashSurvived === true : result.decisionRecorded === true);
  } finally {
    await instance.close();
    result.wallSecs = Math.round((Date.now() - started) / 1000);
  }
  return result;
}

const only = process.argv.slice(2).filter((a) => a.startsWith("--"));
const skipCrash = only.includes("--skip-crash");

const problems = await preflight();
if (problems.length) {
  console.error("G4 PREFLIGHT FAILED:\n- " + problems.join("\n- "));
  process.exit(2);
}

const results = { date: now(), repo: REPO, t1: null, t2: null };
const runDir = mkdtempSync(join(tmpdir(), "gates-g4-"));

console.log(`[t1] happy path: issue #${T1_ISSUE} (fresh store, approve -> merge -> verify)`);
results.t1 = await runMergeFlow({ label: "t1", issue: T1_ISSUE, crashAfterPending: false, mode: MODE });
console.log(`[t1] ${results.t1.pass ? "PASS" : "FAIL"} in ${results.t1.wallSecs}s`);

if (!skipCrash) {
  console.log(`[t2] crash: issue #${T2_ISSUE} (SIGKILL while approval pending -> restart -> approve -> merge)`);
  results.t2 = await runMergeFlow({ label: "t2", issue: T2_ISSUE, crashAfterPending: true, mode: MODE });
  console.log(`[t2] ${results.t2.pass ? "PASS" : "FAIL"} in ${results.t2.wallSecs}s`);
}

writeFileSync(join(runDir, "g4-results.json"), JSON.stringify(results, null, 2));
console.log(`results: ${join(runDir, "g4-results.json")}`);
const pass = results.t1?.pass === true && (skipCrash || results.t2?.pass === true);
console.log(`\nGATE G4: ${pass ? "PASS" : "FAIL"} — evidence complete on PR; exactly-once merge across crash`);
process.exitCode = pass ? 0 : 1;
