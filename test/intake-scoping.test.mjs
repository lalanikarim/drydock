// Intake conversation scoping (#122): which conversation a webhook event lands in, and what that
// conversation is able to call.
//   node --experimental-strip-types --test test/intake-scoping.test.mjs
//
// The bug this pins: the root orchestrator refused `refine_issue` while the tool was in the outbound
// request, because its own earlier refusals were in context and read as evidence. No prompt fixes that,
// so this file pins structure instead — per-(kind, subject) conversations, each created with exactly the
// tools its kind is allowed, plus the exactly-once behavior that scoping must not break.
//
// The harness here is a fake, and it is fake in the direction reality is: `conversation()` returns
// undefined for an id it never created, `submit()` rejects a requestId that conversation already settled
// (that is the kernel's guarantee we depend on), and `createConversation()` throws if asked to open an
// agent with no tools. The kernel contract itself is exercised for real in factory/intake-boot.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { INTAKE_KINDS, createIntakeRoute, intakeKey, validateIntakeBody, IntakeLedgerDoc } from "../factory/intake-router.ts";
import { fakeHarness, call, spec } from "./helpers/intake-fake-harness.mjs";
import { factoryPipeline, intakeToolNames, refinerInstructions } from "../factory/pipeline.ts";
import { makeRouteDispatch } from "../factory/adapter.ts";
import { gitAuthFromToken } from "../factory/github-auth.ts";

// ---------------------------------------------------------------- validation

test("intake body validation refuses instead of defaulting", () => {
  const good = { kind: "refine", subject: "#122", requestId: "issue-122-labeled", content: "do it" };
  assert.equal(validateIntakeBody(good).ok, true);

  const cases = [
    [{ ...good, kind: undefined }, 400, /kind must be one of/],
    [{ ...good, kind: "issue " }, 400, /kind must be one of/, "a trailing space is not a kind"],
    [{ ...good, subject: "" }, 400, /subject/],
    [{ ...good, subject: 42 }, 400, /subject/],
    [{ ...good, requestId: "" }, 400, /requestId/],
    [{ ...good, content: "   " }, 400, /content/],
    [{ ...good, content: "x".repeat(200_001) }, 413, /at most 200000/],
  ];
  for (const [body, status, pattern] of cases) {
    const r = validateIntakeBody(body);
    assert.equal(r.ok, false, `${JSON.stringify(body).slice(0, 60)} must be rejected`);
    assert.equal(r.status, status, `status for ${String(pattern)}`);
    assert.match(r.error, pattern);
  }
});

test("a body that is not JSON is a 400, never a retryable 500", async () => {
  const { harness } = fakeHarness();
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  const res = await call(route, harness, "{ this is not json");
  assert.equal(res.status, 400);
  assert.match(res.json.error, /must be JSON/);
});

test("kinds the route knows are the kinds the adapter classifies", () => {
  // classifyWebhookEvent in factory/intake.ts produces exactly these three; if a fourth is added there,
  // this pin fails rather than the new kind silently 400ing at the instance.
  assert.deepEqual([...INTAKE_KINDS].sort(), ["issue", "pr-feedback", "refine"]);
});

// ------------------------------------------------- capability envelopes (real tools)

function toolNames(pipelineOpts, names) {
  const ext = factoryPipeline({ workDir: "/tmp/does-not-matter", fixturesRepo: "o/r", modelRef: { provider: "p", modelId: "m" }, ...pipelineOpts });
  return (ext.tools ?? []).filter((t) => names.includes(t.name)).map((t) => t.name).sort();
}

test("a refinement conversation gets exactly one tool, and it is refine_issue", () => {
  const names = intakeToolNames({ autoMerge: true, refine: true });
  assert.deepEqual(toolNames({ refine: true }, names.refine), ["refine_issue"]);
  // The same agent must not be able to start implementation work — that is the whole point of scoping.
  assert.ok(!names.refine.includes("delegate"));
  assert.ok(!names.refine.includes("open_draft_pr"));
  assert.ok(!names.refine.includes("merge_pr"));
});

test("an orchestration conversation gets the orchestrator's set and never refine_issue", () => {
  const names = intakeToolNames({ autoMerge: true, refine: true });
  assert.deepEqual(toolNames({ refine: true, autoMerge: true }, names.issue), [
    "delegate",
    "merge_pr",
    "note_lesson",
    "open_draft_pr",
    "pr_status",
  ]);
  assert.deepEqual(toolNames({ refine: true, autoMerge: true }, names["pr-feedback"]), toolNames({ refine: true }, names.issue));
});

test("autoMerge=false removes merge_pr from the intake envelope too, not just from root", () => {
  const names = intakeToolNames({ autoMerge: false, refine: true });
  const picked = toolNames({ autoMerge: false, refine: true }, names.issue);
  assert.ok(!picked.includes("merge_pr"), picked.join(","));
  assert.ok(picked.includes("open_draft_pr"));
});

test("a policy-disabled refinement resolves to zero tools, which the route refuses rather than opening", async () => {
  const names = intakeToolNames({ autoMerge: true, refine: false });
  assert.deepEqual(toolNames({ refine: false }, names.refine), []);

  const { harness, calls } = fakeHarness();
  const route = createIntakeRoute({ repo: "o/r", agents: { refine: { instructions: "x", tools: [] } }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  const res = await call(route, harness, { kind: "refine", subject: "#1", requestId: "r1", content: "go" });
  assert.equal(res.status, 500, "an empty capability envelope is a bug, not a run");
  assert.equal(calls.created.length, 0, "nothing may be created with zero tools");
});

test("the refinement brief never instructs the agent toward a tool it does not have", () => {
  const text = refinerInstructions();
  // It may name them to forbid them; what it must not do is tell the agent to call one.
  assert.match(text, /one tool: refine_issue/);
  assert.doesNotMatch(text, /Call (delegate|open_draft_pr|merge_pr)/);
});

/**
 * A fake harness that refuses what the real kernel refuses. Only three doc/harness behaviors are needed:
 * session-doc snapshot/commit, conversation lookup, and per-conversation requestId settlement.
 */


/**
 * #235 rewrote this test rather than deleting it. It asserted that two `issue` submissions with DIFFERENT
 * requestIds share one conversation — behavior the real adapter cannot even produce, since `intakeRequestId()` is
 * constant `issue-<n>`; the fake could only reach it by inventing ids. Meanwhile the same code path, driven by an
 * operator who did hand-write a second requestId, silently resumed a conversation whose last run had been aborted
 * (#122's hazard). The rule now: for per-attempt kinds a new requestId IS a new attempt, so it gets a clean
 * transcript and reports what it replaced. Per-event kinds keep sharing — asserted below, because that is the case
 * a careless fix would destroy.
 */
test("per-attempt kind: a new requestId is a new attempt, in a fresh conversation (#235)", async () => {
  const { harness, calls } = fakeHarness();
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate", "open_draft_pr"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });

  const a = await call(route, harness, { kind: "issue", subject: "#3", requestId: "issue-3", content: "work on 3" });
  assert.equal(a.status, 202, JSON.stringify(a.json));
  assert.equal(a.json.created, true);

  // An identical requestId is answered by dedupe before find-or-create — that is what makes the rule below safe.
  const dup = await call(route, harness, { kind: "issue", subject: "#3", requestId: "issue-3", content: "work on 3" });
  assert.equal(dup.status, 200, JSON.stringify(dup.json));
  assert.equal(dup.json.duplicate, true);

  const b = await call(route, harness, { kind: "issue", subject: "#3", requestId: "issue-3#attempt-2", content: "retry after abort" });
  assert.equal(b.status, 202, JSON.stringify(b.json));
  assert.equal(b.json.created, true, "a per-attempt kind does not resume an aborted transcript");
  assert.notEqual(b.json.conversationId, a.json.conversationId);
  assert.equal(b.json.supersededConversationId, a.json.conversationId, "the operator is told which conversation was left behind");
  assert.equal(b.json.reusedConversation, undefined, "nothing was reused, so nothing is claimed to be reused");

  // The transcripts are genuinely separate, not two names for one store: each submission carries the conversation
  // it was made in, and those ids differ.
  const submitted = calls.submitted.filter((s) => s.requestId === "issue-3#attempt-2");
  assert.equal(submitted.length, 1);
  assert.notEqual(submitted[0].id, calls.submitted.find((s) => s.requestId === "issue-3")?.id, "the retry landed in the new conversation");

  // A different issue never inherits either transcript.
  const c = await call(route, harness, { kind: "issue", subject: "#4", requestId: "issue-4", content: "work on 4" });
  assert.notEqual(c.json.conversationId, a.json.conversationId);
  assert.notEqual(c.json.conversationId, b.json.conversationId);

  // A kind with no capability envelope is refused rather than routed into whatever conversation exists.
  const d = await call(route, harness, { kind: "refine", subject: "#3", requestId: "issue-3-refine-label", content: "REFINEMENT REQUEST" });
  assert.equal(d.status, 409, "a kind with no envelope is refused, not routed to whatever conversation exists");

  // issue#3 attempt 1 + attempt 2 + issue#4 = three conversations; the duplicate opened none.
  assert.equal(calls.created.length, 3, `expected exactly three created conversations, got ${calls.created.length}`);
});

test("per-event kinds still steer one shared conversation, and say so (#235)", async () => {
  const { harness, calls } = fakeHarness();
  const route = createIntakeRoute({
    repo: "o/r",
    agents: { refine: spec(["refine_issue"]), "pr-feedback": spec(["note_lesson"]) },
    modelRef: { provider: "p", modelId: "m" },
    log: () => {},
  });

  const first = await call(route, harness, { kind: "refine", subject: "#7", requestId: "issue-7-refine-c-101", content: "first comment" });
  assert.equal(first.json.created, true);
  const second = await call(route, harness, { kind: "refine", subject: "#7", requestId: "issue-7-refine-c-102", content: "second comment" });
  assert.equal(second.json.conversationId, first.json.conversationId, "comment-scoped ids steer the existing conversation — this is the feature, not the bug");
  assert.equal(second.json.created, false);
  assert.equal(second.json.supersededConversationId, undefined, "nothing was superseded");
  assert.deepEqual(
    second.json.reusedConversation,
    { id: first.json.conversationId, priorRequestId: "issue-7-refine-c-101", attemptsRecorded: 2 },
    "reuse is reported at request time, with the id it reused and how many attempts it already holds",
  );

  const third = await call(route, harness, { kind: "refine", subject: "#7", requestId: "issue-7-refine-c-103", content: "third comment" });
  assert.equal(third.json.reusedConversation.attemptsRecorded, 3);

  const pr = await call(route, harness, { kind: "pr-feedback", subject: "#7", requestId: "pr-7-c-501", content: "review note" });
  assert.equal(pr.json.created, true, "a different kind is a different key, so it opens its own conversation");
  assert.notEqual(pr.json.conversationId, first.json.conversationId);

  assert.equal(calls.created.length, 2, `refine shared one conversation and pr-feedback opened one: ${calls.created.length}`);
});

test("the tool set is fixed at creation — a refinement conversation cannot be created with orchestration tools", async () => {
  const { harness, calls } = fakeHarness();
  const route = createIntakeRoute({
    repo: "o/r",
    agents: { refine: spec(["refine_issue"]), issue: spec(["delegate"]) },
    modelRef: { provider: "p", modelId: "m" },
    log: () => {},
  });
  await call(route, harness, { kind: "refine", subject: "#9", requestId: "r-a", content: "expand 9" });
  assert.deepEqual(calls.created[0].toolNames, ["refine_issue"]);
  assert.equal(calls.created[0].instructions, "brief for refine_issue", "the envelope's brief is what the conversation is born with");
  assert.match(calls.created[0].metaName, /^intake refine:#9$/, "operators find these conversations by name in GET /conversations");
});

test("a redelivery of a settled requestId is answered without a second submission", async () => {
  const { harness, calls } = fakeHarness();
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  const first = await call(route, harness, { kind: "issue", subject: "#7", requestId: "issue-7-labeled", content: "go" });
  assert.equal(first.status, 202);
  const again = await call(route, harness, { kind: "issue", subject: "#7", requestId: "issue-7-labeled", content: "go" });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(calls.submitted.length, 1, "GitHub redelivers; the run must not happen twice");
});

test("the (kind, subject) → conversation mapping is written to a durable session document", async () => {
  // Restart behavior depends on this: the route holds no in-memory state, so if the mapping were only in
  // the process, a restart would open a fresh conversation per event and the core's per-conversation
  // requestId dedupe would no longer see the earlier settlement.
  const { harness, docs } = fakeHarness();
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  const first = await call(route, harness, { kind: "issue", subject: "#5", requestId: "r-1", content: "go" });

  const ledger = docs.get(IntakeLedgerDoc.definition.kind);
  assert.ok(ledger, "the intake ledger document must exist after the first intake");
  assert.equal(ledger.entries[intakeKey("issue", "#5")], first.json.conversationId);
  assert.deepEqual(ledger.requests.map((r) => [r.id, r.key]), [["r-1", "issue:#5"]]);
});

test("a ledger entry pointing at a deleted conversation opens a replacement instead of failing forever", async () => {
  const { harness, docs } = fakeHarness();
  docs.set(IntakeLedgerDoc.definition.kind, { entries: { "issue:#6": 999 }, requests: [] });
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  const res = await call(route, harness, { kind: "issue", subject: "#6", requestId: "r-9", content: "go" });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.created, true);
  assert.notEqual(docs.get(IntakeLedgerDoc.definition.kind).entries["issue:#6"], 999);
});

test("a submission the kernel rejects surfaces as a 500, not a silent accept", async () => {
  const { harness, conversations } = fakeHarness();
  // kind `refine`, not `issue`: this test needs the SECOND dispatch to land in the conversation it patched, and
  // since #235 a per-attempt kind deliberately opens a fresh one instead. Per-event kinds still reuse, which is what
  // makes them the right harness for "the kernel refused the submit".
  const route = createIntakeRoute({ repo: "o/r", agents: { refine: spec(["refine_issue"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  await call(route, harness, { kind: "refine", subject: "#8", requestId: "r-first", content: "go" });
  // Force the conversation's own settlement to fail for a different requestId.
  const conv = [...conversations.values()].at(-1);
  conv.submit = async () => { throw new Error("no_model"); };
  const res = await call(route, harness, { kind: "refine", subject: "#8", requestId: "r-second", content: "go again" });
  assert.equal(res.status, 500);
  assert.match(res.json.error, /no_model/);
});

// ------------------------------------------- adapter → route contract (real HTTP, real route code)

async function serveRoute(route, harness) {
  const server = createServer((req, res) => {
    const rctx = {
      harness,
      ctx: {},
      json: (r, status, body) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); },
      async pendingApprovals() { return []; },
    };
    route.handle(req, res, rctx).catch((e) => { res.writeHead(500); res.end(String(e)); });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const issueEvent = { action: "labeled", label: { name: "agent" }, repository: { full_name: "o/a" }, issue: { number: 3, title: "Add sorting", body: "sort it" }, sender: { login: "lalanikarim" } };
const refineEvent = { action: "labeled", label: { name: "refine" }, repository: { full_name: "o/a" }, issue: { number: 12, title: "Vague thing", body: "..." }, sender: { login: "lalanikarim" } };

test("the adapter posts kind and subject to /factory/intake, and the real route accepts them", async () => {
  const { harness, calls } = fakeHarness();
  const srv = await serveRoute(createIntakeRoute({ repo: "o/a", agents: { issue: spec(["delegate"]), refine: spec(["refine_issue"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} }), harness);
  try {
    const dispatch = makeRouteDispatch([{ repo: "o/a", secret: "s", target: srv.url, token: "instance-token", refine: true, eligibilityLabel: "agent", refineLabel: "refine" }], {
      gitAuth: gitAuthFromToken("ghs_x"),
      fetchState: async () => "open",
    });
    const r1 = await dispatch("o/a", issueEvent);
    assert.equal(r1.accepted !== false, true, JSON.stringify(r1));
    const r2 = await dispatch("o/a", refineEvent);
    assert.equal(r2.accepted !== false, true, JSON.stringify(r2));

    assert.deepEqual(calls.created.map((c) => c.toolNames), [["delegate"], ["refine_issue"]], "issue work and refinement land in different conversations with different capabilities");
  } finally {
    srv.close();
  }
});
