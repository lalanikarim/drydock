// #143 — a supervisor must never die inside its own recovery path.
//
// On 2026-11-02 `fleet/supervisor.ts` called `loadRegistry()` with no error handling from a child's "exit"
// handler. #140 had just added `webhookId`; the running supervisor was one build behind, rejected the key as
// `registry.repos[2]: unknown field: webhookId`, threw inside the handler that was trying to restart a
// factory, and every factory in the fleet went down. Three defects in one line: strict parsing on a RELOAD,
// an exception allowed to escape a recovery path, and no answer to "then what do we serve?".
//
// The tests below are ordered cheapest-first, and the last two spawn REAL processes because the failure mode
// is process death — asserting that a function "did not throw" against a stub would have described the old
// code just as happily as the new.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRegistry, loadRegistryTolerant, loadRegistry } from "../factory/repo-registry.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const tmp = () => mkdtempSync(join(tmpdir(), "resilient-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const registryDoc = (extra = {}) => ({
  defaults: { eligibilityLabel: "agent", autoMerge: false },
  repos: [{ repo: "a/b" }, { repo: "c/d", ...extra }],
});

test("strict parsing is still the boot default", () => {
  assert.throws(() => validateRegistry({ ...registryDoc(), surpriseTop: 1 }), /unknown registry field: surpriseTop/);
  assert.throws(() => validateRegistry({ defaults: { autoMerge2: true }, repos: [{ repo: "a/b" }] }), /unknown registry defaults field/);
  assert.throws(() => validateRegistry(registryDoc({ webhookKind: "hook" })), /registry\.repos\[1\]: unknown field: webhookKind/);
});

test("tolerant parsing ignores fields it has not met, and says which ones", () => {
  const warnings = [];
  const reg = validateRegistry(registryDoc({ webhookKind: "hook" }), { tolerateUnknownFields: true, onWarning: (m) => warnings.push(m) });

  assert.equal(reg.repos.length, 2, "the registry still loads — the fleet keeps its repos");
  assert.deepEqual(reg.repos.map((r) => r.repo), ["a/b", "c/d"]);
  assert.ok(warnings.some((w) => /unknown field: webhookKind/.test(w)), `expected a warning naming the field, got ${JSON.stringify(warnings)}`);

  // Tolerance is per-field, not per-file: everything else in the document is still validated.
  assert.throws(
    () => validateRegistry({ defaults: {}, repos: [{ repo: "not-an-owner-name" }] }, { tolerateUnknownFields: true, onWarning: () => {} }),
    /must be "owner\/name"/,
  );
});

test("tolerance never forgives a field whose meaning moved", () => {
  // `configFile` was replaced by the $DRYDOCK_CONFIG_DIR convention. Ignoring it would mean running with
  // credentials nobody pointed at, so it stays fatal in BOTH modes.
  assert.throws(() => validateRegistry({ defaults: {}, repos: [{ repo: "a/b", configFile: "x.json" }] }), /configFile was removed/);
  assert.throws(
    () => validateRegistry({ defaults: {}, repos: [{ repo: "a/b", configFile: "x.json" }] }, { tolerateUnknownFields: true, onWarning: () => {} }),
    /configFile was removed/,
  );
});

test("tolerance covers unknown fields, not missing or corrupt policy", () => {
  const dir = tmp();
  try {
    const gone = join(dir, "nope.json");
    assert.throws(() => loadRegistryTolerant(gone), /cannot read repo registry/);

    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ broken");
    assert.throws(() => loadRegistryTolerant(corrupt), /cannot read repo registry/);

    // An additive field, on the other hand, must load — this is the exact shape that killed the fleet.
    const future = join(dir, "future.json");
    writeFileSync(future, JSON.stringify({ defaults: {}, repos: [{ repo: "a/b", webhookId: 703101252, nextFieldFromNextRelease: true }] }));
    const seen = [];
    const reg = loadRegistryTolerant(future, (m) => seen.push(m));
    assert.equal(reg.repos[0].webhookId, 703101252);
    assert.ok(seen.length === 1 && /nextFieldFromNextRelease/.test(seen[0]));

    // Strict loader still refuses it, so boot behavior is unchanged.
    assert.throws(() => loadRegistry(future), /unknown field: nextFieldFromNextRelease/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real processes: the defect is process death, so the proof has be observable in `ps`.
// ---------------------------------------------------------------------------

/** A parent whose child-exit handler runs `body`, mirroring supervisor.ts's recovery path shape. */
function spawnParentWithExitHandler(body) {
  const script = `
    const { spawn, once } = require("node:child_process");
    let line = (s) => process.stdout.write(s + "\\n");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30)"], { stdio: "inherit" });
    child.on("exit", () => {
      ${body}
    });
    setInterval(() => {}, 1000); // a supervisor always has live handles; without one node exits by design
    line("PARENT_UP " + process.pid);
    process.on("SIGTERM", () => { line("PARENT_EXIT"); process.exit(0); });
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

test("the hazard is real: an uncaught throw in a child-exit handler kills the parent", async () => {
  const p = spawnParentWithExitHandler(`throw new Error("registry.repos[2]: unknown field: webhookId");`);
  try {
    const up = await once(p.stdout, "data").then((b) => String(b));
    const pid = Number(up.match(/PARENT_UP (\d+)/)?.[1]);
    assert.ok(pid > 0, "parent should have reported its pid");

    const [code] = await once(p, "exit");
    assert.notEqual(code, 0, "this is the fleet-wide outage: the parent died from a rejection inside its own recovery path");
    assert.equal(isPidAlive(pid), false, "and it is gone, not backgrounded");
  } finally {
    // Harness hygiene learned the hard way today: an assertion that throws before teardown turns a red test
    // into a leaked keep-alive process and a suite that never returns.
    if (p.exitCode === null && !p.killed) p.kill("SIGKILL");
  }
});

test("the guarded shape survives, keeps last-good bytes, and announces on edges", async () => {
  const dir = tmp();
  let p = null; // declared outside try so the finally can always reap it
  try {
    const routesFile = join(dir, "routes.json");
    writeFileSync(routesFile, "[{\"repo\":\"a/b\"}]\n");
    const before = readFileSync(routesFile, "utf8");

    p = spawnParentWithExitHandler(`
      // The #143 shape: tolerant reload, keep last-good on any failure, announce once, carry on supervising.
      let degraded = false;
      try {
        JSON.parse("{ not valid json");            // stands in for a registry this build rejects
      } catch (e) {
        if (!degraded) {
          console.error("routes reload failed: " + e.message);
          process.stdout.write("SERVING STALE POLICY\\n");
          degraded = true;
        }
      }
      setTimeout(() => {
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(join(dir, "alive.txt"))}, String(process.pid));
      }, 400);
    `);

    let out = "";
    p.stdout.on("data", (b) => { out += String(b); });

    const outcome = await Promise.race([
      once(p, "exit").then(() => "EXITED_EARLY"),
      sleep(1500).then(() => "SURVIVED"),
    ]);
    assert.equal(outcome, "SURVIVED", "a rejected reload must not take the supervisor down");
    assert.match(out, /SERVING STALE POLICY/, `expected the edge alert in output, got: ${out}`);

    // Observable effects: still running (wrote a file 400 ms after the failure) and policy bytes untouched.
    await sleep(200);
    assert.ok(readFileSync(join(dir, "alive.txt"), "utf8").trim().length > 0, "the supervisor kept working after the failed reload");
    assert.equal(readFileSync(routesFile, "utf8"), before, "a failed routes write must leave last-good policy in place");

  } finally {
    if (p && p.exitCode === null && !p.killed) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/health reports boot time and build sha so staleness is visible from outside (#143)", async () => {
  const src = readFileSync(join(ROOT, "factory", "intake.ts"), "utf8");
  assert.match(src, /body\.startedAt = PROCESS_STARTED_AT/);
  assert.match(src, /DRYDOCK_BUILD_SHA/);

  // The supervisor is what knows the commit; it stamps children and logs both digests at boot.
  const sup = readFileSync(join(ROOT, "fleet", "supervisor.ts"), "utf8");
  assert.match(sup, /process\.env\.DRYDOCK_BUILD_SHA = buildSha/);
  assert.match(sup, /\[supervisor\] build \$\{buildSha\}/);

  // Boot stays strict (nothing to fall back on yet); every later write is tolerant.
  assert.match(sup, /writeRoutes\("boot", \{ strict: true \}\)/);
  assert.doesNotMatch(sup, /writeRoutes\(\)/, "no call site may go back to the unannotated form");
});

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
