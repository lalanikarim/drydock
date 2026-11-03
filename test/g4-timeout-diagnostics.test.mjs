// #147 — a crash-recovery gate that times out has to leave behind a merge **or a reason**.
//
// G4 T2 stalled once for the full 900 s and passed in 48 s on an identical re-run, printing only
// `no merged PR for agent/issue-45 within 900s`. These tests exist so the diagnostic added for that cannot rot: the
// timeout path is exercised (not merely described), and its output has to contain the task snapshot.
//
// The store here is a real sqlite database created with the production DDL, verbatim from
// `sqlite3 <instance>/engram-data/agent.sqlite .schema` on 2026-11-03 — including the CHECK constraints that make an
// invalid status impossible and the STRICT that makes a wrong column type throw. Two facts about that schema are
// asserted rather than assumed: `kind` is JSON-encoded text, and there is no heartbeat column (status is a reservation).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { taskSnapshot, formatTaskSnapshot, staleTasksBefore, waitOrDiagnose, instanceStoreDb } from "../gates/timeout-diagnostics.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const TASKS_DDL = `CREATE TABLE tasks (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`;

const SUBMISSIONS_DDL = `CREATE TABLE submissions (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`;

const recordOf = (id, conversationId, kind, status, startedAt) =>
  JSON.stringify({ id, conversationId, kind, version: 1, input: {}, background: false, abortRequested: false, state: { status, outcome: null }, startedAt });

function makeStore(name, rows = [], submissions = []) {
  const dir = mkdtempSync(join(tmpdir(), `g4-diag-${name}-`));
  const dbPath = join(dir, "agent.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(TASKS_DDL);
  db.exec(SUBMISSIONS_DDL);
  for (const r of rows) {
    db.prepare(`insert into tasks (id, conversation_id, kind, status, abort_requested, background, record) values (?,?,?,?,?,?,?)`).run(
      r.id, r.conversationId ?? 1, JSON.stringify(r.kind), r.status, r.abortRequested ? 1 : 0, r.background ? 1 : 0, recordOf(r.id, r.conversationId ?? 1, r.kind, r.status, r.startedAt ?? Date.now()),
    );
  }
  for (const s of submissions) {
    db.prepare(`insert into submissions (id, conversation_id, request_id, status, record) values (?,?,?,?,?)`).run(s.id, s.conversationId ?? 1, s.requestId ?? null, s.status, JSON.stringify({ id: s.id }));
  }
  db.close();
  return { dir, dbPath };
}

test("the snapshot names the non-terminal work and skips terminal rows", () => {
  const started = Date.now() - 60_000;
  const { dir, dbPath } = makeStore(
    "basic",
    [
      { id: 1294, kind: "pi.agent", status: "waiting", startedAt: started },
      { id: 1296, kind: "factory.worker", status: "running", startedAt: started - 5_000, abortRequested: true },
      { id: 1300, kind: "pi.generation", status: "terminal", startedAt: started },
    ],
    [{ id: 7, requestId: "retry-1", status: "queued" }, { id: 8, requestId: "old", status: "done" }],
  );
  try {
    const snap = taskSnapshot(dbPath);
    assert.equal(snap.ok, true, snap.reason);
    assert.deepEqual(snap.tasks.map((t) => t.id), [1294, 1296], "terminal rows are not the question");
    assert.deepEqual(snap.tasks.map((t) => t.kind), ["pi.agent", "factory.worker"], "kind is JSON-encoded text in the store and decoded on the way out");
    assert.equal(snap.tasks[1].abortRequested, true);
    assert.ok(snap.tasks[1].ageSec >= 60, `age should be computed from startedAt, got ${snap.tasks[1].ageSec}`);
    assert.deepEqual(snap.submissions.map((s) => s.id), [7], "only queued/placed submissions matter");
    assert.equal(snap.counts.terminal, 1);

    const text = formatTaskSnapshot(snap);
    for (const needle of ["task 1294", "pi.agent", "status=waiting", "task 1296", "abort-requested", "submission 7", "retry-1"]) {
      assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `snapshot text must contain "${needle}"`);
    }
    assert.doesNotMatch(text, /task 1300/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staleTasksBefore finds the pre-restart task that could be holding the slot", () => {
  const restart = Date.now();
  const { dir, dbPath } = makeStore(
    "stale",
    [
      { id: 10, kind: "factory.worker", status: "running", startedAt: restart - 120_000 },
      { id: 11, kind: "pi.generation", status: "pending", startedAt: restart + 1_000 },
    ],
  );
  try {
    const stale = staleTasksBefore(taskSnapshot(dbPath), restart);
    assert.deepEqual(stale.map((t) => t.id), [10]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable store still produces text — a diagnostic must not be the thing that fails (#143's lesson)", () => {
  const dir = mkdtempSync(join(tmpdir(), "g4-diag-bad-"));
  try {
    const missing = join(dir, "nope.sqlite");
    const s1 = taskSnapshot(missing);
    assert.equal(s1.ok, false);
    assert.match(formatTaskSnapshot(s1), /task snapshot unavailable/);
    assert.match(formatTaskSnapshot(s1), /no store file/);

    // A file that is not a database at all: opening may succeed, the query must not.
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, "this is not a database\n");
    const s2 = taskSnapshot(junk);
    assert.equal(s2.ok, false, "a file that is not a store must not report an empty task list as if it were truthy");
    assert.match(formatTaskSnapshot(s2), /task snapshot unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the timeout path carries the snapshot — this is what was missing at 900s", async () => {
  const { dir, dbPath } = makeStore(
    "timeout",
    [{ id: 1296, kind: "factory.worker", status: "running", startedAt: Date.now() - 30_000 }],
    [{ id: 9, requestId: "g4-t2-retry", status: "queued" }],
  );
  try {
    await assert.rejects(
      () =>
        waitOrDiagnose({
          what: "merged PR for agent/issue-45",
          timeoutMs: 50,
          pollMs: 10,
          probe: async () => null,
          diagnose: async () => formatTaskSnapshot(taskSnapshot(dbPath)),
        }),
      (err) => {
        assert.match(err.message, /no merged PR for agent\/issue-45 within 1s/);
        // The three things the 900-second shrug could not say: what is running, how long, and what is queued.
        assert.match(err.message, /task 1296/);
        assert.match(err.message, /factory\.worker/);
        assert.match(err.message, /status=running/);
        assert.match(err.message, /age=\d+s/);
        assert.match(err.message, /g4-t2-retry/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diagnosis that itself fails is reported and never replaces the timeout", async () => {
  await assert.rejects(
    () =>
      waitOrDiagnose({
        what: "merged PR",
        timeoutMs: 10,
        pollMs: 5,
        probe: async () => null,
        diagnose: () => {
          throw new Error("sqlite exploded");
        },
      }),
    /no merged PR within 1s[\s\S]*diagnosis itself failed: sqlite exploded/,
  );
});

test("waitOrDiagnose returns the first truthy probe result", async () => {
  let calls = 0;
  const got = await waitOrDiagnose({
    what: "thing",
    timeoutMs: 1_000,
    pollMs: 1,
    probe: async () => (++calls < 3 ? null : { state: "MERGED" }),
  });
  assert.deepEqual(got, { state: "MERGED" });
  assert.equal(calls, 3);
});

test("instanceStoreDb matches how factory/main.ts actually composes the path", () => {
  // FACTORY_INSTANCES_ROOT is a parent: main.ts appends repo.replace("/", "_") before engram-data.
  assert.equal(instanceStoreDb("/tmp/inst", "lalanikarim/drydock"), join("/tmp/inst", "lalanikarim_drydock", "engram-data", "agent.sqlite"));

  // Layout drift guard against the real thing, if this checkout has a fleet instance.
  const live = join(REPO_ROOT, "factory-instances", "lalanikarim_drydock", "engram-data", "agent.sqlite");
  if (existsSync(live)) {
    assert.equal(instanceStoreDb(join(REPO_ROOT, "factory-instances"), "lalanikarim/drydock"), live);
    assert.ok(existsSync(instanceStoreDb(join(REPO_ROOT, "factory-instances"), "lalanikarim/drydock")));
  }
});
