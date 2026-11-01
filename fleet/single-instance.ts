// Single-instance guard for the fleet supervisor (#107).
//
// Why this exists: two supervisors were running at once (an old one survived a `kill` against the
// wrong pid). Each mints its own per-route instance token and rewrites `routes.json`, so they fought
// over shared state — churn → adapter drift refusal (503) → adapter exit → restart → churn again. The
// drift guard behaved correctly; two real issue dispatches were refused during the window and, because
// GitHub does NOT automatically redeliver failed webhook deliveries
// (https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), they were
// never delivered at all. Nothing in the process table hinted at it: the symptom was refused events
// an hour later.
//
// A lock file is enough, as long as it distinguishes "held by a live process" from "left behind by a
// crash". Reclaiming blindly would reintroduce the exact condition this prevents, so an unparsable
// lock is treated as held and the operator is told to look at it.

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface InstanceLock {
  acquired: boolean;
  path: string;
  /** Pid found inside a blocking lock file, when one could be read. */
  heldBy?: number;
  /** Human explanation — printed verbatim on refusal, asserted in tests. */
  reason: string;
  /** Remove the lock if (and only if) this handle created it. Idempotent. */
  release: () => void;
}

/** Default liveness probe: `kill(pid, 0)` — no signal sent, ESRCH means dead. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireInstanceLock(
  lockPath: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean; label?: string } = {},
): InstanceLock {
  const self = opts.pid ?? process.pid;
  const alive = opts.isAlive ?? isPidAlive;
  const label = opts.label ?? "supervisor";
  let owned = false;

  const refuse = (heldBy: number | undefined, why: string): InstanceLock => ({
    acquired: false,
    path: lockPath,
    heldBy,
    reason: why,
    release: () => {}, // not ours to remove
  });

  const tryCreate = (): boolean => {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600); // O_EXCL: creation is the claim, no read-then-write race
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e; // a real fs problem (read-only dir, bad path) must not look like "someone else holds it"
    }
    try {
      writeSync(fd, `${self}\n`);
    } finally {
      closeSync(fd);
    }
    owned = true;
    return true;
  };

  if (tryCreate()) {
    return {
      acquired: true,
      path: lockPath,
      reason: `instance lock held by pid ${self}`,
      release: () => {
        if (!owned) return;
        owned = false;
        try {
          unlinkSync(lockPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      },
    };
  }

  // Contended. Read the claimed owner and decide whether it is real.
  let raw: string | null = null;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    raw = null;
  }
  const pidRaw = (raw ?? "").trim();
  const pid = Number.parseInt(pidRaw, 10);
  const parsedPid = Number.isInteger(pid) && String(pid) === pidRaw ? pid : undefined;

  if (parsedPid === undefined) {
    return refuse(
      undefined,
      `${label} instance lock at ${lockPath} is not parsable (found ${JSON.stringify(pidRaw.slice(0, 40))}); refusing to start rather than assume it is stale. Inspect and remove that file if no ${label} is running`,
    );
  }
  if (alive(parsedPid)) {
    return refuse(
      parsedPid,
      `${label} already running as pid ${parsedPid} (lock: ${lockPath}); refusing to start a second one — concurrent supervisors rewrite the shared routes file with different per-route tokens, which makes every in-flight adapter refuse deliveries`,
    );
  }

  // Stale lock from a crashed run: reclaim once, then re-claim atomically. Another process may win
  // the race between unlink and create, so failure after reclaim is a genuine contention, not a bug.
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore; tryCreate below reports the real condition */
  }
  if (tryCreate()) {
    return {
      acquired: true,
      path: lockPath,
      reason: `reclaimed stale ${label} lock (previous pid ${parsedPid} is not running); held by pid ${self}`,
      release: () => {
        if (!owned) return;
        owned = false;
        try {
          unlinkSync(lockPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      },
    };
  }
  let racedPid: number | undefined;
  try {
    const t = readFileSync(lockPath, "utf8").trim();
    const p = Number.parseInt(t, 10);
    if (Number.isInteger(p)) racedPid = p;
  } catch {
    /* fall through */
  }
  return refuse(
    racedPid,
    `${label} lock at ${lockPath} was reclaimed from pid ${parsedPid} but immediately taken again (now ${racedPid ?? "unknown"}) — another supervisor is starting concurrently`,
  );
}

/** Where the lock lives: next to the routes file it protects, so two fleets do not share one lock. */
export function defaultLockPath(routesFile: string): string {
  return `${routesFile}.lock`;
}

/** Convenience for callers that only need "is something else home?". */
export function lockFileLooksLive(lockPath: string, isAlive: (pid: number) => boolean = isPidAlive): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    const t = readFileSync(lockPath, "utf8").trim();
    const p = Number.parseInt(t, 10);
    const st = statSync(lockPath);
    void st;
    return Number.isInteger(p) && isAlive(p);
  } catch {
    return false;
  }
}
