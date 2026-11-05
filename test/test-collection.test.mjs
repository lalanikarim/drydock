// #241 — drydock's own eng#78: a test file no CI job collects is not a test, it is a rumor.
//
// What actually happened here: `npm run test:boot` runs three suites (`core-spike`, `pipeline-boot`,
// `intake-boot`). `ci.yml` runs `npm ci`, `npm test`, `npm run typecheck` — never `test:boot`. So the only
// end-to-end check of the intake path (real kernel conversations, real HTTP route, real capability envelopes)
// had been failing deterministically for an unknown stretch with a green pipeline above it. It is also the
// suite that would have exercised #235 for real; instead I verified #235 by hand against production, which is
// evidence but not a regression net.
//
// Two rules, deliberately separate:
//   1. **Collection.** Every test file is either collected from CI's own commands (expanding the npm script
//      graph — "mentioned in package.json" is not the property, reachability is) or declared host-tier with a
//      `// manual-only:` header naming why and which script runs it.
//   2. **Skip-is-not-pass.** These suites skip when inference is unreachable, and GitHub runners cannot reach
//      `aurora.infinidigm`. Wiring them into CI would print green over an empty run — the exact failure mode
//      this repo has been filed for repeatedly (R6b, R10). So they are host-tier by design, and the release
//      checklist runs them where inference exists.
//
// Non-vacuity is asserted too (floor, known-file presence, negative case): a checker whose failure mode is
// "collected nothing, passed everything" needs its own failure demonstrated.
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const FACTORY_DIR = path.join(ROOT, "factory");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");

/** `// manual-only: <why>; run with npm run <script>` at column 0.
 *  Anchored to column 0 so this file's own documentation of the marker does not declare itself manual, and the
 *  reason capture is lazy-anchored on `; run with` because reasons contain semicolons. */
const MANUAL_MARKER = /^\/\/ manual-only:\s*(.+?);\s*run with\s+(?:npm run )?([\w:-]+)/m;

/** Inventory: drydock's own suites, in both of its two layouts (.mjs under node --test, .ts run by explicit
 *  invocation). `vendor/` is another project's test tree and is not ours to collect. */
function inventory() {
  const mjs = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => path.join("test", f));
  const ts = existsSync(FACTORY_DIR)
    ? readdirSync(FACTORY_DIR)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => path.join("factory", f))
    : [];
  return [...mjs, ...ts].sort();
}

const scripts = () => {
  const file = path.join(ROOT, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).scripts ?? {} : {};
};

/** `npm test` / `npm run x` mentions inside a script body or a CI step. */
function npmMentions(text) {
  const out = [];
  // `npm run <name>` and bare `npm test`. The order of the alternation matters: a bare-`test` branch first would
  // also match the prefix of `npm run test:boot` and report the wrong script.
  const re = /npm\s+(?:run\s+([\w:.-]+)|test(?![:\w-]))/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? "test");
  return out;
}

/** Files named explicitly by a script body. */
function filesMentioned(text) {
  const hits = [
    ...[...text.matchAll(/(?:^|[\s'"(=])(test\/[\w.-]+\.test\.mjs)/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?:^|[\s'"(=])(factory\/[\w.-]+\.test\.ts)/g)].map((m) => m[1]),
  ];
  return hits;
}

/** Does a body collect the whole `test/` directory by glob? That is how drydock runs its .mjs suites. */
function collectsTestDirGlob(text) {
  return /--test\s+'?"?[^\s]*test\/\*\.test\.mjs/.test(text);
}

/** The closure of test files reachable from CI's own commands. */
function reachableFromCi(ciCommands) {
  const all = scripts();
  const seen = new Set();
  const files = new Set();
  let globTestDir = false;

  const visit = (name) => {
    const body = all[name];
    if (!body || seen.has(name)) return;
    seen.add(name);
    for (const f of filesMentioned(body)) files.add(f);
    if (collectsTestDirGlob(body)) globTestDir = true;
    for (const nested of npmMentions(body)) visit(nested);
  };

  for (const cmd of ciCommands) for (const mention of npmMentions(cmd)) visit(mention);
  if (globTestDir) for (const f of readdirSync(TEST_DIR).filter((x) => x.endsWith(".test.mjs"))) files.add(path.join("test", f));
  return { files, seen };
}

/** `run:` step bodies — block scalars and one-liners both. */
function ciRunCommands(workflowPath) {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2].trim();
    if (inline && !inline.startsWith("|") && !inline.startsWith(">")) {
      commands.push(inline);
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if ((lines[j].match(/^\s*/)[0] ?? "").length <= indent) break;
      body.push(lines[j].trim());
    }
    commands.push(body.join("\n"));
  }
  return commands;
}

const passed = [];
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`FAIL ${name} — ${e.message}`);
  }
}

const commands = existsSync(WORKFLOW) ? ciRunCommands(WORKFLOW) : [];
const { files: reachable, seen: scriptsReached } = reachableFromCi(commands);
const files = inventory();
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const markerOf = (rel) => MANUAL_MARKER.exec(read(rel));

check("the CI workflow exists and yields commands", () => {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} not found — if CI moved, this check moves with it; it may not pass`);
  assert.ok(commands.length > 0, "parsed zero `run:` steps; the parser or the workflow changed shape");
});

check("CI runs `npm test` (the hermetic suite)", () => {
  assert.ok(
    commands.some((c) => /npm\s+test/.test(c)),
    "ci.yml no longer invokes `npm test`; the required status check would sit 'Expected' forever",
  );
});

check("every test file is CI-collected or declared host-tier", () => {
  const offenders = [];
  for (const file of files) {
    const collected = reachable.has(file);
    const marker = markerOf(file);
    if (collected && marker) offenders.push(`${file}: collected by CI AND marked manual — delete the stale marker`);
    else if (!collected && !marker)
      offenders.push(
        `${file}: runs nowhere. Add it to a CI-reachable script, or add a column-0 header of the form ` +
          `"// manual-only: <why it needs a host>; run with npm run <script>".`,
      );
  }
  assert.equal(offenders.length, 0, `\n${offenders.join("\n")}`);
});

check("a host-tier marker names a script that exists", () => {
  const all = scripts();
  const broken = [];
  for (const file of files) {
    const marker = markerOf(file);
    if (marker && !all[marker[2]]) broken.push(`${file}: says "run with npm run ${marker[2]}", no such script`);
  }
  assert.equal(broken.length, 0, `\n${broken.join("\n")}`);
});

check("non-vacuity: the checker sees files and a non-trivial reached set", () => {
  assert.ok(files.length >= 40, `inventory floor: expected dozens of suites, saw ${files.length}`);
  assert.ok(reachable.size >= 10, `reached-set floor: CI reaches only ${reachable.size} file(s)`);
  assert.ok(reachable.has("test/intake-reopen.test.mjs"), "reached set must include a known .mjs suite");
  assert.ok(reachable.has("factory/intake.test.ts"), "reached set must include factory/intake.test.ts (npm test names it)");
  assert.ok(!reachable.has("test/does-not-exist.test.mjs"), "the matcher matches things that do not exist");
});

check("non-vacuity: a file nothing reaches is actually reported", () => {
  // The whole point of the check, demonstrated on a synthetic orphan rather than asserted.
  const orphan = "factory/synthetic-orphan.test.ts";
  const collected = reachable.has(orphan);
  const marker = MANUAL_MARKER.exec(`// manual-only: nope; run with npm run nothing\n`);
  assert.equal(collected, false, "the reachability set matched a file nobody names");
  assert.ok(marker, "the marker regex stopped parsing its own convention");
});

check("#241 specifically: the boot suites are declared, not silently skipped", () => {
  // These three need inference GitHub runners cannot reach. They must be declared host-tier — never added to CI
  // as always-skipping green, and never left undeclared.
  for (const f of ["factory/core-spike.test.ts", "factory/pipeline-boot.test.ts", "factory/intake-boot.test.ts"]) {
    if (!existsSync(path.join(ROOT, f))) continue;
    const marker = markerOf(f);
    assert.ok(marker, `${f}: host-tier suite with no manual-only marker (#241's exact blind spot)`);
    assert.ok(/test:boot/.test(marker[2]), `${f}: marker says "npm run ${marker[2]}", expected test:boot`);
  }
});

// ------------------------------------------------------------------ report
console.log(`\n=== drydock test-file collection report (${files.length} files) ===`);
const orphans = [];
for (const file of files) {
  const collected = reachable.has(file);
  const marker = markerOf(file);
  if (!collected && !marker) orphans.push(file);
  console.log(
    `  ${collected ? "CI-COLLECTED" : marker ? "host-tier   " : "ORPHAN      "}  ${file}` +
      (marker ? `   (${marker[1].trim()} → npm run ${marker[2]})` : ""),
  );
}
console.log(
  `  CI-reachable: ${reachable.size} · host-tier declared: ${files.filter((f) => !reachable.has(f) && markerOf(f)).length} · orphans: ${orphans.length}`,
);
console.log(`  CI commands parsed: ${commands.length} · scripts expanded: ${[...scriptsReached].join(", ") || "none"}`);

const summary = `${passed.length} passed, ${failures.length} failed`;
console.log(`\nRESULT: ${summary}`);
if (failures.length) console.error(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);
