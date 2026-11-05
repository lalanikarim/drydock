// Shared fake harness for the intake routes (#122 scoping, #226 reopen).
//
// Extracted from test/intake-scoping.test.mjs rather than copied, because this fake encodes kernel behavior
// the routes depend on — and two copies drift, at which point a green suite is describing whichever fake it
// happened to load. It is fake in the direction reality is:
//
//   * `conversation(id)` returns undefined for an id it never created;
//   * `submit()` rejects a requestId that conversation already settled (the exactly-once guarantee routes rely on);
//   * `createConversation()` throws for a tool-less agent or wrong ownership;
//   * documents materialize from the REAL doc token's `initial()`, so the fake cannot drift from the shape.
//
// The kernel contract itself is exercised for real in factory/intake-boot.test.ts.
import { ConversationMeta } from "../../vendor/engram/app/src/meta.ts";

export function fakeHarness({ settled = [] } = {}) {
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

export async function call(route, harness, body, { token = "t" } = {}) {
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

export const spec = (names) => ({ instructions: `brief for ${names.join(",")}`, tools: names.map((name) => ({ name })) });
