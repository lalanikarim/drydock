// Telegram operator notifications (#64).
//   node --experimental-strip-types --test test/notify-telegram.test.mjs
//
// The properties worth pinning are not "does the text look nice" — they are the ones that decide whether a
// notification feature can be trusted next to a run: it never breaks the run, the bot token never appears in
// a log line or error string, connection resets are retried (this host really does ECONNRESET node's fetch
// where curl succeeds) while a 400 is not, and an unconfigured deployment is an explicit disabled state
// rather than a function that silently does nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { renderNotifyMessage, clampMessage, sendTelegramMessage, notifyEventKey, createNotifier, TELEGRAM_MAX_MESSAGE } =
  await import("../factory/notify-telegram.ts");
const { openDraftPrTool } = await import("../factory/open-draft-pr.ts");
const { RefusalBudget } = await import("../factory/refusal-budget.ts");

const TOKEN = "123456:AA-secrets-not-for-logs";
const CHAT = "8355675626";

function res(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** fetch that returns the queued responses in order, recording each call. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? res(200, '{"ok":true}');
  };
  return { impl, calls };
}

const noSleep = async () => {};

// ---------------------------------------------------------------- rendering

test("each event renders one informative line", () => {
  assert.equal(
    renderNotifyMessage({ kind: "pr_opened", repo: "lalanikarim/drydock", issueNumber: 120, prNumber: 123, prUrl: "https://github.com/lalanikarim/drydock/pull/123", head: "abcdef1234567", verification: { ran: true, passed: true } }),
    "drydock: draft PR #123 opened for issue #120 (tests pass, head abcdef123) https://github.com/lalanikarim/drydock/pull/123",
  );
  assert.match(renderNotifyMessage({ kind: "run_stopped", repo: "a/b", issueNumber: 99, reason: "identical refusals", detail: "path scope" }), /^b: run stopped for issue #99: identical refusals — path scope$/);
  assert.match(renderNotifyMessage({ kind: "refine_posted", repo: "a/drydock", issueNumber: 120, commentUrl: "https://x/1" }), /^drydock: refinement brief posted on issue #120 https:\/\/x\/1$/);
  assert.match(renderNotifyMessage({ kind: "pr_opened", repo: "a/b", issueNumber: 1, prUrl: "u", verification: { ran: false } }), /tests not run/);
});

test("clamping keeps the URL whole — a truncated link is useless", () => {
  const long = `${"x".repeat(5000)} https://github.com/o/r/pull/1`;
  const out = clampMessage(long);
  assert.ok(out.length <= TELEGRAM_MAX_MESSAGE, `length ${out.length}`);
  assert.ok(out.endsWith("https://github.com/o/r/pull/1"), "link intact");
  assert.equal(clampMessage("short"), "short");
  assert.ok(clampMessage("y".repeat(5000)).endsWith("…"));
});

// ---------------------------------------------------------------- transport behaviour

test("a message is posted to the bot API with chat id and text", async () => {
  const { impl, calls } = fakeFetch(res(200, '{"ok":true}'));
  const r = await sendTelegramMessage("hello", { token: TOKEN, chatId: CHAT, fetchImpl: impl, sleep: noSleep });
  assert.deepEqual({ ok: r.ok, attempts: r.attempts }, { ok: true, attempts: 1 });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual({ chat_id: calls[0].body.chat_id, text: calls[0].body.text }, { chat_id: CHAT, text: "hello" });
});

test("ECONNRESET is retried — node resets where curl succeeds on this host", async () => {
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const { impl, calls } = fakeFetch(reset, reset, res(200, '{"ok":true}'));
  const r = await sendTelegramMessage("hi", { token: TOKEN, chatId: CHAT, fetchImpl: impl, sleep: noSleep, maxAttempts: 3 });
  assert.deepEqual({ ok: r.ok, attempts: r.attempts }, { ok: true, attempts: 3 });
  assert.equal(calls.length, 3);
});

test("a 400 is not retried, and the token never reaches the failure detail", async () => {
  const { impl, calls } = fakeFetch(res(401, '{"description":"Unauthorized"}'));
  const r = await sendTelegramMessage("hi", { token: TOKEN, chatId: CHAT, fetchImpl: impl, sleep: noSleep, maxAttempts: 5 });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, "retrying a bad token forever is how an outage turns into a storm");
  assert.ok(!String(r.detail).includes(TOKEN), `token leaked into detail: ${r.detail}`);
});

test("429 honours retry_after and then succeeds", async () => {
  const waits = [];
  const { impl } = fakeFetch(res(429, '{"ok":false,"parameters":{"retry_after":7}}'), res(200, '{"ok":true}'));
  const lines = [];
  const r = await sendTelegramMessage("hi", {
    token: TOKEN,
    chatId: CHAT,
    fetchImpl: impl,
    sleep: async (ms) => void waits.push(ms),
    log: (l) => lines.push(l),
  });
  assert.deepEqual({ ok: r.ok, attempts: r.attempts }, { ok: true, attempts: 2 });
  assert.deepEqual(waits, [8000], "waits retry_after + 1s");
  assert.match(lines.join("\n"), /rate limited/);
});

test("5xx is retried up to the ceiling, then reported — never thrown", async () => {
  const { impl } = fakeFetch(res(502, "bad gateway"), res(502, "bad gateway"));
  const r = await sendTelegramMessage("hi", { token: TOKEN, chatId: CHAT, fetchImpl: impl, sleep: noSleep, maxAttempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.status, undefined, "last status is reported through detail after exhausting attempts");
  assert.match(String(r.detail), /502/);
});

test("a thrown non-connection error is returned, not propagated", async () => {
  class Weird extends Error { constructor() { super("nope"); this.name = "WeirdError"; } }
  const r = await sendTelegramMessage("hi", { token: TOKEN, chatId: CHAT, fetchImpl: async () => { throw new Weird(); }, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(String(r.detail), /nope/);
});

test("unconfigured credentials report disabled instead of throwing or calling out", async () => {
  const calls = [];
  const r = await sendTelegramMessage("hi", { token: "", chatId: CHAT, fetchImpl: async () => { calls.push(1); return res(200); } });
  assert.deepEqual({ ok: r.ok, attempts: r.attempts, outbound: calls.length }, { ok: false, attempts: 0, outbound: 0 });
  assert.match(String(r.detail), /not configured/);
});

// ---------------------------------------------------------------- notifier wrapper

test("no credentials means no notifier at all — disabled is a state, not a silent function", () => {
  assert.equal(createNotifier({ token: "", chatId: CHAT }), undefined);
  assert.equal(createNotifier({ token: TOKEN }), undefined);
  assert.equal(typeof createNotifier({ token: TOKEN, chatId: CHAT, fetchImpl: async () => res(200) }), "function");
});

test("the same event is announced once per window", async () => {
  const { impl, calls } = fakeFetch(res(200), res(200));
  const notify = createNotifier({ token: TOKEN, chatId: CHAT, fetchImpl: impl, sleep: noSleep });
  const event = { kind: "pr_opened", repo: "a/b", issueNumber: 7, prUrl: "https://x/7" };
  await notify(event);
  await notify(event);
  assert.equal(calls.length, 1);
  await notify({ ...event, issueNumber: 8 });
  assert.equal(calls.length, 2, "a different issue is a different event");
});

test("a notifier failure can never reject into the caller", async () => {
  const lines = [];
  const notify = createNotifier({
    token: TOKEN,
    chatId: CHAT,
    fetchImpl: async () => { throw Object.assign(new Error(`reset for ${TOKEN}`), { code: "ECONNRESET" }); },
    sleep: noSleep,
    log: (l) => lines.push(l),
  });
  await notify({ kind: "refine_posted", repo: "a/b", issueNumber: 3 });
  const out = lines.join("\n");
  assert.match(out, /not delivered/);
  assert.ok(!out.includes(TOKEN), "the token must not survive into a log line even inside an error message");
});

test("event keys separate the three kinds", () => {
  assert.notEqual(notifyEventKey({ kind: "pr_opened", repo: "a/b", issueNumber: 1, prUrl: "u" }), notifyEventKey({ kind: "run_stopped", repo: "a/b", issueNumber: 1, reason: "x" }));
  assert.equal(notifyEventKey({ kind: "refine_posted", repo: "a/b", issueNumber: 1 }), notifyEventKey({ kind: "refine_posted", repo: "a/b", issueNumber: 1 }));
});

// ---------------------------------------------------------------- wiring at the real gate
//
// Driven through openDraftPrTool().execute() against a scratch git repo whose only change is outside the
// repo's path allowlist, so the refusal is real policy behaviour rather than a stubbed branch. The point is
// the wiring: the second identical refusal must produce exactly one stopped-run notification, and a notifier
// that throws must not change what the tool returns.

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A scratch repo shaped like a real run: `main` on origin, an open `agent/issue-1` branch, and a workspace
 * cloned from that branch carrying one unpushed commit whose file (`notes.md`) is outside the allowlist the
 * test will configure. Same shape as test/verification-push-gate.test.mjs so the gate is exercised against a
 * realistic moving target rather than a fixture that cannot fail.
 */
function scratchWorkDir() {
  const root = mkdtempSync(join(tmpdir(), "notify-wire-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["init", "--initial-branch=main", seed]);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "scratch", scripts: { test: "node --test" } }) + "\n");
  writeFileSync(join(seed, "suite.test.mjs"), "import test from 'node:test';\ntest('green', () => {});\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "base");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "-u", "origin", "main");
  git(seed, "checkout", "-q", "-b", "agent/issue-1");
  writeFileSync(join(seed, "prior.md"), "first attempt\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "worker: prior attempt");
  git(seed, "push", "-q", "-u", "origin", "agent/issue-1");

  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const ws = join(workDir, "issue-1");
  execFileSync("git", ["clone", "-q", "--branch", "agent/issue-1", bare, ws]);
  git(ws, "config", "user.email", "test@example.com");
  git(ws, "config", "user.name", "Test");
  writeFileSync(join(ws, "notes.md"), "the change the allowlist will not admit\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "worker: implement issue 1");
  return { root, workDir, ws, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the second identical path-scope refusal notifies exactly once, and a throwing notifier cannot change the outcome", async () => {
  const fx = scratchWorkDir();
  try {
    const budget = new RefusalBudget();
    const seen = [];
    const opts = {
      workDir: fx.workDir,
      fixturesRepo: "octo/scratch",
      ghToken: "",
      modelRef: { provider: "p", modelId: "m" },
      reviewerTaskDef: { name: "unused" },
      testCommand: "node --test",
      requireVerification: true,
      // Everything except docs/ is out of scope, so the worker's change cannot be pushed (#52).
      pathScope: { allowlist: ["docs/"], protectedPaths: [] },
      refusalBudget: budget,
      findOpenPr: async () => null,
      postPrComment: async () => {},
      notify: async (e) => { seen.push(e); },
    };
    const tool = openDraftPrTool(opts);

    const r1 = await tool.execute({ issueNumber: 1, title: "t", summary: "s" }, { createTask: async () => { throw new Error("must not reach review"); } }, {});
    const p1 = JSON.parse(r1.output[0].text);
    assert.equal(p1.refused ?? p1.terminal ?? true, true, `expected a refusal, got ${r1.output[0].text}`);
    assert.ok(!p1.runStopped, "the first identical refusal is still retryable");

    const r2 = await tool.execute({ issueNumber: 1, title: "t", summary: "s" }, { createTask: async () => { throw new Error("must not reach review"); } }, {});
    const p2 = JSON.parse(r2.output[0].text);
    assert.equal(p2.runStopped, true, `expected the second refusal to stop the run, got ${r2.output[0].text}`);

    assert.equal(seen.length, 1, `expected exactly one stopped-run notification, saw ${JSON.stringify(seen)}`);
    assert.equal(seen[0].kind, "run_stopped");
    assert.equal(seen[0].issueNumber, 1);
    assert.equal(seen[0].repo, "octo/scratch");

    // A notifier that explodes must not change what the tool returns (#64's central promise).
    const boomBudget = new RefusalBudget();
    const boom = openDraftPrTool({ ...opts, refusalBudget: boomBudget, notify: async () => { throw new Error("bot is on fire"); } });
    await boom.execute({ issueNumber: 1, title: "t", summary: "s" }, {}, {});
    const rb = await boom.execute({ issueNumber: 1, title: "t", summary: "s" }, {}, {});
    assert.equal(JSON.parse(rb.output[0].text).runStopped, true, "a dead notification channel cannot un-stop a run");
  } finally {
    fx.cleanup();
  }
});
