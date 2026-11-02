/**
 * The PR-body evidence contract — ONE definition, used by the producer and the gates.
 *
 * Why this exists: four gates (`m1`, `m2`, `m4`, `g4`) each carried their own copy of the required-section
 * list plus two regexes, and one copy said `## Test suite (host-verified at PR creation)` while production
 * had long since switched to `## Verification (host-run at PR creation, decision C1)`. All three M gates went
 * red on 2026-11-02 for that string alone — while the properties they exist to test (exactly-once merge,
 * isolation under SIGKILL, clean budget abort) were passing. A gate asserting an assumed contract is a claim
 * about the gate, which is the lesson in AGENTS.md; here it cost three fixture runs and a night.
 *
 * Production builds bodies from `EVIDENCE_SECTIONS`; gates assert with `checkEvidenceBody`. Changing one
 * heading now changes both sides, and `test/pr-evidence-contract.test.mjs` fails if a body produced by the
 * real builder stops satisfying the checker — in `npm test`, not 15 minutes into a gate run.
 */

export const DIFF_SUMMARY_HEADING = "## Diff summary";
export const REVIEW_HEADING = "## Independent review (read-only subagent)";
export const REVIEWER_CONCERNS_HEADING = "Reviewer concerns:";
export const VERIFICATION_HEADING = "## Verification (host-run at PR creation, decision C1)";
export const WORKER_REPORT_HEADING = "## Worker report (transcript excerpt)";

/** Headings every factory-opened draft PR must contain, in the order production emits them. */
export const EVIDENCE_SECTIONS = [
  DIFF_SUMMARY_HEADING,
  REVIEW_HEADING,
  REVIEWER_CONCERNS_HEADING,
  VERIFICATION_HEADING,
  WORKER_REPORT_HEADING,
] as const;

/** The reviewer subagent's verdict line (section heading followed immediately by PASS). */
export const REVIEW_PASS_RE = /## Independent review[^\n]*\nPASS/;

/** Host-run suite summary, as emitted by `formatVerificationEvidence` on a passing run. */
export const VERIFICATION_PASS_RE = /PASS — \d+ tests, \d+ passed, 0 failed/;

export type EvidenceCheck = { ok: boolean; missing: readonly string[] };

/** Does this PR body carry the full evidence pack? `missing` names what it does not, so a gate reports
 *  which section drifted rather than "evidence=false". */
export function checkEvidenceBody(body: string | null | undefined): EvidenceCheck {
  const text = body ?? "";
  const missing = EVIDENCE_SECTIONS.filter((s) => !text.includes(s));
  return { ok: missing.length === 0 && REVIEW_PASS_RE.test(text) && VERIFICATION_PASS_RE.test(text), missing };
}
