#!/usr/bin/env node
// Deploy-posture drift gate (#220, assertion 4).
//
// `factory/gate-policy.ts` is the single source of truth for which tools are gated and which argument paths the
// destructive floor judges. Each running instance gets that object serialized to
// `<instancesRoot>/<repo-slug>/config/gates.json` at boot by `factory/main.ts`. Which means the file on disk is
// evidence about **the build that last booted**, not about the checkout you are standing in — and those two
// disagree every time main advances the policy and nobody restarts the fleet.
//
// Why this gate exists, verbatim from 2026-11-05: I "verified" a deploy by running `gates/gate-posture.mjs`, a file
// that has never existed in this repository, through a pipe (`… 2>&1 | tail -2`) that reported `tail`'s exit status.
// Node printed MODULE_NOT_FOUND and the step exited 0. The only real check that day was a human grepping the boot
// log for one line. So: a named command that exists, fails loudly when it collects nothing, and can be pointed at
// fixtures in a test.
//
// What it checks, per factory declared in the fleet config:
//   1. the instance's config/gates.json exists (absent = that instance never booted from this root — not "fine"),
//   2. it parses,
//   3. it matches `instanceGatesConfig()` in both directions — missing narrowing AND extra narrowing are drift,
//      because "the fleet is stricter than main" usually means the fleet is running an older build.
//
// What it does NOT check: whether the *running process* agrees with its own file. Restarting writes the file from
// the loaded code, so the pair can be self-consistently stale relative to a deploy that never happened; `/health`
// reports the build sha and that half belongs in the release checklist next to this gate, not inside it.
//
// Exit codes: 0 = every declared instance matches · 1 = drift or an unreadable/absent artifact · 2 = the gate could
// not run (bad config path), which is deliberately distinct so a green run can never mean "nothing was inspected".

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { instanceGatesConfig } from "../factory/gate-policy.ts";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "usage: node --experimental-strip-types gates/deploy-posture.mjs [--config fleet/fleet.local.json] [--json]",
      "",
      "Compares each fleet instance's on-disk config/gates.json against factory/gate-policy.ts.",
      "Exit 0 all match · 1 drift or missing artifact · 2 gate could not run.",
    ].join("\n"),
  );
  process.exit(0);
}

const configFlag = argv.indexOf("--config");
const configPath = configFlag >= 0 ? argv[configFlag + 1] : "fleet/fleet.local.json";
const asJson = argv.includes("--json");

/** Stable stringify so key ordering never reads as drift. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** The slug `factory/main.ts` uses for an instance directory. Kept local + asserted in the test rather than
 *  imported, so a rename in main.ts shows up here as a red gate instead of a silently-skipped instance. */
function slugForRepo(repo) {
  return String(repo).replace(/[/@:]/g, "_");
}

function describePolicy(policy) {
  const tiers = (policy.tiers ?? []).map((t) => `${t.tool}${t.containment ? `(${t.containment})` : ""}`);
  const narrowed = Object.keys(policy.destructiveArgs ?? {});
  return { tiers, narrowed };
}

/** Field-level comparison. Returns human-readable drift strings; empty array means identical. */
function diffPolicy(onDisk, expected) {
  const drift = [];
  const got = describePolicy(onDisk);
  const want = describePolicy(expected);

  for (const t of want.tiers) if (!got.tiers.includes(t)) drift.push(`tiers: missing ${t}`);
  for (const t of got.tiers) if (!want.tiers.includes(t)) drift.push(`tiers: unexpected ${t}`);

  for (const tool of want.narrowed) {
    if (!(tool in (onDisk.destructiveArgs ?? {}))) {
      drift.push(`destructiveArgs.${tool}: absent on disk, policy says ${canon(expected.destructiveArgs[tool])}`);
    } else if (canon(onDisk.destructiveArgs[tool]) !== canon(expected.destructiveArgs[tool])) {
      drift.push(
        `destructiveArgs.${tool}: on disk ${canon(onDisk.destructiveArgs[tool])} ≠ policy ${canon(expected.destructiveArgs[tool])}`,
      );
    }
  }
  for (const tool of got.narrowed) {
    if (!(tool in (expected.destructiveArgs ?? {}))) {
      drift.push(`destructiveArgs.${tool}: narrowed on disk but NOT in policy — an older build wrote this`);
    }
  }
  return drift;
}

let raw;
try {
  raw = readFileSync(configPath, "utf8");
} catch (err) {
  console.error(`deploy-posture: cannot read fleet config ${configPath}: ${err.message}`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  console.error(`deploy-posture: fleet config ${configPath} is not valid JSON: ${err.message}`);
  process.exit(2);
}

const factories = Array.isArray(config.factories) ? config.factories : [];
const expected = instanceGatesConfig();
const want = describePolicy(expected);

// Non-vacuity, in the direction reality fails: an empty factory list, a policy with nothing declared, or a config
// whose entries all get skipped must never print green. "Not collected" and "passing" are the same color
// (work-queue R6b/R10) and that equivalence is the whole reason this gate was written.
const vacuous = [];
if (factories.length === 0) vacuous.push("fleet config declares zero factories — nothing was inspected");
if (want.tiers.length === 0 && want.narrowed.length === 0) {
  vacuous.push("instanceGatesConfig() declares no tiers and no destructiveArgs — the policy source is empty");
}
if (vacuous.length > 0) {
  console.error(`deploy-posture: REFUSING to report success (${vacuous.join("; ")})`);
  process.exit(1);
}

const results = [];
for (const f of factories) {
  const repo = String(f.repo ?? "");
  const root = resolve(dirname(configPath), String(f.instancesRoot ?? "../factory-instances"));
  const gatesPath = resolve(root, slugForRepo(repo), "config", "gates.json");
  if (!repo) {
    results.push({ repo: "<missing repo>", gatesPath, status: "error", detail: "factory entry has no repo" });
    continue;
  }
  if (!existsSync(gatesPath)) {
    results.push({
      repo,
      gatesPath,
      status: "missing",
      detail: "no config/gates.json — this instance has never booted from this instancesRoot",
    });
    continue;
  }
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync(gatesPath, "utf8"));
  } catch (err) {
    results.push({ repo, gatesPath, status: "error", detail: `unparseable gates.json: ${err.message}` });
    continue;
  }
  const drift = diffPolicy(onDisk, expected);
  results.push(
    drift.length === 0
      ? { repo, gatesPath, status: "ok", detail: `${describePolicy(onDisk).tiers.length} tier(s), ${describePolicy(onDisk).narrowed.length} narrowed tool(s)` }
      : { repo, gatesPath, status: "drift", detail: drift.join("; ") },
  );
}

const bad = results.filter((r) => r.status !== "ok");

if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, inspected: results.length, expected: want, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.status === "ok" ? "ok  " : r.status.toUpperCase().padEnd(4)} ${r.repo.padEnd(26)} ${r.gatesPath}`);
    if (r.status !== "ok") console.log(`      ${r.detail}`);
  }
  // The collection line, printed last and always: a run that inspected nothing is visible in the count.
  console.log(
    `\ninspected ${results.length} of ${factories.length} declared instance(s) · policy has ${want.tiers.length} tier(s) ` +
      `and narrows ${want.narrowed.length} tool(s): ${want.narrowed.join(", ")}`,
  );
  if (bad.length > 0) {
    console.error(`\ndeploy-posture: ${bad.length} instance(s) do not match factory/gate-policy.ts.`);
    console.error("Restart the fleet from the build you intend to run, or roll the policy back. Do not hand-edit an");
    console.error("instance's gates.json — it is regenerated at boot and editing it hides the version skew.");
  }
}

process.exit(bad.length === 0 ? 0 : 1);
