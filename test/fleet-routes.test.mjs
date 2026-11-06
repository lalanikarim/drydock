// Supervisor → adapter routes: the eligibility label comes from the registry, never the fleet file.
//   node --experimental-strip-types --test test/fleet-routes.test.mjs
//
// Why this mapping is worth its own test: "which label makes an issue eligible" is policy (§5.11).
// If a deployment file could set it, one typo would silently stop all work for that repo while the
// adapter reported healthy — the exact class of failure that had already been lurking in intake,
// where the label was hardcoded to "agent" while the registry declared drydock's as "build".

import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutes } from "../fleet/supervisor.ts";
import { loadRegistry } from "../factory/repo-registry.ts";

// A fixture, not the live registry: which repos are managed is deployment state (see registryPath()).
const POLICY_FIXTURE = new URL("fixtures/repo-registry.fixture.json", import.meta.url).pathname;

const factories = [
  { repo: "octo/fix", secret: "fleet-secret" },
  { repo: "octo/build", secret: "other-fleet-secret", token: "tok", allowedSenders: ["alice"] },
];
const registry = { repos: [{ repo: "octo/fix", eligibilityLabel: "agent" }, { repo: "octo/build", eligibilityLabel: "build" }] };

test("eligibility labels come from the registry", () => {
  const routes = buildRoutes(factories, new Map(), registry);
  assert.deepEqual(
    routes.map((r) => [r.repo, r.eligibilityLabel]),
    [["octo/fix", "agent"], ["octo/build", "build"]],
  );
});

test("a fleet entry cannot override the policy label", () => {
  // The field is not even read from the entry — deployment says what runs, registry says what is allowed.
  const sneaky = [{ repo: "octo/fix", secret: "s", eligibilityLabel: "agent" }];
  const routes = buildRoutes(sneaky, new Map(), { repos: [{ repo: "octo/fix", eligibilityLabel: "build" }] });
  assert.equal(routes[0].eligibilityLabel, "build");
});

test("unregistered repos are refused rather than defaulted", () => {
  assert.throws(() => buildRoutes([{ repo: "ghost/repo", secret: "s" }], new Map(), registry), /not in the repo registry/);
});

test("secret env override and target/token/sender passthrough still hold", () => {
  const bases = new Map([["octo/fix", "http://127.0.0.1:9601"]]);
  const routes = buildRoutes(factories, bases, registry, { GITHUB_WEBHOOK_SECRET_octo_fix: "from-env" });
  const fix = routes.find((r) => r.repo === "octo/fix");
  assert.equal(fix.secret, "from-env", "env secret wins over the checked-in placeholder");
  assert.equal(fix.target, "http://127.0.0.1:9601");
  const build = routes.find((r) => r.repo === "octo/build");
  assert.equal(build.secret, "other-fleet-secret");
  assert.ok(!("target" in build), "no target until the instance reports ready");
  assert.deepEqual(build.allowedSenders, ["alice"]);
  assert.equal(build.token, "tok");
});

test("policy routes each repo by its own eligibility label", () => {
  const real = loadRegistry(POLICY_FIXTURE);
  const labelFor = (repo) => real.repos.find((r) => r.repo === repo)?.eligibilityLabel;
  assert.equal(labelFor("lalanikarim/factory-fixture"), "agent");
  assert.equal(labelFor("lalanikarim/factory-fixture-2"), "agent");
  // drydock self-work deliberately uses a different label so the factory's own issue queue is not
  // the same queue its operators use.
  assert.equal(labelFor("lalanikarim/drydock"), "build");

  const routes = buildRoutes(
    [{ repo: "lalanikarim/drydock", secret: "s" }],
    new Map(),
    real,
  );
  assert.equal(routes[0].eligibilityLabel, "build");
});
