// Wall-clock budget enforcement (plan §3.4), ported to TS for the core
// composition. Host-side: races the conversation's idle-wait against a
// deadline; the caller decides how to abort on overrun.

import type { ConversationHandle } from "@earendil-works/pi-durable";
// `Context` belongs to chord, not pi-durable — the sandbox contract takes one and so does
// ConversationHandle.waitForIdle. Importing it from pi-durable cost nothing at runtime (types are
// stripped) and reported TS2305 the first time a compiler was pointed at this tree (#173).
import type { Context } from "@earendil-works/chord/context";

/** Deadline in ms from now (budgetSecs <= 0 means no budget). */
export function budgetDeadlineMs(budgetSecs: number): number | null {
  return budgetSecs > 0 ? Date.now() + budgetSecs * 1000 : null;
}

/** Wait for the conversation to idle, or until the deadline.
 * Returns "idle" or "overrun" — the caller decides how to abort. */
export async function awaitIdleWithinBudget(handle: ConversationHandle, ctx: Context, budgetSecs: number): Promise<"idle" | "overrun"> {
  const deadline = budgetDeadlineMs(budgetSecs);
  if (deadline === null) return handle.waitForIdle(ctx).then(() => "idle");
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"overrun">((resolve) => {
    timer = setTimeout(() => resolve("overrun"), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([handle.waitForIdle(ctx).then(() => "idle" as const), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
