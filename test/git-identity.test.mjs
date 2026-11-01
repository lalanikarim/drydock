// Commit identity for factory-authored commits (#87).
//   node --experimental-strip-types --test test/git-identity.test.mjs
//
// Provenance: worker commits were configured as `factory-worker <factory-worker@localhost>`.
// The pull request was authored by the App, but the commits — what `git log`, mirrors and
// archives actually read — were authored by a string that resolves to nobody. GitHub's branch
// ruleset reports require_extra_approval_for_unattributed_changes, and an email belonging to no
// account is exactly "unattributed". The fix derives the identity from the credential in use;
// these checks pin the derivation, the override rules, and that no deployment-specific identity
// crept back into committed files.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  defaultAppSlugResolver,
  resolveGitIdentity,
  gitIdentityOverride,
  noreplyEmailFor,
  isResolvableGithubIdentity,
} from "../factory/git-identity.ts";

const BOT_USER = { id: 350801583, login: "drydock-factory[bot]" };

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => body });
}

/** Route-keyed fake: answers per URL path so multi-call derivations can be scripted. */
function routeFetch(routes) {
  const seen = [];
  const impl = async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const hit = routes[path] ?? { ok: false, status: 404, body: {} };
    return { ok: hit.ok ?? true, status: hit.status ?? 200, json: async () => hit.body ?? {} };
  };
  return { impl, seen };
}

const boomFetch = async () => {
  throw new Error("network must not be used when an override is configured");
};

test("a user-scoped token yields its own account", async () => {
  const id = await resolveGitIdentity({ env: {}, token: "ghu_user", fetchImpl: fakeFetch(BOT_USER) });
  assert.equal(id.name, "drydock-factory[bot]");
  assert.equal(id.email, "350801583+drydock-factory[bot]@users.noreply.github.com");
  assert.ok(isResolvableGithubIdentity(id.email), "derived email must resolve to an account");
});

// The regression this test exists for: the first implementation asked only `GET /user`, which an
// installation token cannot read (401) unless the App holds user read permission. Every fake in the
// file answered /user successfully, so the shipped code passed its suite and then faulted the first
// real run. This test scripts the actual API shape.
test("an installation token is refused by /user — identity comes from app metadata instead", async () => {
  const { impl, seen } = routeFetch({
    "/user": { ok: false, status: 401, body: { message: "Bad credentials" } },
    "/users/drydock-factory%5Bbot%5D": { body: BOT_USER },
  });
  const id = await resolveGitIdentity({
    env: {},
    token: "ghs_installation_token",
    fetchImpl: impl,
    appSlug: async () => "drydock-factory",
  });
  assert.equal(id.name, "drydock-factory[bot]");
  assert.equal(id.email, "350801583+drydock-factory[bot]@users.noreply.github.com");
  assert.ok(isResolvableGithubIdentity(id.email));
  assert.deepEqual(seen, ["/user", "/users/drydock-factory%5Bbot%5D"], "must try /user once, then the bot account");
});

test("GITHUB_APP_SLUG short-circuits app-metadata derivation", async () => {
  const { impl, seen } = routeFetch({
    "/user": { ok: false, status: 401, body: {} },
    "/users/drydock-factory%5Bbot%5D": { body: BOT_USER },
  });
  const id = await resolveGitIdentity({ env: { GITHUB_APP_SLUG: "drydock-factory" }, token: "ghs_x", fetchImpl: impl });
  assert.equal(id.name, "drydock-factory[bot]");
  assert.ok(!seen.includes("/app"), "the slug hint must not require minting an App JWT");
});

test("defaultAppSlugResolver: no App configured and no hint means no slug, and no network", async () => {
  const boom = async () => {
    throw new Error("must not be called");
  };
  assert.equal(await defaultAppSlugResolver({}, boom), null);
  assert.equal(await defaultAppSlugResolver({ GITHUB_APP_SLUG: "my-app" }, boom), "my-app");
  assert.equal(await defaultAppSlugResolver({ GITHUB_APP_SLUG: "my-app[bot]" }, boom), "my-app");
});

test("derivation failure names both routes so an operator knows what to set", async () => {
  await assert.rejects(
    () => resolveGitIdentity({ env: {}, token: "ghs_x", fetchImpl: fakeFetch({}, { ok: false, status: 401 }) }),
    /GET \/user returned HTTP 401.*no App is configured.*FACTORY_GIT_NAME/s,
  );
});

test("a PAT-derived human identity is also resolvable", async () => {
  const id = await resolveGitIdentity({ env: {}, token: "ghp_human", fetchImpl: fakeFetch({ id: 1, login: "octocat" }) });
  assert.equal(id.email, "1+octocat@users.noreply.github.com");
});

test("explicit overrides win and no network call is made", async () => {
  const id = await resolveGitIdentity({
    env: { FACTORY_GIT_NAME: "ci-bot[bot]", FACTORY_GIT_EMAIL: "999+ci-bot[bot]@users.noreply.github.com" },
    token: "ghs_ignored",
    fetchImpl: boomFetch,
  });
  assert.deepEqual(id, { name: "ci-bot[bot]", email: "999+ci-bot[bot]@users.noreply.github.com" });
});

test("a half-set override is an error, not a silent partial identity", () => {
  assert.throws(() => gitIdentityOverride({ FACTORY_GIT_NAME: "solo-name" }), /incomplete/);
  assert.throws(() => gitIdentityOverride({ FACTORY_GIT_EMAIL: "1+x@users.noreply.github.com" }), /incomplete/);
  // The .env shape that does this by accident: a name with an empty email.
  assert.throws(() => gitIdentityOverride({ FACTORY_GIT_NAME: "solo-name", FACTORY_GIT_EMAIL: "   " }), /incomplete/);
});

test("no override and no credential fails loudly instead of inventing an author", async () => {
  await assert.rejects(() => resolveGitIdentity({ env: {}, token: "", fetchImpl: boomFetch }), /cannot resolve a git identity/);
});

test("a failed lookup says what to do rather than falling back", async () => {
  await assert.rejects(
    () => resolveGitIdentity({ env: {}, token: "ghs_bad", fetchImpl: fakeFetch({}, { ok: false, status: 401 }) }),
    /GET \/user returned HTTP 401[\s\S]*FACTORY_GIT_NAME/,
  );
  await assert.rejects(
    () => resolveGitIdentity({ env: {}, token: "ghs_x", fetchImpl: fakeFetch({ login: "no-id" }) }),
    /no login\/id/,
  );
});

test("the old placeholder is recognizably unresolvable", () => {
  assert.equal(isResolvableGithubIdentity("factory-worker@localhost"), false);
  assert.equal(isResolvableGithubIdentity(""), false);
  assert.equal(isResolvableGithubIdentity("no-at-sign"), false);
  assert.equal(isResolvableGithubIdentity("x@example"), false, "a domain with no TLD resolves to nobody");
  assert.equal(isResolvableGithubIdentity("someone@example.com"), true);
});

test("noreplyEmailFor builds GitHub's linking address", () => {
  assert.equal(noreplyEmailFor(BOT_USER), "350801583+drydock-factory[bot]@users.noreply.github.com");
});

// --- provenance guards: no deployment identity in committed files -------------------------------

test(".env.example documents the variables without carrying a real identity", () => {
  const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(env, /^FACTORY_GIT_NAME=$/m, "template must leave the name empty");
  assert.match(env, /^FACTORY_GIT_EMAIL=$/m, "template must leave the email empty");
  assert.doesNotMatch(env, /[0-9]+\+[^\s]*@users\.noreply\.github\.com/, "no real noreply address in the template");
});

test("the source module hardcodes no bot id or account name", () => {
  const src = readFileSync(new URL("../factory/git-identity.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /[0-9]{6,}/, "no numeric user id baked into the resolver");
  assert.doesNotMatch(src, /drydock-factory/, "no account name baked into the resolver");
});
