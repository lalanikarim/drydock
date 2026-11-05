#!/usr/bin/env node
// Deploy verification as a command (#220).
//
// Steps 4–5 of `fleet/release-checklist.md` were a human running eight commands and pasting the output. That works
// until somebody pastes yesterday's table — and on 2026-11-05 I "verified" a deploy by invoking a gate filename that
// has never existed, piped through `tail`, which exited 0 on a MODULE_NOT_FOUND traceback (#236 shipped the drift
// gate; this is the rest of the issue). So: one command, one row per assertion, observed values printed even on
// success, non-zero exit if any row fails.
//
// Six assertions, in the order #220 lists them:
//   1 build identity    /health build.sha == `git rev-parse --short HEAD`
//   2 parenting         every factory/adapter process is a child of the supervisor
//   3 quarantine        zero quarantine lines in the boot log
//   4 posture drift     on-disk config/gates.json == gate-policy.ts (delegated to gates/deploy-posture.mjs)
//   5 posture line      the kernel's startup line names every narrowed tool
//   6 settlement sanity approval-block-probe + settlement-window, reporting what each COLLECTED, not just its code
//
// Design rules this file has to keep:
//   • Never report ok for something that was not collected. Zero processes, zero log lines, an unreadable lock, an
//     absent sub-gate — all failures ("not collected" and "passing" are the same color; work-queue R6b/R10).
//   • Read-only. No GitHub calls, no restarts, no writes to fleet state. It inspects; a human acts.
//   • Exit 2 means "could not run", never folded into pass or fail — a broken verifier must not look like a red
//     deploy nor a green one.
//
// Usage: node --experimental-strip-types fleet/verify-deploy-posture.mjs [--config fleet/fleet.local.json]
//        [--log /tmp/fleet-abc1234.log] [--base http://127.0.0.1:9700] [--json] [--timeout-ms 5000]

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ------------------------------------------------------------------------------------------- pure parts
// Exported and unit-tested without a fleet. Anything touching the network, `ps`, or a sub-process lives below the
// line, in `collect()`, so a test can drive every branch above it.

/** Row shape: value is what was observed (printed even on success — placeholders hide empty collection). */
export function row(name, ok, value, detail = "") {
  return { name, ok, value, detail };
}

export function parseSupervisorPid(lockText) {
  const first = String(lockText ?? "").split("\n")[0].trim();
  if (!/^\d+$/.test(first)) return null;
  return Number(first);
}

/** Processes we care about, from `ps -eo pid=,ppid=,command=`. Deliberately matches the runbook's bracket trick so
 *  the verifier's own command line can never appear as a child of itself. */
export function parseFleetProcesses(psOutput) {
  const re = /(factory\/main\.ts|fleet\/adapter\.ts|factory\/main[.]ts|adapter[.]ts)/;
  const out = [];
  for (const line of String(psOutput ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pid, ppid, ...rest] = trimmed.split(/\s+/);
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue;
    const command = rest.join(" ");
    if (!re.test(command)) continue;
    if (/verify-deploy-posture/.test(command)) continue; // this script, when invoked oddly, is not fleet state
    out.push({ pid: Number(pid), ppid: Number(ppid), command });
  }
  return out;
}

/** Assertion 2. Zero processes is a FAILURE — an empty list passes "no orphans" vacuously. */
export function checkParenting(processes, supervisorPid) {
  if (supervisorPid === null || supervisorPid === undefined) {
    return row("parenting", false, "unknown supervisor", "lock file missing or first line is not a pid — refusing to infer");
  }
  if (processes.length === 0) {
    return row("parenting", false, "0 fleet processes", "nothing matched factory/main.ts or adapter.ts — the fleet is not running; that is not 'no orphans'");
  }
  const orphans = processes.filter((p) => p.ppid !== supervisorPid);
  if (orphans.length > 0) {
    return row(
      "parenting",
      false,
      `${orphans.length} orphan(s) of ${processes.length}`,
      orphans.map((o) => `pid ${o.pid} ppid ${o.ppid} ≠ supervisor ${supervisorPid}: ${o.command.slice(0, 80)}`).join("\n      "),
    );
  }
  return row("parenting", true, `${processes.length}/${processes.length} children of ${supervisorPid}`);
}

/** Assertion 3. Case-insensitive, like the `grep -ci quarantin` habit it replaces. */
export function checkQuarantine(logText) {
  const lines = String(logText ?? "").split("\n").filter((l) => /quarantin/i.test(l));
  if (lines.length === 0) return row("quarantine", true, "0 lines");
  return row("quarantine", false, `${lines.length} line(s)`, lines.slice(0, 5).map((l) => l.slice(0, 140)).join("\n      "));
}

/** Assertion 5: the kernel's startup posture line, and the tools it names. */
export const POSTURE_PREFIX = "[gates] destructive floor judges effect-bearing args only for:";

export function parsePostureLine(logText) {
  const lines = String(logText ?? "").split("\n").filter((l) => l.includes(POSTURE_PREFIX));
  if (lines.length === 0) return { present: false, tools: [] };
  const last = lines[lines.length - 1];
  const after = last.slice(last.indexOf(POSTURE_PREFIX) + POSTURE_PREFIX.length);
  // The real line is `[gates] … only for: write(path), edit(edits[].path,path), multi_edit(edits[].path,path),
  // delegate(issueNumber), submit_verdict(nothing scanned), … — payload/prose is not scanned …`. Arg specs contain
  // commas and the sentence ends in prose, so a naive split on "," mangles `edit(edits[].path,path)` into two tools
  // and turns `submit_verdict(nothing scanned)` into garbage. Split top-level commas only, then keep the bare name.
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of after) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    // Stop at the em-dash sentence break once a tool name has started and we are outside any spec.
    if (depth === 0 && ch === " " && cur.includes(")")) break;
    if (depth === 0 && ch === " " && cur === "") continue;
    cur += ch;
  }
  parts.push(cur);
  const tools = parts
    .map((t) => t.trim().replace(/\(.*$/, "").trim()) // "edit(edits[].path,path)" → "edit"
    .filter((t) => /^[a-z_][a-z0-9_]*$/i.test(t));
  return { present: true, tools };
}

export function checkPostureLine(logText, expectedTools) {
  const got = parsePostureLine(logText);
  if (!got.present) {
    return row("posture line", false, "absent", `${POSTURE_PREFIX} … never appeared in the boot log — the floor may be running undeclared (#53/#69 require it to be loud at startup)`);
  }
  const bare = got.tools.map((t) => t.replace(/\(.*\)$/, ""));
  const missing = (expectedTools ?? []).filter((t) => !bare.includes(t));
  if (missing.length > 0) {
    return row("posture line", false, `missing ${missing.join(", ")}`, `booted build narrowed only: ${bare.join(", ") || "<none>"}`);
  }
  return row("posture line", true, `${bare.length} tool(s): ${bare.join(", ")}`);
}

/** Assertion 1. Comparison is on the short sha both sides report; a missing field is a failure, not undefined==undefined. */
export function checkBuildIdentity(health, gitSha) {
  const running = health && typeof health === "object" ? health?.build?.sha : undefined;
  if (!running) return row("build identity", false, "no build.sha from /health", JSON.stringify(health ?? null).slice(0, 160));
  if (!gitSha) return row("build identity", false, `${running} vs unknown checkout`, "could not read the checked-out sha — refusing to compare against nothing");
  if (String(running).slice(0, 7) !== String(gitSha).slice(0, 7)) {
    return row("build identity", false, `running ${running} ≠ checkout ${gitSha}`, "restart the fleet from this tree, or check out what is deployed — do not edit this assertion");
  }
  return row("build identity", true, `${running}`);
}

export function formatRows(rows, { json = false } = {}) {
  const allOk = rows.every((r) => r.ok);
  if (json) return JSON.stringify({ ok: allOk, rows }, null, 2);
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  ${r.value}${r.detail ? `\n      ${r.detail}` : ""}`);
  lines.push("");
  lines.push(allOk ? "PASS" : `FAIL — ${rows.filter((r) => !r.ok).length} of ${rows.length} assertions`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------- live parts

function readConfig(path) {
  const raw = readFileSync(path, "utf8");
  const cfg = JSON.parse(raw);
  return cfg;
}

/** Newest `/tmp/fleet-*.log`, which is where this operator starts the supervisor. Printed in the row so a stale
 *  guess is visible rather than silently believed. */
function newestFleetLog() {
  const dir = "/tmp";
  try {
    const names = readdirSync(dir).filter((n) => /^fleet-.*\.log$/.test(n));
    if (names.length === 0) return null;
    names.sort((a, b) => mtimeOrZero(join(dir, b)) - mtimeOrZero(join(dir, a)));
    return join(dir, names[0]);
  } catch {
    return null;
  }
}

function mtimeOrZero(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

async function fetchHealth(base, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: ctrl.signal });
    return await res.json();
  } catch (err) {
    return { status: "unreachable", error: String(err?.message ?? err) };
  } finally {
    clearTimeout(t);
  }
}

function runSubGate(script, args, timeoutMs = 180_000) {
  const path = join(REPO, script);
  if (!existsSync(path)) return { code: null, missing: true, out: `${script} does not exist` };
  const r = spawnSync(process.execPath, ["--experimental-strip-types", path, ...args], { encoding: "utf8", timeout: timeoutMs, cwd: REPO });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.error) return { code: null, missing: false, out: `${script} failed to start: ${r.error.message}` };
  return { code: r.status, missing: false, out };
}

/** Assertion 6, honestly reported: the sub-gate's exit code PLUS what it says it collected. A gate that ran over an
 *  empty set is not a pass (R6b/R10), so each row quotes the collection line. */
export function summarizeSubGate(label, script, result) {
  if (result.missing) return row(label, false, "gate missing", result.out);
  // Each sub-gate has one line that states what it looked at. Those are matched explicitly — a generic heuristic
  // would accept any output containing a digit, which is how a checker starts believing itself.
  const settlement = result.out.match(/all:\s*completed=\d+.*?inFlight=\d+(?: waiting=\d+)?/);
  const posture = result.out.match(/inspected \d+ of \d+ declared instance\(s\)/);
  const blocks = result.out.match(/\d+ blocked conversation\(s\): \d+ explained by detection, \d+ drifted\/failed/);
  const collected = settlement?.[0] ?? posture?.[0] ?? (blocks ? blocks[0] : "");
  const tail = result.out.split("\n").filter(Boolean).slice(-1)[0] ?? "";
  const value = `exit ${result.code}${collected ? ` · ${collected}` : ""}`;
  if (result.code !== 0) {
    return row(label, false, value, `${script}: ${tail.slice(0, 200)}`);
  }
  if (!collected) {
    // Strict on purpose. Every sub-gate this verifier invokes has one line stating what it inspected; if that line
    // is absent the gate's behavior changed or it collected nothing, and exit 0 alone is not evidence (#236).
    return row(label, false, value, `${script} exited 0 without printing its collection line — treat as unverified. Last line: ${tail.slice(0, 160)}`);
  }
  return row(label, true, value);
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const asJson = argv.includes("--json");
  const configPath = flag("--config") ?? "fleet/fleet.local.json";
  const timeoutMs = Number(flag("--timeout-ms") ?? 5000);

  // Refuse loudly before producing a table nobody can trust: no lock file means no supervisor to check against.
  const lockPath = resolve(REPO, "fleet/data/routes.json.lock");
  if (!existsSync(lockPath)) {
    console.error(`verify-deploy-posture: cannot read ${lockPath} — refusing to run (#220: no silent "nothing to check" success)`);
    return 2;
  }
  const supervisorPid = parseSupervisorPid(readFileSync(lockPath, "utf8"));

  let cfg;
  try {
    cfg = readConfig(resolve(REPO, configPath));
  } catch (err) {
    console.error(`verify-deploy-posture: cannot read fleet config ${configPath}: ${err.message}`);
    return 2;
  }

  const base = flag("--base") ?? `http://127.0.0.1:${cfg?.adapter?.port ?? 9700}`;
  const logPath = flag("--log") ?? newestFleetLog();
  const rows = [];

  // 1 — build identity
  const health = await fetchHealth(base, timeoutMs);
  let gitSha = "";
  try {
    gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    gitSha = "";
  }
  rows.push(checkBuildIdentity(health, gitSha));

  // 2 — parenting
  const ps = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  rows.push(checkParenting(parseFleetProcesses(ps), supervisorPid));

  // 3 + 5 — the boot log
  if (!logPath || !existsSync(logPath)) {
    rows.push(row("quarantine", false, "no boot log", `pass --log <path>; looked for /tmp/fleet-*.log`));
    rows.push(row("posture line", false, "no boot log", "cannot assert a startup line from a file that is not there"));
  } else {
    const logText = readFileSync(logPath, "utf8");
    rows.push(checkQuarantine(logText));
    const { instanceGatesConfig } = await import("../factory/gate-policy.ts");
    rows.push(checkPostureLine(logText, Object.keys(instanceGatesConfig().destructiveArgs ?? {})));
  }

  // 4 — posture drift, delegated to the gate that owns it (#236) rather than reimplemented here
  const drift = runSubGate("gates/deploy-posture.mjs", ["--config", resolve(REPO, configPath), "--json"]);
  if (drift.missing) {
    rows.push(row("posture drift", false, "gate missing", drift.out));
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(drift.out);
    } catch {
      /* fall through to the raw tail below */
    }
    if (!parsed) {
      rows.push(row("posture drift", false, `exit ${drift.code}`, `could not parse gate output: ${drift.out.slice(0, 200)}`));
    } else {
      const bad = (parsed.results ?? []).filter((r) => r.status !== "ok");
      rows.push(
        parsed.ok
          ? row("posture drift", true, `inspected ${parsed.inspected} instance(s), all match`)
          : row("posture drift", false, `${bad.length} drifted`, bad.map((b) => `${b.repo}: ${b.detail}`).join("\n      ")),
      );
    }
  }

  // 6 — settlement/approval sanity, reported with what each collected
  rows.push(summarizeSubGate("approval blocks", "gates/approval-block-probe.mjs", runSubGate("gates/approval-block-probe.mjs", [])));
  rows.push(summarizeSubGate("settlement window", "gates/settlement-window.mjs", runSubGate("gates/settlement-window.mjs", [])));

  console.log(formatRows(rows, { json: asJson }));
  if (!asJson) console.log(`\nlog: ${logPath ?? "<none found>"} · base: ${base} · config: ${configPath}`);
  return rows.every((r) => r.ok) ? 0 : 1;
}

/**
 * Run only when invoked directly. The naive `import.meta.url === pathToFileURL(process.argv[1]).href` comparison
 * silently no-ops — exit code 0, no output — whenever the invocation path traverses a symlink, which on macOS is
 * every `/var/folders/...` temp dir (it resolves to `/private/var/...`). A verifier that runs nothing and reports
 * success is the exact defect this file catalogs (#236), so both sides are realpath'd before comparing.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`verify-deploy-posture: crashed: ${err?.stack ?? err}`);
      process.exit(2);
    },
  );
}
