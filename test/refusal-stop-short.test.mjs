// #100 — integration proof at the gate that does the refusing, not around it.
//
// The unit checks (`test/refusal-budget.test.mjs`) prove the arithmetic. These prove the properties
// that actually mattered after issue #99 spent six worker+review cycles on an impossible task:
//
//   * a refusal carries `retryable`, so the orchestrator does not infer permanence from prose;
//   * the second identical refusal terminates the run;
//   * once terminated, open_draft_pr refuses **before** any git work — proven by deleting the
//     workspace out from under it and still getting the terminal payload instead of "no local branch";
//   * a fresh budget on the same repository state does not short-circuit (so the stop is state, not
//     an artifact of the fixture);
//   * no reviewer inference is spent on any of it, and origin's tip never moves.
//
//   node --experimental-strip-types --test test/refusal-stop-short.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openDraftPrTool } = await import("../factory/open-draft-pr.ts");
const { RefusalBudget } = await import("../factory/refusal-budget.ts");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Scratch repo + factory-shaped workspace whose branch changes `changedFile`. */
function makeFixture({ failing = false, changedFile = "suite.test.mjs" }) {
  const root = mkdtempSync(join(tmpdir(), "budget-"));
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

  const workDir = join(root, "work");
  mkdirSync(workDir);
  const ws = join(workDir, "issue-1");
  execFileSync("git", ["clone", "-q", "--branch", "main", bare, ws]);
  // The branch the factory looks for is `agent/issue-<n>`; it exists only in the workspace, which is
  // what makes "was anything pushed" a real assertion rather than a tautology.
  git(ws, "checkout", "-q", "-b", "agent/issue-1");
  git(ws, "config", "user.email", "test@example.com");
  git(ws, "config", "user.name", "Test");

  const content = changedFile.endsWith(".mjs")
    ? failing
      ? "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('wrong', () => { assert.equal(1, 2); });\n"
      : "import test from 'node:test';\ntest('fine', () => {});\n"
    : JSON.stringify({ name: "scratch", scripts: {}, touchedByWorker: true }) + "\n";
  writeFileSync(join(ws, changedFile), content);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "worker: attempt");

  return { root, bare, workDir, ws, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function stubApi(shared) {
  const calls = shared ?? [];
  return {
    calls,
    api: {
      conversationId: 1,
      taskId: 1,
      createTask: async () => {
        calls.push("createTask");
        throw new Error("review stage reached (unexpected: every refusal here precedes it)");
      },
      waitForTask: async () => {
        calls.push("waitForTask");
        throw new Error("review stage reached (unexpected)");
      },
      scanEntries: async () => ({ items: [] }),
    },
  };
}

const payloadOf = async (tool, shared) => {
  const { calls, api } = stubApi(shared);
  const result = await tool.execute({ issueNumber: 1, title: "t", summary: "s" }, api, {});
  return { payload: JSON.parse(result.output.map((o) => o.text).join("")), calls };
};

const makeTool = (fx, budget, extra = {}) =>
  openDraftPrTool({
    workDir: fx.workDir,
    fixturesRepo: "octo/scratch",
    ghToken: "",
    modelRef: { provider: "p", modelId: "m" },
    reviewerTaskDef: { name: "unused" },
    testCommand: "node --test",
    requireVerification: true,
    refusalBudget: budget,
    ...extra,
  });

test("a verification refusal says retryable:true and stops the run on its second identical occurrence", async () => {
  const fx = makeFixture({ failing: true });
  const beforeSha = git(fx.bare, "rev-parse", "main");
  try {
    const budget = new RefusalBudget();
    const tool = makeTool(fx, budget);

    const first = await payloadOf(tool);
    assert.equal(first.payload.refused, true);
    assert.equal(first.payload.retryable, true, "a red suite is fixable, so the first refusal stays retryable");
    assert.equal(first.payload.terminal, undefined);
    assert.equal(first.payload.attempts, 1);

    const second = await payloadOf(tool);
    assert.equal(second.payload.terminal, true, "an identical red run twice proves nothing changed");
    assert.equal(second.payload.runStopped, true);
    assert.equal(second.payload.identicalAttempts, 2);
    assert.match(second.payload.stopReason, /identical verification refusals/);
    assert.match(second.payload.hint, /Do not re-delegate/);

    assert.deepEqual([...first.calls, ...second.calls], [], "no reviewer inference is spent on a refused run");
    assert.equal(git(fx.bare, "rev-parse", "main"), beforeSha, "origin never moves");
  } finally {
    fx.cleanup();
  }
});

test("once stopped, the tool refuses before touching git — no workspace required", async () => {
  const fx = makeFixture({ failing: true });
  try {
    const budget = new RefusalBudget();
    const tool = makeTool(fx, budget);
    await payloadOf(tool);
    await payloadOf(tool);

    // Remove the workspace entirely. Without a real short-circuit this returns the "no local branch …
    // and no remote branch to recover" error (and would then retry against origin); with one it is the
    // same terminal payload, because nothing runs.
    rmSync(fx.ws, { recursive: true, force: true });
    const third = await payloadOf(tool);
    assert.equal(third.payload.runStopped, true);
    assert.equal(third.payload.error, undefined, "the missing workspace must not even be noticed");
    assert.equal(third.payload.identicalAttempts, 2, "counts stay frozen after the stop");
  } finally {
    fx.cleanup();
  }
});

test("control: a fresh budget over the same repository state does not short-circuit", async () => {
  const fx = makeFixture({ failing: true });
  try {
    const first = await payloadOf(makeTool(fx, new RefusalBudget()));
    assert.equal(first.payload.refused, true);
    assert.equal(first.payload.runStopped, undefined, "the stop is per-run state, not a property of the branch");
  } finally {
    fx.cleanup();
  }
});

test("a path-scope refusal is labelled non-retryable from the first one and terminal on the second", async () => {
  const fx = makeFixture({ changedFile: "package.json" });
  try {
    const budget = new RefusalBudget();
    const tool = makeTool(fx, budget, { pathScope: { allowlist: ["src/"], protectedPaths: [] } });

    const first = await payloadOf(tool);
    assert.equal(first.payload.refused, true);
    assert.match(first.payload.reason, /path scope violation/);
    assert.equal(first.payload.retryable, false, "policy cannot change during a run — this is the #99 case");
    assert.equal(first.payload.terminal, undefined, "one refusal still gives the orchestrator a chance to narrow the change");
    assert.deepEqual(first.payload.offenders.map((o) => o.file), ["package.json"]);

    const second = await payloadOf(tool);
    assert.equal(second.payload.terminal, true);
    assert.match(second.payload.stopReason, /2 identical path_scope refusals/);
    assert.match(second.payload.hint, /pathAllowlist/, "the human way out is named");
    assert.deepEqual([...first.calls, ...second.calls], [], "scope runs are refused before the reviewer too");
  } finally {
    fx.cleanup();
  }
});

test("a green suite still reaches the next gate (the budget does not swallow successes)", async () => {
  const fx = makeFixture({ failing: false });
  try {
    const budget = new RefusalBudget();
    const tool = makeTool(fx, budget);
    // The stub throws at createTask on purpose: reaching it is the assertion, and nothing past the
    // first reviewer call should happen.
    const calls = [];
    try {
      await payloadOf(tool, calls);
      assert.fail("expected the review stage to be reached (the stub throws there)");
    } catch (e) {
      assert.match(e.message, /review stage reached/);
    }
    // The observable effect that matters: exactly one reviewer call, and nothing else.
    assert.deepEqual(calls, ["createTask"], "with a green suite the review stage must be reached — and only it");
    assert.equal(budget.ledger().length, 0, "reaching review is not a refusal");
  } finally {
    fx.cleanup();
  }
});
