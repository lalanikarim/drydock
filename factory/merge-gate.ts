// Merge gate (Phase 4; byte-scoped approval per issue #47).
//
// The factory never merges without a durable human decision — but the gating
// itself is now provided by the CORE approval machinery, not re-implemented
// here (issue #30, D2): `merge_pr` is registered in this instance's gates
// config at the destructive tier, so every call prompts with explicit
// acknowledgement and can never be auto-approved or covered by an allow-rule.
// When the hook blocks a call, the agent reports the approval key and stops;
// after a human approves via POST /approvals (API/Web/Telegram), the agent
// retries and the hook passes it.
//
// Exactly-once rests on VERIFIED PR state, not on a consumed flag: the tool
// checks `gh pr` state before acting and verifies `state === "MERGED"` after —
// a re-passed identical call after crash/retry lands on alreadyMerged and
// no-ops. This holds under every crash interleaving (crash after merge →
// alreadyMerged; crash before merge → same PR, same args, re-approved).
//
// ## Why `headSha` exists (#47)
//
// An approval that says "merge PR #24" is not an approval of any particular bytes, because
// `open_draft_pr` force-with-leases its branch: when main moves and the same issue is retried, the
// head goes H1 → H2 and the PR body's evidence is regenerated for H2. Observed 2026-10-28 on stale
// drafts for issues #35/#18/#34 — exactly-once merge held, but the commit that landed was not the
// commit whose review and test evidence had been checked, and the old head became unreferenced.
// Until now the only guard against that lived in the G4 harness (a head comparison before it
// approved), which protects the battery run and nothing else.
//
// The fix uses the kernel's own key derivation: `approvalKeyFor(name, args)` hashes the *arguments*,
// so putting the verified head sha in the arguments makes the durable decision byte-scoped by
// construction. Approving now means "merge exactly this commit"; if the branch is rewritten after
// approval, the retry's live head no longer matches the approved argument and the merge refuses —
// and a re-approval becomes an act of reviewing the new commit, which is what an approval should be.
//
// Residual window, stated honestly: between our `gh pr view` and `gh pr merge` (seconds) someone can
// still move the head, and GitHub's merge API takes no expected-head precondition. That is *detected*
// rather than prevented — the merge commit's parents are verified to contain the approved sha, so a
// mismatch is reported instead of silently accepted.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { gitAuthFromToken, type GitAuth } from "./github-auth.ts";

const pExecFile = promisify(execFile);

async function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

export const MERGE_TOOL = "merge_pr";
export const PR_STATUS_TOOL = "pr_status";

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Does an approved head sha identify the commit that is actually on the PR?
 *
 * Exact, full-length match only. Prefix matching would let a 7-character argument stay "valid" while
 * colliding with nothing today but weakening the very binding this parameter exists to provide — the
 * sha is machine-supplied (from `pr_status` or `open_draft_pr`), so there is no ergonomic reason to
 * accept short forms.
 */
export function headShaMatches(approved: string, actual: string): boolean {
  const a = String(approved ?? "").trim().toLowerCase();
  const b = String(actual ?? "").trim().toLowerCase();
  if (!FULL_SHA.test(a)) return false;
  return a === b;
}

function ok(payload: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(message: string) {
  return { output: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

/** PR state we need for merging, in one round trip. */
async function readPr(fixturesRepo: string, prNumber: number, ghToken: string) {
  const env = { ...process.env, GH_TOKEN: ghToken };
  const out = await sh(
    "gh",
    ["pr", "view", String(prNumber), "--repo", fixturesRepo, "--json", "number,state,isDraft,headRefOid,mergeStateStatus,mergeCommit"],
    { env },
  );
  return JSON.parse(out) as {
    number: number; state: string; isDraft: boolean; headRefOid: string; mergeStateStatus: string;
    mergeCommit?: { oid: string } | null;
  };
}

/** Parent shas of a commit (used to prove the approved commit is what landed). */
async function commitParents(fixturesRepo: string, sha: string, ghToken: string): Promise<string[]> {
  const env = { ...process.env, GH_TOKEN: ghToken };
  const out = await sh("gh", ["api", `repos/${fixturesRepo}/commits/${sha}`], { env });
  const json = JSON.parse(out) as { parents?: Array<{ sha: string }> };
  return (json.parents ?? []).map((p) => p.sha.toLowerCase());
}

/**
 * Read-only PR state for one issue's agent branch.
 *
 * Separate from `merge_pr` on purpose: the orchestrator has to learn the current head sha *without*
 * triggering a destructive approval, otherwise every merge would burn an approval on a discovery
 * call. It is also the honest way to check "did that merge land?" after a restart.
 */
export function prStatusTool({ fixturesRepo, ghToken = "", gitAuth }: { fixturesRepo: string; ghToken?: string; gitAuth?: GitAuth }) {
  const auth: GitAuth = gitAuth ?? gitAuthFromToken(ghToken);
  return defineTool({
    name: PR_STATUS_TOOL,
    description:
      "Read the pull request state for one issue's agent branch: { prNumber, state, isDraft, headSha, mergeStateStatus, mergeCommit }. Read-only. Use it before merge_pr — the merge needs the current headSha — and after a restart to check whether a merge actually landed.",
    parameters: Type.Object({ issueNumber: Type.Integer() }),
    replay: "safe",
    execute: async ({ issueNumber }) => {
      const gh = await auth.token();
      const env = { ...process.env, GH_TOKEN: gh };
      const branch = `agent/issue-${issueNumber}`;
      try {
        const out = await sh(
          "gh",
          ["pr", "list", "--repo", fixturesRepo, "--state", "all", "--head", branch, "--json", "number,state"],
          { env },
        );
        const list = JSON.parse(out || "[]") as Array<{ number: number; state: string }>;
        if (!list.length) return ok({ prNumber: null, state: "NONE", branch });
        const preferred = list.find((p) => p.state === "OPEN") ?? list.find((p) => p.state === "MERGED") ?? list[0];
        const pr = await readPr(fixturesRepo, preferred.number, gh);
        return ok({
          prNumber: pr.number,
          state: pr.state,
          isDraft: pr.isDraft,
          headSha: pr.headRefOid,
          mergeStateStatus: pr.mergeStateStatus,
          mergeCommit: pr.mergeCommit?.oid ?? null,
        });
      } catch (e) {
        return err(`pr_status failed: ${String((e as Error).message).slice(0, 300)}`);
      }
    },
  });
}

export function mergePrTool({ fixturesRepo, ghToken = "", gitAuth }: { fixturesRepo: string; ghToken?: string; gitAuth?: GitAuth }) {
  const auth: GitAuth = gitAuth ?? gitAuthFromToken(ghToken);
  return defineTool({
    name: MERGE_TOOL,
    description:
      "Merge the draft pull request for one issue. APPROVAL-GATED (destructive tier): the first call is blocked pending human approval with an approval key — report that key and stop; after a human approves it, call again with the identical arguments. headSha is REQUIRED and must be the PR's current head commit (from pr_status or open_draft_pr): the approval covers exactly that commit, so if the branch is rewritten after approval the merge refuses instead of landing unverified bytes. If the PR is already merged, reports alreadyMerged.",
    parameters: Type.Object({
      issueNumber: Type.Integer(),
      headSha: Type.String({ description: "Full 40-char head commit sha of the PR being approved for merge." }),
    }),
    replay: "unsafe", // real git side effect; idempotent via the verified PR-state check
    execute: async ({ issueNumber, headSha }) => {
      const gh = await auth.token();
      const env = { ...process.env, GH_TOKEN: gh };
      const branch = `agent/issue-${issueNumber}`;

      // Locate the PR for this head branch (open preferred, else merged).
      let list: Array<{ number: number; state: string }>;
      try {
        const out = await sh(
          "gh",
          ["pr", "list", "--repo", fixturesRepo, "--state", "all", "--head", branch, "--json", "number,state"],
          { env },
        );
        list = JSON.parse(out || "[]");
      } catch (e) {
        return err(`gh pr list failed: ${String((e as Error).message).slice(0, 300)}`);
      }
      if (!list.length) return err(`no pull request found for head branch ${branch} — open_draft_pr has not run`);
      // Preference order matters: `--state all` also returns closed PRs from abandoned attempts on the
      // same head branch (fixture-2 has three for issue #11), and acting on one of those would merge
      // or report the wrong pull request entirely.
      const preferred = list.find((p) => p.state === "OPEN") ?? list.find((p) => p.state === "MERGED") ?? list[0];

      let pr: Awaited<ReturnType<typeof readPr>>;
      try {
        pr = await readPr(fixturesRepo, preferred.number, gh);
      } catch (e) {
        return err(`gh pr view failed: ${String((e as Error).message).slice(0, 300)}`);
      }

      // Idempotent terminal state. Reported with whether the commit that landed is the one being
      // asked about, so a stale retry can't quietly claim success for a different commit.
      if (pr.state === "MERGED") {
        const landedHead = headShaMatches(headSha, pr.headRefOid);
        return ok({
          merged: true, alreadyMerged: true, prNumber: pr.number, mergeCommit: pr.mergeCommit?.oid ?? null,
          approvedHeadSha: headSha, landedHeadMatched: landedHead,
          ...(landedHead ? {} : { warning: `already merged, but its head is ${pr.headRefOid}, not the requested ${headSha} — audit which commit was merged` }),
        });
      }

      // The byte-scoping check. A missing or malformed sha is treated as a mismatch (fail closed) and
      // answered with the current head so the caller can re-issue a correctly scoped request; note
      // that this refusal may arrive *after* an approval was granted for the sha-less key, which is
      // harmless — that key simply does not authorize anything, and the retry needs its own approval.
      if (!headShaMatches(headSha, pr.headRefOid)) {
        return err(
          `HEAD MISMATCH: PR #${pr.number} head is ${pr.headRefOid} but merge_pr was called with headSha=${JSON.stringify(headSha ?? "")}. ` +
          `No merge attempted. The branch was rewritten (open_draft_pr rebases onto main) or the sha was never read. ` +
          `Re-verify this commit — review and test evidence must correspond to it — then call merge_pr again with {"issueNumber": ${issueNumber}, "headSha": "${pr.headRefOid}"}, which requires a fresh approval because approval is per commit.`,
        );
      }

      // Stale-branch detection: a branch that conflicts with main needs rework
      // (re-run the work directive), not a merge attempt.
      if (pr.mergeStateStatus === "DIRTY") {
        return err(`PR #${pr.number} conflicts with the base branch (mergeStateStatus=DIRTY) — the branch is stale and needs rework via the work directive; no merge was attempted`);
      }

      // A human-approved merge implies review is done: convert draft -> ready
      // (GitHub refuses to merge draft PRs). Idempotent if already ready.
      if (pr.isDraft) {
        try {
          await sh("gh", ["pr", "ready", String(pr.number), "--repo", fixturesRepo], { env });
        } catch (e) {
          return err(`gh pr ready failed: ${(String((e as Error & { stdout?: string }).stdout ?? "") + String((e as Error).message)).slice(0, 400)}`);
        }
      }

      try {
        await sh("gh", ["pr", "merge", String(pr.number), "--repo", fixturesRepo, "--merge"], { env });
      } catch (e) {
        return err(`gh pr merge failed: ${(String((e as Error & { stdout?: string }).stdout ?? "") + String((e as Error).message)).slice(0, 400)}`);
      }

      // Verify the terminal state rather than trusting the CLI exit code.
      let after: Awaited<ReturnType<typeof readPr>>;
      try {
        after = await readPr(fixturesRepo, pr.number, gh);
      } catch (e) {
        return err(`post-merge verification failed: ${(e as Error).message}`);
      }
      if (after.state !== "MERGED") return err(`merge did not settle: state=${after.state}`);

      // Close the residual TOCTOU by proof rather than hope: the merge commit must have the approved
      // sha among its parents. If it does not, something moved the head between our read and GitHub's
      // merge — we cannot undo it, but we refuse to report a clean success.
      const mergeOid = after.mergeCommit?.oid ?? null;
      let landedVerified: boolean | "unknown" = "unknown";
      try {
        landedVerified = mergeOid ? (await commitParents(fixturesRepo, mergeOid, gh)).includes(headSha.toLowerCase()) : false;
      } catch {
        landedVerified = "unknown"; // API hiccup: report unknown, never a false true.
      }
      return ok({
        merged: true, alreadyMerged: false, prNumber: pr.number, mergeCommit: mergeOid,
        approvedHeadSha: headSha, approvedCommitLanded: landedVerified,
        ...(landedVerified === true ? {} : { warning: `merged, but the merge commit's parents could not be confirmed to include ${headSha} — audit before trusting this merge` }),
      });
    },
  });
}
