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
import { ConversationMeta } from "../vendor/engram/app/src/meta.ts";
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

// ---------------------------------------------------------------- route behavior

/**
 * A fake harness that refuses what the real kernel refuses. Only three doc/harness behaviors are needed:
 * session-doc snapshot/commit, conversation lookup, and per-conversation requestId settlement.
 */

function fakeHarness({ settled = [] } = {}) {
  const docs = new Map();
  const conversations = new Map();
  const calls = { created: [], submitted: [] };
  let nextConvId = 100;
  let nextSubId = 500;
  for (const [key, id] of settled) conversations.set(id, makeConv(id, key));

  function makeConv(id, name) {
    const done = new Set();
    return {
      id,
      name,
      done,
      async submit(draft, _ctx) {
        if (typeof draft.requestId !== "string" || !draft.requestId) throw new Error("requestId required");
        // The kernel's guarantee, mirrored: the same requestId settles once per conversation.
        if (done.has(draft.requestId)) throw new Error(`submission ${draft.requestId} already settled in conversation ${id}`);
        done.add(draft.requestId);
        calls.submitted.push({ id, requestId: draft.requestId, content: draft.content });
        return { id: ++nextSubId };
      },
    };
  }

  // One address space for both scopes: session singletons are keyed by kind alone, conversation docs by
  // kind + id — the same distinction the kernel makes between `tx.doc(Doc)` and `tx.doc(Doc, id)`.
  const kindOf = (doc) => (doc.definition ?? doc).kind;
  const docAt = (doc, id) => {
    const key = id === undefined ? kindOf(doc) : `${kindOf(doc)}:${id}`;
    if (!docs.has(key)) {
      // Materialized from the real definition (`token.definition.initial`), so the fake cannot drift from
      // the document shape the route writes.
      const def = doc.definition ?? doc;
      if (typeof def.initial !== "function") throw new Error(`no initial() on doc ${String(def.kind)} — fake harness needs a real doc token`);
      docs.set(key, structuredClone(def.initial()));
    }
    return docs.get(key);
  };

  const harness = {
    async snapshot(doc) {
      // A session singleton that has never been written reads as absent, which is what the route expects.
      return docs.has(kindOf(doc)) ? docs.get(kindOf(doc)) : undefined;
    },
    async commit(fn) {
      await fn({ doc: async (doc, id) => docAt(doc, id) });
      return undefined;
    },
    async conversation(id) {
      return conversations.get(id); // undefined for an id that was never created — as in reality
    },
    async createConversation(opts) {
      const tools = opts?.agent?.tools;
      if (!Array.isArray(tools) || tools.length === 0) throw new Error("refusing to create a conversation with no tools");
      for (const t of tools) if (typeof t?.name !== "string") throw new Error("tool registrations must have names");
      if (opts?.ownership?.kind !== "ownerless") throw new Error(`unexpected ownership ${JSON.stringify(opts?.ownership)}`);
      const id = ++nextConvId;
      if (opts.init) await opts.init({ doc: async (doc, cid) => docAt(doc, cid) }, id);
      const conv = makeConv(id, docs.get(`${ConversationMeta.definition?.kind ?? ConversationMeta.kind}:${id}`)?.name ?? "");
      conversations.set(id, conv);
      calls.created.push({ id, toolNames: tools.map((t) => t.name).sort(), instructions: opts.agent.instructions, metaName: conv.name });
      return conv;
    },
  };
  return { harness, calls, conversations, docs };
}

async function call(route, harness, body, { token = "t" } = {}) {
  // A real Readable for the request (the kernel's readJsonBody consumes it as an async iterable) and a
  // response stub that only records what `rctx.json` — the kernel-provided sender — was handed.
  const { Readable } = await import("node:stream");
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = route.method;
  req.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let sent = null;
  const res = { writeHead() {}, end() {} };
  const rctx = {
    harness,
    ctx: {},
    json(_r, status, payload) { sent = { status, json: payload }; },
    async pendingApprovals() { return []; },
  };
  await route.handle(req, res, rctx);
  if (!sent) throw new Error("route answered nothing");
  return sent;
}

const spec = (names) => ({ instructions: `brief for ${names.join(",")}`, tools: names.map((name) => ({ name })) });

test("two events for one issue share a conversation; two issues never do", async () => {
  const { harness, calls } = fakeHarness();
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate", "open_draft_pr"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });

  const a = await call(route, harness, { kind: "issue", subject: "#3", requestId: "issue-3-labeled", content: "work on 3" });
  assert.equal(a.status, 202, JSON.stringify(a.json));
  assert.equal(a.json.created, true);
  const b = await call(route, harness, { kind: "issue", subject: "#3", requestId: "issue-3-comment", content: "also this" });
  assert.equal(b.json.conversationId, a.json.conversationId, "same subject → same conversation, so the core can dedupe");
  assert.equal(b.json.created, false);
  const c = await call(route, harness, { kind: "issue", subject: "#4", requestId: "issue-4-labeled", content: "work on 4" });
  assert.notEqual(c.json.conversationId, a.json.conversationId, "a different issue must not inherit this transcript");

  const d = await call(route, harness, { kind: "refine", subject: "#3", requestId: "issue-3-refine-label", content: "REFINEMENT REQUEST" });
  assert.equal(d.status, 409, "a kind with no envelope is refused, not routed to whatever conversation exists");
  void d;
  assert.equal(calls.created.length, 2);
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
  const route = createIntakeRoute({ repo: "o/r", agents: { issue: spec(["delegate"]) }, modelRef: { provider: "p", modelId: "m" }, log: () => {} });
  await call(route, harness, { kind: "issue", subject: "#8", requestId: "r-first", content: "go" });
  // Force the conversation's own settlement to fail for a different requestId.
  const conv = [...conversations.values()].at(-1);
  conv.submit = async () => { throw new Error("no_model"); };
  const res = await call(route, harness, { kind: "issue", subject: "#8", requestId: "r-second", content: "go again" });
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
