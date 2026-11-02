// #141 — the wall-budget loop must have a counter, and the counter must outlive the process that
// incremented it. Tonight: task 1158 aborted at 2400s → task 1297 delegated immediately → fleet restart →
// task 1437 anyway. Three full budgets on one issue because the retry cap was prose.
//
// Two layers here, and they are deliberately different kinds of test:
//   * pure ledger logic — the arithmetic of "how many times may this cost another budget";
//   * a REAL kernel instance whose data directory is closed and reopened, proving the stop survives the
//     exact event that kept clearing the old one (a restart). A fake would have proven my assumption.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  BudgetLedgerDoc,
  DEFAULT_MAX_BUDGET_ABORTS,
  emptyBudgetLedger,
  budgetShortCircuitPayload,
  budgetSummary,
  isBudgetStopped,
  noteBudgetAbort,
  noteOperatorAbort,
} = await import("../factory/budget-ledger.ts");
const { validateAbortRequest } = await import("../factory/run-control.ts");

test("ledger: first abort is counted, not terminal; second stops the issue", () => {
  const state = emptyBudgetLedger();
  const first = noteBudgetAbort(state, 141, { reason: "wall-clock budget exceeded (2400s)" });
  assert.equal(first.attempts, 1);
  assert.equal(first.terminal, false);
  assert.equal(isBudgetStopped(state, 141), false);

  const second = noteBudgetAbort(state, 141, { reason: "wall-clock budget exceeded (2400s)" });
  assert.equal(second.attempts, DEFAULT_MAX_BUDGET_ABORTS);
  assert.equal(second.terminal, true, "the cap is what makes this a stop rather than a statistic");
  assert.equal(isBudgetStopped(state, 141), true);
});

test("ledger: the stop is sticky — a third abort cannot un-stop it or buy another attempt", () => {
  const state = emptyBudgetLedger();
  noteBudgetAbort(state, 7, { reason: "a" });
  noteBudgetAbort(state, 7, { reason: "b" });
  const third = noteBudgetAbort(state, 7, { reason: "c" });
  assert.equal(third.attempts, 3);
  assert.equal(third.terminal, true);
  assert.equal(isBudgetStopped(state, 7), true);
});

test("ledger: counting is per issue — stopping one issue must not stop its neighbours", () => {
  const state = emptyBudgetLedger();
  noteBudgetAbort(state, 1, { reason: "x" });
  noteBudgetAbort(state, 1, { reason: "x" });
  assert.equal(isBudgetStopped(state, 1), true);
  assert.equal(isBudgetStopped(state, 2), false);
  const other = noteBudgetAbort(state, 2, { reason: "x" });
  assert.equal(other.attempts, 1, "issue #2's counter starts at 1 regardless of what #1 did");
});

test("ledger: an operator abort is recorded but never charged to the cap", () => {
  const state = emptyBudgetLedger();
  noteOperatorAbort(state, 9, { reason: "watching it spin" });
  noteOperatorAbort(state, 9, { reason: "watching it spin again" });
  assert.equal(isBudgetStopped(state, 9), false, "pressing the stop button must not lock an issue out");
  assert.equal(state.issues["9"].operatorAborts, 2);
  assert.equal(state.issues["9"].budgetAborts, 0);

  // …and the model's own budget still counts from zero after human intervention.
  const n = noteBudgetAbort(state, 9, { reason: "overran" });
  assert.equal(n.attempts, 1);
});

test("ledger: maxAborts is validated — a zero or fractional cap would silently disable the stop", () => {
  const state = emptyBudgetLedger();
  assert.throws(() => noteBudgetAbort(state, 1, { reason: "x", maxAborts: 0 }), /positive integer/);
  assert.throws(() => noteBudgetAbort(state, 1, { reason: "x", maxAborts: 1.5 }), /positive integer/);
});

test("short-circuit payload is terminal in the vocabulary the orchestrator already speaks (#100)", () => {
  const state = emptyBudgetLedger();
  noteBudgetAbort(state, 42, { reason: "wall-clock budget exceeded (2400s)" });
  noteBudgetAbort(state, 42, { reason: "wall-clock budget exceeded (2400s)" });
  const payload = budgetShortCircuitPayload(42, state.issues["42"]);
  assert.equal(payload.refused, true);
  assert.equal(payload.terminal, true);
  assert.equal(payload.retryable, false, "host state, not a request: the next call cannot create a task");
  assert.equal(payload.runStopped, true);
  assert.equal(payload.budgetAborted, true, "#141: distinguishable from a #100 policy refusal in the transcript");
  assert.equal(payload.attempts, 2);
  // The hint must name the operator's levers, not just forbid the retry.
  assert.match(payload.hint, /wallSecsPerIssue/);
  assert.match(payload.hint, /split the issue/i);
});

test("summary: only stopped issues are named, and operator intervention is visible", () => {
  const state = emptyBudgetLedger();
  assert.match(budgetSummary(state), /no runs stopped/);
  noteBudgetAbort(state, 3, { reason: "x" });
  noteBudgetAbort(state, 3, { reason: "x" });
  noteOperatorAbort(state, 3, { reason: "looked stuck" });
  const line = budgetSummary(state);
  assert.match(line, /issue #3/);
  assert.match(line, /operator aborts: 1/);
  assert.doesNotMatch(line, /no runs stopped/);
});

// ── durable across a real restart ────────────────────────────────────────────────────────────────

test("the stop survives a real instance restart (the event that kept clearing the old cap)", async (t) => {
  if (!process.env.OPENAI_BASE_URL && !process.env.DEFAULT_MODEL) {
    t.skip("needs an inference endpoint so the instance's model ref resolves (npm test provides it)");
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), "drydock-budget-ledger-"));
  for (const d of ["data", "config", "work"]) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(join(tmp, "config", "gates.json"), JSON.stringify({ approvals: { default: { mode: "auto" } }, toolAccess: {} }));

  // The kernel requires a bearer token to construct an instance; this test never issues an HTTP request,
  // so a local value is honest — the thing under test is durable storage, not auth.
  process.env.API_TOKEN ??= "budget-ledger-test-token";
  const { createCoreInstance, loadConfig } = await import("../vendor/engram/app/src/core.ts");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

  const boot = () =>
    createCoreInstance({
      config: loadConfig({
        dataDir: join(tmp, "data"),
        configDir: join(tmp, "config"),
        workRoot: join(tmp, "work"),
        sandbox: { image: "factory-sandbox:latest", network: "none", allowImages: ["factory-sandbox:latest"], allowMountRoot: join(tmp, "work") },
      }),
      port: 0,
      // A ref is required to construct the root agent; no generation ever runs here, so the id does not
      // have to exist. The assertion below is about durable state, not inference.
      rootAgent: { model: { provider: "openai-completions", modelId: "budget-ledger-probe" }, instructions: "probe" },
    });

  // First life: two aborts committed through the same transaction path production uses.
  let instance = await boot();
  try {
    await instance.harness.commit(async (tx) => {
      const doc = await tx.doc(BudgetLedgerDoc);
      noteBudgetAbort(doc, 141, { reason: "wall-clock budget exceeded (2400s)" });
    }, BACKGROUND_CONTEXT);
    await instance.harness.commit(async (tx) => {
      const doc = await tx.doc(BudgetLedgerDoc);
      noteBudgetAbort(doc, 141, { reason: "wall-clock budget exceeded (2400s)" });
    }, BACKGROUND_CONTEXT);
    assert.equal(isBudgetStopped(await instance.harness.snapshot(BudgetLedgerDoc, BACKGROUND_CONTEXT), 141), true);
    await instance.close();
  } catch (e) {
    try { await instance.close(); } catch { /* already down */ }
    throw e;
  }

  // Second life: a brand-new process state over the same data directory. This is the restart that, in
  // production tonight, produced attempt #3.
  instance = await boot();
  try {
    const after = await instance.harness.snapshot(BudgetLedgerDoc, BACKGROUND_CONTEXT);
    assert.ok(after, "the ledger document must come back, not read as fresh");
    assert.equal(isBudgetStopped(after, 141), true, "a stop that does not survive restart is not a stop");
    assert.equal(after.issues["141"].budgetAborts, 2);
    await instance.close();
  } catch (e) {
    try { await instance.close(); } catch { /* already down */ }
    throw e;
  }
}, 120_000);

// ── the abort route's request contract ───────────────────────────────────────────────────────────

test("abort request: exactly one target, and never both", () => {
  assert.equal(validateAbortRequest({}).ok, false);
  assert.match(validateAbortRequest({ taskId: 1, conversationId: 2 }).error, /exactly one/);
  assert.equal(validateAbortRequest({ taskId: 5 }).ok, true);
  assert.equal(validateAbortRequest({ conversationId: 5 }).ok, true);
});

test("abort request: ids that cannot name a record are refused, not silently ignored", () => {
  for (const bad of [0, -1, 1.5, "abc", {}, true]) {
    const v = validateAbortRequest({ taskId: bad });
    assert.equal(v.ok, false, `${JSON.stringify(bad)} must not be accepted as a task id`);
  }
  // A string id is accepted only if it is exactly a positive integer — delivery ids proved string-vs-number
  // mismatches silently match nothing.
  assert.equal(validateAbortRequest({ taskId: "42" }).ok, true);
  assert.equal(validateAbortRequest({ taskId: "42" }).taskId, 42);
});

test("abort request: reason is bounded so a log line cannot be used to write unbounded text", () => {
  const v = validateAbortRequest({ taskId: 1, reason: "x".repeat(5000) });
  assert.equal(v.ok, true);
  assert.ok(v.reason.length <= 500);
});
