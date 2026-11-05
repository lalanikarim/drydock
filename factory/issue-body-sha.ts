/**
 * The one mechanical check #230 deliberately left out (#238): hash the issue text at abort, compare at retry.
 *
 * #230 made a retry attributable: `replanSource` says whether a human authorized an attempt or the orchestrator
 * supplied a sentence. It cannot say the sentence was **false**. Observed live on build `6ce582e`: an operator reopen
 * reason came back as the model's claim that "the issue has since been sliced down to assertion 4 only". Nothing about
 * that scope reduction had happened; everything downstream of #230 recorded it honestly as `replanSource=model` and
 * proceeded.
 *
 * This module supplies the check prose cannot. If a model says the spec changed and the bytes are identical, that
 * claim is contradicted by an external fact — not judged, not parsed, not scored.
 *
 * ## What it can and cannot prove (the honesty clause; keep it next to the code)
 *
 * - **Can**: show that a claim of modification was false at retry time. Mechanical, falsifiable, and the only such
 *   signal available without reading prose.
 * - **Cannot**: show a slice is correctly sized, that a new body is coherent, or that the retry will succeed. An
 *   unchanged body with an honest reason ("same scope, more wall time") is legitimate — which is why this reports and
 *   never refuses. Refusal would need its own issue-level decision (`research/decision-log.md`), not a quiet upgrade
 *   smuggled into a logging change.
 * - **A model that edits the issue satisfies it.** Accepted deliberately: editing the spec is the action we want
 *   distinguishable from asserting one, and the edit leaves an `updated_at` trail regardless.
 *
 * ## Two defects a live run caught, in the order they were found
 *
 * 1. **Transport noise.** The abort side hashed an in-process string; the retry side hashed the stdout of
 *    `gh api --jq .body`, and jq appends a newline. Unchanged issues therefore hashed differently. Fixed by
 *    `canonicalText` (CRLF→LF, trailing newlines stripped).
 * 2. **Wrong projection.** The abort side does not hash the body at all — `fetchIssue` hashes
 *    `title + "\\n--- body ---\\n" + body`, sanitized. Comparing that against `.body` yields "clear" forever: a check
 *    that can never fire, and every hermetic test passed because both sides of the fake used the same string.
 *    Fixed by making BOTH sides call `fetchIssueProjection` in `factory/gh-read.ts`. Same source, or the comparison
 *    means nothing.
 *
 * Neither was visible from a green suite. This is AGENTS.md's "a fake proves your assumption, not the API", and the
 * live check lives at `gates/scope-claim-live.mjs` so it stays runnable rather than becoming a comment.
 *
 * ## Failure posture
 *
 * A failed read is `"unavailable"`, never `"clear"` and never a crash. "Could not check" degrading to "check passed"
 * is the failure mode this repository has been filed for repeatedly (R6b/R10), and the retry path is exactly where a
 * flaky GitHub read most coincides with a real problem.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchIssueProjection } from "./gh-read.ts";

const pExecFile = promisify(execFile);

/**
 * The form actually hashed. A trailing newline is transport noise (jq adds one, the REST JSON has none); an edit that
 * only adds or removes trailing blank lines is invisible to this check, and that trade-off is stated rather than
 * hidden. Everything else — including whitespace inside the body — changes the hash. A check that never fires is worse
 * than a check with a documented blind spot.
 */
export function canonicalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/** Canonical-form sha256 of the issue projection a worker was shown (#238). */
export function hashIssueText(text: string): string {
  return createHash("sha256").update(canonicalText(text), "utf8").digest("hex");
}

/** Short form for log lines; 8 hex chars is for grep-ability, not collision resistance. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * Result of re-reading the issue projection. Exactly one field is set: `error` means **unknown**, and callers must
 * treat it as unknown rather than folding it into a comparison.
 */
export type IssueProbeResult = { sha: string; textLength: number } | { error: string };

/**
 * Re-reads the issue exactly as `factory/worker.ts` reads it — same helper, same jq projection, same sanitizer — and
 * hashes it. The "same helper" is not a style preference: hashing two different projections of one issue is how this
 * check was born silently dead (see the header).
 */
export function makeGhIssueProber(opts: {
  repo: string;
  /** A literal token, or a supplier for one that expires (an App installation token). */
  token?: string | (() => Promise<string>);
  /** Injection point for the `gh` invocation — tests assert the projection argument without touching the network. */
  exec?: typeof pExecFile;
}): (issueNumber: number) => Promise<IssueProbeResult> {
  return async (issueNumber: number): Promise<IssueProbeResult> => {
    try {
      // Token resolution inside the try: an App credential that cannot mint a token is the same "unknown" as a 403,
      // and letting it throw would turn a degraded check into a faulted `delegate` call.
      const token = typeof opts.token === "function" ? await opts.token() : opts.token;
      const text = await fetchIssueProjection(
        opts.repo,
        issueNumber,
        { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
        { exec: opts.exec },
      );
      return { sha: hashIssueText(text), textLength: text.length };
    } catch (err) {
      // Rate limit, 403, dead network, missing issue, credential that cannot be minted. All one thing here: unknown.
      return { error: `${(err as Error)?.name ?? "Error"}: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
    }
  };
}

export type ScopeClaimVerdict =
  /** The issue text is byte-identical to the one at abort. A claim that the issue changed is contradicted. */
  | "contradicted"
  /** The text differs from the abort hash. Consistent with an edit — not proven, not disputed. */
  | "clear"
  /** No abort hash on file, or the read failed. Unknown, and recorded as such. */
  | "unavailable";

/**
 * Compare "now" against the hash recorded at abort. Pure, so every branch is testable without a network — including
 * the two ways `unavailable` happens (no prior hash; failed read), both of which are asserted.
 */
export function compareIssueText(
  shaAtAbort: string | undefined,
  probe: IssueProbeResult,
): { verdict: ScopeClaimVerdict; detail: string } {
  if (!shaAtAbort) {
    return {
      verdict: "unavailable",
      detail: "no issue hash was recorded at abort (the abort predates #238, or the worker never fetched the issue)",
    };
  }
  if ("error" in probe) {
    return { verdict: "unavailable", detail: `could not re-read the issue — ${probe.error}` };
  }
  if (probe.sha === shaAtAbort) {
    return {
      verdict: "contradicted",
      detail: `issue text is byte-identical to the one at abort (${shortSha(shaAtAbort)}, ${probe.textLength} chars)`,
    };
  }
  return { verdict: "clear", detail: `issue changed since abort (${shortSha(shaAtAbort)} → ${shortSha(probe.sha)})` };
}
