// #230 — `delegate` must be able to tell an operator's authorization from the model's assertion about one.
//
// The production transcript that motivated this (build `6ce582e`, 2026-11-05 03:19 UTC), on the issue whose
// reopen it was:
//
//   reopen — reopened issue #220 as issue-220#reopen-1 … : slice reduced to assertion 4 only (policy vs on-disk gates.json drift)
//   [factory.delegate] issue #220 re-delegated after a budget abort with replan: … the issue has since been sliced
//     down to assertion 4 only …
//
// The scope reduction had not happened. My reopen reason was injected into a fresh conversation as authoritative
// operator context and returned as the model's own claim; #222's guard accepted it because the rule is "non-empty
// string", and the log line for that event was identical to the one for a human authorizing a retry.
//
// These tests pin the difference: an operator reopen grants exactly one attempt, spending it records
// `replanSource:"operator"`, prose records `"model"`, the two log lines are distinguishable, and a grant cannot
// be replayed or used to bypass #141's stop.
import test from "node:test";
import assert from "node:assert/strict";

import { factoryDelegateTool } from "../factory/worker.ts";
import { emptyBudgetLedger, grantReopenAttempt, pendingReopenGrant, requiresReplan } from "../factory/budget-ledger.ts";
import { beyondBoundaryThrows, captureLogs, ledgerAfterOneBudgetAbort, ledgerApi, NOW, textOf } from "./helpers/delegate-fake-api.mjs";

const MODEL = { provider: "aurora", modelId: "some/served-model" };
const GRANT_REASON = "issue body rewritten to cover the drift check only";
const tool = () => factoryDelegateTool({ taskDef: {}, modelRef: MODEL });

/** The state after one wall-budget abort, plus the operator reopen that authorizes exactly one more attempt. */
function withOperatorGrant(extra = {}) {
  const ledger = ledgerAfterOneBudgetAbort(extra);
  grantReopenAttempt(ledger, 220, { requestId: "issue-220#reopen-1", reason: GRANT_REASON, at: NOW() });
  return ledger;
}

test("an operator grant lets a retry through with NO model-authored replan, and says who authorized it", async () => {
  const ledger = withOperatorGrant();
  const { created, api } = ledgerApi(ledger);

  const { result, lines } = await captureLogs(() => tool().execute({ issueNumber: 220 }, api, {}));

  assert.equal(created.length, 1, "a human authorized this attempt; requiring prose on top would be theater");
  assert.match(textOf(result), /"report":"done"/);
  const e = ledger.issues["220"];
  assert.equal(e.replanSource, "operator", "the ledger can distinguish permission from prose — the whole point of #230");
  assert.equal(e.replan, GRANT_REASON, "the verbatim operator reason is the authorization text, never rewritten");
  assert.equal(e.grants[0].consumedBy, "task-caller", "spendable back to the delegate call that spent it");
  assert.ok(Number.isInteger(e.grants[0].consumedAt), "and timestamped");
  const log = lines.join("\n");
  assert.match(log, /OPERATOR GRANT/);
  assert.match(log, /replanSource=operator/);
  assert.match(log, /issue-220#reopen-1/, "the log names the requestId, so a line resolves to the reopen that granted it");
});

test("model-authored prose still works — but it is labelled as the weaker thing it is", async () => {
  const ledger = ledgerAfterOneBudgetAbort(); // no grants at all
  const { created, api } = ledgerApi(ledger);

  const { lines } = await captureLogs(() => tool().execute({ issueNumber: 220, replan: "the issue has since been sliced down to assertion 4 only" }, api, {}));

  assert.equal(created.length, 1, "#222's acceptance stands: re-scoped work must not be stranded");
  const e = ledger.issues["220"];
  assert.equal(e.replanSource, "model", "exactly the case that fooled production is now recorded as unverified prose");
  const log = lines.join("\n");
  assert.match(log, /MODEL-AUTHORED/);
  assert.match(log, /replanSource=model/);
  assert.match(log, /no operator grant on file/, "and says out loud that nothing human stands behind it");
});

test("non-vacuity: the two authorization paths are distinguishable in the log", async () => {
  const grantLedger = withOperatorGrant();
  const proseLedger = ledgerAfterOneBudgetAbort();
  const a = (await captureLogs(() => tool().execute({ issueNumber: 220 }, ledgerApi(grantLedger).api, {}))).lines.join("\n");
  const b = (await captureLogs(() => tool().execute({ issueNumber: 220, replan: "split smaller" }, ledgerApi(proseLedger).api, {}))).lines.join("\n");

  assert.notEqual(a.split("\n")[0].replace(/\d+/g, ""), b.split("\n")[0].replace(/\d+/g, ""), "identical lines would mean #230 changed nothing observable");
  assert.match(a, /OPERATOR GRANT/);
  assert.doesNotMatch(a, /MODEL-AUTHORED/);
  assert.match(b, /MODEL-AUTHORED/);
  assert.doesNotMatch(b, /OPERATOR GRANT/);
});

test("one grant buys one attempt — it cannot be replayed", async () => {
  const ledger = withOperatorGrant();
  const { created, api } = ledgerApi(ledger);

  await tool().execute({ issueNumber: 220 }, api, {});
  const consumedAt = ledger.issues["220"].grants[0].consumedAt;
  assert.ok(consumedAt, "first attempt spent it");
  assert.equal(pendingReopenGrant(ledger, 220), undefined);

  const second = JSON.parse(textOf(await tool().execute({ issueNumber: 220 }, api, {})));

  assert.equal(created.length, 1, "the second call must not reach createTask");
  assert.equal(second.requires, "replan", "back to #222's rule: the grant was a second chance, not a license");
  assert.equal(ledger.issues["220"].grants[0].consumedAt, consumedAt, "a spent grant is history, not a reusable token");
});

test("a call refused for another reason never burns the grant", async () => {
  const ledger = withOperatorGrant();
  ledger.issues["220"].claim = { taskId: "task-other", at: NOW() }; // another worker owns the issue
  const { created, api } = ledgerApi(ledger, { refuseToSpawn: true });

  const payload = JSON.parse(textOf(await tool().execute({ issueNumber: 220 }, api, {})));

  assert.equal(payload.alreadyRunning, true);
  assert.deepEqual(created, [], "nothing was spawned");
  assert.ok(pendingReopenGrant(ledger, 220), "#230: an authorization spent by a call that did nothing is a stolen second chance");
});

test("a grant never bypasses #141's stop", async () => {
  const ledger = withOperatorGrant({ budgetAborts: 2, stopped: true, stopReason: "stopped after 2 aborts" });
  const calls = [];
  const api = beyondBoundaryThrows(calls, { commit: false });
  api.snapshot = async () => {
    calls.push("snapshot");
    return ledger;
  };

  const payload = JSON.parse(textOf(await tool().execute({ issueNumber: 220 }, api, {})));

  assert.equal(payload.runStopped, true, "the terminal stop outranks any authorization");
  assert.equal(payload.requires, undefined);
  assert.deepEqual(calls, ["snapshot"], "a stopped issue is refused before any grant is consumed");
  assert.ok(pendingReopenGrant(ledger, 220), "and the grant survives to be visible in an audit of what was NOT spent");
});

test("spending a grant never moves the counters (#141 stays intact)", async () => {
  const ledger = withOperatorGrant();
  const before = structuredClone(ledger.issues["220"]);
  const { api } = ledgerApi(ledger);

  await tool().execute({ issueNumber: 220 }, api, {});

  const after = ledger.issues["220"];
  for (const field of ["budgetAborts", "operatorAborts", "stopped"]) {
    assert.deepEqual(after[field], before[field], `${field} must be untouched by spending a grant`);
  }
  assert.equal(requiresReplan(ledger, 220), true, "with no PR recorded, the issue still owes authorization next time");
});

test("a replan on an issue that owed nothing is recorded as model text without implying permission", async () => {
  const ledger = emptyBudgetLedger(); // fresh issue: no aborts, so no authorization was needed
  const { created, api } = ledgerApi(ledger);

  await tool().execute({ issueNumber: 5, replan: "context the orchestrator volunteered" }, api, {});

  assert.equal(created.length, 1);
  assert.equal(ledger.issues["5"].replanSource, "model", "recorded for audit only — nothing was unlocked");
});

test("grantReopenAttempt refuses to manufacture untraceable authorization", () => {
  for (const bad of [{ requestId: "", reason: "x" }, { requestId: "   ", reason: "x" }, { requestId: "issue-1#reopen-1", reason: "" }, { requestId: "issue-1#reopen-1", reason: "  " }]) {
    assert.throws(
      () => grantReopenAttempt(emptyBudgetLedger(), 1, bad),
      /non-empty requestId|stated reason/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
  const ledger = emptyBudgetLedger();
  grantReopenAttempt(ledger, 1, { requestId: "issue-1#reopen-1", reason: "first", at: 1 });
  grantReopenAttempt(ledger, 1, { requestId: "issue-1#reopen-2", reason: "second", at: 2 });
  assert.deepEqual(ledger.issues["1"].grants.map((g) => g.requestId), ["issue-1#reopen-1", "issue-1#reopen-2"], "history appends; it is never overwritten");
});
