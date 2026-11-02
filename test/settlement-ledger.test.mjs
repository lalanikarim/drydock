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
    task({ id, kind = "factory.worker", outcomeStatus = "completed", stateStatus = "terminal", abortReason = null, endedAt = 1_793_600_000_000, errorMessage = null }) {
      const record = {
        id,
        conversationId: 1,
        kind: JSON.stringify(kind),
        state: {
          status: stateStatus,
          ...(outcomeStatus === null ? {} : {
            outcome: errorMessage
              ? { status: outcomeStatus, error: { message: errorMessage } }
              : { status: outcomeStatus, result: { entryId: 7 } },
          }),
        },
        endedAt,
        ...(abortReason === null ? {} : { abortReason }),
      };
      sql(db, `insert into tasks (id, conversation_id, kind, status, abort_requested, background, record)
               values (${id}, 1, ${sqlLit(JSON.stringify(kind))}, 'terminal', ${abortReason ? 1 : 0}, 0, ${sqlLit(JSON.stringify(record))});`);
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
  assert.equal(ledger.classifyTask("completed", ""), "completed");
  assert.equal(ledger.classifyTask("failed", ""), "failing");
  assert.equal(ledger.classifyTask("faulted", ""), "failing");
});

test("a restart-reclaimed abort is churn, an unexplained one is just reported — neither alarms", () => {
  // Observed in production: abortReason 'restart' for reclaimed tasks, empty for operator aborts via #141.
  assert.equal(ledger.classifyTask("aborted", "restart"), "restarted");
  assert.equal(ledger.classifyTask("aborted", ""), "aborted");
  assert.equal(ledger.classifyTask("aborted", "aborted by operator"), "aborted");
});

test("an outcome we do not recognize is alarming, never silently 'completed'", () => {
  assert.equal(ledger.classifyTask("", ""), "failing");
  assert.equal(ledger.classifyTask("exploded", ""), "failing");
});

test("submissions: unanswered alarms unless a human aborted it; queued/placed are unsettled", () => {
  assert.equal(ledger.classifySubmission("done", ""), "completed");
  assert.equal(ledger.classifySubmission("unanswered", "aborted"), "aborted");
  // The #133 shape: no model answered. Must never be folded into the abort bucket.
  assert.equal(ledger.classifySubmission("unanswered", "no_model"), "unanswered");
  assert.equal(ledger.classifySubmission("queued", ""), "unsettled");
  assert.equal(ledger.classifySubmission("placed", ""), "unsettled");
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
    assert.equal(byId[32].cls, "unanswered");
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
