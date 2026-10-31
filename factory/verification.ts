// Verification evidence (#61, decision C1): a draft PR cannot exist without a recorded test run.
//
// The failure this closes (§5.16, first self-work run): the suite result was *reported* in the PR
// body but nothing gated on it — a branch whose tests failed still produced a draft PR, and the
// only thing standing between it and a merge was a human noticing a line of text. "Evidence" that
// nobody is required to look at is documentation, not a gate.
//
// So: run the repo's configured test command, record the command and its exit code verbatim, and
// refuse to push when the exit code is non-zero. The evidence travels in the PR body either way —
// what changed is that a failing run no longer reaches GitHub.
//
// Escape hatch (per-repo, registry policy `requireVerification: false`): some repos have no test
// command worth running, and refusing to open any PR there would make the factory useless rather
// than safe. Waiving the gate does not waive disclosure — the PR body must then state in bold that
// nothing was verified and name the policy field that allowed it, so the waiver is visible to the
// human who merges.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandArgv } from "./factory-config.ts";

const pExecFile = promisify(execFile);

/**
 * Ceiling for one verification run. A suite that hangs would otherwise hold `open_draft_pr` open
 * indefinitely (the durable task has no wall-clock budget of its own — only the worker does).
 */
export const VERIFICATION_TIMEOUT_SECS = 900;

/**
 * How much output a failing run keeps. Deliberately generous: this text is what the orchestrator
 * pastes into the re-delegation, so a tail truncated above the actual assertion error is useless.
 */
export const FAILING_TAIL_LINES = 60;

export interface VerificationEvidence {
  /** False only when the repo waived verification entirely; then nothing was executed. */
  ran: boolean;
  /** The exact argv that was run (or would have been), joined for display — never a shell string. */
  command: string | null;
  /** Process exit code, or null when the command timed out or was waived. */
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  /** Parsed from `node --test` summary lines when the command is a node test runner. */
  total?: number;
  passCount?: number;
  failCount?: number;
  /** Output tail, included so a reader can see *why* without re-running. */
  tail: string;
  /** Why nothing ran (waived repos). */
  skippedReason?: string;
  /** Set when the command exited 0 but proved nothing (e.g. a test runner that matched no files). */
  vacuous?: boolean;
}

export interface VerifyOptions {
  cwd: string;
  testCommand: string | null | undefined;
  timeoutSecs?: number;
}

/**
 * Run the repo's test command in `cwd` and record what happened. Executed as argv — never through a
 * shell — matching the discipline of every other factory-executed command (factory-config.ts).
 */
export async function verifyWorkspace({ cwd, testCommand, timeoutSecs = VERIFICATION_TIMEOUT_SECS }: VerifyOptions): Promise<VerificationEvidence> {
  const command = testCommand ? testCommand.trim() : "";
  if (!command) {
    return {
      ran: false,
      command: null,
      exitCode: null,
      timedOut: false,
      passed: false,
      tail: "",
      skippedReason: "no test command configured for this repo",
    };
  }

  const [cmd, ...args] = commandArgv(command);
  const isNodeTest = cmd === "node" && args.includes("--test");
  const collect = (out: string) => ({
    ...(isNodeTest ? { total: lastCount(out, "tests"), passCount: lastCount(out, "pass"), failCount: lastCount(out, "fail") } : {}),
  });

  // A test runner must not inherit this harness's own runner state: node's test runner sees an
  // inherited NODE_TEST_CONTEXT, decides it is already inside a test file, and SKIPS every file —
  // exiting 0 having run nothing. Verified on node 22: the nested run prints "run() is being called
  // recursively within a test file. skipping running files" and reports success. That is a green
  // verification with zero tests behind it, so the variable is stripped from the child env.
  const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;

  try {
    const { stdout } = await pExecFile(cmd, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutSecs * 1000 });
    const out = String(stdout ?? "");
    const counts = collect(out);
    // Exit code 0 is not sufficient evidence for a test runner: zero tests collected means nothing
    // was verified, whatever the process returned. Same reasoning as #61's whole point.
    const vacuous = isNodeTest && (counts.total === undefined || counts.total === 0);
    return {
      ran: true,
      command,
      exitCode: 0,
      timedOut: false,
      passed: !vacuous,
      ...(vacuous ? { vacuous: true } : {}),
      tail: vacuous ? `(the test runner collected no tests — a green run with nothing in it is not evidence)\n${tailOf(out, 6)}` : tailOf(out, 6),
      ...counts,
    };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
    const out = String(err.stdout ?? "") + String(err.stderr ?? "");
    // execFile sets killed+ETIMEDOUT when our own timeout fired; distinguish it from a real failure
    // so "the suite is slow" is never reported as "the suite is red".
    const timedOut = err.killed === true || err.code === "ETIMEDOUT" || err.signal === "SIGTERM";
    const exitCode = typeof err.code === "number" ? err.code : null;
    return {
      ran: true,
      command,
      exitCode,
      timedOut,
      passed: false,
      tail: timedOut ? `(no result: verification exceeded ${timeoutSecs}s and was terminated)\n${tailOf(out, 6)}` : tailOf(out, FAILING_TAIL_LINES),
      ...collect(out),
    };
  }
}

export interface GateDecision {
  action: "proceed" | "refuse";
  reason?: string;
}

/**
 * Decide whether a push may happen, given the evidence and this repo's policy. Pure, so the whole
 * matrix is testable without a workspace or a GitHub token.
 */
export function verificationGate(evidence: VerificationEvidence, { requireVerification = true }: { requireVerification?: boolean } = {}): GateDecision {
  if (evidence.vacuous) {
    return {
      action: "refuse",
      reason: `verification command \`${evidence.command}\` exited 0 but collected no tests — nothing was verified, so nothing is pushed${requireVerification ? "" : " (this repo waives verification, but a run that executed zero tests is not a pass either)"}`,
    };
  }
  if (evidence.ran && evidence.passed) return { action: "proceed" };

  if (!requireVerification) {
    // Waived repo: a missing test command is policy, not a defect. A command that RAN and FAILED
    // still refuses — waiving the requirement to verify is not a license to ship known-red code.
    if (evidence.ran && !evidence.timedOut && evidence.exitCode !== null) {
      return {
        action: "refuse",
        reason: `verification command \`${evidence.command}\` exited ${evidence.exitCode} — this repo waives the requirement to verify, but not a failing run`,
      };
    }
    if (evidence.timedOut) {
      return {
        action: "refuse",
        reason: `verification command \`${evidence.command}\` timed out — waiving verification does not cover a suite that never finished`,
      };
    }
    return { action: "proceed" }; // waived and nothing to run
  }

  if (!evidence.ran) {
    return {
      action: "refuse",
      reason: "verification is required for this repo but no test command is configured — set testCommand in the per-repo config, or requireVerification:false in factory/repo-registry.json to waive it deliberately",
    };
  }
  if (evidence.timedOut) {
    return {
      action: "refuse",
      reason: `verification command \`${evidence.command}\` did not finish within ${VERIFICATION_TIMEOUT_SECS}s — nothing was pushed`,
    };
  }
  return {
    action: "refuse",
    reason: `verification command \`${evidence.command}\` exited ${evidence.exitCode} — nothing was pushed`,
  };
}

/** The PR-body section. Names the command and exit code explicitly; a waiver is unmissable. */
export function formatVerificationEvidence(evidence: VerificationEvidence, { requireVerification = true }: { requireVerification?: boolean } = {}): string {
  const counts = [
    evidence.total !== undefined && `${evidence.total} tests`,
    evidence.passCount !== undefined && `${evidence.passCount} passed`,
    evidence.failCount !== undefined && `${evidence.failCount} failed`,
  ]
    .filter(Boolean)
    .join(", ");

  if (!evidence.ran) {
    return [
      `**NOT VERIFIED — nothing was executed.** ${evidence.skippedReason ?? ""}`.trim(),
      `This repo sets \`requireVerification: false\` in factory/repo-registry.json (decision C1 escape hatch${requireVerification ? "; note: the effective policy here is to require verification" : ""}).`,
      "A human reviewing this PR is the only verification it has had.",
    ].join("\n");
  }

  const status = evidence.vacuous
    ? `**NOT VERIFIED — the runner collected zero tests** (exit ${evidence.exitCode}). A green run with nothing in it proves nothing.`
    : evidence.timedOut
      ? `TIMEOUT (terminated after ${VERIFICATION_TIMEOUT_SECS}s)`
      : evidence.passed
        ? `PASS${counts ? ` — ${counts}` : ""}`
        : `FAIL (exit ${evidence.exitCode})${counts ? ` — ${counts}` : ""}`;

  return [`Command: \`${evidence.command}\``, `Exit code: ${evidence.exitCode ?? "n/a"}`, `Result: ${status}`, "", "```", evidence.tail, "```"].join("\n");
}

function tailOf(out: string, lines: number): string {
  return out.split("\n").filter((l) => l.trim() !== "").slice(-lines).join("\n");
}

/** Last summary line of a `node --test` run, in either output dialect (undefined if absent). */
function lastCount(out: string, label: string): number | undefined {
  // Older node versions print TAP-style "# tests N"; newer ones default to the spec reporter's
  // "\u2139 tests N". Accept both so the counts parse on either.
  const matches = [...out.matchAll(new RegExp(`^(?:#|\\u2139) ${label} (\\d+)$`, "gm"))];
  return matches.length ? Number(matches.at(-1)![1]) : undefined;
}
