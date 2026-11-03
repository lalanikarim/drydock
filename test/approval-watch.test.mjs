// #188 — "a run is waiting on a human" must become an event, not a mystery.
//
// The incident: a reviewer's `submit_verdict` was blocked pending approval for ~40 minutes. `/health` said ok,
// no alert fired, and the store read `reviewer never called submit_verdict` — which blames the model for what
// the gate did, and invites a retry that cannot possibly help (same call → same block; reword it and the
// sha1(tool+args) key changes to one nobody approved).
//
// These tests drive REAL HTTP servers: an instance-shaped `/approvals` endpoint (including ones that refuse,
// return junk, or omit fields) and a Telegram-API-shaped stub for delivery. The thing being tested is what the
// fleet does with a live dependency, so a stubbed fetch would only describe an assumption.
//
//   node --experimental-strip-types --test test/approval-watch.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalWatcher, buildApprovalWatcher, parseApprovalsBody, readRoutesForWatch } from "../factory/approval-watch.ts";
import { renderNotifyMessage, notifyEventKey, createNotifier } from "../factory/notify-telegram.ts";

function server(handler) {
  const s = createServer(handler);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port, url: `http://127.0.0.1:${s.address().port}` })));
}

const collect = () => {
  const events = [];
  return { events, notify: async (e) => { events.push(e); } };
};

// --- parsing ----------------------------------------------------------------
test("parseApprovalsBody reads what the instance actually returns and drops entries nobody could approve", () => {
  const items = parseApprovalsBody({
    approvals: [
      { key: "74944fe45911", tool: "submit_verdict", tier: "destructive", args: { verdict: "pass" } },
      { key: "8ce583c1e1c9", tool: "edit" }, // pre-tier marker: no tier field at all
      { tool: "bash" }, // keyless → cannot be approved → alerting on it wastes the operator's time
      null,
      "junk",
    ],
  });
  assert.deepEqual(items.map((i) => i.key), ["74944fe45911", "8ce583c1e1c9"]);
  assert.equal(items[0].tier, "destructive");
  assert.equal(items[1].tier, undefined);
});

test("an unrecognized body is NOT read as 'nothing pending'", () => {
  for (const junk of [{}, { approvals: "yes" }, [], null, { approvals: {} }]) {
    assert.deepEqual(parseApprovalsBody(junk), []);
  }
});

// --- the watch loop ---------------------------------------------------------
test("each pending key is announced exactly once; a second pass over the same state is silent", async () => {
  const inst = await server((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ approvals: [{ key: "74944fe45911", tool: "submit_verdict", tier: "destructive" }, { key: "dc0fcf59f723", tool: "open_draft_pr", tier: "destructive" }] }));
  });
  const { events, notify } = collect();
  const w = new ApprovalWatcher({ targets: () => [{ repo: "lalanikarim/engram", target: inst.url }], notify, log: () => {} });

  const first = await w.check();
  assert.deepEqual(first.alerted.sort(), ["74944fe45911", "dc0fcf59f723"]);
  assert.equal(first.pending, 2);
  assert.equal(first.failures.length, 0);

  const second = await w.check();
  assert.deepEqual(second.alerted, [], "a standing condition must not nag every interval — that is how operators learn to mute alerts");
  assert.equal(second.pending, 2, "still pending; the count keeps reporting even when the alert does not");

  assert.equal(events.length, 2);
  const e = events.find((x) => x.key === "74944fe45911");
  assert.equal(e.kind, "approval_blocked");
  assert.equal(e.tool, "submit_verdict");
  assert.equal(e.tier, "destructive");
  w.stop();
  await new Promise((r) => inst.s.close(r));
});

test("a blocked call that resolves and a NEW one appearing are different news", async () => {
  let pending = [{ key: "aaa111bbb222", tool: "edit", tier: "prompt" }];
  const inst = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ approvals: pending })); });
  const { events, notify } = collect();
  const w = new ApprovalWatcher({ targets: () => [{ repo: "o/a", target: inst.url }], notify, log: () => {} });

  await w.check();
  pending = []; // operator denied it
  const cleared = await w.check();
  assert.deepEqual(cleared.alerted, []);
  assert.equal(cleared.pending, 0);

  pending = [{ key: "ccc333ddd444", tool: "open_draft_pr" }];
  const next = await w.check();
  assert.deepEqual(next.alerted, ["ccc333ddd444"], "a different blocked call is a different key and must alert");
  assert.equal(events.length, 2);
  w.stop();
  await new Promise((r) => inst.s.close(r));
});

test("hostile instances: refusal, junk body and timeout are failures, never 'nothing pending', and never throw", async () => {
  const denies = await server((req, res) => {
    // The instance requires bearer auth (#122); a watcher that forgot the token must report that, not "0 pending".
    if (req.headers.authorization !== "Bearer right-token") { res.writeHead(401); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ approvals: [{ key: "ok1", tool: "submit_verdict" }] }));
  });
  const junk = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("<html>not json</html>"); });
  const dead = { repo: "o/gone", target: "http://127.0.0.1:1" };

  const { events, notify } = collect();
  const w = new ApprovalWatcher({
    targets: () => [
      { repo: "o/denied", target: denies.url }, // no token → 401
      { repo: "o/junk", target: junk.url },
      dead,
    ],
    notify,
    log: () => {},
  });

  const r = await w.check();
  assert.equal(r.checked, 0, "nothing was read successfully");
  assert.equal(r.alerted.length, 0);
  assert.equal(r.failures.length, 3, `every unreadable target must be named: ${JSON.stringify(r.failures)}`);
  assert.match(r.failures.join("\n"), /o\/denied: HTTP 401/);

  // Same endpoint, with the token it expects: proves the failure above was the credential, not the parser.
  const ok = new ApprovalWatcher({ targets: () => [{ repo: "o/denied", target: denies.url, token: "right-token" }], notify, log: () => {} });
  const good = await ok.check();
  assert.deepEqual(good.alerted, ["ok1"]);
  assert.equal(events.length, 1);

  await new Promise((r2) => denies.s.close(r2));
  await new Promise((r2) => junk.s.close(r2));
});

// --- route plumbing ---------------------------------------------------------
// The target list comes from the routes FILE on every pass. This is a defect found by deploying the first
// version and watching it alert about nothing: the adapter adopts in-memory `target` values only inside the
// per-request drift check (#81), so with no webhook traffic an instance's freshly published port never reaches
// that array — and four genuinely pending approvals went unreported.
test("targets are re-read from the routes file each pass, including late-arriving ports and #185 markers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-watch-"));
  const file = join(dir, "routes.json");
  const live = await server((req, res) => {
    if (req.headers.authorization !== "Bearer tok-live") { res.writeHead(401); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ approvals: [{ key: "74944fe45911", tool: "submit_verdict", tier: "destructive" }] }));
  });
  const { events, notify } = collect();

  // Pass 1: the instance has not published a port yet (boot), and another repo is quarantined.
  writeFileSync(file, JSON.stringify([{ repo: "o/live" }, { repo: "o/sick", quarantined: "unknown config field: x" }]));
  const w = buildApprovalWatcher(file, { notify, log: () => {} });
  const first = await w.check();
  assert.equal(first.checked, 0, "no target to ask yet");
  assert.deepEqual(first.alerted, []);

  // Pass 2: the instance became ready — same watcher, no restart, no webhook needed to notice.
  writeFileSync(file, JSON.stringify([{ repo: "o/live", target: live.url, token: "tok-live" }, { repo: "o/sick", quarantined: "unknown config field: x" }]));
  const second = await w.check();
  assert.deepEqual(second.alerted, ["74944fe45911"], `the late port must be polled; got ${JSON.stringify(second)}`);
  assert.equal(events.length, 1);

  // A missing or corrupt file is "nothing to ask", never a crash next to webhook serving.
  writeFileSync(file, "{ half-written");
  assert.deepEqual(readRoutesForWatch(file), []);
  rmSync(file, { force: true });
  assert.deepEqual(readRoutesForWatch(file), []);

  w.stop();
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => live.s.close(r));
});

// --- delivery ---------------------------------------------------------------
test("the alert message carries the key AND the command, and dedupes by key", async () => {
  const e = { kind: "approval_blocked", repo: "lalanikarim/engram", key: "74944fe45911", tool: "submit_verdict", tier: "destructive" };
  const msg = renderNotifyMessage(e);
  assert.match(msg, /waiting on approval 74944fe45911/);
  assert.match(msg, /submit_verdict, destructive/);
  assert.match(msg, /POST \/approvals\/74944fe45911/, "the message must be actionable without reading a doc");

  assert.equal(notifyEventKey(e), "approval_blocked:lalanikarim/engram:74944fe45911");
  assert.notEqual(notifyEventKey({ ...e, key: "other" }), notifyEventKey(e));
});

test("delivery is real HTTP to the Telegram API and happens once per key", async () => {
  const hits = [];
  const api = await server((req, res) => {
    let body = "";
    req.on("data", (d) => (body += String(d)));
    req.on("end", () => { hits.push(body); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: { message_id: 9007 } })); });
  });
  const logs = [];
  const notify = createNotifier({
    token: "bot-token",
    chatId: "111111",
    log: (l) => logs.push(l),
    env: { TELEGRAM_API_BASE: api.url }, // drill seam (#160): never message a real operator from a test
  });
  assert.ok(notify, "notifier must exist when credentials are supplied");

  const ev = { kind: "approval_blocked", repo: "o/a", key: "74944fe45911", tool: "submit_verdict" };
  await notify(ev);
  await notify(ev); // same key → suppressed by the dedupe table
  await notify({ ...ev, key: "dc0fcf59f723" });

  assert.equal(hits.length, 2, `one send per distinct approval key, got ${hits.length}`);
  assert.match(hits[0], /74944fe45911/);
  assert.ok(logs.some((l) => /telegram delivered approval_blocked message_id=9007/.test(l)), `delivery must be logged with the id: ${logs.join(" | ")}`);

  await new Promise((r) => api.s.close(r));
});
