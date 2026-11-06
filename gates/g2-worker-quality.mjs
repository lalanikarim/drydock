// Phase 2 / Gate G2 — worker quality on bounded real issues.
//
//   node gates/g2-worker-quality.mjs [--timeout-min 25] [--preflight-only]
//   node gates/g2-worker-quality.mjs --issues 34,35 [--allow-existing] [--max-files 6]
//   node gates/g2-worker-quality.mjs --repo lalanikarim/factory-fixture-2 --preflight-only
//
// Which repo is judged comes from the repo registry ($DRYDOCK_CONFIG_DIR/repo-registry.json): it supplies the issue
// eligibility label and the oracleBoot recipe for starting that repo's server. `--repo all` on
// --regression walks every registered repo; a plain run targets one repo.
//
// TARGETS ARE SELECTED BY LABEL, NOT BY NUMBER. With no --issues, every open issue carrying
// `agent` (override: --target-label) is a target. Each target must also carry exactly one
// `probe:<key>` label naming its behavior oracle in gates/probes/. Both are resolved at PREFLIGHT,
// before any inference, so "no oracle for this target" costs seconds instead of a worker run.
//
// For each issue: if a draft PR already exists for agent/issue-<n> (and
// --allow-existing), evaluate it; otherwise run the full unattended chain
// (simulated webhook -> factory -> sandboxed worker -> draft PR).
//
// Objective checks per issue (no model judgment):
//   A. test suite passes on the resulting branch;
//   B. diff is scoped: every changed file under src/ or test/, <= --max-files (default 5);
//   C. the issue's oracle passes against a live server from the candidate branch;
//   D. zero human edits (PR body carries the factory marker).
//
// Preflight additionally requires each oracle to FAIL against fixture `main` (fail-to-pass): an
// oracle that already passes on main judges nothing — the work is merged, or the probe is wrong.
// Both are preflight failures. --skip-fail-to-pass overrides it; --preflight-only stops here.
//
// G2 passes when >= 2 targets (or all of them, when fewer than 2 exist) satisfy A-D.

import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOTE: plain ESM — no TS syntax in .mjs gates (Node's strip-types does not
// transform .mjs); types are omitted throughout this file.
import { startIntakeServer } from "../factory/intake.ts";
import { loadRegistry, requireEnabledRepo, enabledRepos } from "../factory/repo-registry.ts";
import { loadFactoryEnv, spawnInstance, defaultConfigPath } from "./lib.ts";
import { totalTokensFor } from "./usage.ts";
import { loadProbes, probeKeyFromLabels, formatLabels } from "./behavior-probes.mjs";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const argv = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
// Explicit target list overrides label discovery; use it to evaluate one issue without pulling in
// every open `agent` issue. Numbers still need their `probe:<key>` label.
const issuesOpt = opt("--issues", "");
const preflightOnly = argv.includes("--preflight-only");
// Run every oracle against fixture main and report. Oracles for already-merged work stay in
// gates/probes/ without a label for exactly this: they are regression checks, and an oracle that
// silently stops passing on main means the feature it specified broke (or drifted).
const regression = argv.includes("--regression");
const skipFailToPass = argv.includes("--skip-fail-to-pass");
const timeoutMin = Number(opt("--timeout-min", "25"));
const allowExisting = argv.includes("--allow-existing");
// Scope bound: 5 held for single-behavior issues, but an issue that adds a ROUTE legitimately
// spans server.mjs + invoices.mjs + store.mjs + two test files (issue #34 did exactly that and
// failed scope while its behavior was correct). The bound stays at 5 by default — weakening it
// silently would defeat the check — but is now overridable so a run's calibration is explicit.
const maxScopeFiles = Number(opt("--max-files", "5"));

loadFactoryEnv();
// The repo registry ($DRYDOCK_CONFIG_DIR/repo-registry.json) decides which repo we judge, which label makes an issue
// workable there, and how that repo's server is started for behavior oracles. That last one is why
// this exists: fixture-1 logs "127.0.0.1:<port>" after binding 0, while fixture-2 reads PORT and
// logs the *requested* value — so a second repo could not be judged with fixture-1's boot recipe.
const registry = loadRegistry();
const repoOpt = opt("--repo", process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture");
if (repoOpt === "all" && !regression) {
  console.error("--repo all only applies to --regression; a worker run targets one repo");
  process.exit(2);
}
// "all" is a regression-only pseudo-repo: sweep every registered repo that can be booted. A worker
// run always targets exactly one repo, so it never resolves this.
const registryEntry = repoOpt === "all"
  ? enabledRepos(registry).find((e) => e.oracleBoot)
  : requireEnabledRepo(registry, repoOpt);
if (!registryEntry) {
  console.error("no enabled repo in the registry has an oracleBoot — nothing can be judged (add one to $DRYDOCK_CONFIG_DIR/repo-registry.json)");
  process.exit(2);
}
const fixturesRepo = registryEntry.repo;
// A target label may differ per repo (drydock uses "build" so its own backlog is not auto-picked).
const targetLabel = opt("--target-label", registryEntry.eligibilityLabel);
const runDir = await mkdtemp(join(tmpdir(), "gates-g2-"));
const results = [];

// ---------------------------------------------------------------------------
// Run one issue end-to-end (or skip when its draft PR already exists).
// ---------------------------------------------------------------------------
async function runIssue(issueNumber) {
  const branch = `agent/issue-${issueNumber}`;
  let existing = [];
  try {
    const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", branch, "--json", "number,url,isDraft"]);
    existing = JSON.parse(out || "[]");
  } catch { /* none */ }

  if (existing.length > 0) {
    if (!allowExisting) throw new Error(`draft PR ${existing[0].url} already exists for ${branch}; close it or pass --allow-existing`);
    console.log(`issue #${issueNumber}: using existing draft PR ${existing[0].url}`);
    return { issueNumber, prUrl: existing[0].url, wallSecs: null, run: "existing" };
  }

  const t0 = Date.now();
  const instance = await spawnInstance({ repo: fixturesRepo, configPath: defaultConfigPath(fixturesRepo) });
  const dispatch = async ({ requestId, content }) => {
    const res = await fetch(`${instance.base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.token}` },
      body: JSON.stringify({ requestId, content }),
    });
    if (!res.ok) throw new Error(`factory /tasks returned ${res.status}`);
    return res.json();
  };
  const { server: intake, port: intakePort } = await startIntakeServer({
    logPath: join(runDir, `intake-g2-issue-${issueNumber}.jsonl`),
    dispatch,
  });

  const issue = await sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", ".title"]);
  const body = (await sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", '.body // ""'])).trim();
  const event = {
    action: "opened",
    delivery_id: `g2-${issueNumber}-${Date.now()}`,
    repository: { full_name: fixturesRepo },
    issue: { number: issueNumber, title: issue, body, labels: [{ name: "agent" }] },
  };
  const delivery = await fetch(`http://127.0.0.1:${intakePort}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": event.delivery_id },
    body: JSON.stringify(event),
  });
  const deliveryBody = await delivery.json();
  if (!deliveryBody.accepted) throw new Error(`intake rejected issue #${issueNumber}: ${JSON.stringify(deliveryBody)}`);

  let pr = null;
  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", branch, "--json", "number,url,isDraft"]);
      const list = JSON.parse(out || "[]");
      if (list.length > 0) {
        pr = list[0];
        break;
      }
    } catch { /* not yet */ }
    process.stdout.write(".");
  }
  intake.close();
  await instance.close();

  const wallSecs = Math.round((Date.now() - t0) / 1000);
  // Phase 6 accounting, read after close from the durable `pi.usage` documents. Wall time alone hides what
  // actually scales with fleet size: one issue's context is mostly cache reads, and only the store says so.
  const tokens = totalTokensFor(instance.root);
  // Include the spend in the failure message: a run that produced nothing still burned context, and that
  // is exactly the case where "how much did it cost to fail?" matters most.
  if (!pr || !pr.isDraft) throw new Error(`no draft PR for ${branch} after ${wallSecs}s (${tokens ?? "unmeasured"} tokens)`);
  console.log(`issue #${issueNumber}: draft PR ${pr.url} in ${wallSecs}s (${tokens ?? "unmeasured"} tokens)`);
  return { issueNumber, prUrl: pr.url, wallSecs, tokens, run: "fresh" };
}

// ---------------------------------------------------------------------------
// Objective checks on one branch.
// ---------------------------------------------------------------------------
async function cloneBranch(branch, repo = fixturesRepo) {
  const dir = await mkdtemp(join(tmpdir(), `g2-${branch.replace(/\W/g, "")}-`));
  await sh("git", ["clone", "--quiet", "--branch", branch, `https://github.com/${repo}.git`, dir]);
  return dir;
}

async function runSuite(dir) {
  try {
    const out = await sh("node", ["--test"], { cwd: dir });
    const pass = [...out.matchAll(/^# pass (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    const fail = [...out.matchAll(/^# fail (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    return { passed: fail === 0 && pass > 0, pass, fail };
  } catch (e) {
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    const fail = [...out.matchAll(/^# fail (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    return { passed: false, pass: 0, fail: fail || -1 };
  }
}

async function checkScope(dir, maxFiles = maxScopeFiles) {
  const files = (await sh("git", ["-C", dir, "diff", "--name-only", "origin/main...HEAD"])).split("\n").filter(Boolean);
  // Scope: implementation + tests + README docs only; nothing else, and bounded size.
  const inScope = files.every((f) => f.startsWith("src/") || f.startsWith("test/") || f === "README.md");
  return { files, maxFiles, inScope, ok: inScope && files.length <= maxFiles };
}

/** Reserve an ephemeral port (close-then-use; a brief race is acceptable for a local oracle). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const waitForListening = (port, deadlineMs) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + deadlineMs;
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.on("connect", () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing listening on 127.0.0.1:${port} within ${deadlineMs}ms`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });

/**
 * Start the candidate branch's server per the registry entry's oracleBoot recipe; run fn; always
 * stop it. Two port-discovery modes because real fixtures differ: "stdout" parses the bound port out
 * of the log line (fixture-1), "env" picks a free port ourselves and waits for the socket to accept
 * (fixture-2 logs the requested port, which is meaningless when we ask for 0).
 */
async function withServer(dir, boot, fn) {
  if (!boot) throw new Error(`${fixturesRepo} has no oracleBoot in $DRYDOCK_CONFIG_DIR/repo-registry.json — cannot run behavior oracles`);
  const env = { ...process.env };
  let port = 0;
  if (boot.portFrom === "env") {
    port = await freePort();
    env[boot.envPortVar] = String(port);
  }
  const child = spawn(boot.command, boot.args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env });
  // Drain both streams (an unread pipe can block the child) and keep the tail for diagnostics.
  let tail = "";
  const drain = (d) => { tail = (tail + String(d)).slice(-4000); return tail; };
  child.stdout.on("data", drain);
  child.stderr.on("data", drain);
  const earlyExit = new Promise((_, reject) => {
    child.on("exit", (code) => reject(new Error(`server exited early (${code}); output:\n${tail}`)));
  });
  // The oracle's own SIGKILL makes this reject after the fact; the race only cares about early exit.
  earlyExit.catch(() => {});
  if (boot.portFrom === "stdout") {
    // The server logs the port it actually bound; wait for that line.
    await Promise.race([
      new Promise((resolve, reject) => {
        const tick = setInterval(() => {
          const m = tail.match(new RegExp(boot.stdoutPattern));
          // clearTimeout on success: a live 15s timer kept the whole battery process alive after PASS.
          if (m) { clearInterval(tick); clearTimeout(giveUp); port = Number(m[1]); resolve(); }
        }, 100);
        const giveUp = setTimeout(() => {
          clearInterval(tick);
          reject(new Error(`server did not log a bound port within 15s; output:\n${tail}`));
        }, 15_000);
      }),
      earlyExit,
    ]);
  } else {
    // We chose the port, so there is nothing to parse — readiness is "the socket accepts".
    await Promise.race([waitForListening(port, 15_000), earlyExit]);
  }
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
  }
}

const api = (base, method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// Run an issue's behavior oracle against a booted checkout of the candidate branch.
// The oracle itself lives in gates/probes/<key>.mjs and is selected by the issue's
// `probe:<key>` label — see gates/behavior-probes.mjs for why this replaced per-issue-number
// if-blocks (a missing oracle used to surface only after a full worker run).
async function runProbe(probe, dir, { repo = fixturesRepo, boot = registryEntry.oracleBoot } = {}) {
  // A probe names the repo whose API it speaks. Running an invoice oracle against the jobs service
  // would judge nothing — and could accidentally judge something — so cross-repo probes are refused.
  if (probe.repo !== repo) throw new Error(`probe ${probe.key} targets ${probe.repo}, not ${repo}`);
  return withServer(dir, boot, (base) => probe.check({ base, api }));
}

async function evaluateIssue(target, probe) {
  const issueNumber = target.number;
  const branch = `agent/issue-${issueNumber}`;
  const dir = await cloneBranch(branch);
  const suite = await runSuite(dir);
  const scope = await checkScope(dir);
  const behavior = await runProbe(probe, dir);
  // Zero human edits: the PR was opened by the factory (marker in body) and we never touched it.
  let zeroEdits = true;
  try {
    const listOut = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", branch, "--json", "number"]);
    const prNumber = JSON.parse(listOut || "[]")[0]?.number;
    if (!prNumber) zeroEdits = false;
    else {
      const prBody = await sh("gh", ["pr", "view", String(prNumber), "--repo", fixturesRepo, "--json", "body", "-q", ".body"]);
      zeroEdits = prBody.includes("_Opened as a draft by the drydock software factory");
    }
  } catch { /* no PR — treat as not verified */ zeroEdits = false; }
  const passed = suite.passed && scope.ok && behavior.ok && zeroEdits;
  return { issueNumber, title: target.title, labels: target.labels, probeKey: probe.key, branch, suite, scope, behavior, zeroEdits, passed };
}

// ---------------------------------------------------------------------------
// Target resolution + preflight. Everything here runs before a single inference call.
// ---------------------------------------------------------------------------
async function fetchIssue(number, repo = fixturesRepo) {
  const out = await sh("gh", ["api", `repos/${repo}/issues/${number}`, "--jq",
    "{number,title,state,labels:[.labels[].name]}"]);
  return JSON.parse(out);
}

async function listOpenIssueNumbers(repo = fixturesRepo) {
  const out = await sh("gh", ["api", `repos/${repo}/issues?state=open&per_page=100`, "--jq", "[.[].number]"]);
  return new Set(JSON.parse(out || "[]"));
}

async function discoverTargets(repo = fixturesRepo, label = targetLabel) {
  const out = await sh("gh", ["api",
    `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    "--jq", "[.[] | {number,title,labels:[.labels[].name]}]"]);
  return JSON.parse(out || "[]");
}

/** -> { targets: [{ issue, probe }], problems: string[] } */
async function resolveTargets(probes, { repo = fixturesRepo, label = targetLabel, numbers: numbersOpt = null } = {}) {
  const numbers = numbersOpt ?? (issuesOpt ? issuesOpt.split(",").map((s) => Number(s.trim())).filter(Number.isFinite) : (await discoverTargets(repo, label)).map((i) => i.number));
  if (numbers.length === 0) {
    return { targets: [], problems: [`no open issues labeled "${label}" in ${repo} — label a target or pass --issues`] };
  }
  const targets = [];
  const problems = [];
  for (const n of numbers) {
    let issue;
    try {
      issue = await fetchIssue(n, repo);
    } catch (e) {
      problems.push(`#${n}: not readable (${e.message.split("\n")[0]})`);
      continue;
    }
    let key;
    try {
      key = probeKeyFromLabels(issue.labels);
    } catch (e) {
      problems.push(`#${n}: ${e.message}`);
      continue;
    }
    if (!key) {
      problems.push(`#${n} "${issue.title}" has no probe:<key> label — add the oracle label or drop it as a target`);
      continue;
    }
    const probe = probes.get(key);
    if (!probe) {
      problems.push(`#${n}: probe:${key} has no module in gates/probes/ (typo, or the oracle was deleted)`);
      continue;
    }
    if (probe.repo !== repo) {
      // The label is resolvable but names another repo's oracle: judging this issue with it would be
      // meaningless, so treat it as an unresolvable target rather than silently skipping the check.
      problems.push(`#${n}: probe:${key} belongs to ${probe.repo}, not ${repo}`);
      continue;
    }
    targets.push({ issue, probe });
  }
  return { targets, problems };
}

/** Every oracle must fail against main, or it is not an oracle. */
async function checkFailToPass(targets, { repo = fixturesRepo, boot = registryEntry.oracleBoot } = {}) {
  const dir = await cloneBranch("main", repo);
  const problems = [];
  for (const { issue, probe } of targets) {
    let res;
    try {
      res = await runProbe(probe, dir, { repo, boot });
    } catch (e) {
      problems.push(`#${issue.number}: oracle ${probe.key} errored against main (${e.message.split("\n")[0]})`);
      continue;
    }
    if (res.ok) problems.push(`#${issue.number}: oracle ${probe.key} already PASSES on main — the work is merged or the probe is vacuous`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
const probes = await loadProbes();

if (regression) {
  // Oracles with no live target specify MERGED work: they must still hold against main.
  // Claimed oracles are expected to fail there (that is what makes their issue a target), so
  // they never count as regressions — but one that passes on main means the work landed and the
  // target is stale, which gets reported.
  //
  // `--repo all` sweeps every registered repo; otherwise just the selected one. Grouping by repo is
  // what makes a second fixture judgeable at all: each group boots with its own oracleBoot recipe.
  const repos = repoOpt === "all" ? enabledRepos(registry).filter((e) => e.oracleBoot) : [registryEntry];
  let regressed = 0;
  for (const entry of repos) {
    const group = [...probes.values()].filter((p) => p.repo === entry.repo);
    if (!entry.oracleBoot) {
      console.log(`\n${entry.repo}: SKIPPED — no oracleBoot in $DRYDOCK_CONFIG_DIR/repo-registry.json (${group.length} oracle(s) unrunnable)`);
      continue;
    }
    if (group.length === 0) {
      console.log(`\n${entry.repo}: no oracles registered for this repo`);
      continue;
    }
    const { targets: live, problems } = await resolveTargets(probes, { repo: entry.repo, label: entry.eligibilityLabel, numbers: null });
    const claimed = new Map(live.map((t) => [t.probe.key, t.issue.number]));
    const openIssues = await listOpenIssueNumbers(entry.repo);
    const dir = await cloneBranch("main", entry.repo);
    console.log(`\n${entry.repo}: ${group.length} oracles against main (${live.length} claimed by live targets)`);
    for (const p of problems) console.log(`  LABEL    ${p}`);
    for (const probe of group) {
      let res;
      try {
        res = await runProbe(probe, dir, { repo: entry.repo, boot: entry.oracleBoot });
      } catch (e) {
        res = { ok: false, detail: e.message.split("\n")[0] };
      }
      const claim = claimed.get(probe.key);
      if (claim !== undefined) {
        console.log(`  ${res.ok ? "STALE  " : "open "} #${claim} ${probe.key}: ${res.ok ? "oracle already passes on main — target is implemented, retarget or close it" : "expected to fail until the target lands"}`);
      } else if (res.ok) {
        console.log(`  ok      ${probe.key}: ${res.detail}`);
      } else if (probe.sourceIssue !== undefined && openIssues.has(probe.sourceIssue)) {
        // Not a regression: this behavior was never shipped. Issue #18 is exactly this case — an
        // open draft PR, so main still fails the oracle. It IS a missing target, so say so.
        console.log(`  UNTARGET #${probe.sourceIssue} ${probe.key}: unsatisfied on main and its issue is still open — label it (${entry.eligibilityLabel} + probe:${probe.key}) or close the issue`);
      } else {
        regressed += 1;
        console.log(`  REGRESS ${probe.key}${probe.sourceIssue !== undefined ? ` (specified by #${probe.sourceIssue}, now closed)` : ""}: ${res.detail}`);
      }
    }
  }
  console.log(`\nG2 regression ${regressed === 0 ? "PASS" : `FAIL — ${regressed} oracle(s) no longer hold against main`}`);
  process.exit(regressed === 0 ? 0 : 1);
}

console.log(`G2 preflight: ${probes.size} oracles loaded; targets from ${issuesOpt ? `--issues ${issuesOpt}` : `label "${targetLabel}"`}`);
const { targets, problems: resolveProblems } = await resolveTargets(probes);
let problems = resolveProblems;
if (targets.length > 0 && !skipFailToPass) {
  const ftp = await checkFailToPass(targets);
  problems = problems.concat(ftp);
}
const claimed = new Set(targets.map((t) => t.probe.key));
for (const { issue, probe } of targets) {
  console.log(`  #${issue.number} [${formatLabels(issue.labels)}] -> ${probe.key}: ${probe.title}`);
}
const sameRepo = [...probes.values()].filter((p) => p.repo === fixturesRepo);
const unclaimed = sameRepo.filter((p) => !claimed.has(p.key));
if (unclaimed.length) {
  console.log(`  (${unclaimed.length} further ${fixturesRepo} oracles cover merged work — run --regression to re-check them against main)`);
}
const otherRepos = [...new Set([...probes.values()].filter((p) => p.repo !== fixturesRepo).map((p) => p.repo))];
if (otherRepos.length) {
  console.log(`  (${probes.size - sameRepo.length} oracle(s) belong to other registry repos: ${otherRepos.join(", ")} — run with --repo <name> or --regression --repo all)`);
}
for (const p of problems) console.log(`  PROBLEM ${p}`);
if (preflightOnly) {
  console.log(problems.length ? `\nG2 preflight: ${problems.length} problem(s)` : `\nG2 preflight OK — ${targets.length} target(s), all oracles fail against main`);
  process.exitCode = problems.length ? 1 : 0;
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  console.error(`\nG2 PREFLIGHT FAILED (${problems.length} problem(s)) — nothing was run, so no worker time was spent on unresolvable targets`);
  process.exit(2);
}

console.log(`G2 battery: issues ${targets.map((t) => t.issue.number).join(", ")} (timeout ${timeoutMin}min each)`);
for (const { issue, probe } of targets) {
  const n = issue.number;
  try {
    const run = await runIssue(n);
    const evaln = await evaluateIssue(issue, probe);
    results.push({ ...run, ...evaln });
    const suiteStr = evaln.suite.passed ? `pass ${evaln.suite.pass}/${evaln.suite.fail}` : "FAIL";
    const scopeStr = evaln.scope.ok
      ? `ok (${evaln.scope.files.length}/${evaln.scope.maxFiles} files)`
      : evaln.scope.inScope
        ? `FAIL too many files (${evaln.scope.files.length} > ${evaln.scope.maxFiles})`
        : `FAIL out of scope (${evaln.scope.files.join(", ")})`;
    const behaviorStr = evaln.behavior.ok ? "ok" : `FAIL: ${evaln.behavior.detail}`;
    console.log(`  issue #${n}: suite=${suiteStr} scope=${scopeStr} behavior=${behaviorStr} zeroEdits=${evaln.zeroEdits} tokens=${run.tokens ?? "unmeasured"} => ${evaln.passed ? "PASS" : "FAIL"}`);
  } catch (e) {
    results.push({ issueNumber: n, passed: false, error: e.message });
    console.log(`  issue #${n}: RUN FAIL — ${e.message}`);
  }
}

const passCount = results.filter((r) => r.passed).length;
const total = targets.length;
const gate = passCount >= 2 && total === 3 ? "PASS" : passCount >= Math.min(2, total) ? `PASS (${passCount}/${total})` : "FAIL";
console.log(`\nG2 ${gate} — ${passCount}/${total} issues produced a passing, scoped PR with zero human edits`);
const tokenRuns = results.map((r) => r.tokens).filter((t) => typeof t === "number");
if (tokenRuns.length > 0) {
  const sum = tokenRuns.reduce((a, b) => a + b, 0);
  console.log(`tokens: ${sum} across ${tokenRuns.length} run(s), mean ${Math.round(sum / tokenRuns.length)} per issue`);
} else {
  console.log("tokens: no durable stores were readable, so spend is unmeasured for this run");
}
for (const r of results) console.log(`  #${r.issueNumber}: ${r.passed ? "PASS" : `FAIL${r.error ? ` (${r.error})` : ""}`}`);

const { writeFileSync } = await import("node:fs");
writeFileSync(join(runDir, "g2-results.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`results: ${join(runDir, "g2-results.json")}`);
process.exitCode = gate.startsWith("PASS") ? 0 : 1;
