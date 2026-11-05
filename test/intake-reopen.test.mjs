// #226 — an issue whose orchestration conversation ended could never be dispatched again: intake dedupes on a
// constant per-issue requestId stored in a durable document, so re-applying the `build` label is silently a
// no-op. Observed live 2026-11-05 while trying to re-run drydock#220 to prove #222:
//
//   [factory] lalanikarim/drydock: intake — requestId issue-220 already handled — no new submission
//
// These tests pin the operator verb that fixes it, and — more importantly — the things it must NOT do: clear
// the wall-budget ledger (#141/#222), reuse a transcript that already contains an abort (#122), or pretend the
// retry is free.
import test from "node:test";
import assert from "node:assert/strict";

import { createIntakeRoute, IntakeLedgerDoc } from "../factory/intake-router.ts";
import { buildReopenContent, createReopenRoute, nextReopenRequestId, validateReopenBody } from "../factory/intake-reopen.ts";
import { BudgetLedgerDoc } from "../factory/budget-ledger.ts";
import { fakeHarness, call, spec } from "./helpers/intake-fake-harness.mjs";

const MODEL = { provider: "p", modelId: "m" };
const agents = { issue: spec(["delegate", "open_draft_pr"]) };
const mkIntake = () => createIntakeRoute({ repo: "o/r", agents, modelRef: MODEL, log: () => {} });
const mkReopen = () => createReopenRoute({ repo: "o/r", agents, modelRef: MODEL, log: () => {} });

/** Wrap a fake harness so every document any commit touches is recorded by kind. The #226 assertion needs
 *  "the budget ledger was not written", which a value comparison alone cannot prove. */
function instrument(harness) {
  const touched = [];
  const original = harness.commit.bind(harness);
  harness.commit = (fn, ctx) =>
    original(async (tx) => fn({ doc: async (doc, id) => { touched.push((doc.definition ?? doc).kind); return tx.doc(doc, id); } }), ctx);
  return { touched };
}

/** Put an issue in the state tonight's #220 was in: dispatched once, budget aborted once, operator stopped. */
function dispatchedOnce({ harness, docs }, issueNumber = 220, conversationId = 100) {
  docs.set(IntakeLedgerDoc.definition?.kind ?? IntakeLedgerDoc.kind, {
    entries: { "issue:#220": conversationId },
    requests: [{ id: `issue-${issueNumber}`, key: `issue:#${issueNumber}`, conversationId, at: 1 }],
  });
  docs.set(BudgetLedgerDoc.definition?.kind ?? BudgetLedgerDoc.kind, {
    issues: { [String(issueNumber)]: { budgetAborts: 1, operatorAborts: 1, lastAt: 2, lastReason: "aborted by operator", stopped: true } },
  });
}

/** A fake that also *has* the prior conversation, so "did reopen reuse it?" is observable rather than vacuous. */
function seeded(issueNumber = 220, conversationId = 100) {
  const f = fakeHarness({ settled: [[`issue:#${issueNumber}`, conversationId]] });
  dispatchedOnce(f, issueNumber, conversationId);
  return f;
}

test("reopen dispatches an issue that intake would otherwise swallow forever", async () => {
  const f = seeded();
  const before = f.conversations.size;

  const res = await call(mkReopen(), f.harness, { issueNumber: 220, reason: "issue split to the drift check only" });

  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.reopened, true);
  assert.equal(res.json.requestId, "issue-220#reopen-1");
  assert.equal(f.conversations.size, before + 1, "a new conversation must exist that the label could never open");
  assert.equal(res.json.supersededConversationId, 100, "reports what it replaced instead of hiding it");
  const submitted = f.calls.submitted.at(-1);
  assert.match(submitted.content, /issue split to the drift check only/, "the operator's reason reaches the agent");
  assert.match(submitted.content, /did NOT change: the wall-budget ledger/i, "and so does the warning that budget is not restored");
});

test("reopen never reuses the superseded conversation — #122's transcript-poisoning rule", async () => {
  const f = seeded();
  const oldConv = f.conversations.get(100);
  const submissionsIntoOld = () => f.calls.submitted.filter((s) => s.id === 100).length;

  await call(mkReopen(), f.harness, { issueNumber: 220, reason: "retry after fix" });

  assert.ok(oldConv, "the superseded conversation still exists — reopen does not destroy it");
  assert.equal(submissionsIntoOld(), 0, "submitting into a transcript that contains an abort starts the retry at a disadvantage");
});

test("repeated reopens get distinct, ordered request ids and keep history intact", async () => {
  const f = seeded();

  const first = await call(mkReopen(), f.harness, { issueNumber: 220, reason: "first retry" });
  const second = await call(mkReopen(), f.harness, { issueNumber: 220, reason: "second retry" });

  assert.equal(first.json.requestId, "issue-220#reopen-1");
  assert.equal(second.json.requestId, "issue-220#reopen-2");
  const ledger = f.docs.get(IntakeLedgerDoc.definition?.kind ?? IntakeLedgerDoc.kind);
  const ids = ledger.requests.map((r) => r.id);
  assert.deepEqual(ids, ["issue-220", "issue-220#reopen-1", "issue-220#reopen-2"], "history is appended, never rewritten");
});

test("the budget ledger is read but NEVER written by a reopen (#141/#222 must survive an operator's convenience)", async () => {
  const f = seeded();
  const { touched } = instrument(f.harness);

  const res = await call(mkReopen(), f.harness, { issueNumber: 220, reason: "please retry" });

  assert.ok(touched.includes("factory.intake-ledger"), `reopen must record its own dispatch; touched: ${touched.join(",")}`);
  assert.equal(touched.includes("factory.budget-ledger"), false, "a reopen that could reset budgetAborts would undo #141 and #222 in one call");
  const budgets = f.docs.get(BudgetLedgerDoc.definition?.kind ?? BudgetLedgerDoc.kind);
  assert.deepEqual(budgets.issues["220"], { budgetAborts: 1, operatorAborts: 1, lastAt: 2, lastReason: "aborted by operator", stopped: true });
  // And the operator is told the consequence up front rather than discovering it in a worker log.
  assert.equal(res.json.budget.stopped, true);
  assert.match(res.json.warning, /STOPPED/);
  assert.match(res.json.warning, /restores dispatchability, not budget/i);
});

test("a stopped issue still reopens — the verb restores dispatchability, and #141 does the refusing", async () => {
  const f = seeded();
  const res = await call(mkReopen(), f.harness, { issueNumber: 220, reason: "operator accepts the risk of another attempt" });
  // Refusing here would be wrong in the other direction: it is delegate's job (#222/#141) to enforce budget,
  // and intake's job only to deliver. The warning above is what keeps that honest.
  assert.equal(res.status, 202);
});

test("validation: a reopen needs an issue number and a stated reason", async () => {
  const good = { issueNumber: 220, reason: "wall budget raised to 5400" };
  assert.equal(validateReopenBody(good).ok, true);

  for (const bad of [
    { issueNumber: 220 },
    { issueNumber: 220, reason: "" },
    { issueNumber: 220, reason: "   " },
    { reason: "no issue number" },
    { issueNumber: "220", reason: "strings are not numbers here" },
    { issueNumber: 0, reason: "x" },
    { issueNumber: -3, reason: "x" },
    { issueNumber: 1.5, reason: "x" },
    { issueNumber: 220, reason: "x".repeat(2_001) },
  ]) {
    const r = validateReopenBody(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad).slice(0, 50)} must be rejected`);
    assert.equal(r.status, 400);
  }

  // The reason requirement is deliberate and its message says why (#222's rule applies to operators too).
  assert.match(validateReopenBody({ issueNumber: 1 }).error, /what changed/);

  const res = await call(mkReopen(), fakeHarness().harness, { issueNumber: 220 });
  assert.equal(res.status, 400);
});

test("nextReopenRequestId counts the max, not the length — deleted history cannot collide", () => {
  assert.equal(nextReopenRequestId([], 9), "issue-9#reopen-1");
  assert.equal(nextReopenRequestId([{ id: "issue-9" }], 9), "issue-9#reopen-1");
  assert.equal(nextReopenRequestId([{ id: "issue-9#reopen-1" }, { id: "issue-9#reopen-2" }], 9), "issue-9#reopen-3");
  assert.equal(nextReopenRequestId([{ id: "issue-9#reopen-5" }], 9), "issue-9#reopen-6", "max, not count");
  assert.equal(nextReopenRequestId([{ id: "issue-8#reopen-9" }, { id: "issue-9#reopen-bogus" }], 9), "issue-9#reopen-1", "other issues and malformed ids ignored");
});

test("buildReopenContent says what it is, what changed, and what did not", () => {
  const c = buildReopenContent(220, "split to the drift check", 2, 100);
  assert.match(c, /attempt 2/);
  assert.match(c, /#\s?220|#220/);
  assert.match(c, /"split to the drift check"/, "the reason is quoted, so it cannot be mistaken for instructions");
  assert.match(c, /superseded conversation was 100/);
  assert.match(c, /Do not work around that/i, "the agent must be told the guard is still armed");
});

test("the duplicate intake response now names the supported way forward (#226's other half)", async () => {
  const f = seeded();
  const body = { kind: "issue", subject: "#220", requestId: "issue-220", content: "labeled build" };

  const res = await call(mkIntake(), f.harness, body);

  assert.equal(res.json.duplicate, true, "dedupe behavior itself must not change — redelivery is still absorbed");
  assert.match(res.json.hint, /POST \/factory\/intake\/reopen/, "but the caller is told what to do instead of being left with `duplicate:true`");
  assert.match(res.json.hint, /220/, "and with which issue number to pass");
});

test("reopen uses the same capability envelope as webhook intake (shared dispatch path, not a copy)", async () => {
  const f = fakeHarness();
  await call(mkReopen(), f.harness, { issueNumber: 7, reason: "fresh issue via reopen" });
  const created = f.calls.created.at(-1);
  assert.deepEqual(created.toolNames, ["delegate", "open_draft_pr"], "a reopened conversation gets exactly the issue-kind tools");
  assert.match(created.instructions, /brief for delegate,open_draft_pr/);
  assert.match(created.metaName ?? "", /issue:#7/, "named like an intake conversation so it is findable in the UI");
});
