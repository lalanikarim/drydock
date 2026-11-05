// Small host-side GitHub reads shared by the adapter's dispatch path (#65).
//
// Lives apart from factory/refine-task.ts on purpose: that module pulls in the durable kernel to define
// tasks, and the intake adapter must stay loadable without it. Anything here is a single read whose only
// job is to answer "is this still what the webhook said it was?" before acting.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/**
 * Current state of an issue: "open", "closed", … or null when it cannot be read.
 *
 * Null is a refusal, not a pass — the same posture as `fetchPrFacts`. A webhook payload is a snapshot of
 * a moment that has already passed, and this factory's rule since #67 is that live state is read with the
 * factory's own credential rather than trusted from an event body.
 */
export async function fetchIssueState(
  repo: string,
  issueNumber: number,
  token: string,
  { exec = pExecFile }: { exec?: typeof pExecFile } = {},
): Promise<string | null> {
  try {
    const { stdout } = await exec("gh", ["api", `repos/${repo}/issues/${issueNumber}`, "--jq", ".state"], {
      env: { ...process.env, GH_TOKEN: token },
      maxBuffer: 4 * 1024 * 1024,
    });
    const state = String(stdout ?? "").trim();
    return state.length ? state : null;
  } catch {
    return null;
  }
}
import { sanitizeUntrusted } from "./untrusted.ts";

/**
 * The exact text a worker is shown for an issue (#238): title, separator, body — sanitized.
 *
 * This function exists in ONE place because two callers must agree on it byte for byte: `factory/worker.ts` feeds
 * the result to the model and hashes it at a wall-budget abort, and `factory/issue-body-sha.ts` re-reads it at retry
 * to test a claim that the issue changed. When they disagreed — one hashing `title + separator + body`, the other
 * hashing `.body` alone — every comparison came back "clear" and the check was silently dead. A live run caught it;
 * no unit test could have, because both sides of every fake used the same string.
 *
 * If you change the projection, the hashes recorded before the change stop matching. That is correct behavior (a new
 * hash per abort) but worth knowing: an in-flight issue's `bodyShaAtAbort` from before the change reads as `clear`,
 * never as `contradicted`.
 */
export const ISSUE_PROJECTION_JQ = '.title + "\\n--- body ---\\n" + (.body // "")';

export async function fetchIssueProjection(
  repo: string,
  issueNumber: number,
  env: NodeJS.ProcessEnv,
  { exec = pExecFile }: { exec?: typeof pExecFile } = {},
): Promise<string> {
  const { stdout } = await exec("gh", ["api", `repos/${repo}/issues/${issueNumber}`, "--jq", ISSUE_PROJECTION_JQ], {
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return sanitizeUntrusted(String(stdout ?? ""));
}
