// #222 — after ONE wall-budget abort that produced no PR, `delegate` must refuse unless the caller states what
// changed (`replan`), and it must refuse a second concurrent run of the same issue.
//
// Live shape this prevents (drydock#220, build c993bdd): the worker aborted at wallSecsPerIssue=2400s; delegate
// returned {budgetAborted:true, retryable:false, hint:"Do not re-delegate…"}; the orchestrator re-delegated
// twice anyway (~40 min of inference each) because the structural stop only trips on the SECOND abort. A
// task-scoped operator abort did not stop it either — a worker for #220 was running again 0.8 min later, and
// only {conversationId:1545} ended the loop.
//
// Stubs follow this repo's rule (AGENTS.md, "a fake proves your assumption"): everything past the boundary
// throws, so a refusal can only pass by genuinely creating and committing nothing.
import test from "node:test";
import assert from "node:assert/strict";

import { factoryDelegateTool } from "../factory/worker.ts";
import {
  claimTtlMs,
  DEFAULT_CLAIM_TTL_MS,
  emptyBudgetLedger,
  noteOperatorAbort,
  notePrOpened,
  releaseClaim,
  requiresReplan,
} from "../factory/budget-ledger.ts";
import { prNumberFromPrUrl } from "../factory/open-draft-pr.ts";

const MODEL = { provider: "aurora", modelId: "some/served-model" };

// Stubs shared with test/replan-provenance.test.mjs — see test/helpers/delegate-fake-api.mjs for why they moved.
import { beyondBoundaryThrows, ledgerAfterOneBudgetAbort, ledgerApi, NOW, textOf } from "./helpers/delegate-fake-api.mjs";

test("one budget abort with no PR refuses a plain re-delegate and touches nothing past the ledger", async () => {
  const calls = [];
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
  const api = beyondBoundaryThrows(calls);
  // Only the ledger read is allowed to succeed; everything after it throws.
  api.snapshot = async () => {
    calls.push("snapshot");
    return ledgerAfterOneBudgetAbort();
  };

  const result = await tool.execute({ issueNumber: 220 }, api, {});

  assert.deepEqual(calls, ["snapshot"], `refusal must not commit, create, or wait — saw: ${calls.join(",")}`);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.refused, true, "same refusal vocabulary as #100/#141/#214");
  assert.equal(payload.requires, "replan", "names the argument that unlocks the call instead of being a bare no");
  assert.equal(payload.retryable, false, "the same arguments cannot succeed — that is the whole point");
  assert.equal(payload.attempts, 1, "says how much has already been spent");
  assert.match(payload.reason, /no pull request/i);
  assert.match(payload.hint, /replan/, "the hint must name the fix, or the model guesses (that is how #214 happened)");
  assert.match(payload.hint, /tell the human|the levers/i, "and says who owns the decision when nothing changed");
});

test("a whitespace-only replan is not a plan", async () => {
  const calls = [];
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
  const api = beyondBoundaryThrows(calls);
  api.snapshot = async () => {
    calls.push("snapshot");
    return ledgerAfterOneBudgetAbort();
  };

  for (const value of ["", "   ", "\n\t "]) {
    const result = await tool.execute({ issueNumber: 220, replan: value }, api, {});
    const payload = JSON.parse(textOf(result));
    assert.equal(payload.requires, "replan", `replan=${JSON.stringify(value)} must not unlock the guard`);
  }
  assert.deepEqual(calls, ["snapshot", "snapshot", "snapshot"], "no attempt may be scheduled");
});

test("a stated replan proceeds — the guard must not strand legitimately re-scoped work", async () => {
  const ledger = ledgerAfterOneBudgetAbort();
  const { created, api } = ledgerApi(ledger);
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

  const result = await tool.execute({ issueNumber: 220, replan: "issue split to the drift check only" }, api, {});

  assert.equal(created.length, 1, "exactly one task for a stated replan");
  assert.equal(created[0].issueNumber, 220);
  assert.match(textOf(result), /"report":"done"/);
  // Audit trail: whoever/whatever authorized the second full-budget attempt is recorded durably (#222).
  assert.equal(ledger.issues["220"].replan, "issue split to the drift check only");
});

test("a recorded PR clears the requirement — rework after review is not held hostage to it", async () => {
  const ledger = ledgerAfterOneBudgetAbort({ prNumber: 77 });
  const { created, api } = ledgerApi(ledger);
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

  await tool.execute(
    { issueNumber: 220, feedback: { prNumber: 77, directive: "instruct", instruction: "apply review" } },
    api,
    {},
  );

  assert.equal(created.length, 1, "a PR exists, so this is ordinary rework, not a repeat of failed work");
  assert.equal(requiresReplan(ledger, 220), false);
});

test("operator aborts alone never demand a replan and never charge the cap (#141 semantics preserved)", async () => {
  const ledger = emptyBudgetLedger();
  noteOperatorAbort(ledger, 220, { reason: "batch scope exceeded", at: NOW() });
  assert.equal(requiresReplan(ledger, 220), false, "a human pressing stop is information, not evidence of flailing");

  const { created, api } = ledgerApi(ledger);
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
  await tool.execute({ issueNumber: 220 }, api, {});

  assert.equal(created.length, 1, "the stop button must stay cheap to use");
  assert.equal(ledger.issues["220"].budgetAborts, 0, "operator aborts are still never charged to the cap");
  assert.equal(ledger.issues["220"].stopped, false);
});

test("a live claim refuses the second call and names the owner", async () => {
  const ledger = emptyBudgetLedger();
  ledger.issues["9"] = {
    budgetAborts: 0,
    operatorAborts: 0,
    lastAt: 0,
    lastReason: "",
    stopped: false,
    claim: { taskId: "task-caller-1", at: NOW() - 5_000 },
  };
  const { created, api } = ledgerApi(ledger, { refuseToSpawn: true });
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

  const result = await tool.execute({ issueNumber: 9 }, api, {});

  assert.deepEqual(created, [], "a busy issue must not reach createTask");
  assert.equal(ledger.issues["9"].claim.taskId, "task-caller-1", "the refusal must not steal or clear the live claim");
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.alreadyRunning, true);
  assert.equal(payload.owningTaskId, "task-caller-1", "names who owns the run so it can be stopped deliberately");
  assert.match(payload.hint, /conversationId/, "and tells the operator the lever that actually stops a loop (#222)");
});

test("a stale claim expires — the guard is a claim, not a lock that strands an issue", async () => {
  const ledger = emptyBudgetLedger();
  const ttl = claimTtlMs(2400);
  ledger.issues["9"] = {
    budgetAborts: 0,
    operatorAborts: 0,
    lastAt: 0,
    lastReason: "",
    stopped: false,
    claim: { taskId: "task-dead", at: NOW() - ttl - 1_000 },
  };
  const { created, api } = ledgerApi(ledger);
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

  await tool.execute({ issueNumber: 9 }, api, {});
  assert.equal(created.length, 1, "a claim older than its own budget + slack cannot block work forever");
});

test("the claim is held for the whole run and released on every outcome", async () => {
  for (const outcome of [
    { status: "completed", result: { answer: "done" } },
    { status: "aborted", reason: "wall-clock budget exceeded (2400s)", budgetAborted: true, attempts: 1 },
    { status: "faulted", error: { message: "boom" } },
  ]) {
    const ledger = emptyBudgetLedger();
    let heldDuringRun;
    const { api } = ledgerApi(ledger, {
      outcome,
      captureAtCreate: (state) => {
        heldDuringRun = state.issues["9"]?.claim?.taskId;
      },
    });
    const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
    await tool.execute({ issueNumber: 9 }, api, {});

    assert.equal(heldDuringRun, "task-caller", `claim must exist while the child runs (outcome ${outcome.status})`);
    assert.equal(ledger.issues["9"].claim, undefined, `claim must be released after outcome ${outcome.status}`);
  }
});

test("the stopped-issue short-circuit still wins over the new guards (#141 unchanged)", async () => {
  const calls = [];
  const tool = factoryDelegateTool({ taskDef: {}, modelRef: MODEL });
  const api = beyondBoundaryThrows(calls, { commit: false });
  api.snapshot = async () => ledgerAfterOneBudgetAbort({ budgetAborts: 2, stopped: true, stopReason: "stopped after 2 aborts" });

  const payload = JSON.parse(textOf(await tool.execute({ issueNumber: 220 }, api, {})));
  assert.equal(payload.runStopped, true, "a stopped issue reports the stop, not a request for a replan");
  assert.equal(payload.requires, undefined);
});

test("ledger helpers: TTL sizing, PR recording, and release tolerance", () => {
  assert.equal(claimTtlMs(2400), 2_520_000, "one 2400s budget plus slack");
  assert.equal(claimTtlMs(undefined), DEFAULT_CLAIM_TTL_MS);
  assert.ok(claimTtlMs(-5) > 0 && claimTtlMs(Number.NaN) > 0, "a bad config must not make every claim instantly stale");

  const ledger = emptyBudgetLedger();
  notePrOpened(ledger, 12, 34);
  assert.equal(ledger.issues["12"].prNumber, 34);
  for (const bad of [0, -1, 2.5, "7", null]) {
    assert.throws(() => notePrOpened(emptyBudgetLedger(), 12, bad), /positive integer/, `prNumber=${String(bad)} must throw`);
  }

  // releaseClaim runs in a finally; it must never be the thing that throws.
  releaseClaim(emptyBudgetLedger(), 999);
  const withEntry = emptyBudgetLedger();
  withEntry.issues["5"] = { budgetAborts: 0, operatorAborts: 0, lastAt: 0, lastReason: "", stopped: false };
  releaseClaim(withEntry, 5);
  assert.equal(withEntry.issues["5"].claim, undefined);
});

test("prNumberFromPrUrl handles what `gh pr create` actually prints", () => {
  assert.equal(prNumberFromPrUrl("https://github.com/lalanikarim/engram/pull/77"), 77);
  assert.equal(prNumberFromPrUrl("  https://github.com/o/r/pull/123/files\n"), 123, "trailing path/newline tolerated");
  assert.equal(prNumberFromPrUrl("https://github.com/o/r/pull/123?n=1"), 123);
  assert.equal(prNumberFromPrUrl("https://github.com/o/r/pull/abc"), undefined);
  assert.equal(prNumberFromPrUrl(""), undefined, "empty output must read as 'no PR', not PR NaN");
});
