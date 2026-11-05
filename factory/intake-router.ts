// Deterministic intake routing (#122): every webhook event gets a conversation of its own kind, with
// only the capabilities that kind needs — instead of everything landing in the one long-lived root
// conversation.
//
// Why this exists. The live failure was: the root orchestrator refused `refine_issue` three times while
// the tool sat in the outbound request. Nothing was wrong with the registration; the transcript was.
// Once a model has written "I don't have that tool" into its own context, that sentence is the most
// recent authority on what exists, and every later turn reads it as evidence. A prompt saying "you DO
// have it" is a fight against the transcript, and the transcript wins — that is why the fix here is not
// a prompt. Conversation-scoping makes the failure unrepresentable: a refinement conversation has never
// contained a turn where `refine_issue` was absent, because it is created with exactly one tool and that
// tool is `refine_issue`.
//
// Scope of one conversation = one (kind, subject). Not per event: per-event conversations would break
// the kernel's exactly-once guarantee, which settles `requestId` *within a conversation*. GitHub
// redelivers; a stable conversation per issue/PR means a redelivery is absorbed by the core instead of
// starting a second run. Cross-issue and cross-kind poisoning — the class that actually bit — is gone
// because no two subjects share a transcript.
//
// The map lives in a session-scoped durable document, so a restart finds the same conversations rather
// than silently opening new ones (which would reopen the dedupe hole).

import { defineDoc } from "@earendil-works/pi-durable";
// Kernel seams, both already reached into by factory/main.ts (this repo consumes the submodule's src,
// pinned by gitlink): AppRoute is the documented consumer-route interface, readJsonBody is exported
// for app routes, ConversationMeta is the doc GET /conversations reads to display a name.
import { readJsonBody, type AppRoute, type RouteContext } from "../vendor/engram/app/src/server.ts";
import { ConversationMeta } from "../vendor/engram/app/src/meta.ts";

/** The three intake kinds the adapter distinguishes (factory/intake.ts `classifyWebhookEvent`). */
export const INTAKE_KINDS = ["issue", "pr-feedback", "refine"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export function isIntakeKind(v: unknown): v is IntakeKind {
  return typeof v === "string" && (INTAKE_KINDS as readonly string[]).includes(v);
}

/** Stable conversation key for one subject of one kind. */
export function intakeKey(kind: IntakeKind, subject: string): string {
  return `${kind}:${subject}`;
}

/**
 * What a `requestId` MEANS for each kind — which decides what a *different* requestId means (#235).
 *
 * `per-attempt` (`issue`): the adapter always sends `issue-<n>` (`factory/intake.ts:intakeRequestId`), so the id
 * identifies one attempt at the issue, not one GitHub event. Dedupe answers an identical id with 200 before this
 * code runs, therefore arriving here with a different id than the recorded one can only mean a deliberate new
 * attempt — and #122 says that attempt starts in a clean transcript, the same rule `POST /factory/intake/reopen`
 * has always followed. Reusing the old conversation on this path is never what the caller meant: it writes into a
 * transcript whose last entry may be an abort or a refusal, which #122 measured as evidence the model reads.
 *
 * `per-event` (`refine`, `pr-feedback`): ids carry the comment id (`issue-<n>-refine-c-<commentId>`,
 * `pr-<pr>-c-<commentId>`), so many distinct ids for one subject are the feature — steering an existing
 * conversation. Forcing fresh there would destroy refinement context, and `factory/intake-boot.test.ts` step 5
 * pins that reuse. Hence a per-kind policy rather than one rule for all three kinds.
 *
 * Stated as data with this comment because the alternative — inferring intent from message text or from settle
 * state — was the option rejected in #235: "sometimes fresh" is worse for a transcript-poisoning hazard than
 * "always fresh, and here is what it replaced".
 */
export const CONVERSATION_POLICY: Record<IntakeKind, "per-attempt" | "per-event"> = {
  issue: "per-attempt",
  "pr-feedback": "per-event",
  refine: "per-event",
};

/** The most recent requestId recorded for a key. Prefers `lastRequest` (written atomically with the conversation
 *  pointer); falls back to scanning the bounded tail for stores that predate #235. */
function lastRequestIdFor(
  ledger: { lastRequest?: Record<string, string>; requests?: { id: string; key: string }[] } | undefined,
  key: string,
): string | undefined {
  if (ledger?.lastRequest?.[key] !== undefined) return ledger.lastRequest[key];
  const rows = ledger?.requests ?? [];
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].key === key) return rows[i].id;
  return undefined;
}

/** How many recorded requests already landed on this conversation. Bounded by the tail, so it is a floor after
 *  pruning — which is why the response calls it `attemptsRecorded`, not `attempt`. */
function attemptsOn(ledger: { requests?: { key: string; conversationId: number }[] } | undefined, key: string, conversationId: number): number {
  return (ledger?.requests ?? []).filter((r) => r.key === key && r.conversationId === conversationId).length;
}

type RequestRecord = { id: string; key: string; conversationId: number; at: number };

/**
 * Durable intake ledger: which conversation owns which (kind, subject), plus a bounded tail of handled
 * request ids. The request tail is an observability fast path — the actual exactly-once guarantee is the
 * core's per-conversation `requestId` settlement, which still applies on every submit.
 */
export const IntakeLedgerDoc = defineDoc({
  scope: "session",
  kind: "factory.intake-ledger",
  version: 1,
  initial: (): {
    entries: Record<string, number>;
    requests: RequestRecord[];
    /**
     * Last requestId per key (#235). Written in the SAME commit as `entries[key]`, which is why it exists at all:
     * deriving "what was the previous attempt's id" from the bounded `requests` tail leaves a crash window between
     * the conversation-write and the tail-append, and a caller retrying inside that window would be judged a new
     * attempt and get a second conversation for one submission. Optional because stores predating #235 lack it;
     * readers fall back to the tail.
     */
    lastRequest?: Record<string, string>;
  } => ({
    entries: {},
    requests: [],
    lastRequest: {},
  }),
});

/** How many handled request ids to keep. Pruning older ones is safe: the core still dedupes. */
const REQUEST_TAIL = 2000;

/** What an intake conversation may be: instructions plus the exact tool registrations it can call. */
export type IntakeAgentSpec = {
  instructions: string;
  // ToolRegistration is structurally opaque here; the kernel takes the array as-is in AgentChange.
  tools: readonly unknown[];
};

export interface IntakeRouteOptions {
  repo: string;
  /** Per-kind capability envelope. A missing kind means that kind is refused (409) with a reason. */
  agents: Partial<Record<IntakeKind, IntakeAgentSpec>>;
  modelRef: { provider: string; modelId: string };
  log?: (message: string) => void;
}

const MAX_CONTENT = 200_000; // characters; a webhook-rendered prompt is a few KB
const MAX_SUBJECT = 120;
const MAX_REQUEST_ID = 200;

/**
 * Validate an intake body. Returns the normalized fields or a human-runnable reason for the rejection —
 * never a default. A malformed body must not be routed "best effort": GitHub retries on 5xx and answers
 * 2xx on policy refusals, so the status code is the only feedback loop anyone has.
 */
export function validateIntakeBody(body: Record<string, unknown>):
  | { ok: true; kind: IntakeKind; subject: string; requestId: string; content: string }
  | { ok: false; status: number; error: string } {
  const { kind, subject, requestId, content } = body ?? {};
  if (!isIntakeKind(kind)) {
    return { ok: false, status: 400, error: `kind must be one of ${INTAKE_KINDS.join(" | ")} (got ${JSON.stringify(kind)})` };
  }
  if (typeof subject !== "string" || !subject.trim()) {
    return { ok: false, status: 400, error: "subject must be a non-empty string (e.g. \"#122\")" };
  }
  if (subject.length > MAX_SUBJECT) {
    return { ok: false, status: 400, error: `subject must be at most ${MAX_SUBJECT} characters` };
  }
  if (typeof requestId !== "string" || !requestId.trim()) {
    return { ok: false, status: 400, error: "requestId must be a non-empty string (exactly-once depends on it)" };
  }
  if (requestId.length > MAX_REQUEST_ID) {
    return { ok: false, status: 400, error: `requestId must be at most ${MAX_REQUEST_ID} characters` };
  }
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, status: 400, error: "content must be a non-empty string" };
  }
  if (content.length > MAX_CONTENT) {
    return { ok: false, status: 413, error: `content must be at most ${MAX_CONTENT} characters (got ${content.length})` };
  }
  return { ok: true, kind, subject: subject.trim(), requestId: requestId.trim(), content };
}

/** A normalized intake submission, as produced by `validateIntakeBody` or by an operator verb. */
export type IntakeSubmission = { kind: IntakeKind; subject: string; requestId: string; content: string };

/**
 * The one path from a validated submission to "a conversation owns this subject and has the input".
 *
 * Exported because there are now two front doors that must behave identically — the webhook intake route and
 * the operator reopen verb (#226). Two implementations of find-or-create + submit + ledger-write is how the
 * reopen path would quietly stop recording history, and history is the only reason the dedupe is debuggable.
 *
 * `forceNewConversation` (reopen only) skips the existing conversation for this key. That is deliberate and
 * follows #122's own reasoning: a transcript that already contains "this run was aborted" or a refusal reads
 * its own history as evidence about what is possible, so resubmitting into it starts from a disadvantage the
 * operator did not agree to. The old conversation id is reported, never reused.
 */
export async function dispatchIntake(
  opts: IntakeRouteOptions,
  v: IntakeSubmission,
  rctx: RouteContext,
  log: (message: string) => void,
  policy: { forceNewConversation?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const spec = opts.agents[v.kind];
  if (!spec) {
    // The adapter classifies with the same policy and should never send this. Reaching here means the
    // two halves disagree, which is worth a log line rather than a silent drop.
    log(`refused kind "${v.kind}" — no capability envelope configured for it (policy disabled it?)`);
    return { status: 409, body: { error: `intake kind "${v.kind}" is not enabled for ${opts.repo}` } };
  }
  // A conversation with zero tools cannot do the work it was opened for; refusing at the door beats
  // scheduling a run that will report itself unable. (This is the #122 shape, seen from the other side.)
  if (spec.tools.length === 0) {
    log(`refused kind "${v.kind}" — its capability envelope is empty`);
    return { status: 500, body: { error: `intake kind "${v.kind}" has no tools registered` } };
  }

  const key = intakeKey(v.kind, v.subject);
  const { harness, ctx } = rctx;

  const ledger = await harness.snapshot(IntakeLedgerDoc, ctx);
  if (ledger?.requests?.some((r) => r.id === v.requestId)) {
    log(`requestId ${v.requestId} already handled — no new submission`);
    // The message used to be just `duplicate:true`, which left a caller unable to tell "GitHub redelivered"
    // (ignore it) from "this issue was aborted and you cannot retry it by re-labeling" (#226). Name the
    // supported verb in the body, because that is the only surface the caller reads.
    return {
      status: 200,
      body: {
        accepted: true,
        duplicate: true,
        conversationId: ledger.entries[key] ?? null,
        hint:
          "This requestId was already handled, so nothing was submitted. If the issue's previous run was aborted or " +
          'exhausted and you mean to dispatch it again, re-applying the label will never work: an issue has one constant ' +
          `requestId (issue-<n>) per instance store. Use POST /factory/intake/reopen {"issueNumber":${subjectNumber(
            v.subject,
          )},"reason":"what changed"} (#226), which records a new requestId and leaves the budget ledger alone.`,
      },
    };
  }

  // Find-or-create the conversation for this (kind, subject) — unless a reopen deliberately wants a clean
  // transcript (`forceNewConversation` above), or the kind's own policy says this submission IS a new attempt
  // (#235, `CONVERSATION_POLICY`).
  const priorRequestId = lastRequestIdFor(ledger ?? undefined, key);
  const policyWantsFresh =
    CONVERSATION_POLICY[v.kind] === "per-attempt" &&
    ledger?.entries?.[key] !== undefined &&
    priorRequestId !== undefined &&
    priorRequestId !== v.requestId;
  if (policyWantsFresh) {
    log(
      `${v.kind} ${v.subject}: requestId changed (${priorRequestId} → ${v.requestId}) — per-attempt kind, so this opens a fresh conversation (#235). ` +
        "Use POST /factory/intake/reopen when the new attempt also needs budget authorization.",
    );
  }
  const forceFresh = Boolean(policy.forceNewConversation) || policyWantsFresh;
  let conversationId = forceFresh ? undefined : ledger?.entries?.[key];
  const supersededConversationId = forceFresh ? ledger?.entries?.[key] : undefined;
  let created = false;
  let conv = conversationId ? await harness.conversation(conversationId as never, ctx) : undefined;
    if (!conv) {
      if (conversationId) {
        // The ledger pointed at a conversation that no longer exists (store pruned/restored). Drop the
        // pointer so the replacement is recorded, rather than failing every later event for this subject.
        log(`ledger entry ${key} → ${conversationId} is gone; opening a replacement conversation`);
        await harness.commit(async (tx) => {
          const d = await tx.doc(IntakeLedgerDoc);
          delete d.entries[key];
        }, ctx);
      }
      const fresh = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          // Capability scoping happens here, at creation: `tools` replaces the conversation's tool set,
          // so a refinement conversation is not merely told to behave — it cannot call delegate.
          agent: {
            model: { provider: opts.modelRef.provider, modelId: opts.modelRef.modelId },
            thinkingLevel: "medium",
            tools: spec.tools as never,
            instructions: spec.instructions,
          },
          init: async (tx, id) => {
            const d = await tx.doc(ConversationMeta, id);
            d.name = `intake ${key}`;
            d.createdAt = Date.now();
          },
        },
        ctx,
      );
      conversationId = fresh.id as unknown as number;
      created = true;
      conv = fresh;
      await harness.commit(async (tx) => {
        const d = await tx.doc(IntakeLedgerDoc);
        d.entries[key] = conversationId!;
        // Same commit as the pointer, on purpose — see IntakeLedgerDoc.lastRequest (#235).
        d.lastRequest = { ...d.lastRequest, [key]: v.requestId };
      }, ctx);
      log(`opened ${v.kind} conversation ${conversationId} for ${v.subject} (${spec.tools.length} tool(s))`);
    }

  // Submit with the caller's requestId: if this delivery is a redelivery that arrived before our
  // ledger write (or after a crash between the two commits), the core settles it as a duplicate.
  let submissionId: number | undefined;
  try {
    const sub = await conv.submit({ type: "input", content: v.content, requestId: v.requestId }, ctx);
    submissionId = sub.id as number;
  } catch (e) {
    log(`submission failed for ${key}: ${(e as Error).message}`);
    return { status: 500, body: { error: `submission failed: ${(e as Error).message}` } };
  }

  // Counted BEFORE the ledger write below: a snapshot implementation that hands back a live document reference
  // (as the test fake does) would otherwise make this submission count itself, and an off-by-one here is exactly
  // the kind of number an operator would believe.
  const reusedConversationInfo =
    !created && conversationId !== undefined
      ? {
          id: conversationId,
          priorRequestId: priorRequestId ?? null,
          attemptsRecorded: attemptsOn(ledger ?? undefined, key, conversationId) + 1,
        }
      : undefined;

  await harness.commit(async (tx) => {
    const d = await tx.doc(IntakeLedgerDoc);
    d.entries[key] = conversationId!;
    d.lastRequest = { ...d.lastRequest, [key]: v.requestId };
    d.requests = [...d.requests.filter((r) => r.id !== v.requestId), { id: v.requestId, key, conversationId: conversationId!, at: Date.now() }];
    if (d.requests.length > REQUEST_TAIL) d.requests = d.requests.slice(-REQUEST_TAIL);
  }, ctx);

  // #235: writing into an existing transcript is now visible at request time. `created:false` used to be the only
  // signal, which is how a probe landed in a conversation whose last run had been aborted and nobody noticed until
  // reading the log days later. Deliberately NOT an outcome classification: deciding "was the last run aborted?"
  // means reading pi-durable task stores across instances, and that reader belongs to the settlement gates (#204),
  // not inside a request path.
  return {
    status: 202,
    body: {
      accepted: true,
      conversationId,
      created,
      submissionId,
      ...(supersededConversationId ? { supersededConversationId } : {}),
      ...(reusedConversationInfo ? { reusedConversation: reusedConversationInfo } : {}),
    },
  };
}

/** Pull the bare issue number out of an intake subject ("#226" → 226) for use in a hint. Undefined-safe. */
function subjectNumber(subject: string): number | undefined {
  const m = /(\d+)/.exec(String(subject ?? ""));
  return m ? Number(m[1]) : undefined;
}

/**
 * The factory's intake route. Registered via `createCoreInstance({ routes: [...] })`; the kernel's auth
 * gate runs before any app route, so this is bearer-authenticated like `/tasks`.
 *
 * Body: `{ kind, subject, requestId, content }` → 202 `{ accepted, conversationId, created }`, or
 * 200 `{ accepted, duplicate: true, conversationId, hint }` when this exact requestId was already handled.
 * When an existing conversation is reused the response also carries `reusedConversation` (prior requestId + how
 * many attempts it already holds); when one is superseded it carries `supersededConversationId` (#235).
 */
export function createIntakeRoute(opts: IntakeRouteOptions): AppRoute {
  const log = opts.log ?? ((m) => console.log(`[factory] ${opts.repo}: intake — ${m}`));

  return {
    method: "POST",
    path: "/factory/intake",
    async handle(req, res, rctx: RouteContext) {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        rctx.json(res, 400, { error: `body must be JSON: ${(e as Error).message}` });
        return;
      }

      const v = validateIntakeBody(body);
      if (!v.ok) {
        log(`rejected (${v.status}): ${v.error}`);
        rctx.json(res, v.status, { error: v.error });
        return;
      }

      const result = await dispatchIntake(opts, v, rctx, log);
      rctx.json(res, result.status, result.body);
    },
  };
}
