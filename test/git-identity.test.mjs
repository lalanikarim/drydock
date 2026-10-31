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
  resolveGitIdentity,
  gitIdentityOverride,
  noreplyEmailFor,
  isResolvableGithubIdentity,
} from "../factory/git-identity.ts";

const BOT_USER = { id: 350801583, login: "drydock-factory[bot]" };

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => body });
}

const boomFetch = async () => {
  throw new Error("network must not be used when an override is configured");
};

test("identity is derived from the credential: an App installation token yields the bot account", async () => {
  const id = await resolveGitIdentity({ env: {}, token: "ghs_installation_token", fetchImpl: fakeFetch(BOT_USER) });
  assert.equal(id.name, "drydock-factory[bot]");
  assert.equal(id.email, "350801583+drydock-factory[bot]@users.noreply.github.com");
  assert.ok(isResolvableGithubIdentity(id.email), "derived email must resolve to an account");
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
