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
    };

const SHORT = (s: string | null | undefined, n = 9): string => (s ? String(s).slice(0, n) : "");

/** One-line, plain-text message for an event. No parse_mode is used anywhere, so no escaping is needed. */
export function renderNotifyMessage(e: NotifyEvent): string {
  const name = e.repo.includes("/") ? e.repo.split("/")[1] : e.repo;
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
    case "refine_posted": {
      return `${name}: refinement brief posted on issue #${e.issueNumber}${e.commentUrl ? ` ${e.commentUrl}` : ""}`.trim();
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

export type SendResult = { ok: boolean; status?: number; detail?: string; attempts: number };

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
      const res = await doFetch(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: opts.chatId, text: message, disable_web_page_preview: true }),
      });
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };

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
      lastDetail = redact(e instanceof Error ? `${e.name} ${e.code ?? ""} ${e.message}` : String(e));
      if (!isRetryableError(e)) return { ok: false, detail: lastDetail, attempts: attempt };
      log(`telegram connection error (${lastDetail}), retrying (attempt ${attempt}/${maxAttempts})`);
      await sleep(500 * attempt);
    }
  }
  return { ok: false, detail: lastDetail, attempts: maxAttempts };
}

/** A key per event so a retried path cannot spam the same line. */
export function notifyEventKey(e: NotifyEvent): string {
  if (e.kind === "pr_opened") return `pr_opened:${e.repo}:${e.issueNumber}:${e.prUrl}`;
  if (e.kind === "refine_posted") return `refine_posted:${e.repo}:${e.issueNumber}`;
  return `run_stopped:${e.repo}:${e.issueNumber}:${e.reason}`;
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
  log?: (line: string) => void;
}): Notifier | undefined {
  const log = opts.log ?? (() => {});
  if (!opts.token || !opts.chatId) return undefined;
  const seen = new Map<string, number>();
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;

  return async (e: NotifyEvent) => {
    const key = notifyEventKey(e);
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
    if (seen.has(key)) return;
    seen.set(key, now);
    try {
      const res = await sendTelegramMessage(renderNotifyMessage(e), {
        token: opts.token!,
        chatId: opts.chatId!,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log,
      });
      if (!res.ok) log(`telegram notification not delivered (${res.detail ?? "unknown"}), attempts ${res.attempts}`);
    } catch (e2) {
      // sendTelegramMessage already swallows; this is belt-and-braces so a future edit cannot throw into a run.
      log(`telegram notification threw: ${opts.token ? String(e2).split(opts.token).join("[token]") : String(e2)}`);
    }
  };
}
