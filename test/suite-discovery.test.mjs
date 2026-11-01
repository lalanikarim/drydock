// Guard against the failure mode that hid a whole suite from CI (#101).
//
// `npm test` used to enumerate every suite by name. Suites added without editing package.json were
// therefore never run — and nothing failed, because "not collected" and "passing" look identical from
// the outside. This is R6's vacuous-green shape again: git-identity.test.mjs existed, passed when run
// directly, and was absent from every CI run until the glob replaced the list.
//
// So this file asserts the two things that make discovery trustworthy:
//   1. the test command discovers suites structurally (a pattern), rather than naming them;
//   2. the set of suite files on disk equals the set the pattern matches — no orphans, and never zero.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function testScript() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.test;
}

/** The suite files a `--test '<pattern>'` argument actually collects (same matching node performs). */
function patternMatches(pattern) {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".") + "$",
  );
  return readdirSync(join(ROOT, "test"))
    .filter((f) => re.test(f))
    .sort();
}

test("the test command discovers suites by pattern, not by name", () => {
  const script = testScript();
  assert.match(script, /--test\s+'?[^']*[*][^']*'?/, "test script must contain a globbed --test argument");
});

test("every suite file on disk is collected, and the collected set is never empty", () => {
  const script = testScript();
  const patterns = [...script.matchAll(/--test\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(patterns.length >= 1, "no globbed --test argument to inspect");

  const collected = new Set();
  for (const p of patterns) {
    const rel = p.replace(/^\.?\//, "");
    for (const f of patternMatches(basename(rel))) collected.add(join(dirname(rel), f).replace(/^\.\//, ""));
    assert.ok(patternMatches(basename(rel)).length > 0, `glob ${p} matches nothing — that is a green build testing nothing`);
  }

  const onDisk = readdirSync(join(ROOT, "test"))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => `test/${f}`)
    .sort();

  const orphans = onDisk.filter((f) => !collected.has(f));
  assert.deepEqual(orphans, [], `suite files exist but are not run by npm test: ${orphans.join(", ")}`);
  assert.ok(collected.size >= 20, `expected the suite to have grown past 20 files, found ${collected.size}`);
});

test("the two harness entry points stay explicit (they gate on their own boot conditions)", () => {
  const script = testScript();
  for (const entry of ["factory/pipeline.test.ts", "factory/intake.test.ts"]) {
    assert.ok(script.includes(entry), `${entry} must remain explicitly listed`);
  }
});
