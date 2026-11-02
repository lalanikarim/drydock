// Registry pre-flight audit (factory/audit-registry.mjs).
//   node --experimental-strip-types --test test/audit-registry.test.mjs
//
// The runbook's cold-start checklist told operators to run `factory/audit-registry.ts` — a file that was never
// written. This is the tool that claim refers to, so these tests are about the claims it makes: what counts as
// a gap, and when a gap is allowed to fail a pre-flight check versus merely being stated.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLines, fleetRepoNames } from "../factory/audit-registry.mjs";

const entry = (over = {}) => ({
  repo: "a/one",
  enabled: true,
  autoMerge: false,
  eligibilityLabel: "build",
  requireVerification: true,
  pathAllowlist: ["src/"],
  ...over,
});
const registryWith = (repos) => ({ repos });

test("an enabled repo with no hook id is warned about, and fails only if this machine deploys it", () => {
  const registry = registryWith([entry({ webhookId: undefined })]);
  const notDeployed = auditLines({ registry, fleetRepos: [] });
  assert.ok(notDeployed.lines.some((l) => /never swept/.test(l)), "the gap is always stated");
  assert.equal(notDeployed.failures, 1, "no fleet file given → every enabled repo is treated as in scope");

  const deployed = auditLines({ registry, fleetRepos: ["a/one"] });
  assert.equal(deployed.failures, 1);

  const otherMachine = auditLines({ registry: registryWith([entry()]), fleetRepos: ["b/two"] });
  assert.equal(otherMachine.failures, 0, "a repo this fleet does not run cannot make this fleet fail pre-flight");
});

test("policy choices are stated, not failed on — only the sweep gap is a failure", () => {
  const registry = registryWith([entry({ autoMerge: true, webhookId: 5, pathAllowlist: null })]);
  const r = auditLines({ registry, fleetRepos: ["a/one"] });
  assert.ok(r.lines.some((l) => /autoMerge is on/.test(l)));
  assert.ok(r.lines.some((l) => /no pathAllowlist/.test(l)));
  assert.equal(r.failures, 0, "autoMerge=true is a decision someone made, not a defect this tool gets to veto");
});

test("the fleet file's key is `factories`, and repo names come out deduped", () => {
  const p = join(mkdtempSync(join(tmpdir(), "fleet-audit-")), "fleet.local.json");
  writeFileSync(p, JSON.stringify({ _comment: "x", adapter: {}, factories: [{ repo: "a/one" }, { repo: "a/one" }, { repo: "b/two" }] }));
  assert.deepEqual(fleetRepoNames(p), ["a/one", "b/two"]);
});

test("a fleet file that is not an object does not crash the audit into silence", () => {
  const p = join(mkdtempSync(join(tmpdir(), "fleet-audit-")), "weird.json");
  writeFileSync(p, JSON.stringify([{ repo: "a/one" }]));
  assert.deepEqual(fleetRepoNames(p), ["a/one"], "array-shaped fleet files are tolerated rather than yielding []");
});
