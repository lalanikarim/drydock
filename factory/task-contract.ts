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
