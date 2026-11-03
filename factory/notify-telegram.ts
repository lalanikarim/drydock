// Telegram operator notification (#64).
//
// Why this exists as its own module with a narrow event union: the factory's outcomes are already reported
// where the work happens (PR comments, audit log, durable task state). A notification is not a fourth copy of
// that — it is the one place an operator learns "a draft PR now exists" or "this run stopped instead of
// finishing" without polling GitHub. So the events are exactly the moments where silence costs something.
//
// Three properties this file is responsible for:
//
// 1. **It must never break a run.** Every entry point swallows its own failures and logs them. A dead bot
//    token cannot be allowed to fail a pull request that passed verification and review.
// 2. **The token must never reach a log line or an error message.** Telegram's API takes the bot token in the
//    URL path, so any naive `fetch` error string can contain it. Requests are built through a redactor and
//    every thrown value is scrubbed before it is logged.
// 3. **Node's fetch resets connections where curl succeeds on this host** (observed live while verifying the
//    bot credentials, 2026-11-01: `ECONNRESET` from `fetch`, 200 from `curl` with the same body). Connection
//    errors are therefore retried — but only connection errors and 5xx/429, never a 4xx that will fail
//    identically forever.

/** Telegram hard limit on message length. */
export const TELEGRAM_MAX_MESSAGE = 4096;

/** What may be announced. Deliberately small: anything else belongs in the PR comment or the audit log. */
export type NotifyEvent =
  | {
      kind: "pr_opened";
      repo: string;
      issueNumber: number;
      prNumber?: number | null;
      prUrl: string;
      head?: string | null;
      verification?: { ran: boolean; passed?: boolean; exitCode?: number | null };
    }
  | {
      kind: "run_stopped";
      repo: string;
      issueNumber: number;
      reason: string;
      detail?: string;
    }
  | {
      kind: "refine_posted";
      repo: string;
      issueNumber: number;
      commentUrl?: string | null;
    }
  | {
      /**
       * Infrastructure alert, not per-issue (#133). The fleet had no way to say "the inference host is down"
       * and needed an outage to discover that; this is the event that makes the edge audible. `detail` must be
       * operator-safe text — reasons and counts, never keys or URLs with credentials.
       */
      kind: "inference_state";
      state: "reachable" | "degraded" | "unreachable" | "unknown";
      reachable: number;
      total: number;
      detail?: string;
    }
  | {
      /**
       * A repo stopped being supervised (#185): its boot failures exhausted the restart budget, so the
       * supervisor quarantined THAT repo and kept its siblings serving. Before that change one bad config
       * key in one repo was a fleet-wide kill switch, and the component best placed to report it (the
       * adapter) was killed as part of the outage.
       *
       * `reason` must be operator-safe text — the child's last fault line, never a token. Quarantine is
       * sticky within a supervisor process, so this fires once per repo; see notifyEventKey.
       */
      kind: "repo_quarantined";
      repo: string;
      attempts: number;
      reason: string;
    }
  | {
      /**
       * A run is waiting on a human (#188). Before this, an approval block looked identical to an agent
       * failure — `reviewer never called submit_verdict` — and got retried, which cannot help: the same call
       * produces the same block, and because the key is `sha1(tool + exact args)` a reworded retry produces a
       * DIFFERENT key nobody approved. The message therefore has to carry the key, because the key is the fix.
       */
      kind: "approval_blocked";
      repo: string;
      key: string;
      tool: string;
      tier?: string;
    };

const SHORT = (s: string | null | undefined, n = 9): string => (s ? String(s).slice(0, n) : "");

/** One-line, plain-text message for an event. No parse_mode is used anywhere, so no escaping is needed. */
export function renderNotifyMessage(e: NotifyEvent): string {
  // Infrastructure events (inference_state) have no repo — prefixing one would print "undefined:".
  const name = "repo" in e ? (e.repo.includes("/") ? e.repo.split("/")[1] : e.repo) : "";
  switch (e.kind) {
    case "pr_opened": {
      const v = e.verification;
      const tests = !v?.ran ? "tests not run" : v.passed ? "tests pass" : `tests exit ${v.exitCode ?? "?"}`;
      const pr = e.prNumber ? `PR #${e.prNumber}` : "a PR";
      return `${name}: draft ${pr} opened for issue #${e.issueNumber} (${tests}${e.head ? `, head ${SHORT(e.head)}` : ""}) ${e.prUrl}`.trim();
    }
    case "run_stopped": {
      const detail = e.detail ? ` — ${e.detail}` : "";
      return `${name}: run stopped for issue #${e.issueNumber}: ${e.reason}${detail}`;
    }
    case "inference_state": {
      const detail = e.detail ? ` — ${e.detail}` : "";
      return `factory: inference ${e.state} (${e.reachable}/${e.total} endpoint(s))${detail}`.trim();
    }
    case "refine_posted": {
      return `${name}: refinement brief posted on issue #${e.issueNumber}${e.commentUrl ? ` ${e.commentUrl}` : ""}`.trim();
    }
    case "repo_quarantined": {
      return `factory: ${name} quarantined after ${e.attempts} failed boots — ${e.reason}. Its deliveries are refused with 503; siblings unaffected`.trim();
    }
    case "approval_blocked": {
      // Imperative, and it names the exact command: an operator who wants to unblock this should not have to
      // look up the endpoint while a run is idle and inference is being wasted.
      return `${name}: waiting on approval ${e.key} (${e.tool}${e.tier ? `, ${e.tier}` : ""}) — POST /approvals/${e.key} {"decision":"approved"}`.trim();
    }
  }
}

/** Truncate to Telegram's limit without cutting a URL in half — the link is the useful part. */
export function clampMessage(text: string, limit = TELEGRAM_MAX_MESSAGE): string {
  if (text.length <= limit) return text;
  const urlMatch = text.match(/(?:https?:\/\/\S+)$/);
  if (urlMatch && urlMatch.index !== undefined) {
    const url = urlMatch[0];
    const glue = " … ";
    // Keep the whole URL: a notification whose link is cut in half has lost the only part worth reading.
    if (url.length + glue.length < limit - 40) {
      const head = text.slice(0, limit - url.length - glue.length).trimEnd();
      const out = `${head}${glue}${url}`;
      return out.length <= limit ? out : `${out.slice(0, limit - 1)}…`;
    }
  }
  return `${text.slice(0, limit - 1)}…`;
}

function isRetryableError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  const name = (e as { name?: string })?.name ?? "";
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "TypeError"].includes(code) || name === "TypeError";
}

/**
 * `messageId` is Telegram's own id for the delivered message. It exists so "the alert was sent" is an auditable
 * claim in a log line rather than an inference from silence — before it, only failures were logged, so a healthy
 * fleet and a mis-configured bot looked identical from the operator's side.
 */
const TELEGRAM_API_DEFAULT = "https://api.telegram.org";

/**
 * Resolve the Telegram Bot API base.
 *
 * The override exists so an operator can prove the alert path delivers — against a local stand-in, on demand —
 * instead of waiting for an outage or trusting a green suite about someone else's HTTP API. It is loud by
 * construction: a redirected alert channel that reports success into a void is worse than no channel, because
 * the entire value of this code is that somebody finds out.
 */
export function resolveTelegramApiBase(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = () => {},
): string {
  const raw = env.TELEGRAM_API_BASE?.trim();
  if (!raw) return TELEGRAM_API_DEFAULT;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    log(`telegram transport override ignored — TELEGRAM_API_BASE is not a valid URL (${raw.slice(0, 80)})`);
    return TELEGRAM_API_DEFAULT;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    log(`telegram transport override ignored — only http/https allowed (got ${parsed.protocol})`);
    return TELEGRAM_API_DEFAULT;
  }
  const base = parsed.toString().replace(/\/+$/, "");
  log(`⚠ telegram transport overridden → ${base} (TELEGRAM_API_BASE): alerts are NOT reaching the operator's chat`);
  return base;
}

export type SendResult = { ok: boolean; status?: number; detail?: string; attempts: number; messageId?: number };

/**
 * POST one message to the Telegram Bot API. Retries connection errors, 429 (honouring `retry_after`) and 5xx;
 * gives up immediately on other 4xx, which will fail identically forever.
 *
 * Never throws: a notification failure is data for the log, not an error to propagate into a run. Every value
 * that leaves this function has the token removed.
 */
export async function sendTelegramMessage(
  text: string,
  opts: {
    token: string;
    chatId: string;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    log?: (line: string) => void;
    /** Bot API base. Defaults to api.telegram.org; see `resolveTelegramApiBase`. */
    apiBase?: string;
  },
): Promise<SendResult> {
  const log = opts.log ?? (() => {});
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;
  const message = clampMessage(text);
  const redact = (s: string) => (opts.token ? s.split(opts.token).join("[token]") : s);

  if (!opts.token || !opts.chatId) {
    return { ok: false, detail: "telegram not configured (missing bot token or chat id)", attempts: 0 };
  }

  let lastDetail = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const base = (opts.apiBase ?? TELEGRAM_API_DEFAULT).replace(/\/+$/, "");
      const res = await doFetch(`${base}/bot${opts.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: opts.chatId, text: message, disable_web_page_preview: true }),
      });
      if (res.ok) {
        // Parse but never depend on the body: a 200 with an unexpected shape is still a delivered message, and
        // losing the id must not turn a success into a failure.
        let messageId: number | undefined;
        try {
          const body = (await res.json()) as { result?: { message_id?: unknown } };
          const id = body?.result?.message_id;
          if (typeof id === "number" && Number.isFinite(id)) messageId = id;
        } catch {
          /* no parseable body — fine, we just cannot quote an id */
        }
        return { ok: true, status: res.status, attempts: attempt, ...(messageId !== undefined ? { messageId } : {}) };
      }

      const body = await res.text().catch(() => "");
      lastDetail = redact(`${res.status} ${body.slice(0, 180)}`.trim());

      // 429 carries the required back-off in the payload; ignoring it just burns the retry budget.
      if (res.status === 429) {
        let waitMs = 1000 * attempt;
        try {
          const j = JSON.parse(body) as { parameters?: { retry_after?: number } };
          if (typeof j?.parameters?.retry_after === "number") waitMs = Math.min(30_000, (j.parameters.retry_after + 1) * 1000);
        } catch {
          /* body wasn't JSON; fall back to linear backoff */
        }
        log(`telegram rate limited, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
        await sleep(waitMs);
        continue;
      }

      if (res.status >= 500) {
        log(`telegram ${res.status}, retrying (attempt ${attempt}/${maxAttempts})`);
        await sleep(500 * attempt);
        continue;
      }
      // 4xx other than 429: bad token, bad chat id, blocked bot. Retrying cannot help.
      return { ok: false, status: res.status, detail: lastDetail, attempts: attempt };
    } catch (e) {
      lastDetail = redact(e instanceof Error ? `${e.name} ${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}` : String(e));
      if (!isRetryableError(e)) return { ok: false, detail: lastDetail, attempts: attempt };
      log(`telegram connection error (${lastDetail}), retrying (attempt ${attempt}/${maxAttempts})`);
      await sleep(500 * attempt);
    }
  }
  return { ok: false, detail: lastDetail, attempts: maxAttempts };
}

/**
 * A key per event so a retried path cannot spam the same line.
 *
 * Every kind must be named here. The previous shape ended in an unconditional `run_stopped:…` fallback, which
 * meant `inference_state` inherited a key built from fields it does not have — `run_stopped:undefined:undefined:
 * undefined` for every inference alert, whatever its state. Effect: the first alert of any kind muted every
 * other inference alert for the whole dedupe window, so an operator who was told "inference unreachable" was
 * never told it recovered (#133). A catch-all key is not a default; it is a collision waiting for the next kind.
 */
export function notifyEventKey(e: NotifyEvent): string {
  switch (e.kind) {
    case "pr_opened":
      return `pr_opened:${e.repo}:${e.issueNumber}:${e.prUrl}`;
    case "refine_posted":
      return `refine_posted:${e.repo}:${e.issueNumber}`;
    case "run_stopped":
      // Reason is part of the identity: an issue stopped twice for two different reasons is two news items.
      return `run_stopped:${e.repo}:${e.issueNumber}:${e.reason}`;
    case "inference_state":
      // The state IS the event — an outage and its recovery are different messages, and a fleet that went from
      // 1/2 to 0/2 is news again.
      return `inference_state:${e.state}:${e.reachable}/${e.total}`;
    case "repo_quarantined":
      // Deliberately NOT keyed by reason or attempt count: quarantine is sticky (nothing lifts it inside a
      // process lifetime), so a repeat would be the same news re-worded. Two repos quarantining IS two news
      // items, which is why repo is in the key — and a supervisor that dies and re-quarantines the same repo
      // starts a fresh dedupe table, which is correct: that is a second outage.
      return `repo_quarantined:${e.repo}`;
    case "approval_blocked":
      // Keyed by the approval key itself: one block, one message. A different blocked call is a different key
      // (keys are content hashes), so it is genuinely separate news; the same key again is the same standing
      // condition and must not nag.
      return `approval_blocked:${e.repo}:${e.key}`;
    default: {
      // Unreachable while NotifyEvent is exhaustive. Structurally keyed so a future kind cannot silently share
      // another's dedupe window; it also keeps this function total, because a notification defect must never
      // throw into the code path that just merged something.
      const exotic = e as unknown as { kind?: string };
      return `unkeyed:${exotic?.kind ?? "event"}:${JSON.stringify(exotic)}`;
    }
  }
}

export type Notifier = (e: NotifyEvent) => Promise<void>;

/**
 * A notifier that never rejects and announces each event at most once per window. Returns undefined when the
 * credentials are absent, so callers keep "notifications disabled" as an explicit state instead of a silently
 * no-oping function that looks like it worked.
 */
export function createNotifier(opts: {
  token?: string;
  chatId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  /** Cap on inference state edges announced per `windowMs` before going quiet (flap guard). */
  maxInferenceEdges?: number;
  log?: (line: string) => void;
  env?: Record<string, string | undefined>;
}): Notifier | undefined {
  const log = opts.log ?? (() => {});
  if (!opts.token || !opts.chatId) return undefined;
  // Resolved once, loudly if overridden: an operator who sets this for a drill must not be able to forget it.
  const apiBase = resolveTelegramApiBase(opts.env ?? process.env, log);
  const seen = new Map<string, number>();
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;

  /**
   * Inference alerts dedupe by EDGE, not by time window — and the difference is a missed recovery.
   *
   * The generic path below suppresses a key for `windowMs` after announcing it. For per-issue events that is
   * right (a retried tool call should not ping twice). For inference state it is wrong: a fleet that started
   * healthy, went down, and came back announces `reachable:2/2` twice — once at boot and once as the recovery —
   * so with a time window the operator gets "inference unreachable" and never gets the all-clear. The prober
   * already fires only on transitions, so a second suppression by recency is what swallows the news.
   *
   * What the window was really protecting against is flapping, so that is what gets bounded here: edges are
   * announced while they are rare, and once they are not, we say so once and go quiet until it settles.
   */
  let lastInferenceKey: string | undefined;
  let inferenceEdges: number[] = [];
  let flapAnnounced = false;
  const MAX_INFERENCE_EDGES = opts.maxInferenceEdges ?? 6;

  return async (e: NotifyEvent) => {
    const key = notifyEventKey(e);
    const now = Date.now();

    if (e.kind === "inference_state") {
      if (lastInferenceKey === key) return; // the same state again is not an edge
      inferenceEdges = inferenceEdges.filter((t) => now - t < windowMs);
      if (inferenceEdges.length >= MAX_INFERENCE_EDGES) {
        if (!flapAnnounced) {
          flapAnnounced = true;
          log(`inference state flapping (${inferenceEdges.length} edges in ${Math.round(windowMs / 60000)} min) — suppressing further state alerts until it settles`);
        }
        return;
      }
      flapAnnounced = false;
      inferenceEdges.push(now);
      lastInferenceKey = key;
    } else {
      for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
      if (seen.has(key)) return;
      seen.set(key, now);
    }
    try {
      const res = await sendTelegramMessage(renderNotifyMessage(e), {
        token: opts.token!,
        chatId: opts.chatId!,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        apiBase,
        log,
      });
      if (res.ok) {
        // Success is logged too, with the id: "alerts are wired" becomes a claim backed by a line in the log.
        log(`telegram delivered ${String((e as { kind?: string }).kind ?? "event")} message_id=${res.messageId ?? "unreported"} attempts=${res.attempts}`);
      } else {
        log(`telegram notification not delivered (${res.detail ?? "unknown"}), attempts ${res.attempts}`);
      }
    } catch (e2) {
      // sendTelegramMessage already swallows; this is belt-and-braces so a future edit cannot throw into a run.
      log(`telegram notification threw: ${opts.token ? String(e2).split(opts.token).join("[token]") : String(e2)}`);
    }
  };
}
