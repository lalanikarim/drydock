// The route dispatcher's decision path (#67): what actually gets POSTed to a factory instance, and
// what is refused before anything is POSTed.
//   node --experimental-strip-types --test test/route-dispatch.test.mjs
//
// This is where a PR-comment trigger becomes real work, so it is also where the dangerous questions
// land: does a closed pull request start a run? does a comment on somebody's feature branch? does a
// repo that never opted in get reached by another repo's webhook? Every refusal here must happen
// before the POST, because a task submission starts inference — the expensive, side-effecting part.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeRouteDispatch } from "../factory/adapter.ts";
import { gitAuthFromToken } from "../factory/github-auth.ts";

const FACTS = {
  number: 42,
  state: "OPEN",
  isDraft: true,
  headRefName: "agent/issue-7",
  baseRefName: "main",
  headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  mergeable: "CLEAN",
  mergeStateStatus: "BEHIND",
};

async function startInstance() {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, authorization: req.headers.authorization ?? null, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ submissionId: 11 }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
}

const issueEvent = { action: "labeled", label: { name: "agent" }, repository: { full_name: "o/a" }, issue: { number: 3, title: "Add sorting", body: "sort it" }, sender: { login: "lalanikarim" } };

const commentEvent = (body = "/factory rebase") => ({
  action: "created",
  repository: { full_name: "o/a" },
  issue: { number: 42, pull_request: {} },
  comment: { id: 7, body },
  sender: { login: "lalanikarim", type: "User" },
});

test("a labeled issue dispatches the issue task it always did", async () => {
  const inst = await startInstance();
  try {
    const routes = [{ repo: "o/a", secret: "s", target: inst.url, token: "instance-token" }];
    const result = await makeRouteDispatch(routes, { gitAuth: gitAuthFromToken("ghs_x") })("o/a", issueEvent);
    assert.deepEqual(result, { submissionId: 11 });
    assert.equal(inst.hits.length, 1);
    assert.equal(inst.hits[0].authorization, "Bearer instance-token");
    // #122: intake goes to the factory's own route, which scopes a conversation per (kind, subject).
    // Posting this to the kernel's /tasks would put every issue in the fleet into one shared transcript.
    assert.equal(inst.hits[0].url, "/factory/intake");
    const sent = JSON.parse(inst.hits[0].body);
    assert.equal(sent.kind, "issue");
    assert.equal(sent.subject, "#3", "the subject is what makes the conversation stable across redelivery");
    assert.equal(sent.requestId, "issue-3");
    assert.match(sent.content, /Work on GitHub issue number: 3/);
    assert.match(sent.content, /<untrusted>/);
  } finally {
    inst.close();
  }
});

test("an authorized PR comment dispatches a rework task carrying the verified facts", async () => {
  const inst = await startInstance();
  const seen = [];
  try {
    const routes = [{ repo: "o/a", secret: "s", target: inst.url, token: "t", prFeedback: true }];
    const result = await makeRouteDispatch(routes, {
      gitAuth: gitAuthFromToken("ghs_app"),
      fetchPr: async (repo, n, token) => { seen.push({ repo, n, token }); return FACTS; },
    })("o/a", commentEvent());
    assert.deepEqual(result, { submissionId: 11 });
    assert.equal(inst.hits[0].url, "/factory/intake");
    const sent = JSON.parse(inst.hits[0].body);
    assert.equal(sent.kind, "pr-feedback");
    assert.equal(sent.subject, "#42");
    assert.equal(sent.requestId, "pr-42-c-7", "the task is scoped to the comment, so redelivery cannot double-run");
    assert.match(sent.content, /PR feedback request/);
    assert.match(sent.content, /head branch: agent\/issue-7 at a1b2c3d4e5f6/);
    assert.match(sent.content, /Directive parsed by the host.*rebase/);
    assert.deepEqual(seen, [{ repo: "o/a", n: 42, token: "ghs_app" }], "state is read with the factory's own credential");
  } finally {
    inst.close();
  }
});

test("a closed PR, a human branch and an unreadable PR are refused before any POST", async () => {
  for (const [what, facts] of [
    ["closed", { ...FACTS, state: "CLOSED" }],
    ["human branch", { ...FACTS, headRefName: "feature/billing" }],
    ["unreadable", null],
  ]) {
    const inst = await startInstance();
    try {
      const routes = [{ repo: "o/a", secret: "s", target: inst.url, token: "t", prFeedback: true }];
      const result = await makeRouteDispatch(routes, { gitAuth: gitAuthFromToken("ghs_x"), fetchPr: async () => facts })("o/a", commentEvent());
      assert.equal(result.accepted, false, `${what}: must not be accepted`);
      assert.ok(result.reason, `${what}: a refusal must say why`);
      assert.equal(inst.hits.length, 0, `${what}: nothing may reach the instance — a submission starts inference`);
    } finally {
      inst.close();
    }
  }
});

test("a repo without prFeedback never has its PR state read at all", async () => {
  const inst = await startInstance();
  let fetched = 0;
  try {
    const routes = [{ repo: "o/a", secret: "s", target: inst.url, token: "t" }];
    const result = await makeRouteDispatch(routes, {
      gitAuth: gitAuthFromToken("ghs_x"),
      fetchPr: async () => { fetched += 1; return FACTS; },
    })("o/a", commentEvent());
    assert.equal(result.accepted, false);
    assert.match(result.reason, /not enabled/);
    assert.equal(fetched, 0, "opt-out means no work at all, not a check performed later");
    assert.equal(inst.hits.length, 0);
  } finally {
    inst.close();
  }
});

test("dispatch re-applies the classifier instead of trusting its caller", async () => {
  const inst = await startInstance();
  try {
    const routes = [{ repo: "o/a", secret: "s", target: inst.url, token: "t" }];
    // An unlabeled issue event: intake would never have accepted it, and the dispatcher agrees.
    const result = await makeRouteDispatch(routes, { gitAuth: gitAuthFromToken("ghs_x") })("o/a", { action: "edited", repository: { full_name: "o/a" }, issue: { number: 9 } });
    assert.equal(result.accepted, false);
    assert.equal(inst.hits.length, 0);
  } finally {
    inst.close();
  }
});

test("a missing route target is an error, not a silent drop", async () => {
  const routes = [{ repo: "o/a", secret: "s" }];
  await assert.rejects(
    () => makeRouteDispatch(routes, { gitAuth: gitAuthFromToken("ghs_x") })("o/a", issueEvent),
    /no instance target configured for o\/a/,
    "the message names the repo and makes clear nothing was posted",
  );
});
