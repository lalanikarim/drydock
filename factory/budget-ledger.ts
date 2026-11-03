// Durable wall-budget attempt ledger (#141).
//
// The incident, in the issue's own words: task 1158 aborted at the 2400 s wall budget, task 1297 was
// delegated immediately afterwards, and after a fleet restart task 1437 appeared anyway. Nothing counted
// anything — the retry cap was the word "once" in a prompt, and a prompt is not a counter. Each attempt
// costs the full wall budget in inference, so an issue that cannot finish inside it burns money forever.
//
// Why this is NOT the in-memory `RefusalBudget` from #100, which solved the sibling problem:
//
//   * **It has to survive a restart.** #100's ledger is deliberately process-local — restarting is a human
//     act and a durable stop on a *policy* refusal would outlive that intent. A wall-budget loop is the
//     opposite: tonight's third attempt appeared *because* of a restart. An in-memory cap here would be
//     cleared by exactly the event that keeps happening.
//   * **Different resource.** #100 bounds "the same refusal repeats"; this bounds "the work does not fit
//     the clock". Conflating them would let two budget aborts plus one path-scope refusal look like a
//     policy stop, and the operator would be told to widen an allowlist that was never the problem.
//
// Operator aborts are recorded but never counted toward the cap: a human stopping a run is information,
// not evidence the model flailed, and locking an issue because an operator pressed the button twice is a
// bad way to encourage using the button.

import { defineDoc } from "@earendil-works/pi-durable";

// Type aliases, not interfaces: pi-durable's document state is constrained to `JsonObject`
// (`{ [key: string]: JsonValue }`), and TypeScript gives interfaces no implicit index signature — so an
// identical `type` is assignable where an `interface` is not. Reported the moment tsc was run on this tree
// (#173); at runtime the two are the same file.
export type BudgetEntry = {
  /** Wall-clock aborts caused by the budget itself (not by an operator). */
  budgetAborts: number;
  /** Operator-initiated aborts, recorded for context and never charged to the cap. */
  operatorAborts: number;
  lastAt: number;
  lastReason: string;
  /** True once this issue's runs are refused without doing work. */
  stopped: boolean;
  stopReason?: string;
}

export type BudgetLedgerState = {
  issues: Record<string, BudgetEntry>;
}

/** Per-issue ceiling on wall-budget aborts. One abort says "this did not fit"; the second says the task
 *  is too big for this budget, which is a decision for a human, not a third attempt. */
export const DEFAULT_MAX_BUDGET_ABORTS = 2;

/** Fresh ledger state. Exported because `defineDoc` returns a token, not the definition — tests and any
 * caller that needs an empty ledger must not have to duplicate the shape. */
export const emptyBudgetLedger = (): BudgetLedgerState => ({ issues: {} });

export const BudgetLedgerDoc = defineDoc({
  scope: "session",
  kind: "factory.budget-ledger",
  version: 1,
  initial: emptyBudgetLedger,
});

const key = (issueNumber: number) => String(issueNumber);

function entry(state: BudgetLedgerState, issueNumber: number): BudgetEntry {
  const k = key(issueNumber);
  if (!state.issues[k]) state.issues[k] = { budgetAborts: 0, operatorAborts: 0, lastAt: 0, lastReason: "", stopped: false };
  return state.issues[k];
}

export interface BudgetNoteResult {
  entry: BudgetEntry;
  attempts: number;
  terminal: boolean;
  stopReason?: string;
}

/**
 * Record one wall-clock abort and decide whether this issue may be tried again.
 *
 * Mutates the durable document in place (the kernel commits whatever the transaction touched), so callers
 * pass `await tx.doc(BudgetLedgerDoc)` directly.
 */
export function noteBudgetAbort(
  state: BudgetLedgerState,
  issueNumber: number,
  opts: { maxAborts?: number; reason: string; at?: number } = { reason: "wall-clock budget exceeded" },
): BudgetNoteResult {
  const max = opts.maxAborts ?? DEFAULT_MAX_BUDGET_ABORTS;
  if (!Number.isInteger(max) || max < 1) throw new Error(`maxAborts must be a positive integer, got ${JSON.stringify(max)}`);
  const e = entry(state, issueNumber);
  e.budgetAborts += 1;
  e.lastAt = opts.at ?? Date.now();
  e.lastReason = opts.reason;

  let stopReason: string | undefined;
  if (!e.stopped && e.budgetAborts >= max) {
    e.stopped = true;
    stopReason =
      `stopped after ${e.budgetAborts} wall-budget aborts (${opts.reason}). ` +
      `The work does not fit inside the configured budget, so a third attempt buys nothing but another full budget.`;
    e.stopReason = stopReason;
  }
  return { entry: e, attempts: e.budgetAborts, terminal: e.stopped, ...(stopReason ? { stopReason } : {}) };
}

/** Record an operator-initiated abort. Never charges the cap; see the header. */
export function noteOperatorAbort(
  state: BudgetLedgerState,
  issueNumber: number,
  opts: { reason?: string; at?: number } = {},
): BudgetEntry {
  const e = entry(state, issueNumber);
  e.operatorAborts += 1;
  e.lastAt = opts.at ?? Date.now();
  e.lastReason = opts.reason?.trim() || "aborted by operator";
  return e;
}

export function isBudgetStopped(state: BudgetLedgerState | undefined, issueNumber: number): boolean {
  return state?.issues[key(issueNumber)]?.stopped === true;
}

export function budgetEntry(state: BudgetLedgerState | undefined, issueNumber: number): BudgetEntry | undefined {
  return state?.issues[key(issueNumber)];
}

/**
 * What a short-circuited delegate returns. Shaped like `terminalRefusalPayload` (#100) on purpose — one
 * vocabulary for "further attempts are refused without doing work" — but naming the wall clock and the two
 * levers a human actually has.
 */
export function budgetShortCircuitPayload(issueNumber: number, e: BudgetEntry): Record<string, unknown> {
  return {
    refused: true,
    terminal: true,
    retryable: false,
    runStopped: true,
    budgetAborted: true,
    issueNumber,
    attempts: e.budgetAborts,
    operatorAborts: e.operatorAborts,
    reason: e.stopReason ?? "run stopped by the wall-budget ledger",
    hint:
      "Do not re-delegate this issue and do not call delegate again for it: the answer will be this same payload. " +
      "Tell the human that the task has exceeded its wall-clock budget twice, and that the levers are theirs — raise " +
      "wallSecsPerIssue in this repo's runtime config, or split the issue into pieces that each fit inside one budget.",
  };
}

/** One line per stopped issue, for the shutdown summary the refusal ledger already writes. */
export function budgetSummary(state: BudgetLedgerState | undefined): string {
  const stopped = Object.entries(state?.issues ?? {}).filter(([, e]) => e.stopped);
  if (stopped.length === 0) return "no runs stopped by the wall-budget ledger";
  return stopped.map(([n, e]) => `issue #${n}: ${e.stopReason ?? "stopped"} (operator aborts: ${e.operatorAborts})`).join("\n");
}
