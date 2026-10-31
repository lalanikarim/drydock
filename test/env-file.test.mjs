// Shared .env loading + webhook secret resolution (queue 6).
//   node --experimental-strip-types --test test/env-file.test.mjs
//
// Provenance: the supervisor did not load .env while factory/main.ts did, so starting the fleet from
// a plain shell made the adapter HMAC against the fleet file's placeholder string. Every GitHub
// delivery then failed with "invalid signature" — an error message that points at GitHub. These
// checks pin the fix and, more importantly, pin that a placeholder can never be used silently again.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadEnvFile, resolveWebhookSecret, webhookSecretVar } = await import(
  "../factory/env-file.ts"
);

const ws = mkdtempSync(join(tmpdir(), "envfile-"));

test("loadEnvFile applies KEY=value and strips one layer of quotes", () => {
  const file = join(ws, "a.env");
  writeFileSync(file, 'FOO=bar\nQUOTED="with spaces"\nSINGLE=\'s\'\n  SPACED  =  v  \n# comment\nnot a line\n');
  const env = {};
  const applied = loadEnvFile(file, env);
  assert.equal(env.FOO, "bar");
  assert.equal(env.QUOTED, "with spaces");
  assert.equal(env.SINGLE, "s");
  assert.equal(env.SPACED, "v", "surrounding whitespace trimmed");
  assert.ok(!("not a line" in env));
  assert.deepEqual(applied.sort(), ["FOO", "QUOTED", "SINGLE", "SPACED"].sort());
});

test("ambient values are never overwritten (explicit export wins over the file)", () => {
  const file = join(ws, "b.env");
  writeFileSync(file, "SECRET=from-file\n");
  const env = { SECRET: "from-shell" };
  const applied = loadEnvFile(file, env);
  assert.equal(env.SECRET, "from-shell");
  assert.deepEqual(applied, [], "nothing reported as applied");
});

test("a missing .env is not an error", () => {
  assert.deepEqual(loadEnvFile(join(ws, "nope.env"), {}), []);
});

test("webhookSecretVar names the variable per repo", () => {
  assert.equal(webhookSecretVar("lalanikarim/drydock"), "GITHUB_WEBHOOK_SECRET_lalanikarim_drydock");
});

const REAL = "a".repeat(40);

test("env beats the fleet file, and the source is reported (never the value)", () => {
  const r = resolveWebhookSecret("lalanikarim/drydock", { GITHUB_WEBHOOK_SECRET_lalanikarim_drydock: REAL }, "fleet-value-aaaaaaaaaaaa");
  assert.equal(r.secret, REAL);
  assert.equal(r.source, "env");
});

test("fleet file value is used when the env var is absent", () => {
  const r = resolveWebhookSecret("o/r", {}, REAL);
  assert.equal(r.secret, REAL);
  assert.equal(r.source, "fleet-file");
});

test("a placeholder secret is refused with the variable to set — this is what silently failed HMAC", () => {
  // The exact string that was in fleet.local.json on 2026-10-31.
  const placeholder = "see-GITHUB_WEBHOOK_SECRET_lalanikarim_drydock-in-env";
  assert.throws(
    () => resolveWebhookSecret("lalanikarim/drydock", {}, placeholder),
    (e) => {
      assert.match(e.message, /looks like a placeholder/);
      assert.match(e.message, /invalid signature/);
      assert.match(e.message, /GITHUB_WEBHOOK_SECRET_lalanikarim_drydock/);
      assert.ok(!e.message.includes(placeholder), "the refused value is not echoed");
      return true;
    },
  );
});

test("template-shaped secrets are refused; short-but-real ones are not our call", () => {
  for (const bad of ["CHANGE_ME_now_then", "placeholder-secret-value", "todo-replace-this-x", "xxxxxxxxxxxxxxxxxxxx", "see-ENV-var-for-this"]) {
    assert.throws(() => resolveWebhookSecret("o/r", {}, bad), /placeholder/, `${bad} must not be accepted`);
  }
  // A short but genuinely-random secret is the operator's business: it fails loudly at HMAC time
  // rather than silently forever, so refusing it here would be overreach.
  assert.equal(resolveWebhookSecret("o/r", {}, "shortbutreal").secret, "shortbutreal");
});

test("missing everywhere is a hard error naming both places to set it", () => {
  assert.throws(() => resolveWebhookSecret("acme/widget", {}), (e) => {
    assert.match(e.message, /GITHUB_WEBHOOK_SECRET_acme_widget/);
    assert.match(e.message, /fleet file/);
    return true;
  });
});

test("a real secret never appears in a thrown message", () => {
  const secretish = "z".repeat(40);
  try {
    resolveWebhookSecret("o/r", { GITHUB_WEBHOOK_SECRET_o_r: secretish }, undefined);
  } catch (e) {
    assert.ok(!String(e).includes(secretish));
  }
});
