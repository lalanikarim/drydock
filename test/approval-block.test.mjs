// #188 — an approval block must not be reported as an agent defect.
//
// The incident: a reviewer called `submit_verdict`, a gate required a human, and the durable store recorded
// "reviewer never called submit_verdict" while the run sat waiting ~40 minutes. The retry then burned a second full
// worker cycle arriving at a different approval key nobody had approved.
//
// Fixtures below are structurally copied from the production engram store (conversation 269, entry 304, captured
// 2026-11-04 by reading a `.backup` copy through `Conversation.context()`), with invented keys/tools per this repo's
// rule that tests use invented values. The *shape* is not invented: `kind: "pi.tool-result"`, a `toolResult` model
// message, and `data.diagnostics[].code === "blocked"` are what the kernel actually writes.
//
//   node --experimental-strip-types --test test/approval-block.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const {
  extractBlockedApprovals,
  findBlockForTool,
  blockedOutcomeFor,
  anyBlockedOutcome,
  readBlockedFromOutcome,
  blocksFromContextView,
  findBlocksInTaskContext,
  countUnparsedBlocks,
  describeBlockedApproval,
} = await import("../factory/approval-state.ts");

// ---------------------------------------------------------------- fixtures (production-shaped)

const KEY = "aabbccddeeff";
const MARKER_TEXT =
  `BLOCKED: "submit_verdict" requires human approval before it can run.\n` +
  `This action was classified DESTRUCTIVE. It will run only if the user explicitly acknowledges the risk.\n` +
  `Approval request: {"key":"${KEY}","tool":"submit_verdict","args":{"verdict":"pass"},"tier":"destructive"}\n` +
  `Do not retry this action until the user has approved it.`;

/** One entry exactly as the store holds it (model channel + structured diagnostic). */
const realEntry = (overrides = {}) => ({
  kind: "pi.tool-result",
  id: 304,
  conversationId: 269,
  byTaskId: 303,
  model: [
    {
      role: "toolResult",
      toolCallId: "WcnurxY9QdjvsObsDIs9zATTvXHSUKoF",
      toolName: "submit_verdict",
      content: [{ type: "text", text: `<harness>\n[error] Tool call blocked: ${MARKER_TEXT}\n</harness>` }],
      isError: true,
      timestamp: 1793722001868,
    },
  ],
  data: { diagnostics: [{ severity: "error", code: "blocked", message: `Tool call blocked: ${MARKER_TEXT}` }] },
  ...overrides,
});

// ---------------------------------------------------------------- marker extraction

test("extraction: finds the block in a production-shaped entry and names tool, key and tier", () => {
  const blocks = extractBlockedApprovals([realEntry()]);
  assert.equal(blocks.length, 1, "one wall, not one per channel — duplicates must collapse");
  assert.deepEqual(blocks[0], { key: KEY, tool: "submit_verdict", tier: "destructive" });
});

test("extraction: the same block seen on both channels collapses to one entry", () => {
  // Measured on production: every blocked conversation carried its marker twice. A caller that counted markers
  // would report two approvals pending where one exists.
  const blocks = extractBlockedApprovals([realEntry(), realEntry({ id: 305 })]);
  assert.equal(blocks.length, 1);
});

test("extraction: a keyless or malformed marker is dropped rather than guessed at", () => {
  // An approval with no key cannot be approved; surfacing it would tell the operator to run a command that does not exist.
  const junk = [
    { kind: "pi.tool-result", data: { note: "Approval request: {not json" } },
    { kind: "pi.tool-result", data: { note: 'Approval request: {"tool":"edit","tier":"prompt"}' } },
    { kind: "pi.tool-result", model: [{ role: "user", content: "no marker here at all" }] },
  ];
  assert.deepEqual(extractBlockedApprovals(junk), []);
});

test("extraction: entries with no markers of any kind yield nothing, including hostile shapes", () => {
  const hostile = [null, undefined, "string entry", 42, [], {}, { model: [[]] }, { data: { deep: { nested: [[[{ x: 1 }]]] } } }];
  assert.deepEqual(extractBlockedApprovals(hostile), []);
});

test("context view: finds the block via entries only, messages only, and both", () => {
  const entry = realEntry();
  const message = entry.model[0];
  assert.equal(blocksFromContextView({ entries: [entry] }).length, 1, "entries channel");
  assert.equal(blocksFromContextView({ messages: [message] }).length, 1, "messages channel");
  assert.equal(blocksFromContextView({ entries: [entry], messages: [message] }).length, 1, "both channels still one block");
  assert.deepEqual(blocksFromContextView(undefined), []);
});

// ---------------------------------------------------------------- outcome construction

test("outcome: a block for the guarded tool produces the machine fact downstream consumers branch on", () => {
  const blocks = extractBlockedApprovals([realEntry()]);
  const outcome = blockedOutcomeFor(blocks, "submit_verdict", "review");
  assert.ok(outcome, "a matching block must produce an outcome");
  // `failed` is the only honest kernel-representable status: TaskOutcome is a closed union of
  // completed|failed|aborted (#188 offered "new status OR result.blocked"; the type decided which).
  assert.equal(outcome.status, "failed");
  assert.deepEqual(outcome.result.blocked, { key: KEY, tool: "submit_verdict", tier: "destructive" });
  assert.equal(outcome.result.blockedKind, "approval");
  // The message must stop blaming the model and name what to do — that is the entire user-visible point.
  assert.match(outcome.error.message, /not an agent defect/);
  assert.match(outcome.error.message, new RegExp(KEY));
  assert.doesNotMatch(outcome.error.message, /never called submit_verdict/, "the blaming message must not survive");
  assert.match(describeBlockedApproval(outcome.result.blocked), /POST \/approvals\/aabbccddeeff/);
});

test("outcome: a block on a DIFFERENT tool does not explain a missing verdict", () => {
  // Precision matters: if the reviewer was blocked on some unrelated tool, "review blocked on submit_verdict" would be
  // a fabricated explanation for a genuine agent failure.
  const blocks = [{ key: KEY, tool: "edit", tier: "destructive" }];
  assert.equal(blockedOutcomeFor(blocks, "submit_verdict", "review"), undefined);
  // A worker has no single critical tool, so any block is the explanation there.
  const w = anyBlockedOutcome(blocks, "worker");
  assert.ok(w);
  assert.equal(w.result.blocked.tool, "edit");
});

test("outcome: no blocks means no blocked outcome (the ordinary failure path stays intact)", () => {
  assert.equal(blockedOutcomeFor([], "submit_verdict", "review"), undefined);
  assert.equal(anyBlockedOutcome([], "worker"), undefined);
});

test("round trip: a settled outcome written by one stage is readable by another, through every legacy shape", () => {
  const built = blockedOutcomeFor(extractBlockedApprovals([realEntry()]), "submit_verdict", "review");
  assert.deepEqual(readBlockedFromOutcome(built), { key: KEY, tool: "submit_verdict", tier: "destructive" });
  // Shapes that must never throw and never invent a block.
  for (const junk of [null, undefined, {}, { result: null }, { result: {} }, { result: { blocked: {} } }, { result: { blocked: { key: "", tool: "x" } } }, "nope", 7]) {
    assert.equal(readBlockedFromOutcome(junk), undefined);
  }
});

// ---------------------------------------------------------------- the in-task read

test("in-task read: degrades to 'no block' when the context read throws, and says so", () => {
  // The failure direction is deliberate and is the safety property of this whole module: an unreadable transcript must
  // reproduce pre-#188 behavior (report the ordinary failure), never suppress a retry with an invented block.
  const logs = [];
  const probe = findBlocksInTaskContext(async () => { throw new Error("store closed"); }, (l) => logs.push(l));
  return probe.then((blocks) => {
    assert.deepEqual(blocks, []);
    assert.ok(logs.some((l) => /reporting no block/.test(l)), "the degradation must be logged, not silent");
  });
});

test("in-task read: returns the blocks from a view supplied by the task runtime", async () => {
  const blocks = await findBlocksInTaskContext(async () => ({ entries: [realEntry()], messages: [] }));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tool, "submit_verdict");
});

test("drift alarm: a blocked diagnostic with an unparseable marker is reported instead of treated as 'no block'", () => {
  // If the kernel ever changes the marker wording, silent degradation would put the blaming message back in
  // production with a green test suite. The machine-readable `code: "blocked"` is what catches that.
  const entry = { kind: "pi.tool-result", data: { diagnostics: [{ severity: "error", code: "blocked", message: 'BLOCKED: needs sign-off (format changed, no JSON here)' }] } };
  const view = { entries: [entry], messages: [] };
  assert.equal(countUnparsedBlocks(view), 1);
  const logs = [];
  return findBlocksInTaskContext(async () => view, (l) => logs.push(l)).then((blocks) => {
    assert.deepEqual(blocks, []);
    assert.ok(logs.some((l) => /no parseable approval marker/.test(l)), "drift must be announced");
  });
});

test("drift alarm does not fire when the marker parses", async () => {
  const logs = [];
  await findBlocksInTaskContext(async () => ({ entries: [realEntry()] }), (l) => logs.push(l));
  assert.ok(!logs.some((l) => /no parseable/.test(l)), JSON.stringify(logs));
});

// ---------------------------------------------------------------- settlement classification (#188 item 4)

const ledger = await import("../factory/settlement-ledger.ts");
const { keyFor } = ledger;

test("settlement: an approval-blocked terminal row is `waiting`, not `failing`", () => {
  assert.equal(ledger.classifyTask("terminal", "failed", "", KEY), "waiting");
  // Without the key, nothing changes: an ordinary failure still alarms.
  assert.equal(ledger.classifyTask("terminal", "failed", ""), "failing");
  // An open task stays inFlight even if a stale marker exists — there is no outcome to judge yet.
  assert.equal(ledger.classifyTask("running", "", "", KEY), "inFlight");
});

test("settlement: `waiting` never alarms, and the watermark advances past it (unlike an open row)", () => {
  const rows = [
    { store: "s", table: "task", id: 10, kind: "factory.reviewer", status: "failed", kernelStatus: "terminal", cls: "waiting", whenMs: null, detail: `approval ${KEY} (submit_verdict)` },
    { store: "s", table: "task", id: 11, kind: "factory.worker", status: "unknown", kernelStatus: "running", cls: "inFlight", whenMs: null, detail: "" },
  ];
  const summary = ledger.summarize(rows, 1);
  assert.equal(summary.alarms.length, 0, "a run waiting on a human is not an incident");
  assert.equal(summary.counts.waiting, 1);
  const wm = ledger.advance({ version: 1, updatedAt: 0, highWater: {} }, rows);
  assert.equal(wm.highWater[keyFor("s", "task")], 10, "settled-but-waiting advances; the open row at 11 does not (#186 rule)");
});

test("settlement: the summary line prints the waiting count so a human sees the fleet is idle on them", () => {
  const rows = [{ store: "s", table: "task", id: 3, kind: "factory.reviewer", status: "failed", kernelStatus: "terminal", cls: "waiting", whenMs: null, detail: `approval ${KEY} (submit_verdict)` }];
  const text = ledger.formatSummary(ledger.summarize(rows, 1));
  assert.match(text, /waiting=1/);
});

// ------------------------------------------------------- the wiring, not just the helpers
//
// Everything above tests pure functions against production-shaped data. These drive the REAL `wait` phase handler of
// factory/reviewer.ts with a stub runtime, which is the only way to prove the branch is actually taken — a helper that
// works and a call site nobody wired is precisely how this repo shipped four green-but-dead fixes.

const { factoryReviewerTask } = await import("../factory/reviewer.ts");

function reviewerWaitHarness(view) {
  const commits = [];
  const task = { state: { checkpoint: { convId: 269 } }, input: { issueNumber: 63 } };
  const runtime = {
    // The reviewer's idle-wait, and the in-task context read #188 depends on.
    conversation: async () => ({ waitForIdle: async () => {} }),
    context: async () => view,
    commit: async (fn) => { commits.push(fn()); },
  };
  return { commits, run: () => factoryReviewerTask({ workDir: "/tmp/does-not-run", fixturesRepo: "o/r" }).definition.phases.wait(task, runtime, {}) };
}

test("wiring: the reviewer's wait phase records the block instead of blaming the model", async () => {
  const h = reviewerWaitHarness({ entries: [realEntry()], messages: realEntry().model });
  await h.run();
  assert.equal(h.commits.length, 1, "exactly one terminal commit");
  const committed = h.commits[0];
  assert.equal(committed.status, "terminal");
  assert.equal(committed.outcome.result.blocked.key, KEY);
  assert.equal(committed.outcome.result.blocked.tool, "submit_verdict");
  assert.match(committed.outcome.error.message, /not an agent defect/);
});

test("wiring: with no block in the transcript, the ordinary failure message is unchanged", async () => {
  // Guards against the opposite defect: a detection that invents blocks would suppress genuine retries.
  const h = reviewerWaitHarness({ entries: [{ kind: "pi.assistant" }], messages: [] });
  await h.run();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].outcome.error.message, "reviewer never called submit_verdict");
  assert.equal(h.commits[0].outcome.result, undefined);
});

test("wiring: a context read that throws falls back to the ordinary failure and never rejects the task", async () => {
  // The safety property of #188 end to end: a broken block lookup must degrade to exactly the pre-#188 behavior, not
  // fault the reviewer task (which would trade a misreported outcome for a lost run).
  const commits = [];
  const runtime = {
    conversation: async () => ({ waitForIdle: async () => {} }),
    context: async () => { throw new Error("store closed"); },
    commit: async (fn) => { commits.push(fn()); },
  };
  const task = { state: { checkpoint: { convId: 269 } }, input: { issueNumber: 63 } };
  await factoryReviewerTask({ workDir: "/tmp/does-not-run", fixturesRepo: "o/r" }).definition.phases.wait(task, runtime, {});
  assert.equal(commits.length, 1);
  assert.equal(commits[0].outcome.error.message, "reviewer never called submit_verdict");
  assert.equal(commits[0].outcome.result, undefined, "no block may be invented from a failed read");
});
