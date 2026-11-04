// Process lifecycle: process groups, orphan detection, bounded shutdown (#125 → #127, #110).
//   node --experimental-strip-types --test test/process-lifecycle.test.mjs
//
// These spawn **real processes** and assert on observable effects — a pid that stops answering, a group that
// empties, an exit code — because every defect behind this change was committed green under a fake. A stub
// for "did the child die?" answers whatever you assume; `pgrep -g` does not. Where a double is unavoidable
// (the shutdown coordinator's timers) it is injected, and the recorded sequence is asserted in order.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execPath } from "node:process";
import { spawn } from "node:child_process";
import { spawnInProcessGroup, terminateProcessGroup, killProcessGroupNow, listProcessGroup } from "../fleet/proc-group.ts";
import { createShutdownCoordinator } from "../fleet/shutdown-coordinator.ts";
import { releaseChildStreams } from "../fleet/supervisor.ts";
import { parseSupervisorPid, detectOrphan, startParentWatchdog, SUPERVISOR_PID_ENV } from "../factory/parent-watchdog.ts";

const WATCHDOG_TS = new URL("../factory/parent-watchdog.ts", import.meta.url).pathname;
const workdir = () => mkdtempSync(join(tmpdir(), "proc-lifecycle-"));

/** A process that does nothing but exist, to stand in for a supervisor we can SIGKILL. */
function spawnDummySupervisor() {
  return spawnInProcessGroup(execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "inherit"] });
}

/**
 * A child running the *real* watchdog, reporting what it decides on stdout as JSON lines. With WATCH_DURABLE
 * set it mirrors those events into that file — the only channel that survives a supervisor dying with the pipe,
 * which is what the "supervisor owns the pipes" test needs in order to observe anything at all.
 */
const WATCHED_CHILD_SOURCE = `
import { appendFileSync } from "node:fs";
import { startParentWatchdog, SUPERVISOR_PID_ENV } from ${JSON.stringify(WATCHDOG_TS)};
const durable = process.env.WATCH_DURABLE || null;
// Exactly production's shape: the child's own log line goes to stdout and nowhere else — which is a pipe into a
// supervisor that may already be dead. The mark() helper exists only for the startup marker, so the durable
// of WHY the child exited can come from one place: the watchdog's own durable sink. A test that let the fixture
// write it would pass with that sink removed (it did, once) and prove nothing.
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };
const mark = (o) => { if (durable) { try { appendFileSync(durable, JSON.stringify(o) + "\\n"); } catch {} } };
mark({ ev: "ready", pid: process.pid, ppid: process.ppid, supervised: process.env[SUPERVISOR_PID_ENV] ?? null });
out({ ev: "ready", pid: process.pid });
let closing = false;
const close = (why) => { if (closing) return; closing = true; out({ ev: "closing", why }); process.exit(0); };
process.on("SIGTERM", () => close("sigterm"));
startParentWatchdog({
  supervisorPid: process.env[SUPERVISOR_PID_ENV] ?? null,
  label: "watched-child",
  intervalMs: 100,
  firstCheckDelayMs: 150,
  durableLogPath: durable ?? undefined,
  onOrphaned: (info) => close("orphaned:" + info.reason),
});
setInterval(() => {}, 1000);
`;

function spawnWatchedChild({ supervisorPid, dir }) {
  const script = join(dir, "watched-child.mjs");
  writeFileSync(script, WATCHED_CHILD_SOURCE);
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

/**
 * Wait until `pgrep -g` can see the group. A spawn that has not been scheduled yet is invisible to it, and a
 * teardown test that fires in that window proves nothing — CI caught exactly this on an ubuntu runner (the
 * stubborn-child test below reported "no escalation needed" because there was nothing in the group yet).
 */
async function waitForGroup(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = listProcessGroup(pid);
    if (seen.length > 0) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`process group ${pid} never became visible to pgrep — group-addressable teardown cannot be tested`);
}

test("a detached child leads its own process group", async () => {
  const dir = workdir();
  const leader = spawnInProcessGroup(execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(leader.pid, "child must have a pid");
    // pgid === child pid is the whole premise of group-addressable teardown.
    const seen = await waitForGroup(leader.pid);
    assert.deepEqual(seen, [leader.pid]);
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
  // The child announces readiness AFTER installing its trap. Without that handshake this test was a race and
  // lost on a loaded runner: teardown ran while the group was still empty, so "escalation was not needed" was
  // reported as if SIGTERM had been honored — a pass about scheduling, not about the code under test.
  const ready = join(dir, "ready");
  const stubborn = join(dir, "stubborn.mjs");
  writeFileSync(
    stubborn,
    `import { appendFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nappendFileSync(${JSON.stringify(ready)}, "armed\\n");\nsetInterval(() => {}, 1000);\n`,
  );
  const child = spawnInProcessGroup(execPath, [stubborn], { stdio: "ignore" });
  const exited = once(child, "exit");

  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(existsSync(ready), "stubborn child never installed its SIGTERM trap — nothing to escalate against");
  // Non-vacuity: there must be something in the group before teardown claims it escalated.
  assert.equal((await waitForGroup(child.pid)).length, 1);

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

test("a broken stdout pipe cannot abort the orphan shutdown — the durable copy is what survives", async () => {
  // The hostile version of reality. When a supervisor dies it takes the child's stdout pipe with it, so the one
  // line explaining "an instance nobody dispatched" is written into nothing and console.log raises EPIPE. If
  // that exception escaped, teardown would stop mid-close — durable store still open, no exit, no record. So:
  // log throws like a dead pipe, and shutdown must still run, with a record somewhere the pipe cannot reach.
  const dir = workdir();
  const durable = join(dir, "orphan-events.log");
  let orphaned = null;
  const stop = startParentWatchdog({
    supervisorPid: 4242,
    label: "watched",
    durableLogPath: durable,
    log: () => {
      throw new Error("EPIPE: broken pipe — write end of a supervisor that no longer exists");
    },
    ppidFn: () => 1,
    isAlive: () => false,
    intervalMs: 5,
    firstCheckDelayMs: 0,
    onOrphaned: (info) => {
      orphaned = info;
    },
  });
  try {
    const deadline = Date.now() + 2_000;
    while (!orphaned && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(orphaned, "watchdog never fired while stdout was throwing — the exception aborted detection");
    assert.equal(orphaned.reason, "reparented-to-init");
    const text = readFileSync(durable, "utf8");
    assert.match(text, /orphaned \(reparented-to-init\)/, "durable record missing the reason");
    assert.match(text, /Runbook/, "durable record must carry the operator action, not just the fact");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REAL PROCESSES: when the supervisor that OWNS THE PIPES dies, the child still notices and records it", async () => {
  // The shape reality actually has — and the one this suite originally missed. The test above keeps the pipe
  // alive (the test process is still reading), so it proved orphan *detection* while a live `kill -9` of the
  // real supervisor left no trace whatsoever: the child's stdout was a pipe into a process that no longer
  // exists, and its one explanatory line went there. Here the supervisor is the child's own parent and creates
  // the pipes, so its death closes them. Assertions are on observable effects only: the child stops, and an
  // event file that does not depend on the pipe says why.
  const dir = workdir();
  try {
    const durable = join(dir, "orphan-events.log");
    const childScript = join(dir, "watched-child.mjs");
    writeFileSync(childScript, WATCHED_CHILD_SOURCE);

    const supSource = [
      'import { spawn } from "node:child_process";',
      "const child = spawn(process.execPath, [CHILD_SCRIPT], {",
      '  stdio: ["ignore", "pipe", "pipe"], // fresh pipes whose reader is THIS process',
      "  env: { ...process.env, SUP_PID_ENV: String(process.pid), WATCH_DURABLE: __DURABLE__ },",
      "});",
      "child.stdout.resume();",
      "child.stderr.resume();",
      'process.stdout.write(String(child.pid) + "\\n");',
      'setTimeout(() => process.kill(process.pid, "SIGKILL"), 400); // no handler runs; the pipes die here',
      "",
    ]
      .join("\n")
      .replace("CHILD_SCRIPT", JSON.stringify(childScript))
      .replace("SUP_PID_ENV", JSON.stringify(SUPERVISOR_PID_ENV))
      .replace("__DURABLE__", JSON.stringify(durable));
    const supScript = join(dir, "mini-supervisor.mjs");
    writeFileSync(supScript, supSource);

    const sup = spawnInProcessGroup(execPath, [supScript], { stdio: ["ignore", "pipe", "pipe"] });
    let childPid = 0;
    sup.stdout.setEncoding("utf8");
    sup.stdout.on("data", (d) => {
      const n = Number(String(d).trim());
      if (n > 0) childPid = n;
    });

    // The supervisor dies by itself at 400 ms; wait for it to be gone.
    await Promise.race([once(sup, "exit"), new Promise((r) => setTimeout(r, 5_000))]);
    assert.ok(childPid > 0, "mini-supervisor never reported its child's pid");

    const deadline = Date.now() + 10_000;
    let text = "";
    let stillServing = true;
    while (Date.now() < deadline) {
      try {
        text = readFileSync(durable, "utf8");
      } catch {
        text = "";
      }
      if (/orphaned/.test(text) && !alive(childPid)) {
        stillServing = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(stillServing, false, `child pid ${childPid} was still serving 10s after its supervisor died`);
    assert.match(text, /"ev":"ready"/, "child never marked itself up");
    // The wording below is the watchdog's, written through its durable sink — the fixture cannot produce it.
    assert.match(text, /orphaned \(reparented-to-init\)/, "no durable record of the orphaning: invisible once the pipe dies (#125)");

    sup.kill("SIGKILL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// #196 — early exit and stream release.
//
// Measured before this change (isolated fleet, piped stdio): factory children settled at ~189 ms, the
// adapter at ~224 ms, and the supervisor still exited at 3213 ms — the coordinator had no path to ask
// "is there anything left to wait for?", so the bound was paid in full every shutdown. Two halves:
//   * the coordinator exits early once `settled()` says nothing is alive (deadline stays as the backstop);
//   * the supervisor releases the child stdio read ends on every exit path, so a writer still blocked at
//     the deadline gets EPIPE instead of hanging on a pipe whose reader is gone.

// Mirrors the supervisor's real wiring: settled means no live children AND no group teardown in flight.
// `terminate` opens a teardown (the child is still alive); `childExited` drops it from the live set, as the
// exit handler does; `settle` resolves one group teardown, as the .finally does. Both call maybeExitEarly,
// exactly like the production wiring — early exit can come from either edge.
function earlyExitHarness({ graceMs = 1_000, children = ["factory:a", "adapter"] } = {}) {
  const events = [];
  let live = [...children];
  let pendingTeardowns = 0;
  let forcedSettled = null;
  let pendingTimer = null;
  const coord = createShutdownCoordinator({
    tracked: () => live,
    settled: () => (forcedSettled ?? (live.length === 0 && pendingTeardowns === 0)),
    terminate: (key) => {
      events.push(`term:${key}`);
      pendingTeardowns += 1;
    },
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
    clearTimer: () => events.push("clear-timer"),
  });
  return {
    coord,
    events,
    childExited: (key) => {
      live = live.filter((k) => k !== key);
      coord.maybeExitEarly();
    },
    settle: () => {
      pendingTeardowns = Math.max(0, pendingTeardowns - 1);
      coord.maybeExitEarly();
    },
    setSettled: (b) => { forcedSettled = b; },
    fireTimer: () => pendingTimer?.fn(),
  };
}

test("a shutdown with nothing left to wait for exits immediately (#196)", () => {
  const h = earlyExitHarness({ children: [] }); // nothing tracked → settled from the start
  h.coord.begin("received SIGTERM");
  assert.ok(h.events.includes("exit:0"), "no tracked children → no reason to pay the deadline: " + h.events.join(" | "));
  assert.ok(h.events.includes("clear-timer"), "the armed deadline must not outlive the process");
  assert.ok(h.events.indexOf("clear-timer") < h.events.indexOf("exit:0"), "timer cleared before exit");
});

test("early exit waits for BOTH edges — last child out AND last teardown resolved (#196)", () => {
  const h = earlyExitHarness();
  h.coord.begin("received SIGTERM");
  assert.ok(!h.events.some((e) => e.startsWith("exit:")), "nothing settled → no exit yet");

  h.childExited("factory:a"); // one child gone, but its group teardown is still in flight
  assert.ok(!h.events.some((e) => e.startsWith("exit:")), "a live child or an in-flight teardown means wait");
  h.settle(); // that group confirmed empty — the other child is still alive
  assert.ok(!h.events.some((e) => e.startsWith("exit:")), "the other child is still alive → still no exit");

  h.childExited("adapter"); // last child out, but its teardown is still in flight
  assert.ok(!h.events.some((e) => e.startsWith("exit:")), "exiting before the group is confirmed empty would orphan grandchildren (#125)");
  h.settle(); // everything settled — this edge exits
  assert.ok(h.events.includes("exit:0"), h.events.join(" | "));
  assert.ok(h.events.includes("clear-timer"), "the bound is cleared, not merely ignored");
  assert.ok(h.events.indexOf("clear-timer") < h.events.indexOf("exit:0"));
});

test("maybeExitEarly is a no-op while anything is still alive, and outside the graceful phase (#196)", () => {
  const h = earlyExitHarness();
  h.coord.begin("received SIGTERM");
  h.coord.maybeExitEarly(); // settled=false: a live child or an in-flight teardown means wait
  assert.ok(!h.events.some((e) => e.startsWith("exit:")), "must not exit while unsettled");
  const h2 = earlyExitHarness();
  h2.setSettled(true);
  h2.coord.maybeExitEarly(); // settled but never began — nothing to exit
  assert.ok(!h2.events.some((e) => e.startsWith("exit:")));
});

test("early exit carries the give-up exit code (#196)", () => {
  const h = earlyExitHarness({ children: [] }); // siblings already dead; nothing to wait for
  h.coord.begin("all managed repos quarantined", { exitCode: 1 });
  assert.ok(h.events.includes("exit:1"), "a give-up that settles fast still looks like a failure: " + h.events.join(" | "));
});

test("without a settled() dependency the old behavior holds: the deadline is paid in full (#196 regression guard)", () => {
  const h = harness(); // no settled dep → default false
  h.coord.begin("received SIGTERM");
  assert.ok(!h.events.some((e) => e.startsWith("exit:")), "no early exit without settlement knowledge");
  h.fireTimer();
  assert.ok(h.events.includes("exit:0"));
});

// ---------------------------------------------------------------------------
// #196 lifecycle: real processes, asserted on observable effects.
// A child that writes continuously into its stdout pipe, TERMINATED mid-burst, must reach its handler and
// exit promptly while the parent keeps draining — and releasing our read end must hand a stuck writer an
// error instead of a hang. Stubs cannot answer these questions; real processes do.

const DRAIN_DIR = mkdtempSync(join(tmpdir(), "drain-196-"));
const drainMark = (name) => join(DRAIN_DIR, name);

/** 8 KB log line every 10 ms — fills a 64 KB pipe buffer in well under a second when nobody drains. */
function writerSource(markPath, { handleSigterm } = {}) {
  return `
import { appendFileSync } from "node:fs";
const t0 = Date.now();
const pad = "x".repeat(8192);
const mark = (m) => appendFileSync(${JSON.stringify(markPath)}, JSON.stringify({ ms: Date.now() - t0, m }) + "\\n");
const writeLine = (m, done) => process.stdout.write(JSON.stringify({ ms: Date.now() - t0, m }) + " " + pad + "\\n", (err) => {
  if (err) { mark("write-errored:" + err.code); }
  if (done) done(err);
});
let n = 0;
setInterval(() => writeLine("tick " + (++n), (err) => { if (err) process.exit(3); }), 10);
mark("child-boot");
${handleSigterm ? `
process.on("SIGTERM", () => {
  mark("handler-entered");
  writeLine("sigterm-log", (err) => {
    mark(err ? "sigterm-write-errored:" + err.code : "sigterm-write-ok");
    setTimeout(() => process.exit(0), 20);
  });
});` : `
// No SIGTERM handler: this child can only leave through the write error, which is what the test asserts on.`}
`;
}

function readMarks(path) {
  try {
    return String(readFileSync(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function waitForMark(path, marker, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readMarks(path).some((m) => m.m === marker)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("a child writing continuously reaches its SIGTERM handler and exits promptly while we keep draining (#196)", async () => {
  const markPath = drainMark("handled.jsonl");
  const child = spawn(execPath, ["-e", writerSource(markPath, { handleSigterm: true })], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let drainedBefore = 0;
  let drainedAfter = 0;
  let termAt = 0;
  child.stdout.on("data", (d) => ((termAt ? (drainedAfter += d.length) : (drainedBefore += d.length))));
  child.stderr?.resume();

  assert.ok(await waitForMark(markPath, "child-boot"), "child booted");
  await new Promise((r) => setTimeout(r, 300)); // mid-burst: the pipe is actively carrying data
  const tTerm = Date.now();
  termAt = 1;
  child.kill("SIGTERM");
  const res = await Promise.race([
    new Promise((res) => child.on("exit", (code, signal) => res({ code, signal }))),
    new Promise((r) => setTimeout(() => r(null), 5_000)),
  ]);
  const latency = Date.now() - tTerm;

  assert.ok(res, `child exited within 5 s of SIGTERM (latency ${latency} ms)`);
  assert.ok(latency < 2_000, `child exited before the deadline it would otherwise have waited out: ${latency} ms`);
  const marks = readMarks(markPath).map((m) => m.m);
  assert.ok(marks.includes("handler-entered"), "the handler ran — a drained pipe is what let it: " + marks.join(", "));
  assert.ok(marks.includes("sigterm-write-ok"), "the handler's own log write completed");
  assert.ok(drainedAfter > 0, `parent kept draining after the signal (${drainedAfter} bytes) — that is the fix`);
});

test("releasing our read end hands a stuck writer an error instead of a hang (#196)", async () => {
  const markPath = drainMark("stuck.jsonl");
  const child = spawn(execPath, ["-e", writerSource(markPath, { handleSigterm: false })], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {}); // flowing mode: we are draining
  child.stderr?.resume();

  assert.ok(await waitForMark(markPath, "child-boot"), "child booted");
  await new Promise((r) => setTimeout(r, 300));
  // Stop reading: no data listener means the stream pauses and the kernel buffer fills — this is the
  // "nobody is draining" state. (A listener that ignores its bytes would still drain, which is exactly
  // the mistake this test exists to keep honest.)
  child.stdout.removeAllListeners("data");
  child.stdout.pause();
  await new Promise((r) => setTimeout(r, 500));

  const tRelease = Date.now();
  releaseChildStreams([child.stdout]); // the real supervisor exit-path code
  const res = await Promise.race([
    new Promise((res) => child.on("exit", (code, signal) => res({ code, signal }))),
    new Promise((r) => setTimeout(() => r(null), 5_000)),
  ]);
  const latency = Date.now() - tRelease;

  assert.ok(res, `stuck writer left within 5 s of the release (latency ${latency} ms)`);
  assert.equal(res.code, 3, "left through the write error, not some other path: " + JSON.stringify(res));
  const marks = readMarks(markPath).map((m) => m.m);
  const errored = marks.find((m) => /^write-errored:/.test(m));
  assert.ok(errored, "the writer's write failed instead of hanging: " + marks.join(", "));
  assert.match(errored, /EPIPE|DESTROYED/, "the failure names the closed pipe, not a mystery");
});

test("releasing already-ended streams is a no-op (normal exit path) (#196)", async () => {
  const child = spawn(execPath, ["-e", "process.stdout.write('done')"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr?.resume();
  await new Promise((res) => child.on("exit", () => res(null)));
  assert.doesNotThrow(() => releaseChildStreams([child.stdout, child.stderr]), "a normal exit must not error on release");
});
