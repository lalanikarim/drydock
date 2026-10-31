// Model pinning + catalog self-check (#47 follow-up).
//   node --experimental-strip-types --test test/model-catalog.test.mjs
//
// Background: `modelId: "auto"` asked the endpoint what it has loaded, while the kernel built its
// catalog from <agentDir>/models.json — where a provider entry wins over the env auto-registration.
// Two sources of truth meant the factory ran fine only while both agreed, and failed as
// "unanswered / no_model" with no surfaced error when they did not (G4 waited its full 25 minutes).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { catalogModelIds, isModelAvailable, unavailableModelError, defaultMismatchWarning } from "../factory/model-catalog.ts";

const PINNED = "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF";
const ref = { provider: "aurora", modelId: PINNED };

test("catalog payloads are flattened defensively", () => {
  // Shape A: objects with provider+id (what the app returns today).
  assert.deepEqual(
    catalogModelIds({ models: [{ id: PINNED, provider: "aurora" }, { id: "other", provider: "spark" }] }),
    [`aurora/${PINNED}`, "spark/other"],
  );
  // Shape B: bare strings.
  assert.deepEqual(catalogModelIds({ models: [`aurora/${PINNED}`] }), [`aurora/${PINNED}`]);
  assert.deepEqual(catalogModelIds([`aurora/${PINNED}`]), [`aurora/${PINNED}`]);
  // Junk degrades to "not found" (fails closed) rather than matching something by accident.
  assert.deepEqual(catalogModelIds(undefined), []);
  assert.deepEqual(catalogModelIds({ models: "nope" }), []);
  assert.deepEqual(catalogModelIds({ models: [{}, { id: "" }, null, 7] }), []);
});

test("availability is an exact provider/id match", () => {
  const payload = { models: [{ id: PINNED, provider: "aurora" }] };
  assert.equal(isModelAvailable(ref, payload), true);
  assert.equal(isModelAvailable({ provider: "AURORA", modelId: PINNED.toLowerCase() }, payload), true, "case only");
  // A prefix of a listed model must not count as available — that is how "close enough" bugs ship.
  assert.equal(isModelAvailable({ provider: "aurora", modelId: "ISTA" }, payload), false);
  assert.equal(isModelAvailable({ provider: "spark", modelId: PINNED }, payload), false);
  assert.equal(isModelAvailable(ref, { models: [] }), false);
});

test("the failure message names both sides and the file that decides", () => {
  const msg = unavailableModelError({ provider: "aurora", modelId: "unsloth/gemma-4-12b-it-GGUF" }, {
    models: [{ id: PINNED, provider: "aurora" }],
  });
  assert.match(msg, /aurora\/unsloth\/gemma-4-12b-it-GGUF is not in this instance's model catalog/);
  assert.match(msg, /unanswered \/ no_model/, "says what would otherwise happen silently");
  assert.match(msg, new RegExp(PINNED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "lists what IS available");
  assert.match(msg, /models\.json/, "points at the file whose provider entry wins");
});

test("every repo config pins an explicit model id — no \"auto\"", () => {
  // Measurement baselines (81–145K vs 119–220K tokens) are model-specific; a factory that silently
  // follows whatever the inference box happens to have loaded cannot produce comparable numbers, and
  // coupling "loaded" to "catalogued" is what broke runs on 2026-10-30.
  const dir = join(import.meta.dirname, "..", "factory", "config");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 3, `expected the three repo configs, saw: ${files.join(", ")}`);
  for (const f of files) {
    const cfg = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (!cfg.models) continue;
    assert.notEqual(cfg.models.modelId, "auto", `${f}: "auto" resolves independently of the kernel's catalog — pin an id`);
    assert.ok(typeof cfg.models.modelId === "string" && cfg.models.modelId.length > 3, `${f}: modelId must be an explicit id`);
    assert.ok(typeof cfg.models.provider === "string" && cfg.models.provider, `${f}: provider required`);
  }
});

test("the instance default differing from the pin is reported, not swallowed", () => {
  const payload = { models: [{ id: PINNED, provider: "aurora" }], default: "aurora/unsloth/gemma-4-12b-it-GGUF" };
  const warn = defaultMismatchWarning(ref, payload);
  assert.ok(warn, "a differing default is what caused the silent no_model outage");
  assert.match(warn, /instance default model is aurora\/unsloth\/gemma-4-12b-it-GGUF/);
  assert.match(warn, new RegExp(PINNED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(defaultMismatchWarning(ref, { models: [], default: `aurora/${PINNED}` }), null);
  assert.equal(defaultMismatchWarning(ref, { models: [] }), null, "no default reported is not a mismatch");
});

test("default comparison is model identity, not separator formatting", () => {
  const esc = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // The instance reports its default as `provider:modelId` while the pin is formatted
  // `provider/modelId` — same model, so no warning (the false alarm that fired on every boot).
  assert.equal(defaultMismatchWarning(ref, { models: [], default: `aurora:${PINNED}` }), null);
  // Case-insensitivity preserved across both separators.
  assert.equal(defaultMismatchWarning(ref, { models: [], default: `AURORA:${PINNED.toLowerCase()}` }), null);
  assert.equal(
    defaultMismatchWarning({ provider: "Aurora", modelId: PINNED }, { models: [], default: `aurora/${PINNED.toLowerCase()}` }),
    null,
  );
  // A genuinely different model id still warns, naming both sides in their raw form.
  const otherId = defaultMismatchWarning(ref, { models: [], default: "aurora/unsloth/gemma-4-12b-it-GGUF" });
  assert.ok(otherId);
  assert.match(otherId, /instance default model is aurora\/unsloth\/gemma-4-12b-it-GGUF but this repo pins aurora\//);
  assert.match(otherId, esc(PINNED));
  // A different provider still warns, with both names in the message.
  const otherProv = defaultMismatchWarning(ref, { models: [], default: `spark:${PINNED}` });
  assert.ok(otherProv);
  assert.match(otherProv, /instance default model is spark:/);
  assert.match(otherProv, esc(PINNED));
  // Missing or empty default: no warning (unchanged).
  assert.equal(defaultMismatchWarning(ref, { models: [] }), null);
  assert.equal(defaultMismatchWarning(ref, { models: [], default: "" }), null);
});

test("main.ts pins the orchestrator model instead of inheriting the endpoint's loaded model", () => {
  // Tripwire: core.ts falls back to defaultModelRef() (DEFAULT_MODEL, else the *loaded* model) when
  // rootAgent.model is unset. That fallback is what silently ran a model absent from the catalog.
  const src = readFileSync(join(import.meta.dirname, "..", "factory", "main.ts"), "utf8");
  // AgentChange.model is a ModelRef object ({provider, modelId}), not the "<provider>:<id>" string
  // used by config roles; passing a string produced "Model undefined/undefined is not available".
  assert.match(src, /model: \{ provider: modelRef\.provider, modelId: modelRef\.modelId \}/, "rootAgent must carry an explicit ModelRef");
  assert.match(src, /assertModelAvailable\(/, "readiness must be gated on the catalog");
});
