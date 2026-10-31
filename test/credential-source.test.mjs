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
