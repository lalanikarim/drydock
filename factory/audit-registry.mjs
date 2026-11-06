#!/usr/bin/env node
// Pre-flight audit of the repo registry — the thing runbook §"cold start" row 4 has always claimed to run.
//
// That row referenced `factory/audit-registry.ts`, a file that never existed, for as long as the plist it
// documents also never existed. A checklist item whose command fails with MODULE_NOT_FOUND is worse than no
// checklist item: it trains the operator to skim past the line that was supposed to catch them.
//
// What this reports, and what it deliberately does not decide:
//   - facts per enabled repo: eligibility label, auto-merge posture, path scope, hook id.
//   - WARN for things that are almost certainly wrong (no hook id ⇒ deliveries unswept; no path allowlist ⇒
//     the pipeline may change any non-protected path).
//   - exit 1 only when a repo this MACHINE DEPLOYS (from the fleet file, if given) has no `webhookId`. That is
//     an unambiguous gap: work can arrive and its failed deliveries will never be examined. Whether
//     `autoMerge: true` is right for a repo is a policy call, so it is stated, not failed on.

import { readFileSync } from "node:fs";
import { loadRegistry, enabledRepos } from "../factory/repo-registry.ts";

export function auditLines({ registry, fleetRepos = [] }) {
  const lines = [];
  let failures = 0;
  for (const e of enabledRepos(registry)) {
    const deployed = fleetRepos.length === 0 || fleetRepos.includes(e.repo);
    const hook = e.webhookId ?? null;
    lines.push(
      `${e.repo}  eligibility=${e.eligibilityLabel}  autoMerge=${e.autoMerge}  verify=${e.requireVerification ? "required" : "OFF"}  scope=${e.pathAllowlist ? e.pathAllowlist.join(",") : "ANY non-protected path"}  hook=${hook ?? "MISSING"}`,
    );
    if (!hook) lines.push(`  WARN no webhookId — failed deliveries for ${e.repo} are never swept (runbook §7)`);
    if (e.autoMerge) lines.push(`  WARN autoMerge is on: a green run merges without a human looking at the diff`);
    if (!e.pathAllowlist) lines.push(`  WARN no pathAllowlist: a run may change anything outside protectedPaths`);
    if (!hook && deployed) failures += 1;
  }
  return { lines, failures };
}

export function fleetRepoNames(fleetPath) {
  const doc = JSON.parse(readFileSync(fleetPath, "utf8"));
  // The deployment file's key is `factories` (`repos` tolerated for older/other shapes).
  const list = Array.isArray(doc?.factories) ? doc.factories : Array.isArray(doc?.repos) ? doc.repos : Array.isArray(doc) ? doc : [];
  return [...new Set(list.map((r) => (typeof r === "string" ? r : r?.repo)).filter(Boolean))];
}

export function main({ argv = process.argv.slice(2), log = console.log } = {}) {
  let registry;
  try {
    registry = loadRegistry();
  } catch (e) {
    log(`registry unreadable: ${e.message}`);
    return 2;
  }
  const fleetPath = argv.find((a) => !a.startsWith("--"));
  let fleetRepos = [];
  if (fleetPath) {
    try {
      fleetRepos = fleetRepoNames(fleetPath);
    } catch (e) {
      log(`cannot read fleet file ${fleetPath}: ${e.message}`);
      return 2;
    }
  }
  const { lines, failures } = auditLines({ registry, fleetRepos });
  for (const l of lines) log(l);
  if (failures > 0) {
    log(`\n${failures} deployed repo(s) have no webhookId — record it in $DRYDOCK_CONFIG_DIR/repo-registry.json so the sweep covers them.`);
    return 1;
  }
  if (fleetPath) log("\nno gaps found for the repos this fleet deploys.");
  return 0;
}

// Only run as a CLI when executed directly — importing the pure helpers from tests must not exit the process.
const invokedDirectly = Boolean(process.argv[1]) && /audit-registry\.(mjs|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exit(main());
}
