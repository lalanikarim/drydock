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
//     { "repo": "owner/name", "config": "factory/config/owner-name.json",
//       "instancesRoot": "factory-instances", "token": "<32-hex>" }
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

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { loadRootEnv, resolveWebhookSecret, webhookSecretVar } from "../factory/env-file.ts";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadRegistry, requireEnabledRepo } from "../factory/repo-registry.ts";
import { acquireInstanceLock, defaultLockPath } from "./single-instance.ts";
import { readSweepState } from "./redeliver-failed.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const MAX_RESTARTS = 10;
const RESTART_BACKOFF_MS = 5_000;
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

function spawnProc(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env });
  const pump = (stream: NodeJS.ReadableStream, prefix: string) =>
    stream.on("data", (d: Buffer) => process.stdout.write(`[${name}] ${prefix}${String(d).replace(/\n$/, "")}\n`));
  pump(child.stdout, "");
  pump(child.stderr, "err: ");
  return child;
}

/** Resolve a fleet-file-relative path against the fleet file's directory. */
function rel(fleetPath: string, p: string): string {
  return resolve(dirname(fleetPath), p);
}

async function runFleet(fleetPath: string): Promise<void> {
  const fleet = loadFleet(fleetPath);

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

  let shuttingDown = false;
  const restarts = new Map<string, number>();
  const children: ChildProcess[] = [];
  // repo -> base URL once the instance reports ready (for the routes file).
  const bases = new Map<string, string>();

  // The routes file lists ALL factories from boot (secret known up front) so
  // the adapter validates cleanly before any instance is ready; `target` is
  // filled in when an instance reports its ephemeral port and removed on exit.
  const writeRoutes = () => {
    if (!fleet.adapter) return;
    const routesFile = rel(fleetPath, fleet.adapter.routesFile);
    const routes = buildRoutes(fleet.factories, bases, loadRegistry());
    const hash = writeRoutesFile(routesFile, routes);
    console.log(`[supervisor] wrote ${routes.length} route(s) to ${routesFile} (hash ${hash.slice(0, 16)})`);
  };

  // #69: the routes file is written BEFORE anything is spawned. The old seed-if-missing logic let a
  // leftover file from a previous run survive — the adapter then started against stale policy and
  // never re-read it. Overwriting unconditionally means every start begins from the current fleet.
  writeRoutes();

  const startFactory = (f: FactoryEntry) => {
    const key = `factory:${f.repo}`;
    restarts.set(key, (restarts.get(key) ?? 0) + 1);
    if ((restarts.get(key) ?? 0) > MAX_RESTARTS) {
      console.error(`[supervisor] ${key} exceeded ${MAX_RESTARTS} restarts — giving up`);
      shuttingDown = true;
      return;
    }
    const configPath = f.config ? rel(fleetPath, f.config) : join(REPO_ROOT, "factory", "config", `${f.repo.replace("/", "_")}.json`);
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
    children.push(child);
    let readySent = false;
    // Learn the ephemeral port from stdout and publish it to the routes file.
    child.stdout!.on("data", (d: Buffer) => {
      if (readySent) return;
      const m = String(d).match(READY_RE);
      if (m) {
        readySent = true;
        bases.set(f.repo, `http://127.0.0.1:${m[1]}`);
        writeRoutes();
      }
    });
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      bases.delete(f.repo);
      console.error(`[supervisor] ${key} exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
      setTimeout(() => startFactory(f), RESTART_BACKOFF_MS);
    });
  };

  const startAdapter = () => {
    if (!fleet.adapter) return; // adapter is optional (single-factory dev mode)
    const key = "adapter";
    restarts.set(key, (restarts.get(key) ?? 0) + 1);
    if ((restarts.get(key) ?? 0) > MAX_RESTARTS) {
      console.error(`[supervisor] ${key} exceeded ${MAX_RESTARTS} restarts — giving up`);
      shuttingDown = true;
      return;
    }
    const a = fleet.adapter!;
    // Rewrite immediately before spawning: the adapter hashes this file at start and on every
    // request (#69). A fresh write here means a restarted adapter always adopts current policy,
    // even if something external touched the file while it was down.
    writeRoutes();
    const routesFile = rel(fleetPath, a.routesFile);
    const args = ["--experimental-strip-types", join(REPO_ROOT, "factory", "adapter.ts"), String(a.port), routesFile, a.logPath ? rel(fleetPath, a.logPath) : join(dirname(routesFile), "intake-adapter.jsonl")];
    console.log(`[supervisor] starting ${key} (port ${a.port}) — attempt ${restarts.get(key)}`);
    const child = spawnProc(key, args, process.env);
    children.push(child);
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[supervisor] ${key} exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
      setTimeout(startAdapter, RESTART_BACKOFF_MS);
    });
  };

  for (const f of fleet.factories) startFactory(f);
  startAdapter();

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[supervisor] shutting down");
    // Release before waiting, so a restart racing our own teardown is not told "already running" by a
    // lock we no longer intend to hold.
    lock.release();
    for (const c of children) c.kill("SIGTERM");
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
    // Deliberately NOT unref'd: an unref'd deadline timer lets the process linger on whatever handle a
    // child left open, which is how a supervisor sat alive 13s after logging "shutting down" and had to
    // be SIGKILLed. A ref'd timer guarantees shutdown is bounded at 3s either way.
    setTimeout(() => process.exit(0), 3_000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
    const row: Record<string, string> = { repo: r.repo, base: r.target, state: "DOWN", pending: "" };
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
    console.log(`\nfailed-delivery sweep: ${sweep.reason === "never" ? "NEVER RECORDED" : sweep.reason.toUpperCase()} — run fleet/redeliver-failed.mjs with --state-file ${sweepPath}`);
    return;
  }
  const st = sweep.state as { at: string; mode?: string; inspected?: number; undelivered?: number; queued?: number; since?: string | null; acknowledged?: number };
  const ageMin = Math.round((Date.now() - Date.parse(st.at)) / 60_000);
  const stale = ageMin > 60 ? " ⚠ older than 1h" : "";
  // The window matters as much as the count: "undelivered 35" across all retained history is housekeeping,
  // "undelivered 35 in the last hour" is an incident.
  const window = st.since ? `since ${st.since}` : "all retained history";
  // Acknowledged failures are excluded from the alarm but must stay on the line: "0 undelivered" after
  // acknowledging 16 is a different claim than "0 undelivered" on a clean hook.
  const acked = st.acknowledged ? `, ${st.acknowledged} acknowledged` : "";
  console.log(`\nfailed-delivery sweep: ${ageMin} min ago (${st.mode ?? "?"}) — inspected ${st.inspected ?? "?"}, undelivered ${st.undelivered ?? "?"}, queued ${st.queued ?? 0}, ${window}${acked}${stale}`);
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
