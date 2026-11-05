// Unit tests for the pure parts of fleet/verify-deploy-posture.mjs (#220). Collected by `npm test`'s
// test/*.test.mjs glob.
//
// The rule these exist to enforce: a row may only say ok if something was observed. Every hostile fixture is built in
// the direction reality actually fails — fleet running an older sha, an orphaned child, a boot log whose posture line
// lost a tool, a sub-gate that exits 0 over nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  row,
  parseSupervisorPid,
  parseFleetProcesses,
  checkParenting,
  checkQuarantine,
  parsePostureLine,
  checkPostureLine,
  checkBuildIdentity,
  summarizeSubGate,
  formatRows,
  POSTURE_PREFIX,
} from "../fleet/verify-deploy-posture.mjs";

// Copied verbatim from /tmp/fleet-9b3a123.log on 2026-11-05. Not a plausible-looking fixture — the real string, with
// the nested commas in `edit(edits[].path,path)` and the prose tail, because that is what broke a naive parser here.
const REAL_POSTURE_LINE =
  `[gates] destructive floor judges effect-bearing args only for: write(path), edit(edits[].path,path), ` +
  `multi_edit(edits[].path,path), delegate(issueNumber), refine_issue(issueNumber), open_draft_pr(issueNumber), ` +
  `submit_verdict(nothing scanned), note_lesson(nothing scanned) — payload/prose is not scanned for these tools; ` +
  `device/credential/later-executed paths stay destructive`;

test("supervisor pid: the lock file's first line, or nothing at all", () => {
  assert.equal(parseSupervisorPid("4242\nsecond line\n"), 4242);
  assert.equal(parseSupervisorPid("  99 \n"), 99);
  assert.equal(parseSupervisorPid(""), null);
  assert.equal(parseSupervisorPid("not-a-pid\n"), null, "a lock file we cannot read a pid from must never default to anything");
  assert.equal(parseSupervisorPid(undefined), null);
});

test("ps parsing: fleet processes only, and never this verifier", () => {
  const ps = [
    "  100     1  node --experimental-strip-types fleet/supervisor.ts run fleet/fleet.local.json",
    "  101   100  node --experimental-strip-types factory/main.ts --repo lalanikarim/drydock",
    "  102   100  node --experimental-strip-types factory/adapter.ts --config fleet/fleet.local.json",
    "  103   100  grep -E factory/main[.]ts|adapter[.]ts",
    "  104   500  node --experimental-strip-types fleet/verify-deploy-posture.mjs",
    "  105   100  /bin/sh -c sleep 300",
  ].join("\n");
  const procs = parseFleetProcesses(ps);
  const pids = procs.map((p) => p.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [101, 102], `expected the two fleet children only, got ${JSON.stringify(procs)}`);
  assert.equal(procs.find((p) => p.pid === 101).ppid, 100);
});

test("parenting: all children of the supervisor passes and says how many", () => {
  const procs = parseFleetProcesses("  2  1  node factory/main.ts\n  3  1  node factory/adapter.ts");
  const r = checkParenting(procs, 1);
  assert.equal(r.ok, true);
  assert.match(r.value, /2\/2 children of 1/);
});

test("parenting: an orphan is a hard failure naming pid and ppid", () => {
  const procs = parseFleetProcesses("  2  1  node factory/main.ts\n  3  77  node factory/adapter.ts");
  const r = checkParenting(procs, 1);
  assert.equal(r.ok, false, "ppid 77 must not pass as parented");
  assert.match(r.value, /1 orphan\(s\) of 2/);
  assert.match(r.detail, /pid 3 ppid 77 ≠ supervisor 1/);
});

test("parenting: zero processes is a failure, never 'no orphans'", () => {
  const r = checkParenting([], 1);
  assert.equal(r.ok, false, "an empty process list passes 'no orphans' vacuously — that is the R6b defect this file exists to avoid");
  assert.match(r.detail, /not running/);
});

test("parenting: an unreadable supervisor pid refuses to infer", () => {
  const r = checkParenting(parseFleetProcesses("  2  1  node factory/main.ts"), null);
  assert.equal(r.ok, false);
  assert.match(r.detail, /refusing to infer/);
});

test("quarantine: clean log passes, any line fails and is quoted", () => {
  assert.equal(checkQuarantine("booting\nready\n").ok, true);
  const r = checkQuarantine("booting\n[supervisor] quarantining lalanikarim/drydock: boot failed\n");
  assert.equal(r.ok, false);
  assert.match(r.value, /1 line\(s\)/);
  assert.match(r.detail, /quarantining lalanikarim\/drydock/);
});

test("posture line: the real production string parses into tool names, not fragments", () => {
  const got = parsePostureLine(`noise\n${REAL_POSTURE_LINE}\nmore noise`);
  assert.equal(got.present, true);
  for (const tool of ["write", "edit", "multi_edit", "delegate", "refine_issue", "open_draft_pr", "submit_verdict", "note_lesson"]) {
    assert.ok(got.tools.includes(tool), `expected ${tool} in ${JSON.stringify(got.tools)}`);
  }
  // The two ways a naive split fails, asserted directly:
  for (const junk of ["path", "nothing scanned", "edits[].path", "— payload/prose is not scanned for these tools"]) {
    assert.ok(!got.tools.includes(junk), `parser leaked fragment ${JSON.stringify(junk)} into ${JSON.stringify(got.tools)}`);
  }
});

test("posture line: absent log line fails — a silent floor is the #53/#69 hazard", () => {
  const r = checkPostureLine("booting\nready\n", ["delegate"]);
  assert.equal(r.ok, false);
  assert.match(r.value, /absent/);
  assert.match(r.detail, new RegExp(POSTURE_PREFIX.slice(0, 20).replace(/[[\]]/g, "\\$&")));
});

test("posture line: a narrowed tool missing from the booted build is named", () => {
  const partial = REAL_POSTURE_LINE.replace(", submit_verdict(nothing scanned)", "");
  const r = checkPostureLine(partial, ["delegate", "submit_verdict"]);
  assert.equal(r.ok, false, "the fleet ran a build without the full declaration");
  assert.match(r.value, /missing submit_verdict/);
});

test("build identity: running sha must equal the checkout", () => {
  assert.equal(checkBuildIdentity({ build: { sha: "abc1234" } }, "abc1234").ok, true);
  const stale = checkBuildIdentity({ build: { sha: "9b3a123" } }, "9cade1c");
  assert.equal(stale.ok, false, "fleet older than the tree is THE failure this issue exists for");
  assert.match(stale.value, /running 9b3a123 ≠ checkout 9cade1c/);
});

test("build identity: missing halves fail instead of comparing undefined", () => {
  assert.equal(checkBuildIdentity({ status: "unreachable" }, "abc1234").ok, false);
  assert.match(checkBuildIdentity({ status: "unreachable" }, "abc1234").value, /no build\.sha/);
  const noCheckout = checkBuildIdentity({ build: { sha: "abc1234" } }, "");
  assert.equal(noCheckout.ok, false);
  assert.match(noCheckout.detail, /refusing to compare against nothing/);
});

test("sub-gate: exit 0 with its collection line is the only way to ok", () => {
  const settlement = summarizeSubGate("settlement window", "gates/settlement-window.mjs", {
    code: 0,
    missing: false,
    out: "all: completed=3 failing=0 modelUnavailable=0 unanswered=0 aborted=0 restarted=0 unsettled=0 inFlight=0 waiting=0\n",
  });
  assert.equal(settlement.ok, true);
  assert.match(settlement.value, /exit 0 · all: completed=3/);

  const approval = summarizeSubGate("approval blocks", "gates/approval-block-probe.mjs", {
    code: 0,
    missing: false,
    out: "\n12 blocked conversation(s): 7 explained by detection, 0 drifted/failed\nOK — every blocked conversation.\n",
  });
  assert.equal(approval.ok, true);
  assert.match(approval.value, /12 blocked conversation\(s\)/);
});

test("sub-gate: exit 0 with NO collection line is a failure (R6b/R10)", () => {
  const r = summarizeSubGate("mystery", "gates/mystery.mjs", { code: 0, missing: false, out: "done\n" });
  assert.equal(r.ok, false, "a gate that collected nothing must not be reported as passing");
  assert.match(r.detail, /without printing its collection line/);
});

test("sub-gate: non-zero exit and a missing gate both fail", () => {
  const red = summarizeSubGate("settlement window", "gates/settlement-window.mjs", {
    code: 1,
    missing: false,
    out: "all: completed=1 failing=2 modelUnavailable=0 unanswered=0 aborted=0 restarted=0 unsettled=1 inFlight=0 waiting=0\nunexamined rows\n",
  });
  assert.equal(red.ok, false);
  assert.match(red.value, /exit 1/);

  const gone = summarizeSubGate("approval blocks", "gates/nope.mjs", { code: null, missing: true, out: "gates/nope.mjs does not exist" });
  assert.equal(gone.ok, false, "#236: the gate I 'ran' did not exist and reported success through a pipe");
  assert.match(gone.value, /gate missing/);
});

test("formatting: PASS only when every row is ok; FAIL counts them", () => {
  const green = formatRows([row("build identity", true, "9cade1c"), row("b", true, "2")]);
  assert.ok(green.split("\n")[0] === "ok   build identity  9cade1c", green.split("\n")[0]);
  assert.match(green, /PASS/);
  const red = formatRows([row("a", true, "1"), row("b", false, "2", "why")]);
  assert.match(red, /FAIL — 1 of 2 assertions/);
  assert.match(red, /why/);
  assert.ok(!/^PASS$/m.test(red));

  const parsed = JSON.parse(formatRows([row("a", true, "1"), row("b", false, "2")], { json: true }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rows.length, 2);
});

test("main refuses to run when the lock file is absent — no silent 'nothing to check' success", () => {
  // Copy ONLY the script into a fake repo root: REPO resolves relative to the file, so the lock file is genuinely
  // missing and main() must bail with exit 2 before touching /health or `ps`.
  const tmp = mkdtempSync(join(tmpdir(), "vdp-"));
  mkdirSync(join(tmp, "fleet"), { recursive: true });
  copyFileSync(new URL("../fleet/verify-deploy-posture.mjs", import.meta.url), join(tmp, "fleet", "verify-deploy-posture.mjs"));
  try {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", join(tmp, "fleet", "verify-deploy-posture.mjs")], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stderr}${r.stdout}`, /cannot read .*routes\.json\.lock/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("invoked through a symlinked path it still runs (a silent no-op exits 0 and lies)", async () => {
  // macOS resolves /var → /private/var, which broke the first version of this file's main guard: exit 0, no output.
  const { symlinkSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "vdp-link-"));
  const real = join(tmp, "real");
  mkdirSync(join(real, "fleet"), { recursive: true });
  copyFileSync(new URL("../fleet/verify-deploy-posture.mjs", import.meta.url), join(real, "fleet", "verify-deploy-posture.mjs"));
  symlinkSync(real, join(tmp, "link"));
  try {
    const viaLink = join(tmp, "link", "fleet", "verify-deploy-posture.mjs");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", viaLink], { encoding: "utf8", timeout: 60_000 });
    assert.ok(
      `${r.stdout}${r.stderr}`.length > 0,
      "invoking through a symlink must still produce output — empty output with exit 0 is the bug this test exists for",
    );
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
