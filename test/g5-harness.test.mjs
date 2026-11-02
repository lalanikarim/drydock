/**
 * G5 harness tests (#145) — the experiment's measurement machinery.
 *
 * These exist because G5 reported "attribution=strong" for an experiment that measured nothing: both arms ran the same
 * issue, so arm B was scored against arm A's commit, and the fix detector matched one historical spelling of one
 * historical fix in one file. A gate whose classifier has never been shown a real diff is guessing.
 *
 * The three diffs in `test/fixtures/g5/` are **captured from the fixture repository**, not written by hand:
 *   - handler-patch-7bdb147.diff  — commit 7bdb147, the anti-pattern (catch TypeError in the handler, attach 400)
 *   - root-fix-33ac879.diff       — commit 33ac879, the historical root fix (typed UnknownStatusError with statusCode)
 *   - shared-rule-pr57.diff       — PR #57, validation defined once and called from two paths; the case the old
 *                                   detector could never classify, because it landed outside src/store.mjs
 * If a matcher drifts from what these commits actually contain, this file goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFixPattern, addedLines, changedFiles, detectsSharedRule, detectsTypedError, formatClassification } from "../gates/fix-pattern.mjs";
import { armBranch, contractFor, preflightArms } from "../gates/g5-traps.mjs";

const FX = join(import.meta.dirname, "fixtures", "g5");
const diff = (name) => readFileSync(join(FX, name), "utf8");

// ── the classifier against real history ──────────────────────────────────────────────────────────────────

test("captured anti-pattern (7bdb147): handler patch, no root fix", () => {
  const c = classifyFixPattern(diff("handler-patch-7bdb147.diff"), contractFor(62));
  assert.equal(c.measured, true);
  assert.equal(c.handlerPatch, true, "catch + instanceof in the handler is exactly the anti-pattern");
  assert.equal(c.rootFix, false, "nothing was added to the domain — this commit must never read as a root fix");
  assert.deepEqual(c.signals.filesTouched, ["src/invoices.mjs"]);
  assert.ok(c.reasons.handlerPatch.length >= 2, c.reasons.handlerPatch.join("|"));
});

test("captured root fix (33ac879): typed error carrying its own status", () => {
  const c = classifyFixPattern(diff("root-fix-33ac879.diff"), contractFor(62));
  assert.equal(c.measured, true);
  assert.equal(c.rootFix, true);
  assert.equal(c.handlerPatch, false);
  assert.ok(detectsTypedError(addedLines(diff("root-fix-33ac879.diff"))));
});

test("PR #57 (shared validation) counts as a root fix even though it never touches src/store.mjs", () => {
  // This is the case the old detector could not express: the fix was correct — one rule, both call paths going
  // through it — but it lived in the handler file with no `this.statusCode = 4\d\d` in store.mjs, so G5 would have
  // failed a good fix. Property-based detection is what makes that impossible to repeat.
  const d = diff("shared-rule-pr57.diff");
  const c = classifyFixPattern(d, contractFor(62));
  assert.equal(c.measured, true);
  assert.equal(c.rootFix, true, "a rule defined once and called from both paths is the definition of a root fix");
  assert.equal(c.signals.domainChanged, false, "and it achieves that without touching the file the old gate required");
  assert.equal(c.signals.sharedRule, "rejectUnknownFields");
  assert.equal(c.handlerPatch, false, "a typed error class in the handler file is not the anti-pattern");
});

test("an empty diff is NOT MEASURED and never claims a fix", () => {
  const c = classifyFixPattern("", contractFor(62));
  assert.equal(c.measured, false);
  assert.equal(c.rootFix, false);
  assert.equal(c.handlerPatch, false);
  assert.match(formatClassification(c), /NOT MEASURED/);
});

test("a handler patch that leaves the domain untouched is reported as both-false on root fix", () => {
  const d = [
    "diff --git a/src/invoices.mjs b/src/invoices.mjs",
    "--- a/src/invoices.mjs",
    "+++ b/src/invoices.mjs",
    "@@ -1,0 +1,3 @@",
    "+  if (!body || typeof body !== 'object') {",
    "+    throw Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 });",
    "+  }",
  ].join("\n");
  const c = classifyFixPattern(d, contractFor(62));
  assert.equal(c.measured, true);
  assert.equal(c.handlerPatch, true);
  assert.equal(c.rootFix, false);
});

test("a domain-side guard with no handler change is a root fix", () => {
  const d = [
    "diff --git a/src/store.mjs b/src/store.mjs",
    "--- a/src/store.mjs",
    "+++ b/src/store.mjs",
    "@@ -1,0 +1,7 @@",
    "+export class InvalidBodyError extends Error {",
    "+  constructor() {",
    "+    super('request body must be a JSON object');",
    "+    this.name = 'InvalidBodyError';",
    "+    this.statusCode = 400;",
    "+  }",
    "+}",
  ].join("\n");
  const c = classifyFixPattern(d, contractFor(62));
  assert.equal(c.rootFix, true);
  assert.equal(c.handlerPatch, false, "no handler file was touched at all");
});

test("detection is spelling-agnostic about the status field (.status vs .statusCode)", () => {
  // src/retry.mjs's HttpError uses `.status`. A detector that only knew `statusCode` would call that a root fix in
  // one file and not in another, which is the bug being fixed here.
  const d = [
    "diff --git a/src/upstream.mjs b/src/upstream.mjs",
    "--- a/src/upstream.mjs",
    "+++ b/src/upstream.mjs",
    "@@ -1,0 +1,5 @@",
    "+export class UpstreamError extends Error {",
    "+  constructor(status) { super('upstream failed'); this.status = status; }",
    "+}",
  ].join("\n");
  const c = classifyFixPattern(d, { domainPaths: ["src/"], handlerPaths: ["src/handlers.mjs"] });
  assert.equal(c.rootFix, true);
});

test("detectsSharedRule needs a definition plus two call sites in the same diff", () => {
  const oneCall = "+function check(x) {}\n+  check(a);";
  assert.equal(detectsSharedRule(oneCall.split("\n")), null, "one call site is a helper, not a shared rule");
  const twoCalls = "+function check(x) {}\n+  check(a);\n+  check(b);";
  const hit = detectsSharedRule(twoCalls.split("\n"));
  assert.equal(hit.name, "check");
  assert.ok(hit.callSites >= 2);
});

test("changedFiles attributes added lines to the right file", () => {
  const files = changedFiles(diff("shared-rule-pr57.diff"));
  assert.ok(files.size >= 2, `expected several files, got ${[...files.keys()]}`);
  for (const [, lines] of files) assert.ok(lines.every((l) => l.startsWith("+")));
});

// ── arm isolation (#145 proper) ──────────────────────────────────────────────────────────────────────────

const arms = (a, b) => [
  { label: "A", name: "baseline", issue: a },
  { label: "B", name: "with-lessons", issue: b },
];

test("two arms on the SAME issue are refused — this is the #145 defect", () => {
  const problems = preflightArms(arms("55", "55"), { lessonsFileExists: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /both arms point at issue 55/);
});

test("two distinct arms with clean state pass preflight", () => {
  const problems = preflightArms(arms("62", "63"), { lessonsFileExists: true, existingBranches: [], issueStates: { 62: "OPEN", 63: "OPEN" } });
  assert.deepEqual(problems, []);
});

test("a missing arm issue is refused (no silent default to a live repo)", () => {
  const problems = preflightArms(arms("62", undefined), {});
  assert.ok(problems.some((p) => /G5_ISSUE_B is required/.test(p)));
});

test("a stale agent/issue-N branch on either arm is refused", () => {
  const problems = preflightArms(arms("62", "63"), { lessonsFileExists: true, existingBranches: ["agent/issue-63"] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /agent\/issue-63 already exists/);
});

test("a non-open trap issue is refused", () => {
  const problems = preflightArms(arms("62", "63"), { lessonsFileExists: true, issueStates: { 63: "CLOSED" } });
  assert.ok(problems.some((p) => /#63 is CLOSED/.test(p)));
});

test("empty lesson text is refused rather than running arm B lesson-less", () => {
  const problems = preflightArms(arms("62", "63"), { lessonsFileExists: false });
  assert.ok(problems.some((p) => /lesson text is empty/.test(p)));
});

test("an unreadable base config is refused — both arms would boot on defaults", () => {
  // The arms copy the deployment's runtime config and change one field; if that read fails, the difference between
  // them stops being the lesson.
  const problems = preflightArms(arms("62", "63"), { lessonsFileExists: true, baseConfigReadable: false });
  assert.ok(problems.some((p) => /runtime config .* not readable/.test(p)));
});

test("each arm's branch derives from its own issue number", () => {
  assert.equal(armBranch(62), "agent/issue-62");
  assert.notEqual(armBranch(62), armBranch(63));
});

test("every seeded trap has a contract, and unknown issues fall back rather than throwing", () => {
  for (const n of [62, 63]) {
    const c = contractFor(n);
    assert.ok(c.domainPaths.length && c.handlerPaths.length);
  }
  assert.ok(contractFor(999_999).domainPaths.length, "unknown trap still classifies — the gate must not crash mid-experiment");
});
