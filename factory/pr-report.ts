// Post-run replies on the pull request (#96).
//
// Why this exists: `/factory rebase` on an already-current branch did everything right and produced
// **no artifact a human could see**. The push was a no-op, the run log said fine, and the only way to
// learn what happened was to read the durable store. Same for a gate refusal after a rework request —
// the model knew, the reviewer knew, the PR said nothing. Feedback loops with invisible outcomes get
// re-requested, which costs a full worker cycle to discover "nothing changed" again.
//
// Two boundaries, stated because both were tempting:
//
//   * **Only runs that reached the pull request report.** Pre-dispatch refusals (sender not
//     allowlisted, comment on a branch we do not own, closed PR) post nothing: those decisions are
//     made against a stranger's comment, and replying would both disclose policy detail to whoever
//     typed the comment and hand anyone with an account a comment-writing primitive.
//   * **One reply per rework.** A first-time draft PR already carries the evidence pack in its body;
//     commenting there too would be noise. The reply is for the case where a human asked for
//     something and is waiting to find out whether it happened.
//
// Failure posture: reporting is best-effort. A comment that cannot be posted is logged and ignored —
// losing a status note must never turn a successful push into a failed run, and never the other way
// around (the push happens first, so the report can only describe reality, not cause it).

import type { VerificationEvidence } from "./verification.ts";

export interface PrReportFacts {
  prNumber: number;
  branch: string;
  issueNumber: number;
  /** sha the PR pointed at before this run pushed. */
  previousHead: string | null;
  /** sha after this run's push, or null when nothing was pushed (a refusal). */
  newHead: string | null;
  outcome: "pushed" | "no_change" | "refused";
  summary?: string;
  verification?: Pick<VerificationEvidence, "ran" | "command" | "exitCode" | "passed">;
  reviewVerdict?: string | null;
  /** Gate or budget refusal text, truncated for a comment. */
  refusalReason?: string;
  /** True when the refusal budget stopped this issue's run (#100) — a different kind of "stop". */
  runStopped?: boolean;
}

const MAX_REASON_CHARS = 900;

function short(s: string | undefined | null, fallback = "(none recorded)"): string {
  const text = String(s ?? "").trim();
  if (!text) return fallback;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}\n\n_(truncated — the full text is in the run log)_` : text;
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 10) : "(unknown)");

/** The comment body. Written for a human skimming a PR thread, so the verdict is the first line. */
export function buildPrReport(facts: PrReportFacts): string {
  const lines: string[] = [];
  if (facts.outcome === "pushed") {
    lines.push(`**Rework pushed.** \`${facts.branch}\` moved \`${shortSha(facts.previousHead)}\` → \`${shortSha(facts.newHead)}\`.`);
  } else if (facts.outcome === "no_change") {
    lines.push(
      `**No change to push.** The requested rework left the branch exactly where it was — head is still \`${shortSha(facts.newHead)}\`. ` +
        "This is a correct outcome for directives like a rebase onto an already-current base, but it is invisible without this note.",
    );
  } else {
    lines.push(`**Rework refused — nothing was pushed.** \`${facts.branch}\` still points at \`${shortSha(facts.previousHead)}\`.`);
  }

  if (facts.summary) {
    lines.push("", `> ${short(facts.summary).split("\n").join("\n> ")}`);
  }

  lines.push("", "| | |", "|---|---|");
  lines.push(`| outcome | ${facts.outcome === "pushed" ? "new commit(s) on the PR branch" : facts.outcome === "no_change" ? "no new commit" : "refused before push"} |`);
  if (facts.verification) {
    const v = facts.verification;
    lines.push(
      `| verification | ${v.ran ? `\`${v.command}\` exit ${v.exitCode} — ${v.passed ? "pass" : "fail"}` : "did not run"} |`,
    );
  }
  if (facts.reviewVerdict) lines.push(`| review | ${facts.reviewVerdict} |`);
  if (facts.runStopped) lines.push(`| retry budget | **run stopped** — further attempts on this issue are refused without doing work ([#100](https://github.com/lalanikarim/drydock/issues/100)) |`);

  if (facts.outcome === "refused" && facts.refusalReason) {
    lines.push("", "**Why**", "", short(facts.refusalReason));
  }

  lines.push(
    "",
    facts.outcome === "refused"
      ? "_Nothing on the branch or the PR changed. Comment `/factory <directive>` again with a different instruction, or widen this repo's policy in `factory/repo-registry.json` if the request genuinely needs it._"
      : "_Replied automatically by the factory after a `/factory` comment ([#96](https://github.com/lalanikarim/drydock/issues/96))._",
  );
  return lines.join("\n");
}

/** Did this run actually change the branch? Compared host-side from shas, never from what the model
 *  claims it did. */
export function classifyPush(previousHead: string | null, newHead: string | null): "pushed" | "no_change" {
  if (!previousHead || !newHead) return "pushed";
  return previousHead === newHead ? "no_change" : "pushed";
}
