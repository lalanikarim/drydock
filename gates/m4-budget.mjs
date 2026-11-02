// Phase 2 / Gate M4 — budget enforcement: a long-running issue hits
// wallSecsPerIssue, is aborted cleanly (no PR, durable abort outcome), and the
// other repo's runs are unaffected. Production entrypoint via gates/lib.ts.
//
// Requires TWO onboarded repos:
//   M_REPO_A / M_ISSUE_A  — runs under a TIGHT budget (M4_BUDGET_SECS, default 120)
//                           so the worker is aborted by wall clock
//   M_REPO_B / M_ISSUE_B  — runs under normal budgets and must complete end-to-end
//
// PASS when: A's worker task is durably aborted with the budget reason (and no
// draft PR exists for its issue), while B completes the full chain on the same
// machine.
//
// Usage: node --experimental-strip-types gates/m4-budget.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  console.error("M4 requires M_REPO_B and M_ISSUE_B (the repo that must complete) — set them and re-run.");
  process.exit(2);
}
// The budget must be BELOW a typical successful run or the gate proves nothing: with the old
// default of 120 s a bounded fixture issue now finishes in ~60–120 s, so no abort ever fires and
// the script waits out its full 20-minute delegate-wait before failing with no diagnostic.
// 30 s reliably interrupts a real worker mid-task on our endpoint (verified 2026-10-28: A aborted
// by budget with zero side effects while B completed and merged exactly once in 202 s).
const budgetSecs = Number(process.env.M4_BUDGET_SECS ?? 30);
const GH_ENV = { ...process.env, GH_TOKEN: process.env.FACTORY_GITHUB_TOKEN ?? "" };
const WAIT_APPROVAL_MS = 25 * 60 * 1000;
const WAIT_MERGED_MS = 25 * 60 * 1000;

// Tight-budget config override for A (same repo config, budgets replaced).
const runDir = mkdtempSync(join(tmpdir(), "gates-m4-"));
const baseCfg = JSON.parse(readFileSync(defaultConfigPath(repoA), "utf8"));
baseCfg.budgets = { ...(baseCfg.budgets ?? {}), wallSecsPerIssue: budgetSecs };
const cfgPathA = join(runDir, "factory-config-a.json");
writeFileSync(cfgPathA, JSON.stringify(baseCfg, null, 2));



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
  const tmp = mkdtempSync(join(tmpdir(), "m4-verify-"));
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

async function preflight() {
  const problems = [];
  for (const repo of [repoA, repoB]) {
    try { await sh("gh", ["api", `repos/${repo}`, "--jq", ".full_name"], { env: GH_ENV }); }
    catch (e) { problems.push(`gh access to ${repo} failed: ${e.message}`); }
  }
  try {
    const images = await sh("podman", ["images", "--format", "{{.Repository}}"]);
    if (!images.split("\n").some((l) => l.includes("factory-sandbox"))) problems.push("factory-sandbox image missing");
  } catch (e) { problems.push(`podman unavailable: ${e.message}`); }
  try {
    const res = await fetch(`${process.env.OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` } });
    if (!res.ok) problems.push(`inference endpoint unhealthy: HTTP ${res.status}`);
  } catch (e) { problems.push(`inference endpoint unreachable: ${e.message}`); }
  return problems;
}

const problems = await preflight();
if (problems.length) {
  console.error("M4 PREFLIGHT FAILED:\n- " + problems.join("\n- "));
  process.exit(2);
}

console.log(`M4: budget — A=${repoA}#${issueA} @ ${budgetSecs}s budget; B=${repoB}#${issueB} normal`);
const results = { date: new Date().toISOString(), budgetSecs, a: null, b: null };

const instA = await spawnInstance({ repo: repoA, configPath: cfgPathA });
const instB = await spawnInstance({ repo: repoB, configPath: defaultConfigPath(repoB) });
try {
  const t0 = Date.now();
  await postTask(instA.base, instA.token, `Work on GitHub issue number: ${issueA}.`, `m4-a-${issueA}`);
  await postTask(instB.base, instB.token, `Work on GitHub issue number: ${issueB}.`, `m4-b-${issueB}`);

  // A: expect the delegate tool result to report the budget abort. The worker
  // task aborts at wallSecsPerIssue; delegate surfaces the outcome error.
  const convIdA = await rootConversationId(instA.base, instA.token);
  let aResult = null;
  try {
    const text = await waitForToolResult(instA.base, instA.token, convIdA, "delegate", (t) => /budget|abort/i.test(t), 20 * 60_000);
    aResult = text.slice(0, 400);
  } catch { /* fall through — checked below */ }
  const branchA = `agent/issue-${issueA}`;
  let prAExists = false;
  try { prAExists = (await sh("gh", ["pr", "list", "--repo", repoA, "--state", "open", "--head", branchA, "--json", "number"], { env: GH_ENV })).trim() !== "[]"; } catch { /* none */ }
  results.a = { abortedByBudget: aResult ? /wall-clock budget exceeded/i.test(aResult) : false, delegateResult: aResult, prExists: prAExists, wallSecs: Math.round((Date.now() - t0) / 1000) };

  // B: must complete the full chain unaffected.
  const preMainShaB = (await sh("gh", ["api", `repos/${repoB}/commits/main`, "--jq", ".sha"], { env: GH_ENV }));
  const branchB = `agent/issue-${issueB}`;
  const convIdB = await rootConversationId(instB.base, instB.token);
  const draftText = await waitForToolResult(instB.base, instB.token, convIdB, "open_draft_pr", (t) => t.includes('"prUrl"') || t.includes('"refused": true'), 25 * 60_000);
  const draft = JSON.parse(draftText.slice(draftText.indexOf("{")));
  if (draft.refused) throw new Error(`B review refused: ${JSON.stringify(draft).slice(0, 300)}`);

  const prB = await prForHead(repoB, branchB);
  if (!prB || prB.state !== "OPEN") throw new Error(`no open PR for ${branchB}`);
  results.b = { evidence: checkEvidence(prB), expectedHeadSha: prB.headRefOid };

  const pending = await waitForApproval(instB.base, instB.token, "merge_pr", WAIT_APPROVAL_MS);
  await decideApproval(instB.base, instB.token, pending.key, "approved", "m4-battery");
  await postTask(instB.base, instB.token, `The human has APPROVED merge approval key ${pending.key}. Call merge_pr again with exactly { issueNumber: ${issueB} } and report the result.`, `m4-b-retry`);

  const mergedPr = await waitMergedForHead(repoB, branchB, WAIT_MERGED_MS);
  results.b.mergeCommit = mergedPr.mergeCommit?.oid ?? null;
  results.b.singleMerge = await verifySingleMerge({ repo: repoB, preMainSha: preMainShaB, expectedHeadSha: results.b.expectedHeadSha });
  results.b.wallSecs = Math.round((Date.now() - t0) / 1000);
  results.b.pass = results.b.evidence.ok && results.b.singleMerge.ok;
} finally {
  await instA.close();
  await instB.close();
}

const pass = results.a?.abortedByBudget === true && results.a?.prExists === false && results.b?.pass === true;
writeFileSync(join(runDir, "m4-results.json"), JSON.stringify({ ...results, pass }, null, 2));
console.log(`A: abortedByBudget=${results.a?.abortedByBudget} prExists=${results.a?.prExists}`);
console.log(`B: evidence=${results.b?.evidence?.ok} singleMerge=${results.b?.singleMerge?.ok} => ${pass ? "PASS" : "FAIL"} in ${results.b?.wallSecs}s`);
console.log(`results: ${join(runDir, "m4-results.json")}`);
console.log(`\nGATE M4: ${pass ? "PASS" : "FAIL"} — budget aborted A cleanly; B unaffected`);
process.exitCode = pass ? 0 : 1;
