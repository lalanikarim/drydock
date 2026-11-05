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
  /**
   * Draft PR recorded for this issue by `open_draft_pr` (#222). This is what makes "does a PR exist?" a
   * durable local fact instead of a GitHub query inside `delegate`: the question the retry guard has to
   * answer is "has this factory produced anything since the abort", and answering it with a network call
   * would make the guard's correctness depend on the thing most likely to be flaky at that moment.
   */
  prNumber?: number;
  /** The `delegate` call currently owning this issue, if any (#222 concurrency guard). */
  claim?: BudgetClaim;
  /** Verbatim reason the operator/orchestrator gave for retrying after a budget abort (#222), for audit. */
  replan?: string;
}

/**
 * A live `delegate` claim on an issue. Not a lock — nothing here can prevent a determined caller — it is a
 * durable record of "a worker for this issue was scheduled by call X at time Y", which is enough to refuse a
 * second one and enough for a human to see who owns the run.
 */
export type BudgetClaim = {
  /**
   * The `delegate` call that owns the issue (the caller's own task id, known BEFORE the child is created —
   * claiming with the child's id would require creating the thing the claim exists to prevent).
   */
  taskId: string | number;
  /** Epoch ms when the claim was taken. */
  at: number;
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

// ------------------------------------------------------------------------------------------- #222 — retry guards
//
// Observed live on the first throughput-batch dispatch (drydock#220, build c993bdd): a worker aborted at the
// 2400 s wall budget, `delegate` returned `{budgetAborted:true, retryable:false, hint:"Do not re-delegate"}`,
// and the orchestrator re-delegated anyway — twice, ~40 min of inference each. The structural stop existed
// but trips at DEFAULT_MAX_BUDGET_ABORTS = 2, so after the FIRST abort the only defense left was a sentence.
// These guards close that gap without touching the cap's semantics (operator aborts stay uncharged).

/** Slack past one wall budget after which a claim is treated as abandoned rather than running (#222). A run
 *  cannot legitimately outlive its own budget by more than this much: the worker enforces the same clock. */
export const CLAIM_TTL_SLACK_MS = 120_000;

/** Minimum sensible claim TTL when the caller does not know the configured wall budget (worker's own default
 *  is 1800 s, so this matches the shipped configuration rather than inventing a tighter one). */
export const DEFAULT_CLAIM_TTL_MS = 1_800_000 + CLAIM_TTL_SLACK_MS;

/** Claim TTL for a configured `wallSecsPerIssue`, with slack. Guards against a zero/negative config turning
 *  every claim instantly stale, which would make the concurrency check decorative. */
export function claimTtlMs(wallSecsPerIssue: number | undefined): number {
  const secs = typeof wallSecsPerIssue === "number" && wallSecsPerIssue > 0 ? wallSecsPerIssue : 1_800;
  return secs * 1_000 + CLAIM_TTL_SLACK_MS;
}

/** A claim is live while it is younger than the TTL. `at` in the future (clock skew) counts as live, since a
 *  stale-looking claim is the one that lets a duplicate worker start. */
export function claimIsLive(e: BudgetEntry | undefined, nowMs: number, ttlMs: number): boolean {
  if (!e?.claim) return false;
  const age = nowMs - e.claim.at;
  return !(age > ttlMs);
}

/**
 * Take exclusive ownership of an issue for one delegated run. Returns `{ ok: false }` with the live claim
 * instead of throwing, so `delegate` can answer with an actionable tool result rather than a faulted call.
 */
export function claimIssue(
  state: BudgetLedgerState,
  issueNumber: number,
  taskId: string | number,
  opts: { now?: number; ttlMs?: number } = {},
): { ok: true; entry: BudgetEntry } | { ok: false; entry: BudgetEntry; liveForMs: number; ttlMs: number } {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
  const e = entry(state, issueNumber);
  if (claimIsLive(e, now, ttlMs)) {
    return { ok: false, entry: e, liveForMs: Math.max(0, now - e.claim!.at), ttlMs };
  }
  e.claim = { taskId, at: now };
  return { ok: true, entry: e };
}

/** Release ownership. Tolerates a missing entry/claim — release runs in a `finally` and must not be able to
 *  turn a settled run into a thrown error. */
export function releaseClaim(state: BudgetLedgerState, issueNumber: number): void {
  const e = state.issues[key(issueNumber)];
  if (!e) return;
  delete e.claim;
}

/** Record the PR this factory opened, so "did anything come of it?" survives a restart (#222). */
export function notePrOpened(
  state: BudgetLedgerState,
  issueNumber: number,
  prNumber: number,
  opts: { at?: number } = {},
): BudgetEntry {
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`prNumber must be a positive integer, got ${JSON.stringify(prNumber)}`);
  const e = entry(state, issueNumber);
  e.prNumber = prNumber;
  e.lastAt = opts.at ?? Date.now();
  return e;
}

/**
 * Does this call need a `replan`? True when the issue has already burned a wall budget and produced no PR:
 * retrying identical work at an identical budget is what doubled the cost of dispatch #1, so the caller must
 * state what changed. A recorded PR clears the requirement — rework after a review comment is legitimate and
 * must not be stranded (acceptance: the fix may not block legitimately re-scoped work).
 */
export function requiresReplan(state: BudgetLedgerState | undefined, issueNumber: number): boolean {
  const e = state?.issues[key(issueNumber)];
  if (!e) return false;
  if (e.prNumber) return false;
  return e.budgetAborts >= 1;
}

/** Payload for "you may re-delegate, but only by saying what changed". Same vocabulary as the other refusals:
 *  `refused` + `retryable`, plus the exact argument name that unlocks it. */
export function replanRequiredPayload(issueNumber: number, e: BudgetEntry): Record<string, unknown> {
  return {
    refused: true,
    retryable: false,
    requires: "replan",
    issueNumber,
    attempts: e.budgetAborts,
    operatorAborts: e.operatorAborts,
    reason:
      `issue #${issueNumber} already aborted ${e.budgetAborts} time(s) on the wall-clock budget and produced no pull request. ` +
      "Re-delegating unchanged work at an unchanged budget cannot produce a different result.",
    hint:
      'Call delegate again with `replan: "<what is different now>"` — e.g. "issue split to only the drift check", "wallSecsPerIssue raised to 5400", ' +
      '"setup is cached so npm ci no longer dominates". No task was created and nothing was cloned; if nothing has changed, the honest answer is to tell the human, ' +
      "because the levers (raise wallSecsPerIssue, split the issue) belong to them.",
  };
}

/** Payload for "an earlier worker for this issue still owns it". Names the owning task so a human can abort it 
 *  deliberately instead of racing it. */
export function alreadyRunningPayload(issueNumber: number, claim: BudgetClaim, liveForMs: number): Record<string, unknown> {
  return {
    refused: true,
    retryable: false,
    alreadyRunning: true,
    issueNumber,
    owningTaskId: claim.taskId,
    runningForMs: liveForMs,
    reason:
      `a delegate call for issue #${issueNumber} is already in flight (owning task ${JSON.stringify(claim.taskId)}, started ${Math.round(liveForMs / 1000)}s ago). ` +
      "Two workers on one issue share a branch and one inference endpoint; the second would only fight the first.",
    hint:
      "Do not re-delegate and do not poll in a loop. Either wait for the run in flight, or stop it deliberately with POST /factory/runs/abort. Note for the operator: aborting by taskId settles that task but does NOT stop an orchestration conversation from delegating again — use {\"conversationId\":…} to stop the loop (fleet/README.md, #222).",
  };
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
