// Config-driven targets: no probe may freeze the list of repositories it checks, and no tool that acts on
// a repository may default to a live one.
//
// Each assertion below exists because of an observed drift, not in the abstract:
//   * `gates/github-app-check.mjs` kept `["lalanikarim/drydock", fixture, fixture-2]` as a "floor" next to
//     a registry-derived half, so one report carried two answers about what the fleet manages (#128 added
//     engram and only one half noticed).
//   * `gates/self-run-task.mjs --issue N` with no `--repo` silently targeted the LIVE managed repo.
//   * `factory/pr-report.ts` embedded this project's issue-tracker URL in every PR body it posts.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { registryRepoNames, tryRegistryRepoNames } from "../gates/registry-targets.mjs";

// Policy is deployment state now (see registryPath()), so this reads the fixture. The live file is audited
// on the factory host by gates/registry-posture.mjs.
const POLICY_FIXTURE = new URL("fixtures/repo-registry.fixture.json", import.meta.url).pathname;

const ROOT = resolve(import.meta.dirname, "..");

test("targets come from policy, and only from policy", () => {
  // The original form of this test compared the reader's output against the same file it read — true no
  // matter what the code did, which is precisely the vacuity this repo keeps getting burned by (R10).
  // Non-vacuous version: point the reader at a registry naming ONE unusual repo. A hardcoded floor would
  // still return lalanikarim/* alongside it.
  const dir = mkdtempSync(join(tmpdir(), "targets-only-"));
  try {
    const only = join(dir, "only.json");
    writeFileSync(only, JSON.stringify({ repos: [{ repo: "zzb/sole-entry", enabled: true }] }));
    assert.deepEqual(registryRepoNames(only), ["zzb/sole-entry"], "the reader returned more than policy declared — a floor is back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // And the reader must not name a repository in executable code. Comments are stripped first: this file's
  // own header quotes the old hardcoded list as a cautionary tale, and an assertion that fires on prose
  // teaches nothing about behavior.
  const src = readFileSync(new URL("../gates/registry-targets.mjs", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!/lalanikarim\//.test(src), "registry-targets.mjs hardcodes a repo name — that is the #78 drift this file exists to prevent");

  const declared = new Set(JSON.parse(readFileSync(POLICY_FIXTURE, "utf8")).repos.map((r) => r.repo));
  const names = registryRepoNames(POLICY_FIXTURE);
  assert.ok(names.length > 0, "a policy with no entries yields no targets (see gates/registry-posture.mjs)");
  for (const n of names) assert.ok(declared.has(n), `${n} probed but not declared in the registry`);
});

test("a registry that cannot be read is an error, never a stale floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  try {
    assert.match(tryRegistryRepoNames(join(dir, "nope.json")).error, /cannot read repo registry/);

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    assert.match(tryRegistryRepoNames(broken).error, /not valid JSON/);

    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ repos: [] }));
    // "Nothing to probe" must not render as a pass — same rule as an uncollected test suite (R6b/R10).
    assert.match(tryRegistryRepoNames(empty).error, /refusing to report/);

    const disabled = join(dir, "disabled.json");
    writeFileSync(disabled, JSON.stringify({ repos: [{ repo: "a/b", enabled: true }, { repo: "c/d", enabled: false }] }));
    assert.deepEqual(registryRepoNames(disabled), ["a/b", "c/d"], "disabled repos stay in policy scope (#78)");
    assert.deepEqual(registryRepoNames(disabled, { includeDisabled: false }), ["a/b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provenance links follow the configured tracker, and a bad value fails at boot", async () => {
  const { trackerRepo, issueLink } = await import("../factory/provenance.ts");

  assert.equal(trackerRepo({}), "lalanikarim/drydock", "default is this project, so today's output is unchanged");
  assert.equal(
    issueLink(100, {}),
    "[#100](https://github.com/lalanikarim/drydock/issues/100)",
  );

  assert.equal(trackerRepo({ DRYDOCK_TRACKER_REPO: "acme/widget" }), "acme/widget");
  assert.equal(issueLink(96, { DRYDOCK_TRACKER_REPO: "acme/widget" }), "[#96](https://github.com/acme/widget/issues/96)");

  assert.throws(() => trackerRepo({ DRYDOCK_TRACKER_REPO: "acme-widget" }), /must be 'owner\/name'/);
  assert.throws(() => trackerRepo({ DRYDOCK_TRACKER_REPO: "   " }), /must be 'owner\/name'/);
  assert.throws(() => issueLink("not-a-number", {}), /not an issue number/);
});

test("the report body cites the configured tracker, not a frozen URL", async () => {
  process.env.DRYDOCK_TRACKER_REPO = "acme/widget";
  try {
    const { buildPrReport } = await import("../factory/pr-report.ts");
    const body = buildPrReport({
      prNumber: 7,
      branch: "agent/issue-3",
      issueNumber: 3,
      previousHead: "a".repeat(40),
      newHead: "b".repeat(40),
      outcome: "pushed",
      runStopped: true,
      verification: { ran: true, command: "npm test", exitCode: 0, passed: true },
    });
    assert.match(body, /github\.com\/acme\/widget\/issues\/100/, "retry-budget citation tracks config");
    assert.match(body, /github\.com\/acme\/widget\/issues\/96/, "auto-reply footer tracks config");
    assert.doesNotMatch(body, /lalanikarim/, "no owner leaked from a literal");
  } finally {
    delete process.env.DRYDOCK_TRACKER_REPO;
  }
});

test("self-run-task refuses to guess a repository", () => {
  const script = join(ROOT, "gates/self-run-task.mjs");

  const noRepo = spawnSync(process.execPath, [script, "--issue", "1"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(noRepo.status, 2, `expected exit 2, got ${noRepo.status}: ${noRepo.stderr}`);
  assert.match(noRepo.stderr, /--repo <owner\/name> is required/);

  const badRepo = spawnSync(process.execPath, [script, "--repo", "not-an-owner-name", "--issue", "1"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(badRepo.status, 2, "a malformed owner/name must not reach GitHub");
  assert.match(badRepo.stderr, /--repo <owner\/name> is required/);

  // Still refuses for the missing issue once a repo IS named — the guard order stays informative.
  const noIssue = spawnSync(process.execPath, [script, "--repo", "lalanikarim/factory-fixture"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(noIssue.status, 2);
  assert.match(noIssue.stderr, /usage:/);
});

test("divergence guard: no gate freezes a repository name again", () => {
  // A literal owner/name in these two files means somebody re-added the floor this change removed. The
  // registry is the only allowed source; fixture defaults live behind env vars in the g*/m* gates.
  for (const rel of ["gates/github-app-check.mjs", "gates/self-run-task.mjs"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      // Comments may mention names (they explain history); code may not.
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && /["'`]lalanikarim\//.test(line));
    assert.deepEqual(offenders, [], `${rel} hardcodes a repository: ${JSON.stringify(offenders)}`);
  }
});
