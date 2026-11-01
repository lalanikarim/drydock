#!/usr/bin/env node
// Re-drive webhook deliveries GitHub already gave up on (#107, layer 2).
//
// The premise this tool exists on, stated because it contradicts an assumption we ran with for weeks:
// **GitHub does not automatically redeliver failed webhook deliveries**
// (https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries). A 503 from a
// mid-change adapter, a timeout while the laptop slept, a funnel blip — each is recorded once and then
// never attempted again. Two real issue dispatches were lost that way during #107.
//
// So failed deliveries are operator-repaired state, like a queue with no consumer. This walks the hook's
// delivery log and re-POSTs the attempts. Run it on a schedule (cron, a launchd job, or by hand after
// any supervisor restart) — an interval is what turns "we can recover" into "we do".
//
// Policy refusals are NOT in scope and cannot accidentally be swept: they answer 200/403, so GitHub
// records them as `OK` and this tool never sees them. What shows up here is infrastructure failure only.
//
//   node fleet/redeliver-failed.mjs --repo owner/repo --hook <id>              # report only (default)
//   node fleet/redeliver-failed.mjs --repo owner/repo --hook <id> --apply      # re-POST each one
//   …--since 2026-11-01T00:00:00Z                                             # bound the window
//
// Auth: GITHUB_TOKEN / GH_TOKEN, else `gh auth token`.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const API = "https://api.github.com";

/** Token resolution mirrors the factory's posture: env first, then the gh CLI helper. */
export function resolveToken(env = process.env) {
  const t = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
  if (t) return t;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Which deliveries need re-driving.
 *
 * GitHub's delivery records mark success with `status: "OK"` and put the reason elsewhere for failures
 * (`Invalid HTTP Response: 503`, `timeout`, `server_error`, …). Anything not OK is a candidate — including
 * records whose `response_code` is null because the connection never completed.
 */
export function selectFailedDeliveries(rows, { since = null, skip = [] } = {}) {
  const skipSet = new Set(skip.map((x) => String(x)));
  const sinceMs = since ? Date.parse(since) : null;
  if (Number.isNaN(sinceMs ?? NaN) && since) throw new Error(`--since is not a valid timestamp: ${since}`);
  return (rows ?? [])
    .filter((d) => d && String(d.status ?? "").toUpperCase() !== "OK")
    .filter((d) => !(skipSet.has(String(d.id))))
    .filter((d) => (sinceMs === null ? true : Date.parse(d.delivered_at ?? "") >= sinceMs))
    .sort((a, b) => String(a.delivered_at ?? "").localeCompare(String(b.delivered_at ?? "")));
}

/** Human summary, one line per distinct failure reason — the part an operator actually reads. */
export function summarize(rows) {
  const byReason = new Map();
  for (const d of rows ?? []) {
    const reason = String(d.status ?? "unknown");
    const entry = byReason.get(reason) ?? { count: 0, ids: [], events: new Set() };
    entry.count += 1;
    entry.ids.push(d.id);
    entry.events.add(d.event ?? "?");
    byReason.set(reason, entry);
  }
  return [...byReason.entries()].map(([reason, v]) => ({
    reason,
    count: v.count,
    ids: v.ids,
    events: [...v.events].sort(),
  }));
}

async function ghFetch(path, { token, method = "GET" } = {}) {
  // `path` is absolute when it came from a Link header (see listDeliveries) and relative otherwise.
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  const body = safeParse(text);
  // headers are part of the contract: this endpoint paginates with Link, not `page`.
  return { status: res.status, ok: res.ok, body: body, headers: res.headers ?? null };
}

/**
 * JSON parse that keeps oversized integer ids exact.
 *
 * Delivery ids are 19 digits (e.g. 3851475922366504960) — well past Number.MAX_SAFE_INTEGER, so a plain
 * JSON.parse rounds `…504960` to `…505000`. That is not cosmetic: the id is how you select a delivery and
 * how you address its redelivery attempt, so a rounded value silently targets nothing (or, worse, another
 * record). Found by live run — `--only <real id>` matched zero of 35 failures. Only oversized integers are
 * quoted; small ids and other numbers stay as they were.
 */
export function safeParse(text) {
  try {
    return JSON.parse(String(text).replace(/"id":\s*(\d{16,})/g, '"id":"$1"'));
  } catch {
    return { raw: String(text).slice(0, 200) };
  }
}

/** Parse RFC 5988 Link header into rel -> URL. */
export function parseLink(header) {
  const out = {};
  for (const part of String(header ?? "").split(",")) {
    const m = part.match(/\<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}



/**
 * Paginated delivery listing.
 *
 * This endpoint does **not** accept `page` — it answers 422 `"page" is not a permitted key` and paginates
 * with RFC 5988 `Link` rel="next" cursors instead (found by running it; the fake had accepted page=2
 * cheerfully, which is the usual story). So: one request per page, following the cursor the server hands
 * back, never synthesizing one.
 */
export async function listDeliveries({ repo, hookId, token, fetchImpl = ghFetch, maxPages = 10 } = {}) {
  const all = [];
  let next = `/repos/${repo}/hooks/${hookId}/deliveries?per_page=100`;
  for (let page = 1; next && page <= maxPages; page += 1) {
    const res = await fetchImpl(next, { token });
    if (!res.ok) throw new Error(`listing deliveries failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`);
    const rows = Array.isArray(res.body) ? res.body : [];
    all.push(...rows);
    next = parseLink(res.headers?.get?.("link") ?? res.headers?.link ?? null).next ?? null;
  }
  return all;
}

/**
 * Re-POST one delivery attempt. GitHub returns 202 when the redelivery is queued — accepted is not
 * delivered, so a sweep that reports success still needs its own re-check on the next run.
 */
export async function redeliver({ repo, hookId, deliveryId, token, fetchImpl = ghFetch }) {
  const res = await fetchImpl(`/repos/${repo}/hooks/${hookId}/deliveries/${deliveryId}/attempts`, { token, method: "POST" });
  return { deliveryId, ok: res.status === 202 || res.ok, status: res.status };
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = ghFetch, log = console.log } = {}) {
  const args = new Set(argv);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = opt("repo");
  const hookId = opt("hook");
  const since = opt("since") ?? null;
  // Surgical recovery: re-drive named ids only. Redelivering a whole window can resurrect work for
  // issues that were closed hours ago, so the default sweep is report-only and --apply is expected to
  // name what it touches. Comma-separated.
  const only = (opt("only") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const apply = args.has("--apply");

  if (!repo || !hookId) {
    log("usage: node fleet/redeliver-failed.mjs --repo owner/repo --hook <hook_id> [--since <ISO>] [--only <id,id>] [--apply]");
    return { code: 2, failed: [], applied: [] };
  }
  const token = resolveToken(env);
  if (!token) {
    log("no GitHub token: set GITHUB_TOKEN/GH_TOKEN or be logged in to gh");
    return { code: 2, failed: [], applied: [] };
  }

  const all = await listDeliveries({ repo, hookId, token, fetchImpl });
  let failed = selectFailedDeliveries(all, { since });
  if (only.length) {
    const keep = new Set(only.map(String));
    const skipped = failed.filter((d) => !keep.has(String(d.id))).length;
    failed = failed.filter((d) => keep.has(String(d.id)));
    log(`--only: keeping ${failed.length} of ${failed.length + skipped} failure(s)`);
  }
  log(`${all.length} delivery record(s) inspected; ${failed.length} not delivered${since ? ` since ${since}` : ""}`);
  for (const group of summarize(failed)) {
    log(`  ${group.reason}: ${group.count} (${group.events.join(", ")}) ids: ${group.ids.slice(0, 8).join(", ")}${group.ids.length > 8 ? " …" : ""}`);
  }

  if (!failed.length) return { code: 0, failed, applied: [] };

  if (!apply) {
    log("");
    log("DRY RUN — nothing re-driven. Re-run with --apply to POST delivery attempts.");
    log("  (A policy refusal is NOT listed here: those answer 2xx and GitHub records them as OK.)");
    return { code: 1, failed, applied: [] }; // nonzero so a scheduled run surfaces in mail/logs
  }

  const applied = [];
  for (const d of failed) {
    const r = await redeliver({ repo, hookId, deliveryId: d.id, token, fetchImpl });
    log(`  redeliver ${d.id} (${d.event}) -> HTTP ${r.status} ${r.ok ? "queued" : "FAILED"}`);
    applied.push(r);
  }
  const queued = applied.filter((a) => a.ok).length;
  log(`${queued}/${applied.length} redelivery attempt(s) queued. GitHub accepted != delivered — check again next run.`);
  return { code: applied.every((a) => a.ok) ? 0 : 1, failed, applied };
}

// Same direct-run test the supervisor uses: importing this module for tests must not fire a live sweep.
const isDirectRun = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[redeliver-failed] fatal: ${e.message}`);
    process.exit(1);
  });
}
