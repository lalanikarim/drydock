/**
 * Registration-time contract checks for task definitions (#164).
 *
 * `defineTask` in pi-durable is `{ definition }` — a pass-through with no validation — and the scheduler aborts by
 * calling `erased(task).abort(...)`, i.e. `definition.abort`, a **top-level** member. Ours sat inside `phases`, whose
 * string index signature accepted it as just another phase name, so two production tasks faulted with
 * `erased(...).abort is not a function` and nothing said anything until a settlement counter existed (#161) to notice
 * that a handler which had never run was also a handler nobody called.
 *
 * The kernel can't validate this for us (it doesn't look until the abort happens, possibly days later), so we check it
 * where we still can: at boot, before any task is submitted. A factory that cannot abort its own workers should fail
 * to start rather than discover it during an incident.
 */

export interface AbortableTask {
  definition?: { name?: string; phases?: Record<string, unknown>; abort?: unknown };
}

/**
 * Did this abort come from the kernel reclaiming a reservation whose owner died? (#157)
 *
 * A task created under a tool that does not resume is flagged `abandonOnRestart`, and the next instance boot marks its
 * live tasks with `abortReason: "restart"` before anything of them runs a phase again. That mechanism exists and
 * works — what was missing was that nothing said so: a settled-at-boot task looked identical to an operator stop in
 * the durable record, and no log line mentioned the recovery at all (verified 2026-11-03: stale `factory.worker`
 * reservation terminal within 5 s of the replacement boot, zero log lines naming it).
 */
export function isRestartAbort(task: { abortReason?: unknown } | undefined): boolean {
  return String(task?.abortReason ?? "").toLowerCase() === "restart";
}

/** Durable facts an abort handler may record alongside its reason (#173: inside `result`, not on the outcome). */
export type AbortFacts = { reclaimedAtBoot?: boolean };

/**
 * The outcome an abort handler commits, keeping a crash-reclaim distinguishable from a human stopping a run.
 *
 * `label` produces the historical strings unchanged (`worker aborted`, `reviewer aborted`, `refinement aborted`) so
 * anything matching them keeps matching; a restart gets its own reason instead of inheriting one. The settlement
 * ledger classifies on the kernel's `abort_reason` column (#161), which this does not touch — it is about what a
 * reader of the record, or of a log line, can tell apart afterwards.
 */
export function abortedOutcome(
  task: { abortReason?: unknown } | undefined,
  label: string,
): { status: "aborted"; reason: string; result?: AbortFacts } {
  // Durable extras go in `result`. The kernel's TaskOutcome union is closed (`status`, `reason`, `result`, `error`)
  // and `reclaimedAtBoot` used to ride on the outcome itself — persisted, because nothing validates, but promised by
  // nothing either (#173).
  return isRestartAbort(task)
    ? { status: "aborted", reason: `${label} reclaimed at boot`, result: { reclaimedAtBoot: true } }
    : { status: "aborted", reason: `${label} aborted` };
}

/**
 * Throws unless the task exposes a callable `abort` where the kernel reads it.
 *
 * @param task   the value returned by `defineTask(...)` — `{ definition }`
 * @param label  what to call it in the message; defaults to `definition.name`
 */
export function assertAbortable(task: AbortableTask | null | undefined, label?: string): void {
  if (task === null || task === undefined) return; // optional definitions are the caller's decision, not a contract violation
  const def = task.definition;
  const name = label ?? def?.name ?? "<unnamed task>";
  if (!def || typeof def !== "object") {
    throw new Error(`task ${name}: defineTask() must return { definition } (got ${JSON.stringify(def) ?? String(def)})`);
  }
  if (typeof def.abort !== "function") {
    const nested = def.phases && "abort" in def.phases;
    throw new Error(
      `task ${name}: definition.abort is ${typeof def.abort}, but the scheduler calls erased(task).abort(...) directly — ` +
        (nested
          ? "`abort` is nested under `phases`, where its index signature hides it from the type checker and the kernel never looks (#164). "
          : "") +
        "Declare abort as a top-level member of TaskDefinition.",
    );
  }
}
