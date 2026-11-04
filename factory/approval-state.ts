// Approval-block detection inside a task (#188).
//
// The defect this closes. When a gate refuses a pipeline tool (`submit_verdict`, `edit`), the tool never runs, so no
// factory code executes at the moment of the block. The reviewer then goes idle with no verdict and the pipeline
// reported `reviewer never called submit_verdict` — which blames the model for what the policy did — while the run sat
// waiting on a human who was never told (#188, engram #63).
//
// Why a transcript read, when `GET /approvals` already exists. The adapter-side watcher (`approval-watch.ts`, shipped
// in #191) answers "who is waiting on a human?" fleet-wide, and it is the right place for that question. But the
// pipeline needs a different question answered at settle time — "did *this* conversation just stop because of an
// approval?" — and the answer has to be in the task's own outcome or every downstream consumer (refusal budget,
// retry decision, settlement window) keeps reading a policy block as an agent defect. `factory/approval-watch.ts`
// argued against reaching into kernel-internal docs; this module does not. It reads **committed transcript entries**
// through the documented `Conversation.entries()` read and parses the marker with `parseApprovalMarker`, which engram
// re-exports from `app/src/core.ts` — the same public surface `factory/main.ts` already imports from. The kernel's own
// `GET /approvals` is built by doing exactly this (server.ts: "pending approval requests (discovered from transcript
// markers)"), so this is the documented mechanism, not a side door.
//
// What this can and cannot claim — stated because overclaiming here is the interesting failure:
//
//   - It CAN say: this conversation contains an approval request for tool T with key K, and T's guarded effect never
//     landed. Both are observable facts about committed records.
//   - It CANNOT say: K is still pending right now. Approval decisions live in a kernel doc this module deliberately
//     does not read, and approvals expire (TTL sweep in `GET /approvals`). So callers use it the only way that is
//     sound: **after** the guarded result turned out to be absent. A granted approval makes the tool run, which
//     produces the very result whose absence we just observed; so "no result + request present" is a real block at
//     settle time, and callers must not report it as "still waiting" indefinitely. Wording here says "blocked pending
//     approval", never "waiting for you now" — that claim belongs to the watcher, which does poll live state.
//
// Failure direction: every read path degrades to "no block detected", which reproduces the old behavior (report a
// failure) rather than inventing a new one. A block we cannot see is a reporting gap; a block we hallucinate would
// suppress a genuine retry, which is worse.

import { parseApprovalMarker } from "../vendor/engram/app/src/core.ts";

export type BlockedApproval = { key: string; tool: string; tier?: string };

/** The literal text the kernel puts in a blocked tool result (`approvals.ts: approvalMarker`). */
const MARKER_NEEDLE = "Approval request: ";

/**
 * Collect every approval marker reachable from one transcript entry, newest-first ordering preserved.
 *
 * Entries carry content on several channels (`model` messages, `data` payload), and the same block appears more than
 * once in practice — measured on the production engram store, where each of five blocked conversations carried its
 * marker twice. Duplicates are collapsed by key so a caller gets "one wall", not "two walls".
 */
function markersIn(node: unknown, out: BlockedApproval[], depth = 0): void {
  if (depth > 16 || node === null || node === undefined) return;
  if (typeof node === "string") {
    if (!node.includes(MARKER_NEEDLE)) return;
    const req = parseApprovalMarker(node);
    // A marker without a key or tool cannot be approved, so surfacing it would send the operator an action they
    // cannot take. Malformed markers are dropped rather than guessed at.
    if (req && typeof req.key === "string" && req.key && typeof req.tool === "string" && req.tool) {
      out.push({ key: req.key, tool: req.tool, ...(typeof req.tier === "string" ? { tier: req.tier } : {}) });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) markersIn(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) markersIn(value, out, depth + 1);
  }
}

/** Every distinct approval marker across `entries`, in first-seen order. Never throws on shape. */
export function extractBlockedApprovals(entries: Iterable<unknown>): BlockedApproval[] {
  const byKey = new Map<string, BlockedApproval>();
  for (const entry of entries) {
    const found: BlockedApproval[] = [];
    try {
      markersIn(entry, found);
    } catch {
      // A shape we could not walk is not a block and not an error worth propagating into a settle path.
      continue;
    }
    for (const b of found) if (!byKey.has(b.key)) byKey.set(b.key, b);
  }
  return [...byKey.values()];
}

/** The block that explains a missing result for `tool`, if any entry reported one. */
export function findBlockForTool(blocks: readonly BlockedApproval[], tool: string): BlockedApproval | undefined {
  return blocks.find((b) => b.tool === tool);
}

/** One line for an outcome message or log: names the tool, the key, and how to clear it. */
export function describeBlockedApproval(b: BlockedApproval): string {
  const tier = b.tier ? `, ${b.tier}` : "";
  return `blocked pending approval ${b.key} (${b.tool}${tier}) — clear with POST /approvals/${b.key} {"decision":"approved"}`;
}

/**
 * The machine-readable fact downstream consumers branch on. `blockedKind` is a stable label for "this failure is a
 * policy wall, not an agent defect"; `blocked` carries the key to approve. Kept tiny and JSON-safe because it lands
 * in a durable outcome that the settlement window reads out of sqlite with `json_extract`.
 */
export const BLOCKED_KIND_APPROVAL = "approval" as const;

/**
 * The `outcome.result` shape for an approval-blocked stage. It has to be a member of each task's result union
 * (`TaskOutcome<R>` types `result` as `R | undefined`), which is why `ReviewerResult` and `WorkerResult` both gained
 * it — the compiler is what forced that, and a union that omitted it would have quietly made the honest outcome
 * unrepresentable and left the blaming message in place.
 */
export type ApprovalBlockedFacts = {
  blocked: BlockedApproval;
  blockedKind: typeof BLOCKED_KIND_APPROVAL;
};

export type BlockedOutcome = {
  status: "failed";
  error: { message: string };
  result: ApprovalBlockedFacts;
};

/**
 * Build the terminal outcome for "the guarded tool was refused", or `undefined` when nothing explains the gap.
 *
 * Why `failed` and not something nicer: `TaskOutcome` is a closed union of `completed | failed | aborted`, so there is
 * no `blocked` status to settle as (#188 offered "new outcome status **or** `outcome.result.blocked`" — the kernel's own
 * type decides which of the two is available). The run genuinely did not complete, so `failed` is honest; what was
 * dishonest was the *message*, which blamed the model. Consumers branch on `result.blocked`, never on a status that
 * does not exist.
 *
 * Extracted as a pure function so the classification is exhaustively unit-testable while the wiring around it stays
 * three lines that a live probe can prove.
 */
export function blockedOutcomeFor(blocks: readonly BlockedApproval[], tool: string, subject: string): BlockedOutcome | undefined {
  const block = findBlockForTool(blocks, tool);
  return block ? toBlockedOutcome(block, subject) : undefined;
}

/**
 * Like `blockedOutcomeFor`, for a stage whose critical tool is not one known name — a worker may be refused on
 * `edit`, `write`, or anything else in its policy. Takes the first block in context order (newest content first, as
 * the kernel returns it). Naming the actual tool matters: "a gate refused something" sends an operator to read config,
 * "`edit` was refused with key 8ce583c1e1c9" sends them to approve it.
 */
export function anyBlockedOutcome(blocks: readonly BlockedApproval[], subject: string): BlockedOutcome | undefined {
  const block = blocks[0];
  return block ? toBlockedOutcome(block, subject) : undefined;
}

function toBlockedOutcome(block: BlockedApproval, subject: string): BlockedOutcome {
  return {
    status: "failed",
    error: { message: `${subject} ${describeBlockedApproval(block)} — the call was made and a gate required a human decision; this is not an agent defect` },
    result: { blocked: block, blockedKind: BLOCKED_KIND_APPROVAL },
  };
}

/** Read `outcome.result.blocked` back out of a settled outcome. Tolerates every shape the store has ever held. */
export function readBlockedFromOutcome(outcome: unknown): BlockedApproval | undefined {
  const o = outcome as { result?: { blocked?: { key?: unknown; tool?: unknown; tier?: unknown } } } | null | undefined;
  const b = o?.result?.blocked;
  if (!b || typeof b.key !== "string" || !b.key || typeof b.tool !== "string" || !b.tool) return undefined;
  return { key: b.key, tool: b.tool, ...(typeof b.tier === "string" ? { tier: b.tier } : {}) };
}

/** The narrow capability this module needs: read one conversation's committed context view. */
export type ViewSource = () => Promise<{ entries?: readonly unknown[]; messages?: readonly unknown[] } | undefined>;

/**
 * Scan a kernel `ContextView` for approval requests. Both channels are searched on purpose.
 *
 * Verified against a copy of the production engram store (2026-11-04): conversation 269 (#188's reviewer block)
 * exposes `submit_verdict:74944fe45911` in **both** `view.entries` and `view.messages`, and 312's worker block
 * (`edit:8ce583c1e1c9`) likewise. Entries is the authoritative channel — a message can be dropped by context edits
 * while the entry remains — so scanning both costs nothing and cannot miss via either alone.
 */
export function blocksFromContextView(view: { entries?: readonly unknown[]; messages?: readonly unknown[] } | undefined): BlockedApproval[] {
  if (!view) return [];
  return extractBlockedApprovals([...(view.entries ?? []), ...(view.messages ?? [])]);
}

/**
 * The in-task read used by worker.ts and reviewer.ts: ask the task runtime for its own conversation's committed
 * context, then scan it.
 *
 * This is the seam that makes #188 solvable without an upstream API and without reaching across the kernel boundary:
 * `TaskRuntime.context()` is a documented in-task read (worker.ts already uses it to find the worker's final answer),
 * it runs under the task's own context, and it needs nothing injected from factory/main.ts. The alternative this
 * deliberately does not use — capturing `CoreInstance.harness` and reading with `BACKGROUND_CONTEXT` — works too
 * (it is how the probe script verifies this file) but binds a task to process-level state for a read the task can
 * already perform itself.
 *
 * Bounds, stated: entries run from the current head marker, so a block recorded before a compaction is no longer
 * visible. That is acceptable because callers consult this only at the moment a guarded result turns out to be
 * missing, when the block is by construction the most recent thing in the conversation. Read failures degrade to "no
 * block" for the reason given at the top of this file.
 */
export async function findBlocksInTaskContext(readView: ViewSource, log: (line: string) => void = () => {}): Promise<BlockedApproval[]> {
  try {
    const view = await readView();
    const blocks = blocksFromContextView(view);
    if (blocks.length > 0) log(`approval request(s) in committed context — ${blocks.map((b) => `${b.tool}:${b.key}`).join(", ")}`);
    // Parser-drift alarm. This module's only dangerous failure is silently returning "no block": the run then gets
    // the pre-#188 message that blames the model, and nothing downstream notices. The kernel records a machine-readable
    // `code: "blocked"` diagnostic next to the human marker, so if the wording or marker format ever changes we still
    // see a block we could not parse — and say so out loud instead of concluding there was none.
    const unparsed = countUnparsedBlocks(view);
    if (unparsed > 0) log(`WARNING: ${unparsed} blocked-tool diagnostic(s) with no parseable approval marker — the marker format may have changed; #188 detection is degraded, not absent`);
    return blocks;
  } catch (e) {
    log(`context read failed (${(e as Error).message}) — reporting no block, which reproduces pre-#188 behavior`);
    return [];
  }
}

/**
 * Blocked-tool diagnostics whose text carries no parseable approval marker.
 *
 * Captured from the production engram store (conversation 269, entry 304, 2026-11-04) — the real shape is:
 * `entry.kind === "pi.tool-result"`, `entry.data.diagnostics[] = { severity: "error", code: "blocked", message }`,
 * and `entry.model[0] = { role: "toolResult", toolName, isError: true }`. The `code` field is what makes this check
 * independent of the marker's wording; `toolName` is a second independent source of the blocked tool's identity.
 */
export function countUnparsedBlocks(view: { entries?: readonly unknown[]; messages?: readonly unknown[] } | undefined): number {
  if (!view) return 0;
  let count = 0;
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 16 || node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    const rec = node as Record<string, unknown>;
    if (rec.code === "blocked" && typeof rec.message === "string" && !parseApprovalMarker(rec.message)) count += 1;
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  for (const e of [...(view.entries ?? []), ...(view.messages ?? [])]) walk(e);
  return count;
}


