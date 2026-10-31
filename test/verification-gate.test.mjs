// #61 / decision C1: a draft PR cannot exist without recorded verification, and a failing run
// cannot be talked past. The gate decision is pure, so the whole matrix is exercised here;
// verifyWorkspace is exercised against real processes in a scratch workspace.
//   node --experimental-strip-types --test test/verification-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkspace, verificationGate, formatVerificationEvidence } from "../factory/verification.ts";

const passing = { ran: true, command: "npm test", exitCode: 0, timedOut: false, passed: true, tail: "" };
const failing = { ran: true, command: "npm test", exitCode: 1, timedOut: false, passed: false, tail: "1 fail" };
const timeout = { ran: true, command: "npm test", exitCode: null, timedOut: true, passed: false, tail: "" };
const nothing = { ran: false, command: null, exitCode: null, timedOut: false, passed: false, tail: "", skippedReason: "no test command configured for this repo" };

test("gate matrix — required repo", () => {
  assert.equal(verificationGate(passing, { requireVerification: true }).action, "proceed");
  assert.equal(verificationGate(failing, { requireVerification: true }).action, "refuse");
  assert.equal(verificationGate(timeout, { requireVerification: true }).action, "refuse");
  const noCmd = verificationGate(nothing, { requireVerification: true });
  assert.equal(noCmd.action, "refuse");
  assert.match(String(noCmd.reason), /no test command is configured/);
  assert.match(String(noCmd.reason), /requireVerification:false/); // names the way out
});

test("gate matrix — waived repo still refuses known-red and hung runs", () => {
  // The waiver covers "this repo has no suite", not "this repo's suite is red".
  assert.equal(verificationGate(nothing, { requireVerification: false }).action, "proceed");
  assert.equal(verificationGate(passing, { requireVerification: false }).action, "proceed");
  const red = verificationGate(failing, { requireVerification: false });
  assert.equal(red.action, "refuse");
  assert.match(String(red.reason), /waives the requirement to verify, but not a failing run/);
  assert.equal(verificationGate(timeout, { requireVerification: false }).action, "refuse");
});

test("refusal reasons name the command and exit code, never just 'failed'", () => {
  const d = verificationGate(failing, { requireVerification: true });
  assert.match(String(d.reason), /`npm test`/);
  assert.match(String(d.reason), /exited 1/);
  assert.match(String(d.reason), /nothing was pushed/);
});

test("evidence formatting names command + exit code; a waiver is unmissable", () => {
  const ok = formatVerificationEvidence(passing);
  assert.match(ok, /Command: `npm test`/);
  assert.match(ok, /Exit code: 0/);
  assert.match(ok, /Result: PASS/);

  const bad = formatVerificationEvidence(failing);
  assert.match(bad, /Result: FAIL \(exit 1\)/);

  const waived = formatVerificationEvidence(nothing, { requireVerification: false });
  assert.match(waived, /\*\*NOT VERIFIED — nothing was executed\.\*\*/);
  assert.match(waived, /requireVerification: false/);
  assert.match(waived, /only verification it has had/);
});

test("verifyWorkspace records exit code and output for real commands", async () => {
  const ws = mkdtempSync(join(tmpdir(), "verify-"));
  writeFileSync(join(ws, "pass.mjs"), "console.log('# tests 3\\n# pass 3\\n# fail 0');\n");
  writeFileSync(join(ws, "fail.mjs"), "console.error('boom: expected 1 got 2');\nprocess.exit(1);\n");

  const ok = await verifyWorkspace({ cwd: ws, testCommand: "node pass.mjs" });
  assert.equal(ok.ran, true);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.passed, true);
  // Counts are parsed only for `node --test`; any other command reports exit status alone, so the
  // evidence never claims a test count it did not see.
  assert.deepEqual([ok.total, ok.passCount, ok.failCount], [undefined, undefined, undefined]);
  assert.equal(verificationGate(ok).action, "proceed");

  writeFileSync(join(ws, "suite.test.mjs"), "import test from 'node:test';\ntest('t', () => {});\n");
  const nodeTest = await verifyWorkspace({ cwd: ws, testCommand: "node --test" });
  assert.equal(nodeTest.passed, true);
  assert.deepEqual([nodeTest.total, nodeTest.passCount, nodeTest.failCount], [1, 1, 0]);

  const bad = await verifyWorkspace({ cwd: ws, testCommand: "node fail.mjs" });
  assert.equal(bad.passed, false);
  assert.equal(bad.exitCode, 1, "the exit code is the evidence — it must be recorded verbatim");
  assert.match(bad.tail, /boom: expected 1 got 2/);
  assert.equal(verificationGate(bad).action, "refuse");

  const missing = await verifyWorkspace({ cwd: ws, testCommand: null });
  assert.equal(missing.ran, false);
  assert.equal(verificationGate(missing).action, "refuse");
});

test("exit 0 with zero tests collected is NOT verification (vacuous green)", async () => {
  // A runner that matched no test files can still exit 0. That must never satisfy the gate.
  const ws = mkdtempSync(join(tmpdir(), "verify-empty-"));
  writeFileSync(join(ws, "readme.md"), "no tests here\n");
  const res = await verifyWorkspace({ cwd: ws, testCommand: "node --test" });
  assert.equal(res.vacuous, true, `expected vacuous, got ${JSON.stringify(res)}`);
  assert.equal(res.passed, false);
  for (const requireVerification of [true, false]) {
    const d = verificationGate(res, { requireVerification });
    assert.equal(d.action, "refuse", `zero tests must refuse even when verification is waived (requireVerification=${requireVerification})`);
    assert.match(String(d.reason), /collected no tests/);
  }
  assert.match(formatVerificationEvidence(res), /collected zero tests/);
});

test("the outer harness's own runner state cannot neuter the verification run", async () => {
  // Regression guard for a real defect found while writing this gate: node's test runner inherits
  // NODE_TEST_CONTEXT, prints "skipping running files", and exits 0 having run nothing. The child
  // env must be stripped so a nested `node --test` actually runs the suite.
  const ws = mkdtempSync(join(tmpdir(), "verify-ctx-"));
  writeFileSync(join(ws, "real.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('genuine', () => { assert.equal(1, 1); });\n");
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const res = await verifyWorkspace({ cwd: ws, testCommand: "node --test" });
    assert.equal(res.total, 1, `nested runner was skipped: ${JSON.stringify(res)}`);
    assert.equal(res.passed, true);
    assert.equal(res.vacuous, undefined);
  } finally {
    delete process.env.NODE_TEST_CONTEXT;
  }
});

test("a hanging suite is a timeout, not a pass, and cannot be pushed", async () => {
  const ws = mkdtempSync(join(tmpdir(), "verify-hang-"));
  writeFileSync(join(ws, "hang.mjs"), "setTimeout(() => process.exit(0), 60_000);\n");
  const res = await verifyWorkspace({ cwd: ws, testCommand: "node hang.mjs", timeoutSecs: 1 });
  assert.equal(res.timedOut, true, `expected timeout, got ${JSON.stringify(res)}`);
  assert.equal(res.passed, false);
  assert.match(res.tail, /exceeded 1s/);
  for (const requireVerification of [true, false]) {
    assert.equal(verificationGate(res, { requireVerification }).action, "refuse", `timeout must refuse even when verification is waived (requireVerification=${requireVerification})`);
  }
});

test("the test command is argv, never a shell — metacharacters cannot smuggle a second command", async () => {
  const ws = mkdtempSync(join(tmpdir(), "verify-argv-"));
  // Echoes its argv so we can see what the process actually received.
  writeFileSync(join(ws, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const res = await verifyWorkspace({ cwd: ws, testCommand: "node argv.mjs && touch pwned.txt" });

  // The security property that matters: `&&`/`touch` were arguments, not commands.
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(ws, "pwned.txt")), false, "shell metacharacters must never be interpreted");
  // The child received them as three inert arguments (slice(2) drops the script name itself).
  assert.match(res.tail, /\["&&","touch","pwned\.txt"\]/);
  assert.equal(res.exitCode, 0, "node ran and ignored the extra argv — proof there was no shell in between");
});
