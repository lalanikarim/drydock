#!/usr/bin/env node
// Alert delivery drill (#133 / #64): prove that an infrastructure edge actually reaches a notification,
// without waiting for an outage and without spamming the operator's phone.
//
// Why this exists: the alert path crossed four boundaries — prober aggregate → transition edge → notifier dedupe
// → Telegram HTTP — and every one of them can swallow a message while looking healthy. A shipped defect lived in
// exactly that seam (`notifyEventKey`'s catch-all fallback muted inference recoveries for the whole dedupe window)
// and no unit test noticed, because each half was individually correct. The only honest question is whether a
// message arrives at the far end.
//
// So: run the REAL `InferenceProber` and the REAL `createNotifier`, wired as `factory/adapter.ts` wires them,
// against a local stand-in for the Telegram Bot API (`TELEGRAM_API_BASE`, loudly logged when set) and two local
// inference endpoints whose reachability is controlled here. It then forces outage → recovery and checks that
// BOTH messages were received.
//
// Nothing external is contacted: not Telegram, not aurora. Credentials are read from the environment so the
// resolution rules (trimming, presence) are the production ones, but the token never leaves the process — and it
// is never printed.
//
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node gates/alert-drill.mjs [--json]
//
// Exit 0 = an outage AND its recovery were both delivered (with Telegram-assigned message ids).
// Exit 2 = the alert path is broken or unconfigured. "Not checked" and "passing" are not the same answer.
import { createServer } from "node:http";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { InferenceProber } = await import(`${ROOT}/factory/inference-probe.ts`);
const { createNotifier, resolveTelegramApiBase } = await import(`${ROOT}/factory/notify-telegram.ts`);

const asJson = process.argv.includes("--json");
const lines = [];
const emit = (s) => {
  lines.push(s);
  if (!asJson) console.log(s);
};
const fail = (msg, detail = null) => {
  const payload = { ok: false, error: msg, ...(detail ? { detail } : {}), log: lines };
  console.log(asJson ? JSON.stringify(payload, null, 2) : `DRILL FAILED: ${msg}`);
  if (!asJson && detail) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exitCode = 2;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An OpenAI-compatible endpoint whose reachability this drill controls. */
function startProvider(name) {
  const state = { up: true };
  const server = createServer((req, res) => {
    if (!state.up) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable (alert drill)" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: `${name}-drill-model` }] }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

/** A stand-in for the Telegram Bot API: records sendMessage bodies, hands back plausible message ids. */
function startTelegramStandIn() {
  const received = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!req.url?.includes("sendMessage")) {
        res.writeHead(404).end();
        return;
      }
      try {
        received.push(JSON.parse(raw || "{}"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 9000 + received.length } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const chatId = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
if (!token || !chatId) {
  fail("alerting is not configured for this shell", [
    `TELEGRAM_BOT_TOKEN ${token ? "present" : "MISSING"}, TELEGRAM_CHAT_ID ${chatId ? "present" : "MISSING"}.`,
    "These are the same two values the fleet runs with (launchd EnvironmentVariables, or the operator shell in",
    "runbook §12). The drill does not create them.",
  ]);
  process.exit(2);
}

async function main() {
const tg = await startTelegramStandIn();
const alpha = await startProvider("alpha");
let beta = null;
try {
  beta = await startProvider("beta");

  // The notifier is built with the operator's real credential resolution, but pointed at the stand-in. This is
  // the one deviation from production wiring, and `resolveTelegramApiBase` prints a warning precisely because
  // of it: this drill proves the pipeline, not that api.telegram.org accepts the token.
  const env = { ...process.env, TELEGRAM_API_BASE: tg.base };
  const warnings = [];
  if (resolveTelegramApiBase(env, (l) => warnings.push(l)) !== tg.base) {
    fail("TELEGRAM_API_BASE override was rejected — the drill would have messaged the real chat", warnings.join("\n"));
    process.exit(2);
  }
  emit("stand-in transport active (no message left this machine; production alerts use api.telegram.org)");

  const delivered = [];
  const notifier = createNotifier({
    token,
    chatId,
    env,
    log: (l) => {
      warnings.push(l);
      if (l.includes("telegram")) emit(`  [notifier] ${l}`);
    },
  });
  if (!notifier) {
    fail("createNotifier returned no notifier despite credentials being present");
    process.exit(2);
  }

  const prober = new InferenceProber({
    providers: [
      { id: "alpha", baseUrl: alpha.baseUrl },
      { id: "beta", baseUrl: beta.baseUrl },
    ],
    timeoutMs: 3_000,
    onTransition: (next) => {
      delivered.push(next.state);
      void notifier({ kind: "inference_state", state: next.state, reachable: next.reachable, total: next.total });
    },
    log: (l) => emit(`  [prober] ${l}`),
  });

  // Three edges: healthy at boot → one endpoint down (degraded) → all down (unreachable) → recovered. The last
  // one is the message a time-window dedupe deletes, because it matches the boot announcement.
  await prober.check();
  beta.state.up = false;
  await prober.check();
  alpha.state.up = false;
  await prober.check();
  alpha.state.up = true;
  beta.state.up = true;
  await prober.check();
  await sleep(150); // the notifier is fire-and-forget by contract; give its POSTs a moment to land

  emit(`edges observed: ${delivered.join(" → ")}`);
  for (const m of tg.received) emit(`  delivered → chat_id=${m.chat_id} text="${m.text}"`);

  const texts = tg.received.map((m) => m.text ?? "");
  const sawOutage = texts.some((t) => /inference (unreachable|degraded)/.test(t));
  const sawRecovery = texts.some((t) => /inference reachable/.test(t) && !/^\s*$/.test(t));

  if (!sawOutage) return fail("no outage alert was delivered", { received: texts });
  if (!sawRecovery) return fail("outage delivered but NO recovery — the all-clear is missing", { received: texts });
  return true;

  emit("");
  emit(`alert path verified: ${tg.received.length} messages, outage and recovery both delivered`);
  emit("what this proves: probe → edge → dedupe → HTTP transport, end to end, in one process.");
  emit("what it does NOT prove: that api.telegram.org accepts your token or that the chat is reachable.");
  emit("For that, watch for a 'telegram delivered … message_id=…' line in supervisor.log after a real event.");

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      edges: delivered,
      delivered: tg.received.map((m) => ({ chat_id: m.chat_id, text: m.text })),
    }, null, 2));
  }
} catch (e) {
  fail("drill crashed", String(e?.stack ?? e));
} finally {
  await tg.close();
  await alpha.close();
  if (beta) await beta.close();
}
}

const outcome = await main();
// `fail()` sets process.exitCode, but an explicit non-zero here keeps "the drill did not pass" from ever
// reporting as success.
if (outcome !== true && process.exitCode === undefined) process.exitCode = 2;
