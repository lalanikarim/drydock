// Unit tests for the TS intake port: signature verification, cross-repo
// rejection (gate M3), sender allowlist, and event filtering. No model calls.

import assert from "node:assert/strict";
import net from "node:net";
import { createHmac } from "node:crypto";
import { startIntakeServer, verifyGitHubSignature, isAgentIssueEvent, validateRoutes, MAX_WEBHOOK_BODY_BYTES } from "./intake.ts";

const SECRET = "test-webhook-secret";

function sign(body: Buffer): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

const issueEvent = (repo: string, opts: { action?: string; labels?: string[]; sender?: string } = {}) => ({
  action: opts.action ?? "opened",
  repository: { full_name: repo },
  issue: { number: 42, title: "Test issue", body: "do the thing", labels: (opts.labels ?? ["agent"]).map((name) => ({ name })) },
  ...(opts.sender ? { sender: { login: opts.sender } } : {}),
});

// --- verifyGitHubSignature -------------------------------------------------
{
  const body = Buffer.from('{"x":1}');
  assert.equal(verifyGitHubSignature({ signatureHeader: sign(body), rawBody: body, secret: SECRET }), true, "valid signature");
  assert.equal(verifyGitHubSignature({ signatureHeader: sign(Buffer.from('{"x":2}')), rawBody: body, secret: SECRET }), false, "wrong body digest");
  assert.equal(verifyGitHubSignature({ signatureHeader: undefined, rawBody: body, secret: SECRET }), false, "missing header");
  assert.equal(verifyGitHubSignature({ signatureHeader: sign(body), rawBody: body, secret: "" }), false, "empty secret fails closed");
}

// --- isAgentIssueEvent -----------------------------------------------------
{
  assert.equal(isAgentIssueEvent(issueEvent("o/r")), true, "opened with agent label");
  assert.equal(isAgentIssueEvent(issueEvent("o/r", { labels: ["other"] })), false, "opened without agent label");
  assert.equal(isAgentIssueEvent({ action: "labeled", label: { name: "agent" }, issue: { number: 1 } }), true, "labeled agent");
  assert.equal(isAgentIssueEvent({ action: "edited", issue: { number: 1 } }), false, "edited is ignored");
  assert.equal(isAgentIssueEvent(null), false, "null event");

  // Per-repo eligibility labels (the registry's `eligibilityLabel`, §5.11). drydock self-work uses
  // "build"; without threading this the label was hardcoded and such an issue could never trigger work.
  assert.equal(isAgentIssueEvent(issueEvent("o/r", { labels: ["build"] }), "build"), true, "opened with the repo's own label");
  assert.equal(isAgentIssueEvent(issueEvent("o/r", { labels: ["agent"] }), "build"), false, "a different repo's trigger label must not fire here");
  assert.equal(isAgentIssueEvent({ action: "labeled", label: { name: "build" }, issue: { number: 2 } }, "build"), true, "labeled with the repo's own label");
  assert.equal(isAgentIssueEvent({ action: "labeled", label: { name: "agent" }, issue: { number: 2 } }), true, "absent argument keeps the historical default");
}

// --- server: routes mode ---------------------------------------------------
{
  const dispatched: Array<{ repo: string; n: number }> = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [
      { repo: "alpha/one", secret: SECRET, target: "http://127.0.0.1:1/tasks", token: "t" },
      { repo: "beta/two", secret: "other-secret", target: "http://127.0.0.1:2/tasks", token: "t" },
    ],
    dispatch: async (repo: string, event: any) => { dispatched.push({ repo, n: event.issue.number }); return { submissionId: 1 }; },
  });

  const post = (event: unknown, secret: string) => {
    const body = Buffer.from(JSON.stringify(event));
    return fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body: body.toString(),
    });
  };

  // Happy path: signed with alpha's secret, names alpha/one -> dispatched.
  let res = await post(issueEvent("alpha/one"), SECRET);
  assert.equal(res.status, 202, `expected 202, got ${res.status}: ${await res.text()}`);
  assert.deepEqual(dispatched, [{ repo: "alpha/one", n: 42 }], "dispatched to owning route");

  // Cross-repo naming (M3): signed with alpha's secret but names beta/two.
  res = await post(issueEvent("beta/two"), SECRET);
  assert.equal(res.status, 403, `expected 403 cross-repo, got ${res.status}`);

  // Wrong secret: signed with beta's secret naming alpha/one.
  res = await post(issueEvent("alpha/one"), "other-secret");
  assert.equal(res.status, 403, `expected 403 wrong-secret-naming, got ${res.status}`);

  // Non-agent event: valid signature but no agent label -> 200 not accepted.
  res = await post(issueEvent("alpha/one", { labels: ["other"] }), SECRET);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.accepted, false);

  server.close();
}

// --- server: sender allowlist ----------------------------------------------
{
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [{ repo: "alpha/one", secret: SECRET, target: "http://x/tasks", token: "t", allowedSenders: ["alice"] }],
    dispatch: async () => ({ submissionId: 1 }),
  });
  const body = Buffer.from(JSON.stringify(issueEvent("alpha/one", { sender: "mallory" })));
  const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body: body.toString(),
  });
  assert.equal(res.status, 403, `expected 403 sender not allowlisted, got ${res.status}`);
  server.close();
}

// --- server: per-route eligibility labels ----------------------------------
{
  const dispatched: string[] = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [
      { repo: "alpha/one", secret: SECRET, target: "http://x/tasks", token: "t" },
      { repo: "build/two", secret: "build-secret", target: "http://y/tasks", token: "t", eligibilityLabel: "build" },
    ],
    dispatch: async (repo: string) => { dispatched.push(repo); return { submissionId: 1 }; },
  });
  const post = (event: unknown, secret: string) => {
    const body = Buffer.from(JSON.stringify(event));
    return fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
      body: body.toString(),
    });
  };

  // The build-labelled issue on the route declaring eligibilityLabel "build" is accepted…
  let res = await post(issueEvent("build/two", { labels: ["build"] }), "build-secret");
  assert.equal(res.status, 202, `expected 202 for repo-specific label, got ${res.status}: ${await res.text()}`);

  // …and an "agent"-labelled issue on that same route is NOT: labels are per repo, not global.
  res = await post(issueEvent("build/two", { labels: ["agent"] }), "build-secret");
  assert.equal(res.status, 200, "wrong label for this route must be ignored, not dispatched");
  assert.equal((await res.json()).accepted, false);

  // A route with no eligibilityLabel keeps defaulting to "agent" (fixtures unchanged).
  res = await post(issueEvent("alpha/one", { labels: ["agent"] }), SECRET);
  assert.equal(res.status, 202, "default label must stay 'agent'");
  assert.deepEqual(dispatched, ["build/two", "alpha/one"]);

  server.close();
}

// --- validateRoutes rejects a blank eligibility label ----------------------
{
  const { validateRoutes } = await import("./intake.ts");
  assert.throws(() => validateRoutes([{ repo: "a/b", secret: "s", eligibilityLabel: "  " }]), /eligibilityLabel must be a non-empty string/);
  assert.throws(() => validateRoutes([{ repo: "a/b", secret: "s", eligibilityLabel: 42 } as any]), /eligibilityLabel must be a non-empty string/);
  validateRoutes([{ repo: "a/b", secret: "s", eligibilityLabel: "build" }]);
}

// --- server: non-loopback requires auth ------------------------------------
{
  assert.throws(
    () => startIntakeServer({ port: 0, host: "0.0.0.0", dispatch: async () => ({}) }),
    /refusing to bind/,
    "non-loopback without secret must refuse to start",
  );
}

// --- server: exposure hardening (issue #57) ----------------------------------
{
  const dispatched: string[] = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [{ repo: "alpha/one", secret: SECRET, target: "http://x/tasks", token: "t" }],
    dispatch: async (repo: string) => { dispatched.push(repo); return { submissionId: 1 }; },
  });

  // /health stays an unauthenticated liveness probe but must not name the
  // configured repositories: assume any published listener is internet-reachable.
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200, "unauthenticated liveness must stay 200");
  const healthBody = await health.text();
  assert.ok(!healthBody.includes("alpha/one"), `/health disclosed a configured repo: ${healthBody}`);
  assert.match(healthBody.toLowerCase(), /ok|alive|healthy|up/, `liveness payload unclear: ${healthBody}`);

  // Raw-socket exchange. fetch() cannot report a status for a connection the
  // server tears down mid-upload, so drive the socket directly. When the
  // server refuses early, "error" and "data" race — never let an EPIPE win
  // over a status line that already arrived, and never leave a socket error
  // unhandled (a refused request erroring out is the expected outcome).
  const rawExchange = (opts: { headers: string; onConnect: (sock: net.Socket, isClosed: () => boolean) => void }) =>
    new Promise<{ status?: number; raw: string }>((resolveX) => {
      const sock = net.connect(port, "127.0.0.1");
      let got = "";
      let settled = false;
      let closed = false;
      const statusOf = () => (got.match(/HTTP\/1\.[01] (\d{3})/) ?? [])[1];
      const done = (r: { status?: number; raw: string }) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolveX(r);
      };
      const settleIfAnswered = () => {
        const s = statusOf();
        if (s) done({ status: Number(s), raw: got });
        return Boolean(s);
      };
      // The server may reset the socket while we are still writing; give it a
      // beat to deliver an already-sent status line before giving up.
      const lament = (why: string) => setTimeout(() => (settleIfAnswered() ? undefined : done({ raw: `${why}: ${got.slice(0, 200)}` })), 150);
      sock.on("data", (d) => { got += d.toString("latin1"); settleIfAnswered(); });
      sock.on("error", () => { closed = true; lament("socket error"); });
      sock.on("close", () => { closed = true; lament("connection closed"); });
      sock.on("connect", () => {
        sock.write(`POST /webhook/github HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${opts.headers}`);
        opts.onConnect(sock, () => closed);
      });
      setTimeout(() => (settleIfAnswered() ? undefined : done({ raw: `no response within timeout: ${got.slice(0, 200)}` })), 5000);
    });

  // Declared Content-Length over the cap: the 413 must come from the headers
  // alone — it arrives before any of the payload does.
  {
    const r = await rawExchange({
      headers: `content-type: application/json\r\ncontent-length: ${MAX_WEBHOOK_BODY_BYTES + 1}\r\nx-hub-signature-256: sha256=deadbeef\r\n\r\n`,
      onConnect: (sock) => sock.write('{"a":'),
    });
    assert.equal(r.status, 413, `expected 413 before the body arrives, got ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(dispatched.length, 0, "a refused body must never be dispatched");
  }

  // Chunked stream with no Content-Length: pump frames until the server stops
  // us. It must stop well under 2 MB (buffering would let all of it through);
  // a status line, if one arrives, must be 413 — but an implementation that
  // answers and then tears down is correct even if the client never sees it.
  {
    let written = 0;
    const r = await rawExchange({
      headers: "content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n",
      onConnect: (sock, isClosed) => {
        const frame = Buffer.alloc(32 * 1024, 0x61);
        const pump = () => {
          if (isClosed() || written > 8 * 1024 * 1024) return;
          sock.write(`${frame.length.toString(16)}\r\n`);
          sock.write(frame, () => {
            written += frame.length;
            sock.write("\r\n", () => { if (!isClosed()) setImmediate(pump); });
          });
        };
        pump();
      },
    });
    assert.ok(written < 2 * 1024 * 1024, `server let ${written} bytes through before refusing — that is buffering, not capping`);
    if (r.status !== undefined) assert.equal(r.status, 413, `a status line on an over-cap stream must be 413, got ${r.status}`);
    assert.equal(dispatched.length, 0, "a cut-off stream must never be dispatched");
  }

  // Regression: a signed body comfortably under the cap still dispatches.
  {
    const body = Buffer.from(JSON.stringify(issueEvent("alpha/one")));
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      body: body.toString(),
    });
    assert.equal(res.status, 202, `expected 202 under the cap, got ${res.status}: ${(await res.text()).slice(0, 200)}`);
    assert.deepEqual(dispatched, ["alpha/one"]);
  }

  server.close();
}

// --- PR feedback (#67): a `/factory …` comment on an open PR is opt-in work -----------------
{
  const prComment = (repo: string, body: string, sender = { login: "lalanikarim", type: "User" }) => ({
    action: "created",
    repository: { full_name: repo },
    issue: { number: 42, pull_request: { url: `https://api.github.com/repos/${repo}/pulls/42` } },
    comment: { id: 900, body },
    sender,
  });

  const calls: Array<{ repo: string; body: string }> = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [
      // The bot login is deliberately allowlisted below: the point of that case is that the bot guard
      // fires even for a sender the allowlist would let through.
      { repo: "alpha/one", secret: SECRET, target: "http://127.0.0.1:1/tasks", token: "t", allowedSenders: ["lalanikarim", "drydock-factory[bot]"], prFeedback: true },
      // Same sender, same signature scheme — but feedback was never enabled here.
      { repo: "beta/two", secret: "other-secret", target: "http://127.0.0.1:2/tasks", token: "t", allowedSenders: ["lalanikarim"] },
    ],
    dispatch: async (repo: string, event: any) => {
      calls.push({ repo, body: event.comment.body });
      return { submissionId: 7 };
    },
  });

  const postTo = async (p: number, event: unknown, secret: string) => {
    const raw = Buffer.from(JSON.stringify(event));
    const res = await fetch(`http://127.0.0.1:${p}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` },
      body: raw.toString(),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };

  // Accepted: enabled repo + command present → 202 and a pr-feedback task request id.
  {
    const r = await postTo(port, prComment("alpha/one", "/factory rebase"), SECRET);
    assert.equal(r.status, 202, `a /factory comment on an opted-in repo must be accepted, got ${r.status}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.kind, "pr-feedback");
    assert.equal(r.json.requestId, "pr-42-c-900", "the request id carries the comment id, so redelivery is exactly-once per comment");
    assert.deepEqual(calls.at(-1), { repo: "alpha/one", body: "/factory rebase" });
  }

  // Refused: same comment on a repo that never opted in (200, not 202; nothing dispatched).
  {
    const before = calls.length;
    const r = await postTo(port, prComment("beta/two", "/factory rebase"), "other-secret");
    assert.equal(r.status, 200, `feedback on a non-opted-in repo must not be accepted, got ${r.status}`);
    assert.equal(r.json.accepted, false);
    assert.match(r.json.reason, /not enabled/);
    assert.equal(calls.length, before, "a refused comment must never reach dispatch");
  }

  // Refused: prose on an opted-in repo (no command) — the common case of normal review discussion.
  {
    const r = await postTo(port, prComment("alpha/one", "could we maybe rebase this?"), SECRET);
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, false);
    assert.match(r.json.reason, /does not start with \/factory/);
  }

  // Refused: a bot author, even an allowlisted one — comment-triggered pipelines loop.
  {
    const r = await postTo(port, prComment("alpha/one", "/factory rebase", { login: "drydock-factory[bot]", type: "Bot" }), SECRET);
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, false);
    assert.match(r.json.reason, /bot/i);
  }

  // Sender allowlist still applies to comment events (403 before any parsing of intent).
  {
    const r = await postTo(port, prComment("alpha/one", "/factory rebase", { login: "stranger", type: "User" }), SECRET);
    assert.equal(r.status, 403, `a non-allowlisted commenter must be rejected outright, got ${r.status}`);
  }

  server.close();
}

// A policy refusal decided after the state check is a 200 (no retry), not a 502.
{
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [{ repo: "alpha/one", secret: SECRET, target: "http://127.0.0.1:1/tasks", token: "t", prFeedback: true }],
    dispatch: async () => ({ accepted: false, reason: "PR #42 is CLOSED, not OPEN" }),
  });
  const raw = Buffer.from(JSON.stringify({
    action: "created",
    repository: { full_name: "alpha/one" },
    issue: { number: 42, pull_request: {} },
    comment: { id: 1, body: "/factory rebase" },
    sender: { login: "lalanikarim", type: "User" },
  }));
  const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
    body: raw.toString(),
  });
  const json = await res.json() as any;
  assert.equal(res.status, 200, `a refusal that will repeat identically must not ask GitHub to retry (got ${res.status})`);
  assert.equal(json.accepted, false);
  assert.match(json.reason, /CLOSED/);
  server.close();
}

// prFeedback is a safety-shaped flag: a string "false" must not enable it (the R6 lesson).
{
  assert.throws(
    () => validateRoutes([{ repo: "a/b", secret: "s", prFeedback: "false" as any }]),
    /prFeedback must be a boolean/,
    'prFeedback: "false" would be truthy and silently enable a comment trigger nobody asked for',
  );
  validateRoutes([{ repo: "a/b", secret: "s", prFeedback: false }]);
}

console.log("intake (TS port): all checks passed");
