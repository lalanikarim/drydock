// Factory reviewer: an independent, structurally read-only subagent that
// verifies a candidate branch against its issue's acceptance criteria.
// Ported to TS for the core composition.
//
// Read-only by construction — no write/edit/bash tools exist for the role:
//   read          — guarded file reads (sandbox env via the core)
//   git_diff      — host-side `git diff origin/main...HEAD` (read-only)
//   run_tests     — test command inside the conversation's Podman sandbox
//                   (untrusted test code never runs on the host; network=none, no host env)
//                   As of #247 this claim covers the push-gate verification run too — it used to be a host
//                   `execFile` with `process.env`, which made the sentence above true only for this tool
//                   while the same suite was executed unsandboxed one gate earlier. Both paths now go
//                   through factory/container.ts; where a run happened is recorded in the evidence.
//   submit_verdict — captures a machine-consumable {verdict, evidence, concerns}
//
// Sandbox wiring through the core: the reviewer conversation is flagged
// `ConversationMeta.sandbox = true` with `cwd = review-<branch>` in its
// configure commit; the core's envFor routes every tool execution into a
// per-conversation Podman sidecar (image/allowlists from the instance config)
// and disposes the container when the run ends. `run_tests` uses `api.env`
// directly — no registry needed.
//
// NOTE: dead-container supervision (#20) is pending upstream exposure of the
// SandboxManager (engram issue #44); until then a dead container surfaces as an
// exec error, matching current engram product behavior.

import { execFile } from "node:child_process";
import { readLessons, reviewerLessonsSection } from "./lessons.ts";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { configure, defineTask, defineTool, type ConversationId, type PhaseHandler, type RunningTask, type Task, type TaskRuntime, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context"; // chord owns Context (#173)
// ConversationMeta is part of the kernel's declared public surface (app/src/core.ts;
// engram #44 closed in v0.2.0) — reach it through that seam, not the internal module.
import { ConversationMeta } from "../vendor/engram/app/src/core.ts";
import { runSetupInContainer } from "./setup-sandbox.ts";
import { awaitIdleWithinBudget } from "./budgets.ts";
import { cloneUrlWithAuth, createGitAuth, gitAuthEnv, type GitAuth } from "./github-auth.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { abortedOutcome, isRestartAbort, type AbortFacts } from "./task-contract.ts";
import { blockedOutcomeFor, findBlocksInTaskContext, type ApprovalBlockedFacts } from "./approval-state.ts";

const pExecFile = promisify(execFile);
async function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

/** conversationId -> submitted verdict (written by submit_verdict, read in wait).
 *  Keyed by conversation because api.taskId inside a tool call is the internal
 *  pi.tool task, not the owning factory.reviewer task. */
export const verdictRegistry = new Map<number, ReviewVerdict>();

export interface ReviewVerdict {
  verdict: string;
  evidence: string[];
  concerns: string[];
}

/** Deterministic workspace path for a reviewed branch (shared by spawn + tools).
 * Absolute host path; the core maps `cwd = review-<sanitized>` under workRoot. */
export function reviewWorkspace(workDir: string, branch: string): string {
  return join(workDir, `review-${branch.replace(/[^a-zA-Z0-9]+/g, "-")}`);
}

/** The core's cwd component for the reviewer workspace (relative to workRoot). */
export function reviewCwd(branch: string): string {
  return `review-${branch.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

/**
 * The jq program that assembles the issue text a reviewer reads (#209 shipped this string corrupted: an automated
 * edit spliced the new `import { readLessons, … }` line into the middle of the jq literal, so every review threw at
 * SPAWN with `invalid escape sequence "\i"`. It survived 611 unit tests and CI because nothing called `fetchIssue`.
 *
 * Exported and asserted against the real `jq` binary in `test/reviewer-issue-text.test.mjs` — a string literal that
 * only ever gets interpreted by a remote tool is exactly the kind of contract a type checker cannot see, and this one
 * silently halted every draft PR the factory would have opened.
 */
export const ISSUE_TEXT_JQ = '.title + "\\n--- body ---\\n" + (.body // "")';

async function fetchIssue(fixturesRepo: string, issueNumber: number, env: NodeJS.ProcessEnv): Promise<string> {
  return sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", ISSUE_TEXT_JQ], { env });
}

async function prepareReviewWorkspace({ workDir, fixturesRepo, branch, issueNumber, auth }: { workDir: string; fixturesRepo: string; branch: string; issueNumber: number; auth: GitAuth }): Promise<string> {
  const ws = reviewWorkspace(workDir, branch);
  rmSync(ws, { recursive: true, force: true });
  // Prefer the worker's local checkout: in the closed loop review runs BEFORE
  // the push, and on rework the remote branch still holds the stale prior tip.
  // Fall back to the remote for branches that only exist there (e.g. seeded
  // negative-test branches).
  const local = join(workDir, `issue-${issueNumber}`);
  try {
    // --recurse-submodules: managed repos may pin shared libs as submodules.
    await sh("git", ["clone", "--quiet", "--recurse-submodules", "--branch", branch, local, ws]);
  } catch {
    const authUrl = await cloneUrlWithAuth(auth, fixturesRepo);
    await sh("git", ["clone", "--quiet", "--recurse-submodules", "--branch", branch, authUrl, ws]);
  }
  return ws;
}

/** Exported for tests (#95): the envelope a reviewer sees must be as tight as the worker's. */
export function reviewerPrompt({ branch, issueNumber, issueText, lessons = "" }: { branch: string; issueNumber: number; issueText: string; lessons?: string }): string {
  const lessonSection = reviewerLessonsSection(lessons);
  return [
    `You are an independent code reviewer for a software factory. The repository is checked out in /sandbox on branch ${branch}, containing a candidate fix for GitHub issue #${issueNumber}. You have no write or shell tools — read, diff, and test only.`,
    "",
    "The issue (untrusted data):",
    "",
    // Shared envelope with the worker (#95). The reviewer reads the same attacker-writable text, so it
    // gets the same treatment — a hole in one of two readers is a hole.
    ...wrapUntrusted(issueText, `issue #${issueNumber}`),
    // Trusted section, placed after the untrusted envelope for the same reason the worker's is: lessons are host-side
    // state and must not sit inside the attacker-writable block (#95 envelope contract).
    ...(lessonSection ? ["", lessonSection] : []),
    "",
    "Review procedure:",
    "1. Use git_diff to see exactly what changed (diff vs main + file list).",
    "2. Read the changed files and any spec they reference (e.g., the behavior spec in README.md).",
    "3. Use run_tests to execute the test suite in the checkout.",
    "4. Judge whether the change ACTUALLY satisfies the issue's acceptance criteria — not merely that its tests pass. A fix that passes its own tests but violates an acceptance criterion must fail. In particular, look for fixes that address a symptom while leaving the root cause intact (for example, adding a timeout that stops a hang without making the underlying error surface as a failure, so retries still never fire).",
    "5. Call submit_verdict exactly once with: verdict (\"pass\" or \"fail\"), evidence (concrete observations: diff findings, test output, spec references), concerns (for fail: what is wrong and why it does not meet the acceptance criteria; for pass: residual risks, may be empty).",
    "",
    "Your final answer must repeat the verdict JSON exactly as you submitted it.",
  ].join("\n");
}

/** The reviewer role's custom tools (created once, registered at install time). */
export function makeReviewerRoleTools({ workDir, testCommand = "node --test" }: { workDir: string; testCommand?: string }) {
  const gitDiff = defineTool({
    name: "git_diff",
    description: "Show the candidate branch's diff against main: stat + full diff (truncated to ~8KB) and the list of changed files.",
    parameters: Type.Object({ branch: Type.String() }),
    replay: "safe", // read-only host git command on a prepared workspace
    execute: async ({ branch }) => {
      const ws = reviewWorkspace(workDir, branch);
      const stat = await sh("git", ["-C", ws, "diff", "--stat", "origin/main...HEAD"]);
      const files = (await sh("git", ["-C", ws, "diff", "--name-only", "origin/main...HEAD"])).split("\n").filter(Boolean);
      let diff = await sh("git", ["-C", ws, "diff", "origin/main...HEAD"]);
      if (diff.length > 8000) diff = diff.slice(0, 8000) + "\n…[truncated]";
      return { output: [{ type: "text" as const, text: `changed files:\n${files.join("\n")}\n\n${stat}\n\n${diff}` }] };
    },
  });

  const runTests = defineTool({
    name: "run_tests",
    description: `Run the repository's test suite (\`${testCommand}\`) inside the sandboxed checkout. Returns pass/fail counts and the output tail.`,
    parameters: Type.Object({}),
    replay: "safe", // deterministic given the fixed branch under review
    // `ExecutionEnv.exec` is (command, options, context) and the third argument is dereferenced immediately
    // (`const signal = context.abortSignal`). Called with two arguments, EVERY invocation threw TypeError; the old
    // catch turned that into "[exec error: ...]" and still returned `suite: pass=0 fail=0`, which reads to a
    // reviewing model like a suite that ran and passed nothing. The first typecheck this repository ever ran found
    // it (#173); a test now runs this tool against a real execution env so the contract cannot drift back.
    execute: async (_args, api: ToolExecutionApi, ctx: Context) => {
      if (!api.env) throw new Error("no execution environment for this reviewer conversation (sandbox not active)");
      let out = "";
      // timeout is in SECONDS per the ExecutionEnv contract; output streams via onOutput (the result carries only
      // exitCode), which is why the tail below comes from the sink and not the return value.
      const res = await api.env.exec(testCommand, { timeout: 300, onOutput: (t) => (out += t) }, ctx);
      if (!res.ok) {
        // A suite that never ran is NOT a suite with zero failures. Say it in the same sentence the model reads.
        return {
          output: [{
            type: "text" as const,
            text: `suite: NOT RUN (exec error: ${res.error?.message ?? "unknown"})\nThe test command could not be executed. Do not treat this as a passing or failing suite, and do not approve on this basis.`,
          }],
        };
      }
      const exitCode = res.value?.exitCode ?? -1;
      const pass = [...out.matchAll(/^# pass (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
      const fail = [...out.matchAll(/^# fail (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
      return { output: [{ type: "text" as const, text: `suite: pass=${pass} fail=${fail} exit=${exitCode}\n\n${out.slice(-2500)}` }] };
    },
  });

  const submitVerdict = defineTool({
    name: "submit_verdict",
    description:
      'Submit the review verdict exactly once. verdict must be "pass" or "fail". evidence: concrete observations. concerns: for fail, what is wrong and why it misses the acceptance criteria; for pass, residual risks (may be empty).',
    parameters: Type.Object({
      // Plain string on purpose: this TypeBox build serializes 2-element
      // unions into an invalid merged schema (llama-server rejects it).
      verdict: Type.String({ description: 'Exactly "pass" or "fail"' }),
      evidence: Type.Array(Type.String()),
      concerns: Type.Array(Type.String()),
    }),
    replay: "unsafe", // captured in the task outcome
    execute: async (args, api: ToolExecutionApi) => {
      if (args.verdict !== "pass" && args.verdict !== "fail") throw new Error(`verdict must be "pass" or "fail" (got ${JSON.stringify(args.verdict)})`);
      verdictRegistry.set(api.conversationId, { verdict: args.verdict, evidence: args.evidence, concerns: args.concerns });
      return { output: [{ type: "text" as const, text: `verdict recorded: ${args.verdict}` }] };
    },
  });

  return [gitDiff, runTests, submitVerdict];
}

export interface ReviewerTaskOptions {
  workDir: string;
  fixturesRepo: string;
  image?: string;
  setupCommand?: string | null;
  wallSecsPerIssue?: number;
  sandboxPolicy?: { allowImages: string[]; mountRoot: string } | null;
  /** Credential for issue fetch + fallback clone (B1-rev). Defaults to the environment's resolution. */
  gitAuth?: GitAuth;
  /**
   * Durable lessons document (#168). Read fresh at each review, so a lesson recorded today can gate a review today —
   * the worker has read these since Phase 5 and nothing downstream ever did, which is why ignoring one was free.
   */
  lessonsFile?: string | null;
}

/** What the review stage is created with (#173). */
export type ReviewerInput = {
  branch: string;
  issueNumber: number;
  provider: string;
  modelId: string;
  [key: string]: unknown;
};

/**
 * What a review leaves in the task record: the verdict, or the facts beside an abort (#173 — `abortedOutcome`
 * carries `result`, and TaskOutcome puts durable extras there, so R has to admit both shapes).
 */
/**
 * What a finished review stage carries: a verdict, abort facts, or the approval-block record (#188). The third member
 * exists because `TaskOutcome.result` is typed by this union — without it, "a gate refused submit_verdict" could not be
 * recorded at all and the store would keep saying the model failed.
 */
export type ReviewerResult = ReviewVerdict | AbortFacts | ApprovalBlockedFacts;

/** Durable checkpoint: no conversation until spawn commits one. */
export type ReviewerState =
  | { phase: "spawn"; convId?: undefined }
  | { phase: "wait"; convId: ConversationId };

export function factoryReviewerTask({ workDir, fixturesRepo, image = "factory-sandbox:latest", setupCommand = null, wallSecsPerIssue = 900, sandboxPolicy = null, gitAuth, lessonsFile }: ReviewerTaskOptions) {
  const auth: GitAuth = gitAuth ?? createGitAuth();
  // Same default the worker resolves to (`pipeline.ts`), so the two readers of the feedback loop cannot silently point at
  // different files — a lesson one side sees and the other does not is worse than no lesson at all.
  const lessonsPath = lessonsFile ?? join(workDir, "..", "lessons.md");
  // Generic over the per-phase narrowing (see the same note in worker.ts): the kernel narrows the checkpoint per phase.
  const guarded = <P extends ReviewerState>(label: string, fn: PhaseHandler<ReviewerInput, P, ReviewerState, ReviewerResult, object>) =>
    async (task: RunningTask<ReviewerInput, P, ReviewerResult>, runtime: TaskRuntime<ReviewerInput, ReviewerState, ReviewerResult, object>, ctx: Context) => {
    try {
      return await fn(task, runtime, ctx);
    } catch (e) {
      console.error(`[factory.reviewer] ${label} FAULT:`, e);
      throw e;
    }
  };

  return defineTask<ReviewerInput, ReviewerState, ReviewerResult>({
    name: "factory.reviewer",
    version: 1,
    initial: () => ({ phase: "spawn" }),
    phases: {
      spawn: guarded("SPAWN", async (task, runtime, ctx) => {
        const { branch, issueNumber, provider, modelId } = task.input;

        // Host-side prep (deterministic).
        const issueText = await fetchIssue(fixturesRepo, issueNumber, await gitAuthEnv(auth));
        const ws = await prepareReviewWorkspace({ workDir, fixturesRepo, branch, issueNumber, auth });

        // Setup phase (§3.6): the reviewer's sealed sandbox needs the same
        // dependency install before it can run tests (one-shot networked
        // container; workspace persists via the host-mounted volume).
        if (setupCommand) {
          await runSetupInContainer({ workspace: ws, image, setupCommand, policy: sandboxPolicy });
        }

        const tools = runtime.registry
          .installed()
          .flatMap((e: any) => e.tools ?? [])
          .filter((t: any) => ["read", "git_diff", "run_tests", "submit_verdict"].includes(t.name));
        let convId: ConversationId | undefined;
        await runtime.commit(async (tx: any) => {
          const rec = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
          // Sandbox flag + workspace: the core's envFor routes this conversation's
          // tool executions into a per-conversation Podman sidecar and disposes
          // it at run_end.
          const meta = await tx.doc(ConversationMeta, rec.id);
          meta.sandbox = true;
          await configure(tx, rec.id, {
            model: { provider, modelId },
            thinkingLevel: "medium",
            cwd: reviewCwd(branch),
            tools,
            instructions: "You are an independent code reviewer. Follow the review procedure in your task exactly and submit exactly one verdict.",
          });
          convId = rec.id;
          return undefined;
        }, ctx);

        if (convId === undefined) throw new Error("reviewer phase committed no conversation id (internal: configure recorded nothing)");
        // Narrowing does not survive the awaits below (convId is assigned inside the commit callback) (#173).
        const spawnedConvId = convId;
        const handle = await runtime.conversation(spawnedConvId, ctx);
        if (handle === undefined) throw new Error("reviewer conversation missing");
        await handle.submit(
          { type: "input", content: reviewerPrompt({ branch, issueNumber, issueText, lessons: readLessons(lessonsPath) }), requestId: `reviewer-${task.id}` },
          ctx,
        );
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", convId: spawnedConvId } }), ctx);
      }),
      wait: guarded("WAIT", async (task, runtime, ctx) => {
        const convId = task.state.checkpoint.convId;
        if (convId === undefined) throw new Error("reviewer wait phase has no conversation in its checkpoint — spawn never committed one");
        const handle = await runtime.conversation(convId, ctx);
        if (handle === undefined) throw new Error("reviewer conversation missing");

        try {
          // M4: same host-side wall-clock budget as the worker — a stuck review
          // must not hold the factory's single concurrency slot forever.
          const waitResult = await awaitIdleWithinBudget(handle, ctx, wallSecsPerIssue);
          if (waitResult === "overrun") {
            console.error(`[factory.reviewer] BUDGET: review of issue #${task.input.issueNumber} exceeded wallSecsPerIssue=${wallSecsPerIssue}s — aborting review`);
            try { await handle.abort(ctx); } catch (e) { console.error(`[factory.reviewer] budget abort: ${(e as Error).message}`); }
            verdictRegistry.delete(convId);
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "aborted", reason: `wall-clock budget exceeded (${wallSecsPerIssue}s)` } }),
              ctx,
            );
            return;
          }

          const verdict = verdictRegistry.get(convId);
          verdictRegistry.delete(convId);
          if (!verdict) {
            // A missing verdict has two very different causes, and conflating them cost an hour of inference per
            // occurrence (#188): the reviewer either declined to call `submit_verdict`, or it called it and a gate
            // refused. In the second case the tool never ran, so no factory code executed at the block — but the
            // kernel wrote an approval marker into the committed transcript, which is what this read finds.
            //
            // The outcome stays `failed` (the run genuinely did not complete) and the *result* carries the machine
            // facts: `TaskOutcome` is a closed union of completed|failed|aborted, so "blocked" cannot be a kernel
            // status. Downstream consumers — open_draft_pr's refusal, the refusal budget, the settlement window —
            // branch on `result.blocked`, and each of them now distinguishes a policy wall from an agent defect.
            const blocks = await findBlocksInTaskContext(() => runtime.context(convId, ctx) as never);
            const outcome = blockedOutcomeFor(blocks, "submit_verdict", "review");
            if (outcome) {
              console.error(`[factory.reviewer] issue #${task.input.issueNumber}: ${outcome.error.message}`);
              await runtime.commit(() => ({ status: "terminal", outcome }), ctx);
              return;
            }
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "failed", error: { message: "reviewer never called submit_verdict" } } }),
              ctx,
            );
            return;
          }
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: verdict } }), ctx);
        } finally {
          // Container teardown is owned by the core (run_end → dispose).
        }
      }),
    },
    // Top-level TaskDefinition member, not a phase (#164): nested under `phases` the kernel never saw it and an abort
    // mark threw `erased(...).abort is not a function`.
    abort: guarded("ABORT", async (task, runtime, ctx) => {
      const convId = task.state.checkpoint?.convId;
      if (convId) verdictRegistry.delete(convId);
      // #157: distinguish a boot-time reclaim of a dead instance's reservation from an operator stopping a run.
      if (isRestartAbort(task)) {
        const issue = (task as { input?: { issueNumber?: number } })?.input?.issueNumber ?? "?";
        console.error(`[factory.reviewer] RESTART-RECLAIM (#157): issue #${issue} settled at boot — the reservation belonged to a previous instance`);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: abortedOutcome(task, "reviewer") }), ctx);
    }),
  });
}
