// #169 — G5's refusal state was permanently `unknown`.
//
// Two things had to be true for that, and both were:
//
//   1. The read assumed a `refused: false` field. Production does not emit one — success is announced by `prUrl`. Both
//      payload shapes here are copied verbatim from production tool results into test/fixtures/g5/production/, so this
//      file asserts against what the tool returns, not what we expected it to return.
//   2. The read polled only the root conversation. On the live instance, `/conversations` listed 22 conversations with
//      exactly one `isRoot: true`, and an intake-driven run lived in a non-root conversation of its own — so a
//      root-only poll can be structurally blind regardless of payload.
//
// The server below is a real HTTP server on a real ephemeral port speaking the recorded response shapes
// (`{conversations:[{id,isRoot,…}]}`, `{conversationId, entries:[{id,kind,model}], hasMore}`); ids and names are
// invented, keys are not. Nothing here stubs a function to agree with itself: the code under test makes real requests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { findToolResultAcrossConversations, waitForToolResult } from "../gates/lib.ts";
import { refusalState } from "../gates/g5-traps.mjs";

const REFUSED = readFileSync(new URL("./fixtures/g5/production/open-draft-pr-refused.json", import.meta.url), "utf8").trim();
const OPENED = readFileSync(new URL("./fixtures/g5/production/open-draft-pr-pr-url.json", import.meta.url), "utf8").trim();

const toolResult = (id, toolName, text, { isError = false } = {}) => ({
  conversationId: null, // filled by the server
  id,
  kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId: `call-${id}`, toolName, isError, timestamp: 1, content: [{ type: "text", text }] }],
});

/**
 * Serve a recorded-shaped conversations API. `conversations` maps id → { isRoot, entries }.
 * `failFor` makes one conversation's entries endpoint return 500 (the hostile sibling case).
 */
async function startRecordedApi({ conversations, failFor = null }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/conversations") {
      // Newest-first, as production serves it: keys are given oldest-first here on purpose.
      const ids = [...conversations.keys()].sort((a, b) => b - a);
      return json(200, { conversations: ids.map((id) => ({ id, isRoot: conversations.get(id).isRoot === true, ownedByTask: false, lastEntryId: 1, name: `conversation-${id}`, cwd: "/tmp", sandbox: "off", createdAt: 1, model: null, openSubmissions: 0 })) });
    }
    const m = url.pathname.match(/^\/conversations\/(\d+)\/entries$/);
    if (m) {
      const id = Number(m[1]);
      if (!conversations.has(id)) return json(404, { error: "no such conversation" });
      if (failFor === id) return json(500, { error: "boom" });
      // Entries come descending, like the real endpoint.
      const entries = conversations.get(id).entries.map((e) => ({ ...e, conversationId: id })).sort((a, b) => b.id - a.id);
      return json(200, { conversationId: id, entries, hasMore: false });
    }
    json(404, { error: "no route" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("a result in a non-root conversation is invisible to the root-scoped read and visible to the scan (#169)", async () => {
  // Topology copied from the live instance: one old root, and an intake run in its own newer conversation.
  const conversations = new Map([
    [1, { isRoot: true, entries: [toolResult(10, "bash", "ls output")] }],
    [1145, { isRoot: false, entries: [toolResult(77, "delegate", "{}"), toolResult(90, "open_draft_pr", OPENED)] }],
  ]);
  const api = await startRecordedApi({ conversations });
  try {
    // The blind spot, demonstrated rather than asserted about.
    await assert.rejects(() => waitForToolResult(api.base, "t", 1, "open_draft_pr", () => true, 1_500), /no matching open_draft_pr result/);

    const found = await findToolResultAcrossConversations(api.base, "t", "open_draft_pr", () => true);
    assert.ok(found, "the scan must find what the root poll missed");
    assert.equal(found.conversationId, 1145);
    assert.equal(found.isError, false);
    assert.deepEqual(JSON.parse(found.text).prUrl, JSON.parse(OPENED).prUrl);
  } finally {
    await api.close();
  }
});

test("a conversation whose entries endpoint fails is skipped loudly, not silently", async () => {
  // The failing conversation must be visited before the match: the scan runs newest-first and stops at the first hit,
  // so a failure in an older sibling would legitimately never be reported.
  const conversations = new Map([
    [1, { isRoot: true, entries: [] }],
    [3, { isRoot: false, entries: [toolResult(5, "open_draft_pr", REFUSED)] }],
    [4, { isRoot: false, entries: [] }],
  ]);
  const api = await startRecordedApi({ conversations, failFor: 4 });
  const warnings = [];
  try {
    const found = await findToolResultAcrossConversations(api.base, "t", "open_draft_pr", () => true, (m) => warnings.push(m));
    assert.ok(found, "a broken sibling must not end the search");
    assert.equal(found.conversationId, 3);
    assert.ok(warnings.some((w) => /conversation 4/.test(w) && /500/.test(w)), `expected a warning naming the failing conversation, got ${JSON.stringify(warnings)}`);
  } finally {
    await api.close();
  }
});

test("a tool result that errored is unknown with the error text, never a refusal", () => {
  const r = refusalState({ outcomeText: "ENOENT: no such file or directory", toolErrored: true });
  assert.equal(r.refused, "unknown");
  assert.match(r.reason, /errored/);
  assert.match(r.reason, /ENOENT/);
});

// ── the payload-level read, over both real production payloads ─────────────────────────────────────────────────────

test("the real refusal payload reads as refused", () => {
  const r = refusalState({ outcomeText: REFUSED });
  assert.equal(r.refused, "true");
  assert.match(r.reason, /open_draft_pr refused/);
  assert.ok(String(r.parsed.reason).length > 0, "the reason the tool gave is carried through for the run record");
});

test("the real success payload reads as not refused — this is what every run ever made got wrong", () => {
  // The old read was: parsed.refused === false ? "false" : "unknown". This payload has no `refused` key at all.
  assert.equal(JSON.parse(OPENED).refused, undefined, "fixture must stay the production shape: success carries prUrl, not refused:false");
  const r = refusalState({ outcomeText: OPENED });
  assert.equal(r.refused, "false", r.reason);
  assert.match(r.reason, /open_draft_pr opened https/);
});

test("JSON with neither field is unknown and says what it saw", () => {
  const r = refusalState({ outcomeText: JSON.stringify({ ok: true, note: "unexpected" }) });
  assert.equal(r.refused, "unknown");
  assert.match(r.reason, /neither .refused. nor .prUrl./);
  assert.match(r.reason, /unexpected/);
});

test("no tool result at all: a PR on the branch settles it, nothing does not", () => {
  const withPr = refusalState({ prNumber: 83 });
  assert.equal(withPr.refused, "false");
  assert.match(withPr.reason, /PR #83 exists/);

  const withoutPr = refusalState({});
  assert.equal(withoutPr.refused, "unknown");
  assert.match(withoutPr.reason, /no open_draft_pr result/);
});

test("whitespace-only outcome is treated as no outcome, not as unparsable JSON", () => {
  assert.equal(refusalState({ outcomeText: "   \n " }).refused, "unknown");
  assert.match(refusalState({ outcomeText: "   " }).reason, /no open_draft_pr result/);
});
