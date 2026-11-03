/**
 * Trap definitions and arm-isolation checks for G5 (#145).
 *
 * A "trap" is a seeded fixture issue whose defect has an obvious handler-local patch and a correct root-level fix.
 * G5 runs one trap with no lessons (baseline) and an equivalent one with lessons, then compares. Equivalence is the
 * whole design: two different kinds of bug would produce different behavior for reasons that have nothing to do with
 * the lesson.
 *
 * ## What a trap issue must and must not say
 *
 * It states the symptom (a command and its wrong output) and the required contract. It never hints at where the fix
 * belongs — an issue that says "validate this in the domain layer" measures instruction-following, not whether the
 * lesson changed behavior. Both traps below were authored to that rule.
 *
 * ## Why the pair is #62/#63 and not the original #19/#55
 *
 * `main` has moved: every error class in the fixture now carries a status code, so the historical "add statusCode to
 * the domain error" trap can no longer be fixed naively — it was already fixed, twice, by earlier runs. The current
 * pair is two live defects on `main` (runtime-internals messages leaking from the create path and the batch path),
 * which are the same defect in two call paths and therefore equivalent by construction.
 */

/**
 * The one thing arm B gets and arm A does not.
 *
 * Formatted the way `note_lesson` writes (`- [date] text`) because `readLessons` hands the content to the worker
 * prompt verbatim, inside a trusted section. It deliberately names no file, no symbol, and no issue number: a lesson
 * that says "in src/store.mjs add statusCode" is an instruction for one historical bug, and whether a worker follows
 * instructions is not the feedback loop. `test/g5-harness.test.mjs` asserts that property so the lesson cannot drift
 * into a per-bug hint without going red.
 */
export const LESSON_TEXT =
  "- [2026-11-03] When an API returns the wrong status or an internal error string for client input, fix the rule where the error originates — give the domain error a type that carries its own status, or enforce the check once in a place every path calls. Do not translate errors with instanceof/catch in one request handler: the other paths keep the bug.";

/**
 * Identifiers belonging to the current traps. A lesson that contains one has stopped being a lesson and become the
 * answer to a specific bug, which measures instruction-following instead of the feedback loop.
 */
export const LESSON_FORBIDDEN_TOKENS = ["invoices", "customerId", "amountCents"];

/**
 * Same rules `test/g5-harness.test.mjs` asserts of `LESSON_TEXT`, exported so a `--lesson-file` variant is held to the
 * standard instead of smuggling the answer past the test that exists to prevent exactly that.
 *
 * @returns {string[]} problems; empty means the text is usable as a lesson
 */
export function validateLessonText(text, { forbiddenTokens = LESSON_FORBIDDEN_TOKENS } = {}) {
  const problems = [];
  const body = String(text ?? "");
  if (body.trim().length === 0) return ["lesson text is empty — the with-lessons arm would silently run without lessons"];
  if (/\.(mjs|ts|js)\b/.test(body)) problems.push("lesson names a source file (a filename makes it the answer to one bug, not a rule)");
  if (/issue\s*#\d+/i.test(body)) problems.push("lesson names an issue number (same reason)");
  for (const token of forbiddenTokens) {
    if (new RegExp(`\\b${token}\\b`, "i").test(body))
      problems.push(`lesson names a trap identifier (${token}) — it would be solving this trap by name rather than transferring a rule`);
  }
  return problems;
}

/** What each arm's lessons file contains (arm A: empty, which is what "no lessons yet" looks like to readLessons). */
export function lessonsContent(enabled, lessonText = LESSON_TEXT) {
  if (!enabled) return "";
  const text = String(lessonText ?? "").trim();
  // Blank in, blank out — never a bare `- [date]` marker, which would read as a lesson and satisfy preflight while
  // telling the worker nothing.
  if (text.length === 0) return "";
  // A variant supplied on the command line may already carry its own `- [date]` marker; the default always does.
  return /^-\s+\[/.test(text) ? `${text}\n` : `- [${new Date().toISOString().slice(0, 10)}] ${text}\n`;
}

/** Branch a worker will use for an issue — one branch per issue, so distinct issues mean distinct arms. */
export function armBranch(issueNumber) {
  return `agent/issue-${issueNumber}`;
}

/**
 * What counts as a root fix vs a handler patch for a given trap.
 *
 * Paths are roles, not filenames: `domain` is where the invariant lives, `handler` is where the HTTP shape is built.
 * Classification itself (the property checks) lives in `fix-pattern.mjs`; this file only says which files play which
 * role per trap, so a future trap in another repo needs a new entry here and no new detector.
 */
const CONTRACTS = {
  // POST /invoices non-object body leaks an engine message (#62).
  "62": { domainPaths: ["src/store.mjs"], handlerPaths: ["src/invoices.mjs", "src/server.mjs"] },
  // POST /invoices/batch non-object element leaks an engine message (#63).
  "63": { domainPaths: ["src/store.mjs"], handlerPaths: ["src/invoices.mjs", "src/server.mjs"] },
};

const DEFAULT_CONTRACT = { domainPaths: ["src/store.mjs"], handlerPaths: ["src/invoices.mjs", "src/server.mjs"] };

export function contractFor(issueNumber) {
  return CONTRACTS[String(issueNumber)] ?? DEFAULT_CONTRACT;
}

/**
 * Decide an experiment from both arms' classifications. Pure, so the decision rule itself is testable.
 *
 * The rule that matters: **an arm showing neither signal is inconclusive, never a pass.** On 2026-11-03 arm B
 * produced a domain-layer guard the classifier could not see, printed `rootFix=false handlerPatch=false`, and the old
 * verdict — which only asked "did A root-fix? did B patch a handler?" — reported EXPERIMENT PASSED for a run that had
 * measured nothing of the kind. A gate whose failure modes are "pass" and "fail" will eventually pass something it has
 * not read.
 *
 * @param {Array<{arm:string, issue?:any, branch?:string, prNumber?:any, classification?:{measured?:boolean, rootFix?:boolean, handlerPatch?:boolean}}>} arms
 */
export function experimentVerdict(arms = []) {
  const [a, b] = arms ?? [];
  if (!a || !b) return { status: "fail", attribution: "weak", fails: ["G5 expects exactly two arms"] };

  const fails = [];
  for (const arm of [a, b]) if (!arm.classification?.measured) fails.push(`arm ${arm.arm} produced an empty diff — nothing was measured`);

  const distinctArtifacts = a.prNumber !== b.prNumber && String(a.issue) !== String(b.issue) && a.branch !== b.branch;
  if (!distinctArtifacts) fails.push("both arms resolved to the same artifact — arms are not isolated (#145)");

  // Only read signals from arms that actually produced something; an unmeasured arm has no signals to interpret.
  if (a.classification?.measured) {
    if (a.classification.rootFix)
      fails.push(
        `arm A (baseline, no lessons) already produced a root fix.\n  The trap no longer exercises the anti-pattern, so this experiment cannot measure the lesson. Author a fresh equivalent pair against current main (gates/g5-traps.mjs) and re-run.`,
      );
    else if (!a.classification.handlerPatch)
      fails.push(
        `INCONCLUSIVE: arm A (baseline) produced a diff that reads as neither root fix nor handler patch.\n  Either the classifier cannot see what happened or the trap does not exercise either pattern. Read the diff; if the fix is real and structural, add its shape to gates/fix-pattern.mjs with the diff as a captured fixture — then re-run. A pass here would be a claim about a diff nobody read.`,
      );
  }
  if (b.classification?.measured) {
    if (b.classification.handlerPatch)
      fails.push(
        `arm B (with lessons) still patched a handler.\n  Before concluding anything about the loop, check arm B's intake log and lessons file — the likelier cause is that the lesson never reached the prompt.`,
      );
    else if (!b.classification.rootFix)
      fails.push(
        `INCONCLUSIVE: arm B (with lessons) produced a diff that reads as neither root fix nor handler patch.\n  Read it before believing anything: this is the classifier saying "I don't know", not the lesson working or failing. If the change is structural, capture it as a fixture and teach gates/fix-pattern.mjs its shape.`,
      );
  }

  const attribution = distinctArtifacts && a.classification?.measured && b.classification?.measured ? "strong" : "weak";
  return { status: fails.length ? "fail" : "pass", attribution, fails };
}

/**
 * Preflight the two arms. Pure — takes what it needs so it is unit-testable without GitHub.
 *
 * @param {Array<{label:string,issue?:string|number}>} arms
 * @param {{lessonsFileExists?:boolean, existingBranches?:string[], issueStates?:Record<string,string>}} facts
 * @returns {string[]} problems; empty means the experiment is meaningful to run
 */
export function preflightArms(arms, facts = {}) {
  const problems = [];
  const [a, b] = arms ?? [];
  if (!a || !b) return ["G5 expects exactly two arms (baseline and with-lessons)"];

  for (const arm of [a, b]) {
    if (arm.issue === undefined || arm.issue === null || String(arm.issue).trim() === "")
      problems.push(`G5_ISSUE_${arm.label} is required — each arm needs its own trap issue`);
  }
  if (a.issue && b.issue && String(a.issue) === String(b.issue))
    problems.push(
      `both arms point at issue ${a.issue}. The first arm's commit lands on agent/issue-${a.issue}; the second would produce nothing and be measured against the first arm's diff. That is #145 — pick an equivalent pair of issues.`,
    );

  // A leftover agent/issue-N branch means a previous run left state behind: the worker inherits it, so the arm stops
  // measuring a fresh attempt.
  for (const [arm, state] of Object.entries(facts.issueStates ?? {})) {
    if (state && state !== "OPEN") problems.push(`issue #${arm} is ${state}, not OPEN`);
  }
  for (const arm of [a, b]) {
    if (!arm.issue) continue;
    const branch = armBranch(arm.issue);
    if ((facts.existingBranches ?? []).includes(branch))
      problems.push(`${branch} already exists — stale run state would be inherited by arm ${arm.label} (inspect it, then pass --allow-stale-branches)`);
  }
  if (facts.lessonsFileExists === false) problems.push("the lesson text is empty; the with-lessons arm would silently run without lessons");
  // Both arms build their config by copying the deployment's runtime config and changing one field. If that file is
  // unreadable the arms would boot on defaults and the comparison would be measuring configuration, not the lesson.
  if (facts.baseConfigReadable === false) problems.push("the repo's runtime config (base for both arms' overrides) is not readable");
  return problems;
}
