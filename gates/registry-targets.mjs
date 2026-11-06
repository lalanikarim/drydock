// Which repositories does policy say the factory works in? One reader for every probe that asks.
//
// Why this exists: `gates/github-app-check.mjs` kept its own list —
// `["lalanikarim/drydock", "…factory-fixture", "…factory-fixture-2", ...managedRepoNames()]` — with a
// comment explaining the trio was "a floor so a registry read failure still probes what matters". That
// floor is the same defect class it was written to prevent: on 2026-11-02 the fleet gained `engram`, and
// the only reason this probe noticed was the registry-derived half. A hardcoded floor silently reports
// the old world while the registry half reports the new one, and a report containing two answers is not
// evidence. If the registry cannot be read, the honest result is "I do not know what to probe" — an
// error, not a plausible-looking subset.

import { readFileSync } from "node:fs";
import { registryPath } from "../factory/repo-registry.ts";

// No DEFAULT_REGISTRY constant any more. The path is deployment state and resolves per call (env override,
// then config dir), so freezing it at import time would pin whichever environment imported this first.

/**
 * Managed repo names (`owner/name`) from the registry itself.
 * @throws if the file is missing, unparseable, or names no repository.
 */
export function registryRepoNames(path = registryPath(), { includeDisabled = true } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read repo registry at ${path}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`repo registry at ${path} is not valid JSON: ${e.message}`);
  }
  // Disabled entries stay in the list on purpose: a repo policy mentions but switched off is still IN
  // policy, and reporting it as "reachable but unmanaged" (#78's residual) would be a false alarm.
  const names = (parsed.repos ?? [])
    .filter((r) => r && typeof r.repo === "string" && (includeDisabled || r.enabled !== false))
    .map((r) => r.repo);
  if (names.length === 0) {
    throw new Error(`repo registry at ${path} lists no repository — refusing to report "nothing to probe" as a pass`);
  }
  return [...new Set(names)];
}

/** Non-throwing form for tools that must degrade loudly rather than at all. */
export function tryRegistryRepoNames(path = registryPath()) {
  try {
    return { names: registryRepoNames(path), error: null };
  } catch (e) {
    return { names: [], error: e.message };
  }
}
