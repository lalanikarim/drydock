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
