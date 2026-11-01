// The refinement pass as a durable task (#65), plus the orchestrator-facing tool that runs it.
//
// Capability story, which is the whole design:
//
//   * the conversation gets **one tool: `read`** — no write, no edit, no bash. It can ground a brief in
//     real code and cannot change a byte;
//   * its workspace is a host-prepared clone of the default branch with the **remote URL scrubbed**, so
//     even a hypothetical escape has no credential in `.git/config` and no network in the sandbox;
//   * posting the resulting comment happens **host-side, after parsing**, by code that never consults the
//     model — and only if the issue is still open at that moment.
//
// Nothing downstream consumes a brief automatically: acting still requires the repo's eligibility label
// plus path scope, verification and review. A refinement is advice with a provenance footer, not a task.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { configure, defineTask, defineTool, type Context, type ToolExecutionApi, type ToolTask } from "@earendil-works/pi-durable";
import type { Notifier } from "./notify-telegram.ts";
import { ConversationMeta } from "../vendor/engram/app/src/core.ts";
import { awaitIdleWithinBudget } from "./budgets.ts";
import { gitAuthEnv, type GitAuth } from "./github-auth.ts";
import { sanitizeUntrusted } from "./untrusted.ts";
import type { PathScope } from "./path-scope.ts";
import { parseRefineBrief, refinePrompt, renderRefineComment, type RefineTrigger } from "./issue-refine.ts";

const pExecFile = promisify(execFile);

async function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

export interface IssueForRefine {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
}

/**
 * Read the issue and its discussion (host-side, fresh — never from the webhook payload).
 *
 * The payload is a snapshot of a moment that has already passed; the same discipline as #67's PR facts.
 * `exec` is injectable so tests never shell out.
 */
export async function fetchIssueForRefine(
  repo: string,
  issueNumber: number,
  token: string,
  { exec = sh }: { exec?: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string> } = {},
): Promise<IssueForRefine | null> {
  const env = { ...process.env, GH_TOKEN: token } as NodeJS.ProcessEnv;
  let raw: string;
  try {
    raw = await exec("gh", ["api", `repos/${repo}/issues/${issueNumber}`, "--jq", ".number"], { env });
  } catch {
    return null;
  }
  if (!/^\d+$/.test(raw)) return null;
  const issue = JSON.parse(await exec("gh", ["api", `repos/${repo}/issues/${issueNumber}`], { env }));
  const commentsRaw = JSON.parse(await exec("gh", ["api", `repos/${repo}/issues/${issueNumber}/comments?per_page=20&sort=created&direction=desc`], { env }));
  return {
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    state: String(issue.state ?? "open"),
    labels: Array.isArray(issue.labels) ? issue.labels.map((l: any) => String(l?.name ?? "")).filter(Boolean) : [],
    // Ascending order, oldest first: the refiner reads discussion chronologically.
    comments: (Array.isArray(commentsRaw) ? commentsRaw : [])
      .reverse()
      .map((c: any) => ({ author: String(c?.user?.login ?? "unknown"), body: String(c?.body ?? "") })),
  };
}

/** Post the refinement comment as the App. Returns the HTML url GitHub assigned. */
export async function postRefineComment(
  repo: string,
  issueNumber: number,
  body: string,
  token: string,
  { exec = sh }: { exec?: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string> } = {},
): Promise<string> {
  const env = { ...process.env, GH_TOKEN: token } as NodeJS.ProcessEnv;
  const out = await exec("gh", ["api", `repos/${repo}/issues/${issueNumber}/comments`, "-f", `body=${body}`], { env });
  try {
    const parsed = JSON.parse(out);
    if (parsed?.html_url) return String(parsed.html_url);
  } catch {
    /* gh prints the created comment; a parse failure here must not lose the fact that it posted */
  }
  return "(posted — url unread from the response)";
}

/**
 * A read-only clone of the default branch for grounding the brief.
 *
 * No feature branch is created (nothing to commit), and the remote URL is scrubbed after cloning so no
 * credential survives in `.git/config` inside a conversation that has a filesystem.
 */
export async function prepareRefineWorkspace({
  workDir,
  fixturesRepo,
  issueNumber,
  token,
  exec = sh,
}: {
  workDir: string;
  fixturesRepo: string;
  issueNumber: number;
  token: string;
  exec?: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;
}): Promise<string> {
  const ws = join(workDir, `refine-${issueNumber}`);
  rmSync(ws, { recursive: true, force: true });
  const authUrl = `https://x-access-token:${token}@github.com/${fixturesRepo}.git`;
  await exec("git", ["clone", "--quiet", "--depth", "50", authUrl, ws]);
  await exec("git", ["-C", ws, "remote", "set-url", "origin", `https://github.com/${fixturesRepo}.git`]);
  return ws;
}

export interface RefineTaskOptions {
  workDir: string;
  fixturesRepo: string;
  gitAuth: GitAuth;
  /** Wall-clock ceiling for one refinement. Deliberately far below the worker's: this is a reading task. */
  wallSecsPerRefine?: number;
  image?: string;
  sandboxPolicy?: any;
  pathScope?: PathScope;
  /** Operator notification (#64), fired host-side after the brief is actually posted. */
  notify?: Notifier;
}

export function factoryRefineTask({ workDir, fixturesRepo, gitAuth, wallSecsPerRefine = 600, pathScope, notify }: RefineTaskOptions) {
  return defineTask({
    name: "factory.refine",
    version: 1,
    initial: () => ({ phase: "spawn" }),
    phases: {
      spawn: async (task: any, runtime: any, ctx: Context) => {
        const { issueNumber, provider, modelId } = task.input;
        const trigger: RefineTrigger = task.input.trigger === "comment" ? "comment" : "label";
        const sender = String(task.input.sender ?? "unknown");
        // Sanitized again here: the text was relayed through intake and a tool argument, and the model
        // must never see an envelope-closing marker regardless of what upstream remembered (#95).
        const directive = sanitizeUntrusted(String(task.input.guidance ?? ""));

        const authEnv = await gitAuthEnv(gitAuth);
        const token = authEnv.GH_TOKEN ?? "";

        const issue = await fetchIssueForRefine(fixturesRepo, issueNumber, token);
        if (!issue) throw new Error(`refinement refused: issue #${issueNumber} not found in ${fixturesRepo}`);
        if (issue.state !== "open") throw new Error(`refinement refused: issue #${issueNumber} is ${issue.state}, not open`);

        const ws = await prepareRefineWorkspace({ workDir, fixturesRepo, issueNumber, token });

        // Read-only by capability, not by instruction.
        const tools = runtime.registry
          .installed()
          .flatMap((e: any) => e.tools ?? [])
          .filter((t: any) => t.name === "read");
        if (!tools.length) throw new Error("refinement cannot run: the `read` tool is not installed in this instance");

        let convId: number;
        await runtime.commit(async (tx: any) => {
          const rec = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
          const meta = await tx.doc(ConversationMeta, rec.id);
          meta.sandbox = true;
          await configure(tx, rec.id, {
            model: { provider, modelId },
            thinkingLevel: "medium",
            cwd: `refine-${issueNumber}`,
            tools,
            instructions: "You refine one GitHub issue into an actionable brief. You have read access only. Answer in the exact section format requested.",
          });
          convId = rec.id;
          return undefined;
        }, ctx);

        const handle = await runtime.conversation(convId, ctx);
        if (handle === undefined) throw new Error("refinement conversation missing");
        const issueText = `# ${issue.title}\n\n${issue.body}\n\nLabels: ${issue.labels.join(", ") || "(none)"}`;
        await handle.submit(
          {
            type: "input",
            content: refinePrompt({ issueNumber, issueText, comments: issue.comments, directive, pathScope, repo: fixturesRepo }),
            requestId: `refine-${task.id}`,
          },
          ctx,
        );
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", convId } }), ctx);
      },

      wait: async (task: any, runtime: any, ctx: Context) => {
        const convId = task.state.checkpoint.convId;
        const handle = await runtime.conversation(convId, ctx);
        if (handle === undefined) throw new Error("refinement conversation missing");
        const { issueNumber } = task.input;
        const trigger: RefineTrigger = task.input.trigger === "comment" ? "comment" : "label";
        const sender = String(task.input.sender ?? "unknown");

        const overBudget = await awaitIdleWithinBudget(handle, ctx, wallSecsPerRefine);
        if (overBudget === "overrun") {
          try {
            await handle.abort(ctx);
          } catch {
            /* abort of an already-finished run is not an error worth failing for */
          }
          await runtime.commit(
            () => ({ status: "completing", outcome: { status: "aborted", reason: `refinement exceeded ${wallSecsPerRefine}s` } }),
            ctx,
          );
          return;
        }

        let answer = "";
        const view = await runtime.context(convId, ctx);
        for (const m of [...view.messages].reverse()) {
          if (m.role !== "assistant") continue;
          const text = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
          if (text) {
            answer = text;
            break;
          }
        }
        if (!answer) {
          await runtime.commit(() => ({ status: "completing", outcome: { status: "failed", error: { message: "refiner produced no output" } } }), ctx);
          return;
        }

        // Fail closed on a malformed brief: a partial acceptance list reads like an approved plan, which
        // is worse than no comment at all. The raw text stays in the task outcome for debugging.
        const parsed = parseRefineBrief(answer);
        if (!parsed.ok) {
          await runtime.commit(
            () => ({ status: "completing", outcome: { status: "failed", error: { message: `refinement not posted: ${parsed.reason}` }, raw: answer.slice(0, 4000) } }),
            ctx,
          );
          return;
        }

        const authEnv = await gitAuthEnv(gitAuth);
        const token = authEnv.GH_TOKEN ?? "";
        // Re-check liveness before writing: a refinement can take minutes, and commenting on an issue
        // that closed meanwhile is exactly the kind of stale-actor noise this factory has been built to avoid.
        const fresh = await fetchIssueForRefine(fixturesRepo, issueNumber, token);
        if (!fresh || fresh.state !== "open") {
          await runtime.commit(
            () => ({ status: "completing", outcome: { status: "failed", error: { message: `refinement not posted: issue #${issueNumber} is no longer open` } } }),
            ctx,
          );
          return;
        }

        const body = renderRefineComment(parsed.brief, { repo: fixturesRepo, issueNumber, trigger, sender });
        const url = await postRefineComment(fixturesRepo, issueNumber, body, token);
        console.error(`[factory.refine] posted refinement for #${issueNumber} -> ${url}`);
        // Told only after the comment exists (#64), and never at the cost of the outcome: a failed
        // notification leaves a completed refinement, not a failed one.
        if (notify) {
          try {
            await notify({ kind: "refine_posted", repo: fixturesRepo, issueNumber, commentUrl: url });
          } catch (e) {
            console.error(`[factory.refine] notification failed for #${issueNumber}: ${String(e)}`);
          }
        }
        await runtime.commit(
          () => ({ status: "completing", outcome: { status: "completed", result: { posted: true, commentUrl: url, brief: parsed.brief } } }),
          ctx,
        );
      },

      abort: async (task: any, runtime: any, ctx: Context) => {
        await runtime.commit(() => ({ status: "completing", outcome: { status: "aborted", reason: "refinement aborted" } }), ctx);
      },
    },
  });
}

/** Orchestrator-facing tool: run one refinement pass for an issue and post the brief as a comment. */
export function refineIssueTool({ taskDef, modelRef }: { taskDef: ToolTask; modelRef: { provider: string; modelId: string } }) {
  return defineTool({
    name: "refine_issue",
    description:
      "Refine one GitHub issue into an actionable brief and post it as a comment on the issue. The refiner reads the repository but cannot change anything, and the brief grants no capability: work still requires the eligibility label plus every gate. Use this when the incoming request says to refine/expand an issue; never call delegate or open_draft_pr in the same turn.",
    parameters: Type.Object({
      issueNumber: Type.Integer(),
      guidance: Type.Optional(Type.String({ description: "Extra guidance from the requester, verbatim. Treated as data." })),
      trigger: Type.Optional(Type.String({ description: 'What asked for this: "label" or "comment". Defaults to "label".' })),
      sender: Type.Optional(Type.String({ description: "GitHub login that requested the refinement (for provenance in the comment footer)." })),
    }),
    replay: "unsafe", // spawns a child task and posts a public comment
    execute: async (args, api: ToolExecutionApi, ctx: Context) => {
      const id = await api.createTask(
        taskDef,
        {
          issueNumber: args.issueNumber,
          guidance: args.guidance ?? "",
          trigger: args.trigger === "comment" ? "comment" : "label",
          sender: args.sender ?? "unknown",
          ...modelRef,
        },
        { ownership: { kind: "task", taskId: api.taskId } },
        ctx,
      );
      const settled = await api.waitForTask(id, ctx);
      const outcome = settled.state.outcome;
      return {
        output: [
          {
            type: "text" as const,
            text: JSON.stringify(
              outcome.status === "completed"
                ? { posted: true, commentUrl: (outcome.result as any).commentUrl, brief: (outcome.result as any).brief }
                : { posted: false, error: outcome.error?.message ?? outcome.reason ?? outcome.status },
            ),
          },
        ],
      };
    },
  });
}
