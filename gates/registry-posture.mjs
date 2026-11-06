#!/usr/bin/env node
// gates/registry-posture.mjs — audit the LIVE repo registry's safety posture.
//   node gates/registry-posture.mjs              # audit $DRYDOCK_REGISTRY_PATH (or config dir)
//   node gates/registry-posture.mjs --self-test  # prove the checks fire, on poisoned registries
//
// Why this exists: the registry left the source tree (it is deployment state — see registryPath() in
// factory/repo-registry.ts), and with it went the unit tests that asserted drydock cannot auto-merge,
// that a self-run cannot edit `gates/`, and that nothing waives verification. Those assertions were
// really about one machine's policy, so they could not stay in CI — but deleting them would have traded
// a real control for a false green, which is the failure mode this repo keeps paying for (§5.19, R10).
// So they live here, run on the factory host, and fail when policy drifts.
//
// Non-vacuity, per the house rule: zero inspected entries is a FAILURE, not a pass, and `--self-test`
// feeds deliberately poisoned registries through the same checker to prove each rule can fire.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, enabledRepos, missingWebhookIds, registryPath } from "../factory/repo-registry.ts";

const SELF_WORK_REPO = "lalanikarim/drydock";

const norm = (p) => String(p).replace(/\/+$/, "");

/**
 * Does an allowlist grant access to `target`? Exact match, a listed directory above it, or a listed path
 * below it all count. Array.includes() would only catch the exact string — which is how a first draft of
 * this gate missed ".github/workflows/ci.yml" and got caught by its own --self-test.
 */
function grants(allow, target) {
  const t = norm(target);
  return (allow ?? []).some((p) => {
    const a = norm(p);
    return a === t || t.startsWith(a + "/") || a.startsWith(t + "/");
  });
}

/**
 * The invariants. Returns { inspected, failures[], warnings[] }.
 * Pure: takes a parsed registry so --self-test can feed it fakes and CI can keep this file honest about
 * the rules themselves even though it cannot see the deployment.
 */
export function auditRegistryPolicy(registry) {
  const failures = [];
  const warnings = [];
  const repos = registry.repos ?? [];
  const enabled = enabledRepos(registry);

  for (const entry of enabled) {
    const name = entry.repo;
    // A run's PR is only as trustworthy as the check behind it. Waiving verification is decision C1's
    // escape hatch and must be an event, not a quiet field flip.
    if (entry.requireVerification === false) {
      failures.push(`${name}: requireVerification:false — nothing proves its PRs work. If deliberate, record it in research/decision-log.md first.`);
    }
    // A run that can edit the CI config or this registry can redefine its own review. `factory/` is where
    // the registry loader and every gate invocation live; `.github/` is the workflow itself.
    const allow = entry.pathAllowlist ?? null;
    if (allow) {
      // The workflow file is the review gate itself: a run that can edit ci.yml can delete the check that
      // refuses its own PR.
      if (grants(allow, ".github")) failures.push(`${name}: pathAllowlist grants .github — a run could edit the workflow that gates it`);
      if (grants(allow, "vendor")) failures.push(`${name}: pathAllowlist includes vendor/ (always protected; the entry is self-contradictory)`);
    } else {
      warnings.push(`${name}: no pathAllowlist — every non-protected path is in scope for a run`);
    }

    if (entry.autoMerge) {
      // Auto-merge is defensible for disposable fixtures; for a repo with real history it means an agent's
      // draft lands without a human, which #139 was filed about.
      if (!/fixture/.test(name)) warnings.push(`${name}: autoMerge:true on a non-fixture repo — runs land without a human merge`);
    }
  }

  // Self-work specifics: the whole safety story for drydock managing itself (see test/path-scope.test.mjs
  // history and #139/#140). These were unit assertions until policy left the tree.
  const self = enabled.find((e) => e.repo === SELF_WORK_REPO);
  if (self) {
    if (self.autoMerge !== false) failures.push(`${SELF_WORK_REPO}: autoMerge must be false — a self-run may never merge into the research record`);
    if ((self.pathAllowlist ?? []).includes("gates/")) failures.push(`${SELF_WORK_REPO}: pathAllowlist includes gates/ — a self-run could edit the oracles that judge it`);
    if (!(self.protectedPaths ?? []).includes("gates/probes/")) failures.push(`${SELF_WORK_REPO}: gates/probes/ must be in protectedPaths`);
    // Stated, not closed: `factory/` is legitimately in scope for self-work, and that directory holds the
    // code which enforces policy. The registry file itself left the tree (so policy is no longer a writable
    // path), but verification.ts and open-draft-pr.ts did not. What actually contains that is autoMerge:false
    // plus human review plus CI — not the allowlist. This line keeps the residual in the operator's face.
    if (grants(self.pathAllowlist, "factory")) {
      warnings.push(`${SELF_WORK_REPO}: factory/ is in scope — a self-run can propose edits to the code that enforces its own policy (contained by autoMerge:false + review, not by scope)`);
    }
  } else {
    warnings.push(`${SELF_WORK_REPO} is not an enabled entry — self-work is off on this deployment (fine, but know it)`);
  }

  const untracked = missingWebhookIds(registry);
  if (untracked.length) warnings.push(`enabled repos with no webhookId — failed deliveries are never swept: ${untracked.join(", ")}`);

  return { inspected: enabled.length, total: repos.length, failures, warnings };
}

const ok = (m) => `  \u2713 ${m}`;
const bad = (m) => `  \u2717 ${m}`;

/** Prove the checker is not decorative: poison each rule and require it to be caught. */
function selfTest() {
  const cases = [
    {
      name: "drydock auto-merging",
      registry: { repos: [{ repo: SELF_WORK_REPO, enabled: true, autoMerge: true, pathAllowlist: ["src/"], protectedPaths: ["gates/probes/"] }] },
      expect: /autoMerge must be false/,
    },
    {
      name: "drydock allowed to edit gates/",
      registry: { repos: [{ repo: SELF_WORK_REPO, enabled: true, autoMerge: false, pathAllowlist: ["src/", "gates/"], protectedPaths: [] }] },
      expect: /could edit the oracles/,
    },
    {
      name: "verification waived",
      registry: { repos: [{ repo: "octo/thing", enabled: true, requireVerification: false }] },
      expect: /requireVerification:false/,
    },
    {
      name: "run may edit .github (its own CI)",
      registry: { repos: [{ repo: "octo/thing", enabled: true, pathAllowlist: [".github/"] }] },
      expect: /grants \.github/,
    },
    {
      name: "run may edit a workflow nested under .github (prefix match, not exact)",
      registry: { repos: [{ repo: "octo/thing", enabled: true, pathAllowlist: ["src/", ".github/workflows/ci.yml"] }] },
      expect: /grants \.github/,
    },
    {
      name: "run may edit the registry loader (vendor-style prefix)",
      registry: { repos: [{ repo: "octo/thing", enabled: true, pathAllowlist: ["vendor/pkg/x.ts"] }] },
      expect: /includes vendor\//,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const { failures } = auditRegistryPolicy(c.registry);
    const hit = failures.some((f) => c.expect.test(f));
    console.log(hit ? ok(`${c.name} is caught`) : bad(`${c.name} NOT caught by any rule`));
    if (!hit) failed++;
  }

  // And the vacuous case: an empty registry must not look like a clean audit.
  const empty = auditRegistryPolicy({ repos: [] });
  const emptyCaught = empty.inspected === 0;

  // And the honest residual must be reported, never silently green.
  const selfScope = auditRegistryPolicy({
    repos: [{ repo: SELF_WORK_REPO, enabled: true, autoMerge: false, pathAllowlist: ["factory/", "src/"], protectedPaths: ["gates/probes/"] }],
  });
  const residualReported = selfScope.warnings.some((w) => /code that enforces its own policy/.test(w));
  console.log(residualReported ? ok("factory/ in self-work scope is reported as a residual, not hidden") : bad("factory/ in self-work scope passed silently"));
  if (!residualReported) failed++;
  console.log(emptyCaught ? ok("an empty registry reports zero inspected") : bad("an empty registry reported inspections"));
  if (!emptyCaught) failed++;

  // A poisoned file on disk must fail the same way load + audit are wired together.
  const dir = mkdtempSync(join(tmpdir(), "registry-posture-selftest-"));
  try {
    const path = join(dir, "repo-registry.json");
    writeFileSync(path, JSON.stringify({ repos: [{ repo: SELF_WORK_REPO, enabled: true, autoMerge: true }] }));
    const audit = auditRegistryPolicy(loadRegistry(path));
    console.log(audit.failures.length ? ok("a poisoned registry file on disk is reported") : bad("a poisoned registry file on disk passed"));
    if (!audit.failures.length) failed++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\nchecks fire as intended" : `\n${failed} check(s) did not fire`);
  return failed === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes("--self-test")) process.exitCode = selfTest();
  else {
    const path = registryPath();
    let registry;
    try {
      registry = loadRegistry(path);
    } catch (e) {
      console.error(`${bad(String(e.message))}`);
      process.exitCode = 2;
      return;
    }
    const audit = auditRegistryPolicy(registry);
    console.log(`registry posture — ${path}`);
    console.log(`inspected ${audit.inspected} enabled repo(s) of ${audit.total} entr(ies)`);
    // "Not collected" is not "passing" (R10): nothing inspected means nothing was verified.
    if (audit.inspected === 0) {
      console.log(bad("no enabled repositories — an empty registry proves nothing about posture"));
      process.exitCode = 1;
      return;
    }
    for (const w of audit.warnings) console.log(`  ! ${w}`);
    for (const f of audit.failures) console.log(bad(f));
    if (audit.failures.length) {
      console.log(`\n${audit.failures.length} posture failure(s)`);
      process.exitCode = 1;
      return;
    }
    console.log(ok(`posture: nothing waives verification, no run may edit its own workflow, ${SELF_WORK_REPO} cannot self-merge`));
    if (audit.warnings.length) console.log(`(${audit.warnings.length} warning(s) above — read them, they are the residual risk)`);
  }
}

main();
