// #3b / decision B1-rev: GitHub App authentication for the factory.
//   node --experimental-strip-types --test test/github-app-auth.test.mjs
//
// The properties worth proving: the JWT is real RS256 signed by the configured key; installation
// tokens are cached and refreshed rather than snapshotted (they expire ~hourly and a factory
// outlives that); concurrent callers share one exchange (GitHub revokes the oldest past ~10 active
// tokens); precedence matches what boot logs; and no error message or description ever carries
// token material.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  mintAppJwt,
  createInstallationTokenProvider,
  createGitAuth,
  gitAuthFromToken,
  gitAuthEnv,
  cloneUrlWithAuth,
  readAppConfig,
  TOKEN_EXPIRY_MARGIN_SECS,
} = await import("../factory/github-auth.ts");

const ws = mkdtempSync(join(tmpdir(), "appauth-"));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPath = join(ws, "app.pem");
writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });

const CFG = { appId: "5557270", privateKeyPath: keyPath, installationId: "177271737" };

function decode(jwt) {
  const [h, c] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(c, "base64url").toString()) };
}

test("the App JWT is a real RS256 signature over the configured key", () => {
  const jwt = mintAppJwt(CFG);
  const { header, claims } = decode(jwt);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(claims.iss, CFG.appId);

  const [h, c] = jwt.split(".");
  const sig = Buffer.from(jwt.split(".")[2], "base64url");
  const verifier = createVerify("RSA-SHA256").update(`${h}.${c}`);
  assert.ok(verifier.verify(publicKey, sig), "signature must verify against the public half");

  // GitHub rejects tokens issued more than 60 s in the future or valid beyond 10 minutes.
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.iat <= now && claims.iat >= now - 61, "iat is skewed 60s early for clock tolerance");
  assert.ok(claims.exp - claims.iat <= 600, `validity ${claims.exp - claims.iat}s must stay within GitHub's 10 minute ceiling`);
});

test("a missing key file fails with the path, never the key material", () => {
  assert.throws(
    () => mintAppJwt({ ...CFG, privateKeyPath: join(ws, "nope.pem") }),
    (e) => /not found at .*nope\.pem/.test(e.message) && !/BEGIN.*PRIVATE/.test(e.message),
  );
});

/** Fake GitHub token endpoint with controllable clock and call accounting. */
function fakeExchange({ expiresInSeconds = 3600, failWith = null } = {}) {
  let now = Math.floor(Date.now() / 1000);
  const state = { calls: 0, seenAuthorization: [] };
  const fetchImpl = async (url, init) => {
    state.calls += 1;
    state.seenAuthorization.push(init?.headers?.Authorization ?? "");
    if (failWith) return { status: failWith.status, text: async () => JSON.stringify(failWith.body ?? {}) };
    const token = `ghs_${"tok".repeat(8)}${state.calls}`;
    return {
      status: 201,
      text: async () => JSON.stringify({ token, expires_at: new Date((now + expiresInSeconds) * 1000).toISOString() }),
    };
  };
  const provider = createInstallationTokenProvider(CFG, { fetchImpl, nowSecs: () => now });
  return { provider, state, advance: (secs) => { now += secs; } };
}

test("tokens are cached — one exchange serves many requests", async () => {
  const { provider, state } = fakeExchange();
  const a = await provider.token();
  const b = await provider.token();
  const c = await provider.token();
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(state.calls, 1, "a still-valid token must be reused, not re-minted");
  assert.equal(provider.mints, 1);
});

test("the token is refreshed before it expires, not after", async () => {
  const { provider, state, advance } = fakeExchange({ expiresInSeconds: 3600 });
  const first = await provider.token();
  advance(3600 - TOKEN_EXPIRY_MARGIN_SECS - 1);
  assert.equal(await provider.token(), first, "still inside the margin window");
  assert.equal(state.calls, 1);

  advance(2); // now inside the refresh margin
  const second = await provider.token();
  assert.notEqual(second, first, "a token approaching expiry must be replaced before a request fails on it");
  assert.equal(state.calls, 2);
});

test("concurrent callers share one in-flight exchange", async () => {
  // GitHub caps active installation tokens and revokes the oldest past that limit, so five parallel
  // tool calls must not become five mints.
  const { provider, state } = fakeExchange();
  const tokens = await Promise.all(Array.from({ length: 5 }, () => provider.token()));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(state.calls, 1);
});

test("failures name the installation and the likely cause; a failed mint is not cached", async () => {
  const { provider, state } = fakeExchange({ failWith: { status: 404, body: { message: "Not Found" } } });
  await assert.rejects(() => provider.token(), (e) => {
    assert.match(e.message, /installation 177271737/);
    assert.match(e.message, /HTTP 404/);
    assert.match(e.message, /check GITHUB_APP_INSTALLATION_ID/);
    return true;
  });
  assert.equal(provider.mints, 0);
  // And a later success still works (no poisoned cache):
  const ok = fakeExchange();
  assert.ok((await ok.provider.token()).startsWith("ghs_"));
  assert.ok(state.calls >= 1);
});

test("a token never appears in an error message, even if the API echoes one", async () => {
  const secretish = `ghs_${"leak".repeat(12)}`;
  const fetchImpl = async () => ({ status: 401, text: async () => JSON.stringify({ message: "bad", token: secretish }) });
  const provider = createInstallationTokenProvider(CFG, { fetchImpl });
  await assert.rejects(() => provider.token(), (e) => {
    assert.ok(!e.message.includes(secretish), `token leaked into the error text: ${e.message}`);
    assert.match(e.message, /JWT rejected/);
    return true;
  });
});

test("readAppConfig: absent is null, partial is an error (never a silent keychain fallback)", () => {
  assert.equal(readAppConfig({}), null);
  assert.throws(
    () => readAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" }),
    /incomplete.*missing: GITHUB_APP_INSTALLATION_ID/s,
  );
  assert.deepEqual(readAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem", GITHUB_APP_INSTALLATION_ID: "2" }), {
    appId: "1",
    privateKeyPath: "/k.pem",
    installationId: "2",
  });
});

const APP_ENV = { GITHUB_APP_ID: CFG.appId, GITHUB_APP_PRIVATE_KEY_PATH: keyPath, GITHUB_APP_INSTALLATION_ID: CFG.installationId };

test("precedence: env token > App > config token, and the description says which", () => {
  const withEnv = createGitAuth({ ...APP_ENV, FACTORY_GITHUB_TOKEN: "ghp_env" });
  assert.equal(withEnv.kind, "pat");
  // The shadow note matters: "we use the App" being quietly untrue is the failure this records.
  assert.match(withEnv.describe(), /FACTORY_GITHUB_TOKEN from environment/);
  assert.match(withEnv.describe(), /GitHub App is configured but this takes precedence/);

  const app = createGitAuth({ ...APP_ENV });
  assert.equal(app.kind, "app");
  assert.match(app.describe(), /GitHub App 5557270 \(installation 177271737\)/);
  assert.ok(!app.describe().includes("ghs_"), "describe() is log-safe");

  const cfg = createGitAuth({}, "ghp_config");
  assert.equal(cfg.kind, "pat");
  assert.match(cfg.describe(), /gitToken/);
});

test("no factory credential resolves to the host-helper path and stays loud about it", async () => {
  // GIT_CONFIG_NOSYSTEM + an empty HOME hide this machine's osxkeychain entry, so the assertion is
  // about the resolution logic rather than the host it happens to run on.
  const auth = createGitAuth({ PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: join(ws, "no-home") });
  assert.equal(auth.kind, "none");
  assert.equal(auth.kind === "app" || auth.kind === "pat", false, "must not invent a credential");
  assert.equal(await auth.token(), "", "empty token means git resolves it its own way");
});

test("partial App config throws instead of downgrading to the keychain", () => {
  assert.throws(() => createGitAuth({ GITHUB_APP_ID: "1" }), /incomplete/);
});

test("child-process env and clone URLs carry the current token, not a stale one", async () => {
  const { provider, advance } = fakeExchange({ expiresInSeconds: 3600 });
  const auth = { kind: "app", token: () => provider.token(), describe: () => "app" };
  const first = (await gitAuthEnv(auth)).GH_TOKEN;
  assert.match(first, /^ghs_/);

  const url = await cloneUrlWithAuth(auth, "octo/private-repo");
  assert.equal(url, `https://x-access-token:${first}@github.com/octo/private-repo.git`);

  advance(3600); // force a refresh
  const second = (await gitAuthEnv(auth)).GH_TOKEN;
  assert.notEqual(second, first, "env is built per call so a long-lived process never uses an expired token");

  const bare = await cloneUrlWithAuth(gitAuthFromToken(""), "octo/public-repo");
  assert.equal(bare, "https://github.com/octo/public-repo.git", "no credential → unauthenticated URL");
});

test("gitAuthFromToken keeps legacy callers working", async () => {
  const auth = gitAuthFromToken("ghp_legacy");
  assert.equal(auth.kind, "pat");
  assert.equal(await auth.token(), "ghp_legacy");
  assert.equal((await gitAuthFromToken(undefined).token()), "");
});


