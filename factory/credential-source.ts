// Credential posture for factory git operations (#70, decision B2).
//
// The failure this exists for: with no explicit token configured, clone and push do not fail —
// git silently asks the host's credential helper, and on a developer machine that helper usually
// holds an ACCOUNT-WIDE credential. "Which credential did the factory use?" then has no answer in
// config or logs, only in the machine's keychain. B2's decision: never silent, never fatal — the
// process starts, but it names the credential path at boot.
//
// The resolution order IS the implementation (factory/github-auth.ts calls this and builds its token
// source from the answer), so the boot log and the credential in use cannot disagree:
//   1. FACTORY_GITHUB_TOKEN env var — an explicit per-run override is never shadowed by config
//   2. GitHub App (GITHUB_APP_ID + _PRIVATE_KEY_PATH + _INSTALLATION_ID) — decision B1-rev
//   3. per-repo config `gitToken`
//   4. host git credential helper(s), if any are configured
//   5. nothing — private repos will fail to clone, and that is the loud failure we want

import { execFileSync } from "node:child_process";

export type CredentialSource =
  | { kind: "env"; variable: string; appShadowed?: boolean }
  | { kind: "app"; appId: string; installationId: string }
  | { kind: "config"; field: "gitToken"; appShadowed?: boolean }
  | { kind: "host-helper"; helpers: Array<{ origin: string; helper: string }>; appShadowed?: boolean }
  | { kind: "none" };

/** Parsed GITHUB_APP_* — the ids only, never key material. */
export interface AppEnvConfig {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

/**
 * Read the three App variables. Absent entirely → null (not configured). Partially set → throws:
 * a half-configured App silently falling back to the account-wide keychain is exactly the failure
 * #70 was filed for, so this is a boot error rather than a downgrade.
 */
export function detectAppConfig(env: NodeJS.ProcessEnv): AppEnvConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  if (!appId && !privateKeyPath && !installationId) return null;
  const missing = [!appId && "GITHUB_APP_ID", !privateKeyPath && "GITHUB_APP_PRIVATE_KEY_PATH", !installationId && "GITHUB_APP_INSTALLATION_ID"].filter(Boolean);
  if (missing.length) {
    throw new Error(`GitHub App config is incomplete — set or unset all three; missing: ${missing.join(", ")}`);
  }
  return { appId: appId!, privateKeyPath: privateKeyPath!, installationId: installationId! };
}

/**
 * Parse `git config --show-origin --get-all credential.helper` output. Lines are
 * `<origin>\t<value>`; an empty result means no helper is configured at any level.
 */
export function parseCredentialHelpers(raw: string): Array<{ origin: string; helper: string }> {
  const out: Array<{ origin: string; helper: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue; // no origin reported — not a --show-origin line
    out.push({ origin: trimmed.slice(0, tab).trim(), helper: trimmed.slice(tab + 1).trim() });
  }
  return out;
}

/** Ask git which credential helpers this machine would actually use. */
export function detectHostCredentialHelpers(): Array<{ origin: string; helper: string }> {
  try {
    const raw = execFileSync("git", ["config", "--show-origin", "--get-all", "credential.helper"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseCredentialHelpers(raw);
  } catch {
    // git exits non-zero when the key is unset at every level — that IS the answer.
    return [];
  }
}

/**
 * Resolve which credential path factory git operations will take.
 * `hostHelpers` is injectable so tests are hermetic — CI runners have no credential helper
 * configured, and a test that asserted one would pass on a laptop and fail in the workflow.
 */
export function resolveCredentialSource(
  env: NodeJS.ProcessEnv,
  configToken?: string,
  hostHelpers: Array<{ origin: string; helper: string }> = detectHostCredentialHelpers(),
  app: AppEnvConfig | null = detectAppConfig(env),
): CredentialSource {
  // An explicit env token wins over everything — but if an App is configured too, say so: "we use
  // the App" being quietly untrue because a shell export survived from last week is the failure mode.
  if (env.FACTORY_GITHUB_TOKEN) {
    return { kind: "env", variable: "FACTORY_GITHUB_TOKEN", ...(app ? { appShadowed: true } : {}) };
  }
  if (app) return { kind: "app", appId: app.appId, installationId: app.installationId };
  if (configToken) return { kind: "config", field: "gitToken" };
  if (hostHelpers.length > 0) return { kind: "host-helper", helpers: hostHelpers };
  return { kind: "none" };
}

/** Human-readable description for boot logs. The host-helper case is the one that must be unmissable. */
export function describeCredentialSource(source: CredentialSource): string {
  const shadow = source.appShadowed ? " — NOTE: a GitHub App is configured but this takes precedence" : "";
  switch (source.kind) {
    case "env":
      return `git credential: ${source.variable} from environment${shadow}`;
    case "app":
      return `git credential: GitHub App ${source.appId} (installation ${source.installationId}) — short-lived installation tokens`;
    case "config":
      return `git credential: per-repo config field ${source.field}`;
    case "host-helper":
      return (
        `git credential: NO factory token configured — clone/push will fall back to the host ` +
        `credential helper(s): ${source.helpers.map((h) => `${h.helper} (${h.origin})`).join(", ")}. ` +
        `On a developer machine that entry is typically ACCOUNT-WIDE; scope it (decision B1) or set FACTORY_GITHUB_TOKEN.`
      );
    case "none":
      return `git credential: no factory token and no host helper configured — private repos will fail to clone`;
  }
}
