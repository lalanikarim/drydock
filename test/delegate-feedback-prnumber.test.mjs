// #214 — a model-supplied feedback.prNumber that cannot name a pull request must be REFUSED AT THE TOOL
// BOUNDARY, not faulted at spawn.
//
// Live shape this prevents (engram#65 dispatch, build 723161b): the worker was approval-blocked before any PR
// existed, the orchestrator passed prNumber=0 to mean "none", and the run died as
//   SPAWN FAULT: Error: worker refuses to rework: feedback.prNumber is not a pull request number (0)
// — recorded in the settlement ledger as `failing`, i.e. an agent defect, for something that was a caller
// mistake with no PR to point at (#188's failure family, one layer up).
//
// The stubs here are hostile in the direction reality is awkward: every kernel touchpoint PAST the boundary
// throws, so a test can only pass if the refusal genuinely creates nothing and consults nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { factoryDelegateTool, reworkPrNumberReject } from "../factory/worker.ts";
import { emptyBudgetLedger } from "../factory/budget-ledger.ts";

const MODEL = { provider: "aurora", modelId: "some/served-model" };

/** An api stub where everything beyond the boundary explodes. If delegate reaches any of these, the test fails
 * for the right reason: work happened that should not have. */
function unreachableApi(calls) {
  return {
    taskId: "task-caller",
    snapshot: async () => {
      calls.push("snapshot");
      throw new Error("must not consult the budget ledger — a refused call must cost nothing");
    },
    createTask: async () => {
      calls.push("createTask");
      throw new Error("must not create a task — refusal happens before scheduling");
    },
    waitForTask: async () => {
      calls.push("waitForTask");
      throw new Error("must not wait on a task that was never created");
    },
  };
}

const textOf = (result) => result?.output?.[0]?.text ?? "";

test("delegate refuses feedback.prNumber=0 as a tool result, and touches nothing", async () => {
  const calls = [];
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

  const result = await tool.execute(
    { issueNumber: 65, feedback: { prNumber: 0, directive: "instruct", instruction: "apply the review" } },
    unreachableApi(calls),
    {},
  );

  assert.deepEqual(calls, [], `refusal must not touch the kernel at all, saw: ${calls.join(",")}`);

  const payload = JSON.parse(textOf(result));
  assert.equal(payload.refused, true, "shaped like the other terminal refusals: refused + retryable");
  assert.equal(payload.retryable, false, "re-sending the same arguments cannot succeed — omit feedback instead");
  assert.match(payload.error, /feedback\.prNumber is not a pull request number \(0\)/, "names the offending value");
  assert.match(payload.error, /No task was created/, "says plainly that nothing happened");
  // The actionable part: without this the model has to guess why, which is how it invented 0 in the first place.
  assert.match(payload.hint, /omit `feedback`/);
  assert.match(payload.hint, /EXISTING open pull request/);
});

test("the boundary refuses every shape a model uses for 'no PR yet', and non-numbers besides", async () => {
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
  for (const bad of [0, -3, null, undefined, "none", "abc", 1.5, NaN]) {
    const calls = [];
    const result = await tool.execute(
      { issueNumber: 65, feedback: { prNumber: bad, directive: "instruct", instruction: "x" } },
      unreachableApi(calls),
      {},
    );
    assert.deepEqual(calls, [], `prNumber=${String(bad)} must not reach the kernel`);
    const payload = JSON.parse(textOf(result));
    assert.equal(payload.refused, true, `prNumber=${String(bad)} must be refused`);
  }
});

test("the shared predicate is the single rule: same values refused at spawn and at the boundary", () => {
  for (const bad of [0, -1, null, undefined, "abc", 2.5]) {
    assert.match(String(reworkPrNumberReject(bad)), /is not a pull request number/, `${String(bad)} must be rejected`);
  }
  assert.equal(reworkPrNumberReject(42), undefined);
  assert.equal(reworkPrNumberReject(1), undefined);
});

test("a real PR number still delegates, with feedback forwarded intact", async () => {
  const created = [];
  const api = {
    taskId: "task-caller",
    snapshot: async () => emptyBudgetLedger(),
    createTask: async (_def, input) => {
      created.push(input);
      return "task-1";
    },
    waitForTask: async () => ({ state: { outcome: { status: "completed", result: { answer: "done" } } } }),
  };
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

  const result = await tool.execute(
    { issueNumber: 65, feedback: { prNumber: 42, directive: "instruct", instruction: "rename totalAmount" } },
    api,
    {},
  );

  assert.equal(created.length, 1, "a valid rework request must still create exactly one task");
  assert.deepEqual(created[0].feedback, { prNumber: 42, directive: "instruct", instruction: "rename totalAmount" });
  assert.equal(created[0].issueNumber, 65);
  assert.equal(created[0].modelId, MODEL.modelId, "the model ref is merged in as before");
  assert.match(textOf(result), /"report":"done"/);
});

test("delegate without feedback is unaffected (the ordinary path cannot depend on the new check)", async () => {
  const created = [];
  const api = {
    taskId: "task-caller",
    snapshot: async () => emptyBudgetLedger(),
    createTask: async (_def, input) => {
      created.push(input);
      return "task-2";
    },
    waitForTask: async () => ({ state: { outcome: { status: "completed", result: { answer: "ok" } } } }),
  };
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
  await tool.execute({ issueNumber: 9 }, api, {});

  assert.equal(created.length, 1);
  assert.equal("feedback" in created[0], false, "no feedback key may be invented for the ordinary path");
});

test("the spawn-phase guard is still wired (defense in depth for direct /tasks submissions)", () => {
  // Structural on purpose. Reaching spawn for real needs git credentials, a sandbox image, and a clone — and the
  // alternative is that nobody asserts this line survives, which is how a "cleanup" would silently remove the only
  // guard a direct POST /tasks submission meets. Its behavior was observed live rather than inferred: the SPAWN
  // FAULT at the top of this file is what build 723161b produced for prNumber=0 before the boundary check existed.
  const src = readFileSync(fileURLToPath(new URL("../factory/worker.ts", import.meta.url)), "utf8");
  assert.match(
    src,
    /const reject = reworkPrNumberReject\(feedback\.prNumber\);\s*\n\s*if \(reject\) throw new Error\(`worker refuses to rework: \$\{reject\}`\)/,
    "spawn must still throw on the same predicate — delegate is not the only way in",
  );
  // And the message a faulted direct submission produces is unchanged, so existing log/runbook matches hold.
  assert.match(src, /worker refuses to rework: \$\{reject\}/);
});
