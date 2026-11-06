// #247 — run the sandboxed verification gate against a REAL container runtime, once, for evidence.
//
// Why a gate script and not only a test: hermetic tests can prove that `verifyWorkspace` builds the argv it
// intends. They cannot prove that podman honors it — that the network really is sealed, that the host
// environment really does not cross the boundary, and that a timed-out run leaves no container behind
// (#251 was exactly this: the code looked right and the container stayed up). Those are properties of the
// runtime, so they get checked against the runtime.
//
//   node gates/verification-sandbox-live.mjs [--image factory-sandbox:latest] [--keep]
//
// Exits non-zero if any check fails, including "no container runtime found" — on a factory host podman is
// a dependency, so a missing runtime is a finding, not a skip. Set FACTORY_CONTAINER_RUNTIME for a
// non-default binary (e.g. docker).
//
// Nothing here needs a model endpoint or a GitHub credential: the gate drives verification directly, which
// is the only factory path that executes repository-authored code.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { verifyWorkspace, verificationGate, formatVerificationEvidence } from "../factory/verification.ts";
import { CONTAINER_RUNTIME, listContainersByPrefix } from "../factory/container.ts";

const pExecFile = promisify(execFile);
const argv = process.argv.slice(2);
const imageAt = argv.indexOf("--image");
const IMAGE = imageAt >= 0 ? argv[imageAt + 1] : "factory-sandbox:latest";
const KEEP = argv.includes("--keep");

/** A value that must never be observable from inside the verification container. */
const CANARY_NAME = "CANARY_NOT_FOR_THE_CONTAINER";
const CANARY_VALUE = `leaked-${Date.now()}`;
process.env[CANARY_NAME] = CANARY_VALUE;

const root = mkdtempSync(join(tmpdir(), "verify-gate-247-"));
let failures = 0;
const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name} — ${detail}`);
};
const check = (cond, name, detail = "") => (cond ? ok(name, detail) : bad(name, detail || "assertion failed"));

async function runtimeAvailable() {
  try {
    await pExecFile(CONTAINER_RUNTIME, ["version", "--format", "{{.Version}}"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Containers this gate created, still known to the runtime (running OR stopped). */
async function survivingContainers() {
  const { stdout } = await pExecFile(CONTAINER_RUNTIME, ["ps", "-a", "--filter", "name=factory-verify", "--format", "{{.Names}}|{{.Status}}"], { timeout: 30_000 });
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

if (!(await runtimeAvailable())) {
  console.error(`FAIL no container runtime — \`${CONTAINER_RUNTIME} version\` did not succeed.`);
  console.error("     On the factory host podman is a dependency of verification; elsewhere run this gate on that host.");
  process.exit(1);
}
console.log(`# runtime: ${CONTAINER_RUNTIME}, image: ${IMAGE}, workspace: ${root}`);

// ---- 1. a green suite runs IN the container, and its effects land on the host mount ----
writeFileSync(join(root, "in-container.test.mjs"), `import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

test("green, executed inside the container", () => {
  // Written by the container process; if it appears on the host, model-authored code ran there.
  writeFileSync("/sandbox/proved-in-container.json", JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv1: process.argv[1] }));
  assert.ok(true);
});
`);

const green = await verifyWorkspace({ cwd: root, testCommand: "node --test in-container.test.mjs", sandboxImage: IMAGE, timeoutSecs: 120 });
check(green.where === "sandbox", "evidence records where it ran", `where=${green.where}`);
check(green.ran && green.passed && green.exitCode === 0, "green suite passes in the container", `exit=${green.exitCode} infraError=${green.infraError ?? "none"}`);
check(existsSync(join(root, "proved-in-container.json")), "the container wrote through the bind mount");
if (existsSync(join(root, "proved-in-container.json"))) {
  const proof = JSON.parse(readFileSync(join(root, "proved-in-container.json"), "utf8"));
  check(proof.cwd === "/sandbox", "working directory is the container path", `cwd=${proof.cwd}`);
}
check(verificationGate(green, { requireVerification: true }).action === "proceed", "the gate proceeds on real passing evidence");

// ---- 2. the host environment does not cross the boundary ----
writeFileSync(join(root, "env.test.mjs"), `import test from "node:test";
import { writeFileSync } from "node:fs";
test("report the environment this container can see", () => {
  writeFileSync("/sandbox/env.json", JSON.stringify(process.env));
});
`);
const envRun = await verifyWorkspace({ cwd: root, testCommand: "node --test env.test.mjs", sandboxImage: IMAGE, timeoutSecs: 120 });
if (!envRun.passed) bad("environment probe ran", `exit=${envRun.exitCode} ${envRun.tail.slice(0, 200)}`);
else {
  const seen = readFileSync(join(root, "env.json"), "utf8");
  check(!seen.includes(CANARY_VALUE), "a host secret value is invisible inside the verification container");
  const keys = Object.keys(JSON.parse(seen));
  const credentialish = keys.filter((k) => /TOKEN|SECRET|API_KEY|CHAT_ID|APP_ID|PRIVATE_KEY/i.test(k));
  check(credentialish.length === 0, "no credential-shaped host variable crossed", `saw: ${credentialish.join(", ") || "(none)"}`);
}

// ---- 3. egress is sealed ----
writeFileSync(join(root, "net.test.mjs"), `import test from "node:test";
import { writeFileSync } from "node:fs";
test("report whether the container has network", async () => {
  let verdict = "reachable";
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    await fetch("http://example.com/", { signal: ac.signal });
    clearTimeout(t);
  } catch (e) {
    verdict = "sealed:" + String((e && e.cause && e.cause.code) || e.message || "error").slice(0, 60);
  }
  writeFileSync("/sandbox/net.json", verdict);
});
`);
const netRun = await verifyWorkspace({ cwd: root, testCommand: "node --test net.test.mjs", sandboxImage: IMAGE, timeoutSecs: 120 });
if (!netRun.passed) bad("network probe ran", `exit=${netRun.exitCode} ${netRun.tail.slice(0, 200)}`);
else {
  const verdict = readFileSync(join(root, "net.json"), "utf8");
  check(verdict.startsWith("sealed"), "the verification container has no network path to the internet", verdict);
}

// ---- 4. a timeout stops AND removes the container (#251) ----
writeFileSync(join(root, "hang.mjs"), "// never exits on its own; a hang must not outlive the verification run\nsetInterval(() => {}, 1000);\n");
const hung = await verifyWorkspace({ cwd: root, testCommand: "node hang.mjs", sandboxImage: IMAGE, timeoutSecs: 8 });
check(hung.timedOut === true && hung.passed === false, "a hanging verification reports timed out, not passed", `exit=${hung.exitCode}`);
check(!hung.cleanupError, "the runner itself proved the container was gone before returning", hung.cleanupError ?? "(no cleanup error)");
const leaked = await survivingContainers();
check(leaked.length === 0, "no verification container survived the timeout", leaked.join("; ") || "(none)");
check(verificationGate(hung, { requireVerification: true }).action === "refuse", "a timed-out verification refuses the push");

// ---- 5. a broken runtime is infrastructure, never a pass ----
const broken = await verifyWorkspace({ cwd: root, testCommand: "node --test", sandboxImage: "definitely-not-a-local-image-247:none", timeoutSecs: 60 });
check(broken.ran === false && Boolean(broken.infraError), "an unstartable image is reported as an infrastructure failure", broken.infraError ?? JSON.stringify(broken).slice(0, 160));
const waived = verificationGate(broken, { requireVerification: false });
check(waived.action === "refuse" && waived.infra === true, "even a repo that waives verification is refused when nothing could run", waived.reason ?? "");
check(/infrastructure/i.test(waived.reason ?? "") && /not a test result/i.test(waived.reason ?? ""), "the refusal text says infrastructure, not 'the suite failed'");

// ---- 6. the explicit host opt-out still works, and discloses itself ----
// Its own fixture: the in-container one writes to /sandbox, which only exists inside a container.
writeFileSync(join(root, "host-green.test.mjs"), `import test from "node:test";
import assert from "node:assert/strict";
test("green on the host", () => assert.ok(true));
`);
const host = await verifyWorkspace({ cwd: root, testCommand: "node --test host-green.test.mjs", mode: "host", timeoutSecs: 120 });
check(host.where === "host" && host.passed, "mode:\"host\" runs on the host (the documented escape hatch)", `exit=${host.exitCode}`);
check(/factory HOST/.test(formatVerificationEvidence(host)), "a host run is disclosed in bold in the PR body");
// The canary must also be visible on the host path — proof the two modes really are different code paths,
// not one path with a label (an inherited-environment host run is what #247 was about).
check(process.env[CANARY_NAME] === CANARY_VALUE, "(control) the host path does inherit this process's environment");

// ---- 7. the setup container shares the runner, so it gets the same guarantees (#251) ----
writeFileSync(join(root, "setup-ok.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync("/sandbox/setup-ran.json", JSON.stringify({ node: process.version, cwd: process.cwd() }));
`);
const { runSetupInContainer } = await import("../factory/setup-sandbox.ts");
try {
  await runSetupInContainer({ workspace: root, image: IMAGE, setupCommand: "node setup-ok.mjs", timeoutSecs: 120, policy: { allowImages: [IMAGE], mountRoot: root } });
  check(existsSync(join(root, "setup-ran.json")), "the setup container installed through the bind mount");
} catch (e) {
  bad("setup container ran", e.message);
}
// Setup is the one factory container with egress, so a timeout there must not leave it up either.
try {
  await runSetupInContainer({ workspace: root, image: IMAGE, setupCommand: "node hang.mjs", timeoutSecs: 6, policy: { allowImages: [IMAGE], mountRoot: root } });
  bad("setup timeout rejects", "a hanging setup command resolved instead of rejecting");
} catch (e) {
  check(/timed out/.test(e.message), "a hanging setup command rejects", e.message.slice(0, 140));
}
const setupLeaks = await listContainersByPrefix("factory-");
check(setupLeaks.length === 0, "no factory container (verify or setup) survived this gate", setupLeaks.join("; ") || "(none)");
// A policy violation must fail before the runtime is touched (#251's containment half).
try {
  await runSetupInContainer({ workspace: root, image: "not-allowlisted-247:latest", setupCommand: "node setup-ok.mjs", timeoutSecs: 10, policy: { allowImages: [IMAGE], mountRoot: root } });
  bad("setup respects the image allowlist", "an unallowlisted image was accepted");
} catch (e) {
  check(/not allowlisted/.test(e.message), "setup rejects an image outside the allowlist before spawning");
}

// ---- cleanup ----
const stillThere = await survivingContainers();
if (!KEEP) rmSync(root, { recursive: true, force: true });
console.log(`# verification containers left behind: ${stillThere.length === 0 ? "none" : stillThere.join("; ")}`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed — sandboxed verification is NOT proven on this host.`);
  process.exit(1);
}
console.log("\nAll #247 checks passed against the real runtime.");
