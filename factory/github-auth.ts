// GitHub App authentication for the factory (decision B1-rev, queue item 3b).
//
// Why a provider and not a token: an installation token expires after ~1 hour and cannot be
// renewed. A factory instance is long-lived and a single issue can burn 30 minutes of wall clock, so
// minting once at boot would fail mid-run — the worst kind of failure, because it looks like the
// credential broke. Instead every use site asks for a token and the provider hands out a cached one
// until it is close to expiry, then mints a fresh one (deduplicating concurrent requests).
//
// Precedence, and why: FACTORY_GITHUB_TOKEN first (an explicit per-run override should never be
// shadowed by configuration), then the App when all three GITHUB_APP_* variables are present, then
// per-repo config `gitToken`, then whatever the host's git helper would supply. The chosen kind is
// logged at boot by factory/credential-source.ts; when an env token shadows a configured App that
// log says so explicitly, because "we use the App" being quietly untrue is the failure this closes.
//
// Secret handling: tokens are returned to callers and never logged, never written to disk, and never
// placed in a URL that outlives a single git invocation. The PEM is read on each mint (so rotation
// takes effect without a restart) and its contents never appear in any error message.

import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  describeCredentialSource,
  detectAppConfig,
  resolveCredentialSource,
  type AppEnvConfig,
  type CredentialSource,
} from "./credential-source.ts";

const API = "https://api.github.com";

/** Refresh this many seconds before the reported expiry, so a token cannot expire mid-request. */
export const TOKEN_EXPIRY_MARGIN_SECS = 300;

/** Parsing lives in credential-source.ts so the boot log and the token source share one answer. */
export type GitHubAppConfig = AppEnvConfig;

/** Read GITHUB_APP_* from an environment (null when not configured; throws when partial). */
export function readAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  return detectAppConfig(env);
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * Mint the App's own JWT: RS256, issued 60 s early to tolerate clock skew, valid at most 10 minutes
 * (GitHub's ceiling). `nowSecs` is injectable for tests.
 */
export function mintAppJwt(cfg: GitHubAppConfig, nowSecs = Math.floor(Date.now() / 1000)): string {
  if (!existsSync(cfg.privateKeyPath)) {
    throw new Error(`GitHub App private key not found at ${cfg.privateKeyPath} (GITHUB_APP_PRIVATE_KEY_PATH)`);
  }
  const key = readFileSync(cfg.privateKeyPath, "utf8");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: nowSecs - 60, exp: nowSecs + 9 * 60, iss: cfg.appId }));
  const signingInput = `${header}.${claims}`;
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(signingInput).sign(key);
  } catch (e) {
    // Name the failure without echoing anything about the key material itself.
    throw new Error(`could not sign the GitHub App JWT with ${cfg.privateKeyPath}: ${(e as Error).message.split("\n")[0]}`);
  }
  return `${signingInput}.${b64url(signature)}`;
}

export interface TokenProvider {
  /** A valid installation token, minted or refreshed as needed. */
  token(): Promise<string>;
  /** Human description safe for logs — never contains token material. */
  describe(): string;
  /** Number of successful exchanges performed (observable in tests and boot diagnostics). */
  readonly mints: number;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export interface ProviderOptions {
  fetchImpl?: FetchLike;
  nowSecs?: () => number;
}

/**
 * Exchange the App JWT for an installation token, cached until close to expiry.
 *
 * GitHub caps active installation tokens (~10, oldest revoked past that), so concurrent callers must
 * share one in-flight exchange rather than each minting their own.
 */
export function createInstallationTokenProvider(cfg: GitHubAppConfig, opts: ProviderOptions = {}): TokenProvider {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init as never) as never);
  const now = opts.nowSecs ?? (() => Math.floor(Date.now() / 1000));

  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  let mints = 0;

  async function exchange(): Promise<string> {
    const jwt = mintAppJwt(cfg, now());
    const url = `${API}/app/installations/${cfg.installationId}/access_tokens`;
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "drydock-factory",
        "Content-Type": "application/json",
        // Unique per attempt so a stuck request is identifiable in GitHub's request logs.
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: "{}",
    });
    const text = await res.text();
    if (res.status !== 201) {
      // Common causes, named, because the raw payload rarely says it plainly:
      //   401 → JWT rejected (wrong GITHUB_APP_ID for this key, or clock skew beyond tolerance)
      //   403 → installation not accessible to this app / insufficient permission acceptance
      //   404 → wrong GITHUB_APP_INSTALLATION_ID
      throw new Error(
        `GitHub App installation token exchange failed for installation ${cfg.installationId} (HTTP ${res.status}): ${classifyExchangeFailure(res.status)} ${redact(text).slice(0, 200)}`,
      );
    }
    let body: { token?: string; expires_at?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`GitHub App token response was not JSON (installation ${cfg.installationId})`);
    }
    if (!body.token) throw new Error(`GitHub App token response contained no token (installation ${cfg.installationId})`);
    const expiresAt = body.expires_at ? Math.floor(new Date(body.expires_at).getTime() / 1000) : now() + 3600;
    cached = { token: body.token, expiresAt };
    mints += 1;
    return body.token;
  }

  return {
    async token() {
      const fresh = cached && cached.expiresAt - now() > TOKEN_EXPIRY_MARGIN_SECS;
      if (fresh) return cached!.token;
      if (inflight) return inflight;
      inflight = exchange().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    describe() {
      return `GitHub App ${cfg.appId} (installation ${cfg.installationId})`;
    },
    get mints() {
      return mints;
    },
  };
}

function classifyExchangeFailure(status: number): string {
  if (status === 401) return "(JWT rejected — check that GITHUB_APP_ID matches this key, and the host clock;)";
  if (status === 403) return "(app cannot use this installation — permissions not accepted, or installation belongs to another app;)";
  if (status === 404) return "(no such installation — check GITHUB_APP_INSTALLATION_ID;)";
  return ";";
}

/** Belt-and-braces: a token must never reach an error message, even if GitHub echoes something odd. */
function redact(text: string): string {
  return text.replace(/gh(s|u|i|o)_[A-Za-z0-9]{16,}/g, "[redacted-token]");
}

/** Which credential a factory run will use, and how to get it. `none` means git's own helper path. */
export interface GitAuth {
  kind: "app" | "pat" | "none";
  token(): Promise<string>;
  describe(): string;
}

const never = async () => "";

/**
 * Resolve the run's git credential. Precedence is documented at the top of this file; the caller
 * (factory/main.ts) logs `describe()` at boot so the choice is visible rather than inferred.
 */
export function createGitAuth(env: NodeJS.ProcessEnv = process.env, configToken?: string): GitAuth {
  const source: CredentialSource = resolveCredentialSource(env, configToken);
  const describe = () => describeCredentialSource(source);

  switch (source.kind) {
    case "env": {
      const token = env.FACTORY_GITHUB_TOKEN!;
      return { kind: "pat", token: async () => token, describe };
    }
    case "app": {
      const provider = createInstallationTokenProvider({
        appId: source.appId,
        privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH!.trim(),
        installationId: source.installationId,
      });
      return { kind: "app", token: () => provider.token(), describe };
    }
    case "config": {
      const token = configToken!;
      return { kind: "pat", token: async () => token, describe };
    }
    // host-helper / none: no factory credential. Returning "" keeps git's own resolution (or its
    // failure) in charge, and describe() is the loud part of #70.
    default:
      return { kind: "none", token: async () => "", describe };
  }
}

/** Test helper: an auth that always returns a fixed token. */
export function staticGitAuth(token: string, kind: GitAuth["kind"] = "pat"): GitAuth {
  return { kind, token: async () => token, describe: () => `static ${kind} credential` };
}


/** Back-compat shim: a bare token string (per-repo config, tests) becomes a static GitAuth. */
export function gitAuthFromToken(token?: string | null): GitAuth {
  if (!token) return { kind: "none", token: never, describe: () => "no credential provided" };
  return { kind: "pat", token: async () => token, describe: () => "static token" };
}

/**
 * Environment for a child process (gh, git-credential-less push). Resolved per call so an App token
 * is always current — this is the whole reason GitAuth is a function and not a string.
 */
export async function gitAuthEnv(auth: GitAuth): Promise<NodeJS.ProcessEnv> {
  const token = await auth.token();
  return { ...process.env, GH_TOKEN: token };
}

/**
 * Clone URL carrying the credential inline. Unavoidable for https clones of private repos, and the
 * reason prepareWorkspace scrubs the remote afterwards — a clone keeps the URL in .git/config.
 */
export async function cloneUrlWithAuth(auth: GitAuth, repo: string): Promise<string> {
  const token = await auth.token();
  return token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
}
