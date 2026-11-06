// Setup-phase container (multi-repo plan §3.6), ported to TS.
//
// Some managed repos need dependencies installed before tests can run. The sealed worker sandbox runs with
// network=none, so installs happen first in a one-shot disposable container that HAS egress:
//
//   podman run --rm --network bridge -v <workspace>:/sandbox -w /sandbox <image> <setupCommand argv...>
//
// The workspace is a host-mounted volume, so node_modules (or whatever the install produces) persists after
// the container exits. The long-lived worker sandbox (owned by the core's SandboxManager) is then sealed — the
// agent never runs in a networked container. Runs are idempotent (setupCommand re-runs on task resume) and
// fail closed: any non-zero exit aborts the worker before its conversation starts.
//
// The podman invocation itself lives in factory/container.ts, which is also where the #251 fix landed: a
// timeout used to SIGKILL only the client and leave this container running with egress, untracked by any
// sweep. The shared runner stops and removes it by name.

import { runInContainer, validateSandboxSpec, type SandboxPolicy } from "./container.ts";

// Re-exported from their original module so existing importers (worker.ts, test/sandbox-allowlist.test.mjs)
// keep resolving while the implementation moves next to the other container call. `SetupPolicy` is the
// historical name for the same declaration; both stay exported rather than churning every call site.
export { validateSandboxSpec, type SandboxPolicy, type SandboxPolicy as SetupPolicy } from "./container.ts";

export async function runSetupInContainer({ workspace, image, setupCommand, timeoutSecs = 900, policy = null }: {
  workspace: string;
  image: string;
  setupCommand: string;
  timeoutSecs?: number;
  policy?: SandboxPolicy | null;
}): Promise<void> {
  // Checked here as well as inside the runner, so a policy violation never prints a "running…" line it
  // is about to contradict.
  if (policy) validateSandboxSpec({ image, workspace, ...policy });
  const argv = setupCommand.trim().split(/\s+/);
  console.log(
    `[setup] running ${setupCommand} in one-shot networked container (policy: ${policy ? "enforced" : "none declared"}, env allowlist: ${SETUP_ENV_ALLOWLIST.length} name(s))`,
  );

  const res = await runInContainer({
    workspace,
    image,
    argv,
    timeoutSecs,
    // The only egress-having factory container by design: dependency installation.
    network: "bridge",
    // Installs occasionally need a proxy/registry override; those are named explicitly rather than
    // inherited wholesale, so a setup container never sees GitHub or Telegram credentials.
    envAllowlist: SETUP_ENV_ALLOWLIST,
    policy,
    namePrefix: "factory-setup-",
  });

  // The container name is in every failure message: `podman ps -a --filter label=io.drydock.run=<name>`
  // is how an operator finds what a failed setup left behind (#251).
  const where = `container ${res.containerName}`;
  if (res.spawnError) throw new Error(`setup container could not start (${where}): ${res.spawnError}`);
  if (res.timedOut) throw new Error(`setup command timed out after ${timeoutSecs}s (${where})${res.cleanupError ? ` — ${res.cleanupError}` : ""}`);
  if (res.exitCode !== 0) throw new Error(`setup command failed (exit ${res.exitCode}, ${where}): ${res.output.trim().slice(-2000)}`);

  console.log(`[setup] setup command succeeded for ${workspace}`);
}

/**
 * Host variables a setup container may inherit, by name. Nothing else crosses the boundary — in particular
 * no `GH_TOKEN`, no `GITHUB_APP_*`, no model or Telegram keys (#247's env-scrubbing rule, applied here too).
 */
export const SETUP_ENV_ALLOWLIST: readonly string[] = [
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NPM_CONFIG_REGISTRY",
  "COREPACK_NPM_REGISTRY",
];
