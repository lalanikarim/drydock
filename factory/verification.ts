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
//
// ## Where verification runs (#247)
//
// The command under test here is **repository-authored code** — files a model wrote because of text in
// an issue body — so this file decides where untrusted code executes. It defaults to `mode: "sandbox"`:
// a one-shot container with `--network none` and no host environment, via factory/container.ts.
//
// That default is the whole point of this file's history. The gate used to be a host `execFile` with
// `process.env` inherited, which put every credential the instance holds (GitHub App ids and the path to
// its private key, the model key, the Telegram bot token) in scope for code chosen by whoever filed the
// issue. Any claim about `<untrusted>` being a fence rather than a sandbox (R13) collapses if one gate
// *runs* the artifact; verification was that gate.
//
// `mode: "host"` still exists — it is the documented escape hatch for a repo whose suite genuinely cannot
// run in the container — but it must be opted into explicitly per instance, it is disclosed in bold on the
// PR body, and it is logged at boot. A silent fallback to host execution is never allowed: if the runtime
// is broken, that is an infrastructure failure and the push is refused (#247 acceptance criteria).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { commandArgv } from "./factory-config.ts";
import { runInContainer, type SandboxPolicy } from "./container.ts";

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

/** Where the command actually ran. "sandbox" is the posture; "host" is an opt-out that must be visible. */
export type VerificationWhere = "sandbox" | "host";

export type VerificationMode = VerificationWhere;

/** Default container image for verification — the same image the worker's own sandbox uses. */
export const DEFAULT_VERIFICATION_IMAGE = "factory-sandbox:latest";

export interface VerificationEvidence {
  /** False only when the repo waived verification entirely, or when nothing could run (#247 infra failure). */
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
  /** Where the run happened. Absent on evidence produced before #247; new runs always set it. */
  where?: VerificationWhere;
  /** Container image, when `where === "sandbox"` — so the PR says what graded the code. */
  image?: string | null;
  /**
   * Set when verification could not be executed at all (missing container runtime, un-startable image).
   * Distinct from a red suite: it is not evidence about the branch, and re-running the worker cannot fix
   * it, so the refusal text and the budget class differ (#100's infrastructure class).
   */
  infraError?: string;
}

export interface VerifyOptions {
  cwd: string;
  testCommand: string | null | undefined;
  timeoutSecs?: number;
  /**
   * Where to run. Defaults to `"sandbox"`. `"host"` is an explicit opt-out (see the header) and never a
   * fallback — there is no code path that switches from sandbox to host on its own.
   */
  mode?: VerificationMode;
  /** Container image for `mode: "sandbox"`. */
  sandboxImage?: string;
  /** Image allowlist + mount root, enforced before the container starts (plan §3.6). */
  sandboxPolicy?: SandboxPolicy | null;
  /** Host env var *names* to forward into the verification container. Default: none. */
  sandboxEnvAllowlist?: readonly string[];
  /**
   * Container runtime binary. Production leaves this unset (`$FACTORY_CONTAINER_RUNTIME`, else `podman`);
   * tests inject a stub so the infrastructure-vs-red-suite classification can be asserted without a
   * container runtime in CI — the stub is deliberately hostile in the direction reality is (exit 125 with a
   * runtime error line), not cooperative (#247: a fake that answers what you assume proves nothing).
   */
  runtime?: string;
}

/**
 * Exit codes the container runtime itself returns when the command never ran: 125 is "the runtime failed"
 * (bad image, bad bind, seccomp), 126/127 are "not executable" / "not found" inside the container.
 * Verified live (#247 gate): a nonexistent image produced exit 125 and was being reported as a red suite.
 */
export const RUNTIME_ERROR_EXIT_CODES = new Set([125, 126, 127]);

/** Runtime failure markers in output — podman/docker prefix their errors with `Error:`. */
const RUNTIME_ERROR_MARKERS = /No such image|unable to find image|error resolving trust|OCI runtime|mount source|bind mount|cannot execute binary|executable file not found|^Error:\s/m;

/**
 * Decide whether an exit code means "nothing was executed because the runtime could not do it". Returns a
 * reason string for `infraError`, or null when this should be read as a real command result.
 *
 * 126/127 are unambiguous. 125 additionally requires a runtime error marker in the output, so a suite that
 * genuinely exits 125 is never quietly re-labelled an infrastructure problem — the safe direction for a
 * gate is to keep refusing, and this only changes which refusal sentence the orchestrator reads.
 */
export function runtimeFailureReason(exitCode: number | null, output: string): string | null {
  if (exitCode === null || !RUNTIME_ERROR_EXIT_CODES.has(exitCode)) return null;
  if (exitCode !== 125) return `the container could not execute the verification command (exit ${exitCode})`;
  if (!RUNTIME_ERROR_MARKERS.test(output)) return null;
  const marker = output.split("\n").map((l) => l.trim()).find((l) => RUNTIME_ERROR_MARKERS.test(l)) ?? "runtime error";
  return `the container runtime could not run the verification command (exit ${exitCode}): ${marker.slice(0, 200)}`;
}

/** What a run will do, resolved from options. Pure and exported so the default is testable, not assumed. */
export function resolveVerificationPlan(o: { mode?: VerificationMode; sandboxImage?: string } = {}): {
  where: VerificationWhere;
  image: string | null;
} {
  const where: VerificationWhere = o.mode ?? "sandbox";
  return { where, image: where === "sandbox" ? o.sandboxImage ?? DEFAULT_VERIFICATION_IMAGE : null };
}

/** Parsed `node --test` counts, attached when the command is a node test runner (either output dialect). */
function countsFor(command: string, out: string): Partial<VerificationEvidence> {
  const [cmd, ...args] = commandArgv(command);
  if (!(cmd === "node" && args.includes("--test"))) return {};
  return { total: lastCount(out, "tests"), passCount: lastCount(out, "pass"), failCount: lastCount(out, "fail") };
}

/** True when the command is a node test runner that collected nothing. */
function isVacuousRun(command: string, out: string): boolean {
  const [cmd, ...args] = commandArgv(command);
  if (!(cmd === "node" && args.includes("--test"))) return false;
  const total = lastCount(out, "tests");
  return total === undefined || total === 0;
}

/**
 * Run the repo's test command in `cwd` and record what happened. Executed as argv — never through a
 * shell — matching the discipline of every other factory-executed command (factory-config.ts).
 *
 * Sandbox path (#247): one-shot container, no network, no host environment, guaranteed cleanup.
 * Host path: only when `mode: "host"` was explicitly chosen; it inherits `process.env` minus
 * `NODE_TEST_CONTEXT`, which is exactly why it is an opt-out rather than a default.
 */
export async function verifyWorkspace({
  cwd,
  testCommand,
  timeoutSecs = VERIFICATION_TIMEOUT_SECS,
  mode,
  sandboxImage,
  sandboxPolicy = null,
  sandboxEnvAllowlist = [],
  runtime,
}: VerifyOptions): Promise<VerificationEvidence> {
  const plan = resolveVerificationPlan({ mode, sandboxImage });
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
      where: plan.where,
      image: plan.image,
    };
  }

  const collect = (out: string) => countsFor(command, out);

  if (plan.where === "sandbox") {
    // Resolve both sides of the mount check. A symlinked tmpdir (macOS `/var` → `/private/var`) or a
    // relative cwd would otherwise either reject a legitimate workspace or hand podman a bind source it
    // cannot resolve; comparing resolved-to-resolved keeps the escape check honest in both cases.
    const wsAbs = resolve(cwd);
    // A caller that declares no policy still gets a containment floor: the image it named is the only image
    // allowed and the workspace may only mount itself. Without this, `policy: null` would mean "run whatever
    // image string arrives" — the same class of hole #247 is about.
    const policy = sandboxPolicy
      ? { allowImages: sandboxPolicy.allowImages, mountRoot: resolve(sandboxPolicy.mountRoot) }
      : { allowImages: [plan.image ?? DEFAULT_VERIFICATION_IMAGE], mountRoot: wsAbs };
    const res = await runInContainer({
      workspace: wsAbs,
      image: plan.image ?? DEFAULT_VERIFICATION_IMAGE,
      argv: commandArgv(command),
      timeoutSecs,
      network: "none",
      envAllowlist: sandboxEnvAllowlist,
      policy,
      namePrefix: "factory-verify-",
      ...(runtime ? { runtime } : {}),
    });

    // Nothing ran, and no re-delegation fixes it — say so in a way the orchestrator cannot read as
    // "the suite is red". Two shapes: the runtime could not be spawned at all, and the runtime answered
    // with its own error (exit 125/126/127), which used to look exactly like a failing test (#247 gate).
    const runtimeReason = res.spawnError ?? runtimeFailureReason(res.exitCode, res.output);
    if (runtimeReason) {
      return {
        ran: false,
        command,
        exitCode: null,
        timedOut: false,
        passed: false,
        where: "sandbox",
        image: plan.image,
        infraError: runtimeReason,
        tail: `the verification container did not run (${runtimeReason}). This is a factory/infrastructure problem, not a test result.\n${tailOf(res.output, 6)}`,
      };
    }

    const out = res.output;
    if (res.timedOut) {
      // A container that could not be removed after a timeout is an operator problem (#251), and the only
      // place an operator will read about it is this evidence, so it goes in even though the run itself is
      // already refused.
      const leak = res.cleanupError ? `\nWARNING: ${res.cleanupError} — an abandoned verification container may still be running.` : "";
      return {
        ran: true,
        command,
        exitCode: null,
        timedOut: true,
        passed: false,
        tail: `(no result: verification exceeded ${timeoutSecs}s and its container was stopped)${leak}\n${tailOf(out, 6)}`,
        where: "sandbox",
        image: plan.image,
        ...collect(out),
      };
    }

    if (res.exitCode === 0) {
      const vacuous = isVacuousRun(command, out);
      return {
        ran: true,
        command,
        exitCode: 0,
        timedOut: false,
        passed: !vacuous,
        ...(vacuous ? { vacuous: true } : {}),
        tail: vacuous
          ? `(the test runner collected no tests — a green run with nothing in it is not evidence)\n${tailOf(out, 6)}`
          : tailOf(out, 6),
        where: "sandbox",
        image: plan.image,
        ...collect(out),
      };
    }

    return {
      ran: true,
      command,
      exitCode: res.exitCode,
      timedOut: false,
      passed: false,
      tail: tailOf(out, FAILING_TAIL_LINES),
      where: "sandbox",
      image: plan.image,
      ...collect(out),
    };
  }

  // ---- host path (explicit opt-out) ----
  try {
    const [cmd, ...args] = commandArgv(command);
    // A test runner must not inherit this harness's own runner state: node's test runner sees an
    // inherited NODE_TEST_CONTEXT, decides it is already inside a test file, and SKIPS every file —
    // exiting 0 having run nothing. Verified on node 22: the nested run prints "run() is being called
    // recursively within a test file. skipping running files" and reports success. That is a green
    // verification with zero tests behind it, so the variable is stripped from the child env.
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const { stdout } = await pExecFile(cmd, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutSecs * 1000 });
    const out = String(stdout ?? "");
    const counts = collect(out);
    // Exit code 0 is not sufficient evidence for a test runner: zero tests collected means nothing
    // was verified, whatever the process returned. Same reasoning as #61's whole point.
    const vacuous = isVacuousRun(command, out);
    return {
      ran: true,
      command,
      exitCode: 0,
      timedOut: false,
      passed: !vacuous,
      ...(vacuous ? { vacuous: true } : {}),
      tail: vacuous ? `(the test runner collected no tests — a green run with nothing in it is not evidence)\n${tailOf(out, 6)}` : tailOf(out, 6),
      where: "host",
      image: null,
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
      where: "host",
      image: null,
      ...collect(out),
    };
  }
}

export interface GateDecision {
  action: "proceed" | "refuse";
  reason?: string;
  /** True when the refusal is a factory/runtime problem rather than a result about the branch (#100 classing). */
  infra?: boolean;
}

/**
 * Decide whether a push may happen, given the evidence and this repo's policy. Pure, so the whole
 * matrix is testable without a workspace or a GitHub token.
 */
export function verificationGate(evidence: VerificationEvidence, { requireVerification = true }: { requireVerification?: boolean } = {}): GateDecision {
  // First, because it outranks every other reading of the run: nothing executed, so there is no
  // evidence to weigh and no amount of re-delegation that would change the outcome. A waived repo does
  // not get a pass either — "we could not verify" is not the same claim as "this repo has no suite".
  if (evidence.infraError) {
    return {
      action: "refuse",
      infra: true,
      reason:
        `verification could not run (${evidence.infraError}) — nothing was pushed. This is an infrastructure failure, ` +
        "not a test result: re-delegating the worker cannot change it. Check that the container runtime is up and the " +
        "sandbox image exists (or set verificationMode:\"host\" in this repo's runtime config to opt out knowingly).",
    };
  }
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
      reason: "verification is required for this repo but no test command is configured — set testCommand in the per-repo config, or requireVerification:false in $DRYDOCK_CONFIG_DIR/repo-registry.json to waive it deliberately",
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

  if (evidence.infraError) {
    return [
      `**NOT VERIFIED — the verification run could not start.** ${evidence.infraError}`,
      "This is a factory infrastructure failure, not a result about this branch.",
    ].join("\n");
  }

  if (!evidence.ran) {
    return [
      `**NOT VERIFIED — nothing was executed.** ${evidence.skippedReason ?? ""}`.trim(),
      `This repo sets \`requireVerification: false\` in $DRYDOCK_CONFIG_DIR/repo-registry.json (decision C1 escape hatch${requireVerification ? "; note: the effective policy here is to require verification" : ""}).`,
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

  const lines = [`Command: \`${evidence.command}\``, `Exit code: ${evidence.exitCode ?? "n/a"}`, `Result: ${status}`];
  // Where it ran (#247) — the posture a reviewer is entitled to see, and the reason a host run is loud.
  if (evidence.where === "sandbox") {
    lines.push("Environment: sealed container (`--network none`, no host environment), image " + `\`${evidence.image ?? "?"}\``);
  } else if (evidence.where === "host") {
    lines.push(
      "**Environment: the factory HOST — repository-authored code ran with the instance's own environment in scope (#247).** " +
        "This repo opted out of sandboxed verification (`verificationMode: \"host\"`); treat this run as unsandboxed.",
    );
  }
  lines.push("", "```", evidence.tail, "```");
  return lines.join("\n");
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
