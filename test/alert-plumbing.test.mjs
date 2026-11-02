// Alert plumbing: #133 (inference edges must actually arrive) and #141's stop announcement.
//
// The bug this file exists for is real and shipped: `notifyEventKey` ended in an unconditional
// `run_stopped:…` fallback, so `inference_state` built its key from fields it does not have. Every inference
// alert — outage, degraded, recovery — collapsed onto one dedupe key, which muted the recovery message for the
// whole 10-minute window. An operator was told the inference host was down and never told it came back. The
// fake Telegram transport below is hostile in the directions reality is: 5xx then success, unparseable bodies,
// and errors that carry the bot token.
import assert from "node:assert/strict";
import test from "node:test";

const {
  notifyEventKey,
  renderNotifyMessage,
  sendTelegramMessage,
  createNotifier,
} = await import("../factory/notify-telegram.ts");
const { budgetStopNotification } = await import("../factory/worker.ts");

const TOKEN = "123456:AA-hostile-token-value";

/** Records every outbound call; returns whatever the script says, so retries and bad bodies are testable. */
function fakeTelegram(script) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (step.throw) throw new Error(step.throw);
    return {
      ok: step.ok,
      status: step.status ?? (step.ok ? 200 : 500),
      // Real Response objects have both. Omitting text() makes the client see a TypeError, which it correctly
      // classifies as a retryable transport fault — so the fake would test retries instead of the 4xx contract.
      text: async () => (step.rawText !== undefined ? step.rawText : JSON.stringify(step.body ?? {})),
      json: async () => {
        if (step.unparseable) throw new SyntaxError("Unexpected end of JSON input");
        return step.body ?? { ok: true, result: { message_id: step.messageId ?? 1 } };
      },
    };
  };
  return { calls, fetchImpl };
}

// ── the dedupe-key defect (#133) ─────────────────────────────────────────────────────────────────

test("inference outage and recovery are DIFFERENT events — a recovery must never be deduped away", () => {
  const down = { kind: "inference_state", state: "unreachable", reachable: 0, total: 1 };
  const back = { kind: "inference_state", state: "reachable", reachable: 1, total: 1 };
  assert.notEqual(notifyEventKey(down), notifyEventKey(back), "regression: both keyed run_stopped:undefined:undefined:undefined");
});

test("partial inference failure is distinct from total failure and from recovery", () => {
  const oneDown = { kind: "inference_state", state: "degraded", reachable: 1, total: 2 };
  const allDown = { kind: "inference_state", state: "unreachable", reachable: 0, total: 2 };
  const healed = { kind: "inference_state", state: "reachable", reachable: 2, total: 2 };
  const keys = new Set([notifyEventKey(oneDown), notifyEventKey(allDown), notifyEventKey(healed)]);
  assert.equal(keys.size, 3, "each transition is its own news item");
});

test("no two event kinds share a dedupe key (a catch-all fallback is a collision)", () => {
  const events = [
    { kind: "pr_opened", repo: "o/r", issueNumber: 1, prUrl: "https://x/1" },
    { kind: "run_stopped", repo: "o/r", issueNumber: 1, reason: "refusal budget exhausted" },
    { kind: "refine_posted", repo: "o/r", issueNumber: 1 },
    { kind: "inference_state", state: "unreachable", reachable: 0, total: 1 },
  ];
  const keys = events.map(notifyEventKey);
  assert.equal(new Set(keys).size, events.length, `keys collided: ${keys.join(" | ")}`);
  for (const k of keys) assert.ok(!k.includes("undefined"), `key built from absent fields: ${k}`);
});

test("the same event retried on the same path still dedupes; different reasons do not", () => {
  const a = { kind: "run_stopped", repo: "o/r", issueNumber: 7, reason: "wall budget exhausted after 2 aborts" };
  const b = { ...a };
  const c = { ...a, reason: "refusal budget exhausted" };
  assert.equal(notifyEventKey(a), notifyEventKey(b));
  assert.notEqual(notifyEventKey(a), notifyEventKey(c));
});

// ── the notifier's real behavior over a fake transport ───────────────────────────────────────────

test("outage then recovery sends TWO messages; repeating the same state sends one", async () => {
  const { calls, fetchImpl } = fakeTelegram([{ ok: true, messageId: 10 }, { ok: true, messageId: 11 }, { ok: true, messageId: 12 }]);
  const lines = [];
  const notify = createNotifier({ token: TOKEN, chatId: "675626", fetchImpl, log: (l) => lines.push(l) });

  const down = { kind: "inference_state", state: "unreachable", reachable: 0, total: 1 };
  const back = { kind: "inference_state", state: "reachable", reachable: 1, total: 1 };
  await notify(down);
  await notify(down); // same edge again — must be muted
  await notify(back);

  assert.equal(calls.length, 2, "one per distinct edge, not one per call");
  assert.match(calls[0].body.text, /inference unreachable \(0\/1/);
  assert.match(calls[1].body.text, /inference reachable \(1\/1/);
  assert.equal(calls[0].body.chat_id, "675626");
});

test("a successful send is logged with Telegram's message id — silence used to hide health and misconfiguration alike", async () => {
  const { fetchImpl } = fakeTelegram([{ ok: true, messageId: 987654321 }]);
  const lines = [];
  await sendTelegramMessage("factory: inference unreachable (0/1 endpoint(s))", { token: TOKEN, chatId: "1", fetchImpl });
  const notify = createNotifier({ token: TOKEN, chatId: "1", fetchImpl: fakeTelegram([{ ok: true, messageId: 55 }]).fetchImpl, log: (l) => lines.push(l) });
  await notify({ kind: "inference_state", state: "unreachable", reachable: 0, total: 1 });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /telegram delivered inference_state/);
  assert.match(lines[0], /message_id=55/);
});

test("a 200 whose body will not parse is still a delivery — the id is a nicety, not a dependency", async () => {
  const { fetchImpl } = fakeTelegram([{ ok: true, unparseable: true }]);
  const res = await sendTelegramMessage("hello", { token: TOKEN, chatId: "1", fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, undefined);
});

test("5xx is retried and the eventual success reports its attempt count", async () => {
  const { calls, fetchImpl } = fakeTelegram([{ ok: false, status: 503 }, { ok: false, status: 502 }, { ok: true, messageId: 7 }]);
  const res = await sendTelegramMessage("hello", { token: TOKEN, chatId: "1", fetchImpl, sleep: async () => {} });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(calls.length, 3);
});

test("a non-retryable 4xx gives up once, and the bot token never reaches the log or the result", async () => {
  const boom = `connect failed to https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const { calls, fetchImpl } = fakeTelegram([{ ok: false, status: 401, body: { ok: false, description: boom } }, { throw: boom }]);
  const lines = [];
  const res = await sendTelegramMessage("hello", { token: TOKEN, chatId: "1", fetchImpl, log: (l) => lines.push(l) });
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 1, "401 will fail identically forever");
  assert.ok(!JSON.stringify(res).includes(TOKEN), "token leaked in SendResult");

  const notify = createNotifier({ token: TOKEN, chatId: "1", fetchImpl: fakeTelegram([{ throw: boom }]).fetchImpl, log: (l) => lines.push(l) });
  await notify({ kind: "inference_state", state: "unreachable", reachable: 0, total: 1 });
  assert.ok(!lines.join("\n").includes(TOKEN), "token leaked in notifier log");
  assert.equal(calls.length, 1);
});

test("missing credentials mean NO notifier at all, not a function that pretends to work", () => {
  assert.equal(createNotifier({ token: undefined, chatId: "1" }), undefined);
  assert.equal(createNotifier({ token: TOKEN, chatId: undefined }), undefined);
});

test("flapping is bounded: edges are announced while they mean something, then one suppression notice", async () => {
  const script = Array.from({ length: 30 }, (_, i) => ({ ok: true, messageId: 200 + i }));
  const { calls, fetchImpl } = fakeTelegram(script);
  const logLines = [];
  const notify = createNotifier({
    token: TOKEN,
    chatId: "1",
    fetchImpl,
    log: (l) => logLines.push(l),
    maxInferenceEdges: 4,
    windowMs: 10 * 60 * 1000,
  });

  // Ten oscillations of the same two states — an endpoint on its way to dying.
  for (let i = 0; i < 10; i++) {
    await notify(i % 2 === 0
      ? { kind: "inference_state", state: "unreachable", reachable: 0, total: 1 }
      : { kind: "inference_state", state: "reachable", reachable: 1, total: 1 });
  }

  assert.equal(calls.length, 4, `expected the flap guard at 4 edges, sent ${calls.length}`);
  const suppression = logLines.filter((l) => l.includes("flapping"));
  assert.equal(suppression.length, 1, "going quiet is announced exactly once, not per suppressed alert");
});

test("a real recovery after a prior outage still arrives even when it matches the startup state", async () => {
  const { calls, fetchImpl } = fakeTelegram([{ ok: true, messageId: 1 }, { ok: true, messageId: 2 }, { ok: true, messageId: 3 }]);
  const notify = createNotifier({ token: TOKEN, chatId: "1", fetchImpl });
  const up = { kind: "inference_state", state: "reachable", reachable: 1, total: 1 };
  const down = { kind: "inference_state", state: "unreachable", reachable: 0, total: 1 };

  await notify(up);    // boot: healthy
  await notify(down);  // outage
  await notify(up);    // all-clear — same key as boot, and the message the old window swallowed

  assert.equal(calls.length, 3);
  assert.match(calls[2].body.text, /inference reachable/);
});

// ── #141's stop announcement ─────────────────────────────────────────────────────────────────────

test("a wall-budget stop is announced as a run_stopped naming the clock and the operator's levers", () => {
  const e = budgetStopNotification({
    repo: "lalanikarim/drydock",
    issueNumber: 141,
    attempts: 2,
    reason: "wall-clock budget exceeded (2400s)",
  });
  assert.equal(e.kind, "run_stopped");
  assert.match(e.reason, /wall budget exhausted after 2 aborts/);
  assert.match(e.detail, /wallSecsPerIssue/);
  assert.match(e.detail, /split the issue/i);

  const text = renderNotifyMessage(e);
  assert.match(text, /^drydock: run stopped for issue #141/);
  assert.match(text, /wall budget exhausted after 2 aborts/);
});

test("the wall-budget stop has its own key, so it cannot be muted by a refusal-budget stop on the same issue", () => {
  const budget = budgetStopNotification({ repo: "o/r", issueNumber: 9, attempts: 2, reason: "wall-clock budget exceeded (2400s)" });
  const refusal = { kind: "run_stopped", repo: "o/r", issueNumber: 9, reason: "refusal budget exhausted" };
  assert.notEqual(notifyEventKey(budget), notifyEventKey(refusal));
});

// ── wiring pins: the notification must actually be reachable from the code that decides ───────────

test("source pin: the worker notifies on a terminal wall-budget stop, and the pipeline hands it a notifier", async () => {
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("../factory/worker.ts", import.meta.url), "utf8");
  const pipeline = readFileSync(new URL("../factory/pipeline.ts", import.meta.url), "utf8");

  assert.match(worker, /if \(note\.terminal\) \{[\s\S]{0,400}notify\?\.\(budgetStopNotification\(/,
    "the terminal branch must fire the alert — a stop nobody is told about is a log line, not an alert");
  assert.match(worker, /budget-stop notification failed/, "notification failure must be caught: it cannot affect the task");
  assert.match(pipeline, /factoryWorkerTask\(\{[\s\S]{0,700}notify: opts\.notify/,
    "the worker must actually receive the notifier");
});
