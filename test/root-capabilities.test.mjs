// Root capability sync (#65 live finding): an existing root conversation silently keeps the agent
// configuration it was created with, so every boot has to re-assert it — and check that it took.
//   node --experimental-strip-types --test test/root-capabilities.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { syncRootCapabilities } from "../factory/root-capabilities.ts";

/** A fake root conversation that records what it was configured with and reports a tool set. */
function fakeConv(offered, opts = {}) {
  const calls = { configure: [], agent: 0 };
  return {
    calls,
    conv: {
      async configure(change) {
        if (opts.throws) throw opts.throws;
        calls.configure.push(change);
      },
      async agent() {
        calls.agent += 1;
        return { tools: offered };
      },
    },
  };
}

const change = { instructions: "INST", tools: [{ name: "delegate" }], model: { provider: "p", modelId: "m" } };

test("a matching capability set is asserted and reported", async () => {
  const { conv, calls } = fakeConv(["delegate", "open_draft_pr", "pr_status", "note_lesson", "refine_issue"]);
  const lines = [];
  const res = await syncRootCapabilities({
    conversation: async () => conv,
    change,
    expected: ["delegate", "open_draft_pr", "pr_status", "note_lesson", "refine_issue"],
    log: (l) => lines.push(l),
  });
  assert.equal(calls.configure.length, 1, "configure must actually be called — creation-time options are not enough");
  assert.deepEqual(calls.configure[0], change);
  assert.equal(res.tools.length, 5);
  assert.match(lines.join("\n"), /root capabilities synced: delegate, open_draft_pr, pr_status, note_lesson, refine_issue/);
});

test("a tool the policy grants but the agent would not get is fatal", async () => {
  // This is the exact live failure: "refinement enabled" in the boot log, no `refine_issue` offered.
  const { conv } = fakeConv(["delegate", "open_draft_pr", "pr_status", "note_lesson"]);
  await assert.rejects(
    () => syncRootCapabilities({ conversation: async () => conv, change, expected: ["delegate", "refine_issue"] }),
    /missing refine_issue[\s\S]*would offer \[delegate, open_draft_pr, pr_status, note_lesson\]/,
  );
});

test("a tool the agent would offer but the policy does not list is fatal too", async () => {
  // The dangerous direction: `autoMerge=false` removed merge_pr from the list, yet a stale root
  // conversation still offers it. Refusing to start is the only honest response.
  const { conv } = fakeConv(["delegate", "open_draft_pr", "merge_pr"]);
  await assert.rejects(
    () => syncRootCapabilities({ conversation: async () => conv, change, expected: ["delegate", "open_draft_pr"] }),
    /unlisted merge_pr/,
  );
});

test("a missing root conversation is fatal rather than skipped", async () => {
  await assert.rejects(
    () => syncRootCapabilities({ conversation: async () => undefined, change, expected: ["delegate"] }),
    /no root conversation handle/,
  );
});

test("a configure that throws propagates — boot must not announce readiness on top of it", async () => {
  const { conv } = fakeConv([], { throws: new Error("doc write rejected") });
  await assert.rejects(() => syncRootCapabilities({ conversation: async () => conv, change, expected: [] }), /doc write rejected/);
});

test("registrations and bare names are both accepted when reading back", async () => {
  const { conv } = fakeConv([{ name: "delegate" }, { name: "refine_issue" }]);
  const res = await syncRootCapabilities({ conversation: async () => conv, change, expected: ["delegate", "refine_issue"] });
  assert.deepEqual(res.tools, ["delegate", "refine_issue"]);
});

test("an empty offered set is reported as empty rather than passing silently", async () => {
  // A root agent with no tools cannot do anything; the caller decides how fatal that is, but the sync
  // must not pretend it matched a non-empty expectation.
  const { conv } = fakeConv([]);
  await assert.rejects(() => syncRootCapabilities({ conversation: async () => conv, change, expected: ["delegate"] }), /missing delegate/);
  const res = await syncRootCapabilities({ conversation: async () => conv, change, expected: [] });
  assert.deepEqual(res.tools, []);
});
