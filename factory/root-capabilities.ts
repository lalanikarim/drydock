// Root capability sync (#65 live finding, 2026-11-01).
//
// `harness.root(ctx, { agent })` applies the agent options **only when the root conversation is created**.
// For an existing root it returns the id immediately and discards `agent` — silently. In code (pi-durable
// harness.js, #create): the early return for an existing root happens before `configure()` is reached.
//
// So restarting a long-lived factory instance did NOT deliver newly registered tools, revised orchestrator
// instructions, or a re-pinned model to the root agent. Observed live: after shipping `refine_issue` and
// booting with "refinement enabled" in the log, the running orchestrator answered —
//
//   "I don't have a `refine_issue` tool available in my current toolset."
//
// with exactly the four tools it was born with. That contradicts this project's standing rule that policy
// applies at process start: capability removal (`autoMerge=false` hiding `merge_pr`) was assumed to be
// re-asserted on every boot, and for an existing root conversation it was not. A policy that is only applied
// the first time a database is created is not a policy, it is a fossil.
//
// This module re-asserts the current agent configuration on the root conversation at every start and then
// **reads back** what the conversation will actually offer, so a sync that did not take is a boot failure
// rather than a surprise several minutes of inference later.

/** The part of a conversation handle this module needs; kept structural so it can be tested with a fake. */
export type RootConversation = {
  configure(change: unknown, ctx: unknown): Promise<void>;
  agent(ctx: unknown): Promise<{ readonly tools?: readonly { readonly name?: string }[] }>;
};

/** Names of the tools an agent will offer, in order, tolerating registrations or bare strings. */
function toolNames(tools: readonly unknown[] | undefined): string[] {
  return (tools ?? []).map((t) => (typeof t === "string" ? t : ((t as { name?: string }).name ?? String(t))));
}

/**
 * Re-assert `change` on the root conversation and verify the capability set that results.
 *
 * Throws when the root handle cannot be resolved, or when the tools actually offered differ from `expected`.
 * Callers should treat either as fatal: continuing means running with capabilities nobody chose, and the
 * interesting case is a run that has MORE authority than the registry grants.
 */
export async function syncRootCapabilities(opts: {
  /** Resolve the root conversation handle (undefined when it does not exist). */
  conversation: () => Promise<RootConversation | undefined>;
  /** The agent configuration to assert, in the shape `configure()` takes. */
  change: Record<string, unknown>;
  /** Tool names that MUST be offered afterwards — usually the same list that built `change.tools`. */
  expected: readonly string[];
  /** Harness context. Defaults to null so tests need not supply one. */
  ctx?: unknown;
  log?: (line: string) => void;
}): Promise<{ tools: string[] }> {
  const log = opts.log ?? (() => {});
  const handle = await opts.conversation();
  if (!handle) {
    throw new Error("root capability sync: no root conversation handle — cannot verify what this instance may do");
  }

  await handle.configure(opts.change, opts.ctx ?? null);
  const agent = await handle.agent(opts.ctx ?? null);
  const actual = toolNames(agent?.tools);
  const expected = [...opts.expected];
  const missing = expected.filter((n) => !actual.includes(n));
  const extra = actual.filter((n) => !expected.includes(n));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `root capability sync refused to start: the root agent would ${missing.length ? `be missing ${missing.join(", ")}` : ""}` +
        `${missing.length && extra.length ? " and" : ""}${extra.length ? ` offer unlisted ${extra.join(", ")}` : ""}. ` +
        `expected [${expected.join(", ")}], would offer [${actual.join(", ")}]. ` +
        `The registry decides capabilities; starting anyway would run with authority nobody chose.`,
    );
  }

  log(`root capabilities synced: ${actual.join(", ")}`);
  return { tools: actual };
}
