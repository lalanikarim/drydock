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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

// ── does the lesson actually reach the worker? (the negative result depends on this) ─────────────────────
//
// G5's conclusion is "the lesson did not change behavior". That is only meaningful if arm B's prompt contained the
// lesson, so the last inch of the chain — lessons file → `readLessons` → `workerPrompt` — is asserted here rather
// than assumed. worker.ts is already imported by other tests in this suite (worker-scope-prompt, worker-rework).

const { readLessons } = await import("../factory/lessons.ts");
const { workerPrompt } = await import("../factory/worker.ts");
const { LESSON_TEXT, lessonsContent } = await import("../gates/g5-traps.mjs");

test("arm A's lessons file reads as no lessons; arm B's reads as exactly one", () => {
  const dir = mkdtempSync(join(tmpdir(), "g5-lessons-"));
  const a = join(dir, "a.md");
  const b = join(dir, "b.md");
  writeFileSync(a, lessonsContent(false));
  writeFileSync(b, lessonsContent(true));
  assert.equal(readLessons(a), "", "an empty file must read as no lessons, not as an empty trusted section");
  assert.equal(readLessons(b), LESSON_TEXT);
  rmSync(dir, { recursive: true, force: true });
});

test("a lesson present in the file appears in the worker prompt; an empty file adds no section", () => {
  const withLesson = workerPrompt({ issueNumber: 63, issueText: "body", lessons: readLessons(writeTemp(lessonsContent(true))) });
  assert.match(withLesson, /Standing factory lessons from prior review findings/);
  // Assert the shipped lesson appears verbatim rather than matching a fragment of its wording: pinning prose made this
  // test fail for a legitimate change to the default (#168), which is the same exact-equality-on-text defect recorded
  // for the fixture repo's tests.
  assert.ok(withLesson.includes(LESSON_TEXT.trim()), "the default lesson must reach the prompt byte-for-byte");

  const without = workerPrompt({ issueNumber: 62, issueText: "body", lessons: readLessons(writeTemp(lessonsContent(false))) });
  assert.doesNotMatch(without, /Standing factory lessons/, "an empty lessons file must not add an empty trusted section");
});

test("the lesson is a standing rule, not an instruction for this run's bug", () => {
  // A lesson that names the fixture's file, symbol, or issue number stops being knowledge and becomes the answer.
  // G5 would then measure instruction-following while claiming to measure the feedback loop.
  assert.doesNotMatch(LESSON_TEXT, /\.(mjs|ts|js)\b/, "no source filenames");
  assert.doesNotMatch(LESSON_TEXT, /issue #\d+/);
  assert.doesNotMatch(LESSON_TEXT, /invoices|statusCode: 400|store\.add/i, "no fixture-specific identifiers");
  assert.match(LESSON_TEXT, /^- \[\d{4}-\d{2}-\d{2}\] /, "note_lesson's own line shape, so it is indistinguishable from a recorded lesson");
});

function writeTemp(content) {
  const dir = mkdtempSync(join(tmpdir(), "g5-lesson-"));
  const p = join(dir, "lessons.md");
  writeFileSync(p, content);
  return p;
}

// ── lesson variants (#168) ───────────────────────────────────────────────────────────────────────────────
//
// The first G5 measurement found that an abstract lesson reached the worker prompt and changed nothing. Testing whether
// the *form* of a lesson matters means handing arm B a different text, and an escape hatch is exactly where the rules
// get smuggled past — so the variant goes through the same validator the default is asserted against, in this file.

const { validateLessonText } = await import("../gates/g5-traps.mjs");

test("the shipped LESSON_TEXT passes its own validator", () => {
  // If this goes red, the validator and the assertion above have diverged and one of them is decorative.
  assert.deepEqual(validateLessonText(LESSON_TEXT), []);
});


// #168 — the default lesson is now a measurement result, so both halves of its contract are pinned: it must carry an
// imitable shape (that is what changed worker behavior) and it must keep a surface that does NOT match the traps (that
// is what makes a green run mean transfer rather than vocabulary matching).
test("the default LESSON_TEXT carries an imitable shape, not a principle", () => {
  assert.match(LESSON_TEXT, /class\s+\w*Error\s+extends\s+Error/, "declares an error type in code");
  assert.match(LESSON_TEXT, /this\.statusCode\s*=\s*/, "the error carries its own status");
  assert.match(LESSON_TEXT, /function\s+assert\w*\s*\(|function\s+require\w*\s*\(/, "names one guard to define once");
  // The failure mode this guards against is subtle: prose that *describes* the pattern passes every other check here
  // and measures nothing, which is precisely the state #168 found and reported.
  assert.doesNotMatch(LESSON_TEXT, /fix the rule where the error originates — give/, "the abstract sentence that measured no change must not be the default again");
});

test("the default lesson keeps a mismatched surface so green still means transfer (#176)", () => {
  // Traps are about request payloads; the default is about limits on a value. If someone rewrites the default to speak
  // the trap's language, a passing G5 stops distinguishing rule-transfer from word-matching and this assertion says so.
  assert.doesNotMatch(LESSON_TEXT, /request body|JSON object|payload/i, "the default must not name the traps' surface");
  assert.deepEqual(validateLessonText(LESSON_TEXT), []);
});

test("the abstract negative control is kept, valid, and deliberately shapeless", () => {
  // It lost the measurement; it is not deleted, because re-measuring it must stay one flag away.
  const text = readFileSync(join(FX, "lesson-abstract.md"), "utf8");
  assert.deepEqual(validateLessonText(text), [], "the control is held to the same rules as the default");
  assert.doesNotMatch(text, /class\s+\w*Error\s+extends\s+Error/, "no code shape — that absence IS the finding");
  assert.match(text, /NEGATIVE CONTROL/i, "and it says so in the file, so nobody mistakes it for guidance to ship");
});

test("the imitable variant is a valid lesson and actually contains an imitable shape", () => {
  const text = readFileSync(join(FX, "lesson-imitable.md"), "utf8");
  assert.deepEqual(validateLessonText(text), [], `variant must satisfy the same rules as the default: ${validateLessonText(text).join("; ")}`);
  // "Imitable" has to mean something checkable: a typed error that carries a status, and one guard meant for reuse.
  assert.match(text, /class\s+\w*Error\s+extends\s+Error/, "declares an error type");
  assert.match(text, /this\.statusCode\s*=\s*400/, "the error carries its own status");
  assert.match(text, /function\s+require\w*\s*\(/, "names a guard to define once");
  assert.match(text, /^- \[\d{4}-\d{2}-\d{2}\] /m, "note_lesson's line shape");
});

test("validateLessonText rejects the shapes that would measure instruction-following", () => {
  const problems = (t) => validateLessonText(t);
  assert.deepEqual(problems("   "), ["lesson text is empty — the with-lessons arm would silently run without lessons"]);
  assert.ok(problems("in src/store.mjs, throw a typed error").some((p) => /source file/.test(p)));
  assert.ok(problems("see issue #19 for the pattern").some((p) => /issue number/.test(p)));
  for (const token of ["invoices", "customerId", "amountCents"]) {
    const found = problems(`validate the ${token} field once`);
    assert.ok(found.some((p) => /trap identifier/.test(p)), `${token} must be rejected`);
  }
});

test("lessonsContent keeps arm A empty and normalizes a variant into lesson shape", () => {
  assert.equal(lessonsContent(false), "");
  assert.equal(lessonsContent(true, "  "), "", "a blank variant for the with-lessons arm is still blank — preflight catches it");
  const marked = lessonsContent(true, "- [2026-01-01] Rule.");
  assert.equal(marked, "- [2026-01-01] Rule.\n");
  const bare = lessonsContent(true, "A rule with no marker.");
  assert.match(bare, /^- \[\d{4}-\d{2}-\d{2}\] A rule with no marker\.\n$/, "a variant file without the marker is wrapped, not passed through raw");
});

// ── the mismatched-surface variant (#176) ────────────────────────────────────────────────────────────────
//
// #168 proved a lesson containing an imitable shape changes behavior — but arm B copied the lesson's own identifiers,
// so "did it transfer the rule or pattern-match the vocabulary?" is still open. This variant is the control: same
// STRUCTURE as the working lesson (a typed error carrying its own status + one guard to define once), deliberately
// mismatched SURFACE (limits on a value, never request payloads). If an input-shape trap still gets a root fix, the
// rule transferred. If it reverts to handler-local, the loop keys on surface tokens — which changes how lessons should
// be authored and retrieved.

test("the domain-limits variant keeps the structure and drops the surface", () => {
  const text = readFileSync(join(FX, "lesson-domain-limits.md"), "utf8");
  assert.deepEqual(validateLessonText(text), [], `must satisfy the same rules as the default: ${validateLessonText(text).join("; ")}`);

  // Structure held constant with the lesson that worked in #168.
  const working = readFileSync(join(FX, "lesson-imitable.md"), "utf8");
  for (const [name, body] of [["working", working], ["variant", text]]) {
    assert.match(body, /class\s+\w*Error\s+extends\s+Error/, `${name} declares an error type`);
    assert.match(body, /this\.statusCode\s*=\s*/, `${name} carries its own status`);
    assert.match(body, /function\s+assert\w*\s*\(|function\s+require\w*\s*\(/, `${name} names one guard to define once`);
  }

  // Surface deliberately absent: no word of the input-shape vocabulary the trap is made of. This assertion is the
  // experiment — a future edit that reintroduces "body"/"object" silently turns it back into a surface match.
  for (const word of ["body", "object", "array", "null", "parse", "destructure", "shape", "request"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`, "i"), `the variant must not mention "${word}"`);
  }
});

// ── the fourth captured diff, and a verdict that can say "I don't know" (#176) ────────────────────────────
//
// PR #83 (fixture repo) is arm B of the mismatched-surface run: it put `if (not an object) throw new TypeError(...)`
// into store.validate(), the function every call path already calls. Verified against a running server — one change
// closed both traps (#71 and #72), suite 125/125. The classifier read it as neither signal and the old verdict printed
// EXPERIMENT PASSED. Both halves of that are defects: a root fix the detector cannot see, and a pass for a run nobody
// read.

test("a guard added where the rule lives is a root fix (captured: fixture PR #83)", () => {
  const c = classifyFixPattern(diff("domain-guard-pr83.diff"), contractFor(72));
  assert.ok(c.measured);
  assert.equal(c.rootFix, true, `expected the domain guard to count; reasons: ${JSON.stringify(c.reasons)}`);
  assert.equal(c.handlerPatch, false, "no translation was added in a handler-layer file");
  assert.ok(c.reasons.rootFix.some((r) => /where the rule lives/.test(r)), JSON.stringify(c.reasons));
  assert.ok(c.signals.domainChanged);
});

test("a bare throw with no condition is not a guard", () => {
  const c = classifyFixPattern(
    ["--- a/src/store.mjs", "+++ b/src/store.mjs", "+throw new Error('nope')"].join("\n"),
    contractFor(72),
  );
  assert.equal(c.rootFix, false, "an unconditional throw in a domain file is a refactor, not a guard");
});

const { experimentVerdict } = await import("../gates/g5-traps.mjs");

const armOf = (label, over = {}) => ({
  arm: label,
  issue: label === "A" ? 71 : 72,
  branch: `agent/issue-${label === "A" ? 71 : 72}`,
  prNumber: label === "A" ? 82 : 83,
  classification: { measured: true, rootFix: false, handlerPatch: false },
  ...over,
});

test("verdict: baseline patches a handler and the lessons arm fixes the rule — the only pass", () => {
  const v = experimentVerdict([
    armOf("A", { classification: { measured: true, rootFix: false, handlerPatch: true } }),
    armOf("B", { classification: { measured: true, rootFix: true, handlerPatch: false } }),
  ]);
  assert.equal(v.status, "pass");
  assert.equal(v.attribution, "strong");
  assert.deepEqual(v.fails, []);
});

test("verdict: an arm reading as neither signal is inconclusive, never a pass", () => {
  const bNeither = experimentVerdict([
    armOf("A", { classification: { measured: true, rootFix: false, handlerPatch: true } }),
    armOf("B"),
  ]);
  assert.equal(bNeither.status, "fail");
  assert.ok(bNeither.fails.some((f) => /INCONCLUSIVE/.test(f) && /arm B/.test(f)), JSON.stringify(bNeither.fails));

  const aNeither = experimentVerdict([
    armOf("A"),
    armOf("B", { classification: { measured: true, rootFix: true, handlerPatch: false } }),
  ]);
  assert.equal(aNeither.status, "fail");
  assert.ok(aNeither.fails.some((f) => /INCONCLUSIVE/.test(f) && /arm A/.test(f)), JSON.stringify(aNeither.fails));
});

test("verdict: the pre-existing failures still fail", () => {
  const aRoot = experimentVerdict([
    armOf("A", { classification: { measured: true, rootFix: true, handlerPatch: false } }),
    armOf("B", { classification: { measured: true, rootFix: true, handlerPatch: false } }),
  ]);
  assert.ok(aRoot.fails.some((f) => /baseline.*already produced a root fix/.test(f)), "trap consumed");

  const bPatched = experimentVerdict([
    armOf("A", { classification: { measured: true, rootFix: false, handlerPatch: true } }),
    armOf("B", { classification: { measured: true, rootFix: false, handlerPatch: true } }),
  ]);
  assert.ok(bPatched.fails.some((f) => /still patched a handler/.test(f)));

  const empty = experimentVerdict([armOf("A", { classification: { measured: false } }), armOf("B")]);
  assert.equal(empty.status, "fail");
  assert.equal(empty.attribution, "weak", "an unmeasured arm cannot carry strong attribution");

  const sameArtifact = experimentVerdict([armOf("A"), { ...armOf("B"), prNumber: 82, issue: 71, branch: "agent/issue-71" }]);
  assert.ok(sameArtifact.fails.some((f) => /not isolated/.test(f)));
});

// ── the reuse blind spot, captured 2026-11-04 (fixture PR #88, G5 arm A) ─────────────────────────────────
//
// Arm A — the arm with NO lesson — fixed fixture #87 by declaring `const BATCH_FIELDS = new Set(["invoices"])` and
// calling the module's existing `rejectUnknownFields` from the batch handler. One rule, now covering every path. The
// classifier read it as neither root fix nor handler patch, because every root-fix signal demanded something new in
// the diff. That asymmetry always falls on the good shape: a codebase that already owns the helper can only produce
// reuse, so the gate would keep reporting "no improvement" for improvements it is blind to.

test("captured PR #88: wiring an existing shared rule into a bare path counts as a root fix", () => {
  const c = classifyFixPattern(diff("arm-a-existing-rule-reuse.diff"), contractFor(87));
  assert.equal(c.measured, true);
  assert.equal(c.rootFix, true, `expected reuse to be seen: ${JSON.stringify(c.reasons)}`);
  assert.equal(c.signals.ruleReuse, "rejectUnknownFields");
  assert.ok(c.reasons.rootFix.some((r) => /existing shared rule/.test(r)), "the reason must name reuse so a reviewer can disagree with it");
});

test("captured PR #89: the arm that HAD the lesson still patched the handler, and is scored as such", () => {
  // The negative result from the same run, kept as a fixture so nobody quietly re-scores it later. Arm B copied the
  // inline sibling guard (throw Object.assign(new Error(...), { statusCode: 400 })) into setInvoiceStatus.
  const c = classifyFixPattern(diff("arm-b-handler-patch-issue-86.diff"), contractFor(86));
  assert.equal(c.rootFix, false, "an inline guard copied from a sibling is not a root fix");
  assert.equal(c.handlerPatch, true);
});

test("the reuse signal is not a rubber stamp", () => {
  // The historical anti-pattern must stay non-root even with the new signal: it touches validation-adjacent code and
  // would be the diff most likely to false-positive.
  const c = classifyFixPattern(diff("handler-patch-7bdb147.diff"), contractFor(62));
  assert.equal(c.rootFix, false, `reuse signal overfired: ${JSON.stringify(c.signals)}`);
  assert.equal(c.signals.ruleReuse, null);

  // A call to a validation-named function with no rule set is not enough on its own.
  const bare = classifyFixPattern(
    ["--- a/src/x.mjs", "+++ b/src/x.mjs", "@@ -1 +1 @@", "+  validateThing(body);"].join("\n"),
    { domainPaths: ["src/store.mjs"], handlerPaths: ["src/x.mjs"] },
  );
  assert.equal(bare.rootFix, false, "calling a validation-ish name with no rule set proves nothing");
});
