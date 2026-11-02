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
