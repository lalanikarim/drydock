// Process lifecycle: process groups, orphan detection, bounded shutdown (#125 → #127, #110).
//   node --experimental-strip-types --test test/process-lifecycle.test.mjs
//
// These spawn **real processes** and assert on observable effects — a pid that stops answering, a group that
// empties, an exit code — because every defect behind this change was committed green under a fake. A stub
// for "did the child die?" answers whatever you assume; `pgrep -g` does not. Where a double is unavoidable
// (the shutdown coordinator's timers) it is injected, and the recorded sequence is asserted in order.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execPath } from "node:process";
import { spawnInProcessGroup, terminateProcessGroup, killProcessGroupNow, listProcessGroup } from "../fleet/proc-group.ts";
import { createShutdownCoordinator } from "../fleet/shutdown-coordinator.ts";
import { parseSupervisorPid, detectOrphan, startParentWatchdog, SUPERVISOR_PID_ENV } from "../factory/parent-watchdog.ts";

const WATCHDOG_TS = new URL("../factory/parent-watchdog.ts", import.meta.url).pathname;
const workdir = () => mkdtempSync(join(tmpdir(), "proc-lifecycle-"));

/** A process that does nothing but exist, to stand in for a supervisor we can SIGKILL. */
function spawnDummySupervisor() {
  return spawnInProcessGroup(execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "inherit"] });
}

/** A child running the *real* watchdog, reporting what it decides on stdout as JSON lines. */
function spawnWatchedChild({ supervisorPid, dir }) {
  const script = join(dir, "watched-child.mjs");
  writeFileSync(
    script,
    `import { startParentWatchdog, SUPERVISOR_PID_ENV } from ${JSON.stringify(WATCHDOG_TS)};
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ ev: "ready", pid: process.pid, ppid: process.ppid, supervised: process.env[SUPERVISOR_PID_ENV] ?? null });
let closing = false;
const close = (why) => { if (closing) return; closing = true; out({ ev: "closing", why }); process.exit(0); };
process.on("SIGTERM", () => close("sigterm"));
startParentWatchdog({
  supervisorPid: process.env[SUPERVISOR_PID_ENV] ?? null,
  label: "watched-child",
  intervalMs: 100,
  firstCheckDelayMs: 150,
  onOrphaned: (info) => close("orphaned:" + info.reason),
});
setInterval(() => {}, 1000);
`,
  );
  return spawnInProcessGroup(execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(supervisorPid ? { [SUPERVISOR_PID_ENV]: String(supervisorPid) } : {}) },
  });
}

const readLines = (stream) => {
  let buf = "";
  const lines = [];
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) lines.push(line);
    }
  });
  return () => lines;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// ---------------------------------------------------------------------------

test("a detached child leads its own process group", () => {
  const dir = workdir();
  const leader = spawnInProcessGroup(execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(leader.pid, "child must have a pid");
    // pgid === child pid is the whole premise of group-addressable teardown.
    assert.deepEqual(listProcessGroup(leader.pid), [leader.pid]);
  } finally {
    leader.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("group termination reaches grandchildren — a child's own subprocess does not survive", async () => {
  const dir = workdir();
  // The leader spawns its own child (what a worker's verification step does). Killing only the leader would
  // leave this behind, which is #125 in miniature.
  const leaderScript = join(dir, "leader.mjs");
  writeFileSync(leaderScript, `import { spawn } from "node:child_process";\nspawn("sleep", ["60"], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`);
  const leader = spawnInProcessGroup(execPath, [leaderScript], { stdio: "ignore" });
  const exited = once(leader, "exit");

  // Give the grandchild a moment to appear.
  await new Promise((r) => setTimeout(r, 400));
  const before = listProcessGroup(leader.pid);
  assert.equal(before.length, 2, `expected leader + grandchild in group ${leader.pid}, saw ${before.join(", ")}`);

  const result = await terminateProcessGroup(leader.pid, { termGraceMs: 2_000, killGraceMs: 1_000 });
  await exited;
  assert.deepEqual(result.survivors, [], `survivors: ${result.survivors.join(", ")}`);
  assert.equal(result.escalated, false, "SIGTERM should have been enough for both");
  assert.equal(listProcessGroup(leader.pid).length, 0, "group must be empty afterwards");
  rmSync(dir, { recursive: true, force: true });
});

test("a child that ignores SIGTERM is escalated to SIGKILL and reported as escalated", async () => {
  const dir = workdir();
  const stubborn = join(dir, "stubborn.mjs");
  writeFileSync(stubborn, `process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`);
  const child = spawnInProcessGroup(execPath, [stubborn], { stdio: "ignore" });
  const exited = once(child, "exit");

  const result = await terminateProcessGroup(child.pid, { termGraceMs: 400, killGraceMs: 1_500 });
  await exited;
  assert.equal(result.escalated, true, "ignoring SIGTERM must force escalation");
  assert.deepEqual(result.survivors, []);
  rmSync(dir, { recursive: true, force: true });
});

test("teardown is idempotent and never throws on an already-dead group", async () => {
  const dir = workdir();
  const child = spawnInProcessGroup(execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "exit");
  const first = await terminateProcessGroup(child.pid, { termGraceMs: 200, killGraceMs: 200 });
  const second = await terminateProcessGroup(child.pid, { termGraceMs: 200, killGraceMs: 200 });
  assert.deepEqual(first.survivors, []);
  assert.deepEqual(second.survivors, []);
  assert.equal(killProcessGroupNow(child.pid).survivors.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("parseSupervisorPid: absent, garbage and self-referential values all mean 'not armed'", () => {
  assert.equal(parseSupervisorPid(undefined), null);
  assert.equal(parseSupervisorPid(""), null);
  assert.equal(parseSupervisorPid("   "), null);
  assert.equal(parseSupervisorPid("not-a-pid"), null);
  assert.equal(parseSupervisorPid("0"), null);
  assert.equal(parseSupervisorPid("-5"), null);
  assert.equal(parseSupervisorPid("12.5"), null);
  assert.equal(parseSupervisorPid(String(process.pid), process.pid), null, "a supervisor claiming to be us is nonsense");
  assert.equal(parseSupervisorPid("4321"), 4321);
  assert.equal(parseSupervisorPid(4321), 4321);
});

test("detectOrphan only fires on evidence, and never when unarmed", () => {
  const aliveProbe = (pid) => pid === 1000; // 1000 is the supervisor in this table
  assert.equal(detectOrphan(null, { ppid: 1, isAlive: aliveProbe }), null, "no supervisor recorded → never armed");
  assert.equal(detectOrphan(1000, { ppid: 1000, isAlive: aliveProbe }), null, "still parented to the supervisor");
  assert.equal(detectOrphan(1000, { ppid: 1, isAlive: () => false }), "reparented-to-init");
  assert.equal(detectOrphan(1000, { ppid: 77, isAlive: () => false }), "supervisor-exited", "supervisor pid stopped answering");
  assert.equal(detectOrphan(1000, { ppid: 77, isAlive: (p) => p === 1000 }), "reparented-elsewhere", "ppid moved while supervisor lives");
});

test("REAL PROCESSES: SIGKILLing the supervisor leaves no served-by-nobody child alive", async () => {
  const dir = workdir();
  const supervisor = spawnDummySupervisor();
  const supPid = supervisor.pid;
  assert.ok(supPid);
  const supervisorGone = once(supervisor, "exit");

  const child = spawnWatchedChild({ supervisorPid: supPid, dir });
  const lines = readLines(child.stdout);
  const exited = once(child, "exit");

  // Wait until the child is up and confirms who it thinks its supervisor is.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !lines().some((l) => l.includes('"ev":"ready"'))) await new Promise((r) => setTimeout(r, 50));
  assert.ok(lines().some((l) => l.includes('"ev":"ready"')), `child never reported ready: ${lines().join(" | ")}`);

  // The condition from #125: the supervisor dies without running a handler.
  supervisor.kill("SIGKILL");
  await supervisorGone;

  const exitDeadline = Date.now() + 6_000;
  let timedOut = true;
  while (Date.now() < exitDeadline) {
    if (!alive(child.pid)) {
      timedOut = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const output = lines().join(" | ");
  if (!timedOut) await exited.catch(() => {});
  child.kill("SIGKILL");

  assert.equal(timedOut, false, `orphaned child was still serving after 6s. Output: ${output}`);
  assert.match(output, /"ev":"closing","why":"orphaned:/, `child exited without naming orphaning as the reason: ${output}`);
  rmSync(dir, { recursive: true, force: true });
});

test("REAL PROCESSES: no FACTORY_SUPERVISOR_PID means no watchdog — manual runs are untouched", async () => {
  const dir = workdir();
  const supervisor = spawnDummySupervisor();
  const supPid = supervisor.pid;
  const child = spawnWatchedChild({ supervisorPid: null, dir });
  const lines = readLines(child.stdout);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !lines().some((l) => l.includes('"ev":"ready"'))) await new Promise((r) => setTimeout(r, 50));
  assert.ok(lines().some((l) => l.includes('"ev":"ready"')), "child never reported ready");

  // Kill the would-be supervisor. A watched child exits; an unwatched one must keep running, because a
  // foreground `node factory/main.ts …` has no supervisor and must not shoot itself when its shell goes.
  supervisor.kill("SIGKILL");
  await once(supervisor, "exit").catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(alive(child.pid), `unmanaged child self-terminated with no supervisor recorded: ${lines().join(" | ")}`);

  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});
  assert.doesNotMatch(lines().join(" | "), /orphaned/);
  rmSync(dir, { recursive: true, force: true });
});

test("startParentWatchdog returns a stop function that prevents firing", async () => {
  let fired = 0;
  const stop = startParentWatchdog({
    supervisorPid: "999999", // certainly not alive
    label: "test",
    intervalMs: 20,
    firstCheckDelayMs: 0,
    isAlive: () => false,
    ppidFn: () => 1,
    onOrphaned: () => {
      fired += 1;
    },
    log: () => {},
  });
  stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, 0, "a stopped watchdog must not fire");

  // And the armed version fires exactly once, not every tick.
  let fired2 = 0;
  startParentWatchdog({
    supervisorPid: "999999",
    label: "test",
    intervalMs: 20,
    firstCheckDelayMs: 0,
    isAlive: () => false,
    ppidFn: () => 1,
    onOrphaned: () => {
      fired2 += 1;
    },
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fired2, 1, "orphaning must be reported once, not per poll");
});

// ---------------------------------------------------------------------------

function harness({ graceMs = 1_000 } = {}) {
  const events = [];
  let children = ["factory:a", "adapter"];
  let pendingTimer = null;
  const coord = createShutdownCoordinator({
    tracked: () => children,
    terminate: (key) => events.push(`term:${key}`),
    forceKill: (key) => events.push(`kill:${key}`),
    stopRestarts: () => events.push("stop-restarts"),
    releaseLock: () => events.push("release-lock"),
    exit: (code) => events.push(`exit:${code}`),
    log: (line) => events.push(`log:${line}`),
    graceMs,
    setTimer: (fn, ms) => {
      events.push(`arm-timer:${ms}`);
      pendingTimer = { fn, ms };
      return pendingTimer;
    },
  });
  return {
    coord,
    events,
    children,
    setChildren: (c) => {
      children = c;
    },
    fireTimer: () => pendingTimer?.fn(),
  };
}

test("first shutdown request: stop restarts → release lock → terminate groups → arm the bound", () => {
  const h = harness();
  assert.equal(h.coord.isShuttingDown(), false);
  h.coord.begin("received SIGTERM");

  // Order is the contract, not an implementation detail. A restart scheduled after teardown starts spawns a
  // child nobody owns; a lock released last tells a restarting operator "already running".
  assert.deepEqual(
    h.events.filter((e) => ["stop-restarts", "release-lock"].includes(e)),
    ["stop-restarts", "release-lock"],
  );
  assert.ok(h.events.indexOf("stop-restarts") < h.events.indexOf("term:factory:a"), "restarts stop before children are signalled");
  assert.ok(h.events.includes("term:factory:a") && h.events.includes("term:adapter"), "every tracked group is terminated");
  assert.ok(!h.events.some((e) => e.startsWith("kill:")), "the first request never SIGKILLs");
  assert.match(h.events.find((e) => e.startsWith("arm-timer")) ?? "", /^arm-timer:1000$/);
  assert.equal(h.coord.isShuttingDown(), true);

  // The armed timer is the bound: firing it exits with the requested code.
  h.fireTimer();
  assert.ok(h.events.includes("exit:0"));
});

test("a give-up shutdown exits non-zero, so a scheduler can tell it from a clean stop", () => {
  const h = harness();
  h.coord.begin("adapter: restart budget exhausted", { exitCode: 1 });
  h.fireTimer();
  assert.ok(h.events.includes("exit:1"), h.events.join(" | "));
});

test("SECOND signal exits immediately and SIGKILLs what is left (#110's ignored signal)", () => {
  const h = harness();
  h.coord.begin("received SIGTERM");
  const beforeSecond = h.events.length;
  h.coord.begin("received SIGTERM again");

  assert.ok(h.events.slice(beforeSecond).includes("kill:factory:a"), "second request force-kills tracked groups");
  assert.ok(h.events.includes("exit:0"), "second request exits without waiting for the timer");
  assert.equal(h.events.filter((e) => e.startsWith("arm-timer")).length, 1, "the bound is armed once, not re-armed per signal");
  // The exit code chosen by the first request survives into the immediate exit.
  const h2 = harness();
  h2.coord.begin("restart budget exhausted", { exitCode: 1 });
  h2.coord.begin("received SIGTERM");
  assert.equal(h2.events[h2.events.length - 1], "exit:1", h2.events.join(" | "));
});

test("teardown suppresses restarts through isShuttingDown()", () => {
  const h = harness();
  let restarted = 0;
  const maybeRestart = () => {
    if (!h.coord.isShuttingDown()) restarted += 1;
  };
  maybeRestart();
  h.coord.begin("received SIGINT");
  maybeRestart();
  maybeRestart();
  assert.equal(restarted, 1, "restarts happen only while not shutting down");
});

test("a child that already exited is not terminated twice: tracked() reflects live children only", () => {
  const h = harness();
  h.setChildren(["adapter"]); // factory:a died and was removed from the map
  h.coord.begin("received SIGTERM");
  assert.ok(!h.events.includes("term:factory:a"));
  assert.ok(h.events.includes("term:adapter"));
});
