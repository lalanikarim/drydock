/**
 * Settlement ledger (#161) — count work that was accepted and produced nothing.
 *
 * Why this reads sqlite instead of an API: the core exposes `POST /tasks` but no task listing, and its `/health`
 * says `{"status":"ok"}` regardless of what settled how. The only place a settlement exists is the durable store —
 * same reason `gates/backup-drill.mjs` reads it. Every query here runs **read-only** (`file:…?mode=ro`), so this
 * module cannot be the thing that corrupts a store while reporting on one.
 *
 * ## The two tables, and why both are needed
 *
 * `tasks` carries an outcome object; `submissions` carries the intake unit's fate. They answer different questions:
 * a task can `faulted` (our code threw) while its submission is still `done`, and — the shape #133 was filed
 * about — a submission can settle `unanswered` because no model ever answered it. Counting only tasks misses the
 * exact failure that motivated this; counting only submissions misses crashes that never reached an answer.
 *
 * ## Contracts verified against production stores on 2026-11-03 (do not "tidy" these)
 *
 * - **Text columns are JSON-encoded.** `tasks.kind` and `documents.kind` store `"factory.worker"` *with quotes*.
 *   `where kind = 'factory.worker'` matches nothing, and a counter built on that reports a clean fleet forever.
 *   Everything here goes through `json_extract(col, '$')`.
 * - **`record.$.state.status` is the state machine, not the result.** It reads `terminal` for all 655 rows in the
 *   drydock store — failures included. The outcome is `record.$.state.outcome.status`.
 * - **`submissions.status ∈ {queued, placed, done, unanswered}`**, and an `unanswered` record carries
 *   `record.$.reason` (all four present in production read `aborted`). That reason is the classification key:
 *   `no_model` is the shape #133 described and must never be merged into "the operator stopped it".
 * - **ids come from one shared allocator** (`record_ids`, 1544 rows spanning conversations, entries, tasks,
 *   submissions, documents). Task ids are therefore sparse (655 tasks below id 1543) but strictly monotone per
 *   store — which makes "highest id seen" a sound watermark and `count(*)`-vs-`max(id)` a meaningless sanity check.
 * - **Nothing is timestamped except task records.** `entries.record` and `submissions.record` have no time field,
 *   so a submission's age cannot be reported honestly; the ledger reports ids and reasons, and takes "when" only
 *   from `tasks.$.endedAt`. Inventing a timestamp for submissions would be worse than omitting it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SettlementClass =
  | "completed"   // produced an answer/result
  | "failing"     // failed or faulted — the alarming bucket
  | "aborted"     // operator/other abort; reported, never alarmed (#141 design)
  | "restarted"   // reclaimed by a restart (abortReason "restart"); churn, not an incident
  | "unanswered"  // accepted work that no model answered — the #133 shape, alarms unless aborted
  | "unsettled";  // queued/placed: still open, or wedged forever

export type SettlementRow = {
  store: string;
  table: "task" | "submission";
  id: number;
  kind: string | null;
  status: string;
  cls: SettlementClass;
  whenMs: number | null;
  detail: string;
};

export type SettlementSummary = {
  storesScanned: number;
  rowsExamined: number;
  counts: Record<SettlementClass, number>;
  /** `factory.*` is the work this fleet owns; `kernel.*` is pi.generation/pi.tool noise nested inside it. */
  byFamily: Record<"factory" | "kernel", Record<SettlementClass, number>>;
  alarms: SettlementRow[];
  samples: SettlementRow[];
  /** False when no store was readable — "not collected" must never render as "passing" (AGENTS.md R6b/R10). */
  collected: boolean;
};

const ALARMING: ReadonlySet<SettlementClass> = new Set(["failing", "unanswered"]);
const DETAIL_MAX = 220;

/** Strip the JSON encoding off a text column value and keep it short enough to print. */
function clean(s: unknown): string {
  if (typeof s !== "string") return "";
  let out = s.trim();
  if (out.startsWith('"') && out.endsWith('"') && out.length > 1) {
    try {
      const parsed = JSON.parse(out);
      if (typeof parsed === "string") out = parsed;
    } catch {
      /* leave as-is; a malformed value is still worth printing */
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function truncate(s: string): string {
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/**
 * One place decides what a settlement means. The rules are ordered, and the order is load-bearing: an aborted task
 * whose abortReason is `restart` is fleet churn, while an aborted task with no reason is either an operator using
 * the #141 verb or something we cannot explain — both go to `aborted`, which is reported but never alarmed,
 * because charging a human's stop to an incident counter trains everyone to mute the counter.
 */
export function classifyTask(outcomeStatus: string, abortReason: string): SettlementClass {
  const s = clean(outcomeStatus).toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed" || s === "faulted") return "failing";
  if (s === "aborted") return clean(abortReason).toLowerCase() === "restart" ? "restarted" : "aborted";
  // Anything else — including an empty outcome on a terminal row — is alarming rather than completed. An unknown
  // shape in the one column we aggregate is exactly when reporting success is most expensive.
  return "failing";
}

export function classifySubmission(status: string, reason: string): SettlementClass {
  const s = clean(status).toLowerCase();
  if (s === "done") return "completed";
  if (s === "unanswered") return clean(reason).toLowerCase() === "aborted" ? "aborted" : "unanswered";
  if (s === "queued" || s === "placed") return "unsettled";
  return "failing";
}

/** Instance stores this fleet owns, discovered the same way `gates/backup-drill.mjs` finds them. */
export function discoverStores(root: string): Array<{ store: string; dbPath: string }> {
  return globSync(join(root, "factory-instances", "*", "engram-data", "agent.sqlite"))
    .map((p) => ({ store: p.split("/factory-instances/")[1]!.split("/")[0]!, dbPath: p }))
    .filter((s) => existsSync(s.dbPath))
    .sort((a, b) => a.store.localeCompare(b.store));
}

function queryJson(dbPath: string, sql: string): Array<Record<string, unknown>> {
  // `file:…?mode=ro` is the whole safety story: SQLITE_READONLY means a bug in this file cannot write to a store.
  const out = execFileSync("sqlite3", ["-batch", "-json", `file:${dbPath}?mode=ro`, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  try {
    const parsed = JSON.parse(out) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
  } catch (e) {
    throw new Error(`sqlite3 returned non-JSON output for a settlement query (${(e as Error).message}); first 120 chars: ${out.slice(0, 120)}`);
  }
}

const TASK_SQL = `
select id,
       json_extract(kind, '$')                        as kind,
       coalesce(json_extract(record, '$.state.outcome.status'), '') as status,
       coalesce(json_extract(record, '$.abortReason'), '')          as abort_reason,
       json_extract(record, '$.endedAt')                            as ended_at,
       coalesce(json_extract(record, '$.state.outcome.error.message'), '') as error_message
  from tasks
 order by id;
`;

const SUBMISSION_SQL = `
select id,
       status,
       coalesce(json_extract(record, '$.reason'), '') as reason,
       coalesce(json_extract(record, '$.requestId'), '') as request_id
  from submissions
 order by id;
`;

/**
 * Read every settlement in one store. `kinds` restricts task rows by prefix (`["factory."]` by default) because
 * kernel-internal `pi.tool`/`pi.generation` tasks outnumber factory runs ~17:1 in a real store and would bury the
 * signal; pass `null` for everything.
 */
export function readStore(
  store: string,
  dbPath: string,
  { kinds = ["factory."] }: { kinds?: readonly string[] | null } = {},
): SettlementRow[] {
  const rows: SettlementRow[] = [];

  const taskRows = queryJson(dbPath, TASK_SQL);
  for (const t of taskRows) {
    const kind = clean(t.kind);
    if (kinds && kinds.length && !kinds.some((k) => kind.startsWith(k))) continue;
    rows.push({
      store,
      table: "task",
      id: Number(t.id),
      kind: kind || null,
      status: clean(t.status) || "unknown",
      cls: classifyTask(String(t.status ?? ""), String(t.abort_reason ?? "")),
      whenMs: typeof t.ended_at === "number" ? t.ended_at : null,
      detail: truncate(clean(t.error_message ?? "")),
    });
  }

  const subRows = queryJson(dbPath, SUBMISSION_SQL);
  for (const s of subRows) {
    const reason = clean(s.reason);
    rows.push({
      store,
      table: "submission",
      id: Number(s.id),
      kind: clean(s.request_id) || null,
      status: clean(s.status) || "unknown",
      cls: classifySubmission(String(s.status ?? ""), reason),
      // Deliberately null: submissions carry no timestamp (verified 2026-11-03). Reporting a fabricated "when"
      // would be an invented fact in an operator-facing count.
      whenMs: null,
      detail: truncate(reason ? `reason=${reason}` : ""),
    });
  }

  return rows;
}

function emptyCounts(): Record<SettlementClass, number> {
  return { completed: 0, failing: 0, aborted: 0, restarted: 0, unanswered: 0, unsettled: 0 };
}

export function summarize(rows: SettlementRow[], storesScanned: number): SettlementSummary {
  const counts = emptyCounts();
  const byFamily: Record<"factory" | "kernel", Record<SettlementClass, number>> = {
    factory: emptyCounts(),
    kernel: emptyCounts(),
  };
  const alarms: SettlementRow[] = [];

  for (const r of rows) {
    counts[r.cls] += 1;
    const family = r.table === "submission" ? "factory" : (r.kind ?? "").startsWith("factory.") ? "factory" : "kernel";
    byFamily[family][r.cls] += 1;
    if (ALARMING.has(r.cls)) alarms.push(r);
  }

  // Newest-first samples across every class, so a human sees shape rather than only a number.
  const samples = [...rows]
    .sort((a, b) => (b.whenMs ?? 0) - (a.whenMs ?? 0) || b.id - a.id)
    .slice(0, 12);

  return {
    storesScanned,
    rowsExamined: rows.length,
    counts,
    byFamily,
    alarms,
    samples,
    // "No store readable" is a different answer from "nothing wrong", so it has to be distinguishable at all.
    collected: storesScanned > 0,
  };
}

export type Watermark = {
  version: 1;
  updatedAt: number;
  /** Highest row id seen per store per table. Ids are monotone (shared allocator), so this never needs to move back. */
  highWater: Record<string, number>;
};

export function emptyWatermark(): Watermark {
  return { version: 1, updatedAt: 0, highWater: {} };
}

/**
 * Read a watermark file. A corrupt or unreadable file is an ERROR, not a fresh start: silently treating "cannot
 * parse" as "nothing seen yet" would re-report every historical failure forever, and the operator's next move after
 * that is to delete the gate. Callers pass `--reset-watermark` when starting over is intended.
 */
export function readWatermark(file: string): Watermark {
  if (!existsSync(file)) return emptyWatermark();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read settlement watermark ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`settlement watermark ${file} is not valid JSON (${(e as Error).message}); re-run with --reset-watermark`);
  }
  const w = parsed as Partial<Watermark>;
  if (!w || w.version !== 1 || typeof w.highWater !== "object" || w.highWater === null) {
    throw new Error(`settlement watermark ${file} has an unexpected shape; re-run with --reset-watermark`);
  }
  return { version: 1, updatedAt: Number(w.updatedAt ?? 0), highWater: w.highWater as Record<string, number> };
}

export function keyFor(store: string, table: "task" | "submission"): string {
  return `${store}/${table}`;
}

/** Rows the caller has not seen before. Never uses a timestamp: submissions do not have one. */
export function unseen(rows: SettlementRow[], wm: Watermark): SettlementRow[] {
  return rows.filter((r) => r.id > (wm.highWater[keyFor(r.store, r.table)] ?? 0));
}

/** Advance per-key maxima. Monotone by construction — `Math.max` means a pruned row can never pull it backwards. */
export function advance(wm: Watermark, rows: SettlementRow[], now = Date.now()): Watermark {
  const highWater = { ...wm.highWater };
  for (const r of rows) {
    const k = keyFor(r.store, r.table);
    highWater[k] = Math.max(highWater[k] ?? 0, r.id);
  }
  return { version: 1, updatedAt: now, highWater };
}

/** Atomic write (tmp + rename): a gate killed mid-write must not leave half a watermark behind. */
export function writeWatermark(file: string, wm: Watermark): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(wm, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function formatSummary(s: SettlementSummary): string {
  const c = s.counts;
  const line = (label: string, x: Record<SettlementClass, number>) =>
    `${label}: completed=${x.completed} failing=${x.failing} unanswered=${x.unanswered} aborted=${x.aborted} restarted=${x.restarted} unsettled=${x.unsettled}`;
  const out = [
    line("all", c),
    line("  factory", s.byFamily.factory),
    line("  kernel ", s.byFamily.kernel),
  ];
  for (const a of s.alarms.slice(0, 8)) {
    out.push(`  ! ${a.store} ${a.table}#${a.id} ${a.kind ?? "?"} ${a.status}${a.detail ? ` — ${a.detail}` : ""}`);
  }
  if (s.alarms.length > 8) out.push(`  … ${s.alarms.length - 8} more`);
  return out.join("\n");
}
