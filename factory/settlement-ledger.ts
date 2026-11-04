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
import { extractBlockedApprovals, type BlockedApproval } from "./approval-state.ts";

export type SettlementClass =
  | "completed"   // produced an answer/result
  | "failing"     // failed or faulted — the alarming bucket
  | "aborted"     // operator/other abort; reported, never alarmed (#141 design)
  | "restarted"   // reclaimed by a restart (abortReason "restart"); churn, not an incident
  | "unanswered"  // accepted work that no model answered — the #133 shape, alarms unless aborted
  | "unsettled"   // queued/placed: still open, or wedged forever
  | "inFlight"   // task row whose kernel state is not terminal yet — no outcome exists to judge (#186)
  | "waiting"   // terminal run a gate stopped for a human approval (#188) — reported, never alarmed
  | "modelUnavailable"; // the endpoint never served the pinned model (#161 follow-up) — alarming, but NOT an agent defect

/**
 * `waiting` (#188): the run stopped because a gate asked a human for an approval.
 *
 * Why it is not `failing`: an approval block is neither an agent defect nor an infrastructure incident, and counting
 * it as failing trains people to ignore the settlement window — the exact dead-endpoint failure mode (#133) this
 * ledger exists to avoid. Why it is not `inFlight` either: the task really did settle, so unlike an open row it will
 * never change state, and the watermark may advance past it. The remedy lives in `detail`, which carries the key.
 */

export type SettlementRow = {
  store: string;
  table: "task" | "submission";
  id: number;
  kind: string | null;
  status: string;
  /** Kernel task state (`terminal`, `running`, …) for task rows; null for submissions. */
  kernelStatus?: string | null;
  cls: SettlementClass;
  /** Conversation the row ran in, when the record carries one. Needed to attribute pre-#188 approval blocks (#204). */
  conversationId?: number | null;
  /** Set when this row's class came from conversation-level evidence rather than from its own outcome. */
  attribution?: "retroactive-approval" | "approval-context" | null;
  /** True when an operator signed this exact row off (`--ack`): counted, never alarming again. */
  acked?: boolean;
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

const ALARMING: ReadonlySet<SettlementClass> = new Set(["failing", "unanswered", "modelUnavailable"]);
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
/**
 * Kernel task states that mean "this row is still open". Verified against the store's own CHECK constraint
 * (`pending|running|waiting|completing|terminal`) on 2026-11-03, plus `waiting` as observed live.
 *
 * Anything NOT in this set falls through to outcome classification, so an unrecognized kernel state stays
 * fail-closed: it is judged by its outcome and lands in `failing` if there is no outcome. Guessing "open" for
 * unknown values would hide exactly the wedged-terminal rows this ledger exists to catch.
 */
const OPEN_KERNEL_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "waiting", "completing"]);

/**
 * `blockedKey` (#188) is `outcome.result.blocked.key`, present when a gate refused a critical tool. It outranks the
 * outcome status on purpose: the row IS a failure in kernel terms (the run did not complete) and reporting it as one
 * would bury the only actionable fact in the row — that a human is being asked, with which key.
 */
/**
 * Kernel reasons meaning "inference did not happen", verified in `pi-durable/dist/harness/generation.js`:
 * `failNoModel` settles the task `failed` with `error.detail.reason:"no_model"` AND its submission
 * `unanswered/no_model`; a provider error mid-generation settles `model_error`. Neither is an agent defect, and both
 * used to land in the anonymous `failing` bucket — so an operator read "the worker broke" for "the model you configured
 * is not served by this endpoint", which is #161's complaint one layer down.
 *
 * It stays alarming: accepted work was lost and a human has to fix a pin or load a model. What changes is that the count
 * names the cause, making a misconfigured repo legible in one line instead of a store dive.
 */
const MODEL_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(["no_model", "model_error"]);

export function modelUnavailableReason(errorReason: string): boolean {
  return MODEL_UNAVAILABLE_REASONS.has(clean(errorReason).toLowerCase());
}

export function classifyTask(kernelStatus: string, outcomeStatus: string, abortReason: string, blockedKey = "", errorReason = ""): SettlementClass {
  // An open task has no outcome by definition. Reading only `$.state.outcome.status` made every in-flight run
  // classify as an unknown outcome — i.e. alarming — so the window was red whenever anything was actually
  // running, which is when an operator most needs it to be readable (#186).
  if (OPEN_KERNEL_STATUSES.has(clean(kernelStatus).toLowerCase())) return "inFlight";
  if (clean(blockedKey).length > 0) return "waiting";
  const s = clean(outcomeStatus).toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed" || s === "faulted") return modelUnavailableReason(errorReason) ? "modelUnavailable" : "failing";
  if (s === "aborted") return clean(abortReason).toLowerCase() === "restart" ? "restarted" : "aborted";
  // Anything else — including an empty outcome on a terminal row — is alarming rather than completed. An unknown
  // shape in the one column we aggregate is exactly when reporting success is most expensive.
  return "failing";
}

export function classifySubmission(status: string, reason: string): SettlementClass {
  const s = clean(status).toLowerCase();
  if (s === "done") return "completed";
  if (s === "unanswered") {
    const r = clean(reason).toLowerCase();
    if (MODEL_UNAVAILABLE_REASONS.has(r)) return "modelUnavailable";
    return r === "aborted" ? "aborted" : "unanswered";
  }
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
       status                                         as kernel_status,
       coalesce(json_extract(record, '$.state.outcome.status'), '') as status,
       coalesce(json_extract(record, '$.abortReason'), '')          as abort_reason,
       json_extract(record, '$.endedAt')                            as ended_at,
       coalesce(json_extract(record, '$.state.outcome.error.message'), '')          as error_message,
       coalesce(json_extract(record, '$.state.outcome.result.blocked.key'), '')     as blocked_key,
       coalesce(json_extract(record, '$.state.outcome.result.blocked.tool'), '')    as blocked_tool,
       coalesce(json_extract(record, '$.state.outcome.error.detail.reason'), '')     as error_reason,
       json_extract(record, '$.conversationId')                                      as conv_id
  from tasks
 order by id;
`;

const SUBMISSION_SQL = `
select id,
       status,
       coalesce(json_extract(record, '$.reason'), '') as reason,
       coalesce(json_extract(record, '$.requestId'), '') as request_id,
       coalesce(json_extract(record, '$.conversationId'), 0) as conv_id
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
      // `status` stays the outcome (it is what an operator greps for); the kernel state rides along for diagnosis
      // because "no outcome" means two completely different things depending on it.
      status: clean(t.status) || "unknown",
      kernelStatus: clean(t.kernel_status) || null,
      conversationId: Number(t.conv_id) > 0 ? Number(t.conv_id) : null,
      cls: classifyTask(String(t.kernel_status ?? ""), String(t.status ?? ""), String(t.abort_reason ?? ""), String(t.blocked_key ?? ""), String(t.error_reason ?? "")),
      whenMs: typeof t.ended_at === "number" ? t.ended_at : null,
      // For a blocked row the key is the whole point of the row, so it leads the detail even if the message is long. A
      // model row leads with its reason for the same reason: "failed" alone hides whether the agent or the pin is wrong.
      detail: modelUnavailableReason(String(t.error_reason ?? "")) && clean(t.status ?? "") !== "completed"
        ? truncate(`${clean(t.error_reason)} — ${clean(t.error_message ?? "")}`)
        : clean(t.blocked_key ?? "")
        ? truncate(`approval ${clean(t.blocked_key)}${clean(t.blocked_tool) ? ` (${clean(t.blocked_tool)})` : ""} — ${clean(t.error_message ?? "")}`)
        : truncate(clean(t.error_message ?? "")),
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
      conversationId: Number(s.conv_id) > 0 ? Number(s.conv_id) : null,
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
  return { completed: 0, failing: 0, aborted: 0, restarted: 0, unanswered: 0, unsettled: 0, inFlight: 0, waiting: 0, modelUnavailable: 0 };
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
    // An acked row is still counted — it happened — but it stopped alarming, which is the whole point of being able to
    // record that someone looked (#204).
    if (ALARMING.has(r.cls) && !r.acked) alarms.push(r);
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

export type Acknowledgement = { reason: string; atMs: number };

export type Watermark = {
  version: 1;
  updatedAt: number;
  /** Highest row id seen per store per table. Ids are monotone (shared allocator), so this never needs to move back. */
  highWater: Record<string, number>;
  /**
   * Rows an operator examined and signed off, keyed `store/table:id` (#204). Without this the gate's rule "alarm until
   * someone looks" has no terminal state: looking is not something you can DO, so a historical failure pins the
   * watermark forever and the alarm turns into noise. A reason is required so the record says why, not merely that.
   */
  acked?: Record<string, Acknowledgement>;
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
  return {
    version: 1,
    updatedAt: Number(w.updatedAt ?? 0),
    highWater: w.highWater as Record<string, number>,
    // Files written before #204 simply have no acks; that is an empty set, not a corrupt file.
    ...(w.acked && typeof w.acked === "object" ? { acked: w.acked as Record<string, Acknowledgement> } : {}),
  };
}

export function keyFor(store: string, table: "task" | "submission"): string {
  return `${store}/${table}`;
}

/** A single row's identity in an acknowledgement record. */
export function ackKeyFor(store: string, table: "task" | "submission", id: number): string {
  return `${store}/${table}:${id}`;
}

export function parseAckRef(ref: string): { key: string } | { error: string } {
  const m = /^(.+)\/(task|submission):(\d+)$/.exec(ref.trim());
  if (!m) return { error: `ack reference "${ref}" is not store/table:id (e.g. lalanikarim_engram/task:46)` };
  return { key: `${m[1]}/${m[2]}:${Number(m[3])}` };
}

/** Immutable add: a new watermark carrying this ack, with the reason that justifies it. */
export function withAck(wm: Watermark, ref: string, reason: string, now = Date.now()): Watermark {
  const parsed = parseAckRef(ref);
  if ("error" in parsed) throw new Error(parsed.error);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error(`ack for ${parsed.key} needs --ack-reason: the record must say why this is not an incident`);
  return { ...wm, updatedAt: now, acked: { ...(wm.acked ?? {}), [parsed.key]: { reason: trimmed, atMs: now } } };
}

/** Flag rows the operator already signed off. Classification is untouched — an ack changes alarming, not history. */
export function applyAcks(rows: SettlementRow[], wm: Watermark): SettlementRow[] {
  const acked = wm.acked ?? {};
  for (const r of rows) if (acked[ackKeyFor(r.store, r.table, r.id)]) r.acked = true;
  return rows;
}

/**
 * Approval markers present per conversation, read straight from the entries table.
 *
 * This exists because #188's detector runs **inside** a task and reads its live context; rows written before that deploy
 * have no `outcome.result.blocked` and would otherwise report as anonymous agent failures forever. The marker text lives
 * in committed entries either way, so the history is legible — it just has to be read from the store side.
 */
export function readConversationApprovals(dbPath: string): Map<number, BlockedApproval[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = queryJson(
      dbPath,
      "select conversation_id as cid, record from entries where cast(record as text) like '%Approval request:%' order by id;",
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // A store with no entries table has no markers — that is an empty answer, not a failure. Anything else (a renamed
    // column, a corrupt db) propagates: silently reporting "no approvals here" when the schema moved is exactly the
    // confident-wrong read this module was built to stop making.
    if (/no such table: entries/.test(msg)) return new Map();
    throw new Error(`cannot read approval markers from ${dbPath}: ${msg}`);
  }
  const perConv = new Map<number, unknown[]>();
  for (const r of rows) {
    const cid = Number(r.cid);
    if (!Number.isFinite(cid)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(r.record));
    } catch {
      continue; // An entry we cannot parse is evidence of nothing.
    }
    if (!perConv.has(cid)) perConv.set(cid, []);
    perConv.get(cid)!.push(parsed);
  }
  const out = new Map<number, BlockedApproval[]>();
  for (const [cid, entries] of perConv) {
    const blocks = extractBlockedApprovals(entries);
    if (blocks.length) out.set(cid, blocks);
  }
  return out;
}

/**
 * Attribute pre-#188 approval blocks without inventing a cause (#204).
 *
 * Markers are attributable to a **conversation**, never to a task id: entry records carry `toolCallId`/`toolName` and
 * nothing tying them to a row (verified against the engram store on 2026-11-04). So the rule is deliberately asymmetric:
 *
 *  - exactly one alarming row in that conversation → it is THE run that blocked: reclassify `waiting`, key in the
 *    detail, `attribution: "retroactive-approval"` so the report says where the claim came from;
 *  - more than one → we cannot tell which failure the marker explains, so **no reclassification**: keep the class and
 *    append the marker as context (`attribution: "approval-context"`).
 *
 * The second branch is the one that matters for honesty. Auto-blaming approvals for every failing row in a busy
 * conversation would be exactly the spelling-based misdiagnosis this line of work replaced.
 */
export function attributeHistoricalBlocks(
  rows: SettlementRow[],
  approvalsByConversation: Map<number, BlockedApproval[]>,
): SettlementRow[] {
  if (approvalsByConversation.size === 0) return rows;
  const alarmingPerConversation = new Map<string, number>();
  for (const r of rows) {
    if ((r.cls !== "failing" && r.cls !== "unanswered") || r.conversationId == null) continue;
    const k = `${r.store}#${r.conversationId}`;
    alarmingPerConversation.set(k, (alarmingPerConversation.get(k) ?? 0) + 1);
  }
  for (const r of rows) {
    if ((r.cls !== "failing" && r.cls !== "unanswered") || r.conversationId == null) continue;
    const blocks = approvalsByConversation.get(r.conversationId);
    if (!blocks || !blocks.length) continue;
    const b = blocks[blocks.length - 1]; // the latest marker is the one that stopped the run
    const label = `approval ${b.key} (${b.tool})`;
    if ((alarmingPerConversation.get(`${r.store}#${r.conversationId}`) ?? 0) === 1) {
      r.attribution = "retroactive-approval";
      r.cls = "waiting";
      r.detail = truncate(`${label} — attributed from conversation ${r.conversationId} (pre-#188 row); was: ${r.detail}`);
    } else {
      r.attribution = "approval-context";
      r.detail = truncate(`${r.detail} | conversation ${r.conversationId} also carries ${label} — check before blaming the agent`);
    }
  }
  return rows;
}

/** Rows the caller has not seen before. Never uses a timestamp: submissions do not have one. */
export function unseen(rows: SettlementRow[], wm: Watermark): SettlementRow[] {
  return rows.filter((r) => r.id > (wm.highWater[keyFor(r.store, r.table)] ?? 0));
}

/**
 * Advance per-key maxima. Monotone by construction — `Math.max` means a pruned row can never pull it backwards.
 *
 * Rows that have not settled yet are **skipped**, and this is the difference between a ledger and a memory hole:
 * ids are allocated before work runs, so an in-flight task or a `placed` submission is already the highest id in
 * its table. Advancing past it meant that when it finally failed five minutes later, no window would ever look at
 * it again — the failure existed only in the store and never in the alarm (#186). Holding the mark below open rows
 * costs a re-read of one row next pass; it buys late settlement being seen exactly once.
 *
 * A row that stays open forever (a wedged queue) pins the mark, which is correct: it keeps showing up as open
 * rather than disappearing from view.
 */
export function advance(wm: Watermark, rows: SettlementRow[], now = Date.now()): Watermark {
  const highWater = { ...wm.highWater };
  for (const r of rows) {
    if (r.cls === "inFlight" || r.cls === "unsettled") continue;
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
    `${label}: completed=${x.completed} failing=${x.failing} modelUnavailable=${x.modelUnavailable} unanswered=${x.unanswered} aborted=${x.aborted} restarted=${x.restarted} unsettled=${x.unsettled} inFlight=${x.inFlight} waiting=${x.waiting}`;
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
