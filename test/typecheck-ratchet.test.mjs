#!/usr/bin/env node
// Tests for the typecheck ratchet (#173) — the thing that keeps 29 known errors from becoming 30.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url); // child_process + tsc paths in an ESM test
import path from "node:path";

import { tally } from "../gates/typecheck-ratchet.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_FILE = path.join(ROOT, "gates", "typecheck-baseline.json");

test("tally counts error lines and ignores prose", () => {
  const sample = [
    "factory/worker.ts(291,17): error TS2339: Property 'issueNumber' does not exist on type 'unknown'.",
    "  Type 'unknown' is not assignable to ...",
    "fleet/supervisor.ts(40,32): error TS7016: Could not find a declaration file.",
    "factory/worker.ts(300,26): error TS18046: 'task.input' is of type 'unknown'.",
    "",
  ].join("\n");
  const t = tally(sample);
  assert.equal(t.errors, 3, "three error lines means three errors");
  assert.equal(t.byFile["factory/worker.ts"], 2);
  assert.equal(t.byFile["fleet/supervisor.ts"], 1);
});

test("tally reports zero for a clean compile (and does not read 'passing' from noise)", () => {
  // The same lesson as R6/R10: a check that cannot tell "nothing collected" from "all green" is worthless.
  assert.deepEqual(tally(""), { errors: 0, byFile: {} });
  assert.deepEqual(tally("npm error code ELIFECYCLE"), { errors: 0, byFile: {} });
});

test("the committed baseline is well-formed and self-consistent", () => {
  assert.ok(existsSync(BASELINE_FILE), "gates/typecheck-baseline.json must be committed — no baseline means the ratchet exits 2");
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));

  assert.equal(typeof baseline.errors, "number");
  assert.ok(baseline.errors >= 0);
  const sum = Object.values(baseline.byFile).reduce((a, b) => a + b, 0);
  assert.equal(sum, baseline.errors, `byFile sums to ${sum} but errors says ${baseline.errors}`);
  for (const [file, count] of Object.entries(baseline.byFile)) {
    assert.ok(!path.isAbsolute(file), `${file} must be repo-relative`);
    assert.ok(count > 0, `${file} recorded with zero errors — delete the entry`);
  }
});

test("the committed baseline is currently satisfied by the real tree", () => {
  // Runs the actual script (and therefore the actual compiler) rather than re-implementing its comparison. If this
  // goes red, `npm run typecheck:ratchet` — and CI with it — is red for the same reason.
  const { spawnSync } = require("node:child_process");
  const proc = spawnSync(process.execPath, ["gates/typecheck-ratchet.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(proc.status, 0, `ratchet exited ${proc.status}:\n${proc.stdout}${proc.stderr}`);
  assert.match(`${proc.stdout}${proc.stderr}`, /typecheck ratchet OK/);
});

test("a baseline of zero would fail today's tree (the ratchet really is a gate)", () => {
  // The failure mode this protects against is a check that can never go red. Prove it can: run the same comparison
  // logic the script uses against an impossible baseline and require it to reject.
  const current = tally(
    require("node:child_process")
      .spawnSync(path.join(ROOT, "node_modules", ".bin", "tsc"), ["-p", path.join(ROOT, "tsconfig.json"), "--pretty", "false"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      })
      .stdout ?? "",
  );
  const zeroBaseline = { errors: 0, byFile: {} };
  const wouldRegress = current.errors > zeroBaseline.errors || Object.keys(current.byFile).length > 0;
  assert.ok(wouldRegress, "with a clean tree this test should be updated to use a different impossible baseline");
});
