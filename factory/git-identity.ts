// Git identity for factory-authored commits (#87).
//
// The *pull request* author is the App, because the App creates it through the API. The
// *commit* author is whatever this resolves, and it used to be `factory-worker` /
// `factory-worker@localhost` — an address that resolves to nobody. Two consequences: every
// factory commit read as "unattributed" (the branch ruleset asks for an extra approval for
// exactly that case), and `git log` answered "who wrote this?" with a placeholder. Factory work
// was distinguishable at the PR level and anonymous one level down, which is the level mirrors
// and archives actually read.
//
// The identity is therefore DERIVED from the credential that is actually in use — the same
// principal that opens the pull request authors its commits — instead of being configured with
// a copy-pasted bot id or invented by a default. Overrides exist for the cases where an operator
// wants commits attributed to something else, and are checked for completeness rather than
// trusted half-set.
//
// Derivation takes two steps because one step does not fit both credential kinds: `GET /user`
// answers for a PAT, but an installation token is scoped to the App's repository permissions and is
// refused 401 unless the App was granted user read. The fallback therefore resolves the App's own bot
// account from app metadata (`/app` with the App JWT, or `GITHUB_APP_SLUG`, then the public
// `/users/<slug>[bot]`). The first version assumed `/user` always worked and the first issue
// dispatched after it shipped faulted worker preparation with exactly that 401 — injected fetches in
// tests had covered every path except the one that mattered.
//
// This makes attribution honest, NOT provenance verified: commits remain unsigned, and no claim
// of verified commits follows from this file (#87 excludes signing deliberately).

import { mintAppJwt, readAppConfig } from "./github-auth.ts";

export type GitIdentity = { name: string; email: string };

/** GitHub's noreply form, which is what links a commit to an account. */
export function noreplyEmailFor(user: { id: number | string; login: string }): string {
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

/** True when an email can resolve to a GitHub account (noreply form or any real address). */
export function isResolvableGithubIdentity(email: string): boolean {
  if (/^[0-9]+\+[^@]+@users\.noreply\.github\.com$/.test(email)) return true;
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = email.slice(at + 1);
  // A localhost/TLD-less domain is how the old placeholder read: syntactically an address,
  // resolvable to nobody.
  return domain.includes(".") && !domain.endsWith(".localhost");
}

/**
 * Explicit operator override from the environment. Returns null when nothing is configured.
 * A half-set override throws: `FACTORY_GIT_NAME` with no email (or a blank one, which `.env`
 * produces all by itself) would silently produce an author that resolves to nobody — the exact
 * bug this module exists to fix, so it must fail rather than half-work.
 */
export function gitIdentityOverride(env: Record<string, string | undefined> = process.env): GitIdentity | null {
  const name = env.FACTORY_GIT_NAME?.trim() ?? "";
  const email = env.FACTORY_GIT_EMAIL?.trim() ?? "";
  if (!name && !email) return null;
  if (!name || !email) {
    throw new Error(
      `git identity override is incomplete: set BOTH FACTORY_GIT_NAME and FACTORY_GIT_EMAIL, or neither ` +
        `(got name=${name ? "set" : "unset"}, email=${email ? "set" : "unset"}).`,
    );
  }
  return { name, email };
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const API = "https://api.github.com";

async function getJson(doFetch: FetchLike, url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: any } | null> {
  try {
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return null; // a network failure is "could not derive", decided by the caller
  }
}

/**
 * The App's own bot login (`<slug>[bot]`), without needing a user-scoped token.
 *
 * Why this exists at all: `GET /user` answers with the App's bot user only when the App was granted
 * user read permission. Most installations — including this deployment's App — have none, so an
 * installation token gets 401 on `/user` and identity derivation must come from app metadata instead.
 * Found by running it: the first issue after #87 shipped faulted worker preparation exactly this way.
 */
export async function defaultAppSlugResolver(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): Promise<string | null> {
  const hint = env.GITHUB_APP_SLUG?.trim();
  if (hint) return hint.endsWith("[bot]") ? hint.slice(0, -"[bot]".length) : hint;
  try {
    const cfg = readAppConfig(env);
    if (!cfg) return null;
    const doFetch: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await getJson(doFetch, `${API}/app`, { authorization: `Bearer ${mintAppJwt(cfg)}`, accept: "application/vnd.github+json" });
    const slug = res?.ok ? (res.body?.slug ?? null) : null;
    return typeof slug === "string" && slug ? slug : null;
  } catch {
    return null; // no App configured, or the key/JWT failed — caller falls through to an error message
  }
}

/**
 * Resolve the identity factory commits should carry.
 *
 *   1. explicit `FACTORY_GIT_NAME` / `FACTORY_GIT_EMAIL` (both required if either is set);
 *   2. otherwise the account behind the current credential, via `GET /user` — for an App
 *      installation token that is the App's bot user (`<slug>[bot]`), for a PAT it is
 *      the human owner; either way the noreply address links the commit to that account.
 *
 * Throws when neither is available. There is deliberately no fallback identity: inventing one is
 * what made every factory commit unattributed in the first place, and a run that cannot say who
 * authored it should stop rather than guess.
 */
export async function resolveGitIdentity(opts: {
  env?: Record<string, string | undefined>;
  token?: string;
  fetchImpl?: FetchLike;
  /** Injectable so tests never need a private key; production resolves via the App JWT. */
  appSlug?: () => Promise<string | null>;
}): Promise<GitIdentity> {
  const env = opts.env ?? process.env;
  const override = gitIdentityOverride(env);
  if (override) return override;

  if (!opts.token) {
    throw new Error(
      "cannot resolve a git identity: no credential to derive it from and FACTORY_GIT_NAME/FACTORY_GIT_EMAIL are unset. " +
        "Set both variables, or run with a GitHub credential so commits can be attributed.",
    );
  }

  const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);

  // 1. Ask the token who it is. Works for PATs and for Apps granted user read permission.
  const me = await getJson(doFetch, `${API}/user`, {
    authorization: `Bearer ${opts.token}`,
    accept: "application/vnd.github+json",
  });
  if (me?.ok && (typeof me.body?.login !== "string" || me.body?.id === undefined || me.body?.id === null)) {
    throw new Error("cannot resolve a git identity: GET /user returned no login/id.");
  }
  if (me?.ok && typeof me.body?.login === "string" && me.body?.id !== undefined && me.body?.id !== null) {
    return { name: me.body.login, email: noreplyEmailFor({ id: me.body.id, login: me.body.login }) };
  }

  // 2. Installation-token case: resolve the App's bot account from app metadata instead.
  const resolveSlug = opts.appSlug ?? (() => defaultAppSlugResolver(env, doFetch));
  const slug = await resolveSlug().catch(() => null);
  if (slug) {
    const login = slug.endsWith("[bot]") ? slug : `${slug}[bot]`;
    // Public endpoint; the bot user of an app is readable without a token.
    const bot = await getJson(doFetch, `${API}/users/${encodeURIComponent(login)}`, { accept: "application/vnd.github+json" });
    if (bot?.ok && Number.isInteger(bot.body?.id)) {
      return { name: login, email: noreplyEmailFor({ id: bot.body.id, login }) };
    }
  }

  throw new Error(
    `cannot resolve a git identity: GET /user returned HTTP ${me?.status ?? "no response"}` +
      (slug ? ` and the App bot account ${slug}[bot] could not be read` : ", and no App is configured to derive a bot account from") +
      ". Set FACTORY_GIT_NAME and FACTORY_GIT_EMAIL (both) in .env to attribute factory commits.",
  );
}
