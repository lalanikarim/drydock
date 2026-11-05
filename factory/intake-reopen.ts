// Operator reopen verb (#226): dispatch an issue again after its orchestration conversation ended.
//
// The trap this removes. Intake dedupes on `requestId`, and for an issue kind that id is a constant derived
// from the event (`issue-<n>`), stored in a durable document. That is correct for webhook redelivery — GitHub
// does redeliver — but it also means an issue gets **one dispatch per instance store, ever**. So the natural
// recovery after aborting a run ("label it again") silently does nothing:
//
//   [factory] lalanikarim/drydock: intake — requestId issue-220 already handled — no new submission
//
// Observed live 2026-11-05 while trying to prove #222's guard: the label event arrived, intake swallowed it,
// and there was no supported way to retry short of filing a replacement issue or hand-editing a live sqlite
// document at 01:50 UTC.
//
// Why this is a new requestId rather than a deletion. Removing the old record would erase the evidence that
// the issue was ever dispatched, which is exactly what makes an intake decision explainable after the fact.
// A reopen appends (`issue-<n>#reopen-2`), leaving the first attempt's record intact and the count of attempts
// readable from history.
//
// Why this must never clear the wall-budget ledger. `budgetAborts` is what makes #141 and #222 real: two
// budget aborts stop an issue so a third cannot silently spend another full budget. A "retry" button that also
// reset that counter would be one call away from undoing both, and it would be tempting precisely when the
// operator is annoyed. So this route reads the ledger and reports it, and writes nothing to it — asserted in
// tests by a fake that records every document any commit touches.

import { readJsonBody, type AppRoute, type RouteContext } from "../vendor/engram/app/src/server.ts";
import { dispatchIntake, intakeKey, IntakeLedgerDoc, type IntakeRouteOptions } from "./intake-router.ts";
import { budgetEntry, BudgetLedgerDoc } from "./budget-ledger.ts";

const MAX_REASON = 2_000;

export interface ReopenRouteOptions extends IntakeRouteOptions {}

/** Validate a reopen request. Same rule as everywhere else in this directory: no defaults for garbage input. */
export function validateReopenBody(body: Record<string, unknown>):
  | { ok: true; issueNumber: number; reason: string }
  | { ok: false; status: number; error: string } {
  const { issueNumber, reason } = body ?? {};
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, status: 400, error: `issueNumber must be a positive integer (got ${JSON.stringify(issueNumber)})` };
  }
  if (typeof reason !== "string" || !reason.trim()) {
    return {
      ok: false,
      status: 400,
      error:
        "reason is required and must be non-empty: a reopen is an authorized second attempt, and 'what changed' is the part worth recording (#222's replan rule applies to operators too)",
    };
  }
  if (reason.length > MAX_REASON) {
    return { ok: false, status: 400, error: `reason must be at most ${MAX_REASON} characters` };
  }
  return { ok: true, issueNumber, reason: reason.trim() };
}

/**
 * The next reopen id for an issue, from durable history: `issue-9#reopen-1`, then `-2`. Counting existing
 * records rather than a fresh clock means two reopens in the same millisecond still get distinct ids, and the
 * sequence reads as an attempt count when someone inspects the ledger later.
 */
export function nextReopenRequestId(requests: readonly { id: string }[], issueNumber: number): string {
  const prefix = `issue-${issueNumber}#reopen-`;
  let max = 0;
  for (const r of requests ?? []) {
    if (typeof r?.id === "string" && r.id.startsWith(prefix)) {
      const n = Number(r.id.slice(prefix.length));
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

/** The instruction the fresh conversation receives. Written to be honest about what it is not: a clean budget. */
export function buildReopenContent(issueNumber: number, reason: string, attempt: number, priorConversationId: number | undefined): string {
  return [
    `[operator reopen — attempt ${attempt}]`,
    `Issue #${issueNumber} is being dispatched again because its previous orchestration conversation ended (aborted by the operator, or it ran out of budget). Re-applying the label cannot do this: an issue has one constant intake requestId per instance store (#226), which is why this verb exists.`,
    `This is a NEW conversation on purpose. A transcript that already contains an abort or a refusal treats that history as evidence about what is possible (#122), so resuming the old one would start the retry at a disadvantage nobody agreed to.${priorConversationId ? ` The superseded conversation was ${priorConversationId}.` : ""}`,
    `Reason given by the operator: ${JSON.stringify(reason)}`,
    `What did NOT change: the wall-budget ledger. If this issue already aborted on its budget, \`delegate\` will refuse until a \`replan\` states what is different (#222), and after two aborts it refuses outright (#141). Do not work around that — if the guard fires, report it to the operator instead of retrying.`,
  ].join("\n\n");
}

/**
 * `POST /factory/intake/reopen {"issueNumber":220,"reason":"issue split to the drift check only"}`
 *
 * → 202 `{ reopened, conversationId, requestId, supersededConversationId?, budget }`, where `budget` is the
 * ledger read back after the dispatch (never modified) so the operator learns immediately whether this attempt
 * is going to be refused by #222/#141 rather than finding out from a log line later.
 */
export function createReopenRoute(opts: ReopenRouteOptions): AppRoute {
  const log = opts.log ?? ((m) => console.log(`[factory] ${opts.repo}: reopen — ${m}`));

  return {
    method: "POST",
    path: "/factory/intake/reopen",
    async handle(req, res, rctx: RouteContext) {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        rctx.json(res, 400, { error: `body must be JSON: ${(e as Error).message}` });
        return;
      }

      const v = validateReopenBody(body);
      if (!v.ok) {
        log(`rejected (${v.status}): ${v.error}`);
        rctx.json(res, v.status, { error: v.error });
        return;
      }

      const { harness, ctx } = rctx;
      const subject = `#${v.issueNumber}`;
      const key = intakeKey("issue", subject);
      const ledger = await harness.snapshot(IntakeLedgerDoc, ctx);
      const requestId = nextReopenRequestId(ledger?.requests ?? [], v.issueNumber);
      const attempt = Number(requestId.slice(`issue-${v.issueNumber}#reopen-`.length));
      const priorConversationId = ledger?.entries?.[key];

      // Same dispatch path as webhook intake — capability envelope, find-or-create, submit, and the durable
      // request record are shared by construction, not copied.
      const result = await dispatchIntake(
        opts,
        { kind: "issue", subject, requestId, content: buildReopenContent(v.issueNumber, v.reason, attempt, priorConversationId) },
        rctx,
        log,
        { forceNewConversation: true },
      );

      if (result.status < 400) {
        log(`reopened issue #${v.issueNumber} as ${requestId} → conversation ${result.body.conversationId ?? "?"} (superseded ${priorConversationId ?? "none"}): ${v.reason.slice(0, 160)}`);
      }

      // Read the budget ledger back and put it in the response. This is the difference between an operator
      // verb that says "ok" and one that says "ok, and note that delegate will refuse this until …".
      const budgets = await harness.snapshot(BudgetLedgerDoc, ctx);
      const entry = budgetEntry(budgets, v.issueNumber);
      const budget = {
        budgetAborts: entry?.budgetAborts ?? 0,
        operatorAborts: entry?.operatorAborts ?? 0,
        stopped: entry?.stopped === true,
        prNumber: entry?.prNumber ?? null,
        claim: entry?.claim ?? null,
      };
      const warning = budget.stopped
        ? "budget ledger says this issue is STOPPED after exhausting its wall budget: delegate will refuse without doing work (#141). Reopening restores dispatchability, not budget — the levers (raise wallSecsPerIssue, split the issue) are operator decisions."
        : budget.budgetAborts > 0
          ? `budget ledger shows ${budget.budgetAborts} prior abort(s): delegate will require a non-empty \`replan\` (#222). The reason recorded here is for audit; the orchestrator must still state what changed.`
          : undefined;

      rctx.json(res, result.status, { reopened: result.status === 202, requestId, attempt, ...result.body, ...(warning ? { warning } : {}), budget });
    },
  };
}
