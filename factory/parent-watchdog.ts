// Reparent watchdog for fleet children (#125, code half of #127).
//
// The supervisor cannot clean up after `SIGKILL` — no handler runs in a dead process. So the surviving
// half of the guarantee has to live in the child: an instance that discovers it has lost its supervisor
// stops serving instead of sitting at `ppid 1` with the durable store open, invisible to `routes.json`.
//
// Why the child self-terminating is the cheap and correct answer here: a false positive costs one respawn
// (the supervisor restarts children on a 5 s backoff; the harness recovers its state from sqlite — that is
// crash-durability's whole purpose). A false negative costs two harnesses over one `agent.sqlite`, which is
// unsafe by construction regardless of what `pragma quick_check` says afterwards.
//
// The watchdog arms **only** when the supervisor identifies itself via `FACTORY_SUPERVISOR_PID`. A manual
// foreground run (`node --experimental-strip-types factory/main.ts …` from a shell) has no supervisor to be
// loyal to, and killing itself when its shell exits would be surprising at best. So absence of the variable
// means "not armed", never "armed with an unknown pid".

import { appendFileSync } from "node:fs";

/** Who we think our supervisor is. Invalid/absent/self-referential values mean "not armed". */
export function parseSupervisorPid(raw: string | number | null | undefined, selfPid: number = process.pid): number | null {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  // A supervisor that claims to be the child itself (or a child that inherits its own pid) is nonsense;
  // arming on that would watch nothing and fire on everything.
  if (value === selfPid) return null;
  return value;
}

/** Default liveness probe: `kill(pid, 0)`. EPERM means it exists and belongs to someone else — alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type OrphanReason = "reparented-to-init" | "supervisor-exited" | "reparented-elsewhere";

/**
 * Decide whether this process has been orphaned. Pure — takes ppid/liveness as arguments so the rule is
 * testable without killing anything, and so a host with different reparenting behavior can be probed
 * directly rather than inferred from a stuck instance hours later.
 *
 * `ppid` must come from `process.ppid` at call time: it is the only field that moves when a parent dies.
 */
export function detectOrphan(
  supervisorPid: number | null,
  { ppid = process.ppid, isAlive = isPidAlive }: { ppid?: number; isAlive?: (pid: number) => boolean } = {},
): OrphanReason | null {
  if (supervisorPid === null) return null;
  if (ppid === supervisorPid) return null; // still parented to who we expect
  if (ppid === 1) return "reparented-to-init"; // launchd/systemd adopted us: the supervisor is gone
  if (!isAlive(supervisorPid)) return "supervisor-exited";
  // ppid is neither our supervisor nor init, and the supervisor pid still answers. Rare (an intermediate
  // wrapper exited, a debugger attached). Treated as orphaned: the contract "my supervisor can reach me"
  // no longer holds, and the failure mode we are preventing is an invisible second harness.
  return "reparented-elsewhere";
}

export interface ParentWatchdogOptions {
  /** Raw `FACTORY_SUPERVISOR_PID` (or a number in tests). Absent/garbage means the watchdog stays off. */
  supervisorPid?: string | number | null;
  /** What to print, e.g. `[factory] lalanikarim/drydock`. */
  label: string;
  /** Called once when orphaned — run the process's own graceful shutdown from here. */
  onOrphaned: (info: { reason: OrphanReason; ppid: number; supervisorPid: number }) => void | Promise<void>;
  intervalMs?: number;
  /**
   * Append the orphan line here as well as logging it (best effort). This exists because of a live finding:
   * the supervisor pipes a child's stdout, so when the supervisor dies the pipe dies with it and the one log
   * line explaining "an instance nobody dispatched" is written into a broken pipe and lost. Observed on a real
   * SIGKILL — the child closed its store cleanly (sqlite `-wal`/`-shm` were checkpointed away) and produced no
   * trace at all. A durable copy in the instance directory is what makes the event visible after the fact.
   */
  durableLogPath?: string;
  /**
   * Grace before the first check. Without it a child can observe its own startup race — or, worse, tear
   * itself down while the supervisor's `SIGTERM` is still being handled gracefully two seconds away.
   */
  firstCheckDelayMs?: number;
  log?: (line: string) => void;
  /** Injectable probes for tests. */
  ppidFn?: () => number;
  isAlive?: (pid: number) => boolean;
}

/**
 * Start watching for orphaning. Returns a stop function (call it on graceful shutdown so the timer does not
 * outlive the reason for its existence, and so it never fires after `close()` has completed).
 */
export function startParentWatchdog(opts: ParentWatchdogOptions): () => void {
  const supervisorPid = parseSupervisorPid(opts.supervisorPid);
  if (supervisorPid === null) return () => {};

  const intervalMs = opts.intervalMs ?? 2_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  const ppidFn = opts.ppidFn ?? (() => process.ppid);
  const isAlive = opts.isAlive ?? isPidAlive;

  let stopped = false;
  let fired = false;
  let timer: NodeJS.Timeout | undefined;

  const check = async () => {
    if (stopped || fired) return;
    const reason = detectOrphan(supervisorPid, { ppid: ppidFn(), isAlive });
    if (!reason) return;
    fired = true;
    if (timer) clearInterval(timer);
    // Loud and on one line, because this is the log line that explains an instance nobody dispatched.
    const line =
      `[${opts.label}] orphaned (${reason}): supervisor pid ${supervisorPid} is gone, my ppid is ${ppidFn()} — ` +
      `exiting rather than serving unmanaged (#127). Runbook §7: check for other instances on this store.`;
    // Both sinks are best-effort. A dead stdout pipe must never abort the shutdown below — writing to a pipe
    // whose reader is gone raises EPIPE, and an exception thrown here would take the process down mid-teardown
    // instead of letting it close its durable store.
    try {
      log(line);
    } catch {
      /* supervisor died with the pipe; the durable copy is the record */
    }
    if (opts.durableLogPath) {
      try {
        appendFileSync(opts.durableLogPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* never let recording the event be the reason the event goes unhandled */
      }
    }
    try {
      await opts.onOrphaned({ reason, ppid: ppidFn(), supervisorPid });
    } catch (e) {
      log(`[${opts.label}] orphan shutdown failed: ${(e as Error).message}`);
      process.exit(1);
    }
  };

  const arm = () => {
    timer = setInterval(() => void check(), intervalMs);
    // Never hold the event loop open for this: a child that is closing must be able to close.
    timer.unref?.();
  };

  if (opts.firstCheckDelayMs && opts.firstCheckDelayMs > 0) {
    const t = setTimeout(() => {
      if (!stopped) arm();
    }, opts.firstCheckDelayMs);
    t.unref?.();
    return () => {
      stopped = true;
      clearTimeout(t);
      if (timer) clearInterval(timer);
    };
  }
  arm();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/** The env var the supervisor sets so children know who is responsible for them. */
export const SUPERVISOR_PID_ENV = "FACTORY_SUPERVISOR_PID";
