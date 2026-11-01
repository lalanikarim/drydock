// #110 — the sweep has to leave a trace someone can read.
//   node --experimental-strip-types --test test/sweep-state.test.mjs
//
// GitHub does not retry failed deliveries, so a sweep nobody ran is indistinguishable from a clean
// system. These pin that the breadcrumb exists, survives being missing or corrupt without throwing at
// `supervisor status`, and is written on every exit path where the listing actually succeeded.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { main, parseSince, readSkipList, readSweepState, resolveToken, runCli, selectFailedDeliveries, sweepStatePayload, writeSweepState } = await import("../fleet/redeliver-failed.mjs");

test("payload is plain JSON with string ids and an ISO timestamp", () => {
  const p = sweepStatePayload({ repo: "o/r", hookId: 703101252, mode: "dry-run", inspected: 72, undelivered: 34, queued: 0 });
  assert.equal(p.repo, "o/r");
  assert.equal(p.hookId, "703101252", "hook ids are strings — they are large and must not round-trip through arithmetic");
  assert.match(p.at, /^\d{4}-\d{2}-\d{2}T/, "an ISO timestamp so age can be computed by any reader");
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test("readSweepState never throws: missing, corrupt and valid all answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweepstate-"));
  try {
    assert.deepEqual(readSweepState(join(dir, "nope.json")), { ok: false, reason: "never" });

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(readSweepState(bad), { ok: false, reason: "corrupt" });

    const shapeless = join(dir, "shapeless.json");
    writeFileSync(shapeless, JSON.stringify({ repo: "o/r" }));
    assert.equal(readSweepState(shapeless).reason, "corrupt", "no timestamp means we cannot reason about freshness");

    const good = join(dir, "good.json");
    writeSweepState(good, sweepStatePayload({ repo: "o/r", hookId: 1, mode: "apply", inspected: 3, undelivered: 0 }));
    const read = readSweepState(good);
    assert.equal(read.ok, true);
    assert.equal(read.state.mode, "apply");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSweepState creates the directory and leaves valid JSON on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweepwrite-"));
  try {
    const path = join(dir, "nested", "deeper", "last-sweep.json");
    writeSweepState(path, sweepStatePayload({ repo: "o/r", hookId: 2, mode: "dry-run", inspected: 5, undelivered: 1 }));
    assert.equal(existsSync(path), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).undelivered, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeFetch(rows) {
  return async (path) => {
    if (path.startsWith("/repos/o/r/hooks/9/deliveries")) return { ok: true, status: 200, body: rows };
    return { ok: false, status: 404, body: { message: `unexpected ${path}` } };
  };
}

const baseArgs = ["--repo", "o/r", "--hook", "9"];

test("a dry run records what it saw, including the finding count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sweepdry-"));
  try {
    const statePath = join(dir, "last-sweep.json");
    const rows = [
      { id: 1, status: "OK", response_code: 200, event: "issues", delivered_at: "2026-11-01T00:00:00Z" },
      { id: 2, status: "timeout", response_code: null, event: "issues", delivered_at: "2026-11-01T00:01:00Z" },
    ];
    const out = await main({ argv: [...baseArgs, "--state-file", statePath], env: { GH_TOKEN: "t" }, fetchImpl: fakeFetch(rows), log: () => {} });
    assert.equal(out.code, 1, "findings still mean a non-zero exit so a scheduled run surfaces");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.mode, "dry-run");
    assert.equal(state.inspected, 2);
    assert.equal(state.undelivered, 1);
    assert.equal(state.queued, 0, "a dry run queued nothing, and says so");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean sweep is recorded too — 'never ran' must differ from 'ran and was clean'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sweepclean-"));
  try {
    const statePath = join(dir, "last-sweep.json");
    const rows = [{ id: 1, status: "OK", response_code: 200, event: "issues", delivered_at: "2026-11-01T00:00:00Z" }];
    const out = await main({ argv: [...baseArgs, "--state-file", statePath], env: { GH_TOKEN: "t" }, fetchImpl: fakeFetch(rows), log: () => {} });
    assert.equal(out.code, 0);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).undelivered, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exit code is the whole point of scheduling this job, and it used to never leave main().
test("runCli propagates the verdict as a process exit code", async () => {
  const dirty = [{ id: 2, status: "timeout", response_code: null, event: "issues", delivered_at: "2026-11-01T00:01:00Z" }];
  const clean = [{ id: 1, status: "OK", response_code: 200, event: "issues", delivered_at: "2026-11-01T00:00:00Z" }];

  const codeOf = async (argv, rows) => {
    let exited = null;
    await runCli({ argv, env: { GH_TOKEN: "t" }, fetchImpl: fakeFetch(rows), log: () => {}, exit: (c) => { exited = c; } });
    return exited;
  };

  assert.equal(await codeOf(baseArgs, dirty), 1, "findings must be visible to launchd/mail as a non-zero exit");
  assert.equal(await codeOf(baseArgs, clean), 0, "a clean sweep is not an error");
  assert.equal(await codeOf([], dirty), 2, "missing --repo/--hook is a usage error, not a silent success");
});

test("runCli turns a thrown listing failure into exit 2 rather than an unhandled rejection", async () => {
  let exited = null;
  const boom = async () => { throw new Error("connect ECONNREFUSED"); };
  const result = await runCli({ argv: baseArgs, env: { GH_TOKEN: "t" }, fetchImpl: boom, log: () => {}, exit: (c) => { exited = c; } });
  assert.equal(exited, 2);
  assert.equal(result.code, 2);
});

// A scheduled job cannot compute "yesterday" in a plist, so the window has to be expressed relative to
// run time — otherwise the alarm reports ancient failures forever and gets ignored.
test("--since accepts a rolling window as well as an absolute timestamp", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");
  assert.equal(parseSince("24h", { now }), "2026-10-31T12:00:00.000Z");
  assert.equal(parseSince("90m", { now }), "2026-11-01T10:30:00.000Z");
  assert.equal(parseSince("7d", { now }), "2026-10-25T12:00:00.000Z");
  assert.equal(parseSince("45s", { now }), "2026-11-01T11:59:15.000Z");
  assert.equal(parseSince("2026-10-01T00:00:00Z", { now }), "2026-10-01T00:00:00Z", "absolute passes through");
  assert.equal(parseSince(null, { now }), null, "absent means unbounded, and must not become NaN");
});

test("a rolling window excludes old failures and keeps recent ones", () => {
  const rows = [
    { id: 1, status: "timeout", delivered_at: "2026-10-20T00:00:00Z" },
    { id: 2, status: "OK", response_code: 200, delivered_at: "2026-10-31T00:00:00Z" },
    { id: 3, status: "server_error", delivered_at: "2026-10-31T06:00:00Z" },
  ];
  const now = Date.parse("2026-11-01T00:00:00Z");
  const picked = selectFailedDeliveries(rows, { since: parseSince("12h", { now }) });
  assert.deepEqual(picked.map((d) => d.id), [], "nothing failed inside the window even though history has failures");
  assert.deepEqual(selectFailedDeliveries(rows, { since: parseSince("30d", { now }) }).map((d) => d.id), [1, 3]);
});

test("the state file records which window was inspected", () => {
  const p = sweepStatePayload({ repo: "o/r", hookId: 1, mode: "dry-run", inspected: 10, undelivered: 2, queued: 0, since: "2026-10-31T12:00:00.000Z" });
  assert.equal(p.since, "2026-10-31T12:00:00.000Z");
  assert.equal(sweepStatePayload({ repo: "o/r", hookId: 1, mode: "dry-run", inspected: 10, undelivered: 2 }).since, null);
});

// An alarm that cannot be acknowledged is an alarm that gets ignored — but acknowledging must not be
// able to make the record look like a clean hook.
test("readSkipList parses ids and comments, and fails towards alarming", () => {
  const dir = mkdtempSync(join(tmpdir(), "ack-"));
  const file = join(dir, "ack.txt");
  writeFileSync(file, "# reviewed 2026-11-01: issue closed before the event was ever actionable\n3851437072338403328\n\n  3851441390821081088   # trailing comment\n");
  assert.deepEqual(readSkipList(file).ids, ["3851437072338403328", "3851441390821081088"]);

  const missing = readSkipList(join(dir, "does-not-exist.txt"));
  assert.deepEqual(missing.ids, [], "an unreadable list must not silence the alarm by acknowledging everything");
  assert.match(missing.warning ?? /$/, /treating as no acknowledgements/);

  assert.deepEqual(readSkipList(null), { ids: [], warning: null }, "no flag is not a warning");
});

test("acknowledged failures clear the exit code yet stay in the record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ack-run-"));
  const state = join(dir, "last-sweep.json");
  const rows = [
    { id: 11, status: "timeout", delivered_at: "2026-11-01T00:00:00Z" },
    { id: 12, status: "server_error", delivered_at: "2026-11-01T00:01:00Z" },
  ];

  const partial = await main({ argv: [...baseArgs, "--skip", "11", "--state-file", state], env: { GH_TOKEN: "t" }, fetchImpl: fakeFetch(rows), log: () => {} });
  assert.equal(partial.code, 1, "acknowledging one of two still leaves something to act on");

  const all = await main({ argv: [...baseArgs, "--skip", "11,12", "--state-file", state], env: { GH_TOKEN: "t" }, fetchImpl: fakeFetch(rows), log: () => {} });
  assert.equal(all.code, 0, "nothing left to act on is exit 0, not a suppressed failure");

  const st = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(st.undelivered, 0);
  assert.equal(st.acknowledged, 2, "the record keeps saying two failures were reviewed and dismissed");
});

// A LaunchAgent does not inherit a login shell's PATH, so resolving `gh` by name alone is an
// assumption about the environment rather than a fact about it — found while installing #110.
test("resolveToken falls back to absolute gh paths when bare gh is not on PATH", () => {
  const tried = [];
  const run = (cmd) => {
    tried.push(cmd);
    if (cmd === "gh") throw Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" });
    if (cmd === "/opt/homebrew/bin/gh") return "  brew-installed-token\n";
    throw new Error(`unexpected candidate ${cmd}`);
  };

  assert.equal(resolveToken({}, { run }), "brew-installed-token");
  assert.deepEqual(tried, ["gh", "/opt/homebrew/bin/gh"], "bare gh first, then absolute paths, in order");
});

test("resolveToken prefers the environment and never shells out when a token is set", () => {
  const run = () => { throw new Error("must not shell out when env provides a token"); };
  assert.equal(resolveToken({ GH_TOKEN: "  from-env  " }, { run }), "from-env");
  assert.equal(resolveToken({ GITHUB_TOKEN: "explicit" }, { run }), "explicit");
});

test("resolveToken reports absence instead of throwing", () => {
  const run = () => { throw new Error("ENOENT"); };
  assert.equal(resolveToken({}, { run }), null, "no credential is a reportable state — the sweep logs it and exits 2");
});

test("no --state-file means no file is written (opt-in state, not ambient)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sweepnone-"));
  try {
    const rows = [{ id: 2, status: "timeout", response_code: null, event: "issues", delivered_at: "2026-11-01T00:01:00Z" }];
    await main({ argv: baseArgs, env: { GH_TOKEN: "t" }, fetchImpl: fakeFetch(rows), log: () => {} });
    assert.deepEqual(readdirSync(dir), [], "the tool must not create files nobody asked for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
