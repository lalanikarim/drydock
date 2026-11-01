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

const { main, readSweepState, runCli, sweepStatePayload, writeSweepState } = await import("../fleet/redeliver-failed.mjs");

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
