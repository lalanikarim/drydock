// Repo registry tests (factory/repo-registry.json + factory/repo-registry.ts).
//   node --experimental-strip-types --test test/repo-registry.test.mjs
//
// The registry is where "may the pipeline merge here?" and "which label makes an issue workable?"
// are answered for every repo, so its validation rules are the safety surface: a typo'd entry must
// fail loudly at load, never silently default to permissive.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const { validateRegistry, loadRegistry, requireRepo, requireEnabledRepo, enabledRepos, registryRepoNames } = await import(
  "../factory/repo-registry.ts"
);
const { loadProbes } = await import("../gates/behavior-probes.mjs");
const { loadFactoryConfig } = await import("../factory/factory-config.ts");

const BOOT_STDOUT = { command: "node", args: ["src/server.mjs", "0"], portFrom: "stdout", stdoutPattern: "127\\.0\\.0\\.1:(\\d+)" };
const BOOT_ENV = { command: "node", args: ["src/server.js"], portFrom: "env", envPortVar: "PORT" };

const entry = (over = {}) => ({
  repo: "octo/thing",
  configFile: "factory/config/x.json",
  oracleBoot: BOOT_STDOUT,
  ...over,
});

test("defaults are applied per entry", () => {
  const registry = validateRegistry({ repos: [entry()] });
  const r = registry.repos[0];
  assert.equal(r.enabled, true);
  assert.equal(r.autoMerge, true, "auto-merge is the fixture default; opting out must be explicit");
  assert.equal(r.eligibilityLabel, "agent");
});

test("registry defaults cascade and per-repo values override", () => {
  const registry = validateRegistry({
    defaults: { eligibilityLabel: "build", autoMerge: false },
    repos: [entry(), entry({ repo: "octo/other", eligibilityLabel: "agent", autoMerge: true })],
  });
  assert.deepEqual(
    registry.repos.map((r) => `${r.eligibilityLabel}/${r.autoMerge}`),
    ["build/false", "agent/true"],
  );
});

test("a disabled repo must not carry a merge grant", () => {
  assert.throws(
    () => validateRegistry({ repos: [entry({ enabled: false, autoMerge: true })] }),
    /disabled registry entry must not declare autoMerge/,
  );
  // The legitimate shape: disabled AND explicitly not auto-merging.
  const registry = validateRegistry({ repos: [entry({ enabled: false, autoMerge: false, configFile: null })] });
  assert.equal(registry.repos[0].enabled, false);
});

test("an enabled repo needs runtime config", () => {
  assert.throws(() => validateRegistry({ repos: [entry({ configFile: null })] }), /requires configFile/);
  assert.throws(() => validateRegistry({ repos: [entry({ configFile: "/etc/passwd" })] }), /repo-relative/);
  assert.throws(() => validateRegistry({ repos: [entry({ configFile: "../outside.json" })] }), /repo-relative/);
});

test("unknown fields are rejected rather than ignored", () => {
  assert.throws(() => validateRegistry({ repos: [entry()], extra: 1 }), /unknown registry field: extra/);
  assert.throws(() => validateRegistry({ repos: [entry({ automerge: true })] }), /unknown field: automerge/, "a near-miss key must not silently mean autoMerge=false");
  assert.throws(() => validateRegistry({ defaults: { autoMerge2: true }, repos: [entry()] }), /unknown registry defaults field/);
});

test("duplicate entries and malformed repo names are rejected", () => {
  assert.throws(() => validateRegistry({ repos: [entry(), entry()] }), /duplicate registry entry/);
  assert.throws(() => validateRegistry({ repos: [entry({ repo: "nope" })] }), /must be "owner\/name"/);
  assert.throws(() => validateRegistry({ repos: [] }), /non-empty array/);
});

test("oracleBoot: port discovery must be declared explicitly", () => {
  assert.throws(
    () => validateRegistry({ repos: [entry({ oracleBoot: { command: "node", args: ["server.js"] } })] }),
    /portFrom must be one of stdout, env/,
  );
  assert.throws(
    () => validateRegistry({ repos: [entry({ oracleBoot: { command: "node", portFrom: "stdout" } })] }),
    /stdoutPattern is required/,
  );
  assert.throws(
    () => validateRegistry({ repos: [entry({ oracleBoot: { command: "node", portFrom: "stdout", stdoutPattern: "([unclosed" } })] }),
    /not a valid regular expression/,
  );
  assert.throws(
    () => validateRegistry({ repos: [entry({ oracleBoot: { command: "node", portFrom: "env" } })] }),
    /envPortVar must be a valid environment variable name/,
  );
});

test("oracleBoot rejects shell metacharacters (it is executed as argv, never via a shell)", () => {
  assert.throws(
    () => validateRegistry({ repos: [entry({ oracleBoot: { command: "node; curl evil", portFrom: "env", envPortVar: "PORT" } })] }),
    /must not contain shell metacharacters/,
  );
  assert.throws(
    () => validateRegistry({ repos: [entry({ oracleBoot: { command: "node", args: ["src/$(whoami).js"], portFrom: "env", envPortVar: "PORT" } })] }),
    /must not contain shell metacharacters/,
  );
});

test("lookup helpers fail with the registry contents in the message", () => {
  const registry = validateRegistry({ repos: [entry(), entry({ repo: "octo/other", enabled: false, autoMerge: false })] });
  assert.deepEqual(registryRepoNames(registry), ["octo/thing", "octo/other"]);
  assert.deepEqual(enabledRepos(registry).map((r) => r.repo), ["octo/thing"]);
  assert.equal(requireRepo(registry, "octo/other").enabled, false);
  assert.throws(() => requireEnabledRepo(registry, "octo/nope"), /not in the repo registry \(known: octo\/thing, octo\/other\)/);
  assert.throws(() => requireEnabledRepo(registry, "octo/other"), /in the repo registry but disabled/);
});

// ---------------------------------------------------------------------------
// The real registry, and its relationship to the oracles.
// ---------------------------------------------------------------------------

test("factory/repo-registry.json loads and describes the expected registry", () => {
  const registry = loadRegistry();
  assert.deepEqual(registryRepoNames(registry), ["lalanikarim/factory-fixture", "lalanikarim/factory-fixture-2", "lalanikarim/drydock"]);
  const fx1 = requireEnabledRepo(registry, "lalanikarim/factory-fixture");
  assert.equal(fx1.oracleBoot.portFrom, "stdout", "fixture-1 logs the port it bound");
  const fx2 = requireEnabledRepo(registry, "lalanikarim/factory-fixture-2");
  assert.equal(fx2.oracleBoot.portFrom, "env", "fixture-2 takes PORT and logs the requested value");
});

test("drydock is enabled for self-work and can never auto-merge", () => {
  const raw = JSON.parse(readFileSync(join(ROOT, "factory/repo-registry.json"), "utf8"));
  const drydock = raw.repos.find((r) => r.repo === "lalanikarim/drydock");
  assert.equal(drydock.enabled, true, "self-work is enabled: local, human-dispatched runs only (no fleet entry, no published listener)");
  // The invariant that replaced "disabled" as the safety story. autoMerge:false is what removes
  // merge_pr from the tool list entirely (test/repo-enforcement.test.mjs), so a self-run cannot land
  // anything in the repo holding the research record even if every other control were bypassed.
  assert.equal(drydock.autoMerge, false, "the factory must never merge into the repo holding the research record");
  assert.notEqual(drydock.eligibilityLabel, "agent", "drydock's own backlog is not factory work by default");
  // Self-grading: the oracles live under gates/, which a self-run must not be able to edit.
  assert.ok(!drydock.pathAllowlist.includes("gates/"), "a self-run may not edit the gates that judge it");
  assert.ok(drydock.protectedPaths.includes("gates/probes/"), "the oracles stay protected even if gates/ were ever allowlisted");
});

test("verification is required by default and waiving it is explicit (#61 / decision C1)", () => {
  assert.equal(validateRegistry({ repos: [entry()] }).repos[0].requireVerification, true, "a draft PR may not exist without verification unless policy says otherwise");
  const waived = validateRegistry({ defaults: { requireVerification: false }, repos: [entry(), entry({ repo: "octo/other", requireVerification: true })] });
  assert.deepEqual(waived.repos.map((r) => r.requireVerification), [false, true], "defaults cascade, per-repo overrides");
});

test("safety flags must be real booleans — \"false\" as a string is a typo, not a grant", () => {
  // Boolean("false") === true. In autoMerge that would hand out merge rights on a typo, so the
  // registry rejects non-boolean values for every safety flag instead of coercing them.
  assert.throws(() => validateRegistry({ repos: [entry({ autoMerge: "false" })] }), /autoMerge.*must be a boolean/);
  assert.throws(() => validateRegistry({ repos: [entry({ enabled: "true" })] }), /enabled.*must be a boolean/);
  assert.throws(() => validateRegistry({ repos: [entry({ requireVerification: "no" })] }), /requireVerification.*must be a boolean/);
  assert.throws(() => validateRegistry({ defaults: { autoMerge: "false" }, repos: [entry()] }), /defaults\.autoMerge must be a boolean/);
});

test("no checked-in repo waives verification", () => {
  // The escape hatch exists for repos with no runnable suite. None of ours qualify, and the day one
  // is waived this test names it instead of the waiver being a quiet diff in a JSON file.
  const registry = loadRegistry();
  for (const entry of registry.repos) {
    assert.equal(entry.requireVerification, true, `${entry.repo} waives verification — PR bodies there would say "NOT VERIFIED"`);
  }
});

test("every registry entry's runtime config parses, including disabled repos", () => {
  // A disabled entry is still checked in and reviewed; discovering that drydock's config has a bad
  // field on the day we finally enable it is the worst possible time. loadRegistry checks existence,
  // this checks content: it satisfies the runtime schema and agrees about repo identity.
  const registry = loadRegistry();
  for (const entry of registry.repos) {
    if (!entry.configFile) continue;
    const cfg = loadFactoryConfig(join(ROOT, entry.configFile));
    assert.equal(cfg.repo, entry.repo, `${entry.configFile} declares ${cfg.repo}, registry says ${entry.repo}`);
    assert.ok(cfg.testCommand.length > 0, `${entry.repo} must declare how it is tested`);
  }
});

test("every oracle declares a repo, and every oracle repo is in the registry", async () => {
  const registry = loadRegistry();
  const known = new Set(registryRepoNames(registry));
  const probes = await loadProbes();
  assert.ok(probes.size >= 13, `expected at least 13 oracles, found ${probes.size}`);
  for (const probe of probes.values()) {
    assert.ok(known.has(probe.repo), `probe ${probe.key} targets ${probe.repo}, which is not in the repo registry`);
  }
  // Each fixture repo must have at least one oracle — an entry you cannot judge is a liability.
  for (const entryRepo of enabledRepos(registry)) {
    if (!entryRepo.oracleBoot) continue;
    assert.ok(
      [...probes.values()].some((p) => p.repo === entryRepo.repo),
      `${entryRepo.repo} has an oracleBoot but no oracle — it can be booted and judged by nothing`,
    );
  }
});
