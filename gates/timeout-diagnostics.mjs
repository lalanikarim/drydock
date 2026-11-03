// Timeout diagnostics for the crash-recovery gates (#147).
//
// G4 T2 stalled once for the full 900 s and passed in 48 s on an identical re-run, and the log said only
// `no merged PR for agent/issue-45 within 900s`. That message is a shrug: it cannot distinguish "queued behind a task
// that will never finish" from "the approval was never recorded" from "still thinking". The gate had no way to ask, so
// the issue could only list hypotheses.
//
// Two constraints shaped this file:
//
//   1. **There is no `GET /tasks`.** Probed against the live instance on 2026-11-03: `/tasks`, `/tasks/status`,
//      `/harness/tasks`, `/task-graph`, `/submissions` all return 404; only `POST /tasks` exists (plus `/approvals`,
//      `/health`, `/conversations`). The task table is readable out of the instance's own sqlite store, which is what
//      gates/measurement.mjs and gates/usage.ts already do.
//   2. **A diagnostic must never be the thing that fails.** This runs on a path that is already failing. Every read is
//      best-effort and reports `ok:false` with a reason instead of throwing — the #143 lesson (a config read in a
//      recovery path killed the supervisor) applied to a gate.
//
// Column facts that bit earlier work: `kind` is JSON-encoded text (`"pi.generation"` including quotes), and task
// `status` is a reservation, not a heartbeat — it can say `running` for a process that died.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Where an instance's durable store lives.
 *
 * `factory/main.ts` composes it as `FACTORY_INSTANCES_ROOT/<repo with "/" replaced by "_">/engram-data`, so the root a
 * gate passes (spawnInstance sets FACTORY_INSTANCES_ROOT) is the **parent**, not the instance directory itself. The
 * fleet layout looks the same from one level up — `factory-instances/lalanikarim_drydock/engram-data/agent.sqlite` —
 * which is what makes this easy to get wrong by a single path segment.
 */
export function instanceStoreDb(instancesRoot, repo) {
  return join(instancesRoot, repo.replace(/[\/]/g, "_"), "engram-data", "agent.sqlite");
}

const decode = (v) => {
  if (typeof v !== "string") return v;
  try { const p = JSON.parse(v); return typeof p === "string" ? p : v; } catch { return v; }
};

/**
 * Read the non-terminal work an instance believes it has, plus its submissions. Never throws: a snapshot that cannot be
 * taken still has to print something useful.
 *
 * @param {string} dbPath path to agent.sqlite (may be missing, locked, or mid-WAL)
 */
export function taskSnapshot(dbPath) {
  const base = { ok: false, dbPath, tasks: [], submissions: [], counts: {}, reason: null };
  if (!existsSync(dbPath)) return { ...base, reason: "no store file at this path" };

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ...base, reason: `could not open store read-only: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  try {
    // Non-terminal only — a terminal list is long, and "what is holding the slot" is the question being asked.
    const tasks = db
      .prepare(`select id, conversation_id, kind, status, abort_requested, background, record from tasks where status != 'terminal' order by id asc`)
      .all();
    const submissions = db
      .prepare(`select id, conversation_id, request_id, status from submissions where status in ('queued','placed') order by id asc`)
      .all();
    const counts = {};
    for (const row of db.prepare(`select status, count(*) as n from tasks group by status`).all()) counts[row.status] = Number(row.n);

    const now = Date.now();
    return {
      ok: true,
      dbPath,
      counts,
      reason: null,
      tasks: tasks.map((t) => {
        let startedAt = null;
        try { startedAt = JSON.parse(t.record)?.startedAt ?? null; } catch { /* leave null; the row still matters */ }
        return {
          id: Number(t.id),
          conversationId: Number(t.conversation_id),
          kind: decode(t.kind),
          status: t.status,
          abortRequested: t.abort_requested === 1,
          background: t.background === 1,
          startedAt,
          ageSec: typeof startedAt === "number" ? Math.round((now - startedAt) / 1000) : null,
        };
      }),
      submissions: submissions.map((s) => ({ id: Number(s.id), conversationId: Number(s.conversation_id), requestId: s.request_id ?? null, status: s.status })),
    };
  } catch (err) {
    return { ...base, reason: `store query failed: ${String(err?.message ?? err).slice(0, 200)}` };
  } finally {
    try { db.close(); } catch { /* nothing worth doing */ }
  }
}

/** Tasks that were opened before `epochMs` and are still non-terminal — the "stale task holds the slot" case. */
export function staleTasksBefore(snapshot, epochMs) {
  return (snapshot?.tasks ?? []).filter((t) => typeof t.startedAt === "number" && t.startedAt < epochMs);
}

/** One-line-per-task rendering, always returns text — including when the snapshot itself failed. */
export function formatTaskSnapshot(snapshot) {
  if (!snapshot?.ok) return `    task snapshot unavailable: ${snapshot?.reason ?? "no snapshot taken"} (${snapshot?.dbPath ?? "unknown path"})`;
  const lines = [];
  const counts = Object.entries(snapshot.counts ?? {}).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)";
  lines.push(`    task counts: ${counts}`);
  if (!snapshot.tasks.length) lines.push("    no non-terminal tasks — nothing was holding a slot");
  for (const t of snapshot.tasks) {
    lines.push(
      `    task ${t.id} conv=${t.conversationId} kind=${t.kind} status=${t.status}` +
        `${t.abortRequested ? " abort-requested" : ""}${t.background ? " background" : ""}` +
        `${t.ageSec === null ? "" : ` age=${t.ageSec}s`}`,
    );
  }
  if (snapshot.submissions.length) {
    for (const s of snapshot.submissions) lines.push(`    submission ${s.id} conv=${s.conversationId} status=${s.status}${s.requestId ? ` requestId=${s.requestId}` : ""}`);
  } else {
    lines.push("    no queued/placed submissions");
  }
  return lines.join("\n");
}

/**
 * Poll `probe` until it returns truthy, or throw with a diagnosis attached. The whole point is the second half: a gate
 * that gives up should say what the system looked like when it did.
 *
 * @param {{what:string, timeoutMs:number, pollMs?:number, probe:()=>Promise<any>, diagnose?:()=>Promise<string>|string}} opts
 */
export async function waitOrDiagnose({ what, timeoutMs, pollMs = 10_000, probe, diagnose }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  let detail = "";
  if (diagnose) {
    try {
      detail = `\n  why it might not have happened:\n${await diagnose()}`;
    } catch (err) {
      // A failing diagnosis is reported, never fatal — the original timeout is the finding.
      detail = `\n  diagnosis itself failed: ${String(err?.message ?? err).slice(0, 200)}`;
    }
  }
  // Never "within 0s": a sub-second budget reported as zero makes the message read like a bug in the gate.
  const secs = Math.max(1, Math.round(timeoutMs / 1000));
  throw new Error(`no ${what} within ${secs}s${detail}`);
}
