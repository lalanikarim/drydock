// Settlement ledger + window gate (#161).
//
// These tests spawn the real `sqlite3` binary against real database files built from the production DDL, because
// the whole module is one query away from being wrong in a way no stub would catch. Three of the cases below exist
// for defects found by querying production stores first: text columns that are JSON-encoded, an outcome nested
// under `state.outcome` while `state.status` says `terminal` for every row, and ids drawn from a shared allocator.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ledger = await import("../factory/settlement-ledger.ts");

/** DDL copied verbatim from a production store (`sqlite3 … .schema`) on 2026-11-03. */
const DDL = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting','completing','terminal')),
  abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0,1)),
  background INTEGER NOT NULL CHECK (background IN (0,1)),
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','placed','done','unanswered')),
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
`;

function sql(db, statement) {
  return execFileSync("sqlite3", ["-batch", db, statement], { encoding: "utf8" });
}

/** A store dir laid out exactly like `factory-instances/<repo>/engram-data/agent.sqlite`. */
function makeStore(name) {
  const root = mkdtempSync(join(tmpdir(), `settlement-${name}-`));
  const dataDir = join(root, "factory-instances", name, "engram-data");
  mkdirSync(dataDir, { recursive: true });
  const db = join(dataDir, "agent.sqlite");
  sql(db, DDL);

  return {
    root,
    db,
    /**
     * `kind` is JSON-encoded because production stores it that way (`"factory.worker"` including the quotes).
     * Pass encodeKind:false to reproduce what happens when someone forgets.
     */
    task({ id, kind = "factory.worker", outcomeStatus = "completed", stateStatus = "terminal", kernelStatus = "terminal", abortReason = null, endedAt = 1_793_600_000_000, errorMessage = null, errorReason = null }) {
      const record = {
        id,
        conversationId: 1,
        kind: JSON.stringify(kind),
        state: {
          status: stateStatus,
          ...(outcomeStatus === null ? {} : {
            outcome: errorMessage
              ? { status: outcomeStatus, error: { message: errorMessage, ...(errorReason ? { detail: { reason: errorReason } } : {}) } }
              : { status: outcomeStatus, result: { entryId: 7 } },
          }),
        },
        endedAt,
        ...(abortReason === null ? {} : { abortReason }),
      };
      // The `status` COLUMN is the kernel's state machine; the record's outcome is a different thing. They are
      // passed independently here on purpose — an in-flight row is exactly (column=running, no outcome).
      sql(db, `insert into tasks (id, conversation_id, kind, status, abort_requested, background, record)
               values (${id}, 1, ${sqlLit(JSON.stringify(kind))}, ${sqlLit(kernelStatus)}, ${abortReason ? 1 : 0}, 0, ${sqlLit(JSON.stringify(record))});`);
      return this;
    },
    /**
     * Move a row from open to settled in place, the way the kernel would between two passes of this gate.
     * Used to prove the watermark held below an open row and therefore still sees its late failure (#186).
     */
    settleTask(id, { outcomeStatus = "failed", errorMessage = "verification exited 1", errorReason = null, endedAt = 1_793_600_500_000 } = {}) {
      const outcome = JSON.stringify(errorMessage
        ? { status: outcomeStatus, error: { message: errorMessage, ...(errorReason ? { detail: { reason: errorReason } } : {}) } }
        : { status: outcomeStatus, result: {} });
      sql(db, `update tasks set status='terminal', record=json_set(record,'$.state.status','terminal','$.state.outcome',json(${sqlLit(outcome)}),'$.endedAt',${endedAt}) where id=${id};`);
      return this;
    },
    submission({ id, status = "done", reason = null, requestId = `issue-${id}` }) {
      const record = { conversationId: 1, requestId, type: "input", status, ...(reason ? { reason } : {}) };
      sql(db, `insert into submissions (id, conversation_id, request_id, status, record)
               values (${id}, 1, ${sqlLit(requestId)}, ${sqlLit(status)}, ${sqlLit(JSON.stringify(record))});`);
      return this;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sqlLit(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

// ── classification (the part that decides whether an operator gets woken) ─────────────────────────

test("failed and faulted alarm; completed does not", () => {
  assert.equal(ledger.classifyTask("terminal", "completed", ""), "completed");
  assert.equal(ledger.classifyTask("terminal", "failed", ""), "failing");
  assert.equal(ledger.classifyTask("terminal", "faulted", ""), "failing");
});

test("a restart-reclaimed abort is churn, an unexplained one is just reported — neither alarms", () => {
  // Observed in production: abortReason 'restart' for reclaimed tasks, empty for operator aborts via #141.
  assert.equal(ledger.classifyTask("terminal", "aborted", "restart"), "restarted");
  assert.equal(ledger.classifyTask("terminal", "aborted", ""), "aborted");
  assert.equal(ledger.classifyTask("terminal", "aborted", "aborted by operator"), "aborted");
});

test("an outcome we do not recognize is alarming, never silently 'completed'", () => {
  assert.equal(ledger.classifyTask("terminal", "", ""), "failing");
  assert.equal(ledger.classifyTask("terminal", "exploded", ""), "failing");
  // Fail-closed on the kernel side too: only the four known open states count as in-flight. An unrecognized state
  // is judged by its outcome, so a wedged row cannot hide by looking novel.
  assert.equal(ledger.classifyTask("zombie", "", ""), "failing");
});

test("submissions: unanswered alarms unless a human aborted it; queued/placed are unsettled", () => {
  assert.equal(ledger.classifySubmission("done", ""), "completed");
  assert.equal(ledger.classifySubmission("unanswered", "aborted"), "aborted");
  // The #133 shape: no model answered. Never folded into the abort bucket — and since the #161 follow-up it is its own
  // class rather than generic `unanswered`, because "nothing was served" and "nobody replied" need different fixes.
  assert.equal(ledger.classifySubmission("unanswered", "no_model"), "modelUnavailable");
  assert.equal(ledger.classifySubmission("queued", ""), "unsettled");
  assert.equal(ledger.classifySubmission("placed", ""), "unsettled");
});

// ── #186: work that has not finished is not work that failed ───────────────────────────────────────

test("REGRESSION (#186): an in-flight task has no outcome, and reading only the outcome alarmed every live run",
  () => {
    // Production shape verified 2026-11-03 while a worker was mid-run: column status 'running', no
    // $.state.outcome at all. The old classifier saw "" → failing, so `settlement-window` exited 2 whenever the
    // fleet was actually doing something — which is precisely when an operator reads it.
    assert.equal(ledger.classifyTask("running", "", ""), "inFlight");
    assert.equal(ledger.classifyTask("waiting", "", ""), "inFlight");
    assert.equal(ledger.classifyTask("pending", "", ""), "inFlight");
    assert.equal(ledger.classifyTask("completing", "", ""), "inFlight");

    const s = makeStore("in-flight");
    try {
      s.task({ id: 64, outcomeStatus: null, kernelStatus: "running" });
      const rows = ledger.readStore("in-flight", s.db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].cls, "inFlight");
      assert.equal(rows[0].kernelStatus, "running");
      const summary = ledger.summarize(rows, 1);
      assert.deepEqual(summary.alarms, [], "a running task must not appear in alarms");
      assert.equal(summary.counts.inFlight, 1);
      assert.equal(summary.counts.failing, 0);
    } finally {
      s.cleanup();
    }
  });

test("REGRESSION (#186): the watermark holds below open rows, so a failure that lands later is still seen",
  () => {
    // Ids are allocated before work starts, so an open row is already the table maximum. Advancing past it meant
    // "failed five minutes after I looked" was invisible forever — the store knew, the alarm never did.
    const s = makeStore("late-failure");
    try {
      s.task({ id: 100, outcomeStatus: null, kernelStatus: "running" });
      s.submission({ id: 101, status: "placed" });

      let wm = ledger.emptyWatermark();
      const pass1 = ledger.unseen(ledger.readStore("late-failure", s.db), wm);
      assert.equal(pass1.length, 2, "both open rows are new");
      wm = ledger.advance(wm, pass1);
      assert.deepEqual(wm.highWater, {}, "open rows must not advance the watermark at all");

      // The kernel settles them between passes.
      s.settleTask(100, { outcomeStatus: "failed", errorMessage: "verification exited 1" });
      s.submission({ id: 102, status: "done" });

      const pass2 = ledger.unseen(ledger.readStore("late-failure", s.db), wm);
      const ids = pass2.map((r) => r.id).sort((a, b) => a - b);
      assert.deepEqual(ids, [100, 101, 102], "the settled ex-open rows are still unseen and now judgeable");
      const summary = ledger.summarize(pass2, 1);
      assert.equal(summary.alarms.length, 1, "the late failure alarms exactly once");
      assert.equal(summary.alarms[0].id, 100);

      // And after it has been reported, it is not reported again.
      wm = ledger.advance(wm, pass2);
      assert.equal(ledger.unseen(ledger.readStore("late-failure", s.db), wm).length, 0);
    } finally {
      s.cleanup();
    }
  });

test("gate: a live run does not make the window red (#186)", () => {
  const s = makeStore("gate-live-run");
  try {
    s.task({ id: 7, outcomeStatus: null, kernelStatus: "running" });
    s.submission({ id: 8, status: "placed" });
    const stateFile = join(s.root, "state.json");
    // Pass 1 baselines (that is the documented first-run behavior). Pass 2 is the interesting one: the same open
    // rows are still ahead of the watermark and must classify as in-flight, not as failures.
    runGate(["--instances-root", s.root, "--state-file", stateFile]);
    const r = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(r.code, 0, `a running worker is not an incident; gate said: ${r.out.slice(0, 300)}`);
    // The task is in-flight; the submission is unsettled. Two open buckets, neither alarming.
    assert.match(r.out, /inFlight=1/);
    assert.match(r.out, /unsettled=1/);
    assert.doesNotMatch(r.out, /failing=[1-9]/);
    assert.match(r.out, /window clean/);
  } finally {
    s.cleanup();
  }
});

// ── reading a real store ────────────────────────────────────────────────────────────────────────

test("REGRESSION: kind is JSON-encoded in the column, so naive equality finds nothing", () => {
  const s = makeStore("kind-encoding");
  try {
    s.task({ id: 10, kind: "factory.worker", outcomeStatus: "completed" });
    // Prove the trap is real before proving it is handled.
    const naive = sql(s.db, "select count(*) from tasks where kind = 'factory.worker';").trim();
    assert.equal(naive, "0", "if this ever stops being 0 the column stopped being JSON-encoded — update the ledger");
    const rows = ledger.readStore("kind-encoding", s.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "factory.worker", "ledger must decode the JSON encoding");
  } finally {
    s.cleanup();
  }
});

test("REGRESSION: state.status says 'terminal' for failures; the outcome lives one level deeper", () => {
  const s = makeStore("state-trap");
  try {
    s.task({ id: 11, outcomeStatus: "faulted", stateStatus: "terminal", errorMessage: "Tool write threw" });
    const shallow = sql(s.db, "select json_extract(record,'$.state.status') from tasks where id=11;").trim();
    assert.equal(shallow, "terminal", "a counter on this column would report a clean fleet forever");
    const rows = ledger.readStore("state-trap", s.db);
    assert.equal(rows[0].cls, "failing");
    assert.match(rows[0].detail, /Tool write threw/);
  } finally {
    s.cleanup();
  }
});

test("kernel tasks are filtered out by default and included with kinds:null", () => {
  const s = makeStore("kinds");
  try {
    s.task({ id: 20, kind: "factory.worker", outcomeStatus: "completed" });
    s.task({ id: 21, kind: "pi.generation", outcomeStatus: "aborted", abortReason: "" });
    s.task({ id: 22, kind: "pi.tool", outcomeStatus: "failed", errorMessage: "boom" });

    const scoped = ledger.readStore("kinds", s.db);
    assert.deepEqual(scoped.map((r) => r.kind), ["factory.worker"]);

    const everything = ledger.readStore("kinds", s.db, { kinds: null });
    assert.equal(everything.length, 3);
    const sum = ledger.summarize(everything, 1);
    assert.equal(sum.byFamily.kernel.failing, 1, "kernel failures must be visible when explicitly requested");
    assert.equal(sum.byFamily.factory.failing, 0);
  } finally {
    s.cleanup();
  }
});

test("submissions are read alongside tasks and carry their reason", () => {
  const s = makeStore("submissions");
  try {
    s.submission({ id: 30, status: "done" });
    s.submission({ id: 31, status: "unanswered", reason: "aborted" });
    s.submission({ id: 32, status: "unanswered", reason: "no_model" });
    s.submission({ id: 33, status: "queued" });

    const rows = ledger.readStore("submissions", s.db);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[30].cls, "completed");
    assert.equal(byId[31].cls, "aborted");
    // Changed intentionally with the #161 follow-up: no_model is its own class now. It still alarms (see below), so
    // nothing about the window's sensitivity changed — only the name the operator has to act on.
    assert.equal(byId[32].cls, "modelUnavailable");
    assert.equal(byId[33].cls, "unsettled");
    // No timestamp exists for submissions in the store; inventing one would be an invented fact.
    assert.equal(byId[32].whenMs, null);

    const sum = ledger.summarize(rows, 1);
    assert.equal(sum.alarms.length, 1, "only the no_model submission alarms");
    assert.equal(sum.alarms[0].id, 32);
  } finally {
    s.cleanup();
  }
});

// ── watermark: the difference between an alert and a lifetime total ──────────────────────────────

test("a missing watermark means baseline; advancing makes later rows the only new ones", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wm-")), "last-settlements.json");
  try {
    const wm0 = ledger.readWatermark(file);
    assert.equal(wm0.updatedAt, 0);

    const s = makeStore("advance");
    try {
      s.task({ id: 40, outcomeStatus: "completed" });
      const all = ledger.readStore("advance", s.db);
      assert.equal(ledger.unseen(all, wm0).length, 1, "baseline sees everything");

      const wm1 = ledger.advance(wm0, all);
      assert.equal(wm1.highWater["advance/task"], 40);
      assert.equal(ledger.unseen(ledger.readStore("advance", s.db), wm1).length, 0);

      s.task({ id: 41, outcomeStatus: "faulted", errorMessage: "new breakage" });
      const fresh = ledger.unseen(ledger.readStore("advance", s.db), wm1);
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].cls, "failing");
    } finally {
      s.cleanup();
    }
  } finally {
    rmSync(file, { force: true });
  }
});

test("pruning can never pull a watermark backwards", () => {
  const wm = ledger.advance(ledger.emptyWatermark(), [
    { store: "a", table: "task", id: 500, kind: "factory.worker", status: "completed", cls: "completed", whenMs: null, detail: "" },
  ]);
  // Rows vanish (deletion, retention, or a store restore) and we advance again over what remains.
  const later = ledger.advance(wm, [
    { store: "a", table: "task", id: 12, kind: "factory.worker", status: "completed", cls: "completed", whenMs: null, detail: "" },
  ]);
  assert.equal(later.highWater["a/task"], 500, "monotone by construction — Math.max, never a recompute from rows");
});

test("a corrupt watermark is an error that names the way out, not a silent reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-bad-"));
  const file = join(dir, "last-settlements.json");
  try {
    writeFileSync(file, "{ this is not json", "utf8");
    assert.throws(() => ledger.readWatermark(file), /--reset-watermark/);

    writeFileSync(file, JSON.stringify({ version: 99, highWater: {} }), "utf8");
    assert.throws(() => ledger.readWatermark(file), /unexpected shape/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the gate end to end: real process, real sqlite, exit codes as the contract ───────────────────

function runGate(args) {
  const r = spawnSync(process.execPath, [join(ROOT, "gates", "settlement-window.mjs"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("gate: baseline exits 0 and says so in those words", () => {
  const s = makeStore("gate-baseline");
  const stateFile = join(s.root, "state.json");
  try {
    s.task({ id: 50, outcomeStatus: "faulted", errorMessage: "historical" });
    const r = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /BASELINE RUN/);
    assert.match(r.out, /baseline established/);
    // And the watermark really moved, or the next run would re-baseline forever.
    const wm = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(wm.highWater["gate-baseline/task"], 50);
  } finally {
    s.cleanup();
  }
});

test("gate: a new failure exits 2 and names the row; it keeps exiting 2 until examined", () => {
  const s = makeStore("gate-alarm");
  const stateFile = join(s.root, "state.json");
  try {
    s.task({ id: 60, outcomeStatus: "completed" });
    assert.equal(runGate(["--instances-root", s.root, "--state-file", stateFile]).code, 0);

    s.task({ id: 61, outcomeStatus: "faulted", errorMessage: "cannot resolve a git identity" });
    const first = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(first.code, 2, first.out);
    assert.match(first.out, /task#61/);
    assert.match(first.out, /cannot resolve a git identity/);

    // A failure that was reported but not acknowledged must alarm again: the watermark does not advance on exit 2.
    const second = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(second.code, 2, "an unexamined failure must not age out of existence");
    assert.match(second.out, /task#61/);

    // Once it is fixed-and-examined (clean run with the alarming row acknowledged), later windows are quiet.
    const wm = JSON.parse(readFileSync(stateFile, "utf8"));
    writeFileSync(stateFile, JSON.stringify({ ...wm, highWater: { ...wm.highWater, "gate-alarm/task": 61 } }), "utf8");
    assert.equal(runGate(["--instances-root", s.root, "--state-file", stateFile]).code, 0);
  } finally {
    s.cleanup();
  }
});

test("gate: a window of only aborted work exits 0 but is still reported", () => {
  const s = makeStore("gate-abort");
  const stateFile = join(s.root, "state.json");
  try {
    s.task({ id: 70, outcomeStatus: "completed" });
    runGate(["--instances-root", s.root, "--state-file", stateFile]);

    // An operator abort (#141) plus a restart reclaim. Information, not an incident.
    s.task({ id: 71, outcomeStatus: "aborted" });
    s.submission({ id: 72, status: "unanswered", reason: "aborted" });
    s.task({ id: 73, outcomeStatus: "aborted", abortReason: "restart" });

    const r = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /aborted=2/);
    assert.match(r.out, /restarted=1/);
    assert.match(r.out, /never alarmed/);
  } finally {
    s.cleanup();
  }
});

test("gate: no stores exits 2 — 'not collected' is not 'passing'", () => {
  const empty = mkdtempSync(join(tmpdir(), "gate-empty-"));
  try {
    const r = runGate(["--instances-root", empty, "--state-file", join(empty, "state.json")]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /no instance stores found|nothing was examined/i);
    assert.match(r.out, /not a pass/i);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("gate: a corrupt watermark exits 2 instead of quietly re-baselining", () => {
  const s = makeStore("gate-corrupt");
  const stateFile = join(s.root, "state.json");
  try {
    s.task({ id: 80, outcomeStatus: "completed" });
    writeFileSync(stateFile, "{ nope", "utf8");
    const r = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--reset-watermark/);
  } finally {
    s.cleanup();
  }
});

test("gate: --all-kinds surfaces kernel failures the default scope hides", () => {
  const s = makeStore("gate-allkinds");
  const stateFile = join(s.root, "state.json");
  try {
    s.task({ id: 90, outcomeStatus: "completed" });
    runGate(["--instances-root", s.root, "--state-file", stateFile]);
    s.task({ id: 91, kind: "pi.tool", outcomeStatus: "failed", errorMessage: "Tool read threw" });

    const scoped = runGate(["--instances-root", s.root, "--state-file", stateFile]);
    assert.equal(scoped.code, 0, "factory scope must not see the kernel row: " + scoped.out);

    const wide = runGate(["--instances-root", s.root, "--state-file", stateFile, "--all-kinds"]);
    assert.equal(wide.code, 2, wide.out);
    assert.match(wide.out, /Tool read threw/);
  } finally {
    s.cleanup();
  }
});

// ── #161 follow-up: a model that was never served is not "the agent failed" ────────────────────────────────
//
// The kernel settles these itself (`failNoModel` in pi-durable's generation.js): task → failed with
// error.detail.reason="no_model", submission → unanswered/no_model; a provider blow-up mid-generation is model_error.
// Both used to dissolve into `failing`, so the window read "worker broke" for "this repo pins a model the endpoint does
// not serve". They stay alarming — accepted work was lost — but they must arrive named.

test("classification: no_model and model_error are modelUnavailable, not anonymous failure", () => {
  assert.equal(ledger.classifyTask("terminal", "failed", "", "", "no_model"), "modelUnavailable");
  assert.equal(ledger.classifyTask("terminal", "failed", "", "", "model_error"), "modelUnavailable");
  assert.equal(ledger.classifyTask("terminal", "failed", "", ""), "failing", "a failure with no kernel reason stays failing");
  // A stray reason on a run that completed is not evidence of anything; reclassifying it would invent incidents.
  assert.equal(ledger.classifyTask("terminal", "completed", "", "", "no_model"), "completed");
  assert.equal(ledger.classifySubmission("unanswered", "model_error"), "modelUnavailable");
  assert.equal(ledger.classifySubmission("unanswered", "aborted"), "aborted", "a human abort is still never a model problem");
});

test("classification: an approval block still outranks a model reason (#188 precedence preserved)", () => {
  // Two rules now want to own the same row. The blocked key wins because it names the only action available; a model
  // reason on a blocked row is downstream noise compared with "a human is being asked".
  assert.equal(ledger.classifyTask("terminal", "failed", "", "abc123", "no_model"), "waiting");
});

test("store: no_model rows classify, alarm, and lead their detail with the reason", () => {
  const s = makeStore("model-unavailable");
  try {
    s.task({ id: 300, outcomeStatus: "failed", errorMessage: "Model aurora/pinned-thing is not available", errorReason: "no_model" });
    s.task({ id: 301, outcomeStatus: "failed", errorMessage: "verification exited 1" });
    s.submission({ id: 302, status: "unanswered", reason: "no_model" });

    const byId = new Map(ledger.readStore("model-unavailable", s.db).map((r) => [r.id, r]));
    assert.equal(byId.get(300).cls, "modelUnavailable");
    assert.match(byId.get(300).detail, /^no_model — Model aurora\/pinned-thing is not available$/, "the reason leads, so one line diagnoses it");
    assert.equal(byId.get(301).cls, "failing", "an ordinary failure must not be absorbed by the new class");
    assert.equal(byId.get(302).cls, "modelUnavailable");

    const sum = ledger.summarize([...byId.values()], 1);
    assert.equal(sum.counts.modelUnavailable, 2);
    assert.equal(sum.counts.failing, 1);
    assert.equal(sum.alarms.length, 3, "lost work alarms whether the cause is inference or the agent");
    assert.match(ledger.formatSummary(sum), /modelUnavailable=2/, "the operator-facing line carries the new count");
  } finally {
    s.cleanup();
  }
});

// ── #204: reading approval blocks back out of history, and recording that a row was examined ─────
//
// Two defects these tests hold shut. (1) #188's detector runs inside a task, so rows written before it shipped have no
// blocked key and reported forever as anonymous agent failures — the marker text is in the conversation's entries, but
// nothing read it from the store side. (2) The window refused to advance its watermark while anything alarmed, with no
// way to record "someone looked", so four historical rows froze the gate indefinitely.

const ENTRIES_DDL = `
CREATE TABLE entries (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			head INTEGER,
			commit_seq INTEGER NOT NULL,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;
`;

/** Add the real `entries` table to a fixture store (DDL copied from a production store). */
function withEntries(store) {
  sql(store.db, ENTRIES_DDL);
  return store;
}

/** One committed entry whose nested text carries an approval marker, shaped like the kernel's tool-result entries. */
function approvalEntry(store, { id, cid, key = "a1b2c3d4e5f6", tool = "submit_verdict" }) {
  const record = {
    kind: "pi.tool-result",
    data: {
      note:
        `Approval request: {"key":"${key}","tool":"${tool}","args":{"verdict":"pass"},"tier":"destructive"}\n` +
        `Do not retry this action until the user has approved it.`,
    },
  };
  sql(store.db, `insert into entries (id, conversation_id, head, commit_seq, record)
                 values (${id}, ${cid}, null, ${id}, ${sqlLit(JSON.stringify(record))});`);
  return store;
}

const MARKER = "a1b2c3d4e5f6";

test("readConversationApprovals finds the marker's key and tool from the entries table", () => {
  const store = approvalEntry(withEntries(makeStore("approvals-read")), { id: 500, cid: 32 });
  const found = ledger.readConversationApprovals(store.db);
  assert.equal(found.get(32)?.[0]?.key, MARKER);
  assert.equal(found.get(32)?.[0]?.tool, "submit_verdict");
  store.cleanup();
});

test("a store with no entries table reads as 'no markers', not as an error", () => {
  // Real stores always have `entries`; fixtures and half-migrated roots do not. Confusing "absent" for "broken" would
  // make the gate fail on a store it can otherwise read fine.
  const store = makeStore("approvals-no-table");
  assert.equal(ledger.readConversationApprovals(store.db).size, 0);
  store.cleanup();
});

test("a pre-#188 failure in a conversation with exactly one alarming row becomes waiting, key and all", () => {
  const store = withEntries(makeStore("retroactive-unique"));
  store.task({ id: 268, outcomeStatus: "failed", errorMessage: "reviewer never called submit_verdict" });
  // conversation_id is a column AND in the record; the ledger reads the record (that is what production carries).
  sql(store.db, `update tasks set conversation_id=32, record=json_set(record,'$.conversationId',32) where id=268;`);
  approvalEntry(store, { id: 259, cid: 32 });

  const rows = ledger.attributeHistoricalBlocks(
    ledger.readStore("retroactive-unique", store.db, { kinds: ["factory."] }),
    ledger.readConversationApprovals(store.db),
  );
  const row = rows.find((r) => r.table === "task" && r.id === 268);
  assert.equal(row.cls, "waiting", "the run did not fail — a gate was waiting on a human");
  assert.equal(row.attribution, "retroactive-approval", "the report must say the claim came from conversation evidence");
  assert.match(row.detail, new RegExp(MARKER), "the key is the actionable part");
  assert.match(row.detail, /reviewer never called submit_verdict/, "and it keeps what the row originally said");

  // The point of all this: an approval wait does not alarm.
  const summary = ledger.summarize(rows, 1);
  assert.equal(summary.counts.waiting, 1);
  assert.deepEqual(summary.alarms.map((a) => a.id), []);
  store.cleanup();
});

test("two alarming rows in one conversation are NOT both blamed on the approval", () => {
  // Markers belong to conversations, not task ids — verified against production entries, which carry toolCallId and
  // nothing tying them to a row. Guessing here would be the spelling-based misdiagnosis this line of work replaced.
  const store = withEntries(makeStore("retroactive-ambiguous"));
  store.task({ id: 10, outcomeStatus: "failed", errorMessage: "verification exited 1" });
  store.task({ id: 11, outcomeStatus: "failed", errorMessage: "reviewer never called submit_verdict" });
  sql(store.db, `update tasks set conversation_id=44, record=json_set(record,'$.conversationId',44);`);
  approvalEntry(store, { id: 600, cid: 44, tool: "bash" });

  const rows = ledger.attributeHistoricalBlocks(
    ledger.readStore("retroactive-ambiguous", store.db, { kinds: ["factory."] }),
    ledger.readConversationApprovals(store.db),
  );
  const both = rows.filter((r) => r.table === "task");
  assert.deepEqual(both.map((r) => r.cls), ["failing", "failing"], "ambiguity keeps the honest class");
  assert.ok(both.every((r) => r.attribution === "approval-context"));
  assert.ok(both.every((r) => /check before blaming the agent/.test(r.detail)));
  assert.equal(ledger.summarize(rows, 1).alarms.length, 2, "both still alarm — context is not an excuse");
  store.cleanup();
});

// ── acknowledgements: making "someone looked" a state instead of a hope ──────────────────────────

test("an ack keeps the row counted and stops it alarming", () => {
  const rows = [
    { store: "s", table: "task", id: 46, kind: "factory.worker", status: "failed", cls: "failing", whenMs: null, detail: "setup command failed (exit 1)" },
    { store: "s", table: "task", id: 99, kind: "factory.worker", status: "failed", cls: "failing", whenMs: null, detail: "brand new failure" },
  ];
  let wm = ledger.emptyWatermark();
  wm = ledger.withAck(wm, "s/task:46", "sandbox npm install was broken then; not an incident");
  ledger.applyAcks(rows, wm);
  const summary = ledger.summarize(rows, 1);
  assert.equal(summary.counts.failing, 2, "an ack is not a deletion — the failure still happened");
  assert.deepEqual(summary.alarms.map((a) => a.id), [99], "only the unexamined row wakes anyone");
});

test("an ack needs a reference we can resolve and a reason that explains it", () => {
  const wm = ledger.emptyWatermark();
  assert.throws(() => ledger.withAck(wm, "task:46", "no store"), /not store\/table:id/);
  assert.throws(() => ledger.withAck(wm, "s/task:notanumber", "x"), /not store\/table:id/);
  assert.throws(() => ledger.withAck(wm, "s/task:46", "   "), /needs --ack-reason/);
});

test("acks survive the state file, and a pre-#204 file loads without them", () => {
  const dir = mkdtempSync(join(tmpdir(), "settlement-ack-"));
  const file = join(dir, "last-settlements.json");
  let wm = ledger.emptyWatermark();
  wm = ledger.advance(wm, [{ store: "s", table: "task", id: 5, kind: "factory.worker", status: "completed", cls: "completed", whenMs: 1, detail: "" }]);
  wm = ledger.withAck(wm, "s/task:46", "examined 2026-11-04: pre-#188 approval wait");
  ledger.writeWatermark(file, wm);
  const back = ledger.readWatermark(file);
  assert.equal(back.highWater["s/task"], 5);
  assert.equal(back.acked["s/task:46"].reason, "examined 2026-11-04: pre-#188 approval wait");

  // A file written before this feature: no `acked` key at all must not be treated as corrupt (the alternative is the
  // operator being told to --reset-watermark, which would silently discard the whole window).
  writeFileSync(file, JSON.stringify({ version: 1, updatedAt: 1, highWater: { "s/task": 5 } }));
  const legacy = ledger.readWatermark(file);
  assert.equal(legacy.highWater["s/task"], 5);
  assert.equal(legacy.acked, undefined);
  rmSync(dir, { recursive: true, force: true });
});
