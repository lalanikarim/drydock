// #61 / decision C1 — integration proof at the actual gate, not around it.
//
// This drives openDraftPrTool().execute() directly against a scratch git repository whose branch
// has a failing test suite, with no GitHub token and no model involved. The point is to prove the
// properties that matter operationally:
//
//   * a red verification run refuses the push (the §5.16 failure mode becomes impossible);
//   * nothing reaches the remote — the branch sha there is unchanged and no PR machinery ran;
//   * the refusal names the command and exit code, so the orchestrator can rework from it;
//   * with the suite green the gate stops at the NEXT stage (review), i.e. verification is not the
//     only thing standing between a branch and a PR.
//
//   node --experimental-strip-types --test test/verification-push-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openDraftPrTool } = await import("../factory/open-draft-pr.ts");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A scratch repo with origin/main and an agent/issue-<n> branch whose suite is red or green.
 * `workDir` mirrors the factory layout: <workDir>/issue-<n>.
 */
function makeFixture({ failing }) {
  const root = mkdtempSync(join(tmpdir(), "odp-"));
  const bare = join(root, "origin.git");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["init", "--initial-branch=main", clone]);
  writeFileSync(join(clone, "package.json"), JSON.stringify({ name: "scratch", scripts: {} }) + "\n");
  git(clone, "config", "user.email", "test@example.com");
  git(clone, "config", "user.name", "Test");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "remote", "add", "origin", bare);
  git(clone, "push", "-q", "-u", "origin", "main");

  // A prior attempt already sits on origin: the realistic shape after one rejected run. The
  // workspace then gains a NEW commit that origin has never seen, so "nothing was pushed" is a
  // claim about a moving target rather than a tautology.
  git(clone, "checkout", "-q", "-b", "agent/issue-1");
  writeFileSync(join(clone, "prior-attempt.md"), "first attempt\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "worker: prior attempt");
  git(clone, "push", "-q", "-u", "origin", "agent/issue-1");

  // The workspace the factory sees: same branch, one unpushed commit on top.
  const workDir = join(root, "work");
  mkdirSync(workDir);
  const ws = join(workDir, "issue-1");
  execFileSync("git", ["clone", "-q", "--branch", "agent/issue-1", bare, ws]);
  writeFileSync(
    join(ws, "suite.test.mjs"),
    failing
      ? "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the change is wrong', () => { assert.equal(1, 2); });\n"
      : "import test from 'node:test';\ntest('the change is fine', () => {});\n",
  );
  git(ws, "config", "user.email", "test@example.com");
  git(ws, "config", "user.name", "Test");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "worker: implement issue 1");
  const localHead = git(ws, "rev-parse", "HEAD");
  const remoteTip = git(bare, "rev-parse", "agent/issue-1");
  assert.notEqual(localHead, remoteTip, "fixture must have an unpushed commit for the gate to withhold");
  return { root, bare, workDir, ws, localHead, remoteTip, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Minimal stand-in for the durable tool API. Any call means the gate let the run go further than
 *  verification — which is exactly what these tests must not allow silently. */
function stubApi() {
  const calls = [];
  return {
    calls,
    api: {
      conversationId: 1,
      taskId: 1,
      createTask: async () => {
        calls.push("createTask");
        throw new Error("review stage reached (unexpected in a verification refusal)");
      },
      waitForTask: async () => {
        calls.push("waitForTask");
        throw new Error("review stage reached (unexpected in a verification refusal)");
      },
      scanEntries: async () => ({ items: [] }),
    },
  };
}

const resultText = (result) => result.output.map((o) => o.text).join("");

test("a red test suite refuses the push, and nothing reaches origin", async () => {
  const fx = makeFixture({ failing: true });
  try {
    const beforeSha = git(fx.bare, "rev-parse", "agent/issue-1"); // pushed by the clone step above
    const tool = openDraftPrTool({
      workDir: fx.workDir,
      fixturesRepo: "octo/scratch",
      ghToken: "",
      modelRef: { provider: "p", modelId: "m" },
      reviewerTaskDef: { name: "unused" },
      testCommand: "node --test",
      requireVerification: true,
    });

    const { calls, api } = stubApi();
    const result = await tool.execute({ issueNumber: 1, title: "t", summary: "s" }, api, {});
    const payload = JSON.parse(resultText(result));

    assert.equal(payload.refused, true, `expected refusal, got ${resultText(result)}`);
    assert.match(payload.reason, /`node --test` exited 1/);
    assert.match(payload.reason, /nothing was pushed/);
    assert.equal(payload.verification.exitCode, 1, "the exit code is recorded verbatim in the refusal");
    assert.match(payload.verification.tail, /the change is wrong/, "the failing output travels with the refusal for rework");
    assert.deepEqual(calls, [], "a refused verification must not spend reviewer inference");

    const afterSha = git(fx.bare, "rev-parse", "agent/issue-1");
    assert.equal(afterSha, beforeSha, "origin's branch tip must be untouched by a refused run");
  } finally {
    fx.cleanup();
  }
});

test("a green suite passes the verification gate (and stops at the next one)", async () => {
  const fx = makeFixture({ failing: false });
  try {
    const tool = openDraftPrTool({
      workDir: fx.workDir,
      fixturesRepo: "octo/scratch",
      ghToken: "",
      modelRef: { provider: "p", modelId: "m" },
      reviewerTaskDef: { name: "unused" },
      testCommand: "node --test",
      requireVerification: true,
    });
    const { calls, api } = stubApi();
    await assert.rejects(
      () => tool.execute({ issueNumber: 1, title: "t", summary: "s" }, api, {}),
      /review stage reached/,
      "verification passed, so the review gate is the next thing to run",
    );
    assert.deepEqual(calls, ["createTask"]);
  } finally {
    fx.cleanup();
  }
});

test("waived repo: no test command is policy-disclosed, but a red suite still blocks the push", async () => {
  // The escape hatch covers "nothing to run", never "it failed".
  const fx = makeFixture({ failing: true });
  try {
    const tool = openDraftPrTool({
      workDir: fx.workDir,
      fixturesRepo: "octo/scratch",
      ghToken: "",
      modelRef: { provider: "p", modelId: "m" },
      reviewerTaskDef: { name: "unused" },
      testCommand: null, // no test command at all
      requireVerification: false, // and policy waives it
      pathScope: { allowlist: null, protectedPaths: [] },
    });
    const { calls, api } = stubApi();
    await assert.rejects(
      () => tool.execute({ issueNumber: 1, title: "t", summary: "s" }, api, {}),
      /review stage reached/,
      "waived + no command: nothing to verify, so the run proceeds to review with a NOT VERIFIED body",
    );

    // Same waived policy, but now there IS a command and it is red → blocked.
    const redTool = openDraftPrTool({
      workDir: fx.workDir,
      fixturesRepo: "octo/scratch",
      ghToken: "",
      modelRef: { provider: "p", modelId: "m" },
      reviewerTaskDef: { name: "unused" },
      testCommand: "node --test",
      requireVerification: false,
      pathScope: { allowlist: null, protectedPaths: [] },
    });
    const second = stubApi();
    const result = await redTool.execute({ issueNumber: 1, title: "t", summary: "s" }, second.api, {});
    const payload = JSON.parse(resultText(result));
    assert.equal(payload.refused, true);
    assert.match(payload.reason, /waives the requirement to verify, but not a failing run/);
    assert.deepEqual(second.calls, []);
  } finally {
    fx.cleanup();
  }
});
