// Supervisor shutdown state machine (#110, #125 → #127).
//
// Two defects this replaces, both observed live on 2026-11-01:
//
// 1. **A second signal did nothing.** The old handler opened with `if (shuttingDown) return`, so the first
//    `SIGTERM` armed a 3 s deadline and every later one was swallowed — including the one an operator sends
//    when the first appears not to have worked. Reproduced as "still alive after >8 s against a 3 s bound".
//    A repeated signal is a request to stop *now*, so it stops now.
//
// 2. **"Giving up" was not a shutdown.** When a child exceeded its restart budget the supervisor set
//    `shuttingDown = true` and returned: no child signalled, no exit armed, process left running with a dead
//    factory behind a liveness-only `/health`. Alive after >24 s across six checks while answering health
//    probes. Giving up is a failure that must leave the process gone and non-zero, because a scheduler that
//    sees a live pid will not restart it and GitHub deliveries keep arriving at an adapter with nothing to
//    dispatch to — permanently lost, since GitHub does not retry failed deliveries.
//
// The machine is extracted from `supervisor.ts` so these transitions are testable without booting the fleet:
// every side effect (signalling groups, clearing restart timers, releasing the lock, exiting) is injected.

export type ShutdownPhase = "running" | "graceful";

export interface ShutdownDeps {
  /** Keys of currently-tracked children to take down. Children that already exited must not appear. */
  tracked: () => string[];
  /** `SIGTERM` (with escalation) one child's process group. Async teardown is fire-and-forget here. */
  terminate: (key: string) => void;
  /** `SIGKILL` one child's process group immediately — used by the second signal. */
  forceKill: (key: string) => void;
  /** Clear pending restart timers so nothing spawns into a teardown in progress. */
  stopRestarts: () => void;
  /** Release the single-instance lock (#108) before waiting, so a replacement is not told "already running". */
  releaseLock: () => void;
  exit: (code: number) => void;
  log: (line: string) => void;
  /** Hard bound on teardown. Deliberately short: the whole complaint was an unbounded shutdown. */
  graceMs?: number;
  /** Injectable timer so tests are not paced by a real 3 s wait. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export interface ShutdownCoordinator {
  /**
   * Begin teardown. First call: stop restarts, release the lock, `SIGTERM` every child group, arm the bounded
   * exit. Any later call exits immediately and `SIGKILL`s what is left.
   */
  begin: (reason: string, opts?: { exitCode?: number }) => void;
  /** True once teardown has started — child exit handlers consult this to suppress restarts. */
  isShuttingDown: () => boolean;
  /** Introspection for logs and tests. */
  state: () => { phase: ShutdownPhase; requests: number; reason?: string; exitCode: number };
}

export function createShutdownCoordinator({
  tracked,
  terminate,
  forceKill,
  stopRestarts,
  releaseLock,
  exit,
  log,
  graceMs = 3_000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
}: ShutdownDeps): ShutdownCoordinator {
  let phase: ShutdownPhase = "running";
  let requests = 0;
  let reason: string | undefined;
  let exitCode = 0;

  return {
    begin(why, opts) {
      requests += 1;

      if (phase === "graceful") {
        // Second (or third) request. Do not re-arm a deadline that is already running — the operator has
        // stopped waiting for it. Kill the trees and go.
        log(
          `[supervisor] teardown request #${requests} (${why}) while already shutting down (${reason}) — ` +
            `exiting immediately and SIGKILLing ${tracked().length} child group(s)`,
        );
        for (const key of tracked()) forceKill(key);
        exit(exitCode);
        return;
      }

      phase = "graceful";
      reason = why;
      exitCode = opts?.exitCode ?? 0;
      log(`[supervisor] shutting down (${why})`);

      // Order matters. Restarts stop first: a child that dies during teardown must not be respawned into a
      // process on its way out, which is how you get a group nobody owns. Then the lock goes before we wait,
      // so a replacement starting one second from now competes with a live-but-closing process rather than
      // being refused by a lock we no longer intend to hold.
      stopRestarts();
      releaseLock();

      const groups = tracked();
      for (const key of groups) terminate(key);
      if (groups.length > 0) {
        log(`[supervisor] terminating ${groups.length} child process group(s): ${groups.join(", ")}`);
      }

      // Deliberately NOT unref'd, and never cleared: this timer is the bound. An unref'd deadline let the
      // process linger on whatever handle a child left open — that is how a supervisor sat alive 13 s after
      // logging "shutting down" and had to be SIGKILLed, which is what orphans children (#125).
      setTimer(() => exit(exitCode), graceMs);
    },

    isShuttingDown: () => phase === "graceful",

    state: () => ({ phase, requests, reason, exitCode }),
  };
}
