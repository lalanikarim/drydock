// Fleet supervisor (multi-repo plan §3.3), ported to TS for the core
// composition (issue #30, phase 3).
//
// One factory instance per managed repo (factory/main.ts) + one webhook
// adapter (factory/adapter.ts), started from a single fleet file.
// Restart-on-fault: the durable harness recovers in-process state from its
// sqlite db, so a plain respawn is safe — crash-durability is the core's
// property, exercised by gate G4. On Linux hosts this can be replaced by
// systemd units with the same one-unit-per-instance shape.
//
// Fleet file (JSON):
// {
//   "adapter":  { "port": 9700, "routesFile": "data/routes.json", "logPath": "data/intake-adapter.jsonl" },
//   "factories": [
//     { "repo": "owner/name", "config": "$DRYDOCK_CONFIG_DIR/owner_name.json",
//       "instancesRoot": "factory-instances", "token": "<32-hex>" }
//   "config" is optional: omitting it resolves the conventional path in the config dir, outside this repo.
//   ]
// }
//
// Instances bind ephemeral ports (core port 0); the supervisor learns the
// actual base from each child's "ready on http://127.0.0.1:<port>" stdout
// line and rewrites the adapter routes file whenever a factory (re)starts —
// the routes file is supervisor-owned, never hand-edited.
//
// Usage:
//   node --experimental-strip-types fleet/supervisor.ts run <fleet.json>
//   node --experimental-strip-types fleet/supervisor.ts status <fleet.json>

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { loadRootEnv, resolveWebhookSecret, webhookSecretVar } from "../factory/env-file.ts";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadRegistry, loadRegistryTolerant, missingRuntimeConfigs, requireEnabledRepo, DEFAULT_REGISTRY_PATH } from "../factory/repo-registry.ts";
import { acquireInstanceLock, defaultLockPath } from "./single-instance.ts";
import { readSweepState } from "./redeliver-failed.mjs";
import { defaultConfigPathFor } from "../factory/factory-config.ts";
import { createNotifier } from "../factory/notify-telegram.ts";
import { spawnInProcessGroup, terminateProcessGroup, killProcessGroupNow } from "./proc-group.ts";
import { createShutdownCoordinator } from "./shutdown-coordinator.ts";
import { SUPERVISOR_PID_ENV } from "../factory/parent-watchdog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
/**
 * Restart budget, overridable for tests (#185). Defaults are the production values and unchanged; the seams
 * exist because "quarantine after N boot failures" is otherwise a 50-second test, and a test that slow gets
 * skipped, which is worse than no test.
 */
const MAX_RESTARTS = readPositiveIntEnv("FACTORY_MAX_RESTARTS", 10);
const RESTART_BACKOFF_MS = readPositiveIntEnv("FACTORY_RESTART_BACKOFF_MS", 5_000);

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[supervisor] ignoring ${name}=${JSON.stringify(raw)} (not a non-negative number); using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}
const READY_RE = /ready on http:\/\/127\.0\.0\.1:(\d+)\/ /;

export interface FactoryEntry {
  repo: string;
  secret: string; // GitHub webhook secret for this repo (must match the repo's webhook config)
  config?: string;
  instancesRoot?: string;
  token?: string; // stable API_TOKEN for the instance (generated per boot when absent)
  allowedSenders?: string[]; // optional sender allowlist, carried into the routes file
}
interface AdapterEntry {
  port: number;
  routesFile: string;
  logPath?: string;
}
interface Fleet {
  adapter?: AdapterEntry;
  factories: FactoryEntry[];
}

/**
 * Atomically write the routes file and return its sha256.
 *
 * Atomicity matters because the adapter re-reads this file on every request to detect drift (#69):
 * a temp-file + rename means a reader sees either the old complete file or the new one, never a
 * half-written JSON document that would look like (and be treated as) policy. The returned hash is
 * what both sides log, so "which write does the running adapter not match?" is answerable from logs.
 */
export function writeRoutesFile(routesFile: string, routes: unknown): string {
  mkdirSync(dirname(routesFile), { recursive: true });
  const text = JSON.stringify(routes, null, 2);
  const tmp = `${routesFile}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, routesFile); // POSIX rename over an existing path is atomic
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Build the adapter's routes list (exported so the mapping is testable without spawning anything).
 *
 * `eligibilityLabel` is read from the registry rather than the fleet file, and this is the reason
 * stated in code: which label triggers work is policy (§5.11). If a deployment file could set it, a
 * typo there would silently stop every event for that repo while the adapter reported healthy —
 * exactly the failure mode intake had before per-repo labels were threaded through at all.
 */
export function buildRoutes(
  factories: FactoryEntry[],
  bases: Map<string, string>,
  registry: { repos: Array<{ repo: string; eligibilityLabel: string; prFeedback?: boolean; refine?: boolean; refineLabel?: string }> },
  env: NodeJS.ProcessEnv = process.env,
  quarantined: Map<string, string> = new Map(),
): Array<{
  repo: string;
  secret: string;
  target?: string;
  token?: string;
  allowedSenders?: string[];
  eligibilityLabel: string;
  prFeedback?: boolean;
  refine?: boolean;
  refineLabel?: string;
  quarantined?: string;
}> {
  return factories.map((f) => {
    const entry = registry.repos.find((r) => r.repo === f.repo);
    if (!entry) throw new Error(`buildRoutes: ${f.repo} is not in the repo registry`);
    return {
      repo: f.repo,
      // resolveWebhookSecret throws on an empty or placeholder value rather than handing the adapter
      // a string that would fail every HMAC check with an external-looking cause.
      secret: resolveWebhookSecret(f.repo, env, f.secret).secret,
      ...(bases.has(f.repo) ? { target: bases.get(f.repo)! } : {}),
      ...(f.token ? { token: f.token } : {}),
      ...(f.allowedSenders ? { allowedSenders: f.allowedSenders } : {}),
      eligibilityLabel: entry.eligibilityLabel,
      // Only written when enabled, so a route that never opted in keeps the exact shape it had before
      // #67 (absent means disabled; the adapter treats missing as false).
      ...(entry.prFeedback ? { prFeedback: true } : {}),
      // Same posture for refinement (#65): absent means off, and refineLabel travels only with it.
      ...(entry.refine ? { refine: true, refineLabel: entry.refineLabel ?? "refine" } : {}),
      // #185: a repo the supervisor gave up on stays in the routes file WITH its reason, so the adapter can
      // refuse its deliveries with 503 `repo_quarantined` instead of accepting work nobody will ever do.
      // Runtime state like `target`, and excluded from the policy fingerprint for the same reason.
      ...(quarantined.has(f.repo) ? { quarantined: quarantined.get(f.repo)! } : {}),
    };
  });
}

/**
 * Policy gate between the two config layers (§5.11): the fleet file says what should be RUNNING,
 * the repo registry says what is ALLOWED. Checking every fleet entry against the registry here means
 * a stale or hand-edited fleet file cannot start a factory for a repo policy does not permit —
 * unregistered, or registered but disabled — a repo can be checked in with policy recorded while not
 * being allowed to run. Runs before any child is spawned.
 */
export function checkRegistryPolicy(repos: string[], registryPath?: string): void {
  const registry = loadRegistry(registryPath);
  for (const repo of repos) requireEnabledRepo(registry, repo);
}

function loadFleet(path: string): Fleet {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read/parse fleet file ${path}: ${(e as Error).message}`);
  }
  const fleet = raw as Fleet;
  if (!Array.isArray(fleet.factories) || fleet.factories.length === 0) {
    throw new Error("fleet.factories must be a non-empty array");
  }
  for (const f of fleet.factories) {
    if (typeof f.repo !== "string" || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(f.repo)) {
      throw new Error(`factory entry has invalid repo: ${JSON.stringify(f)}`);
    }
    // Validate through the same helper buildRoutes uses, so "does this fleet boot?" and "what secret
    // will it actually sign with?" can never diverge. Prints the source, never the value.
    const { source } = resolveWebhookSecret(f.repo, process.env, f.secret);
    console.log(`[supervisor] ${f.repo}: webhook secret from ${source === "env" ? webhookSecretVar(f.repo) : "fleet file .secret"} (value not logged)`);
  }
  checkRegistryPolicy(fleet.factories.map((f) => f.repo));
  return fleet;
}

/**
 * Spawn a fleet child as its own process group leader (#127).
 *
 * `detached` here is not about running in the background — stdio stays piped and read below. It makes the
 * child's pgid equal to its pid, which gives teardown one address that also reaches grandchildren (a worker's
 * test subprocesses). Without it, a `SIGKILL`ed supervisor leaves children reparented to launchd and serving:
 * two harnesses over one durable store (#125).
 *
 * Children are told who their supervisor is (`FACTORY_SUPERVISOR_PID`) so they can notice orphaning on their
 * own — the only half of this that survives us being `SIGKILL`ed, since a dead process runs no handler.
 */
function spawnProc(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawnInProcessGroup(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, [SUPERVISOR_PID_ENV]: String(process.pid) },
  });
  const pump = (stream: NodeJS.ReadableStream, prefix: string) =>
    stream.on("data", (d: Buffer) => process.stdout.write(`[${name}] ${prefix}${String(d).replace(/\n$/, "")}\n`));
  // spawn() with pipe stdio always hands back both streams, but the type says `Readable | null`, and a missing
  // stream here would mean a child's logs silently never reach the supervisor (#173).
  if (child.stdout) pump(child.stdout, "");
  else console.error(`[${name}] child has no stdout pipe — its logs are lost`);
  if (child.stderr) pump(child.stderr, "err: ");
  else console.error(`[${name}] child has no stderr pipe — its errors are lost`);
  return child;
}

/**
 * Stop forwarding and close the read ends we own (#196). Called on every supervisor exit path through the
 * coordinator's `exit` seam. Destroying the read end is what a child blocked in `write(2)` is waiting for:
 * its next write fails with EPIPE instead of hanging on a pipe whose reader is gone — bounded teardown,
 * not a second hang. Safe to call on already-ended streams (a normal exit): destroy is then a no-op.
 */
export function releaseChildStreams(streams: Iterable<Readable>): void {
  for (const s of streams) {
    s.removeAllListeners("data");
    s.destroy();
  }
}

/** Resolve a fleet-file-relative path against the fleet file's directory. */
function rel(fleetPath: string, p: string): string {
  return resolve(dirname(fleetPath), p);
}

async function runFleet(fleetPath: string): Promise<void> {
  const fleet = loadFleet(fleetPath);

  // #143: the fleet died once because nobody could tell that a supervisor two days older than the tree it
  // reads was about to reject a field that new code had just added. Log what is running, in a form an
  // operator (or a gate) can compare against `git log -1` and `sha256sum factory/repo-registry.json`. The
  // sha also goes to children via DRYDOCK_BUILD_SHA so /health reports it and staleness is visible remotely.
  const buildSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
    } catch {
      return "unknown"; // a checkout without git (tarball, vendored copy) must not fail the boot
    }
  })();
  if (!process.env.DRYDOCK_BUILD_SHA) process.env.DRYDOCK_BUILD_SHA = buildSha;
  let registryDigest = "unreadable";
  try {
    registryDigest = createHash("sha256").update(readFileSync(DEFAULT_REGISTRY_PATH)).digest("hex").slice(0, 12);
  } catch {
    /* boot's strict read reports the real reason */
  }
  console.log(`[supervisor] build ${buildSha} · registry sha256:${registryDigest} · started ${new Date().toISOString()}`);

  // Pre-flight (#127-era config-out-of-tree): every repo in this fleet needs runtime config in
  // $DRYDOCK_CONFIG_DIR. Checked before the lock and before any route is written, so a fresh machine gets one
  // message naming every path it must create — instead of children that boot, fail, and respawn on a
  // five-second loop while routes point at ports that die.
  const missingCfgs = missingRuntimeConfigs(loadRegistry(), { repos: fleet.factories.map((f) => f.repo) });
  if (missingCfgs.length > 0) {
    console.error(`[supervisor] missing runtime config for ${missingCfgs.length} repo(s) in this fleet:`);
    for (const m of missingCfgs) console.error(`[supervisor]   ${m.repo} → ${m.path}`);
    console.error("[supervisor] copy factory/config.example.json to each path and set models + testCommand; nothing was started.");
    process.exit(1);
  }

  // Single-instance guard (#107), taken BEFORE the routes file is written. Two supervisors are not two
  // factories: each mints its own per-route instance token and rewrites the shared routes file, so they
  // take turns invalidating each other's adapter, and every delivery refused during that window is gone
  // for good — GitHub does not automatically redeliver failed webhook deliveries. The lock lives beside
  // the file it protects so a second fleet on another routes file is still allowed.
  const lockTarget = fleet.adapter ? rel(fleetPath, fleet.adapter.routesFile) : resolve(fleetPath);
  const lockPath = process.env.FACTORY_SUPERVISOR_LOCK?.trim() || defaultLockPath(lockTarget);
  const lock = acquireInstanceLock(lockPath, { label: "supervisor" });
  if (!lock.acquired) {
    console.error(`[supervisor] ${lock.reason}`);
    console.error(`[supervisor] refusing to start; nothing was written to ${lockTarget}`);
    process.exit(1);
  }
  console.log(`[supervisor] ${lock.reason} (lock: ${lockPath})`);

  const restarts = new Map<string, number>();
  /** key -> pid of a live child. Each pid is also its process group id (#127). */
  const managed = new Map<string, number>();
  /**
   * key -> the child's stdio streams we own (#196). They are drained for the child's whole life — a child
   * blocked writing a log line into an undrained pipe never reaches its SIGTERM handler — and released on
   * every exit path, so that at the deadline a still-blocked writer gets EPIPE instead of hanging on a pipe
   * whose reader is gone.
   */
  const childStreams = new Map<string, Readable[]>();
  /** Group teardowns begun by THIS shutdown; early exit waits for all of them (grandchildren included). */
  let pendingTeardowns = 0;
  const settled = () => managed.size === 0 && pendingTeardowns === 0;

  /** Stop forwarding and close the read ends we own, on every supervisor exit path (#196). See releaseChildStreams. */
  const releaseAllChildStreams = () => {
    for (const streams of childStreams.values()) releaseChildStreams(streams);
    childStreams.clear();
  };
  /**
   * repo -> why it stopped booting (#185). Sticky for the life of this process: nothing here can fix a bad
   * config file, so re-spawning is waste and re-alerting is noise. Cleared only by a supervisor restart, which
   * is also the moment the operator has been told about again.
   */
  const quarantined = new Map<string, string>();
  /** key -> last non-empty stderr line from a child, used as the quarantine reason in logs and alerts. */
  const lastFault = new Map<string, string>();
  /** Pending restart timers, so teardown can guarantee nothing spawns into a shutdown in progress. */
  const restartTimers = new Set<ReturnType<typeof setTimeout>>();
  // repo -> base URL once the instance reports ready (for the routes file).
  const bases = new Map<string, string>();

  /** Wait for the process group to actually disappear, then log what did not (#127). */
  const reportGroup = (key: string, result: Awaited<ReturnType<typeof terminateProcessGroup>>) => {
    if (result.survivors.length > 0) {
      console.error(`[supervisor] ${key}: ${result.survivors.length} process(es) survived SIGTERM+SIGKILL in group ${result.pgid}: ${result.survivors.join(", ")} — check for a second harness on this store (runbook §7)`);
    } else if (result.initial.length > 1) {
      console.log(`[supervisor] ${key}: group ${result.pgid} fully stopped (${result.initial.length} process(es), escalated=${result.escalated})`);
    }
  };

  // Operator alerts for supervisor-level infrastructure events (#185). Same notifier the instances use, so a
  // quarantine and an inference outage arrive through one channel with one dedupe policy. Undefined when
  // credentials are absent — "alerts disabled" stays an explicit state rather than a silent no-op.
  const notify = createNotifier({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    log: (line) => console.log(`[supervisor] ${line}`),
  });
  if (!notify) {
    console.warn("[supervisor] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — supervisor alerts (quarantine, #185) are disabled");
  }

  // The shutdown state machine lives in ./shutdown-coordinator.ts; this is the wiring to real processes.
  const coordinator = createShutdownCoordinator({
    tracked: () => [...managed.keys()],
    settled,
    terminate: (key) => {
      const pid = managed.get(key);
      if (pid === undefined) return; // reaped between begin()'s snapshot and this call — nothing to wait for
      pendingTeardowns += 1;
      // Fire-and-forget on purpose: the coordinator's bounded exit timer is what ends this process, and a
      // teardown that awaits each group serially would blow past that bound. The finally is what lets early
      // exit know the group is confirmed empty — exiting before that would orphan grandchildren (#125).
      void terminateProcessGroup(pid)
        .then((r) => reportGroup(key, r), (e) => console.error(`[supervisor] ${key}: group teardown failed: ${(e as Error).message}`))
        .finally(() => {
          pendingTeardowns -= 1;
          coordinator.maybeExitEarly();
        });
    },
    forceKill: (key) => {
      const pid = managed.get(key);
      if (pid === undefined) return;
      killProcessGroupNow(pid);
    },
    stopRestarts: () => {
      for (const t of restartTimers) clearTimeout(t);
      restartTimers.clear();
    },
    releaseLock: () => lock.release(),
    // Every exit path — early, deadline, second signal, give-up — goes through here, so the streams are
    // released exactly once and a child blocked writing is handed EPIPE rather than an orphaned pipe (#196).
    exit: (code) => {
      releaseAllChildStreams();
      process.exit(code);
    },
    log: (line) => console.log(line),
  });

  // The routes file lists ALL factories from boot (secret known up front) so
  // the adapter validates cleanly before any instance is ready; `target` is
  // filled in when an instance reports its ephemeral port and removed on exit.
  //
  // #143 — this closure runs from a child's "exit" handler and from restart timers, and it used to call
  // `loadRegistry()` with no error handling. When #140 added `webhookId`, a supervisor running the previous
  // build re-read the registry after a child died, hit `registry.repos[2]: unknown field: webhookId`, threw
  // inside that handler, and took every factory in the fleet down with it. Three separate mistakes in one
  // line: parsing policy strictly on a reload (a field it had not met was treated as invalid), letting that
  // throw escape a recovery path, and having no answer for "so what do we serve now?". Now:
  //
  //   * reloads are tolerant of unknown fields (warnings logged, never fatal);
  //   * ANY failure keeps the last-good routes file in place instead of leaving policy half-written;
  //   * failures announce on edges — first one and every 10th, plus a recovery line — because an alert that
  //     repeats every minute is not an alert, and silence here means stale routing forever;
  //   * boot is still strict: without a routes file there is nothing to keep serving, so it must not proceed.
  let routesDegraded = false;
  let lastGoodRoutes: { hash: string; at: string } | null = null;
  const writeRoutes = (why: string, opts: { strict?: boolean } = {}) => {
    if (!fleet.adapter) return;
    const routesFile = rel(fleetPath, fleet.adapter.routesFile);
    let registry: ReturnType<typeof loadRegistryTolerant>;
    try {
      registry = loadRegistryTolerant(DEFAULT_REGISTRY_PATH, (m) => {
        console.warn(`[supervisor] registry ignored a field (reload from ${why}): ${m}`);
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (opts.strict) {
        console.error(`[supervisor] FATAL: cannot read policy at boot (${msg}) — no routes file exists yet, refusing to start`);
        process.exit(1);
      }
      if (!routesDegraded) {
        console.error(`[supervisor] routes reload failed (${why}): ${msg}`);
        console.error(
          lastGoodRoutes
            ? `[supervisor] SERVING STALE POLICY — keeping routes written at ${lastGoodRoutes.at} (hash ${lastGoodRoutes.hash.slice(0, 16)}); fix the registry and restart children to adopt changes`
            : "[supervisor] no previous routes file to fall back on — existing adapter keeps whatever it last validated",
        );
        routesDegraded = true;
      } else {
        console.error(`[supervisor] routes still failing (${why}) — still serving ${lastGoodRoutes ? `hash ${lastGoodRoutes.hash.slice(0, 16)}` : "the adapter's last validated file"}`);
      }
      return;
    }
    const routes = buildRoutes(fleet.factories, bases, registry, process.env, quarantined);
    const hash = writeRoutesFile(routesFile, routes);
    if (routesDegraded) {
      console.log(`[supervisor] routes recovered after a failure — ${routes.length} route(s), hash ${hash.slice(0, 16)}`);
      routesDegraded = false;
    } else {
      console.log(`[supervisor] wrote ${routes.length} route(s) to ${routesFile} (hash ${hash.slice(0, 16)})`);
    }
    lastGoodRoutes = { hash, at: new Date().toISOString() };
  };

  // #69: the routes file is written BEFORE anything is spawned. The old seed-if-missing logic let a
  // leftover file from a previous run survive — the adapter then started against stale policy and
  // never re-read it. Overwriting unconditionally means every start begins from the current fleet.
  writeRoutes("boot", { strict: true });

  /**
   * Keep a fault line from a child's stderr to use as its quarantine reason (#185).
   *
   * "Last non-empty line" is wrong in exactly the case that matters: an uncaught throw ends its output with a
   * stack frame, so this incident's reason would have read `at async asyncRunEntryPointWithESMLoader
   * (node:internal/modules/run_main:117:5)` — found by running the test, not by imagining it. So: skip stack
   * frames, prefer a line that names an error, and let the latest such line win (the last failure is the
   * representative one). Anything else is kept only as a fallback, so a child that dies silently still yields
   * text rather than "exit code 1".
   */
  const FAULT_LINE_RE = /error|fatal|cannot|could not|refus|unknown|invalid|denied|EADDR|no such|not found/i;
  const rememberFault = (key: string, chunk: string) => {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^at\s/.test(line)) continue; // stack frames are noise in a one-line alert
      if (FAULT_LINE_RE.test(line) || !lastFault.has(key)) lastFault.set(key, line.slice(0, 300));
    }
  };

  /**
   * A child exhausted its restart budget (#127, blast radius fixed in #185).
   *
   * Non-zero exit was right when the supervisor supervised ONE factory: "gave up" has to look like a failure to
   * whatever watches pids, because the old behavior (set a flag, stay alive) let a scheduler see a healthy pid
   * while webhooks arrived at an adapter whose factory was dead — deliveries lost permanently, since GitHub
   * does not retry them. With N repos on one supervisor, applying that globally made repo A's bad config key a
   * fleet-wide kill switch: 2026-11-03, `_comment_setup` in engram's config took drydock down too, along with
   * the adapter — the one component that could have reported it.
   *
   * So the blast radius is now per-repo:
   *   - a factory quarantines itself: no more restarts, marked in routes.json so the adapter refuses its
   *     deliveries with 503 rather than accepting work nobody will do, one alert edge, siblings unaffected;
   *   - the supervisor exits only when nothing can serve — every repo quarantined, or the shared adapter dying.
   */
  const giveUp = (key: string) => {
    const attempts = restarts.get(key) ?? MAX_RESTARTS + 1;
    const repo = key.startsWith("factory:") ? key.slice("factory:".length) : undefined;

    if (!repo) {
      // Shared machinery: no adapter means no repo is served, so a supervisor with no route has no purpose.
      console.error(`[supervisor] ${key} exceeded ${MAX_RESTARTS} restarts — giving up and exiting non-zero`);
      coordinator.begin(`${key}: restart budget exhausted`, { exitCode: 1 });
      return;
    }

    if (quarantined.has(repo)) return; // already announced; quarantine is sticky, so a repeat is noise
    const reason = lastFault.get(key) ?? "instance exited before reporting a fault";
    quarantined.set(repo, reason);

    console.error(`[supervisor] QUARANTINE ${key} after ${attempts} failed boots: ${reason}`);
    console.error(`[supervisor] ${key} will not be restarted; ${fleet.factories.length - quarantined.size} of ${fleet.factories.length} repo(s) still served. Fix the cause and restart the supervisor (runbook §7).`);

    // Publish before alerting: "refused with 503" has to be true by the time the operator reads the message.
    writeRoutes(`quarantine:${repo}`);
    void notify?.({ kind: "repo_quarantined", repo, attempts, reason });

    if (fleet.factories.every((f) => quarantined.has(f.repo))) {
      console.error(`[supervisor] every managed repo is quarantined (${fleet.factories.length}) — nothing can serve, exiting non-zero`);
      coordinator.begin("all managed repos quarantined", { exitCode: 1 });
    }
  };

  /** Schedule a restart, tracked so teardown can prove nothing spawns after it. */
  const scheduleRestart = (fn: () => void) => {
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      if (coordinator.isShuttingDown()) return; // cancelled by teardown
      fn();
    }, RESTART_BACKOFF_MS);
    restartTimers.add(timer);
  };

  /**
   * A child that died on its own can leave its own children running, and those keep this repo's durable
   * store open while the replacement boots. Sweep the group before respawning (#127): the pid we just
   * reaped is the group id, so anything still alive inside it is a leftover of a process we owned.
   */
  const sweepLeftovers = (key: string, pid: number | undefined) => {
    if (!pid || pid < 0) return;
    void terminateProcessGroup(pid).then(
      (r) => {
        if (r.initial.length > 0) reportGroup(key, r);
      },
      (e) => console.error(`[supervisor] ${key}: leftover sweep failed: ${(e as Error).message}`),
    );
  };

  const startFactory = (f: FactoryEntry) => {
    const key = `factory:${f.repo}`;
    restarts.set(key, (restarts.get(key) ?? 0) + 1);
    if ((restarts.get(key) ?? 0) > MAX_RESTARTS) {
      giveUp(key);
      return;
    }
    if (quarantined.has(f.repo)) {
      // Defensive: quarantine means "stop", so no path may respawn it. Reaching this line would mean some
      // future refactor scheduled a restart behind giveUp's back, and silence here would hide that.
      console.error(`[supervisor] refusing to start ${key}: quarantined (${quarantined.get(f.repo)})`);
      return;
    }
    // Omitting "config" in the fleet file is now the normal case: the instance resolves the conventional
    // path itself ($DRYDOCK_CONFIG_DIR/<owner>_<repo>.json). Explicit paths remain for a deployment that
    // keeps config somewhere unusual — but never inside the source tree, which is what this change removed.
    const configPath = f.config ? rel(fleetPath, f.config) : defaultConfigPathFor(f.repo);
    const token = f.token ?? randomBytes(16).toString("hex");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      API_TOKEN: token,
      ...(f.instancesRoot ? { FACTORY_INSTANCES_ROOT: rel(fleetPath, f.instancesRoot) } : {}),
    };
    // Remember the token for the routes file even if the entry omitted one.
    (f as FactoryEntry & { token?: string }).token = token;
    const args = ["--experimental-strip-types", join(REPO_ROOT, "factory", "main.ts"), f.repo, "--config", configPath];
    console.log(`[supervisor] starting ${key} — attempt ${restarts.get(key)}`);
    const child = spawnProc(key, args, env);
    managed.set(key, child.pid ?? -1);
    childStreams.set(key, [child.stdout, child.stderr].filter((s): s is Readable => s !== null));
    // Second reader on the same stream (spawnProc's pump is the first and keeps logging): keep the fault text
    // so a quarantine can name the cause instead of "exit code 1" (#185).
    child.stderr?.on("data", (d: Buffer) => rememberFault(key, String(d)));
    let readySent = false;
    // Learn the ephemeral port from stdout and publish it to the routes file.
    child.stdout!.on("data", (d: Buffer) => {
      if (readySent) return;
      const m = String(d).match(READY_RE);
      if (m) {
        readySent = true;
        bases.set(f.repo, `http://127.0.0.1:${m[1]}`);
        writeRoutes(`ready:${f.repo}`);
      }
    });
    child.on("exit", (code, signal) => {
      const pid = managed.get(key);
      managed.delete(key);
      if (coordinator.isShuttingDown()) {
        coordinator.maybeExitEarly(); // the last child out is what may unblock early exit
        return;
      }
      bases.delete(f.repo);
      sweepLeftovers(key, pid);
      console.error(`[supervisor] ${key} exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
      scheduleRestart(() => startFactory(f));
    });
  };

  const startAdapter = () => {
    if (!fleet.adapter) return; // adapter is optional (single-factory dev mode)
    const key = "adapter";
    restarts.set(key, (restarts.get(key) ?? 0) + 1);
    if ((restarts.get(key) ?? 0) > MAX_RESTARTS) {
      giveUp(key);
      return;
    }
    const a = fleet.adapter!;
    // Rewrite immediately before spawning: the adapter hashes this file at start and on every
    // request (#69). A fresh write here means a restarted adapter always adopts current policy,
    // even if something external touched the file while it was down. Not strict: an adapter restart is
    // exactly the wrong moment to discover policy and die over a field shape (#143).
    writeRoutes("adapter-spawn");
    const routesFile = rel(fleetPath, a.routesFile);
    const args = ["--experimental-strip-types", join(REPO_ROOT, "factory", "adapter.ts"), String(a.port), routesFile, a.logPath ? rel(fleetPath, a.logPath) : join(dirname(routesFile), "intake-adapter.jsonl")];
    console.log(`[supervisor] starting ${key} (port ${a.port}) — attempt ${restarts.get(key)}`);
    const child = spawnProc(key, args, process.env);
    managed.set(key, child.pid ?? -1);
    childStreams.set(key, [child.stdout, child.stderr].filter((s): s is Readable => s !== null));
    child.on("exit", (code, signal) => {
      const pid = managed.get(key);
      managed.delete(key);
      if (coordinator.isShuttingDown()) {
        coordinator.maybeExitEarly(); // the last child out is what may unblock early exit
        return;
      }
      sweepLeftovers(key, pid);
      console.error(`[supervisor] ${key} exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
      scheduleRestart(startAdapter);
    });
  };

  for (const f of fleet.factories) startFactory(f);
  startAdapter();

  const handleDiagnostic = () => {
    const beganAt = Date.now();
    // #110 diagnostic: the lingering-handle cause is still unexplained, only bounded. If something is
    // keeping this process alive one second after teardown, say what it was instead of letting the 3s
    // deadline paper over it — that mystery is how a supervisor needed SIGKILL for a week.
    setTimeout(() => {
      const handles = (process as unknown as { _getActiveHandles?: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles?.() ?? [];
      if (handles.length === 0) return;
      const byType = new Map<string, number>();
      for (const h of handles) {
        const name = h?.constructor?.name ?? "unknown";
        byType.set(name, (byType.get(name) ?? 0) + 1);
      }
      console.log(`[supervisor] still alive ${Date.now() - beganAt}ms after shutdown with ${handles.length} active handle(s): ${[...byType.entries()].map(([k, v]) => `${v}×${k}`).join(", ")}`);
    }, 1_000).unref();
  };

  // Every signal goes to the coordinator (#110, #127). Previously the handler opened with `if (shuttingDown)
  // return`, so a second SIGTERM — the one an operator sends when the first seems not to have worked — was
  // swallowed, which is how a routine restart stayed alive past its bound and finished as `kill -9`. Now the
  // first signal asks the children politely and the second one does not ask: it SIGKILLs their groups and
  // exits immediately. The bounded-exit timer lives in the coordinator and is never unref'd or cleared.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      handleDiagnostic();
      coordinator.begin(`received ${signal}`);
    });
  }
}

async function statusFleet(fleetPath: string): Promise<void> {
  const fleet = loadFleet(fleetPath);
  // status reads the routes file (written by a live supervisor) to find bases.
  let routes: Array<{ repo: string; target?: string; token?: string }> = [];
  if (fleet.adapter) {
    try {
      routes = JSON.parse(readFileSync(rel(fleetPath, fleet.adapter.routesFile), "utf8"));
    } catch {
      console.error("routes file missing — is the supervisor running?");
      process.exit(1);
    }
  } else {
    console.error("status requires an adapter entry in the fleet file (it owns the routes file)");
    process.exit(1);
  }
  const rows = await Promise.all(routes.map(async (r) => {
    const row: Record<string, string> = { repo: r.repo, base: r.target ?? "(no target recorded)", state: "DOWN", pending: "" };
    try {
      const health = await fetch(`${r.target}/health`, { headers: { Authorization: `Bearer ${r.token ?? ""}` }, signal: AbortSignal.timeout(3_000) });
      if (!health.ok) throw new Error(`health ${health.status}`);
      row.state = "up";
      const approvals = await fetch(`${r.target}/approvals`, { headers: { Authorization: `Bearer ${r.token ?? ""}` }, signal: AbortSignal.timeout(5_000) }).then((x) => x.json());
      const pending = (approvals as { approvals?: Array<{ key?: string; tool?: string }> }).approvals ?? [];
      if (pending.length > 0) {
        row.state = "awaiting approval";
        row.pending = pending.map((p) => `${p.tool ?? "?"}:${p.key ?? "?"}`).join(", ");
      }
    } catch (e) {
      row.state = `DOWN (${(e as Error).message})`;
    }
    return row;
  }));
  const width = Math.max(...rows.map((r) => r.repo.length), 4);
  console.log(`${"repo".padEnd(width)}  ${"state".padEnd(18)}  pending`);
  for (const r of rows) {
    console.log(`${r.repo.padEnd(width)}  ${r.state.padEnd(18)}  ${r.pending}`);
  }

  // Failed-delivery sweep freshness (#110). GitHub does not retry failed deliveries, so "we have a
  // recovery tool" is worth nothing unless someone ran it — and the only way to find out at a glance
  // is for the status command to admit when it has never happened.
  const routesPath = rel(fleetPath, fleet.adapter!.routesFile);
  const sweepPath = process.env.FACTORY_SWEEP_STATE ?? join(dirname(routesPath), "last-sweep.json");
  const sweep = readSweepState(sweepPath);
  if (!sweep.ok) {
    // The reader returns a `reason` on every not-ok path, but it is JavaScript and the inferred type allows
    // undefined — so default rather than assert (#173). "undefined" printed here would be worse than useless.
    const why = sweep.reason ?? "unreadable";
    console.log(`\nfailed-delivery sweep: ${why === "never" ? "NEVER RECORDED" : why.toUpperCase()} — run fleet/redeliver-failed.mjs with --state-file ${sweepPath}`);
    return;
  }
  const st = sweep.state as {
    at: string;
    mode?: string;
    inspected?: number;
    undelivered?: number;
    queued?: number;
    since?: string | null;
    acknowledged?: number;
    // Present when the sweep ran with --from-registry (#107). Without it a finding on one repo reads as a
    // fleet-wide finding, and "which repo?" is the first question anyone asks.
    targets?: Array<{ repo: string; hookId?: number; inspected?: number; undelivered?: number; acknowledged?: number }>;
    untracked?: string[];
  };
  const ageMin = Math.round((Date.now() - Date.parse(st.at)) / 60_000);
  const stale = ageMin > 60 ? " ⚠ older than 1h" : "";
  // The window matters as much as the count: "undelivered 35" across all retained history is housekeeping,
  // "undelivered 35 in the last hour" is an incident.
  const window = st.since ? `since ${st.since}` : "all retained history";
  // Acknowledged failures are excluded from the alarm but must stay on the line: "0 undelivered" after
  // acknowledging 16 is a different claim than "0 undelivered" on a clean hook.
  const acked = st.acknowledged ? `, ${st.acknowledged} acknowledged` : "";
  console.log(`\nfailed-delivery sweep: ${ageMin} min ago (${st.mode ?? "?"}) — inspected ${st.inspected ?? "?"}, undelivered ${st.undelivered ?? "?"}, queued ${st.queued ?? 0}, ${window}${acked}${stale}`);
  // Per-repo breakdown, and an explicit line for enabled repos the sweep cannot see at all: a control that
  // covers two of three repos and reports "clean" is how engram stayed unswept without anyone noticing.
  if (Array.isArray(st.targets)) {
    for (const t of st.targets) {
      console.log(`  ${t.repo}: inspected ${t.inspected ?? "?"}, undelivered ${t.undelivered ?? 0}${t.acknowledged ? `, ${t.acknowledged} acknowledged` : ""}`);
    }
  }
  if (Array.isArray(st.untracked) && st.untracked.length) {
    console.log(`  ⚠ not swept (no webhookId in the registry): ${st.untracked.join(", ")}`);
  }
}

// CLI guard: importing this module (tests pull in checkRegistryPolicy) must not consume argv or
// call process.exit — which is what the previous unconditional block did to any importer.
const isDirectRun = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  // Load the repo-root .env before anything reads configuration. Without this the adapter's HMAC
  // secret silently came from the fleet file placeholder when started from a plain shell, and every
  // GitHub delivery failed "invalid signature" with an external-looking cause. Non-overriding, so an
  // explicitly exported value still wins; factory children load the same file themselves.
  const applied = loadRootEnv();
  if (applied.length) console.log(`[supervisor] loaded ${applied.length} variable(s) from .env (ambient values not overwritten)`);
  const [cmd, fleetPath] = process.argv.slice(2);
  if (cmd === "run" && fleetPath) {
    runFleet(fleetPath).catch((e) => {
      console.error("[supervisor] fatal:", e);
      process.exit(1);
    });
  } else if (cmd === "status" && fleetPath) {
    statusFleet(fleetPath).catch((e) => {
      console.error("[supervisor] fatal:", e);
      process.exit(1);
    });
  } else {
    console.error("usage: fleet/supervisor.ts run <fleet.json> | status <fleet.json>");
    process.exit(1);
  }
}
