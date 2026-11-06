// Repo registry tests (factory/repo-registry.ts + the policy fixture it loads).
//   node --experimental-strip-types --test test/repo-registry.test.mjs
//
// The registry is where "may the pipeline merge here?" and "which label makes an issue workable?"
// are answered for every repo, so its validation rules are the safety surface: a typo'd entry must
// fail loudly at load, never silently default to permissive.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Policy content is deployment state (see registryPath()), so the assertions about what a policy does —
// scope, labels, oracle routing — run against this fixture, which mirrors the shipped shape. Invariants
// about THIS machine's live registry are audited by gates/registry-posture.mjs on the factory host.
const POLICY_FIXTURE = new URL("fixtures/repo-registry.fixture.json", import.meta.url).pathname;
const {
  validateRegistry,
  loadRegistry,
  requireRepo,
  requireEnabledRepo,
  enabledRepos,
  registryRepoNames,
  missingRuntimeConfigs,
  registryPath,
  EXAMPLE_REGISTRY_PATH,
  REGISTRY_ENV_VAR,
} = await import("../factory/repo-registry.ts");
const { configDir } = await import("../factory/factory-config.ts");
const { loadProbes } = await import("../gates/behavior-probes.mjs");
const { loadFactoryConfig } = await import("../factory/factory-config.ts");

const BOOT_STDOUT = { command: "node", args: ["src/server.mjs", "0"], portFrom: "stdout", stdoutPattern: "127\\.0\\.0\\.1:(\\d+)" };
const BOOT_ENV = { command: "node", args: ["src/server.js"], portFrom: "env", envPortVar: "PORT" };

const entry = (over = {}) => ({
  repo: "octo/thing",
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
  const registry = validateRegistry({ repos: [entry({ enabled: false, autoMerge: false })] });
  assert.equal(registry.repos[0].enabled, false);
});

test("configFile is gone from the schema, and the error names what replaced it", () => {
  // A pointer field in policy let two things disagree about where runtime config lives. Convention replaced
  // it, so the old key must be rejected loudly with a migration message rather than as an anonymous
  // "unknown field" someone has to go dig through git history to understand.
  assert.throws(
    () => validateRegistry({ repos: [entry({ configFile: "factory/config/x.json" })] }),
    /configFile was removed[\s\S]*DRYDOCK_CONFIG_DIR/,
  );
});

test("missingRuntimeConfigs names every enabled repo without config — and none that has it", () => {
  const dir = mkdtempSync(join(tmpdir(), "drydock-cfgdir-"));
  try {
    writeFileSync(
      join(dir, "octo_thing.json"),
      JSON.stringify({ repo: "octo/thing", models: { provider: "p", modelId: "m-model" }, testCommand: "node --test" }),
    );
    const registry = validateRegistry({ repos: [entry(), entry({ repo: "octo/two" })] });
    const missing = missingRuntimeConfigs(registry, { dir });
    assert.deepEqual(missing.map((m) => m.repo), ["octo/two"], "the configured repo must not be reported");
    assert.equal(missing[0].path, join(dir, "octo_two.json"), "names the path to create, not just the repo");

    // Disabled entries are policy statements, not deployments: they need no file.
    const withDisabled = validateRegistry({ repos: [entry({ repo: "octo/off", enabled: false, autoMerge: false })] });
    assert.deepEqual(missingRuntimeConfigs(withDisabled, { dir }), []);

    // `repos` narrows to what a fleet actually wants to start, so a partial deployment is not blocked by an
    // unrelated enabled entry.
    assert.deepEqual(missingRuntimeConfigs(registry, { dir, repos: ["octo/thing"] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("the policy fixture loads and describes every managed repo", () => {
  const registry = loadRegistry(POLICY_FIXTURE);
  // The snapshot is deliberate: this list is the difference between "the factory may act on this
  // repository" and it is not, so a fixture edit must be an intentional one.
  assert.deepEqual(registryRepoNames(registry), [
    "lalanikarim/factory-fixture",
    "lalanikarim/factory-fixture-2",
    "lalanikarim/drydock",
    "lalanikarim/engram",
    "lalanikarim/tasklight",
  ]);
  const fx1 = requireEnabledRepo(registry, "lalanikarim/factory-fixture");
  assert.equal(fx1.oracleBoot.portFrom, "stdout", "fixture-1 logs the port it bound");
  const fx2 = requireEnabledRepo(registry, "lalanikarim/factory-fixture-2");
  assert.equal(fx2.oracleBoot.portFrom, "env", "fixture-2 takes PORT and logs the requested value");
});

test("drydock is enabled for self-work and can never auto-merge", () => {
  const raw = JSON.parse(readFileSync(POLICY_FIXTURE, "utf8"));
  const drydock = raw.repos.find((r) => r.repo === "lalanikarim/drydock");
  // Enabled since #58. Dispatch still requires a deliberate act by an allowlisted sender:
  // the `build` eligibility label on an issue, or a `/factory` comment on a factory PR.
  assert.equal(drydock.enabled, true, "self-work is enabled: nothing starts a run without an eligible event");
  // The invariant that replaced "disabled" as the safety story. autoMerge:false is what removes
  // merge_pr from the tool list entirely (test/repo-enforcement.test.mjs), so a self-run cannot land
  // anything in the repo holding the research record even if every other control were bypassed.
  assert.equal(drydock.autoMerge, false, "the factory must never merge into the repo holding the research record");
  assert.notEqual(drydock.eligibilityLabel, "agent", "drydock's own backlog is not factory work by default");
  // Self-grading: the oracles live under gates/, which a self-run must not be able to edit.
  assert.ok(!drydock.pathAllowlist.includes("gates/"), "a self-run may not edit the gates that judge it");
  assert.ok(drydock.protectedPaths.includes("gates/probes/"), "the oracles stay protected even if gates/ were ever allowlisted");
});

test("engram is managed but can never auto-merge, and the vendored pin stays protected", () => {
  // Onboarding engram closes most of #78: it was reachable-but-unmanaged, which left "the App could write
  // an unprotected kernel main" as a residual. Managed is only safer than reachable if the posture below
  // holds, so it is pinned rather than trusted to the JSON reading well.
  const registry = loadRegistry(POLICY_FIXTURE);
  const engram = requireEnabledRepo(registry, "lalanikarim/engram");
  assert.equal(engram.autoMerge, false, "the kernel repo stops at a draft PR for human merge");
  assert.notEqual(engram.eligibilityLabel, "agent", "engram's own backlog is not factory work by default");
  // drydock vendors the kernel at vendor/engram; a run that broke poc/lib/ would desync the pin discipline.
  assert.ok(engram.protectedPaths.includes("poc/lib/"), "the vendored kernel surface must stay protected");
  assert.ok(!engram.pathAllowlist.includes("vendor/"), "a managed repo may not widen its own vendor tree");
  // #78's precondition for the first dispatch here: branch protection on main, verified live.
  // Runbook: `gh api repos/lalanikarim/engram/branches/main/protection` must answer, not 404.
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
  const registry = loadRegistry(POLICY_FIXTURE);
  for (const entry of registry.repos) {
    assert.equal(entry.requireVerification, true, `${entry.repo} waives verification — PR bodies there would say "NOT VERIFIED"`);
  }
});

test("the checked-in config template validates and stays a template", () => {
  // The template is the only config artifact in the tree now. It has to keep parsing as a shape (so a
  // refactor of the schema cannot leave it describing a file nothing would accept), and it must stay
  // obviously not-a-deployment: no real repo, no real model.
  const cfg = loadFactoryConfig(join(ROOT, "factory", "config.example.json"));
  assert.equal(cfg.repo, "owner/name", "template must not name a managed repo (a copy that forgets to change it boots as the wrong repo…)");
  assert.ok(!/qwen|gpt|claude/i.test(cfg.models.modelId), `template pins a real model: ${cfg.models.modelId}`);
});

// --- where the registry lives ---------------------------------------------------------------
// It used to be factory/repo-registry.json. These are the guards that keep it from creeping back:
// policy must resolve outside the tree, say so when absent, and stay out of git.

test("registryPath resolves the env override, then the config dir — never the source tree", () => {
  assert.equal(registryPath({ DRYDOCK_REGISTRY_PATH: "/etc/drydock/registry.json" }), "/etc/drydock/registry.json");
  assert.equal(
    registryPath({ DRYDOCK_CONFIG_DIR: "/srv/fleet/configs" }),
    join("/srv/fleet/configs", "repo-registry.json"),
    "the config dir is the default home",
  );
  const live = registryPath({});
  assert.ok(!live.startsWith(ROOT), `the registry must not resolve inside the source tree: ${live}`);
  // Empty/whitespace overrides are ignored rather than resolving to a relative surprise.
  assert.ok(!registryPath({ DRYDOCK_REGISTRY_PATH: "   " }).startsWith(ROOT));
});

test("a missing registry names all three ways to fix it", () => {
  const gone = join(mkdtempSync(join(tmpdir(), "reg-absent-")), "repo-registry.json");
  assert.throws(
    () => loadRegistry(gone),
    (e) =>
      /cannot read repo registry/.test(e.message) &&
      e.message.includes(gone) &&
      e.message.includes(EXAMPLE_REGISTRY_PATH) &&
      e.message.includes(REGISTRY_ENV_VAR),
    "the message must name the path, the committed example, and the env override",
  );
});

test("a registry that exists but does not parse is NOT told to copy the example over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-corrupt-"));
  const path = join(dir, "repo-registry.json");
  writeFileSync(path, "{ nope ");
  assert.throws(
    () => loadRegistry(path),
    (e) => /cannot read repo registry/.test(e.message) && !e.message.includes("copy"),
  );
});

test("the committed example validates and stays a template", () => {
  const example = loadRegistry(EXAMPLE_REGISTRY_PATH);
  assert.ok(example.repos.length >= 1, "an example with no entries teaches nothing");
  for (const entry of example.repos) {
    assert.ok(entry.repo.startsWith("example/"), `template names a real repo: ${entry.repo}`);
  }
  assert.ok(!JSON.stringify(example).includes("lalanikarim"), "the template must not leak this deployment");
});

test("factory/repo-registry.json is not a tracked artifact", (t) => {
  // The regression this prevents: someone restores the file 'because it was here before', and policy
  // silently becomes branch-switchable and self-editable again.
  let tracked;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "factory/repo-registry.json"], { cwd: ROOT, stdio: "ignore" });
    tracked = true;
  } catch (e) {
    if (e && e.code === "ENOENT") {
      t.skip("git unavailable — cannot inspect the index");
      return;
    }
    tracked = false;
  }
  assert.equal(tracked, false, "factory/repo-registry.json is tracked again — it is deployment state; see registryPath()");
});

test("runtime configs on this machine parse and agree with the live registry", (t) => {
  // Deployment-side files, so they exist only where a fleet actually runs. CI has neither the registry nor
  // the per-repo configs — that is the point of moving them out — so this skips rather than pretending.
  const dir = configDir();
  let registry;
  try {
    registry = loadRegistry();
  } catch (e) {
    t.skip(`no live repo registry on this machine: ${String(e.message).split("\n")[0]}`);
    return;
  }
  const present = registry.repos.filter((r) => {
    try {
      readFileSync(join(dir, `${r.repo.replace("/", "_")}.json`), "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (present.length === 0) {
    t.skip(`no runtime configs in ${dir} (deployment files; absent on a CI runner)`);
    return;
  }
  for (const entry of present) {
    const path = join(dir, `${entry.repo.replace("/", "_")}.json`);
    const cfg = loadFactoryConfig(path);
    assert.equal(cfg.repo, entry.repo, `${path} declares ${cfg.repo}, registry says ${entry.repo}`);
    assert.ok(cfg.testCommand.length > 0, `${entry.repo} must declare how it is tested`);
  }
});

test("every oracle declares a repo, and every oracle repo is in the registry", async () => {
  const registry = loadRegistry(POLICY_FIXTURE);
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

// --- prFeedback: comments as a rework trigger (#67) -------------------------------------------

test("PR feedback is off unless a repo says otherwise", () => {
  const registry = validateRegistry({ repos: [entry()] });
  assert.equal(registry.defaults.prFeedback, false);
  assert.equal(registry.repos[0].prFeedback, false, "a comment-driven trigger cannot arrive by inheritance from the defaults");
});

test("prFeedback cascades from defaults and can be overridden per repo", () => {
  const registry = validateRegistry({
    defaults: { prFeedback: true },
    repos: [entry(), entry({ repo: "octo/other", prFeedback: false })],
  });
  assert.equal(registry.repos[0].prFeedback, true);
  assert.equal(registry.repos[1].prFeedback, false);
});

test("prFeedback must be a real boolean — Boolean(\"false\") is true (R6)", () => {
  for (const bad of ["false", "true", 0, 1, null]) {
    assert.throws(
      () => validateRegistry({ repos: [entry({ prFeedback: bad })] }),
      /prFeedback/,
      `${JSON.stringify(bad)} must not load as a policy flag`,
    );
  }
});

test("drydock opts in, the fixtures do not", () => {
  const registry = loadRegistry(POLICY_FIXTURE);
  const byName = Object.fromEntries(registry.repos.map((r) => [r.repo, r]));
  // drydock: dogfooding target — a human comments "/factory rebase" on its own draft PRs.
  assert.equal(byName["lalanikarim/drydock"].prFeedback, true);
  // Fixtures stay off: they are graded targets, and a trigger reachable by comment would be one more
  // thing an oracle run could accidentally set off.
  assert.equal(byName["lalanikarim/factory-fixture"].prFeedback, false);
  assert.equal(byName["lalanikarim/factory-fixture-2"].prFeedback, false);
});

test("the supervisor copies prFeedback onto the route it hands the adapter", async () => {
  const { buildRoutes } = await import("../fleet/supervisor.ts");
  const factories = [
    { repo: "lalanikarim/drydock", secret: "s1" },
    { repo: "lalanikarim/factory-fixture", secret: "s2" },
  ];
  const registry = loadRegistry(POLICY_FIXTURE);
  const routes = buildRoutes(factories, new Map(), registry, { WEBHOOK_SECRET_LALANIKARIM_DRYDOCK: "x1", WEBHOOK_SECRET_LALANIKARIM_FACTORY_FIXTURE: "x2" });
  const drydock = routes.find((r) => r.repo === "lalanikarim/drydock");
  const fixture = routes.find((r) => r.repo === "lalanikarim/factory-fixture");
  assert.equal(drydock.prFeedback, true, "policy has to reach the adapter or it enforces nothing");
  assert.equal("prFeedback" in fixture, false, "a repo that never opted in gets no field, so routes stay byte-stable");
});

// ---- webhookId: which hook's deliveries the sweep must cover (#107) -------------------------------
//
// Onboarding a repo used to leave its failed-delivery sweep untouched, because the sweep kept its own copy of
// "which repos exist" in an installed launchd plist. The id now lives here so that "enabled but unswept" is a
// question the registry can answer.

const { sweepTargets, missingWebhookIds } = await import("../factory/repo-registry.ts");

const regWith = (repos) => validateRegistry({ defaults: { eligibilityLabel: "agent", autoMerge: true, enabled: true }, repos });

test("webhookId is accepted as a number and stays absent when unrecorded", () => {
  const r = regWith([
    { repo: "a/one", webhookId: 703101252 },
    { repo: "a/two" },
  ]);
  assert.equal(r.repos[0].webhookId, 703101252);
  assert.ok(!("webhookId" in r.repos[1]), "no default invented — 'nobody recorded it' must stay representable");
});

test("a webhookId that is a string is rejected: it would sweep nothing forever and say it was clean", () => {
  assert.throws(
    () => regWith([{ repo: "a/one", webhookId: "703101252" }]),
    /webhookId must be a positive integer GitHub hook id \(not a string\)/,
  );
  assert.throws(() => regWith([{ repo: "a/one", webhookId: 0 }]), /webhookId/);
  assert.throws(() => regWith([{ repo: "a/one", webhookId: -3 }]), /webhookId/);
  assert.throws(() => regWith([{ repo: "a/one", webhookId: 1.5 }]), /webhookId/);
});

test("sweepTargets covers enabled repos with an id; missingWebhookIds names the rest", () => {
  const r = regWith([
    { repo: "a/deployed", webhookId: 1 },
    { repo: "a/unrecorded", enabled: true },
    { repo: "a/retired", enabled: false, autoMerge: false, webhookId: 2 },
  ]);
  assert.deepEqual(sweepTargets(r), [{ repo: "a/deployed", webhookId: 1 }]);
  assert.deepEqual(missingWebhookIds(r), ["a/unrecorded"], "enabled with no id is the blind spot worth alarming on");
});

test("the real registry records a hook id for every deployed repo", () => {
  // A pin, deliberately: deleting these turns the scheduled sweep back into the version that quietly ignored
  // a repo. Engram was in exactly that state from the day it was onboarded.
  const targets = sweepTargets(loadRegistry(POLICY_FIXTURE));
  const byRepo = Object.fromEntries(targets.map((t) => [t.repo, t.webhookId]));
  assert.equal(byRepo["lalanikarim/drydock"], 703101252);
  assert.equal(byRepo["lalanikarim/engram"], 706043067);
});
