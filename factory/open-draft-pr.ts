// Host-side open_draft_pr tool: pushes the worker's branch and opens a DRAFT PR.
// Ported to TS for the core composition.
//
// Security posture: all GitHub credentials stay on the host. The sandbox never
// pushes (worker prompt forbids it; remote URL is scrubbed of tokens). Draft PRs
// are safe side effects — no merge happens here (the merge gate owns merging,
// approval-gated at the destructive tier by the core machinery). Idempotent
// under retry: an existing draft PR for the same head branch is returned
// instead of creating a duplicate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Context, type ToolExecutionApi, type ToolTask } from "@earendil-works/pi-durable";
import { checkPathScope, formatScopeFailure, UNRESTRICTED_SCOPE, type PathScope } from "./path-scope.ts";
import { verifyWorkspace, verificationGate, formatVerificationEvidence, type VerificationEvidence } from "./verification.ts";
import { gitAuthEnv, cloneUrlWithAuth, gitAuthFromToken, type GitAuth } from "./github-auth.ts";
import { RefusalBudget, terminalRefusalPayload, type RefusalSignal } from "./refusal-budget.ts";
import { buildPrReport, classifyPush, type PrReportFacts } from "./pr-report.ts";
import type { Notifier } from "./notify-telegram.ts";

const pExecFile = promisify(execFile);

async function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

/** Per-file diff stat of the branch against its merge base with main. */
async function diffStat(ws: string, branch: string): Promise<string> {
  try {
    const base = await sh("git", ["-C", ws, "merge-base", "origin/main", branch]);
    return (await sh("git", ["-C", ws, "diff", "--stat", `${base}..${branch}`])).split("\n").filter(Boolean).join("\n");
  } catch {
    return "(diff stat unavailable)";
  }
}

export interface OpenPrInfo {
  number: number;
  /** Empty string only when the host API gave no url; kept required so callers never pass undefined onward. */
  url: string;
  isDraft?: boolean;
  headRefOid?: string | null;
}

/** The open PR for this branch, if any — and crucially its current head sha, which is how "did this
 *  run change anything" gets answered from host state instead of from what the model reports (#96). */
async function ghFindOpenPr(repo: string, branch: string, env: NodeJS.ProcessEnv): Promise<OpenPrInfo | null> {
  const out = await sh("gh", ["pr", "list", "--repo", repo, "--state", "open", "--head", branch, "--json", "number,url,isDraft,headRefOid"], { env });
  const list = JSON.parse(out || "[]");
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0] as Partial<OpenPrInfo>;
  return { number: Number(first.number), url: String(first.url ?? ""), isDraft: first.isDraft, headRefOid: first.headRefOid ?? null };
}

async function ghPostPrComment(repo: string, prNumber: number, body: string, env: NodeJS.ProcessEnv): Promise<void> {
  await sh("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "-f", `body=${body}`], { env });
}

/** Latest delegate tool result in the orchestrator transcript = the worker's final
 *  report (the evidence-packager's transcript excerpt). */
async function workerReportFromTranscript(api: ToolExecutionApi, ctx: Context): Promise<string | null> {
  try {
    const page = await api.commit((tx) => tx.scanEntries({ conversationId: api.conversationId }, 200), ctx);
    for (const item of page.items) { // descending: first match is the latest
      if ((item.kind ?? "") !== "pi.tool-result") continue;
      const msg = Array.isArray(item.model) ? item.model[0] : undefined;
      if (!msg || msg.toolName !== "delegate") continue;
      const text = (msg.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim()) return text.trim();
    }
  } catch { /* transcript scan is best-effort; fall back to the git log */ }
  return null;
}

export interface ReviewVerdict {
  verdict: string;
  evidence?: string[];
  concerns?: string[];
}

/** G4 evidence packager: every non-obvious section of the PR body, assembled from
 *  host-verified facts (diff, suite counts) plus the reviewer verdict and the
 *  worker's final report from the transcript. */
function buildPrBody({ issueNumber, summary, verdict, tests, diffStatText, workerReport, log, requireVerification }: {
  issueNumber: number;
  summary: string;
  verdict: ReviewVerdict;
  tests: VerificationEvidence;
  diffStatText: string;
  workerReport: string | null;
  log: string;
  requireVerification: boolean;
}): string {
  const evidence = (verdict.evidence ?? []).map((e) => `- ${e}`).join("\n");
  const concerns = verdict.concerns?.length ? verdict.concerns.map((c) => `- ${c}`).join("\n") : "- none";
  return [
    `Fixes #${issueNumber}.`,
    "",
    summary,
    "",
    "## Diff summary",
    "```",
    diffStatText,
    "```",
    "",
    "## Independent review (read-only subagent)",
    verdict.verdict === "pass" ? "PASS" : `FAIL (${verdict.verdict})`,
    evidence,
    "",
    "Reviewer concerns:",
    concerns,
    "",
    "## Verification (host-run at PR creation, decision C1)",
    formatVerificationEvidence(tests, { requireVerification }),
    "",
    "## Worker report (transcript excerpt)",
    "```",
    workerReport ?? log,
    "```",
    "",
    "_Opened as a draft by the drydock software factory. Merge is gated by human approval (`merge_pr` is approval-gated at the destructive tier)._",
  ].join("\n");
}

/** Push the branch. If the remote agent/issue-* branch holds a diverged prior
 *  attempt, replace it with --force-with-lease (safe: only our own factory-owned
 *  branch is ever forced, and the lease refuses to clobber anything we have not
 *  fetched). Deleting the branch first would auto-close the open PR tracking it,
 *  so in-place replacement preserves PR continuity. */
async function pushBranch(ws: string, branch: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await sh("git", ["-C", ws, "push", "-u", "origin", branch], { env });
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    const msg = String(err.stdout ?? "") + String(err.stderr ?? "");
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      await sh("git", ["-C", ws, "push", "--force-with-lease", "origin", branch], { env });
    } else {
      throw new Error(`git push failed: ${msg.slice(0, 400)}`);
    }
  }
}

export interface OpenDraftPrOptions {
  workDir: string;
  fixturesRepo: string;
  /** @deprecated Prefer gitAuth (B1-rev). Kept so existing callers/tests still compose. */
  ghToken?: string;
  /**
   * Credential for push + PR calls, resolved per use so a GitHub App installation token is always
   * current (they expire ~hourly; a boot-time snapshot would fail mid-run).
   */
  gitAuth?: GitAuth;
  modelRef: { provider: string; modelId: string };
  reviewerTaskDef: ToolTask;
  testCommand?: string;
  /**
   * Registry policy (decision C1): must a passing verification run exist before this repo's branch
   * may be pushed? Defaults to true. False is the documented escape hatch for repos with no test
   * command; it does not suppress disclosure — the PR body then says nothing was verified.
   */
  requireVerification?: boolean;
  /**
   * Which paths this repo's policy lets a run change (factory/path-scope.ts + the repo registry).
   * Defaults to unrestricted-except-protected, because `vendor/` is protected unconditionally — the
   * vendored kernel pin is a human decision and must not be changeable by omission.
   */
  pathScope?: PathScope;
  /**
   * Retry budget for refusals (#100). One instance per factory process, shared with the pipeline so
   * the stop state is per-issue rather than per-tool-call. A path-scope refusal is terminal on its
   * second identical occurrence; from then on this tool refuses immediately, before any clone, test
   * command or reviewer inference.
   */
  refusalBudget?: RefusalBudget;
  /**
   * PR-comment reporting hooks (#96). Injectable so the reply path is testable without GitHub; the
   * defaults shell out to `gh` with this run's credential.
   */
  findOpenPr?: (branch: string, env: NodeJS.ProcessEnv) => Promise<OpenPrInfo | null>;
  postPrComment?: (prNumber: number, body: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Where a failed report goes. Reporting is best-effort: it must never fail a run (#96). */
  reportLog?: (message: string) => void;
  /**
   * Operator notification (#64). Called after the fact — the PR already exists by then — and never allowed
   * to change the tool's outcome. Undefined means no channel is configured.
   */
  notify?: Notifier;
}

export function openDraftPrTool({ workDir, fixturesRepo, ghToken = "", gitAuth, modelRef, reviewerTaskDef, testCommand = "node --test", requireVerification = true, pathScope = UNRESTRICTED_SCOPE, refusalBudget = new RefusalBudget(), findOpenPr, postPrComment, reportLog = (m) => console.warn(m), notify }: OpenDraftPrOptions) {
  const findPr = findOpenPr ?? ((branch: string, env: NodeJS.ProcessEnv) => ghFindOpenPr(fixturesRepo, branch, env));
  const postComment = postPrComment ?? ((prNumber: number, body: string, env: NodeJS.ProcessEnv) => ghPostPrComment(fixturesRepo, prNumber, body, env));
  const auth: GitAuth = gitAuth ?? gitAuthFromToken(ghToken);
  // Notification is strictly downstream of reality (#64): the push happened, the PR exists, only then does
  // anyone get told. Failures are logged and dropped — a dead bot token cannot unmerge a passing run.
  const notifySafe = async (e: Parameters<Notifier>[0]): Promise<void> => {
    // Everything, including the null check, is inside the try: this is awaited on the path that returns a
    // refusal to the orchestrator, so a notification defect must not be able to surface as a tool error.
    try {
      if (!notify) return;
      await notify(e);
    } catch (err) {
      reportLog(`telegram notification failed: ${String(err)}`);
    }
  };
  return defineTool({
    name: "open_draft_pr",
    description:
      "Push the worker's branch agent/issue-<n> and open a DRAFT pull request for it (never merges). Two structural gates run before the push and neither can be skipped: (1) this repo's test command is executed and a non-zero exit refuses the push outright; (2) an independent read-only review of the committed branch, which also refuses the push on failure. Refusals return the findings and create nothing — re-delegate the worker with them and call again. Idempotent: returns the existing draft PR if one is already open for the branch.",
    parameters: Type.Object({
      issueNumber: Type.Integer(),
      title: Type.String(),
      summary: Type.String(),
    }),
    replay: "unsafe", // external side effects (push + PR create); idempotent by head branch
    execute: async ({ issueNumber, title, summary }, api, ctx) => {
      // Stopped runs are refused before anything expensive or side-effecting happens — no token
      // mint, no clone recovery, no diff, no reviewer. This is the difference between "the prompt
      // asked nicely" and a budget (#100: six full worker+review cycles on one impossible task).
      if (refusalBudget.isStopped(issueNumber)) {
        return { output: [{ type: "text" as const, text: JSON.stringify(terminalRefusalPayload(refusalBudget.stopRecord(issueNumber)!)) }] };
      }
      const ws = join(workDir, `issue-${issueNumber}`);
      const branch = `agent/issue-${issueNumber}`;
      /**
       * Charge one refusal to the budget and merge the verdict into the payload. Every refusal this
       * tool returns goes through here, so `retryable` is never a thing the orchestrator has to infer
       * from prose (R11: the refusal text reached the model in full, six times, and changed nothing).
       */
      const charged = (signal: RefusalSignal, base: Record<string, unknown>): { text: string; rec: ReturnType<RefusalBudget["note"]> } => {
        const rec = refusalBudget.note(issueNumber, signal);
        const verdict: Record<string, unknown> = { ...base, retryable: rec.retryable, attempts: rec.total, identicalAttempts: rec.count };
        if (rec.terminal) {
          // The moment an operator wants to know about: this issue will not produce a PR on its own (#100).
          void notifySafe({ kind: "run_stopped", repo: fixturesRepo, issueNumber, reason: rec.stopReason ?? "refusal budget exhausted" });
          return { text: JSON.stringify({ ...verdict, terminal: true, runStopped: true, stopReason: rec.stopReason, hint: terminalRefusalPayload(rec).hint }), rec };
        }
        return { text: JSON.stringify(verdict), rec };
      };
      // Resolved here (once per tool call) and reused for the PR calls below; an App token minted
      // for this run cannot expire inside it.
      const env = await gitAuthEnv(auth);

      // Is there already an open PR for this branch? Read once, early: it decides whether a report is
      // owed (#96), supplies the previous head sha for no-op detection, and is reused below instead of
      // being queried twice. Best-effort — an unreadable PR list must not block a push.
      let existingPr: OpenPrInfo | null = null;
      try {
        existingPr = await findPr(branch, env);
      } catch {
        existingPr = null;
      }
      /**
       * Tell the humans on the PR what happened (or why nothing did). Only when a PR already exists:
       * a first draft PR carries the evidence pack in its body, and pre-dispatch refusals post nothing
       * at all — see factory/pr-report.ts for why that boundary is where it is.
       */
      const report = async (facts: Omit<PrReportFacts, "prNumber" | "branch" | "issueNumber">) => {
        if (!existingPr?.number) return;
        try {
          // `summary` comes from the tool arguments so every report quotes what the run set out to do;
          // an explicit facts.summary still wins.
          await postComment(existingPr.number, buildPrReport({ prNumber: existingPr.number, branch, issueNumber, summary, ...facts }), env);
        } catch (e) {
          reportLog(`open_draft_pr: could not post the PR report for #${issueNumber}: ${(e as Error).message.split("\n")[0]}`);
        }
      };

      // Verify the worker actually committed on the branch (cheap; before
      // spending minutes on a review of nothing).
      let head: string;
      try {
        head = await sh("git", ["-C", ws, "rev-parse", "--verify", `refs/heads/${branch}`]);
      } catch {
        // No local workspace (e.g. after a machine reset): recover from the remote
        // branch if it was pushed by an earlier run of this issue.
        try {
          const authUrl = await cloneUrlWithAuth(auth, fixturesRepo);
          await sh("git", ["clone", "--quiet", "--branch", branch, authUrl, ws]);
          head = await sh("git", ["-C", ws, "rev-parse", "--verify", `refs/heads/${branch}`]);
        } catch {
          return { output: [{ type: "text" as const, text: JSON.stringify({ error: `no local branch ${branch} in ${ws} and no remote branch to recover — the worker did not commit` }) }] };
        }
      }
      const log = await sh("git", ["-C", ws, "log", "--oneline", "-3", branch]);

      // Path scope gate — structural, and BEFORE the review, so a run that touched something it
      // should not have costs seconds instead of minutes of reviewer inference. The classic case is
      // a branch whose only change is the vendor/engram submodule pointer: every test passes, and
      // the vendored kernel quietly changes under us.
      let changedFiles: string[];
      try {
        const base = await sh("git", ["-C", ws, "merge-base", "origin/main", branch]);
        changedFiles = (await sh("git", ["-C", ws, "diff", "--name-only", `${base}..${branch}`])).split("\n").filter(Boolean);
      } catch (e) {
        // Fail closed: no diff basis means no scope verdict, and pushing unchecked is the unsafe option.
        // Infrastructure, not policy: a missing merge base is usually a broken/stale workspace, and a
        // retry may genuinely fix it. Charged to the ledger but never to the budget — a transient
        // fault must not consume the attempts of the real task behind it.
        return {
          output: [{ type: "text" as const, text: charged({ class: "infrastructure", reason: `cannot compute changed files against origin/main (${(e as Error).message.split("\n")[0]})` }, { refused: true, reason: `cannot compute changed files against origin/main (${(e as Error).message.split("\n")[0]}); refusing to push unchecked`, counted: false }) }],
        };
      }
      const scope = checkPathScope(changedFiles, pathScope);
      if (!scope.ok) {
        const { text, rec } = charged(
          { class: "path_scope", offenders: scope.offenders, reason: "path scope violation" },
          {
            refused: true,
            reason: "path scope violation — nothing was pushed or reviewed",
            offenders: scope.offenders,
            detail: formatScopeFailure(scope),
            // retryable:false is the point (#100): policy is read at process start and lives in a
            // file this run cannot write, so re-delegating the same task cannot change the answer.
            hint: "This repo's pathAllowlist will not change during this run. Either produce the change without touching the offending paths (if the task truly requires them, it is not satisfiable here — say so), or have a human change pathAllowlist in factory/repo-registry.json and restart the factory.",
          },
        );
        await report({
          outcome: "refused",
          previousHead: existingPr?.headRefOid ?? null,
          newHead: null,
          refusalReason: `path scope violation — refused files: ${scope.offenders.map((o) => `\`${o.file}\``).join(", ")}`,
          runStopped: rec.terminal,
        });
        return { output: [{ type: "text" as const, text }] };
      }

      // Verification gate (#61, decision C1): run the repo's test command and refuse to push on a
      // non-zero exit. Ordered before the reviewer because it costs seconds while a review costs
      // minutes of inference — but note this is NOT a substitute for the review: a green suite says
      // the change did not break known behavior, which is exactly the thing a wrong-but-passing
      // implementation survives. Both gates own their own evidence.
      const tests = await verifyWorkspace({ cwd: ws, testCommand });
      const gate = verificationGate(tests, { requireVerification });
      if (gate.action === "refuse") {
        const { text, rec } = charged(
          { class: "verification", reason: gate.reason },
          {
            refused: true,
            reason: gate.reason,
            verification: { ran: tests.ran, command: tests.command, exitCode: tests.exitCode, timedOut: tests.timedOut, tail: tests.tail },
            hint: "Re-delegate the worker with the failing output named, then call open_draft_pr again. Nothing was pushed and no PR exists. Note that an identical red run twice means nothing changed between attempts — the budget stops the run at that point.",
          },
        );
        await report({
          outcome: "refused",
          previousHead: existingPr?.headRefOid ?? null,
          newHead: null,
          refusalReason: gate.reason,
          verification: { ran: tests.ran, command: tests.command, exitCode: tests.exitCode, passed: tests.passed },
          runStopped: rec.terminal,
        });
        return { output: [{ type: "text" as const, text }] };
      }

      // Structural gate (not prompt-dependent): run an independent read-only
      // review of the committed branch NOW; only push if it passes. The
      // orchestrator model cannot skip this — the gate owns its evidence.
      const reviewId = await api.createTask(
        reviewerTaskDef,
        { branch, issueNumber, ...modelRef },
        { ownership: { kind: "task", taskId: api.taskId } },
        ctx,
      );
      const settled = await api.waitForTask(reviewId, ctx);
      const outcome = settled.state.outcome;
      const verdict = (outcome?.status === "completed" ? (outcome.result as ReviewVerdict) : null) ?? null;
      if (!verdict || verdict.verdict !== "pass") {
        const reviewReason = verdict ? (verdict.concerns ?? []).join(" | ") || verdict.verdict : "review did not settle";
        const { text, rec } = charged({ class: "review", reason: reviewReason }, { refused: true, review: verdict ?? { error: "review did not settle" } });
        await report({
          outcome: "refused",
          previousHead: existingPr?.headRefOid ?? null,
          newHead: null,
          refusalReason: `independent review did not pass: ${reviewReason}`,
          reviewVerdict: verdict?.verdict ?? "did not settle",
          runStopped: rec.terminal,
        });
        return { output: [{ type: "text" as const, text }] };
      }

      const diffStatText = await diffStat(ws, branch);
      const workerReport = await workerReportFromTranscript(api, ctx);
      const body = buildPrBody({ issueNumber, summary, verdict, tests, diffStatText, workerReport, log, requireVerification });
      await pushBranch(ws, branch, env);

      // Idempotency: reuse the open PR found at the top of this call (never a second query — two
      // reads of a mutable pointer inside one run is how #47's drift class got introduced).
      const prJson: OpenPrInfo | null = existingPr;

      let prUrl: string;
      if (prJson) {
        // Refresh the evidence sections on the existing PR (G4: evidence must be
        // complete even when the PR predates the packager).
        await sh("gh", ["pr", "edit", String(prJson.number), "--repo", fixturesRepo, "--body", body], { env });
        prUrl = prJson.url;
      } else {
        const out = await sh("gh", [
          "pr", "create", "--repo", fixturesRepo, "--draft",
          "--head", branch, "--title", title, "--body", body,
        ], { env });
        prUrl = out.split("\n").pop()!.trim();
      }

      // The rework report (#96): a human who asked for something on the PR gets exactly one answer,
      // including the case where the answer is "nothing changed" — previously invisible.
      if (prJson) {
        await report({
          outcome: classifyPush(prJson.headRefOid ?? null, head),
          previousHead: prJson.headRefOid ?? null,
          newHead: head,
          summary,
          verification: { ran: tests.ran, command: tests.command, exitCode: tests.exitCode, passed: tests.passed },
          reviewVerdict: verdict.verdict,
        });
      }

      await notifySafe({
        kind: "pr_opened",
        repo: fixturesRepo,
        issueNumber,
        prNumber: prJson?.number ?? null,
        prUrl,
        head,
        verification: { ran: tests.ran, passed: tests.passed, exitCode: tests.exitCode },
      });

      return {
        output: [{
          type: "text" as const,
          // The sha here is what the orchestrator must pass to pr_status/merge_pr (#47): an approval
          // is scoped to this commit, so a later push cannot reuse it.
          // isDraft reports the truth, not the intent: on the rework path (#67) a human may have marked
          // the PR ready for review, and an orchestrator told `isDraft: true` would describe a state
          // that no longer exists.
          text: JSON.stringify({ prUrl, isDraft: prJson ? prJson.isDraft !== false : true, branch, head, verification: { ran: tests.ran, command: tests.command, exitCode: tests.exitCode, passed: tests.passed } }),
        }],
      };
    },
  });
}
