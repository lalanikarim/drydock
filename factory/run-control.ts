// Operator run control: a real lever for "this run will not finish" (#141, and the missing half of #120).
//
// Before this, stopping one delegated task meant either asking the model politely (`/factory <directive>`,
// which spends another generation to decline) or taking the fleet down — and taking the fleet down was
// itself how #143 bit. The kernel already has abort machinery (`Harness.abortTask`, `Conversation.abort`);
// it just exposes no route for it, so an operator with a stuck run and a token had nothing to call.
//
// Two rules this file holds itself to:
//
//   * **Report what happened, not what was asked.** Every response reads the durable record back after the
//     abort — `marked` versus `terminal`, and whether it settled inside a bounded wait. "200 OK" from an
//     abort call that changed nothing is exactly the kind of green-that-means-nothing this repo has been
//     bitten by repeatedly (an uncollected test suite and a passing sweep over zero repos are the same bug).
//   * **An operator abort is never charged to the wall-budget cap.** A human stopping a run is information,
//     not evidence the model flailed; counting it would punish using the lever. It is still recorded, so a
//     later reader sees that a person intervened.
//
// Auth: registered through `createCoreInstance({ routes: [...] })`, so the kernel's bearer-token gate runs
// before this handler — same posture as `/factory/intake` (#122). No address-based trust anywhere; the
// funnel terminates from loopback.

import { readJsonBody, type AppRoute, type RouteContext } from "../vendor/engram/app/src/server.ts";
import { BudgetLedgerDoc, budgetEntry, noteOperatorAbort, type BudgetLedgerState } from "./budget-ledger.ts";

/** How long to wait for an abort mark to reach a terminal state before reporting it as still settling. */
const SETTLE_WAIT_MS = 5_000;
const SETTLE_POLL_MS = 100;

export interface RunControlOptions {
  repo: string;
  log?: (message: string) => void;
}

/** `{taskId}` xor `{conversationId}`, plus an optional `issueNumber` to attribute the intervention to. */
export function validateAbortRequest(body: Record<string, unknown>):
  | { ok: true; taskId?: number; conversationId?: number; issueNumber?: number; reason: string }
  | { ok: false; status: number; error: string } {
  const hasTask = body.taskId !== undefined && body.taskId !== null;
  const hasConv = body.conversationId !== undefined && body.conversationId !== null;
  if (hasTask === hasConv) {
    return {
      ok: false,
      status: 400,
      error: "exactly one of taskId or conversationId is required (abort a task, or a whole conversation — not both, not neither)",
    };
  }
  const int = (v: unknown, name: string): number | undefined | "invalid" => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return "invalid";
    return n;
  };
  const taskId = int(body.taskId, "taskId");
  if (taskId === "invalid") return { ok: false, status: 400, error: "taskId must be a positive integer" };
  const conversationId = int(body.conversationId, "conversationId");
  if (conversationId === "invalid") return { ok: false, status: 400, error: "conversationId must be a positive integer" };
  const issueNumberRaw = int(body.issueNumber, "issueNumber");
  if (issueNumberRaw === "invalid") return { ok: false, status: 400, error: "issueNumber must be a positive integer" };

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  return { ok: true, ...(taskId ? { taskId } : {}), ...(conversationId ? { conversationId } : {}), ...(issueNumberRaw ? { issueNumber: issueNumberRaw } : {}), reason };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The kernel's task lifecycle verbatim (`TaskState`): pending → running → waiting/completing → terminal.
 * Anything not listed is treated as live, because guessing "settled" on a status this build has not seen
 * would report a stopped run that is still spending inference.
 */
const LIVE_STATUSES = new Set(["pending", "running", "waiting", "completing"]);
export const isTerminalStatus = (status: unknown): boolean => status === "terminal";

/** Read the lifecycle status out of a TaskRecord without assuming which field the kernel used. */
function statusOf(record: unknown): string {
  const rec = record as { state?: { status?: string }; status?: string } | undefined;
  return rec?.state?.status ?? rec?.status ?? "unknown";
}

/**
 * The factory's run-control route. `POST /factory/runs/abort`.
 *
 * Task path: read the record → refuse if unknown → abort → **read it back** and report the durable status.
 * Conversation path: withdraw queued inputs and abort that conversation's task scope.
 */
export function createRunControlRoute(opts: RunControlOptions): AppRoute {
  const log = opts.log ?? ((m) => console.log(`[factory] ${opts.repo}: run-control — ${m}`));

  return {
    method: "POST",
    path: "/factory/runs/abort",
    async handle(req, res, rctx: RouteContext) {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        rctx.json(res, 400, { error: `body must be JSON: ${(e as Error).message}` });
        return;
      }

      const v = validateAbortRequest(body);
      if (!v.ok) {
        log(`rejected (${v.status}): ${v.error}`);
        rctx.json(res, v.status, { error: v.error });
        return;
      }

      const { harness, ctx } = rctx;

      // Record the intervention against the issue (never charged to the cap) so the ledger shows a human
      // acted. Only when the caller told us which issue — guessing from conversation names would invent data.
      const noteIntervention = async (issueNumber: number) => {
        await harness.commit(async (tx) => {
          noteOperatorAbort(await tx.doc(BudgetLedgerDoc), issueNumber, { reason: v.reason || "aborted by operator" });
        }, ctx);
      };

      if (v.taskId !== undefined) {
        const taskId = v.taskId as never;
        const before = await harness.getTask(taskId, ctx);
        if (!before) {
          // Distinct from "already terminal": an id that names nothing usually means the operator pasted a
          // stale id or is pointed at the wrong instance, and both deserve to be said out loud.
          log(`no such task ${v.taskId}`);
          rctx.json(res, 404, { error: `no task ${v.taskId} in this instance`, taskId: v.taskId });
          return;
        }

        const statusBefore = statusOf(before);
        if (v.issueNumber) await noteIntervention(v.issueNumber);

        const mark = await harness.abortTask(taskId, ctx);
        if (mark === "terminal") {
          log(`task ${v.taskId} was already terminal (status ${statusBefore}); nothing to abort`);
          rctx.json(res, 200, { aborted: false, alreadyTerminal: true, taskId: v.taskId, status: statusBefore });
          return;
        }

        // "marked" is a promise, not an outcome. Give the abort invocation a bounded window to commit its
        // terminal state, then report honestly whichever way it went.
        const deadline = Date.now() + SETTLE_WAIT_MS;
        let statusAfter = statusBefore;
        while (Date.now() < deadline) {
          await sleep(SETTLE_POLL_MS);
          const rec = await harness.getTask(taskId, ctx);
          const s = statusOf(rec);
          if (isTerminalStatus(s)) {
            statusAfter = s;
            break;
          }
        }
        const settled = isTerminalStatus(statusAfter);
        log(`task ${v.taskId} abort marked; status ${statusBefore} → ${statusAfter}${settled ? "" : ` (still settling after ${SETTLE_WAIT_MS}ms)`}`);
        rctx.json(res, 200, {
          aborted: true,
          taskId: v.taskId,
          mark,
          statusBefore,
          statusAfter,
          settled,
          ...(settled ? {} : { note: `abort marked but not terminal within ${SETTLE_WAIT_MS}ms — re-check the task before assuming the run stopped` }),
        });
        return;
      }

      const conversationId = v.conversationId as never;
      const conv = await harness.conversation(conversationId, ctx);
      if (!conv) {
        log(`no such conversation ${v.conversationId}`);
        rctx.json(res, 404, { error: `no conversation ${v.conversationId} in this instance`, conversationId: v.conversationId });
        return;
      }
      if (v.issueNumber) await noteIntervention(v.issueNumber);
      // Conversation.abort() withdraws queued inputs and aborts the ordinary ownership scope, resolving when
      // that scope is idle — the right lever for "stop everything this issue is doing".
      await conv.abort(ctx);
      log(`conversation ${v.conversationId} aborted${v.reason ? ` (${v.reason})` : ""}`);
      rctx.json(res, 200, { aborted: true, conversationId: v.conversationId, scope: "conversation" });
    },
  };
}

/** What an operator's abort recorded for one issue — used by the shutdown summary and by tests. */
export function operatorAbortCount(state: BudgetLedgerState | undefined, issueNumber: number): number {
  return budgetEntry(state, issueNumber)?.operatorAborts ?? 0;
}
