// #247 — where the verification command runs, asserted without a container runtime.
//
// CI's unit job has no podman (`.github/workflows/ci.yml` says so out loud), so this file asserts the
// *decisions*: that the default is the container, that the container is sealed, that nothing inherits the
// host environment by accident, and that an unrunnable verification is refused rather than waved through.
// The behavior against a real runtime is gates/verification-sandbox-live.mjs — run for real, output in the PR.
//
//   node --test test/verification-sandbox.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  resolveVerificationPlan,
  verificationGate,
  formatVerificationEvidence,
  runtimeFailureReason,
  DEFAULT_VERIFICATION_IMAGE,
} from "../factory/verification.ts";
import { containerRunArgs, validateSandboxSpec, RUN_LABEL } from "../factory/container.ts";
import { SETUP_ENV_ALLOWLIST } from "../factory/setup-sandbox.ts";
import { validateFactoryConfig, DEFAULTS } from "../factory/factory-config.ts";

const baseConfig = {
  repo: "octo/widgets",
  models: { provider: "p", modelId: "m" },
};

/** Value following `flag` in an argv array. */
const pair = (args, flag) => args[args.indexOf(flag) + 1];

test("the default verification posture is the container, not the host (#247)", () => {
  const plan = resolveVerificationPlan({});
  assert.equal(plan.where, "sandbox", "omitting the mode must select the sandbox — a missing field is never 'run on the host'");
  assert.equal(plan.image, DEFAULT_VERIFICATION_IMAGE);
  assert.deepEqual(resolveVerificationPlan({ mode: "host" }), { where: "host", image: null });
  // A typo is a config error, not a silent downgrade; asserted here as well as in the config validator so
  // neither layer can be relaxed alone.
  assert.equal(DEFAULTS.verificationMode, "sandbox");
});

test("the verification container is sealed: no network, workspace bind, and no host environment by default", () => {
  const args = containerRunArgs({
    name: "factory-verify-test",
    workspace: "/srv/factory/work/issue-7",
    image: "factory-sandbox:latest",
    argv: ["node", "--test"],
    network: "none",
    envAllowlist: [],
  });
  assert.ok(args.includes("--rm"), "one-shot: --rm");
  assert.deepEqual(pair(args, "--network"), "none", "verification never inherits the runtime's default bridged network");
  assert.ok(args.includes("-v"), "the workspace is bind-mounted");
  assert.equal(pair(args, "-v"), "/srv/factory/work/issue-7:/sandbox");
  assert.equal(pair(args, "-w"), "/sandbox");
  assert.ok(args.includes(`--label`) && args.includes(`${RUN_LABEL}=factory-verify-test`), "a leaked container must be attributable");
  // The command is argv after the image, never a shell string.
  const imageAt = args.indexOf("factory-sandbox:latest");
  assert.deepEqual(args.slice(imageAt + 1), ["node", "--test"]);
  assert.ok(!args.includes("-e") && !args.some((a) => a.startsWith("--env")), "no host environment crosses the boundary by default");
});

test("environment pass-through is by NAME only — a value never appears in argv", () => {
  // `-e NAME` forwards the client's value at spawn time; `-e NAME=value` would put the secret in the
  // process list (and any `ps`/audit log), which is the leak shape #247 is about.
  const args = containerRunArgs({
    name: "n",
    workspace: "/w",
    image: "i",
    argv: ["node", "--test"],
    network: "none",
    envAllowlist: ["https_proxy", "NPM_CONFIG_REGISTRY"],
  });
  const envFlags = args.filter((a, i) => args[i] === "-e");
  assert.equal(envFlags.length, 2);
  const forwarded = args.map((a, i) => (args[i] === "-e" ? args[i + 1] : null)).filter(Boolean);
  assert.deepEqual(forwarded, ["https_proxy", "NPM_CONFIG_REGISTRY"]);
  assert.ok(!forwarded.some((v) => v.includes("=")), "names only — never NAME=value");
});

test("the setup container's allowlist carries no credential-shaped names", () => {
  // A registry/proxy override is the whole reason a setup container gets any environment. Anything that
  // looks like a token, key, secret, or chat id here would re-open #247 through the other door.
  const credentialish = SETUP_ENV_ALLOWLIST.filter((n) => /TOKEN|SECRET|KEY|PASS|CHAT|APP|CRED/i.test(n));
  assert.deepEqual(credentialish, [], `setup env allowlist must name proxy/registry variables only: ${credentialish.join(", ")}`);
});

test("validateSandboxSpec rejects an image outside the allowlist and a workspace outside the mount root", () => {
  const policy = { allowImages: ["factory-sandbox:latest"], mountRoot: "/srv/factory/work" };
  assert.doesNotThrow(() => validateSandboxSpec({ image: "factory-sandbox:latest", workspace: "/srv/factory/work/issue-7", ...policy }));
  assert.throws(() => validateSandboxSpec({ image: "docker.io/library/alpine", workspace: "/srv/factory/work/issue-1", ...policy }), /not allowlisted/);
  assert.throws(() => validateSandboxSpec({ image: "factory-sandbox:latest", workspace: "/etc", ...policy }), /outside the allowed mount root/);
  // Prefix trickery: /srv/factory-work is not under /srv/factory/work.
  assert.throws(() => validateSandboxSpec({ image: "factory-sandbox:latest", workspace: "/srv/factory/work-evil", ...policy }), /outside the allowed mount root/);
});

test("an unrunnable verification refuses the push, is classed as infrastructure, and outranks a waiver (#247)", () => {
  const infra = { ran: false, command: "node --test", exitCode: null, timedOut: false, passed: false, tail: "", where: "sandbox", image: "factory-sandbox:latest", infraError: "podman: ENOENT" };

  const strict = verificationGate(infra, { requireVerification: true });
  assert.equal(strict.action, "refuse");
  assert.equal(strict.infra, true, "the caller needs to tell 'our runtime is broken' from 'the suite is red' (#100 budget classing)");

  // The hostile case: a repo that waives verification must NOT get a pass out of a broken runtime.
  const waived = verificationGate(infra, { requireVerification: false });
  assert.equal(waived.action, "refuse", "waiving verification is not a license for the runtime to have executed nothing");
  assert.equal(waived.infra, true);

  // And the text must not read like a test result — that is what sends the orchestrator re-delegating.
  assert.match(strict.reason, /infrastructure/i);
  assert.match(strict.reason, /not a test result/i);
});

test("the PR body says where the code ran (#247)", () => {
  const base = { ran: true, command: "node --test", exitCode: 0, timedOut: false, passed: true, tail: "ok" };
  const sandboxed = formatVerificationEvidence({ ...base, where: "sandbox", image: "factory-sandbox:latest" });
  assert.match(sandboxed, /sealed container/);
  assert.match(sandboxed, /--network none/);
  assert.match(sandboxed, /factory-sandbox:latest/);

  const onHost = formatVerificationEvidence({ ...base, where: "host", image: null });
  assert.match(onHost, /the factory HOST/, "a host run must be loud in the artifact a human merges");
  assert.match(onHost, /verificationMode/);

  const infra = formatVerificationEvidence({ ...base, passed: false, ran: false, infraError: "podman: ENOENT" });
  assert.match(infra, /NOT VERIFIED/);
  assert.match(infra, /infrastructure/);
});

test("verificationMode is validated at config load — a typo cannot select host execution", () => {
  assert.equal(validateFactoryConfig({ ...baseConfig }).verificationMode, "sandbox");
  assert.equal(validateFactoryConfig({ ...baseConfig, verificationMode: "host" }).verificationMode, "host");
  for (const bad of ["Sandbox", "SANDBOX", "container", "", true, null, 1]) {
    assert.throws(() => validateFactoryConfig({ ...baseConfig, verificationMode: bad }), /verificationMode/, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("an exit code from the runtime is not a test result (#247, found by running the live gate)", () => {
  // 125 = "the runtime failed", 126/127 = could not execute. All three mean nothing was verified.
  assert.match(runtimeFailureReason(125, 'Error: initializing source docker://nope: no such image') ?? "", /exit 125/);
  assert.match(runtimeFailureReason(126, "permission denied") ?? "", /exit 126/);
  assert.match(runtimeFailureReason(127, "node: not found") ?? "", /exit 127/);
  // A suite that genuinely failed stays a test result, even if its output contains the word Error.
  assert.equal(runtimeFailureReason(1, "AssertionError: expected 1 to be 2"), null);
  assert.equal(runtimeFailureReason(0, "ℹ pass 5"), null);
  // 125 without a runtime marker stays a test result — the safe direction is a normal red refusal.
  assert.equal(runtimeFailureReason(125, "some suite exited 125 for its own reasons"), null);
});

test("a stub runtime proves infra-vs-red classification without podman in CI", async () => {
  const { verifyWorkspace } = await import("../factory/verification.ts");
  const dir = mkdtempSync(join(tmpdir(), "verify-stub-"));
  try {
    const stub = (name, body) => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    // Hostile in the direction reality is: podman answers a missing image with 125 + an Error line.
    const broken = stub("runtime-broken.sh", `echo 'Error: initializing source docker://nope:none: reading manifest: no such image' >&2; exit 125`);
    // And a cooperative-in-the-right-way stub for the contrast case: a real red suite.
    const red = stub("runtime-red.sh", `echo 'ℹ tests 4'; echo 'ℹ pass 3'; echo 'ℹ fail 1'; exit 1`);
    const green = stub("runtime-green.sh", `echo 'ℹ tests 4'; echo 'ℹ pass 4'; echo 'ℹ fail 0'; exit 0`);

    const infra = await verifyWorkspace({ cwd: dir, testCommand: "node --test", runtime: broken, timeoutSecs: 30 });
    assert.equal(infra.ran, false, "nothing ran, so the evidence must not claim it did");
    assert.equal(infra.passed, false);
    assert.match(infra.infraError ?? "", /exit 125/);
    const infraGate = verificationGate(infra, { requireVerification: false });
    assert.equal(infraGate.action, "refuse");
    assert.equal(infraGate.infra, true);

    const failed = await verifyWorkspace({ cwd: dir, testCommand: "node --test", runtime: red, timeoutSecs: 30 });
    assert.equal(failed.ran, true);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.infraError, undefined, "a red suite is a result, not an infrastructure fault");
    assert.equal(failed.failCount, 1, "counts still parse on this path");
    const failedGate = verificationGate(failed, { requireVerification: true });
    assert.equal(failedGate.action, "refuse");
    assert.ok(!failedGate.infra, "the budget class must stay `verification`, not infrastructure");

    const passed = await verifyWorkspace({ cwd: dir, testCommand: "node --test", runtime: green, timeoutSecs: 30 });
    assert.equal(passed.passed, true, `expected a passing sandboxed run, got ${JSON.stringify(passed)}`);
    assert.equal(passed.where, "sandbox");
    assert.equal(verificationGate(passed, { requireVerification: true }).action, "proceed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-vacuity: a verification image nobody allowlisted never executes", async () => {
  // The containment floor is what stands between a config typo and running an arbitrary image, so it is
  // exercised through the real entrypoint rather than through validateSandboxSpec alone. It must reject
  // BEFORE spawning — an error naming the allowlist, not a suite result.
  const { verifyWorkspace } = await import("../factory/verification.ts");
  await assert.rejects(
    () =>
      verifyWorkspace({
        cwd: resolve("."),
        testCommand: "node --test",
        sandboxImage: "totally-not-here:latest",
        sandboxPolicy: { allowImages: ["factory-sandbox:latest"], mountRoot: resolve(".") },
        timeoutSecs: 5,
      }),
    /not allowlisted/,
  );
});
