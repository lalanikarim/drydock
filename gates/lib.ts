// Shared helpers for the Phase 2 gate suite (G0–G5, M1–M4, measurement).
//
// The gates exercise the PRODUCTION entrypoint — each one spawns
// `factory/main.ts` as a supervised child process (exactly what the fleet
// supervisor does), talks to the core server over HTTP with the instance's
// Bearer token, and SIGTERMs it on the way out. Nothing here re-implements
// composition; it only drives and observes.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defaultConfigPathFor } from "../factory/factory-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..");

/** Load the repo-root .env into process.env (never overwrites). */
export function loadFactoryEnv(): void {
  const envFile = join(REPO_ROOT, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] ??= v;
  }
}

/**
 * Default per-repo runtime config path. Resolved the same way the production entrypoint resolves it —
 * `$DRYDOCK_CONFIG_DIR/<owner>_<repo>.json`, outside the source tree — because a gate that read its config
 * from somewhere the factory never looks would prove nothing about the factory.
 */
export function defaultConfigPath(repo: string): string {
  return defaultConfigPathFor(repo);
}

export interface InstanceHandle {
  child: ChildProcess;
  base: string; // http://127.0.0.1:<port>
  token: string; // the instance's API_TOKEN (set by us, known)
  root: string; // isolated factory-instances root for this run
  logPath: string; // full stdout/stderr of the instance process
  close: () => Promise<void>;
}

/** Spawn one factory instance via the production entrypoint.
 * Hermetic: isolated instances root under os.tmpdir(), our own API_TOKEN,
 * ephemeral port (parsed from the ready line).
 * Pass `root` to restart over an EXISTING instance root (same durable store —
 * the G4 crash test); pass `token` to keep a known token across that restart. */
export async function spawnInstance({ repo, configPath, timeoutMs = 90_000, root: rootIn, token: tokenIn }: {
  repo: string;
  configPath?: string;
  timeoutMs?: number;
  root?: string;
  token?: string;
}): Promise<InstanceHandle> {
  // GATES_INSTANCES_ROOT pins instance roots under a persistent dir (the
  // measurement gate scans them); default stays hermetic os.tmpdir().
  const baseRoot = process.env.GATES_INSTANCES_ROOT ?? tmpdir();
  mkdirSync(baseRoot, { recursive: true });
  const root = rootIn ?? mkdtempSync(join(baseRoot, "gates-instances-"));
  mkdirSync(root, { recursive: true });
  const logPath = join(root, "instance.log");
  const token = tokenIn ?? randomBytes(16).toString("hex");
  const args = ["--experimental-strip-types", join(REPO_ROOT, "factory", "main.ts"), repo];
  if (configPath) args.push("--config", configPath);
  const child = spawn(process.execPath, args, {
    env: { ...process.env, API_TOKEN: token, FACTORY_INSTANCES_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buf = "";
  let port: number | undefined;
  const output = (d: Buffer) => {
    buf += d.toString("utf8");
    const m = buf.match(/ready on http:\/\/127\.0\.0\.1:(\d+)\/ /);
    if (m && port === undefined) port = Number(m[1]);
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);

  const deadline = Date.now() + timeoutMs;
  while (port === undefined) {
    if (child.exitCode !== null) throw new Error(`instance exited early (code ${child.exitCode}):\n${buf.slice(-2000)}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`instance did not become ready within ${timeoutMs}ms:\n${buf.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const base = `http://127.0.0.1:${port}`;
  // Persist the log for post-mortem (the in-memory buf is authoritative while running).
  const iv = setInterval(() => { try { writeFileSync(logPath, buf); } catch { /* best effort */ } }, 2000);
  return {
    child, base, token, root, logPath,
    close: async () => {
      clearInterval(iv);
      try { writeFileSync(logPath, buf); } catch { /* best effort */ }
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 15_000);
        child.once("exit", () => { clearTimeout(t); resolve(); });
      });
    },
  };
}

/** Authenticated JSON helpers against one instance. */
export function api(base: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  return {
    async get(path: string): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, { headers });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json };
    },
    async post(path: string, body: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json };
    },
  };
}

/** POST /tasks (exactly-once by requestId). */
export async function postTask(base: string, token: string, content: string, requestId: string): Promise<any> {
  const a = api(base, token);
  const { status, json } = await a.post("/tasks", { content, requestId });
  if (status !== 202) throw new Error(`/tasks returned ${status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Poll GET /approvals for a pending key on `tool`, or timeout. */
export async function waitForApproval(base: string, token: string, tool: string, timeoutMs = 120_000): Promise<any> {
  const a = api(base, token);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await a.get("/approvals");
    const hit = (json.approvals ?? []).find((p: any) => p.tool === tool && p.status !== "approved" && p.status !== "denied");
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no pending approval for ${tool} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Decide one pending approval via the core API (POST /approvals/<key>). */
export async function decideApproval(base: string, token: string, key: string, decision: "approved" | "denied", reason?: string): Promise<{ status: number; json: any }> {
  const a = api(base, token);
  return a.post(`/approvals/${key}`, { decision, ...(reason ? { reason } : {}) });
}

/** Poll GET /conversations/:id/entries for the latest pi.tool-result of `toolName`
 * whose text matches `match`, or timeout. (Replaces the old shim's /tool-results.) */
export async function waitForToolResult(base: string, token: string, conversationId: number, toolName: string, match: (text: string) => boolean, timeoutMs = 300_000): Promise<string> {
  const a = api(base, token);
  const deadline = Date.now() + timeoutMs;
  let lastText: string | undefined;
  for (;;) {
    const { json } = await a.get(`/conversations/${conversationId}/entries?n=200`);
    const items = json.entries ?? json.items ?? [];
    for (const item of items) { // descending
      if ((item.kind ?? "") !== "pi.tool-result") continue;
      const msg = Array.isArray(item.model) ? item.model[0] : undefined;
      if (!msg || msg.toolName !== toolName) continue;
      const text = (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      lastText = text;
      if (match(text)) return text;
    }
    if (Date.now() > deadline) throw new Error(`no matching ${toolName} result within ${timeoutMs}ms${lastText ? ` (last: ${lastText.slice(0, 200)})` : ""}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** The instance's root conversation id (first in the list on a fresh store). */
export async function rootConversationId(base: string, token: string): Promise<number> {
  const a = api(base, token);
  const { json } = await a.get("/conversations");
  const list = json.conversations ?? [];
  if (!list.length) throw new Error("no conversations listed");
  // /conversations is newest-first — never assume list[0] is the root.
  const roots = list.filter((c: any) => c.isRoot === true);
  if (roots.length) return roots.sort((x: any, y: any) => x.id - y.id)[0].id;
  return Math.min(...list.map((c: any) => c.id));
}
