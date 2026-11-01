// Real-kernel verification of intake conversation scoping (#122).
//   node --experimental-strip-types factory/intake-boot.test.ts
//
// Everything in test/intake-scoping.test.mjs runs against a fake harness. This file is the counterweight:
// it boots a real core instance on an ephemeral port with a real sqlite store, POSTs to the real
// /factory/intake route over real HTTP, and asserts on observable effects — which conversation id came
// back, what `pi.agent` actually recorded as that conversation's enabled tools, how many times a tool
// body executed. The unit suite proves the decisions; this proves the kernel honors them.
//
// It uses a probe extension with one no-op tool instead of the factory pipeline on purpose: the factory's
// own tools talk to GitHub and podman, and nothing here should depend on either. The mapping from policy
// to real tool names is pinned separately (test/intake-scoping.test.mjs) against factoryPipeline itself.
//
// Skips cleanly when the inference endpoint in .env is unreachable — a submission starts a generation, and
// without a model there is nothing to wait for.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCoreInstance, loadConfig } from "../vendor/engram/app/src/core.ts";
import { instanceGatesConfig } from "./gate-policy.ts";
import { createIntakeRoute } from "./intake-router.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnvFile() {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] ??= v;
  }
}

async function reachable(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

loadEnvFile();
process.env.API_TOKEN ??= "drydock-intake-boot-token";
const baseUrl = process.env.OPENAI_BASE_URL ?? "";
if (!baseUrl || !(await reachable(baseUrl))) {
  console.log("intake boot (#122): SKIP — no reachable inference endpoint");
  process.exit(0);
}

const token = process.env.API_TOKEN!;
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const tmp = mkdtempSync(join(tmpdir(), "drydock-intake-boot-"));
for (const d of ["data", "config", "work"]) mkdirSync(join(tmp, d), { recursive: true });
// The same factory-owned gate policy production writes, so approvals behave identically here.
writeFileSync(join(tmp, "config", "gates.json"), JSON.stringify(instanceGatesConfig(), null, 2));

// One tool that does nothing but count executions. "How many times did the model's tool actually run" is
// the observable effect that proves a redelivery did not start a second run.
let echoCalls = 0;
const probeTool = defineTool({
  name: "probe_echo",
  description: "Do nothing and return ok. Used only to observe that a conversation could call it.",
  parameters: Type.Object({ note: Type.Optional(Type.String()) }),
  replay: "unsafe",
  execute: async () => {
    echoCalls += 1;
    return { output: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
  },
});

const probeExtension = defineExtension({ name: "intake-probe", tools: [probeTool] });

const modelsRes = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
  headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
});
const modelsBody = (await modelsRes.json()) as { data?: Array<{ id: string }> };
const modelId = modelsBody.data?.[0]?.id;
if (!modelId) throw new Error("no models reported by the inference endpoint");
// Provider resolution matters more than it looks. A ref that names a provider whose host is down does not
// fail loudly: the submission takes, sits unsettled, and produces no assistant turn — the same silence the
// fleet shows when aurora is offline (#133). DEFAULT_MODEL=<provider>:<modelId> therefore wins over the
// env-derived "openai-completions" default, and the non-vacuity assertion below proves a run really happened.
const modelRef = process.env.DEFAULT_MODEL?.includes(":")
  ? { provider: process.env.DEFAULT_MODEL.split(":")[0]!, modelId: process.env.DEFAULT_MODEL.split(":").slice(1).join(":") }
  : { provider: "openai-completions", modelId };
console.log(`probe conversation model: ${modelRef.provider}:${modelRef.modelId}`);

const logLines: string[] = [];
const instance = await createCoreInstance({
  config: loadConfig({
    dataDir: join(tmp, "data"),
    configDir: join(tmp, "config"),
    workRoot: join(tmp, "work"),
    sandbox: { image: "factory-sandbox:latest", network: "none", allowImages: ["factory-sandbox:latest"], allowMountRoot: join(tmp, "work") },
  }),
  extraExtensions: [probeExtension],
  port: 0,
  rootAgent: { model: modelRef as never, instructions: "You are a probe. Do nothing." },
  routes: [
    createIntakeRoute({
      repo: "probe/o",
      modelRef,
      log: (m) => logLines.push(m),
      agents: {
        refine: {
          instructions:
            "You are a probe. When asked, call the probe_echo tool first — never answer without calling a tool — then reply DONE on one line and stop.",
          tools: [probeTool],
        },
      },
    }),
  ],
});

const base = `http://127.0.0.1:${instance.actualPort}`;
const post = async (body: unknown) => {
  const res = await fetch(`${base}/factory/intake`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json: json as any };
};

const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

async function settle(conversationId: number, ms = 120_000) {
  const conv = await instance.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
  if (!conv) throw new Error(`conversation ${conversationId} vanished`);
  await Promise.race([conv.waitForIdle(BACKGROUND_CONTEXT), new Promise((_, rej) => setTimeout(() => rej(new Error("settle timeout")), ms))]);
}

/** Entry kinds for a conversation, read through the kernel's own HTTP surface. */
async function entryKinds(conversationId: number): Promise<string[]> {
  const res = await fetch(`${base}/conversations/${conversationId}/entries`, { headers: auth });
  if (!res.ok) throw new Error(`entries for ${conversationId}: HTTP ${res.status}`);
  const body = (await res.json()) as { entries?: unknown[] } | unknown[];
  const list = Array.isArray(body) ? body : (body.entries ?? []);
  return list.map((e) => String((e as { kind?: unknown }).kind ?? "?"));
}

/** Entry count for a conversation, read through the kernel's own HTTP surface. */
async function entryCount(conversationId: number): Promise<number> {
  const res = await fetch(`${base}/conversations/${conversationId}/entries`, { headers: auth });
  if (!res.ok) throw new Error(`entries for ${conversationId}: HTTP ${res.status}`);
  const body = (await res.json()) as { entries?: unknown[] } | unknown[];
  const list = Array.isArray(body) ? body : (body.entries ?? []);
  return list.length;
}

async function enabledTools(conversationId: number): Promise<string[]> {
  // Live-kernel note: `harness.snapshot(AgentDoc, …)` resolves to the agent state itself, not a record
  // wrapper — the tool filter is `rec.tools`, a string array of enabled tool names. (An earlier revision
  // read `rec.value.tools`, ran against the real kernel, and asserted on an empty array.)
  const rec = (await instance.harness.snapshot(AgentDoc, conversationId as never, BACKGROUND_CONTEXT)) as unknown as
    | { tools?: string[] | { remove: string[] } }
    | undefined;
  const tools = rec?.tools;
  return Array.isArray(tools) ? tools : [];
}

try {
  // 1. The route is behind the kernel's bearer gate, like every other data route.
  const unauthed = await fetch(`${base}/factory/intake`, { method: "POST", body: "{}" });
  assert.equal(unauthed.status, 401, "unauthenticated intake must be refused");
  console.log("check: /factory/intake is bearer-authenticated (401 without a token)");

  // 2. First event for a subject opens its own conversation.
  const first = await post({ kind: "refine", subject: "#1", requestId: "probe-1", content: "Call probe_echo once." });
  assert.equal(first.status, 202, `expected 202, got ${first.status}: ${JSON.stringify(first.json)}`);
  assert.equal(first.json.created, true, "the conversation is created on first use");
  const convA = first.json.conversationId as number;
  console.log(`check: intake opened conversation ${convA} (created=true)`);

  // 3. The capability envelope is real kernel state, not a hope: exactly one enabled tool, and it is ours.
  const toolsA = await enabledTools(convA);
  assert.deepEqual(toolsA, ["probe_echo"], `expected the conversation to be limited to probe_echo, got ${JSON.stringify(toolsA)}`);
  console.log(`check: that conversation's enabled tool set is exactly [${toolsA.join(", ")}] — no orchestration, no built-ins`);

  // 4. Named for operators, visible through the kernel's own listing.
  const listed = (await (await fetch(`${base}/conversations`, { headers: auth })).json()) as { conversations: Array<{ id: number; name: string }> };
  const row = listed.conversations.find((c) => c.id === convA);
  assert.ok(row, "the intake conversation appears in GET /conversations");
  assert.equal(row!.name, "intake refine:#1");
  console.log(`check: listed as "${row!.name}"`);

  // 5. Same subject, different event → same conversation (so the core can dedupe within it).
  const second = await post({ kind: "refine", subject: "#1", requestId: "probe-2", content: "Call probe_echo once more." });
  assert.equal(second.status, 202);
  assert.equal(second.json.created, false);
  assert.equal(second.json.conversationId, convA, "a second event for the same subject reuses the conversation");
  console.log("check: a later event for the same subject reused the conversation (created=false)");

  // 6. A different subject never inherits that transcript.
  const third = await post({ kind: "refine", subject: "#2", requestId: "probe-3", content: "Call probe_echo once." });
  assert.equal(third.json.created, true);
  assert.notEqual(third.json.conversationId, convA, "issue #2 must not share issue #1's conversation");
  console.log(`check: a different subject got its own conversation (${third.json.conversationId})`);

  // 7. A redelivery of an already-settled requestId does no work — verified by the tool's own counter and
  // by the conversation's entry count. Both halves are load-bearing: an earlier revision asserted only
  // "tool executions unchanged" and passed with the counter at zero, i.e. it proved nothing about a run
  // that had never happened. Hence the non-vacuity assertion first.
  await settle(convA);
  const assistantTurns = await entryKinds(convA);
  assert.ok(
    assistantTurns.some((k) => String(k).includes("assistant")),
    `non-vacuity: the first submission must produce an assistant turn (entry kinds: ${assistantTurns.join(",") || "none"}) — a conversation that only ever holds the user entry means generation never ran, usually a provider whose host is unreachable`,
  );
  assert.ok(echoCalls >= 1, `non-vacuity: probe_echo must have executed for the first submission (got ${echoCalls}) — without this, the duplicate check below is vacuous`);
  const before = echoCalls;
  const entriesBefore = await entryCount(convA);
  assert.ok(entriesBefore > 1, `the first run should have written a transcript (entries=${entriesBefore})`);

  const dup = await post({ kind: "refine", subject: "#1", requestId: "probe-1", content: "Call probe_echo once." });
  assert.equal(dup.status, 200, `expected 200 duplicate, got ${dup.status}: ${JSON.stringify(dup.json)}`);
  assert.equal(dup.json.duplicate, true);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(echoCalls, before, `a redelivery must not execute tools again (was ${before}, now ${echoCalls})`);
  assert.equal(await entryCount(convA), entriesBefore, "a redelivery must not append to the transcript either");
  console.log(`check: redelivered requestId answered 200 duplicate — tool executions stayed at ${echoCalls}, entries at ${entriesBefore}`);

  // 8. A kind with no capability envelope is refused rather than routed somewhere convenient.
  const refused = await post({ kind: "issue", subject: "#1", requestId: "probe-4", content: "go" });
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  console.log("check: a kind with no envelope is refused (409)");

  // 9. Malformed bodies are 400s with the reason, not 500s that make GitHub retry forever.
  const bad = await post({ kind: "refine", subject: "#1", requestId: "probe-5" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /content/);
  console.log("check: a body without content is a 400 naming the field");

  await instance.close();
  await instance.close();
  const after = await fetch(`${base}/health`).then(() => "up").catch(() => "down");
  assert.equal(after, "down", "port released after close");
  console.log("check: idempotent close, port released");
} finally {
  try {
    await instance.close();
  } catch {
    /* already closed */
  }
}

console.log("intake boot (#122): all checks passed");
