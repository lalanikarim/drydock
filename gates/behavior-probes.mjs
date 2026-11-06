// Behavior oracles for G2, keyed by LABEL rather than issue number.
//
// Library, not a CLI — deliberately no invocation example: running this file does nothing. Exercised by
// gates/g2-worker-quality.mjs (which reads the probes off the fixture repo's labels) and asserted in
// test/repo-registry.test.mjs via `loadProbes`.
//
// Why: the previous design hardcoded `issueNumber === 16` blocks inside the gate, which coupled
// the harness to specific fixture issues and — worse — only discovered a missing oracle AFTER an
// expensive worker run (`RUN FAIL — no behavior check defined for issue #34`). With labels, the
// target/oracle pairing is resolved at preflight, before any inference: an issue labeled
// `agent` with no `probe:<key>`, or with a typo'd key, fails immediately and cheaply.
//
// Oracle code lives in drydock (gates/probes/), never in the fixture repo: the oracle must not be
// reachable by the pipeline whose work it judges. A probe is only ever loaded from this directory
// by a label value, so adding an oracle is a reviewed PR here, not a fixture edit.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROBE_LABEL_PREFIX = "probe:";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load every probe module in gates/probes/. Throws on a malformed or duplicated probe. */
export async function loadProbes() {
  const dir = join(HERE, "probes");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
  const probes = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (typeof mod.key !== "string" || typeof mod.title !== "string" || typeof mod.check !== "function") {
      throw new Error(`probe ${file} must export { key: string, title: string, check(ctx): Promise<{ok, detail}> }`);
    }
    // Optional provenance (issue number in that repo). Never used for selection.
    if (mod.sourceIssue !== undefined && typeof mod.sourceIssue !== "number") {
      throw new Error(`probe ${file} exports a non-numeric sourceIssue`);
    }
    // Required: which fleet repo this oracle speaks to. Two fixtures expose different APIs, so an
    // unqualified oracle is one `--repo` flag away from judging the wrong service.
    if (typeof mod.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(mod.repo)) {
      throw new Error(`probe ${file} must export repo: "owner/name" (a fleet entry in $DRYDOCK_CONFIG_DIR/repo-registry.json)`);
    }
    if (probes.has(mod.key)) throw new Error(`duplicate probe key "${mod.key}" in ${file}`);
    probes.set(mod.key, { key: mod.key, title: mod.title, check: mod.check, repo: mod.repo, sourceIssue: mod.sourceIssue, file });
  }
  return probes;
}

/**
 * The single `probe:<key>` label on an issue, or null when it has none.
 * More than one is an error: two oracles for one issue means nobody knows which one judges it.
 */
export function probeKeyFromLabels(labels) {
  const keys = labels.filter((l) => l.startsWith(PROBE_LABEL_PREFIX));
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    throw new Error(`${keys.length} ${PROBE_LABEL_PREFIX}* labels (${keys.join(", ")}); an issue may carry exactly one oracle`);
  }
  return keys[0].slice(PROBE_LABEL_PREFIX.length);
}

/** Human-readable label list for gate output / result JSON provenance. */
export function formatLabels(labels) {
  return labels.join(",") || "(none)";
}
