// Process-group ownership for fleet children (#125, code half of #127).
//
// Why this exists: `kill -9` is how deploys currently finish, because shutdown itself is not bounded
// (#110). A SIGKILLed supervisor runs no handler, so its instance children were reparented to launchd and
// kept serving — HTTP up, `agent.sqlite` open, invisible to `routes.json`, which pointed at their
// replacement. Two harnesses over one durable store diverge on in-memory state (refusal budgets #100,
// capabilities read back at boot #121, task graphs) even while SQLite keeps the bytes intact. Detection
// shipped in runbook §7; this module is prevention.
//
// The mechanism: spawn each child `detached: true` so it becomes its own **process group leader**
// (pgid === child pid). That gives us a single address — the group — which reaches grandchildren the
// instance itself spawned (verification runs test subprocesses; signalling only the direct child leaves
// them behind, which is this bug in miniature).
//
// Members are enumerated with `pgrep -g <pgid>` and signalled individually rather than blind-firing at
// `kill(-pgid)`. A negative-pid signal is correct right up until the group has been reaped and its id
// recycled, at which point it hits an unrelated process group; enumerating first makes "no survivors" a
// fact we can check instead of an assumption we hope in. `pgrep` exists on macOS and Linux; where it does
// not, callers get the negative-pid fallback and are told about it in the result.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Members of a process group, empty when there are none (or the probe could not run). */
export type GroupProbe = (pgid: number) => number[];

/** Default probe: `pgrep -g <pgid>` → pids. Returns [] for "no members" and "tool unavailable". */
export function listProcessGroup(pgid: number): number[] {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const res = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
  if (res.error || res.status === null) return [];
  // pgrep exits 1 for "no matches", which is not an error condition here.
  return String(res.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

/** True when `pgrep` is usable on this host, so callers know whether group membership is observable. */
export function canEnumerateProcessGroups(): boolean {
  const res = spawnSync("pgrep", ["-g", String(process.pid)], { encoding: "utf8" });
  return !res.error && res.status !== null;
}

/**
 * Spawn a child as its own process group leader.
 *
 * `detached` is doing one specific job here — making the child's pgid equal to its pid so the whole tree
 * can be addressed later — and is not about detaching from the terminal: stdio stays piped and the
 * supervisor keeps reading it.
 */
export function spawnInProcessGroup(command: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, { ...opts, detached: true });
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    // ESRCH = already gone (the common case during a race). Anything else is unexpected but still means
    // "this pid is not ours to signal", which teardown treats as settled.
    void e;
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TerminateOptions {
  /** How long the group gets to exit after `SIGTERM` before `SIGKILL`. */
  termGraceMs?: number;
  /** How long to wait for `SIGKILL` to land before reporting survivors. */
  killGraceMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Injectable for tests; defaults to `pgrep -g`. */
  probe?: GroupProbe;
}

export interface TerminateResult {
  pgid: number;
  /** Members found when teardown started (includes the group leader). */
  initial: number[];
  /** Still alive after TERM + KILL. Non-empty means the host, not this code, has a problem. */
  survivors: number[];
  /** Whether escalation to `SIGKILL` was needed. */
  escalated: boolean;
  /** Set when `pgrep` is unavailable and teardown fell back to signalling the group blindly. */
  blindGroupSignal: boolean;
}

/**
 * Terminate a process group: `SIGTERM` every member, wait, then `SIGKILL` whatever remains.
 *
 * Idempotent — an already-exited group has no members and this returns immediately. Never throws for
 * "already dead"; the whole point is that teardown calls it defensively and must not crash on a race.
 */
export async function terminateProcessGroup(
  pgid: number,
  { termGraceMs = 2_000, killGraceMs = 1_500, pollMs = 100, probe = listProcessGroup }: TerminateOptions = {},
): Promise<TerminateResult> {
  const initial = probe(pgid);
  const blindGroupSignal = initial.length === 0 && !canEnumerateProcessGroups();

  if (initial.length === 0) {
    // Nothing observable. Either the group is gone, or this host cannot enumerate groups and we signal it
    // blindly as the only available option. Signalling a recycled pgid is possible in that mode; it is
    // reported so an operator on such a host knows teardown is best-effort there.
    if (blindGroupSignal) signalPid(-pgid, "SIGTERM");
    return { pgid, initial, survivors: [], escalated: false, blindGroupSignal };
  }

  for (const pid of initial) signalPid(pid, "SIGTERM");

  const termDeadline = Date.now() + termGraceMs;
  while (Date.now() < termDeadline) {
    if (probe(pgid).length === 0) {
      return { pgid, initial, survivors: [], escalated: false, blindGroupSignal };
    }
    await sleep(pollMs);
  }

  const remaining = probe(pgid);
  for (const pid of remaining) signalPid(pid, "SIGKILL");

  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (probe(pgid).length === 0) {
      return { pgid, initial, survivors: [], escalated: true, blindGroupSignal };
    }
    await sleep(pollMs);
  }

  return { pgid, initial, survivors: probe(pgid), escalated: true, blindGroupSignal };
}

/** `SIGKILL` the group immediately, no grace. For a second operator signal — they have asked twice. */
export function killProcessGroupNow(
  pgid: number,
  { probe = listProcessGroup }: { probe?: GroupProbe } = {},
): { killed: number[]; survivors: number[] } {
  const members = probe(pgid);
  if (members.length === 0) {
    if (!canEnumerateProcessGroups()) signalPid(-pgid, "SIGKILL");
    return { killed: [], survivors: [] };
  }
  for (const pid of members) signalPid(pid, "SIGKILL");
  return { killed: members, survivors: probe(pgid) };
}
