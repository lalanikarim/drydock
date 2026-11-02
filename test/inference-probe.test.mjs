// Inference reachability probing (#133).
//
// The outage this exists for: an inference host with no route, `/health` answering `{"status":"ok"}`, and a
// submission sitting unsettled with no error. Tests here use fake fetches that FAIL THE WAY REALITY FAILS —
// ENOTFOUND/EHOSTDOWN on the cause, 401 rather than a friendly "unavailable" — because a probe written
// against a cooperative double is a probe of the double (AGENTS.md).

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  interpolateSecret,
  parseModelProviders,
  classifyFetchError,
  probeProvider,
  aggregate,
  resolvePinnedProviders,
  InferenceProber,
  redact,
} from "../factory/inference-probe.ts";
import { renderNotifyMessage } from "../factory/notify-telegram.ts";

const fetchReturning = (init, body) => async () =>
  new Response(body ?? "", { status: init.status ?? 200, headers: { "content-type": "application/json" } });

const fetchThrows = (err) => async () => {
  throw err;
};

test("secret interpolation follows the kernel's rules and never executes anything", () => {
  const env = { KEY: "from-env" };
  assert.equal(interpolateSecret("literal", env), "literal");
  assert.equal(interpolateSecret("$KEY", env), "from-env");
  assert.equal(interpolateSecret("${KEY}", env), "from-env");
  assert.equal(interpolateSecret("$MISSING", env), undefined, "an unset env ref is absent, not the literal text");
  assert.equal(interpolateSecret("!echo nope", env), undefined, "!command is unsupported AND must never be run");
  assert.equal(interpolateSecret(undefined, env), undefined);
});

test("models.json parses into probeable endpoints; junk yields none instead of throwing", () => {
  const text = JSON.stringify({
    providers: {
      aurora: { baseUrl: "http://aurora.infinidigm:8888/v1/", apiKey: "$AURORA_KEY" },
      spark: { baseUrl: "https://spark.example/v1", apiKey: "sk-live" },
      broken: {},
      weird: null,
    },
  });
  const out = parseModelProviders(text);
  assert.deepEqual(out.map((p) => p.id), ["aurora", "spark", "broken"]);
  assert.equal(out[0].baseUrl, "http://aurora.infinidigm:8888/v1/");
  assert.equal(parseModelProviders("{ not json").length, 0);
  assert.equal(parseModelProviders(undefined).length, 0);
});

test("fetch failures classify into reasons an operator can act on", () => {
  assert.equal(classifyFetchError(Object.assign(new Error("aborted"), { name: "AbortError" })), "timeout", "what AbortSignal.timeout surfaces from fetch");
  assert.equal(classifyFetchError(Object.assign(new Error("timed out"), { name: "TimeoutError" })), "timeout");
  assert.equal(classifyFetchError(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } })), "refused");
  assert.equal(classifyFetchError(Object.assign(new Error("x"), { cause: { code: "EHOSTDOWN" } })), "no-route");
  assert.equal(classifyFetchError(Object.assign(new Error("x"), { code: "ENOTFOUND" })), "dns");
  assert.equal(classifyFetchError(new Error("???")), "error");
});

test("a reachable endpoint reports latency and its loaded model ids, requested the way an endpoint expects", async () => {
  const seen = {};
  const r = await probeProvider(
    { id: "spark", baseUrl: "https://spark.example/v1/", apiKey: "sk-live" },
    {
      fetchImpl: async (url, init) => {
        seen.url = url;
        seen.auth = init?.headers?.authorization;
        return new Response(JSON.stringify({ data: [{ id: "Qwen3.8-Flash" }, { id: "deepseek-r1" }] }), { status: 200 });
      },
    },
  );
  assert.equal(seen.url, "https://spark.example/v1/models", "trailing slash on baseUrl must not produce //models");
  assert.equal(seen.auth, "Bearer sk-live");
  assert.equal(r.reachable, true);
  assert.deepEqual(r.loadedModelIds, ["Qwen3.8-Flash", "deepseek-r1"]);
  assert.equal(r.host, "spark.example");
});

test("the key never appears in a result — results are rendered into health output and alerts", async () => {
  const r = await probeProvider({ id: "p", baseUrl: "http://h:1/v1", apiKey: "sk-super-secret" }, { fetchImpl: fetchReturning(200, "{}") });
  assert.ok(!JSON.stringify(r).includes("sk-super-secret"));
});

test("a wrong key is unreachable with the status that proves it — not an exception", async () => {
  const r = await probeProvider({ id: "spark", baseUrl: "https://spark.example/v1", apiKey: "wrong" }, { fetchImpl: fetchReturning({ status: 401 }) });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, "http-401");
  assert.equal(r.status, 401);
});

test("no route to the host is unreachable with no-route, exactly as macOS reports it", async () => {
  const err = Object.assign(new Error("connect host down"), { cause: { code: "EHOSTDOWN" } });
  const r = await probeProvider({ id: "aurora", baseUrl: "http://192.168.1.200:8888/v1" }, { fetchImpl: fetchThrows(err) });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, "no-route");
});

test("a malformed provider with no baseUrl is reported, not silently skipped", async () => {
  const r = await probeProvider({ id: "ghost" }, { fetchImpl: fetchReturning(200) });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, "no-base-url");
});

test("aggregate: all / some / none / nothing-probed are four distinct states", () => {
  const mk = (reachable, id) => ({ id, reachable, checkedAt: 100, latencyMs: 1 });
  assert.equal(aggregate([mk(true, "a"), mk(true, "b")]).state, "reachable");
  assert.equal(aggregate([mk(true, "a"), mk(false, "b")]).state, "degraded");
  assert.equal(aggregate([mk(false, "a")]).state, "unreachable");
  const none = aggregate([]);
  assert.equal(none.state, "unknown", "not-yet-measured must not read as healthy");
  assert.equal(none.checkedAt, null);
});

test("resolvePinnedProviders probes what the enabled repos actually pin", () => {
  const modelsJsonText = JSON.stringify({
    providers: { aurora: { baseUrl: "http://aurora:8888/v1", apiKey: "k1" }, spark: { baseUrl: "https://spark:8888/v1", apiKey: "k2" } },
  });
  const configs = {
    "a/one": { models: { provider: "aurora", modelId: "m" } },
    "a/two": { models: { provider: "aurora", modelId: "n" } }, // same provider → one probe, not two
    "a/three": { models: { provider: "spark", modelId: "p" } },
    "a/four": { models: {} }, // no pin → resolves through env
    "a/five": null, // no runtime config at all → cannot boot, probing cannot help it
  };
  const out = resolvePinnedProviders({
    repos: [...Object.keys(configs), "a/broken"],
    readRuntimeConfig: (repo) => {
      if (repo === "a/broken") throw new Error("unreadable config file");
      return configs[repo];
    },
    modelsJsonText,
    defaultBaseUrl: "http://env-host:8888/v1",
    defaultApiKey: "env-key",
  });
  assert.deepEqual(out.map((p) => p.id).sort(), ["$env", "aurora", "spark"]);
  assert.equal(out.find((p) => p.id === "aurora").apiKey, "k1");
});

test("a provider a config names but nobody can resolve stays visible as a failed probe", () => {
  const out = resolvePinnedProviders({
    repos: ["a/one"],
    readRuntimeConfig: () => ({ models: { provider: "typo-provider" } }),
    modelsJsonText: JSON.stringify({ providers: {} }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "typo-provider");
  assert.equal(out[0].baseUrl, undefined, "kept with no baseUrl so the aggregate reports it unreachable");
});

test("the prober announces the first result and every CHANGE, not every tick", async () => {
  const seen = [];
  let mode = "down";
  const fetchImpl = async () => {
    if (mode === "down") throw Object.assign(new Error("down"), { cause: { code: "EHOSTDOWN" } });
    return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
  };
  const p = new InferenceProber({
    providers: [{ id: "aurora", baseUrl: "http://192.168.1.200:8888/v1" }],
    fetchImpl,
    onTransition: (next, prev) => seen.push(`${prev ? prev.state : "none"}->${next.state}`),
  });
  await p.check();
  await p.check();
  mode = "up";
  await p.check();
  await p.check();
  assert.deepEqual(seen, ["none->unreachable", "unreachable->reachable"]);
  assert.equal(p.current().state, "reachable");
});

test("a throwing notification handler cannot take the prober — or its health disclosure — down", async () => {
  const p = new InferenceProber({
    providers: [{ id: "x", baseUrl: "http://h:1/v1" }],
    fetchImpl: fetchReturning(200, "{}"),
    onTransition: () => {
      throw new Error("telegram exploded");
    },
  });
  const agg = await p.check();
  assert.equal(agg.state, "reachable");
  assert.equal(p.current().state, "reachable");
});

test("redact strips credential shapes from any text we might log", () => {
  assert.ok(!redact("Authorization: Bearer abcdef.12345").includes("abcdef.12345"));
  assert.ok(!redact("key sk-abcDEF123456789").includes("abcDEF123456789"));
});

// ---- health surface -----------------------------------------------------------

test("/health reports inference state without naming providers, hosts or repos", async () => {
  const { startIntakeServer } = await import("../factory/intake.ts");
  const srv = await startIntakeServer({
    port: 0,
    webhookSecret: "s3cret",
    dispatch: async () => ({}),
    inferenceStatus: () => ({ state: "unreachable", reachable: 0, total: 2, checkedAt: 123 }),
    inferenceDetails: () => [{ id: "aurora", baseUrl: undefined, host: "aurora.infinidigm", reachable: false, reason: "no-route", checkedAt: 123, latencyMs: 5 }],
  });
  const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.inference, { state: "unreachable", reachable: 0, total: 2, checkedAt: 123 });
  const text = JSON.stringify(body);
  assert.ok(!text.includes("aurora"), "public health must not name a provider");
  assert.ok(!text.includes("infinidigm"), "public health must not name an internal host");
  srv.server.close();
});

test("the detail view exists on loopback and is 404 when there is nothing to show", async () => {
  const { startIntakeServer } = await import("../factory/intake.ts");
  const withDetails = await startIntakeServer({
    port: 0,
    webhookSecret: "s3cret",
    dispatch: async () => ({}),
    inferenceStatus: () => ({ state: "reachable", reachable: 1, total: 1, checkedAt: 1 }),
    inferenceDetails: () => [{ id: "spark", host: "spark.infinidigm", reachable: true, checkedAt: 1, latencyMs: 2 }],
  });
  const res = await fetch(`http://127.0.0.1:${withDetails.port}/health/inference`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers[0].id, "spark");

  const without = await startIntakeServer({ port: 0, webhookSecret: "s3cret", dispatch: async () => ({}) });
  const missing = await fetch(`http://127.0.0.1:${without.port}/health/inference`);
  assert.equal(missing.status, 404, "no prober → the route does not exist (and never advertises itself)");
  const plain = await (await fetch(`http://127.0.0.1:${without.port}/health`)).json();
  assert.deepEqual(plain, { status: "ok" }, "with no probe configured, health claims nothing about inference");
  withDetails.server.close();
  without.server.close();
});

test("the alert for an outage is a sentence an operator can act on, and carries no secrets", () => {
  const msg = renderNotifyMessage({ kind: "inference_state", state: "unreachable", reachable: 0, total: 2, detail: "aurora: no-route" });
  assert.match(msg, /inference unreachable \(0\/2 endpoint\(s\)\)/);
  assert.match(msg, /no-route/);
  assert.ok(!/Bearer|sk-/.test(msg));
});
