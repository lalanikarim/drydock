// #241 — the boot suites picked their model with `data[0].id` from `/models`. That is not a policy; it is the order
// an inference server happened to return today. When Unsloth Studio's list reordered, `intake-boot` selected a model
// that was listed, accepted submissions, wrote two user entries, and never produced an assistant turn — while the same
// endpoint answered a raw completion for that model in 5.9 s. The suite's own message blamed an unreachable host.
//
// These tests pin the replacement: name the model (env) or read production's pin, require it to be served, and skip
// loudly otherwise. The hostile cases are the point — a resolver that falls back "helpfully" is what broke.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chooseBootModel, listServedModels, pinnedModelFromConfig } from "../factory/boot-model.ts";

const BASE = "http://inference.test:8888/v1";
const PINNED = { provider: "aurora", modelId: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF" };

function configWith(models) {
  const dir = mkdtempSync(join(tmpdir(), "drydock-boot-model-"));
  const path = join(dir, "lalanikarim_drydock.json");
  writeFileSync(path, JSON.stringify({ repo: "lalanikarim/drydock", ...(models ? { models } : {}) }));
  return path;
}

const catalogForAurora = JSON.stringify({ providers: { aurora: { baseUrl: BASE } } });

test("DEFAULT_MODEL wins when the endpoint serves it", () => {
  const r = chooseBootModel({
    served: ["unsloth/gemma-4-E4B-it-GGUF", PINNED.modelId],
    baseUrl: BASE,
    env: { DEFAULT_MODEL: `${PINNED.provider}:${PINNED.modelId}` },
    catalogRaw: catalogForAurora,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ref, PINNED);
  assert.equal(r.source, "DEFAULT_MODEL");
});

test("a pin that is not served skips — it never falls back to list position", () => {
  // The exact regression: gemma first, the pin absent. The old code took index 0 and produced a silent non-run.
  const r = chooseBootModel({
    served: ["unsloth/gemma-4-E4B-it-GGUF", "some/other-model"],
    baseUrl: BASE,
    env: { DEFAULT_MODEL: `${PINNED.provider}:${PINNED.modelId}` },
    catalogRaw: catalogForAurora,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not served/);
  assert.match(r.reason, /unsloth\/gemma-4-E4B-it-GGUF/, "the skip must name what IS available, or the operator guesses");
  assert.ok(!("ref" in r), "no ref may be returned — a fallback ref is how this suite went green-then-silent");
});

test("with no DEFAULT_MODEL, production's own pin is used", () => {
  const path = configWith(PINNED);
  const r = chooseBootModel({ served: [PINNED.modelId], baseUrl: BASE, env: {}, configPath: path, catalogRaw: catalogAurora() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.source, "drydock-config");
  assert.deepEqual(r.ref, PINNED);
});
function catalogAurora() {
  return catalogForAurora;
}

test("no pin anywhere: refuse rather than pick from /models", () => {
  const dir = mkdtempSync(join(tmpdir(), "drydock-boot-model-empty-"));
  const r = chooseBootModel({
    served: ["a/one", "a/two", "a/three"],
    baseUrl: BASE,
    env: {},
    configPath: join(dir, "missing.json"),
    catalogRaw: catalogForAurora,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Refusing to pick one from \/models/);
});

test("a provider the kernel never registered is a skip, not a silent non-run (#171)", () => {
  const r = chooseBootModel({
    served: [PINNED.modelId],
    baseUrl: BASE,
    env: { DEFAULT_MODEL: `openai-completions:${PINNED.modelId}` },
    catalogRaw: catalogForAurora,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /openai-completions/);
  assert.match(r.reason, /aurora/, "the message must name the provider the catalog actually declares");
});

test("a malformed config is treated as absent, not as a crash and not as a pin", () => {
  const dir = mkdtempSync(join(tmpdir(), "drydock-boot-model-bad-"));
  const path = join(dir, "lalanikarim_drydock.json");
  writeFileSync(path, "{ this is not json");
  assert.equal(pinnedModelFromConfig(path), undefined);
  const r = chooseBootModel({ served: [PINNED.modelId], baseUrl: BASE, env: {}, configPath: path, catalogRaw: catalogForAurora });
  assert.equal(r.ok, false);
});

test("pinnedModelFromConfig ignores a config with no models block", () => {
  assert.equal(pinnedModelFromConfig(configWith(undefined)), undefined);
  assert.deepEqual(pinnedModelFromConfig(configWith(PINNED)), PINNED);
});

test("listServedModels rejects when it cannot list — 'could not reach' must not look like 'nothing served'", async () => {
  // The boot suites distinguish these on purpose: an unreachable host is a skip, an endpoint serving a different
  // model set is a different skip with a different fix. Collapsing them is how #241's false "provider unreachable"
  // diagnosis survived as the only clue.
  await assert.rejects(() => listServedModels("http://127.0.0.1:1", "x"));
});
