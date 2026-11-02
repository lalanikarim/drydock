#!/usr/bin/env node
// Run ONE real task against a repo through the production pipeline, stopping at the draft PR.
//
// Why this exists when G2/G4 already run end to end: those batteries assume a graded fixture repo —
// G2 boots the candidate's HTTP app via the registry's `oracleBoot` to run behavior probes, and G4
// drives a merge approval. Drydock is neither: it exposes no bootable service, and its registry entry
// says autoMerge:false, so a harness waiting on a merge approval would wait forever. Self-work needs
// exactly the production path with a human at the end: clone -> setup -> worker -> independent review
// -> draft PR. Then a person reads the diff and merges it.
//
// Work is dispatched over the instance's own POST /tasks API rather than through the webhook, on
// purpose: that is the "local dispatch" decision — the public listener stays down until its own
// hardening has landed. The webhook path itself is covered separately (G0 plus factory/intake.test.ts).
//
//   node --experimental-strip-types gates/self-run-task.mjs --issue 56 [--repo owner/name] [--timeout-min 45]
//
// Prints the draft PR URL for branch agent/issue-<n>. Never merges, never approves.

import { execFileSync } from "node:child_process";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, postTask } from "./lib.ts";
import { formatUsage, readInstanceUsage } from "./usage.ts";

loadFactoryEnv();

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

// No default repository, on purpose. This script runs ONE REAL TASK through the production pipeline —
// worktree, branch, worker, PR against whatever it is pointed at — and it used to fall back to
// `lalanikarim/drydock`, i.e. the live managed repo. A tool whose forgotten flag means "do the thing to
// production" has its default pointing the wrong way. Name the target explicitly or set SELF_RUN_REPO.
const repo = (flag("repo", "") || (process.env.SELF_RUN_REPO ?? "")).trim();
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error(
    "error: --repo <owner/name> is required (or set SELF_RUN_REPO); there is no default because this " +
      "script runs a real task against the target repo, and the historical default was the live managed repo.",
  );
  process.exit(2);
}
const issueNumber = Number(flag("issue", "0"));
const timeoutMin = Number(flag("timeout-min", "45"));
const allowExisting = argv.includes("--allow-existing");
if (!issueNumber) {
  console.error("usage: gates/self-run-task.mjs --repo <owner/name> --issue <n> [--timeout-min 45] [--allow-existing]");
  process.exit(2);
}

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

const branch = `agent/issue-${issueNumber}`;
// The head sha of the branch right now, or null when it does not exist yet. This is what makes rework
// runs observable: a re-push lands NEW commits on the SAME branch (the pipeline force-with-leases a
// diverged prior attempt rather than deleting it, because deleting closes the PR), so "a PR exists for
// the branch" is already true before the run starts and proves nothing. Waiting for the head to CHANGE
// is the only signal that distinguishes this attempt from the previous one — the first version of this
// runner matched on PR existence and returned in under a second, then closed the instance mid-run.
const branchHead = () => {
  try {
    return gh(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]) || null;
  } catch {
    return null; // branch not created yet
  }
};
const baselineHead = branchHead();
const existing = JSON.parse(
  gh(["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url"]),
);
if (existing.length > 0 && !allowExisting) {
  console.error(`branch ${branch} already has PR ${existing[0].url} — close it, or pass --allow-existing to run a rework that replaces its head`);
  process.exit(2);
}
if (baselineHead) console.log(`[self-run] baseline head of ${branch} = ${baselineHead.slice(0, 12)}; waiting for a different sha`);

const issue = JSON.parse(
  gh(["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,labels"]),
);
const labels = (issue.labels ?? []).map((l) => l.name);

// Issue text is untrusted input by construction, so it arrives inside the same delimiters intake uses.
// The instruction that follows them is the harness's, not the issue author's.
const content = [
  `<untrusted issue repo=${repo} number=${issue.number}>`,
  `Title: ${issue.title}`,
  "",
  issue.body ?? "",
  `</untrusted>`,
  "",
  "Implement what the issue above asks for and open a DRAFT pull request.",
  "The acceptance criteria in the issue are the contract: if you cannot satisfy all of them, say so plainly in the PR body instead of weakening the change to make it pass.",
  `Issue labels: ${labels.join(", ") || "(none)"}.`,
].join("\n");

console.log(`[self-run] repo=${repo} issue=#${issueNumber} "${issue.title}"`);
const instance = await spawnInstance({ repo, configPath: defaultConfigPath(repo) });
console.log(`[self-run] instance ready at ${instance.base} (log: ${instance.logPath})`);

try {
  const requestId = flag("request-id", `self-${repo.replace("/", "-")}-${issueNumber}`);
  await postTask(instance.base, instance.token, content, requestId);
  console.log(`[self-run] task accepted (requestId=${requestId}); polling for ${branch} / draft PR (${timeoutMin}m ceiling)`);

  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    const found = JSON.parse(
      gh(["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url"]),
    );
    const head = branchHead();
    if (found.length > 0 && head && head !== baselineHead) {
      const how = baselineHead ? `head replaced ${baselineHead.slice(0, 12)} → ${head.slice(0, 12)}` : `new branch at ${head.slice(0, 12)}`;
      console.log(`[self-run] PR ${found[0].url} (state=${found[0].state}, draft=${found[0].isDraft}) — ${how}`);
      process.exitCode = 0;
      break;
    }
  }

  if (process.exitCode === undefined) {
    console.error(`[self-run] no PR on ${branch} within ${timeoutMin}m — inspect the instance log above`);
    process.exitCode = 1;
  }
} finally {
  await instance.close();
  // Spend is read after close, from the durable store: usage lives in per-conversation `pi.usage`
  // documents, so an interrupted run still reports what it consumed up to the point it stopped.
  try {
    console.log(formatUsage(readInstanceUsage(instance.root)));
  } catch (err) {
    console.warn(`[self-run] token accounting unavailable: ${err.message}`);
  }
  console.log(`[self-run] instance closed; verify with: node --experimental-strip-types gates/self-intake-hardening.mjs <workspace>`);
}
