// End-to-end proof of #133's second half: a probe edge must become a delivered alert, in BOTH directions.
//
// This is not a stub-of-my-own-logic test. It runs the real `InferenceProber` wired to the real
// `createNotifier`, exactly as `factory/adapter.ts` wires them, against two local HTTP servers: one shaped like
// an OpenAI-compatible provider (`GET /models`) and one shaped like the Telegram Bot API (records the POST, hands
// back a message id). Nothing external is contacted, and no operator's phone is involved — that is what the loud
// `TELEGRAM_API_BASE` override exists for.
//
// The direction this file most wants to catch is recovery: with the old catch-all dedupe key, "inference
// unreachable" arrived and "inference reachable" never did, because every inference alert shared one key built
// from fields `inference_state` does not have.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const { InferenceProber } = await import("../factory/inference-probe.ts");
const { createNotifier } = await import("../factory/notify-telegram.ts");

const TOKEN = "999:AA-test-token-for-local-proof";

/** An OpenAI-compatible endpoint whose reachability the test controls. */
function fakeProvider(name) {
  const state = { up: true, requests: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    if (!state.up) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model overloaded" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: `${name}-model-a` }, { id: `${name}-model-b` }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        name,
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A Telegram Bot API stand-in: records every sendMessage body and issues incrementing message ids. */
function fakeTelegramApi() {
  const messages = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!req.url?.startsWith("/bot")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw || "{}");
      messages.push({ url: req.url, ...body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + messages.length } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, messages, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test("probe edges deliver one alert each — outage, degradation, and the recovery the old key swallowed", async () => {
  const [a, b, tg] = await Promise.all([fakeProvider("alpha"), fakeProvider("beta"), fakeTelegramApi()]);
  const logs = [];
  try {
    // Wired the way the adapter wires it: transition → notifier. No timers involved; check() drives the edges.
    const notifier = createNotifier({
      token: TOKEN,
      chatId: "123456789",
      env: { TELEGRAM_API_BASE: tg.base },
      log: (l) => logs.push(l),
    });
    assert.ok(notifier, "a notifier must exist when credentials are present");

    const prober = new InferenceProber({
      providers: [
        { id: "alpha", baseUrl: a.baseUrl },
        { id: "beta", baseUrl: b.baseUrl },
      ],
      timeoutMs: 2_000,
      onTransition: (next) => {
        void notifier?.({ kind: "inference_state", state: next.state, reachable: next.reachable, total: next.total });
      },
      log: (l) => logs.push(l),
    });

    const settle = async () => { await new Promise((r) => setTimeout(r, 60)); };

    // 1 — healthy at startup: the first result is announced on purpose ("unreachable at boot" must be heard).
    let agg = await prober.check();
    assert.equal(agg.state, "reachable");
    await settle();
    assert.equal(tg.messages.length, 1, "startup state announces itself once");

    // A repeat with no transition must not send again — this is the dedupe doing its job, not hiding anything.
    await prober.check();
    await settle();
    assert.equal(tg.messages.length, 1, "no edge, no message");

    // 2 — one endpoint down: degraded.
    b.state.up = false;
    agg = await prober.check();
    assert.equal(agg.state, "degraded");
    await settle();
    assert.match(tg.messages.at(-1).text, /inference degraded \(1\/2/);

    // 3 — both down: unreachable.
    a.state.up = false;
    agg = await prober.check();
    assert.equal(agg.state, "unreachable");
    await settle();
    assert.match(tg.messages.at(-1).text, /inference unreachable \(0\/2/);

    // 4 — recovery. THIS is the message the catch-all dedupe key deleted.
    a.state.up = true;
    b.state.up = true;
    agg = await prober.check();
    assert.equal(agg.state, "reachable");
    await settle();
    assert.match(tg.messages.at(-1).text, /inference reachable \(2\/2/);

    // Exactly four alerts — no per-minute spam while the state sat unchanged.
    assert.equal(tg.messages.length, 4, tg.messages.map((m) => m.text).join(" | "));
    for (const m of tg.messages) {
      assert.equal(m.chat_id, "123456789");
      assert.match(m.url, /^\/bot/);
    }

    // Success is auditable: each delivery logged with the id Telegram assigned.
    const delivered = logs.filter((l) => l.includes("telegram delivered inference_state"));
    assert.equal(delivered.length, 4, delivered.join(" | "));
    assert.match(delivered.join("\n"), /message_id=1004/);

    // The override is loud, and the token never reaches the log.
    assert.equal(logs.filter((l) => l.includes("telegram transport overridden")).length, 1);
    assert.ok(!logs.join("\n").includes(TOKEN), "token leaked into a log line");
  } finally {
    // A leaked listening socket makes the suite hang forever (an assertion failure before teardown is worse
    // than a red test — it is an infinite one), so every server closes here.
    await Promise.all([a.close(), b.close(), tg.close()]);
  }
});

test("an unreachable provider is reported by reason, not as a silent omission", async () => {
  const tg = await fakeTelegramApi();
  try {
    // Bind then close to obtain a port that is certainly refusing connections.
    const sacrificial = createServer();
    await new Promise((r) => sacrificial.listen(0, "127.0.0.1", r));
    const deadPort = sacrificial.address().port;
    await new Promise((r) => sacrificial.close(r));

    const prober = new InferenceProber({
      providers: [{ id: "dead", baseUrl: `http://127.0.0.1:${deadPort}` }],
      timeoutMs: 1_500,
    });
    const agg = await prober.check();
    assert.equal(agg.state, "unreachable");
    assert.equal(agg.reachable, 0);
    const detail = prober.details()[0];
    assert.ok(detail.reason && detail.reason.length > 0, "a failed probe must carry a reason for the operator");
    assert.equal(tg.messages.length, 0, "this test has no notifier attached; nothing should have been sent");
  } finally {
    await tg.close();
  }
});
