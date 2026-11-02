// Where the factory cites its own design decisions from.
//
// Why this exists: `factory/pr-report.ts` embedded `https://github.com/lalanikarim/drydock/issues/100`
// and `/issues/96` as literals, so every PR body the fleet posts asserted that THIS project's issue
// tracker is where its policy lives. Harmless while one operator owns everything; wrong the moment the
// factory works for another org — a refusal notice pointing at someone else's repository is not
// evidence, it's a bug that reads like documentation. Same class as the other "a literal outlived the
// thing it described" defects in this repo (the stale evidence heading, #144).
//
// Deliberately strict: a malformed base throws at boot rather than emitting links to a half-built URL.

const DEFAULT_TRACKER_REPO = "lalanikarim/drydock";

/** `owner/name` whose issue tracker the factory cites. Override with `DRYDOCK_TRACKER_REPO`. */
export function trackerRepo(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.DRYDOCK_TRACKER_REPO ?? DEFAULT_TRACKER_REPO).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    throw new Error(
      `DRYDOCK_TRACKER_REPO must be 'owner/name', got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** Markdown link to an issue in the tracker, e.g. `[#100](https://github.com/…/issues/100)`. */
export function issueLink(issueNumber: number | string, env?: Record<string, string | undefined>): string {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`issueLink: not an issue number: ${String(issueNumber)}`);
  return `[#${n}](https://github.com/${trackerRepo(env)}/issues/${n})`;
}
