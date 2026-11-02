// The PR-body evidence contract (factory/pr-evidence.ts) — producer and consumer on one definition.
//   node --experimental-strip-types --test test/pr-evidence-contract.test.mjs
//
// Why this file exists: `m1`, `m2`, `m4` and `g4` each kept their own copy of "which sections must a factory
// PR contain", and one copy said `## Test suite (host-verified at PR creation)` while production emitted
// `## Verification (host-run at PR creation, decision C1)`. All three M gates failed on 2026-11-02 for that
// string — with exactly-once merge, SIGKILL isolation and clean budget abort all passing underneath. A gate
// that asserts a remembered contract tests its own memory. These tests make the contract shared and the drift
// loud at `npm test` time instead of 15 minutes into a fixture run.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const { EVIDENCE_SECTIONS, REVIEW_PASS_RE, VERIFICATION_PASS_RE, checkEvidenceBody, VERIFICATION_HEADING } = await import(
  "../factory/pr-evidence.ts"
);
const { buildPrBody } = await import("../factory/open-draft-pr.ts");
const { formatVerificationEvidence } = await import("../factory/verification.ts");

const passingTests = { ran: true, command: "node --test", exitCode: 0, timedOut: false, passed: true, total: 97, passCount: 97, failCount: 0, tail: "# pass 97\n# fail 0" };

const bodyFor = (over = {}) =>
  buildPrBody({
    issueNumber: 49,
    summary: "Seeded fixture change.",
    verdict: { verdict: "pass", evidence: ["covers the spec"], concerns: [] },
    tests: passingTests,
    diffStatText: " src/a.mjs | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
    workerReport: "Implemented and tested.",
    log: "fallback log line",
    requireVerification: true,
    ...over,
  });

test("a body built by production satisfies the shared checker, sections in emission order", () => {
  const body = bodyFor();
  const check = checkEvidenceBody(body);
  assert.deepEqual(check.missing, [], `production's own body must pass: missing ${check.missing.join(", ")}`);
  assert.ok(check.ok);
  const positions = EVIDENCE_SECTIONS.map((s) => body.indexOf(s));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "section order is part of the contract");
});

test("the checker is not vacuous: renaming one heading fails it and names what is missing", () => {
  const drifted = bodyFor().replace(VERIFICATION_HEADING, "## Test suite (host-verified at PR creation)");
  const check = checkEvidenceBody(drifted);
  assert.equal(check.ok, false, "this is exactly the 2026-11-02 failure; a checker that misses it checks nothing");
  assert.deepEqual(check.missing, [VERIFICATION_HEADING]);
});

test("the checker requires the reviewer to have actually passed", () => {
  const failed = bodyFor({ verdict: { verdict: "fail", evidence: [], concerns: ["handler-level patch"] } });
  assert.ok(failed.includes("FAIL (fail)"), "section still present, so `missing` alone is not the signal");
  assert.equal(checkEvidenceBody(failed).ok, false);
});

test("VERIFICATION_PASS_RE matches what formatVerificationEvidence really emits", () => {
  // The other half of the drift: if production changes the summary line's wording, the gates go red again.
  const out = formatVerificationEvidence(passingTests);
  assert.match(out, VERIFICATION_PASS_RE);
  const failing = formatVerificationEvidence({ ...passingTests, passed: false, failCount: 3 });
  assert.doesNotMatch(failing, VERIFICATION_PASS_RE);
  const waived = formatVerificationEvidence(
    { ran: false, command: "node --test", exitCode: null, timedOut: false, passed: false, tail: "" },
    { requireVerification: false },
  );
  assert.doesNotMatch(waived, VERIFICATION_PASS_RE, "NOT VERIFIED must never read as PASS");
});

test("no gate re-implements the contract", () => {
  const gates = readdirSync(join(ROOT, "gates")).filter((f) => f.endsWith(".mjs"));
  for (const f of gates) {
    const src = readFileSync(join(ROOT, "gates", f), "utf8");
    for (const heading of EVIDENCE_SECTIONS) {
      assert.ok(
        !src.includes(`"${heading}"`) && !src.includes("## Test suite"),
        `${f} hardcodes the evidence heading "${heading}" — import it from factory/pr-evidence.ts instead`,
      );
    }
    if (/checkEvidence/.test(src)) {
      assert.match(src, /from "\.\.\/factory\/pr-evidence\.ts"/, `${f} checks evidence without importing the contract`);
    }
  }
});
