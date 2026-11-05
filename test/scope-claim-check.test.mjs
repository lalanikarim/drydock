// #238 — the mechanical check #230 deliberately left out: hash the issue body at abort, compare at retry.
//
// Live shape this catches (drydock#230, build `6ce582e`): an operator reopen reason came back as the model's claim
// that "the issue has since been sliced down to assertion 4 only". It had not been. #230 made that visible as
// `replanSource=model` — nobody authorized it — but nothing could say the sentence was false, because the fact that
// contradicts it (the body's bytes are unchanged) was sitting in GitHub, cheaply readable.
//
// The fake is hostile in the direction reality is: a prober that returns the SAME body while the claim says it
// changed, a prober that errors, and no prober at all. "Could not check" must never collapse into "checked, fine".
import test from "node:test";
import assert from "node:assert/strict";

import { factoryDelegateTool } from "../factory/worker.ts";
import {
  emptyBudgetLedger,
  grantReopenAttempt,
  noteBudgetAbort,
  noteOperatorAbort,
} from "../factory/budget-ledger.ts";
import { canonicalText, compareIssueText, hashIssueText, makeGhIssueProber, shortSha } from "../factory/issue-body-sha.ts";
import { beyondBoundaryThrows, captureLogs, ledgerAfterOneBudgetAbort, ledgerApi, NOW, textOf } from "./helpers/delegate-fake-api.mjs";

const MODEL = { provider: "aurora", modelId: "some/served-model" };
const BODY_AT_ABORT = "## Task\n\nImplement the drift check across assertions 1-9.\n";
const EDITED_BODY = "## Task\n\nImplement the drift check. Slice reduced to assertion 4 only.\n";

const SHA_AT_ABORT = hashIssueText(BODY_AT_ABORT);

// ---------------------------------------------------------------- pure comparison

test("hashIssueText is stable, content-sensitive, and not accidentally short", () => {
  assert.equal(hashIssueText(BODY_AT_ABORT), SHA_AT_ABORT);
  // Inverted from how this test was first written. It asserted a trailing newline WAS a change — and a live run
  // against drydock#220 proved that assumption would have made the check never fire: `gh api --jq .body` appends a
  // newline, the in-process body has none, so abort-time and retry-time hashes of an UNCHANGED issue differed.
  // Trailing newlines are therefore canonicalized away; everything inside the body still counts. See canonicalBody().
  assert.equal(hashIssueText(BODY_AT_ABORT + "\n"), SHA_AT_ABORT, "trailing newline is transport noise (jq adds one) — not a spec change");
  assert.equal(hashIssueText(BODY_AT_ABORT.replace(/\n/g, "\r\n")), SHA_AT_ABORT, "CRLF from any hop canonicalizes to the same hash");
  assert.notEqual(hashIssueText(BODY_AT_ABORT + " \n"), SHA_AT_ABORT, "a trailing SPACE is content — only newlines are stripped");
  assert.equal(canonicalText("a\r\nb\n\n"), "a\nb", "canonical form: LF, no trailing newlines");
  assert.match(SHA_AT_ABORT, /^[0-9a-f]{64}$/);
  assert.equal(shortSha(SHA_AT_ABORT), SHA_AT_ABORT.slice(0, 8));
});

test("compareIssueText: identical bytes contradict a claim of change", () => {
  const r = compareIssueText(SHA_AT_ABORT, { sha: hashIssueText(BODY_AT_ABORT), textLength: BODY_AT_ABORT.length });
  assert.equal(r.verdict, "contradicted");
  assert.match(r.detail, /byte-identical/);
  assert.match(r.detail, new RegExp(shortSha(SHA_AT_ABORT)), "the log must name the hash an operator can grep for");
});

test("compareIssueText: different bytes clear the claim without proving it", () => {
  const r = compareIssueText(SHA_AT_ABORT, { sha: hashIssueText(EDITED_BODY), textLength: EDITED_BODY.length });
  assert.equal(r.verdict, "clear");
  assert.match(r.detail, /changed since abort/);
});

test("compareIssueText: two distinct kinds of unknown, neither of them 'clear'", () => {
  const missing = compareIssueText(undefined, { sha: hashIssueText(EDITED_BODY), bodyLength: 1 });
  assert.equal(missing.verdict, "unavailable");
  assert.match(missing.detail, /no issue hash was recorded at abort/);

  const failed = compareIssueText(SHA_AT_ABORT, { error: "Error: HTTP 403" });
  assert.equal(failed.verdict, "unavailable");
  assert.match(failed.detail, /could not re-read the issue/);
  assert.match(failed.detail, /403/, "the reason survives into the record — 'unavailable' alone is unactionable");
});

// ---------------------------------------------------------------- abort-time recording

test("a budget abort records the body hash; the latest abort wins and no-hash never erases one", () => {
  const ledger = emptyBudgetLedger();
  noteBudgetAbort(ledger, 220, { reason: "first overrun", bodySha: SHA_AT_ABORT, at: NOW() });
  assert.equal(ledger.issues["220"].bodyShaAtAbort, SHA_AT_ABORT);

  // Second abort carrying a newer body: the hash tracks the most recent failure, which is the one being retried.
  const editedSha = hashIssueText(EDITED_BODY);
  noteBudgetAbort(ledger, 220, { reason: "second overrun", bodySha: editedSha, at: NOW() });
  assert.equal(ledger.issues["220"].bodyShaAtAbort, editedSha, "latest wins");

  // An abort where the worker never saw a body must not destroy the earlier evidence — but must not invent one either.
  noteBudgetAbort(ledger, 220, { reason: "overrun with no body in hand", at: NOW() });
  assert.equal(ledger.issues["220"].bodyShaAtAbort, editedSha, "absent input leaves the prior hash alone (#238)");
});

test("an operator abort never writes or clears the spec hash (#141's rule extended)", () => {
  const ledger = emptyBudgetLedger();
  noteBudgetAbort(ledger, 220, { reason: "overrun", bodySha: SHA_AT_ABORT, at: NOW() });
  noteOperatorAbort(ledger, 220, { reason: "operator stopped it", at: NOW() });
  assert.equal(ledger.issues["220"].bodyShaAtAbort, SHA_AT_ABORT, "a human pressing stop says nothing about the spec");

  const fresh = emptyBudgetLedger();
  noteOperatorAbort(fresh, 7, { reason: "stop", at: NOW() });
  assert.equal(fresh.issues["7"].bodyShaAtAbort, undefined, "and must not create a hash out of nothing");
});

// ---------------------------------------------------------------- delegate integration

const proberReturning = (text, calls) => async () => {
  if (calls) calls.n = (calls.n ?? 0) + 1;
  return { sha: hashIssueText(text), textLength: text.length };
};
const failingProber = (calls) => async () => {
  if (calls) calls.n = (calls.n ?? 0) + 1;
  return { error: "Error: gh exited 1 (rate limited)" };
};

test("model claims scope change against an UNCHANGED body → contradicted, recorded, and said out loud", async () => {
  const ledger = ledgerAfterOneBudgetAbort({ bodyShaAtAbort: SHA_AT_ABORT });
  const { created, api } = ledgerApi(ledger);
  const calls = { n: 0 };

  const { lines } = await captureLogs(() =>
    factoryDelegateTool({ taskDef: {}, modelRef: MODEL, bodyProber: proberReturning(BODY_AT_ABORT, calls) }).execute(
      { issueNumber: 220, replan: "the issue has since been sliced down to assertion 4 only" },
      api,
      {},
    ),
  );

  assert.equal(created.length, 1, "#238 reports; it does NOT refuse (that trade-off needs decision-log.md)");
  const claim = ledger.issues["220"].scopeClaim;
  assert.equal(claim.verdict, "contradicted", "the durable record is what an operator greps for later");
  assert.match(claim.detail, /byte-identical/);
  assert.ok(Number.isInteger(claim.at));

  const log = lines.join("\n");
  assert.match(log, /byte-identical to the one at abort/);
  assert.match(log, /claimedScopeChangeUnverified=true/);
  assert.match(log, /#238/);
  assert.match(log, /proceeding: this reports, it does not refuse/i, "and says what it will NOT do, so nobody over-reads it");

  // Non-vacuity per the acceptance list: #230's line and #238's line must be different sentences, not one line
  // with a number changed — otherwise an operator reading "#… (#NNN)" learns nothing new.
  const strip = (s) => s.replace(/#\d+/g, "#N").replace(/\d+/g, "0");
  const line230 = lines.find((l) => /MODEL-AUTHORED/.test(l));
  const line238 = lines.find((l) => /byte-identical/.test(l));
  assert.ok(line230 && line238, "both lines must be present for the comparison to mean anything");
  assert.notEqual(strip(line230), strip(line238), "#238's line is #230's with different digits — that is not a new signal");
});

test("the body really was edited → clear, and no contradiction language", async () => {
  const ledger = ledgerAfterOneBudgetAbort({ bodyShaAtAbort: SHA_AT_ABORT });
  const { created, api } = ledgerApi(ledger);
  const calls = { n: 0 };

  const { lines } = await captureLogs(() =>
    factoryDelegateTool({ taskDef: {}, modelRef: MODEL, bodyProber: proberReturning(EDITED_BODY, calls) }).execute(
      { issueNumber: 220, replan: "issue sliced to assertion 4" },
      api,
      {},
    ),
  );

  assert.equal(created.length, 1);
  assert.equal(calls.n, 1, "one read on this path — never a per-delegate cost");
  assert.equal(ledger.issues["220"].scopeClaim.verdict, "clear");
  const log = lines.join("\n");
  assert.doesNotMatch(log, /byte-identical/);
  assert.match(log, /consistent with an edited issue body/);
});

test("a failing GitHub read is 'unavailable', never a silent pass — and the attempt still runs", async () => {
  const ledger = ledgerAfterOneBudgetAbort({ bodyShaAtAbort: SHA_AT_ABORT });
  const { created, api } = ledgerApi(ledger);

  const { lines } = await captureLogs(() =>
    factoryDelegateTool({ taskDef: {}, modelRef: MODEL, bodyProber: failingProber() }).execute(
      { issueNumber: 220, replan: "the issue has since been sliced down to assertion 4 only" },
      api,
      {},
    ),
  );

  assert.equal(created.length, 1, "a degraded check must not cost the run its attempt (nor vouch for the claim)");
  const claim = ledger.issues["220"].scopeClaim;
  assert.equal(claim.verdict, "unavailable");
  assert.match(lines.join("\n"), /NOT a pass/);
});

test("no prober configured is reported as unknown, not skipped silently", async () => {
  const ledger = ledgerAfterOneBudgetAbort({ bodyShaAtAbort: SHA_AT_ABORT });
  const { created, api } = ledgerApi(ledger);

  const { lines } = await captureLogs(() =>
    factoryDelegateTool({ taskDef: {}, modelRef: MODEL }).execute(
      { issueNumber: 220, replan: "sliced down to assertion 4" },
      api,
      {},
    ),
  );

  assert.equal(created.length, 1);
  assert.equal(ledger.issues["220"].scopeClaim.verdict, "unavailable");
  assert.match(ledger.issues["220"].scopeClaim.detail, /no body prober|no body hash/);
});

test("an operator grant is permission, not a claim: no probe, no scope verdict (#230's distinction preserved)", async () => {
  const ledger = ledgerAfterOneBudgetAbort({ bodyShaAtAbort: SHA_AT_ABORT });
  grantReopenAttempt(ledger, 220, { requestId: "issue-220#reopen-1", reason: "retried with a bigger budget", at: NOW() });
  const { created, api } = ledgerApi(ledger);
  const calls = { n: 0 };

  const { lines } = await captureLogs(() =>
    factoryDelegateTool({ taskDef: {}, modelRef: MODEL, bodyProber: proberReturning(BODY_AT_ABORT, calls) }).execute(
      { issueNumber: 220 },
      api,
      {},
    ),
  );

  assert.equal(created.length, 1);
  assert.equal(calls.n, 0, "a human authorized this — there is no model claim to check against bytes");
  assert.equal(ledger.issues["220"].scopeClaim, undefined, "and nothing is recorded that would read as a contradicted claim");
  assert.match(lines.join("\n"), /OPERATOR GRANT/);
});

test("a fresh issue that volunteers `replan` text is not scope-checked", async () => {
  const ledger = emptyBudgetLedger();
  const { created, api } = ledgerApi(ledger);
  const calls = { n: 0 };

  await factoryDelegateTool({ taskDef: {}, modelRef: MODEL, bodyProber: proberReturning(BODY_AT_ABORT, calls) }).execute(
    { issueNumber: 220, replan: "volunteered context on a first attempt" },
    api,
    {},
  );

  assert.equal(created.length, 1);
  assert.equal(calls.n, 0, "the read is scoped to the post-abort path only (#238's constraint)");
  assert.equal(ledger.issues["220"].scopeClaim, undefined);
});

test("a refusal path performs no probe at all (the check lives downstream of every refusal)", async () => {
  const calls = { n: 0 };
  const api = beyondBoundaryThrows([]);
  api.snapshot = async () => ledgerAfterOneBudgetAbort({ bodyShaAtAbort: SHA_AT_ABORT });

  const result = await factoryDelegateTool({ taskDef: {}, modelRef: MODEL, bodyProber: proberReturning(EDITED_BODY, calls) }).execute(
    { issueNumber: 220 },
    api,
    {},
  );

  assert.equal(JSON.parse(textOf(result)).requires, "replan");
  assert.equal(calls.n, 0, "a call refused for lacking prose must not spend a GitHub read");
});

// ---------------------------------------------------------------- the real prober's contract

test("makeGhIssueProber reads the SAME projection the worker is shown, and hashes it (#238's dead-check bug)", async () => {
  const seen = [];
  const exec = async (_cmd, args) => {
    seen.push(args);
    return { stdout: "Some title\n--- body ---\n" + BODY_AT_ABORT };
  };
  const probed = await makeGhIssueProber({ repo: "o/r", token: "t", exec })(9);

  const jq = seen[0][seen[0].indexOf("--jq") + 1];
  assert.match(jq, /\.title/, "the abort side hashes title+separator+body; a prober reading .body alone compares different things and reports clear forever");
  assert.match(jq, /--- body ---/);
  assert.equal(probed.sha, hashIssueText("Some title\n--- body ---\n" + BODY_AT_ABORT));
});

test("makeGhIssueProber: a failed gh run is 'unknown' with the reason preserved — never a sha", async () => {
  const err = await makeGhIssueProber({
    repo: "o/r",
    exec: async () => {
      throw new Error("HTTP 403");
    },
  })(9);
  assert.ok("error" in err && !("sha" in err), "a failed read must not produce a sha at all (#238's failure posture)");
  assert.match(err.error, /403/);
});

test("makeGhIssueProber: an expiring credential is minted per call, and its failure is also 'unknown'", async () => {
  let minted = 0;
  await makeGhIssueProber({
    repo: "o/r",
    token: async () => {
      minted += 1;
      return `token-${minted}`;
    },
    exec: async () => ({ stdout: "t\n--- body ---\nb" }),
  })(1);
  assert.equal(minted, 1, "an App installation token must not be cached across calls");

  const dead = await makeGhIssueProber({
    repo: "o/r",
    token: async () => {
      throw new Error("no installation token: app credentials unavailable");
    },
    exec: async () => ({ stdout: "" }),
  })(1);
  assert.ok("error" in dead, "a credential that cannot be minted is unknown — not a crash, not a pass");
});
