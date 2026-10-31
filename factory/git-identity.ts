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
// This makes attribution honest, NOT provenance verified: commits remain unsigned, and no claim
// of verified commits follows from this file (#87 excludes signing deliberately).

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

/**
 * Resolve the identity factory commits should carry.
 *
 *   1. explicit `FACTORY_GIT_NAME` / `FACTORY_GIT_EMAIL` (both required if either is set);
 *   2. otherwise the account behind the current credential, via `GET /user` — for an App
 *      installation token that is the App's bot user (`drydock-factory[bot]`), for a PAT it is
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
}): Promise<GitIdentity> {
  const override = gitIdentityOverride(opts.env ?? process.env);
  if (override) return override;

  if (!opts.token) {
    throw new Error(
      "cannot resolve a git identity: no credential to derive it from and FACTORY_GIT_NAME/FACTORY_GIT_EMAIL are unset. " +
        "Set both variables, or run with a GitHub credential so commits can be attributed.",
    );
  }

  const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`cannot resolve a git identity: GET /user failed (${(e as Error).message}). ` +
      "Set FACTORY_GIT_NAME and FACTORY_GIT_EMAIL to attribute factory commits.");
  }
  if (!res.ok) {
    throw new Error(`cannot resolve a git identity: GET /user returned HTTP ${res.status}. ` +
      "Set FACTORY_GIT_NAME and FACTORY_GIT_EMAIL to attribute factory commits.");
  }

  const user = (await res.json()) as { id?: number | string; login?: string };
  if (!user?.login || user.id === undefined || user.id === null) {
    throw new Error("cannot resolve a git identity: GET /user returned no login/id.");
  }
  return { name: user.login, email: noreplyEmailFor({ id: user.id, login: user.login }) };
}
