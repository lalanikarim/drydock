// #96 — the report is posted by the real gate, not by a description of it.
//   node --experimental-strip-types --test test/pr-report-wiring.test.mjs
//
// Properties that only exist at the call site:
//   * when an open PR exists for the branch, a refusal posts exactly one comment describing it;
//   * when no PR exists, nothing is posted (the boundary: no reply to strangers, no double-post on a
//     first draft whose body already carries the evidence pack);
//   * a failed report never changes the run's outcome — reporting is downstream of reality.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openDraftPrTool } = await import("../factory/open-draft-pr.ts");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture({ failing = false, changedFile = "suite.test.mjs" }) {
  const root = mkdtempSync(join(tmpdir(), "prreport-"));
  const bare = join(root, "origin.git");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["init", "--initial-branch=main", clone]);
  writeFileSync(join(clone, "package.json"), JSON.stringify({ name: "scratch", scripts: {} }) + "\n");
  git(clone, "config", "user.email", "test@example.com");
  git(clone, "config", "user.name", "Test");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "remote", "add", "origin", bare);
  git(clone, "push", "-q", "-u", "origin", "main");

  const workDir = join(root, "work");
  mkdirSync(workDir);
  const ws = join(workDir, "issue-1");
  execFileSync("git", ["clone", "-q", "--branch", "main", bare, ws]);
  git(ws, "checkout", "-q", "-b", "agent/issue-1");
  git(ws, "config", "user.email", "test@example.com");
  git(ws, "config", "user.name", "Test");
  const content = changedFile.endsWith(".mjs")
    ? failing
      ? "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('wrong', () => { assert.equal(1, 2); });\n"
      : "import test from 'node:test';\ntest('fine', () => {});\n"
    : JSON.stringify({ name: "scratch", scripts: {}, touchedByWorker: true }) + "\n";
  writeFileSync(join(ws, changedFile), content);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "worker: attempt");
  return { root, bare, workDir, ws, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const apiStub = {
  conversationId: 1,
  taskId: 1,
  createTask: async () => { throw new Error("review stage reached"); },
  waitForTask: async () => { throw new Error("review stage reached"); },
  scanEntries: async () => ({ items: [] }),
};

function makeTool(fx, { pr, postThrows = false, ...extra }) {
  const posts = [];
  const tool = openDraftPrTool({
    workDir: fx.workDir,
    fixturesRepo: "octo/scratch",
    ghToken: "",
    modelRef: { provider: "p", modelId: "m" },
    reviewerTaskDef: { name: "unused" },
    testCommand: "node --test",
    requireVerification: true,
    findOpenPr: async () => pr,
    postPrComment: async (prNumber, body) => {
      if (postThrows) throw new Error("api: comment create refused (502)");
      posts.push({ prNumber, body });
    },
    reportLog: () => {},
    ...extra,
  });
  const run = () => tool.execute({ issueNumber: 1, title: "t", summary: "Requested rework." }, apiStub, {});
  return { tool, posts, run };
}

test("a refusal on a branch with an open PR posts one comment explaining it", async () => {
  const fx = makeFixture({ failing: true });
  try {
    const { posts, run } = makeTool(fx, { pr: { number: 42, url: "https://example/42", headRefOid: "deadbeefdeadbeef" } });
    const result = await run();
    const payload = JSON.parse(result.output.map((o) => o.text).join(""));
    assert.equal(payload.refused, true);

    assert.equal(posts.length, 1, "exactly one reply per rework attempt");
    assert.equal(posts[0].prNumber, 42);
    assert.match(posts[0].body, /Rework refused — nothing was pushed/);
    assert.match(posts[0].body, /still points at `deadbeefde`/, "the PR's current head is reported from host state");
    assert.match(posts[0].body, /`node --test` exit 1 — fail/, "the command and exit code travel to the human, not just 'it failed'");
    assert.match(posts[0].body, /Requested rework\./, "what the run set out to do is quoted in the refusal too");
  } finally {
    fx.cleanup();
  }
});

test("a path-scope refusal names the refused files on the PR", async () => {
  const fx = makeFixture({ changedFile: "package.json" });
  try {
    const { posts, run } = makeTool(fx, { pr: { number: 9, url: "", headRefOid: "cafe00000000" }, pathScope: { allowlist: ["src/"], protectedPaths: [] } });
    await run();
    assert.equal(posts.length, 1);
    assert.match(posts[0].body, /refused files: `package\.json`/);
  } finally {
    fx.cleanup();
  }
});

test("no open PR means no comment (the boundary is real)", async () => {
  const fx = makeFixture({ failing: true });
  try {
    const { posts, run } = makeTool(fx, { pr: null });
    const result = await run();
    assert.match(result.output.map((o) => o.text).join(""), /refused/);
    assert.deepEqual(posts, [], "a first draft PR carries the evidence pack in its body; nothing else replies");
  } finally {
    fx.cleanup();
  }
});

test("a failed report never changes the run's outcome", async () => {
  const fx = makeFixture({ failing: true });
  try {
    const { run } = makeTool(fx, { pr: { number: 42, url: "", headRefOid: "abc" }, postThrows: true });
    const result = await run(); // must not throw even though commenting did
    const payload = JSON.parse(result.output.map((o) => o.text).join(""));
    assert.equal(payload.refused, true);
    assert.equal(payload.verification.exitCode, 1, "the refusal evidence survives a reporting failure");
  } finally {
    fx.cleanup();
  }
});
