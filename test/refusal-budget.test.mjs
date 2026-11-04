// #100 — refusal classification and retry budget (pure logic).
//
// The defect being fixed: issue #99 burned six full worker+review cycles on a task that could not
// succeed, because a path-scope refusal looked like anything else worth retrying. These checks pin the
// two questions the tool result used to leave implicit — *can this ever succeed* and *should this run
// try again* — plus the arithmetic of the budget itself.
//
//   node --experimental-strip-types --test test/refusal-budget.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { RefusalBudget, refusalSignature, isRetryable, normalizeReason, terminalRefusalPayload } = await import("../factory/refusal-budget.ts");

const scopeSig = (files) => ({ class: "path_scope", offenders: files.map((f) => ({ file: f, why: "outside allowlist" })) });

test("classification: policy is permanent, everything else stays retryable", () => {
  assert.equal(isRetryable({ class: "path_scope", offenders: [{ file: "package.json" }] }), false, "policy is read at process start and lives outside the workspace — it cannot change mid-run");
  assert.equal(isRetryable({ class: "verification", reason: "exited 1" }), true);
  assert.equal(isRetryable({ class: "review", reason: "concern" }), true);
  assert.equal(isRetryable({ class: "infrastructure", reason: "cannot compute merge base" }), true, "a transient fault must stay retryable");
});

test("signature: offender order and duplicates do not make a new refusal", () => {
  const a = refusalSignature(scopeSig(["package.json", "gates/lib.ts"]));
  const b = refusalSignature(scopeSig(["gates/lib.ts", "package.json", "package.json"]));
  assert.equal(a, b, "the same set of refused files is the same refusal");
  assert.notEqual(a, refusalSignature(scopeSig(["package.json"])), "one fewer offender is a different situation worth counting separately");
});

test("signature: reasons are normalized but not paraphrased", () => {
  assert.equal(normalizeReason("a  test   failed\n with wrapping  "), "a test failed with wrapping");
  assert.equal(normalizeReason("x".repeat(900)).length, 400);
  const sig = (r) => refusalSignature({ class: "verification", reason: r });
  assert.equal(sig("`npm test` exited 1\n  at foo"), sig("`npm test` exited 1 at foo"));
  assert.notEqual(sig("exited 1"), sig("exited 2"), "a different exit code is a different refusal");
});

test("first identical path-scope refusal: non-retryable but not yet terminal", () => {
  const log = [];
  const budget = new RefusalBudget({ log: (m) => log.push(m) });
  const rec = budget.note(99, scopeSig(["package.json"]));
  assert.equal(rec.retryable, false);
  assert.equal(rec.terminal, false, "one refusal is information; the stop lands on the second");
  assert.equal(rec.count, 1);
  assert.equal(budget.isStopped(99), false);
  assert.deepEqual(log, [], "nothing to log yet");
});

test("second identical refusal stops the run, once", () => {
  const log = [];
  const budget = new RefusalBudget({ log: (m) => log.push(m) });
  budget.note(99, scopeSig(["package.json"]));
  const second = budget.note(99, scopeSig(["package.json"]));
  assert.equal(second.terminal, true);
  assert.match(second.stopReason, /2 identical path_scope refusals/);
  assert.equal(budget.isStopped(99), true);
  assert.equal(log.length, 1, "the stop is announced exactly once");

  // Frozen after the stop: a caller that ignores terminal:true must not inflate the record.
  const third = budget.note(99, scopeSig(["package.json"]));
  assert.equal(third.count, 2);
  assert.equal(third.terminal, true);
  assert.equal(log.length, 1);
});

test("retryable classes also stop when nothing changed between attempts", () => {
  const budget = new RefusalBudget();
  assert.equal(budget.note(5, { class: "verification", reason: "`npm test` exited 1" }).terminal, false);
  // A different failure is genuinely progress and resets nothing about the first one.
  assert.equal(budget.note(5, { class: "verification", reason: "`npm test` exited 127" }).terminal, false);
  const again = budget.note(5, { class: "verification", reason: "`npm test` exited 1" });
  assert.equal(again.terminal, true, "an identical red run twice means nothing changed between attempts");
  assert.equal(again.count, 2);
});

test("varying offenders cannot dodge the ceiling", () => {
  const budget = new RefusalBudget({ maxIdentical: 2, maxTotal: 3 });
  let rec;
  for (const file of ["a.json", "b.json"]) {
    rec = budget.note(7, scopeSig([file]));
    assert.equal(rec.terminal, false, `${file} is the first refusal of its kind`);
  }
  rec = budget.note(7, scopeSig(["c.json"]));
  assert.equal(rec.terminal, true, "four different offenders is flailing, not progress");
  assert.match(rec.stopReason, /no single signature reached 2/);
});

test("infrastructure refusals are recorded but never charged", () => {
  const budget = new RefusalBudget({ maxIdentical: 2, maxTotal: 3 });
  for (let i = 0; i < 10; i++) {
    const rec = budget.note(3, { class: "infrastructure", reason: "cannot compute changed files" });
    assert.equal(rec.retryable, true);
    assert.equal(rec.terminal, false, "a workspace fault must not consume the budget of the real task");
    assert.equal(rec.count, 0);
  }
  assert.equal(budget.isStopped(3), false);
  assert.equal(budget.ledger().length, 10, "the ledger still shows the whole picture for an operator");
  // …and the issue's real budget is untouched afterwards.
  const scope = budget.note(3, scopeSig(["package.json"]));
  assert.equal(scope.total, 1);
});

test("budgets are per issue", () => {
  const budget = new RefusalBudget();
  budget.note(1, scopeSig(["package.json"]));
  assert.equal(budget.note(2, scopeSig(["package.json"])).terminal, false, "a different issue starts clean");
  assert.equal(budget.note(1, scopeSig(["package.json"])).terminal, true);
  assert.deepEqual(budget.stoppedIssues(), [1]);
});

test("misconfigured budgets are refused at construction, not silently ignored", () => {
  assert.throws(() => new RefusalBudget({ maxIdentical: 0 }), /maxIdentical must be a positive integer/);
  assert.throws(() => new RefusalBudget({ maxTotal: -1 }), /maxTotal must be a positive integer/);
  assert.throws(() => new RefusalBudget({ maxIdentical: 1.5 }), /positive integer/);
});

test("summary is empty when nothing stopped and names the issue when something did", () => {
  const budget = new RefusalBudget();
  assert.equal(budget.summary(), "no runs stopped by the refusal budget");
  budget.note(42, scopeSig(["package.json"]));
  budget.note(42, scopeSig(["package.json"]));
  assert.match(budget.summary(), /issue #42/);
  assert.match(budget.summary(), /package\.json|path_scope/);
});

test("the terminal payload tells the model to stop and the human what to change", () => {
  const budget = new RefusalBudget();
  budget.note(9, scopeSig(["package.json"]));
  const payload = terminalRefusalPayload(budget.note(9, scopeSig(["package.json"])));
  assert.equal(payload.refused, true);
  assert.equal(payload.terminal, true);
  assert.equal(payload.runStopped, true);
  assert.equal(payload.retryable, false);
  assert.match(String(payload.hint), /Do not re-delegate/);
  assert.match(String(payload.hint), /pathAllowlist/, "the human route out of the stop is named in the payload");
});

// --------------------------------------------------------------------------- #188: approval blocks

const blockSig = (key) => ({ class: "approval_blocked", reason: `review blocked pending approval ${key} (submit_verdict)`, approvalKey: key });

test("#188 classification: an approval block is neither retryable nor counted", () => {
  assert.equal(isRetryable({ class: "approval_blocked", approvalKey: "aabbccddeeff" }), false,
    "the key is sha1(tool + exact args): a reworded retry asks a question nobody has answered");
  const budget = new RefusalBudget();
  const rec = budget.note(63, blockSig("aabbccddeeff"));
  assert.equal(rec.count, 0, "not charged to the identical-signature budget");
  assert.equal(rec.total, 0, "not charged to the per-issue total either — a policy wall must not consume a task's budget (#188)");
  assert.equal(rec.retryable, false);
  assert.equal(rec.terminal, false, "one block is information; the run stops by not being retryable, not by exhausting a budget");
});

test("#188 signature: identity is the approval key, so 'same wall again' is detectable", () => {
  assert.equal(refusalSignature(blockSig("aabbccddeeff")), "approval_blocked:aabbccddeeff");
  assert.notEqual(refusalSignature(blockSig("112233445566")), refusalSignature(blockSig("aabbccddeeff")),
    "a different key is a genuinely different question being asked of the operator");
  // Without a key there is no identity to claim — fall back, never invent one.
  assert.equal(refusalSignature({ class: "approval_blocked", reason: "blocked" }), "approval_blocked:not-counted");
});

test("#188 budget isolation: a block does not stop a later, genuinely-retryable failure from getting its budget", () => {
  const budget = new RefusalBudget();
  budget.note(63, blockSig("aabbccddeeff"));
  const first = budget.note(63, { class: "verification", reason: "exited 1" });
  assert.equal(first.total, 1, "the block must not have consumed the issue's only allowance");
  assert.equal(first.retryable, true);
});

test("regression guard: infrastructure refusals stay uncounted AND retryable after #188 split those axes", () => {
  // #188 replaced a hardcoded `retryable: true` on the uncounted path with the computed value. Infrastructure must be
  // unaffected by that refactor — if this goes red, transient faults have started suppressing retries.
  const budget = new RefusalBudget();
  const rec = budget.note(5, { class: "infrastructure", reason: "cannot compute merge base" });
  assert.equal(rec.count, 0);
  assert.equal(rec.total, 0);
  assert.equal(rec.retryable, true);
});
