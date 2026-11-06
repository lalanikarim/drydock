// One place that runs a command inside a container, and guarantees the container dies (#247, #251).
//
// Why this file exists
//
// The factory executes three kinds of repository-influenced commands: the worker's setup install, the
// reviewer's test run (already inside the kernel's sandbox), and — until #247 — the push-gate verification
// run, which was a host `execFile` with the instance's whole environment inherited. Fixing that meant
// running repo code in a container, and we already had two ad-hoc podman invocations (worker setup here,
// engram's SandboxManager upstream) each with their own idea of containment and neither of which actually
// stopped its container when the command timed out: SIGKILL on the `podman run` client leaves the workload
// running server-side, so a "timed out" setup left a networked container alive forever (#251).
//
// So: one runner, one containment posture, cleanup in a `finally`, and an argv builder that is pure so the
// security-relevant flags are asserted by unit tests rather than eyeballed.
//
// Deliberate limits of this file
//
// - It does not pretend to be a sandbox implementation. Long-lived per-conversation sandboxes stay
//   engram's job (vendor/engram/app/src/sandbox.ts); this is for one-shot factory-side commands.
// - No resource limits yet — tracked upstream (engram#92) and worth mirroring here once the flags are
//   agreed, because the same reasoning applies to a verification run that forks bombs on a host also
//   serving inference.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Container runtime binary; override for hosts where podman lives elsewhere or is `docker`. */
export const CONTAINER_RUNTIME = process.env.FACTORY_CONTAINER_RUNTIME ?? "podman";

/** Label key stamped on every factory container so a leak is attributable and greppable. */
export const RUN_LABEL = "io.drydock.run";

/** Output cap per stream, matching the 16 MiB ceiling every other factory command uses. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

/** Containment declaration for one-shot factory containers (engram phase 7 pattern, plan §3.6). */
export interface SandboxPolicy {
  allowImages: string[];
  mountRoot: string;
}

/**
 * Containment last line, applied before any podman call: the base image must be on the factory's allowlist
 * and the workspace must live under the allowed mount root. Pure — callers apply it before spawning.
 */
export function validateSandboxSpec({ image, workspace, allowImages, mountRoot }: { image: string; workspace: string; allowImages: readonly string[]; mountRoot: string }): void {
  if (!allowImages.includes(image)) {
    throw new Error(`sandbox image not allowlisted: ${image} (allowed: ${[...allowImages].join(", ") || "<none>"})`);
  }
  // Path-boundary comparison, so `/srv/work-evil` is never treated as being under `/srv/work`.
  if (workspace !== mountRoot && !workspace.startsWith(`${mountRoot}/`)) {
    throw new Error(`sandbox workspace ${workspace} is outside the allowed mount root ${mountRoot}`);
  }
}

export interface ContainerRunOptions {
  /** Absolute host path bind-mounted at /sandbox and used as the working directory. */
  workspace: string;
  image: string;
  /** Command argv — never a shell string (the caller splits/validates, see factory-config.commandArgv). */
  argv: string[];
  /** Wall-clock ceiling in seconds. On expiry the container is stopped AND removed, not just detached from. */
  timeoutSecs: number;
  /** "none" seals egress; "bridge" is for the setup phase's dependency install and nothing else. */
  network?: "none" | "bridge";
  /**
   * Names of host environment variables to pass through (podman `-e NAME`, which forwards the client's
   * value when set). Default **empty**: a container running repository code gets no host environment, and
   * that is the point — the factory process holds GitHub App credentials, a model key and a bot token.
   */
  envAllowlist?: readonly string[];
  /** When given, enforced before spawning (image allowlist + mount root). */
  policy?: SandboxPolicy | null;
  /** Container name prefix; a unique suffix is appended. */
  namePrefix: string;
  runtime?: string;
}

export interface ContainerRunResult {
  /** Process exit code, or null when it could not be run/observed (spawn failure, timeout). */
  exitCode: number | null;
  /** stdout followed by stderr, capped. */
  output: string;
  timedOut: boolean;
  /** Set when the container itself failed to start or the runtime was missing — an infrastructure failure, not a red suite. */
  spawnError?: string;
  /**
   * Set when cleanup could not prove the container was gone. The run's own result stands, but an
   * unswept container is an operator-visible leak (#251), so it must never be silent.
   */
  cleanupError?: string;
  /** Container name used, for logs and forensics. */
  containerName: string;
}

/** The argv passed to the runtime. Pure and exported so the flags are testable, not reviewable-by-eye. */
export function containerRunArgs(o: {
  name: string;
  workspace: string;
  image: string;
  argv: string[];
  network: "none" | "bridge";
  envAllowlist: readonly string[];
}): string[] {
  const envArgs = o.envAllowlist.flatMap((name) => ["-e", name]);
  return [
    "run",
    "--rm",
    "--name",
    o.name,
    // Explicit network namespace choice — never inherit the runtime default, which is bridged.
    "--network",
    o.network,
    "--label",
    `${RUN_LABEL}=${o.name}`,
    "-v",
    `${o.workspace}:/sandbox`,
    "-w",
    "/sandbox",
    ...envArgs,
    o.image,
    ...o.argv,
  ];
}

/** Run one runtime subcommand and capture its output. Never throws; errors come back in the result. */
function runRuntime(runtime: string, argv: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string; err: string; failure?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(runtime, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, out: "", err: "", failure: (e as Error).message });
      return;
    }
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err, failure: `${runtime} ${argv[0]} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err, failure: (e as Error).message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** Names of containers the runtime still knows about matching `--filter name=<prefix>` (running or stopped). */
export async function listContainersByPrefix(prefix: string, runtime: string = CONTAINER_RUNTIME): Promise<string[]> {
  const res = await runRuntime(runtime, ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}|{{.Status}}"]);
  if (res.failure) throw new Error(`cannot list containers: ${res.failure}`);
  return res.out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Stop and remove a container by name, then confirm it is gone.
 *
 * The confirmation is the whole point (found live, #247/#251): `podman rm -f` issued while a container is
 * still in the `starting`/`Stopping` state returns before the corpse is reaped, so a fire-and-forget removal
 * reports success and leaves an attributable-but-unswept container behind. So: force-remove, poll for
 * absence, retry the remove a couple of times, and return the error rather than swallowing it.
 */
export async function removeContainer(name: string, runtime: string = CONTAINER_RUNTIME, { attempts = 3, settleMs = 400 } = {}): Promise<string | null> {
  let lastErr: string | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await runRuntime(runtime, ["rm", "-f", "--time", "0", name]);
    lastErr = res.failure ?? (res.code === 0 ? null : `removal of ${name} failed (${res.code}): ${(res.err || res.out).trim().slice(0, 200)}`);
    // A container that never existed is as gone as one we just deleted.
    if (await waitForContainerGone(name, runtime, settleMs * 10)) return null;
    await new Promise((r) => setTimeout(r, settleMs));
  }
  return lastErr ?? `container ${name} still present after ${attempts} removal attempts`;
}

/** Poll until the runtime no longer lists `name`. Returns true as soon as it is absent. */
export async function waitForContainerGone(name: string, runtime: string = CONTAINER_RUNTIME, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await runRuntime(runtime, ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], 10_000);
    if (res.failure) return false;
    const found = res.out.split("\n").map((l) => l.trim()).filter((l) => l === name);
    if (found.length === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Run one command in a container and return its result. Never throws for a non-zero exit — that is data
 * (a red suite), not a fault. Throws only for a containment violation from `policy`.
 *
 * The container is guaranteed gone on every path: `--rm` covers normal exit, the timeout path stops it
 * before detaching, and a spawn failure means there was nothing to clean. This is the property #251 was
 * filed for, so it is asserted in test/verification-sandbox-live.test.mjs against a real runtime rather
 * than trusted.
 */
export async function runInContainer(o: ContainerRunOptions): Promise<ContainerRunResult> {
  const network = o.network ?? "none";
  const envAllowlist = o.envAllowlist ?? [];
  const runtime = o.runtime ?? CONTAINER_RUNTIME;
  if (o.policy) validateSandboxSpec({ image: o.image, workspace: o.workspace, ...o.policy });

  const name = `${o.namePrefix}${Date.now()}-${randomBytes(3).toString("hex")}`;
  const args = containerRunArgs({ name, workspace: o.workspace, image: o.image, argv: o.argv, network, envAllowlist });

  return await new Promise<ContainerRunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(runtime, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ exitCode: null, output: "", timedOut: false, spawnError: `could not start ${runtime}: ${(e as Error).message}`, containerName: name });
      return;
    }

    let out = "";
    let errOut = "";
    const cap = (s: string) => (s.length > MAX_OUTPUT_CHARS ? s.slice(-MAX_OUTPUT_CHARS) : s);
    child.stdout?.on("data", (d) => (out = cap(out + d)));
    child.stderr?.on("data", (d) => (errOut = cap(errOut + d)));

    let timedOut = false;
    let cleanup: Promise<string | null> | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // Killing the client does not stop the container (that was #251), so remove it by name too. Kept as a
      // promise and awaited before resolving, because "we asked podman to remove it" is not the same claim
      // as "it is gone".
      cleanup = removeContainer(name, runtime);
    }, o.timeoutSecs * 1000);

    const finish = (r: ContainerRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.on("error", (e) => {
      // ENOENT here means the runtime binary is missing — an infrastructure failure the caller must be
      // able to tell apart from a failing test suite.
      void removeContainer(name, runtime);
      finish({ exitCode: null, output: "", timedOut: false, spawnError: `${runtime}: ${(e as Error).message}`, containerName: name });
    });

    child.on("close", (code) => {
      const output = out + (errOut ? `\n${errOut}` : "");
      // On the timeout path, do not report until removal is proven — otherwise the caller's own sweep check
      // races the runtime and sees a container we already decided to delete (observed live as `Stopping`).
      const settle = async () => {
        const cleanupError = cleanup ? await cleanup : null;
        if (cleanupError) console.error(`[factory.container] ${cleanupError}`);
        if (timedOut) {
          finish({ exitCode: null, output, timedOut: true, containerName: name, ...(cleanupError ? { cleanupError } : {}) });
          return;
        }
        finish({ exitCode: code ?? 1, output, timedOut: false, containerName: name, ...(cleanupError ? { cleanupError } : {}) });
      };
      void settle();
    });
  });
}
