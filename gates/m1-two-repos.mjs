// Phase 2 / Gate M1 — two repos live: two instances on the same machine each
// complete label → draft PR (evidence complete) → approve → merge exactly once,
// simultaneously. Production entrypoint via gates/lib.ts spawnInstance.
//
// Requires TWO onboarded repos (Phase 3 cutover artifacts):
//   M_REPO_A / M_ISSUE_A  (default: lalanikarim/factory-fixture / 4)
//   M_REPO_B / M_ISSUE_B  (default: unset — the gate refuses to run without it)
//
// NOTE: passing this gate MERGES one PR per repo.
//
// Usage: node --experimental-strip-types gates/m1-two-repos.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, postTask, rootConversationId, waitForToolResult, waitForApproval, decideApproval } from "./lib.ts";
import { checkEvidenceBody } from "../factory/pr-evidence.ts";

// The evidence contract belongs to production, not to this gate: see factory/pr-evidence.ts. A local copy of
// the required-section list drifted from the heading open_draft_pr actually emits and turned three completed,
// correctly-merged runs into red gates on 2026-11-02 (the properties under test — exactly-once merge, isolation
// under SIGKILL, clean budget abort — all passed; the string did not).
const checkEvidence = (pr) => checkEvidenceBody(pr.body);

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

loadFactoryEnv();
const repoA = process.env.M_REPO_A ?? "lalanikarim/factory-fixture";
const issueA = Number(process.env.M_ISSUE_A ?? 4);
const repoB = process.env.M_REPO_B;
const issueB = process.env.M_ISSUE_B ? Number(process.env.M_ISSUE_B) : null;
if (!repoB || !issueB) {
  console.error("M1 requires M_REPO_B and M_ISSUE_B (second onboarded repo) — set them and re-run.");
  process.exit(2);
}
const GH_ENV = { ...process.env, GH_TOKEN: process.env.FACTORY_GITHUB_TOKEN ?? "" };
const WAIT_APPROVAL_MS = 25 * 60 * 1000;
const WAIT_MERGED_MS = 25 * 60 * 1000;



async function prForHead(repo, branch) {
  const out = await sh("gh", ["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url,headRefOid,mergeCommit,body"], { env: GH_ENV });
  const list = JSON.parse(out || "[]");
  return list.find((p) => p.state === "MERGED") ?? list.find((p) => p.state === "OPEN") ?? null;
}

async function waitMergedForHead(repo, branch, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await prForHead(repo, branch);
    if (pr && pr.state === "MERGED") return pr;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`no merged PR for ${branch} within ${timeoutMs / 1000}s`);
}

async function verifySingleMerge({ repo, preMainSha, expectedHeadSha }) {
  const tmp = mkdtempSync(join(tmpdir(), "m1-verify-"));
  try {
    const authUrl = process.env.FACTORY_GITHUB_TOKEN
      ? `https://x-access-token:${process.env.FACTORY_GITHUB_TOKEN}@github.com/${repo}.git`
      : `https://github.com/${repo}.git`;
    await sh("git", ["clone", "--quiet", authUrl, tmp]);
    const merges = (await sh("git", ["-C", tmp, "rev-list", "--merges", `${preMainSha}..origin/main`])).split("\n").filter(Boolean);
    const nonMerges = (await sh("git", ["-C", tmp, "rev-list", "--no-merges", `${preMainSha}..origin/main`])).split("\n").filter(Boolean);
    return { ok: merges.length === 1 && nonMerges.length === 1 && nonMerges[0] === expectedHeadSha };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Full chain on one instance: work -> review gate -> evidence -> approve merge -> merged. */
async function runFullChain({ label, repo, issue }) {
  const started = Date.now();
  const result = { label, repo, issue, pass: false };
  const branch = `agent/issue-${issue}`;
  const instance = await spawnInstance({ repo, configPath: defaultConfigPath(repo) });
  try {
    const preMainSha = (await sh("gh", ["api", `repos/${repo}/commits/main`, "--jq", ".sha"], { env: GH_ENV }));

    await postTask(instance.base, instance.token, `Work on GitHub issue number: ${issue}.`, `m1-${label}-${issue}`);
    const convId = await rootConversationId(instance.base, instance.token);
    const draftText = await waitForToolResult(instance.base, instance.token, convId, "open_draft_pr", (t) => t.includes('"prUrl"') || t.includes('"refused": true'), 25 * 60_000);
    const draft = JSON.parse(draftText.slice(draftText.indexOf("{")));
    if (draft.refused) throw new Error(`review refused: ${JSON.stringify(draft).slice(0, 300)}`);

    const prNow = await prForHead(repo, branch);
    if (!prNow || prNow.state !== "OPEN") throw new Error(`no open PR for ${branch}`);
    result.evidence = checkEvidence(prNow);
    result.expectedHeadSha = prNow.headRefOid;

    const pending = await waitForApproval(instance.base, instance.token, "merge_pr", WAIT_APPROVAL_MS);
    await decideApproval(instance.base, instance.token, pending.key, "approved", "m1-battery");
    await postTask(instance.base, instance.token, `The human has APPROVED merge approval key ${pending.key}. Call merge_pr again with exactly { issueNumber: ${issue} } and report the result.`, `m1-${label}-retry`);

    const mergedPr = await waitMergedForHead(repo, branch, WAIT_MERGED_MS);
    result.mergeCommit = mergedPr.mergeCommit?.oid ?? null;
    result.singleMerge = await verifySingleMerge({ repo, preMainSha, expectedHeadSha: result.expectedHeadSha });
    result.pass = result.evidence.ok && result.singleMerge.ok;
  } finally {
    await instance.close();
    result.wallSecs = Math.round((Date.now() - started) / 1000);
  }
  return result;
}

async function preflight() {
  const problems = [];
  for (const repo of [repoA, repoB]) {
    try {
      await sh("gh", ["api", `repos/${repo}`, "--jq", ".full_name"], { env: GH_ENV });
    } catch (e) {
      problems.push(`gh access to ${repo} failed: ${e.message}`);
    }
  }
  try {
    const images = await sh("podman", ["images", "--format", "{{.Repository}}"]);
    if (!images.split("\n").some((l) => l.includes("factory-sandbox"))) problems.push("factory-sandbox image missing");
  } catch (e) {
    problems.push(`podman unavailable: ${e.message}`);
  }
  try {
    const res = await fetch(`${process.env.OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` } });
    if (!res.ok) problems.push(`inference endpoint unhealthy: HTTP ${res.status}`);
  } catch (e) {
    problems.push(`inference endpoint unreachable: ${e.message}`);
  }
  return problems;
}

const problems = await preflight();
if (problems.length) {
  console.error("M1 PREFLIGHT FAILED:\n- " + problems.join("\n- "));
  process.exit(2);
}

console.log(`M1: two repos live — ${repoA}#${issueA} ∥ ${repoB}#${issueB}`);
const [ra, rb] = await Promise.all([
  runFullChain({ label: "a", repo: repoA, issue: issueA }),
  runFullChain({ label: "b", repo: repoB, issue: issueB }),
]);
for (const r of [ra, rb]) {
  console.log(`  ${r.label} (${r.repo}#${r.issue}): evidence=${r.evidence?.ok ?? "?"} singleMerge=${r.singleMerge?.ok ?? "?"} => ${r.pass ? "PASS" : "FAIL"} in ${r.wallSecs}s`);
}
const pass = ra.pass && rb.pass;
const runDir = mkdtempSync(join(tmpdir(), "gates-m1-"));
writeFileSync(join(runDir, "m1-results.json"), JSON.stringify({ date: new Date().toISOString(), a: ra, b: rb, pass }, null, 2));
console.log(`results: ${join(runDir, "m1-results.json")}`);
console.log(`\nGATE M1: ${pass ? "PASS" : "FAIL"} — both repos completed the full chain simultaneously`);
process.exitCode = pass ? 0 : 1;
