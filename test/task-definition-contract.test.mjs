/**
 * Task-definition shape contract (#164).
 *
 * `defineTask(definition)` in pi-durable is `{ definition }` — a pass-through with no validation. The scheduler aborts
 * a task by calling `erased(task).abort(...)`, i.e. **`definition.abort`, a top-level member** ("Runs in a fresh
 * invocation after an abort mark and must commit a terminal outcome"). Our three factory tasks had `abort` nested
 * inside `phases`, where the string index signature on that map accepted it as just another phase name. So
 * `definition.abort` was `undefined` and every abort mark threw:
 *
 * ```
 * $ sqlite3 … "select id, json_extract(record,'$.state.outcome.error.message') from tasks
 *              where json_extract(record,'$.state.outcome.status')='faulted';"
 * 1297|erased(...).abort is not a function
 * 1437|erased(...).abort is not a function
 * ```
 *
 * and the string only our handler writes — outcome reason `worker aborted` — had appeared **zero times** in any
 * production store, meaning it had never once run. Nothing caught it because nothing type-checks this repo:
 * `--experimental-strip-types` removes types without checking them.
 *
 * These tests are the guard at both ends: our definitions expose `abort` where the kernel reads it, and the pass-through
 * property that makes nesting silently fatal is itself asserted, so a future kernel that *did* accept nested aborts
 * would fail here rather than leaving us guessing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { defineTask } from "@earendil-works/pi-durable";
import { factoryWorkerTask } from "../factory/worker.ts";
import { factoryReviewerTask } from "../factory/reviewer.ts";
import { factoryRefineTask } from "../factory/refine-task.ts";

const base = { workDir: "/tmp/drydock-contract", fixturesRepo: "lalanikarim/factory-fixture" };

function definitionOf(kind) {
  const found = definitions.find(([k]) => k === kind);
  if (!found) throw new Error(`no definition for ${kind}`);
  return found[1].definition;
}

const definitions = [
  ["factory.worker", factoryWorkerTask(base)],
  ["factory.reviewer", factoryReviewerTask(base)],
  ["factory.refine", factoryRefineTask(base)],
];

test("defineTask is a pass-through, so only top-level members are visible to the scheduler", () => {
  // This is why the nesting was fatal rather than merely odd: no normalization, no validation, no error.
  const marker = { name: "x", version: 1, phases: { go: async () => {} }, abort: async () => {} };
  assert.equal(defineTask(marker).definition, marker, "returns the same object it was given");
});

for (const [kind, task] of definitions) {
  test(`${kind} exposes abort where the kernel reads it — top level, not under phases`, () => {
    const def = task.definition;
    assert.equal(typeof def.name === "string" ? def.name : kind, kind);
    assert.equal(typeof def.abort, "function", `${kind}.definition.abort must be a function: scheduler.js calls erased(task).abort(...)`);
    assert.ok(def.phases && typeof def.phases === "object", "phases map still present");
    assert.ok(!("abort" in def.phases), `${kind} must not carry abort inside phases — the index signature accepts it and the kernel never looks there (#164)`);
  });

  test(`${kind}'s abort commits a terminal outcome (kernel requirement)`, async () => {
    // The contract is "must commit a terminal outcome": returning without one faults the task with
    // "Abort handler of task N returned without a terminal outcome". Assert the payload we hand the runtime.
    const committed = [];
    let passedCtx = null;
    const runtime = { commit: async (decide, ctx) => { committed.push(decide()); passedCtx = ctx; } };
    await definitionOf(kind).abort({ state: { checkpoint: {} }, input: {} }, runtime, { ctxToken: "ctx" });
    assert.equal(committed.length, 1, "abort must commit exactly once");
    const outcome = committed[0];
    assert.equal(outcome.status, "completing", "terminal transition goes through completing");
    assert.ok(outcome.outcome && typeof outcome.outcome === "object", "an outcome object must be supplied");
    assert.equal(outcome.outcome.status, "aborted", JSON.stringify(outcome));
    assert.ok(String(outcome.outcome.reason ?? "").length > 3, `the reason must name the cause, got ${JSON.stringify(outcome.outcome.reason)}`);
    assert.deepEqual(passedCtx, { ctxToken: "ctx" }, "the invocation context must be passed through to commit");
  });
}

test("every task kind we register declares phases our abort does not depend on", () => {
  // Cheap structural sanity: `initial()` must produce a phase tag, or the scheduler has no entry point.
  for (const [kind, task] of definitions) {
    const state = task.definition.initial({});
    assert.equal(typeof state?.phase, "string", `${kind}.initial() must return { phase }`);
    assert.ok(Number.isInteger(task.definition.version), `${kind} needs an integer version for migration resolution`);
  }
});

// ── registration-time guard (#164) ───────────────────────────────────────────────────────────────────────
//
// The kernel only reads `definition.abort` when an abort mark arrives — possibly days after the definition was
// written, and usually during an incident. Checking at boot is the difference between a factory that refuses to start
// and a `faulted` record with `{message}` and no stack (#164's two rows were found by a counter, not by anything that
// noticed at the time).

const { assertAbortable } = await import("../factory/task-contract.ts");

test("assertAbortable accepts the three real definitions", () => {
  for (const [kind, task] of definitions) {
    assert.doesNotThrow(() => assertAbortable(task, kind), `${kind} must satisfy the abort contract at boot`);
  }
});

test("assertAbortable rejects exactly the shape that shipped (#164)", () => {
  // abort present but nested under phases — the shape TypeScript accepted and the kernel never saw.
  const nested = { definition: { name: "factory.someone_elses", phases: { spawn: async () => {}, abort: async () => {} } } };
  assert.throws(() => assertAbortable(nested), (e) => {
    assert.match(e.message, /factory\.someone_elses/);
    assert.match(e.message, /nested under `phases`/);
    assert.match(e.message, /top-level/);
    return true;
  });
});

test("assertAbortable rejects a definition with no abort at all", () => {
  const missing = { definition: { name: "factory.headless", phases: { spawn: async () => {} } } };
  assert.throws(() => assertAbortable(missing), /definition\.abort is undefined/);
});

test("assertAbortable tolerates an optional definition being absent (refinement disabled)", () => {
  // pipeline.ts passes null when refine is off; that is a configuration choice, not a contract violation.
  assert.doesNotThrow(() => assertAbortable(null, "factory.refine"));
  assert.doesNotThrow(() => assertAbortable(undefined));
});

test("assertAbortable rejects a value that is not a defineTask result", () => {
  assert.throws(() => assertAbortable({ definition: undefined }, "factory.broken"), /must return \{ definition \}/);
  assert.throws(() => assertAbortable({}, "factory.broken2"), /must return \{ definition \}/);
});
