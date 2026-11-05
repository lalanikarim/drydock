// Deploy-posture drift gate (#220 assertion 4). Run by `npm test` via the `test/*.test.mjs` glob — if you rename
// this file off that pattern, wire it into package.json or it stops running in silence.
//
// The gate's own failure mode is not a wrong verdict, it is collecting nothing and reporting success (the R6b/R10
// rule in research/work-queue.md). So the fixtures here are hostile in the direction reality fails: an instance
// that never booted, a policy narrowed on disk but not in code, and an empty fleet config. Each one has to be RED.
// Green-on-green proves nothing, which is also demonstrated below by mutating a fixture and asserting the gate
// notices — a checker never seen to fail is not a checker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceGatesConfig } from "../factory/gate-policy.ts";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "gates", "deploy-posture.mjs");
const POLICY = instanceGatesConfig();

/** A fixture fleet root: <tmp>/fleet.local.json + <tmp>/<slug>/config/gates.json per entry. */
function fixture({ instances = [], factories }) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-posture-"));
  writeFileSync(
    join(dir, "fleet.local.json"),
    JSON.stringify({ adapter: {}, factories: factories ?? instances.map((i) => ({ repo: i.repo, instancesRoot: "." })) }, null, 2),
  );
  for (const inst of instances) {
    const slug = inst.slug ?? inst.repo.replace("/", "_");
    const cfgDir = join(dir, slug, "config");
    mkdirSync(cfgDir, { recursive: true });
    if (inst.contents !== null) {
      writeFileSync(join(cfgDir, "gates.json"), typeof inst.contents === "string" ? inst.contents : JSON.stringify(inst.contents, null, 2));
    }
  }
  return dir;
}

function run(args) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", GATE, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("the policy source is not empty — otherwise every check below is vacuous", () => {
  // If someone empties instanceGatesConfig(), "no drift" becomes trivially true and this whole file passes while
  // verifying nothing. Pin the shape the fleet actually depends on.
  assert.ok(POLICY.tiers.some((t) => t.tool === "merge_pr"), "merge_pr must stay gated");
  assert.ok(Object.keys(POLICY.destructiveArgs).length >= 5, `expected the #69 narrowing to still be declared, got ${JSON.stringify(Object.keys(POLICY.destructiveArgs))}`);
  assert.deepEqual(POLICY.destructiveArgs.submit_verdict, [], "a verdict carries no effect; if this changes, re-read engram#69");
});

test("matching instances pass, and the run reports what it inspected", () => {
  const dir = fixture({
    instances: [
      { repo: "acme/one", contents: POLICY },
      { repo: "acme/two", contents: POLICY },
    ],
  });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 0, out);
    // The collection line is load-bearing: it is how a human tells "checked 2" from "checked nothing".
    assert.match(out, /inspected 2 of 2 declared instance\(s\)/, out);
    assert.match(out, /policy has \d+ tier\(s\) and narrows \d+ tool\(s\)/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an instance that never booted is a failure, not a skip", () => {
  const dir = fixture({
    instances: [
      { repo: "acme/one", contents: POLICY },
      { repo: "acme/two", contents: null }, // config dir absent entirely
    ],
  });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, `a missing gates.json must fail the gate: ${out}`);
    assert.match(out, /MISSING/, out);
    assert.match(out, /never booted/, out);
    assert.match(out, /inspected 2 of 2/, "the count still has to account for both instances");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("narrowing present in policy but absent on disk is drift, named by tool", () => {
  const stale = JSON.parse(JSON.stringify(POLICY));
  delete stale.destructiveArgs.open_draft_pr;
  const dir = fixture({ instances: [{ repo: "acme/one", contents: stale }] });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, out);
    assert.match(out, /DRIFT/, out);
    assert.match(out, /destructiveArgs\.open_draft_pr: absent on disk/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("narrowing on disk that policy does not declare is ALSO drift (older build, not 'stricter = safer')", () => {
  const extra = JSON.parse(JSON.stringify(POLICY));
  extra.destructiveArgs.merge_pr = ["prNumber"]; // exactly what a pre-#69-era build might carry
  const dir = fixture({ instances: [{ repo: "acme/one", contents: extra }] });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, `extra narrowing must not read as compliant: ${out}`);
    assert.match(out, /merge_pr: narrowed on disk but NOT in policy/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed arg path is caught even when the tool set looks identical", () => {
  const wrong = JSON.parse(JSON.stringify(POLICY));
  wrong.destructiveArgs.delegate = ["issue_number"]; // plausible rename; would silently un-narrow delegate
  const dir = fixture({ instances: [{ repo: "acme/one", contents: wrong }] });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, out);
    assert.match(out, /destructiveArgs\.delegate/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lost containment declaration is caught — that is the difference between a sandbox and a stall", () => {
  const noSandbox = JSON.parse(JSON.stringify(POLICY));
  noSandbox.tiers = noSandbox.tiers.filter((t) => t.tool !== "bash");
  const dir = fixture({ instances: [{ repo: "acme/one", contents: noSandbox }] });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, out);
    assert.match(out, /tiers: missing bash\(sandbox\)/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unparseable JSON fails with the file named", () => {
  const dir = fixture({ instances: [{ repo: "acme/one", contents: "{ not json" }] });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, out);
    assert.match(out, /unparseable gates\.json/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty fleet config REFUSES to report success", () => {
  const dir = fixture({ instances: [], factories: [] });
  try {
    const { code, out } = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(code, 1, `zero declared instances must never be green: ${out}`);
    assert.match(out, /REFUSING to report success/, out);
    assert.match(out, /zero factories/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing config file is exit 2 — 'could not run' is not 'drift' and not 'ok'", () => {
  const { code, out } = run(["--config", join(mkdtempSync(join(tmpdir(), "dp-none-")), "absent.json")]);
  assert.equal(code, 2, out);
  assert.match(out, /cannot read fleet config/, out);
});

test("--json emits the machine-readable form with the same verdict", () => {
  const dir = fixture({ instances: [{ repo: "acme/one", contents: POLICY }] });
  try {
    const r = run(["--config", join(dir, "fleet.local.json"), "--json"]);
    assert.equal(r.code, 0, r.out);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.inspected, 1);
    assert.equal(parsed.results[0].status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-vacuity of this very file: a fixture mutated out of compliance flips green to red", () => {
  // Same fixture, one byte of drift. Without this pair the suite could be passing because the gate never finds
  // anything to compare (the exact defect class this gate was written to catch).
  const dir = fixture({ instances: [{ repo: "acme/one", contents: POLICY }] });
  const path = join(dir, "acme_one", "config", "gates.json");
  try {
    assert.equal(run(["--config", join(dir, "fleet.local.json")]).code, 0);
    writeFileSync(path, JSON.stringify({ ...POLICY, tiers: [] }, null, 2));
    const flipped = run(["--config", join(dir, "fleet.local.json")]);
    assert.equal(flipped.code, 1, flipped.out);
    assert.match(flipped.out, /tiers: missing merge_pr/, flipped.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
