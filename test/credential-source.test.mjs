// #70 / decision B2: the factory must never silently downgrade to a host credential.
//   node --experimental-strip-types --test test/credential-source.test.mjs
//
// The resolution order mirrors factory/main.ts: env FACTORY_GITHUB_TOKEN, then per-repo config
// gitToken, then whatever the host's git would ask (credential helpers), then nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { parseCredentialHelpers, resolveCredentialSource, describeCredentialSource } from "../factory/credential-source.ts";

const osxkeychainOutput = `file:/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig\tosxkeychain`;

test("parseCredentialHelpers reads --show-origin lines and skips noise", () => {
  assert.deepEqual(parseCredentialHelpers(osxkeychainOutput), [
    { origin: "file:/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig", helper: "osxkeychain" },
  ]);
  assert.deepEqual(
    parseCredentialHelpers("file:/a\tstore\n\n# comment\nfile:/b\thelper-manager\nno-tab-line"),
    [
      { origin: "file:/a", helper: "store" },
      { origin: "file:/b", helper: "helper-manager" },
    ],
  );
  assert.deepEqual(parseCredentialHelpers(""), []);
});

test("env token wins over everything", () => {
  const source = resolveCredentialSource({ FACTORY_GITHUB_TOKEN: "ghp_x" }, "config-token");
  assert.deepEqual(source, { kind: "env", variable: "FACTORY_GITHUB_TOKEN" });
});

// A stand-in helper list so these tests assert resolution logic, not this machine's keychain.
const SOME_HOST_HELPER = [{ origin: "file:/etc/gitconfig", helper: "store" }];

test("GitHub App is chosen when configured, and named in the log line", () => {
  const appEnv = { GITHUB_APP_ID: "5557270", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem", GITHUB_APP_INSTALLATION_ID: "177271737" };
  const source = resolveCredentialSource(appEnv, "ghp_config_ignored", SOME_HOST_HELPER);
  assert.deepEqual(source, { kind: "app", appId: "5557270", installationId: "177271737" });
  const line = describeCredentialSource(source);
  assert.match(line, /GitHub App 5557270/);
  assert.match(line, /installation 177271737/);
  assert.doesNotMatch(line, /ghp_|BEGIN/, "the log line never carries secret material");
});

test("an env token still beats the App — and says that it does", () => {
  const appEnv = { FACTORY_GITHUB_TOKEN: "explicit", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem", GITHUB_APP_INSTALLATION_ID: "2" };
  const source = resolveCredentialSource(appEnv, undefined, SOME_HOST_HELPER);
  assert.equal(source.kind, "env");
  // Without this note, "the factory uses the App" becomes quietly untrue the moment a stray export
  // lands in the shell — the exact class of drift #70 was filed about.
  assert.match(describeCredentialSource(source), /GitHub App is configured but this takes precedence/);
});

test("a half-configured App is an error, not a silent downgrade to the keychain", () => {
  assert.throws(() => resolveCredentialSource({ GITHUB_APP_ID: "1" }, undefined, SOME_HOST_HELPER), /incomplete/i);
  assert.throws(() => resolveCredentialSource({ GITHUB_APP_INSTALLATION_ID: "2" }, undefined, SOME_HOST_HELPER), /GITHUB_APP_ID/);
});

test("config token is used when the env var is absent", () => {
  const source = resolveCredentialSource({}, "config-token");
  assert.deepEqual(source, { kind: "config", field: "gitToken" });
});

test("no factory token falls through to the host helper — and says so plainly", () => {
  // The osxkeychain entry is injected (this machine's real configuration per #70), not detected:
  // CI runners have no helper, and the description must be testable on both.
  const source = resolveCredentialSource({}, undefined, [{ origin: "file:/…/gitconfig", helper: "osxkeychain" }]);
  assert.equal(source.kind, "host-helper");
  const text = describeCredentialSource(source);
  assert.match(text, /NO factory token configured/);
  assert.match(text, /ACCOUNT-WIDE/);
  assert.match(text, /osxkeychain/);
});

test("no token and no host helper is reported as a hard failure to come, not a silent pass", () => {
  const source = resolveCredentialSource({}, undefined, []);
  assert.deepEqual(source, { kind: "none" });
  assert.match(describeCredentialSource(source), /private repos will fail to clone/);
});

test("live detection is consistent with its description on whatever host this is", () => {
  // Environment-dependent by design: a developer laptop has a helper, a CI runner typically does
  // not. Both branches must produce a description that matches the resolved kind — and both must
  // actually execute, since asserting only one branch hides failures from whichever machine you
  // happen to run on (this test's first version did exactly that).
  const source = resolveCredentialSource({});
  const text = describeCredentialSource(source);
  if (source.kind === "host-helper") {
    assert.ok(source.helpers.length > 0, "host-helper kind must name at least one helper");
    for (const h of source.helpers) assert.match(text, new RegExp(h.helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } else {
    assert.equal(source.kind, "none", `expected none on a helper-less host, got ${JSON.stringify(source)}`);
    assert.doesNotMatch(text, /fall back to the host credential helper/);
    assert.match(text, /no factory token and no host helper configured/);
  }
});

test("the description names the exact path for every kind", () => {
  assert.equal(describeCredentialSource({ kind: "env", variable: "FACTORY_GITHUB_TOKEN" }), "git credential: FACTORY_GITHUB_TOKEN from environment");
  assert.equal(describeCredentialSource({ kind: "config", field: "gitToken" }), "git credential: per-repo config field gitToken");
  assert.match(
    describeCredentialSource({ kind: "none" }),
    /no factory token and no host helper configured/,
  );
});
