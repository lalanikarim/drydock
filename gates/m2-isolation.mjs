// Phase 2 / Gate M2 — isolation: factory A SIGKILLed mid-run while factory B
// completes an issue end-to-end unaffected. Production entrypoint via
// gates/lib.ts spawnInstance.
//
// Requires TWO onboarded repos:
//   M_REPO_A / M_ISSUE_A  (the one that gets killed; default lalanikarim/factory-fixture / 4)
//   M_REPO_B / M_ISSUE_B  (must complete; unset by default — the gate refuses to run without it)
//
// PASS when: A is SIGKILLed while its worker is running, and B still completes
// the full chain (draft PR with complete evidence -> approve -> exactly-once
// merge) on the same machine.
//
// Usage: node --experimental-strip-types gates/m2-isolation.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, postTask, rootConversationId, waitForToolResult, waitForApproval, decideApproval, api } from "./lib.ts";
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
  console.error("M2 requires M_REPO_B and M_ISSUE_B (the repo that must complete) — set them and re-run.");
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
  const tmp = mkdtempSync(join(tmpdir(), "m2-verify-"));
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
  console.error("M2 PREFLIGHT FAILED:\n- " + problems.join("\n- "));
  process.exit(2);
}

console.log(`M2: isolation — A=${repoA}#${issueA} (killed), B=${repoB}#${issueB} (must complete)`);
const results = { date: new Date().toISOString(), a: null, b: null };

// Both instances up; submit work to both.
const instA = await spawnInstance({ repo: repoA, configPath: defaultConfigPath(repoA) });
const instB = await spawnInstance({ repo: repoB, configPath: defaultConfigPath(repoB) });
try {
  const t0 = Date.now();
  await postTask(instA.base, instA.token, `Work on GitHub issue number: ${issueA}.`, `m2-a-${issueA}`);
  await postTask(instB.base, instB.token, `Work on GitHub issue number: ${issueB}.`, `m2-b-${issueB}`);

  // Wait until A has spawned its worker conversation (a second conversation
  // exists), then SIGKILL A mid-run.
  const convIdA = await rootConversationId(instA.base, instA.token);
  let workerSpawned = false;
  const killDeadline = Date.now() + 15 * 60_000;
  while (!workerSpawned && Date.now() < killDeadline) {
    const a = api(instA.base, instA.token);
    const { json } = await a.get("/conversations");
    const list = json.conversations ?? json.items ?? [];
    if (list.length > 1) workerSpawned = true;
    else await new Promise((r) => setTimeout(r, 5000));
  }
  if (!workerSpawned) throw new Error("A never spawned a worker conversation within 15m");

  const preMainShaB = (await sh("gh", ["api", `repos/${repoB}/commits/main`, "--jq", ".sha"], { env: GH_ENV }));
  instA.child.kill("SIGKILL");
  await new Promise((resolve) => instA.child.once("exit", resolve));
  results.a = { killed: true, wallSecsAtKill: Math.round((Date.now() - t0) / 1000) };
  console.log(`A SIGKILLed mid-run after ${results.a.wallSecsAtKill}s`);

  // B must complete the full chain unaffected.
  const branchB = `agent/issue-${issueB}`;
  const convIdB = await rootConversationId(instB.base, instB.token);
  const draftText = await waitForToolResult(instB.base, instB.token, convIdB, "open_draft_pr", (t) => t.includes('"prUrl"') || t.includes('"refused": true'), 25 * 60_000);
  const draft = JSON.parse(draftText.slice(draftText.indexOf("{")));
  if (draft.refused) throw new Error(`B review refused: ${JSON.stringify(draft).slice(0, 300)}`);

  const prB = await prForHead(repoB, branchB);
  if (!prB || prB.state !== "OPEN") throw new Error(`no open PR for ${branchB}`);
  results.b = { evidence: checkEvidence(prB), expectedHeadSha: prB.headRefOid };

  const pending = await waitForApproval(instB.base, instB.token, "merge_pr", WAIT_APPROVAL_MS);
  await decideApproval(instB.base, instB.token, pending.key, "approved", "m2-battery");
  await postTask(instB.base, instB.token, `The human has APPROVED merge approval key ${pending.key}. Call merge_pr again with exactly { issueNumber: ${issueB} } and report the result.`, `m2-b-retry`);

  const mergedPr = await waitMergedForHead(repoB, branchB, WAIT_MERGED_MS);
  results.b.mergeCommit = mergedPr.mergeCommit?.oid ?? null;
  results.b.singleMerge = await verifySingleMerge({ repo: repoB, preMainSha: preMainShaB, expectedHeadSha: results.b.expectedHeadSha });
  results.b.wallSecs = Math.round((Date.now() - t0) / 1000);
  results.b.pass = results.b.evidence.ok && results.b.singleMerge.ok;
} finally {
  await instA.close();
  await instB.close();
}

const pass = results.a?.killed === true && results.b?.pass === true;
const runDir = mkdtempSync(join(tmpdir(), "gates-m2-"));
writeFileSync(join(runDir, "m2-results.json"), JSON.stringify({ ...results, pass }, null, 2));
console.log(`B: evidence=${results.b?.evidence?.ok} singleMerge=${results.b?.singleMerge?.ok} => ${pass ? "PASS" : "FAIL"} in ${results.b?.wallSecs}s`);
console.log(`results: ${join(runDir, "m2-results.json")}`);
console.log(`\nGATE M2: ${pass ? "PASS" : "FAIL"} — A killed mid-run; B completed unaffected`);
process.exitCode = pass ? 0 : 1;
