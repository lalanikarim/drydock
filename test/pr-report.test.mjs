// #96 — what the factory says on the PR after a rework.
//   node --experimental-strip-types --test test/pr-report.test.mjs
//
// The defect: `/factory rebase` on an already-current branch produced nothing a human could see, so the
// correct outcome was indistinguishable from a silent failure. These pin the three report shapes and the
// rule that "nothing changed" is stated as itself.

import test from "node:test";
import assert from "node:assert/strict";

const { buildPrReport, classifyPush } = await import("../factory/pr-report.ts");

test("classifyPush answers from shas, not from claims", () => {
  assert.equal(classifyPush(null, "abc"), "pushed", "no prior head means this is the first push");
  assert.equal(classifyPush("abc", "abc"), "no_change");
  assert.equal(classifyPush("abc123def", "xyz"), "pushed");
  assert.equal(classifyPush("abc", null), "pushed", "a null new head never reaches here; do not read it as 'nothing happened'");
});

test("a pushed rework names both shas and the gates that ran", () => {
  const body = buildPrReport({
    prNumber: 7, branch: "agent/issue-3", issueNumber: 3,
    previousHead: "1111111111111111", newHead: "2222222222222222", outcome: "pushed",
    summary: "Rebased onto current main.",
    verification: { ran: true, command: "npm test", exitCode: 0, passed: true },
    reviewVerdict: "pass",
  });
  assert.match(body, /\*\*Rework pushed\.\*\*/);
  assert.match(body, /`1111111111` → `2222222222`/, "the shas are shortened but present — a human checks them");
  assert.match(body, /npm test` exit 0 — pass/);
  assert.match(body, /\| review \| pass \|/);
});

test("a no-op rework says so in the first line, and says why that is correct", () => {
  const body = buildPrReport({
    prNumber: 7, branch: "agent/issue-3", issueNumber: 3,
    previousHead: "aaaaaaaaaa", newHead: "aaaaaaaaaa", outcome: "no_change",
    verification: { ran: true, command: "npm test", exitCode: 0, passed: true },
  });
  assert.match(body, /\*\*No change to push\.\*\*/);
  assert.match(body, /head is still `aaaaaaaaaa`/);
  assert.match(body, /invisible without this note/, "the report exists precisely because this case used to vanish");
  assert.ok(!body.includes("Rework refused"));
});

test("a refusal states nothing was pushed, quotes the summary, and gives the reason", () => {
  const body = buildPrReport({
    prNumber: 7, branch: "agent/issue-3", issueNumber: 3,
    previousHead: "bbbbbbbbbb", newHead: null, outcome: "refused",
    summary: "Add a test for the parser.",
    refusalReason: "path scope violation — refused files: `package.json`",
  });
  assert.match(body, /\*\*Rework refused — nothing was pushed\.\*\*/);
  assert.match(body, /still points at `bbbbbbbbbb`/);
  assert.match(body, /> Add a test for the parser\./, "the requested work is quoted so the thread reads without scrolling");
  assert.match(body, /\*\*Why\*\*/, "the reason is its own section");
  assert.match(body, /`package\.json`/);
  assert.match(body, /widen this repo's policy/, "the human way out is offered");
});

test("a budget stop is reported as a different kind of stop", () => {
  const body = buildPrReport({
    prNumber: 7, branch: "agent/issue-3", issueNumber: 3, previousHead: "c", newHead: null,
    outcome: "refused", refusalReason: "stopped after 2 identical path_scope refusals", runStopped: true,
  });
  assert.match(body, /retry budget \| \*\*run stopped\*\*/);
  assert.match(body, /issues\/100/);
});

test("long refusal text is truncated with an explicit pointer to the log", () => {
  const body = buildPrReport({
    prNumber: 1, branch: "agent/issue-1", issueNumber: 1, previousHead: null, newHead: null,
    outcome: "refused", refusalReason: "x".repeat(5_000),
  });
  assert.ok(body.length < 2_000, `comment body must stay comment-sized, got ${body.length}`);
  assert.match(body, /truncated — the full text is in the run log/);
});

test("missing facts degrade to explicit placeholders rather than empty cells", () => {
  const body = buildPrReport({ prNumber: 1, branch: "b", issueNumber: 1, previousHead: null, newHead: null, outcome: "refused" });
  assert.match(body, /\(unknown\)/, "an unknown sha is printed as unknown, not blank");
  assert.ok(!body.includes("| outcome |   |"));
});
