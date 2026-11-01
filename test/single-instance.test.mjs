// Single-instance guard tests (#107).
//   node --experimental-strip-types --test test/single-instance.test.mjs
//
// Two supervisors ran at once and destroyed two issue dispatches: each rewrote the shared routes file
// with its own per-route token, the adapter's drift guard (correctly) refused deliveries in the middle,
// and GitHub never redelivered them. These tests pin the three states a lock has to distinguish — live
// owner, crashed owner, nonsense — because "delete it and carry on" is exactly how the incident happens
// again.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as fsRead } from "node:fs";
import { acquireInstanceLock, defaultLockPath, isPidAlive } from "../fleet/single-instance.ts";

const dir = () => mkdtempSync(join(tmpdir(), "lock-test-"));

test("an uncontended lock is created with our pid and removed on release", () => {
  const path = join(dir(), "sup.lock");
  const lock = acquireInstanceLock(path, { pid: 4242, isAlive: () => true });
  assert.ok(lock.acquired, lock.reason);
  assert.equal(readFileSync(path, "utf8").trim(), "4242");
  lock.release();
  assert.ok(!existsSync(path), "release must remove the lock file");
  lock.release(); // idempotent — a second release must not throw
});

test("a live owner blocks a second supervisor and names its pid", () => {
  const path = join(dir(), "sup.lock");
  const first = acquireInstanceLock(path, { pid: 111, isAlive: () => true });
  assert.ok(first.acquired);

  const second = acquireInstanceLock(path, { pid: 222, isAlive: (p) => p === 111 });
  assert.ok(!second.acquired, "a live owner must not be displaced");
  assert.equal(second.heldBy, 111);
  assert.match(second.reason, /already running as pid 111/);
  assert.match(second.reason, /refusing to start a second one/);
  assert.equal(readFileSync(path, "utf8").trim(), "111", "a refused acquire must not touch the lock");

  // The loser's release() is a no-op: it must not unlock the winner.
  second.release();
  assert.ok(existsSync(path), "a refused acquire must not remove the winner's lock");
  const stillHeld = acquireInstanceLock(path, { pid: 333, isAlive: (p) => p === 111 });
  assert.ok(!stillHeld.acquired, "the owner is alive from every observer's point of view");
  first.release();
});

test("a stale lock from a crashed run is reclaimed, and says so", () => {
  const path = join(dir(), "sup.lock");
  writeFileSync(path, "999999\n");
  const lock = acquireInstanceLock(path, { pid: 555, isAlive: () => false });
  assert.ok(lock.acquired, lock.reason);
  assert.match(lock.reason, /reclaimed stale supervisor lock \(previous pid 999999/);
  assert.equal(readFileSync(path, "utf8").trim(), "555");
});

test("an unparsable lock is treated as held, never silently deleted", () => {
  const path = join(dir(), "sup.lock");
  writeFileSync(path, "not-a-pid\n");
  const lock = acquireInstanceLock(path, { pid: 777, isAlive: () => false });
  assert.ok(!lock.acquired, "garbage must not be interpreted as a dead owner");
  assert.match(lock.reason, /not parsable/);
  assert.match(lock.reason, /refusing to start rather than assume it is stale/);
  assert.equal(readFileSync(path, "utf8"), "not-a-pid\n", "the evidence stays for the operator");
});

test("a lock owned by another uid (EPERM) counts as alive", () => {
  // process.kill(pid, 0) throws EPERM for a live process we may not signal; that is liveness, not death.
  const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const real = process.kill;
  try {
    process.kill = () => {
      throw eperm;
    };
    assert.equal(isPidAlive(4321), true);
  } finally {
    process.kill = real;
  }
  assert.equal(isPidAlive(process.pid), true, "we are definitely alive");
  assert.ok(!isPidAlive(0) && !isPidAlive(-1) && !isPidAlive(1.5), "non-pids are not alive");
});

test("defaultLockPath keeps one lock per routes file, so a second fleet is allowed", () => {
  assert.equal(defaultLockPath("/x/routes.json"), "/x/routes.json.lock");
  const d = dir();
  const a = acquireInstanceLock(join(d, "routes-a.json.lock"), { pid: 1, isAlive: () => true });
  const b = acquireInstanceLock(join(d, "routes-b.json.lock"), { pid: 2, isAlive: () => true });
  assert.ok(a.acquired && b.acquired, "distinct routes files must not contend");
});

test("the supervisor takes the lock before writing routes and refuses to proceed without it (source pin)", () => {
  const src = fsRead(new URL("../fleet/supervisor.ts", import.meta.url), "utf8");
  const acquireAt = src.indexOf("acquireInstanceLock(lockPath");
  const writeAt = src.indexOf("writeRoutes();");
  assert.ok(acquireAt > 0, "runFleet must take the instance lock");
  assert.ok(writeAt > 0);
  assert.ok(acquireAt < writeAt, "the lock must be taken BEFORE the shared routes file is written");
  assert.match(src, /if \(!lock\.acquired\)[\s\S]{0,200}process\.exit\(1\)/, "a refused lock must stop the process");
  assert.match(src, /lock\.release\(\)/, "shutdown must release the lock a restart would need");
  // The bounded-shutdown fix: an unref'd deadline never fires if a child handle keeps the loop alive.
  assert.match(src, /setTimeout\(\(\) => process\.exit\(0\), 3_000\)(?!\.unref)/, "shutdown deadline must stay ref'd");
});
