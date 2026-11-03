// N1 — bash DESTRUCTIVE classification (plan §5.7; history in research/n1-bash-destructive-misclassification.md).
//
// Origin: at pin 51b4d39 the destructive floor was evaluated before the tier table (so it gated
// tools with NO tier entry) and matched unanchored substrings of the raw command line, so
// `>/dev/null`, `grep -rn 'shutdown' src/` and SQL inside a string blocked unattended runs.
// Upstream fixed both halves in engram v0.2.0 (issue #53): bash lines are reduced to simple-command
// candidates before matching (quote-aware split on shell operators, /dev/* redirections dropped,
// quoted spans masked unless the head is a shell interpreter/eval), and a tier may declare
// `containment: "sandbox"` to skip the floor in sandboxed conversations.
//
// What each suite guards now:
//   A. the safety floor must keep catching real destruction — permanent guard, never weaken it;
//   B. the four false positives that started N1 stay ungated — regression guard for #53;
//   C. pin characterization for v0.2.0 through the real approval hook (a pin bump that changes
//      classification fails loudly instead of silently invalidating our findings — plan N4);
//   D. containment declaration semantics (the opt-out we may adopt for factory workers);
//   E. the worker prompt still carries its shell-hygiene rules;
//   F. known narrowings introduced by the fix, asserted as-is so tightening them upstream is visible.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileGates,
  evaluateGate,
  applyContainment,
  destructiveCandidates,
  DEFAULT_DESTRUCTIVE_PATTERNS,
} from "../vendor/engram/app/src/extensions/gates.ts";
import { approvalHook } from "../vendor/engram/app/src/extensions/approvals.ts";

// A minimal policy with bash ABSENT from the tier table, used to measure the kernel's floor in
// isolation. Production no longer looks like this: since issue #40 it declares
// {tool:"bash", containment:"sandbox"} (see factory/gate-policy.ts + test/gate-policy.test.mjs),
// which adds a prompt tier for uncontained conversations and suppresses everything for sandboxed
// ones — that path is covered by suite D here.
const MINIMAL_GATES = { tiers: [{ tool: "merge_pr" }] };
const gates = compileGates(MINIMAL_GATES);
const tierOf = (command, g = gates) => evaluateGate(g, "bash", { command });

// A stub of the hook's execution api: one object satisfying both doc readers (ApprovalRulesDoc
// wants .rules, ConversationMeta wants .sandbox) so the hook path can be driven without a harness.
const hookApi = (sandboxed) => ({ conversationId: 1, snapshot: async () => ({ rules: [], sandbox: sandboxed }) });
const blockFor = async (command, g, sandboxed = false) => {
  const hook = approvalHook(g);
  const beforeTool = hook.handlers?.beforeTool ?? hook.beforeTool;
  const res = await beforeTool({ name: "bash", arguments: { command } }, hookApi(sandboxed), {});
  return res?.block;
};

// ---------------------------------------------------------------- A. safety floor holds

test("A1: the destructive floor applies even with bash absent from the tier table", () => {
  assert.equal(gates.tiers.has("bash"), false, "this suite measures the floor itself");
  for (const command of ["rm -rf /tmp/x", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=disk bs=1M", ":(){ :|:& };:"]) {
    assert.equal(tierOf(command), "destructive", `expected destructive: ${command}`);
  }
});

test("A2: the command matcher cannot be bypassed by chaining, prefixes, or quoting tricks", () => {
  for (const command of [
    "ls -la && rm -rf /data",
    "true | git reset --hard HEAD~1",
    "sudo rm -rf /var/tmp/x", // sudo skipped before the head
    "FOO=bar rm -rf /tmp/x", // env assignment skipped before the head
    "find . | xargs rm -rf", // still an executed rm -rf
    `sh -c "rm -rf /tmp/x"`, // interpreter head: quoted text is live code
    "echo $(rm -rf /tmp/x)", // command substitution is never masked
    "echo `rm -rf /tmp/x`", // backticks are never masked
  ]) {
    assert.equal(tierOf(command), "destructive", `expected destructive: ${command}`);
  }
});

test("A3: reboot/shutdown count only as the command being run", () => {
  assert.equal(tierOf("shutdown -h now"), "destructive");
  assert.equal(tierOf("sudo reboot"), "destructive");
  assert.equal(tierOf("grep -rn 'shutdown' src/"), null, "mentioning a word is not running it");
});

test("A4: deleting build artifacts really is destructive and still blocks", () => {
  // Not a false positive: this is `rm -rf`. Workers avoid it via the prompt hygiene rule;
  // suite D2 covers the containment-declaration alternative.
  assert.equal(tierOf("rm -rf node_modules && npm install"), "destructive");
});

// --------------------------- B. the N1 false positives stay fixed (engram #53 regression guard)

test("B1: discarding output to /dev/null is not a destructive write", () => {
  assert.equal(tierOf("npm ci >/dev/null 2>&1"), null);
  assert.equal(tierOf("cd /sandbox && npm test 2>/dev/null"), null);
});

test("B2: a word appearing as search text is not the action it names", () => {
  assert.equal(tierOf("grep -rn 'shutdown' src/"), null);
  assert.equal(tierOf("cat src/server.mjs | grep reboot"), null);
  // `node -e "console.log('DROP TABLE x')"` used to be asserted null here. It is not any more, and that is
  // the deliberate half of engram#63: under a code-executing head (`sh -c`, `python3 -c`, `node -e`) quoted
  // text IS the program, so masking it was the hole that let `node -e "require('fs').rmSync(...)"` through
  // unclassified (see F1). Data positions in ordinary commands are still masked; interpreter bodies are not
  // data. The cost is a false positive on a harmless `-e` string, which costs one approval prompt rather
  // than a silent bypass — the asymmetry is why we reported it upstream rather than tuned around it.
});

test("B3: writing a script that contains a dangerous line is not running it", () => {
  assert.equal(tierOf("printf '%s\\n' '#!/bin/sh' 'rm -rf /tmp/build' > clean.sh"), null);
});

test("B4: candidate reduction splits simple commands and masks data positions", () => {
  assert.deepEqual(destructiveCandidates("echo hi >/dev/null && grep -rn 'shutdown' src/").length >= 2, true);
  // Candidate reduction still splits on operators and drops discard sinks: the device write disappears,
  // the dangerous simple command survives as its own candidate (observed shape: "echo hi ", "rm -rf /tmp/x").
  const split = destructiveCandidates("echo hi >/dev/null && rm -rf /tmp/x");
  assert.ok(split.length >= 2, `expected a candidate per simple command, got ${JSON.stringify(split)}`);
  assert.ok(!split.some((c) => c.includes("/dev/null")), `discard sinks are dropped, not matched: ${JSON.stringify(split)}`);
  assert.ok(split.some((c) => /rm -rf \/tmp\/x/.test(c)), "the real deletion is still visible as a candidate");
  // …but under a code-executing head the payload reaches the patterns on purpose (engram#63 / F1). Asserting
  // the old masking here would be asserting the vulnerability we asked upstream to close.
  assert.ok(destructiveCandidates(`node -e "rm -rf /"`).some((c) => /rm -rf/.test(c)), "interpreter payload stays visible");
});

// ------------------- C. pin characterization (engram v0.2.1 through the real approval hook, hook level)

test("C1: PIN CHARACTERIZATION v0.2.1 — benign commands run, real destruction blocks", async () => {
  for (const command of ["npm ci >/dev/null 2>&1", "grep -rn 'shutdown' src/", "node --test"]) {
    assert.equal(await blockFor(command, gates), undefined, `expected no block: ${command}`);
  }
  const blocked = await blockFor("rm -rf /var", gates);
  assert.ok(blocked, "expected rm -rf /var to block");
  assert.match(blocked, /classified DESTRUCTIVE/);
});

test("C2: PIN CHARACTERIZATION v0.2.1 — the built-in floor is still not removable by config alone", () => {
  const withExtra = compileGates({ ...MINIMAL_GATES, destructivePatterns: ["\\bpay_money\\b"] });
  assert.ok(withExtra.destructive.length > DEFAULT_DESTRUCTIVE_PATTERNS.length, "destructivePatterns is append-only");
  // RegExp.source re-escapes "/" as "\/", so compare against the same normalization.
  const src = (p) => new RegExp(p).source;
  for (const p of DEFAULT_DESTRUCTIVE_PATTERNS) {
    assert.ok(withExtra.destructive.some((r) => r.source === src(p)), `built-in pattern still compiled: ${p}`);
  }
});

// ---------------------------------------------- D. containment declaration semantics (#53 opt-out)

const CONTAINED = { tiers: [{ tool: "merge_pr" }, { tool: "bash", containment: "sandbox" }] };

test("D1: the declaration is validated and recorded on the tier", () => {
  const g = compileGates(CONTAINED);
  assert.equal(g.tiers.get("bash").containment, "sandbox");
  assert.throws(() => compileGates({ tiers: [{ tool: "bash", containment: "jail" }] }), /unknown containment/);
});

test("D2: applyContainment only suppresses for the declared tool when actually sandboxed", () => {
  const g = compileGates(CONTAINED);
  assert.equal(applyContainment(g, "bash", "destructive", true), null, "declared + contained → ungated");
  assert.equal(applyContainment(g, "bash", "destructive", false), "destructive", "uncontained keeps the floor");
  assert.equal(applyContainment(g, "merge_pr", "prompt", true), "prompt", "undeclared tool untouched");
});

test("D3: hook honors the declaration for a sandboxed conversation and refuses to for an uncontained one", async () => {
  const g = compileGates(CONTAINED);
  assert.equal(await blockFor("rm -rf /var", g, true), undefined, "sealed sidecar: containment is the protection");
  assert.match(await blockFor("node --test", g, false), /requires human approval/, "declaring a tier gates it when uncontained");
  assert.match(await blockFor("rm -rf /var", g, false), /classified DESTRUCTIVE/);
});

// ------------- E. factory posture: the guard + containment declaration are the control, not prose

test("E1: the worker prompt carries no destructive-guard workarounds (issue #40)", async () => {
  const { workerPrompt } = await import("../factory/worker.ts");
  const prompt = workerPrompt({ issueNumber: 7, issueText: "Add pagination" });
  // Belt-and-braces prompt rules were the stopgap for pre-v0.2.0 false positives. With command
  // matching fixed and containment declared (factory/gate-policy.ts), keeping them would hide
  // whether safety came from the guard or from the model complying — so they must stay gone.
  for (const gone of ["Shell hygiene", "/dev/null", "DROP TABLE", "shutdown", "reboot"]) {
    assert.ok(!prompt.includes(gone), `worker prompt must not carry guard workarounds: ${gone}`);
  }
  // The workspace contract is unrelated to the guard and must survive.
  assert.match(prompt, /Stay on branch/, "branch contract is still prompt-enforced");
  assert.match(prompt, /do not push/i, "no-remote rule is still prompt-enforced");
});

// --------- F. narrowings we reported upstream, now closed at v0.2.1 (were characterization at v0.2.0)
//
// These two tests used to document gaps: `null` was the expected answer and the comment said
// "characterization, not endorsement". engram#63 fixed both halves (PR #70, tagged `v0.2.1`, vendored at
// that tag since this bump), so the assertions are inverted — they now guard the floor rather than
// memorialize its holes. That inversion is the point of keeping characterization tests in the first place:
// a bump that changed behavior had to make noise here, and it did.
//
// History, because "why does this file mention two versions" is otherwise unanswerable: #41 reviewed the
// v0.2.0 guard and found (F1) quoted payloads through non-shell interpreter heads classified as data and
// (F2) a redirection drop broad enough to swallow writes to block devices. Filed upstream as engram#63,
// fixed there, re-pinned knowingly on 2026-11-03 after the full suite ran green on this commit.

test("F1: every code-executing interpreter head treats quoted text as live code (v0.2.1, was a gap at v0.2.0)", () => {
  assert.equal(tierOf(`sh -c "rm -rf /tmp/x"`), "destructive");
  assert.equal(tierOf(`python3 -c "import os; os.system('rm -rf /tmp/x')"`), "destructive");
  assert.equal(tierOf(`node -e "require('fs').rmSync('/tmp/x',{recursive:true})"`), "destructive");
});

test("F2: only discard sinks are dropped from redirections; writes to devices still classify (v0.2.1)", () => {
  assert.equal(tierOf("dd if=/dev/zero of=/dev/sda"), "destructive");
  assert.equal(tierOf("echo payload > /dev/sda"), "destructive");
  // The #53 false-positive fix must survive the narrowing: discarding output is not a write.
  assert.equal(tierOf("npm ci >/dev/null 2>&1"), null);
  assert.equal(tierOf("cat x > /dev/null"), null);
});
