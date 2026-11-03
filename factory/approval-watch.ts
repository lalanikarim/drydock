// Approval-block watchdog (#188).
//
// Why this exists. During the first cross-repo run (engram #63, 2026-11-03) a reviewer finished its analysis,
// called `submit_verdict`, and the harness refused: the call needed a human approval. Nothing said so. The run
// sat waiting ~40 minutes with `/health` green, no alert, and a durable store that read
// `reviewer never called submit_verdict` — which blames the model for what the policy did. Meanwhile the answer
// was one command away (`POST /approvals/:key {"decision":"approved"}`), and the instance had been publishing it
// on `GET /approvals` the entire time.
//
// So this module asks an endpoint that already exists, on an interval, and turns a new pending key into one
// alert naming the key. It is deliberately NOT a pipeline change:
//
//   - The pipeline cannot see its own block cheaply. A gated tool never runs, so no factory code executes; the
//     reviewer's conversation handle exposes submit/configure/abort/waitForIdle and no transcript read; and
//     reading kernel-internal docs across the boundary is exactly the coupling we have been removing. The
//     instance's HTTP surface is public, documented, bearer-gated, and already proven in production.
//   - The adapter is where a fleet-wide "who is waiting on a human?" question belongs anyway: it holds every
//     route's base URL and token, it already runs an interval probe with edge alerts (#133), and it survives
//     individual repos being down — which the quarantining work (#185) made explicit.
//
// Deliberate limits, stated rather than discovered later:
//   - **Alert once per key per process.** A pending approval is a standing condition, not a transition; nagging
//     every interval is how operators mute alerts. If the same key reappears after being decided, that is a new
//     block by definition and a restart of the adapter will announce it again.
//   - **Never throw.** This runs beside webhook serving; a defective poll must degrade to a logged failure.
//   - **No acting on approvals.** Reading is fine; deciding belongs to a human typing a POST.

import { readFileSync, existsSync } from "node:fs";

import type { Notifier } from "./notify-telegram.ts";

export type ApprovalWatchTarget = { repo: string; target: string; token?: string };

export type PendingApproval = { key: string; tool: string; tier?: string };

export type WatchResult = {
  /** Targets polled successfully (HTTP 2xx with a parseable body). */
  checked: number;
  /** `repo: reason` for every target we could not read — silence here would look like "nothing pending". */
  failures: string[];
  /** Keys newly announced by this pass. */
  alerted: string[];
  /** Total pending approvals seen across healthy targets this pass. */
  pending: number;
};

/** Parse one instance's `GET /approvals` body defensively: junk degrades to "no news", never to a crash. */
export function parseApprovalsBody(payload: unknown): PendingApproval[] {
  const items = (payload as { approvals?: unknown } | null)?.approvals;
  if (!Array.isArray(items)) return []; // a shape we don't recognize is NOT "zero pending" — callers track the fetch result separately
  const out: PendingApproval[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    // A keyless entry cannot be approved, so alerting on it would send the operator a message they cannot act
    // on. Skip it rather than render "waiting on approval undefined".
    if (typeof e.key !== "string" || !e.key) continue;
    out.push({
      key: e.key,
      tool: typeof e.tool === "string" ? e.tool : "unknown",
      ...(typeof e.tier === "string" ? { tier: e.tier } : {}),
    });
  }
  return out;
}

export interface ApprovalWatcherOptions {
  /** Re-read on every pass: routes gain/lose targets as instances restart or are quarantined. */
  targets: () => ApprovalWatchTarget[];
  notify?: Notifier;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

export class ApprovalWatcher {
  private readonly opts: Required<Pick<ApprovalWatcherOptions, "log" | "fetchImpl" | "intervalMs">> & ApprovalWatcherOptions;
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: ApprovalWatcherOptions) {
    this.opts = {
      log: () => {},
      fetchImpl: fetch,
      intervalMs: 60_000,
      ...opts,
    } as typeof this.opts;
  }

  /** One pass over every served repo. Never rejects. */
  async check(): Promise<WatchResult> {
    const result: WatchResult = { checked: 0, failures: [], alerted: [], pending: 0 };
    for (const t of this.opts.targets() ?? []) {
      if (!t?.target) continue;
      try {
        const res = await this.opts.fetchImpl(`${t.target.replace(/\/$/, "")}/approvals`, {
          headers: t.token ? { authorization: `Bearer ${t.token}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          // A repo we cannot read is not a repo with nothing pending. Name it, every pass it fails.
          result.failures.push(`${t.repo}: HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as unknown;
        const items = parseApprovalsBody(body);
        result.checked += 1;
        result.pending += items.length;
        for (const a of items) {
          const id = `${t.repo}/${a.key}`;
          if (this.seen.has(id)) continue;
          this.seen.add(id);
          result.alerted.push(a.key);
          this.opts.log(`${t.repo}: approval pending ${a.key} (${a.tool}${a.tier ? `, ${a.tier}` : ""})`);
          await this.opts.notify?.({ kind: "approval_blocked", repo: t.repo, key: a.key, tool: a.tool, ...(a.tier ? { tier: a.tier } : {}) });
        }
      } catch (e) {
        result.failures.push(`${t.repo}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  start(): void {
    if (this.timer) return;
    // Fire once immediately: a fleet that restarts into a pending approval should say so now, not after an
    // interval, and "waiting on you" is exactly the state most likely to survive a deploy.
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Build the watcher for a running adapter.
 *
 * Targets come from the routes FILE, re-read every pass — not from the adapter's in-memory route array. That
 * distinction was found by deploying this and watching it alert about nothing: in-memory `target` values are only
 * adopted by the per-request drift check (#81), so on an idle adapter (no webhooks arriving) a freshly started
 * instance's port never appears there, and "nobody is waiting on you" would have been reported for a fleet where
 * four approvals were pending. Reading the file also gets quarantine markers (#185) for free.
 */
export function buildApprovalWatcher(
  routesFile: string,
  opts: { notify?: Notifier; log?: (line: string) => void; intervalMs?: number } = {},
): ApprovalWatcher {
  return new ApprovalWatcher({
    targets: () => readRoutesForWatch(routesFile),
    notify: opts.notify,
    log: opts.log,
    intervalMs: opts.intervalMs ?? Number(process.env.APPROVAL_WATCH_INTERVAL_MS ?? 60_000),
  });
}

/** Defensive read: a missing or half-written file yields no targets, never an exception. */
export function readRoutesForWatch(routesFile: string): ApprovalWatchTarget[] {
  try {
    if (!existsSync(routesFile)) return [];
    const parsed = JSON.parse(readFileSync(routesFile, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.repo === "string" && typeof r.target === "string")
      .map((r) => ({ repo: r.repo as string, target: r.target as string, ...(typeof r.token === "string" ? { token: r.token as string } : {}) }));
  } catch {
    return [];
  }
}
