// manual-only: needs live inference at OPENAI_BASE_URL, which GitHub runners cannot reach; run with npm run test:boot
//   A CI job running this would print green over an empty skip (#241). The release checklist runs it on the host.
// Phase 0 spike (issue #30): prove the engram core seam from a pinned drydock
// checkout — before any factory pipeline code moves onto it.
//
// Verifies, in order of risk:
//   1. Single pi-durable copy: the vendored core's bare imports resolve to the
//      SAME module instance as drydock's (no dual-package identity hazards).
//   2. extraExtensions defined with drydock's pi-durable reach the root
//      conversation of a core built from the vendored app/src/core.ts.
//   3. Core tools coexist; product-only board tools do NOT leak into the bare core.
//   4. HTTP server answers /health on the ephemeral actualPort (token auth).
//   5. close() is idempotent and releases the port (rebind proof).
//
// Hermeticity: no model generation happens — catalog discovery needs a reachable
// OPENAI_BASE_URL (GET /models), but nothing else touches the endpoint. When the
// endpoint is unreachable the test skips cleanly (like engram's live suites).

import assert from "node:assert/strict";
import type { ConversationId } from "@earendil-works/pi-durable"; // branded id boundary (#173)
import { test } from "node:test";
import http from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- env: drydock's root .env (the vendored loadDotEnv points inside the
// submodule where no .env exists — parse our own, never overwrite ambient) ----
function readFactoryEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* no .env — rely on ambient */ }
  return out;
}

const factoryEnv = readFactoryEnv();
for (const k of ["OPENAI_BASE_URL", "OPENAI_API_KEY"]) {
  if (!process.env[k] && factoryEnv[k]) process.env[k] = factoryEnv[k];
}
process.env.API_TOKEN ??= "drydock-spike-token";

/** Catalog discovery probe: the core needs GET /models to succeed at boot. */
async function endpointReachable(): Promise<boolean> {
  const base = process.env.OPENAI_BASE_URL;
  if (!base) return false;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function makeDirs(tag: string) {
  const base = mkdtempSync(path.join(tmpdir(), `drydock-spike-${tag}-`));
  const dirs = { data: path.join(base, "data"), work: path.join(base, "work"), kb: path.join(base, "kb"), config: path.join(base, "config") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return { base, dirs };
}

function health(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", headers: { authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
  });
}

function bindPlain(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {});
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

test("engram core seam spike (issue #30 phase 0)", { timeout: 120_000 }, async (t) => {
  if (!(await endpointReachable())) {
    console.log("  SKIP: OPENAI_BASE_URL unreachable — catalog discovery needs it");
    return; // skip, like engram's live suites
  }

  const { loadConfig } = await import("../vendor/engram/app/src/config.ts");
  const { createCoreInstance } = await import("../vendor/engram/app/src/core.ts");

  // ---- 1. Single pi-durable copy across the vendor boundary ----
  const requireHere = createRequire(import.meta.url);
  const requireVendor = createRequire(path.join(ROOT, "vendor", "engram", "app", "src", "core.ts"));
  assert.equal(
    requireVendor.resolve("@earendil-works/pi-durable"),
    requireHere.resolve("@earendil-works/pi-durable"),
    "vendored core must resolve pi-durable to the same module copy as drydock",
  );
  await t.test("single pi-durable copy (no dual-package hazard)");

  // Trivial consumer extension: defined with DRYDOCK's pi-durable.
  const probeTool = defineTool({
    name: "noop_probe",
    description: "Spike probe (no-op).",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => ({ output: [{ type: "text" as const, text: "probe-ok" }] }),
  });
  const probe = defineExtension({ name: "spike-probe", tools: [probeTool] });

  // ---- 2–4. Boot one instance against the pinned core ----
  const { base: spikeBase, dirs } = makeDirs("a");
  let closed = false;
  try {
    const config = loadConfig({ dataDir: dirs.data, workRoot: dirs.work, kbDir: dirs.kb, configDir: dirs.config });
    const inst = await createCoreInstance({ config, extraExtensions: [probe], port: 0 });
    assert(inst.actualPort > 0, "ephemeral port must be allocated");
    await t.test("instance boots with ephemeral port (port: 0)");

    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const ctx = BACKGROUND_CONTEXT;
    // Branded id boundary (#173): the spike handle holds a plain number, pi-durable wants ConversationId.
    // Casting here is honest; letting a bare number flow in would also have accepted a TaskId.
    const root = await inst.harness.conversation(inst.rootConversationId as ConversationId, ctx);
    assert(root, "root conversation exists");
    const toolNames = (await root.agent(ctx)).tools.map((x) => x.name);

    assert(toolNames.includes("noop_probe"), `probe tool not offered to root (got ${toolNames.join(", ")})`);
    await t.test("extraExtension tool (drydock-defined) is visible to the root conversation");

    for (const expected of ["bash", "web_fetch", "kb_search"]) {
      assert(toolNames.includes(expected), `core tool ${expected} missing from root agent`);
    }
    await t.test("core tools remain installed alongside consumer extensions");

    assert(!toolNames.includes("board_status"), "product-only board tools must not leak into the bare core");
    await t.test("product-only board tools are absent from the bare core");

    assert.equal(await health(inst.actualPort), 200, "/health should answer on actualPort");
    await t.test("HTTP server answers /health on the bound port (token auth)");

    // ---- 5. Teardown: idempotent close + port release ----
    await inst.close();
    await inst.close();
    const rebind = await bindPlain(inst.actualPort);
    rebind.close();
    closed = true;
    await t.test("close() is idempotent and releases the port (rebind succeeds)");
  } finally {
    if (!closed) console.error("  NOTE: instance not closed — test failed mid-flight");
    rmSync(spikeBase, { recursive: true, force: true });
  }

  // One summary line per boot suite, so `npm run test:boot` can be verified by counting lines instead of reading
  // three different output shapes. Under node:test a failure aborts before this, so printing it here means "every
  // assertion above held" — the release checklist counts these (#241).
  console.log("core spike (engram seam): all checks passed");
});
