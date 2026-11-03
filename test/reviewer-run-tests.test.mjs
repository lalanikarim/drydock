#!/usr/bin/env node
// Proves `run_tests` — the reviewer's only view of whether the suite passes — actually executes against the REAL
// execution environment, with the REAL argument arity.
//
// Why this exists: `ExecutionEnv.exec(command, options, context)` dereferences `context.abortSignal` on the first
// line, and `run_tests` called it with two arguments. Every call threw TypeError; the surrounding catch converted
// that into "[exec error: ...]" and returned `suite: pass=0 fail=0`. To a reviewing model that reads like a suite
// that ran and passed nothing. No test touched this tool, so it survived from the first commit until the first
// typecheck this repository ever ran (#173). A stub would have "passed" forever — hence NodeExecutionEnv, real
// child processes, real TAP output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import { makeReviewerRoleTools } from "../factory/reviewer.ts";

function workspaceWithSuite({ failing = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "reviewer-env-"));
  writeFileSync(
    path.join(dir, "a.test.mjs"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("passes", () => assert.equal(1, 1));\n${failing ? 'test("fails", () => assert.equal(1, 2));\n' : ""}`,
  );
  return dir;
}

// A child `node --test` started from inside a test file inherits NODE_TEST_CONTEXT and then refuses to run its own
// files ("run() is being called recursively within a test file") — exiting 0 with no TAP at all. Production
// sandboxes do not have that variable, so the command under test drops it. (`env` option alone does not: pi-durable
// merges over process.env, and an empty NODE_TEST_CONTEXT still counts as present.)
const SUITE_CMD = "env -u NODE_TEST_CONTEXT node --test";

function envFor(dir) {
  return new NodeExecutionEnv({ cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, inheritEnv: false });
}

function runTestsTool(testCommand) {
  const tools = makeReviewerRoleTools({ workDir: "/unused-in-this-test", testCommand });
  const tool = tools.find((t) => t.name === "run_tests");
  assert.ok(tool, `run_tests tool missing from ${tools.map((t) => t.name).join(", ")}`);
  return tool;
}

test("run_tests executes the suite and reports real counts", async () => {
  const dir = workspaceWithSuite();
  try {
    const tool = runTestsTool(SUITE_CMD);
    const api = { env: envFor(dir) };
    // The Context is only used for abortSignal by the env; a live run supplies the task's.
    const result = await tool.execute({}, api, {});
    const text = String(result.output?.[0]?.text ?? "");

    assert.match(text, /suite: pass=1 fail=0 exit=0/, `expected one passing test in:\n${text.slice(0, 400)}`);
    assert.doesNotMatch(text, /NOT RUN/, "a suite that ran must not be reported as NOT RUN");
    assert.doesNotMatch(text, /exec error/, `the exec contract is broken again:\n${text.slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing suite reports fail>0 and a non-zero exit code", async () => {
  const dir = workspaceWithSuite({ failing: true });
  try {
    const tool = runTestsTool(SUITE_CMD);
    const api = { env: envFor(dir) };
    const result = await tool.execute({}, api, {});
    const text = String(result.output?.[0]?.text ?? "");

    assert.match(text, /fail=1/, `expected a failing test to be counted:\n${text.slice(0, 400)}`);
    assert.match(text, /exit=[1-9]/, "a failed suite must not report exit=0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the env contract really is three arguments (regression guard for the swallowed TypeError)", async () => {
  const dir = workspaceWithSuite();
  try {
    const env = envFor(dir);
    // Exactly the call run_tests used to make. If this ever stops throwing, the third argument became optional and
    // the comment in reviewer.ts should be updated — but do not delete this test without re-reading it.
    await assert.rejects(
      () => env.exec(SUITE_CMD, { timeout: 30 }),
      (e) => /abortSignal/.test(e.message),
      "two-argument exec() was expected to throw on context.abortSignal",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a suite that cannot run says NOT RUN rather than pass=0", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reviewer-env-empty-"));
  try {
    const tool = runTestsTool("definitely-not-a-real-command");
    const api = { env: envFor(dir) };
    const result = await tool.execute({}, api, {});
    const text = String(result.output?.[0]?.text ?? "");

    // A shell that reports "command not found" is a non-zero exit, not a passing suite. Either way the tool must
    // not hand the reviewer `pass=0 fail=0` as if it were a result.
    const claimsCleanZero = /suite: pass=0 fail=0 exit=0/.test(text);
    assert.ok(!claimsCleanZero, `an unrunnable command was reported as a clean run:\n${text.slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
