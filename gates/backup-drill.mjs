#!/usr/bin/env node
// P0-4: back up the fleet's durable state and PROVE a restore works — by executing one, not by asserting
// that copying files is probably fine.
//
//   node gates/backup-drill.mjs                 # backup + verify + restore drill (default)
//   node gates/backup-drill.mjs --out DIR       # where to write (default $DRYDOCK_BACKUP_DIR or ~/drydock-backups)
//   node gates/backup-drill.mjs --keep 5        # prune older backups beyond N (never the one just written)
//   node gates/backup-drill.mjs --no-restore    # backup + verify only
//   node gates/backup-drill.mjs --boot          # also boot an instance against the restored store
//                                               # (needs a reachable inference endpoint; skips cleanly otherwise)
//
// Why this is a gate and not a paragraph. The fleet's entire durable state is four sqlite stores plus the
// runtime config directory, and until tonight the backup story was "there are files, they look like sqlite".
// Three things that belief does not survive: (1) WAL mode means copying `agent.sqlite` alone can capture a
// database whose newest transactions live in `-wal`; (2) a copy that opens is not a copy that passes
// integrity_check; (3) a store that passes integrity_check is not a store the application can *write* to —
// which is what a harness does seconds after it starts. Each of those gets an assertion below, on real
// files, in this run.
//
// Verification is by observable effect, per AGENTS.md: row counts per table and per-kind document presence
// compared between source and restored copy, not "the copy command exited 0".

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const OUT_ROOT = resolve(opt("out", process.env.DRYDOCK_BACKUP_DIR ?? join(homedir(), "drydock-backups")));
const KEEP = Number(opt("keep", "5"));
const DO_RESTORE = !flag("no-restore");
const DO_BOOT = flag("boot");

// Tables that carry the fleet's meaning. `documents` is where the app-level state lives (approvals,
// approval rules, conversation meta, and since #132 the factory intake ledger), so counts alone can hide a
// missing kind — hence the per-kind census below.
const TABLES = ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions"];

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);
const note = (msg) => console.log(`        ${msg}`);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function sqliteQuery(db, sql) {
  // -cmd-less single statement; `-batch` keeps output parseable, `--newline \n` avoids CR noise.
  return sh("sqlite3", ["-batch", "-newline", "\n", db, sql]).trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Row counts for every table we care about; a missing table is reported, never silently zero. */
function census(db) {
  const out = {};
  for (const t of TABLES) {
    try {
      out[t] = Number(sqliteQuery(db, `select count(*) from ${t};`));
    } catch {
      out[t] = "MISSING";
    }
  }
  return out;
}

/** Per-kind document counts — the census that catches "the ledger doc was never written". */
function docKinds(db) {
  const rows = sqliteQuery(db, `select kind || '=' || count(*) from documents group by kind order by kind;`);
  const out = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const i = line.lastIndexOf("=");
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

/**
 * A consistent snapshot of a live database. `VACUUM INTO` uses the backup API under the hood and produces a
 * single self-contained file: WAL content is folded in, so the copy needs no sidecars. Copying
 * `agent.sqlite` with cp(1) does the opposite — it can capture a database whose newest transactions are
 * still sitting in `-wal`, which restores as an older store with no indication anything is missing.
 */
function snapshotStore(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  sqliteQuery(src, `vacuum into '${dst.replace(/'/g, "''")}';`);
  if (!existsSync(dst)) throw new Error(`snapshot produced no file for ${src}`);
  const check = sqliteQuery(dst, "pragma integrity_check;");
  if (check !== "ok") throw new Error(`integrity_check on ${basename(dst)}: ${check}`);
}

function findStores() {
  return globSync(join(ROOT, "factory-instances", "*", "engram-data", "agent.sqlite"))
    .map((p) => ({ repo: basename(dirname(dirname(resolve(p)))), src: p }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

function configDir() {
  return resolve(process.env.DRYDOCK_CONFIG_DIR ?? join(homedir(), ".drydock", "configs"));
}

// ------------------------------------------------------------------ backup

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(OUT_ROOT, stamp);
mkdirSync(join(outDir, "stores"), { recursive: true });
chmodSync(OUT_ROOT, 0o700);
chmodSync(outDir, 0o700);

console.log(`drydock backup drill — ${stamp}`);
console.log(`  source repo : ${ROOT}`);
console.log(`  output      : ${outDir}  (mode 700 — these files contain webhook secrets and instance tokens)`);

const stores = findStores();
if (stores.length === 0) {
  console.error("no instance stores found under factory-instances/*/engram-data/agent.sqlite — nothing to back up");
  process.exit(2);
}

const manifest = { stamp, root: ROOT, configDir: configDir(), stores: {}, files: {} };

console.log("\n[1] snapshot each durable store (sqlite backup API, not cp)");
for (const { repo, src } of stores) {
  const dst = join(outDir, "stores", `${repo}.sqlite`);
  try {
    snapshotStore(src, dst);
    const c = census(dst);
    const kinds = docKinds(dst);
    manifest.stores[repo] = { file: dst, sha256: sha256(dst), bytes: statSync(dst).size, counts: c, documents: kinds };
    ok(`${repo}: integrity_check ok, ${statSync(dst).size} bytes`);
    note(Object.entries(c).map(([t, n]) => `${t}=${n}`).join(" "));
  } catch (e) {
    fail(`${repo}: ${e.message}`);
  }
}

console.log("\n[2] copy the non-sqlite state (config is not in git by design — losing it is a reinstall)");
const cfg = configDir();
if (existsSync(cfg)) {
  mkdirSync(join(outDir, "config"), { recursive: true });
  for (const f of readdirSync(cfg)) {
    if (!f.endsWith(".json")) continue;
    copyFileSync(join(cfg, f), join(outDir, "config", f));
    manifest.files[`config/${f}`] = sha256(join(outDir, "config", f));
    ok(`config/${f}`);
  }
} else {
  fail(`runtime config dir not found: ${cfg}`);
}
// The repo registry is not listed here any more: it left the tree with #258 and is copied above as part of
// the config directory, which is what a backup of deployment state should have included all along.
for (const rel of ["fleet/fleet.local.json", "fleet/data/routes.json"]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { note(`${rel}: absent, skipped`); continue; }
  const dst = join(outDir, rel.replace(/^/, "repo/"));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(p, dst);
  manifest.files[rel] = sha256(p);
  ok(rel);
}
// Lessons are per-repo durable knowledge; losing them silently degrades every future run.
for (const f of globSync(join(ROOT, "factory-instances", "*", "lessons.md"))) {
  const repo = basename(dirname(f));
  const dst = join(outDir, "lessons", `${repo}.md`);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(f, dst);
  manifest.files[`lessons/${repo}.md`] = sha256(f);
  ok(`lessons for ${repo} (${statSync(f).size} bytes)`);
}

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
ok(`manifest.json (sha256 of every artifact above)`);

// ------------------------------------------------------------------ restore drill

let restoredRoot = null;
if (DO_RESTORE && failures === 0) {
  console.log("\n[3] restore drill: rebuild a working tree from the backup alone and verify it");
  restoredRoot = join(outDir, "restore-check");
  mkdirSync(join(restoredRoot, "factory-instances"), { recursive: true });

  for (const [repo, info] of Object.entries(manifest.stores)) {
    const live = join(ROOT, "factory-instances", repo, "engram-data", "agent.sqlite");
    const dstDir = join(restoredRoot, "factory-instances", repo, "engram-data");
    mkdirSync(dstDir, { recursive: true });
    const dst = join(dstDir, "agent.sqlite");
    copyFileSync(info.file, dst);

    // (a) the restored copy agrees with the manifest on every table count…
    const c = census(dst);
    const mismatch = Object.entries(info.counts).filter(([t, n]) => c[t] !== n);
    if (mismatch.length) fail(`${repo}: restored counts differ from backup: ${JSON.stringify(mismatch)}`);
    else ok(`${repo}: all table counts match (${Object.values(c).join(", ")})`);

    // (b) …and on the document kinds, which is where app-level state actually lives;
    const k = docKinds(dst);
    const kindMismatch = Object.entries(info.documents).filter(([kk, n]) => k[kk] !== n);
    if (kindMismatch.length) fail(`${repo}: restored document kinds differ: ${JSON.stringify(kindMismatch)}`);
    else ok(`${repo}: document kinds match (${Object.keys(k).length} kinds)`);

    // (c) and it is WRITABLE. A harness does not merely read its store: the first thing a restarted
    // instance does is commit (capability re-assert, submissions). Proven with a real write + ROLLBACK, so
    // the restored copy stays byte-comparable afterwards.
    try {
      const probe = sqliteQuery(dst, "begin; create table __drill_probe(x); insert into __drill_probe values (1); select count(*) from __drill_probe; rollback;");
      if (probe !== "1") fail(`${repo}: write probe returned ${JSON.stringify(probe)}, expected 1`);
      else ok(`${repo}: writable (insert inside a rolled-back transaction)`);
    } catch (e) {
      fail(`${repo}: not writable — ${e.message}`);
    }

    // (d) and it refuses to be mistaken for the live store: the source must still exist unchanged.
    if (!existsSync(live)) fail(`${repo}: live store vanished during drill`);
    if (sha256(info.file) !== info.sha256) fail(`${repo}: backup file changed after verification`);
  }

  // The restored config must satisfy the same resolver production uses — otherwise "restored" is a pile of
  // files in the wrong place.
  const restoredCfg = join(outDir, "config");
  for (const repo of Object.keys(manifest.stores)) {
    const slug = repo.replace("/", "_");
    const p = join(restoredCfg, `${slug}.json`);
    if (!existsSync(p)) fail(`restored config missing ${slug}.json — the supervisor would refuse to start this repo`);
    else {
      JSON.parse(readFileSync(p, "utf8")); // parse it: a truncated copy is the classic partial backup
      ok(`restored config parses for ${repo}`);
    }
  }

  if (DO_BOOT) await bootFromRestore(restoredRoot);
} else if (DO_RESTORE) {
  console.log("\n[3] restore drill skipped because earlier steps failed");
}

// ------------------------------------------------------------------ optional live boot

async function bootFromRestore(rootDir) {
  const endpoint = process.env.OPENAI_BASE_URL ?? "";
  let reachable = false;
  if (endpoint) {
    try {
      const r = await fetch(`${endpoint.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
        signal: AbortSignal.timeout(5000),
      });
      reachable = r.ok;
    } catch { reachable = false; }
  }
  if (!reachable) {
    console.log("\n[4] boot-from-restore skipped: no reachable inference endpoint (a factory instance refuses to");
    console.log("    start without its model — which is correct behavior, and the subject of #133).");
    return;
  }
  const slug = Object.keys(manifest.stores)[0];
  if (!slug) return;
  // The store directory is `owner_repo`; factory/main.ts wants `owner/repo`. Take it from the restored
  // config rather than reconstructing it — that also proves the restored config still names its repo.
  const repo = JSON.parse(readFileSync(join(outDir, "config", `${slug}.json`), "utf8")).repo;
  console.log(`\n[4] booting an instance against the RESTORED store (${repo})`);
  // A scratch config derived from the restored one, pointed at the restored data dir. The provider is taken
  // from DEFAULT_MODEL when set, so the drill can run on whichever inference host is up without editing the
  // restored artifact (which must stay byte-identical to what was backed up).
  const cfg = JSON.parse(readFileSync(join(outDir, "config", `${slug}.json`), "utf8"));
  if (process.env.DEFAULT_MODEL?.includes(":")) {
    const [provider, ...rest] = process.env.DEFAULT_MODEL.split(":");
    cfg.models = { provider, modelId: rest.join(":") };
  }
  const scratchCfg = join(outDir, "restore-boot-config.json");
  writeFileSync(scratchCfg, JSON.stringify(cfg, null, 2));

  // FACTORY_INSTANCES_ROOT is the isolation seam factory/main.ts already honors (§ gates): it decides where
  // <repo>/engram-data lives. Pointing it at the restored tree is what makes this a restore test rather than
  // a second harness over the live store — which is exactly the failure runbook §10 exists to prevent.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "factory/main.ts"), repo, "--config", scratchCfg], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_INSTANCES_ROOT: join(rootDir, "factory-instances"), API_TOKEN: process.env.API_TOKEN ?? "backup-drill-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const portPromise = new Promise((resolvePort) => {
    const onData = (buf) => {
      out += buf.toString();
      const m = /ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolvePort(Number(m[1]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(() => resolvePort(null), 90_000);
  });
  // /health is bearer-gated in this app, like the rest of the data plane — an unauthenticated probe gets
  // {"error":"unauthorized"}, which is not the same thing as "the restored store failed".
  const auth = { authorization: `Bearer ${process.env.API_TOKEN ?? "backup-drill-token"}` };
  const port = await portPromise;
  if (!port) {
    fail(`instance did not become ready against the restored store:\n${out.slice(-800)}`);
  } else {
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: auth }).then((r) => r.json()).catch(() => null);
    if (health?.status !== "ok") fail(`restored instance /health: ${JSON.stringify(health)}`);
    else {
      const convs = await fetch(`http://127.0.0.1:${port}/conversations`, { headers: auth }).then((r) => r.json()).catch(() => null);
      const n = convs?.conversations?.length ?? 0;
      const expected = manifest.stores[slug]?.counts?.conversations ?? 0;
      if (n === 0) fail("restored instance lists zero conversations — the store opened but its history did not survive");
      else if (n < expected) fail(`restored instance lists ${n} conversation(s); the backup held ${expected} — history was lost between snapshot and application`);
      else ok(`restored instance is serving with ${n} conversation(s) recovered (backup held ${expected})`);
    }
    console.log(`    boot log tail: ${out.split("\n").filter((l) => /ready on|conversations|intake routing/.test(l)).slice(-2).join(" | ")}`);
  }
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 4000));
  if (!child.killed) child.kill("SIGKILL");
}

// ------------------------------------------------------------------ prune + verdict

if (KEEP > 0 && existsSync(OUT_ROOT)) {
  const dirs = readdirSync(OUT_ROOT).filter((d) => d !== stamp && /^\d{4}-\d{2}-\d{2}T/.test(d)).sort();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
    rmSync(join(OUT_ROOT, d), { recursive: true, force: true });
    note(`pruned older backup ${d}`);
  }
}

console.log(`\n${failures === 0 ? "BACKUP DRILL PASSED" : `BACKUP DRILL FAILED (${failures})`}`);
console.log(`  artifacts: ${outDir}`);
if (restoredRoot) console.log(`  restored tree: ${restoredRoot}`);
process.exit(failures === 0 ? 0 : 1);
