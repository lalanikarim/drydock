// The jq program that builds the issue text a reviewer reads must be asserted against the real `jq` binary, not
// against a stub of it.
//
// Why this file exists: #209 (dfd13f4) shipped `factory/reviewer.ts` with an automated edit spliced into the middle of
// the jq string literal — `'.title + "\import { readLessons, … } from "./lessons.ts";\nn--- body ---\n"'`. The program
// no longer parsed, so `fetchIssue` threw and **every review failed at SPAWN** with `invalid escape sequence "\i"`. It
// reached `main`, passed 611 unit tests, passed CI, and was deployed. Nothing in the suite called `fetchIssue`, and a
// type checker cannot see inside a string that only a remote tool interprets.
//
// So: run the program through jq for real. The assertions below are on observable output — what the reviewer would be
// handed — for the payload shapes GitHub actually returns (body present, body null). Where jq is not installed the test
// skips with a printed reason rather than passing silently; an unrun check and a passing check must not look alike
// (the R6b/R10 rule in AGENTS.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const { ISSUE_TEXT_JQ } = await import("../factory/reviewer.ts");

let jqAvailable = true;
try {
  execFileSync("jq", ["--version"], { stdio: "pipe" });
} catch {
  jqAvailable = false;
}

function runJq(payload) {
  return execFileSync("jq", ["-r", ISSUE_TEXT_JQ], { input: JSON.stringify(payload), encoding: "utf8" });
}

test("the issue-text jq program parses under the real jq binary", { skip: jqAvailable ? false : "jq not installed on PATH — this check cannot run" }, () => {
  // The corruption was a jq *parse* failure, so this is the load-bearing assertion.
  assert.doesNotThrow(() => runJq({ title: "t", body: "b" }));
});

test("it renders title, separator, and body exactly as the reviewer expects", { skip: jqAvailable ? false : "jq not installed on PATH — this check cannot run" }, () => {
  const out = runJq({ title: "GET /exports/invoices 500s", body: "any columns value returns an engine message" });
  assert.equal(out, "GET /exports/invoices 500s\n--- body ---\nany columns value returns an engine message\n");
});

test("a null body yields the separator and no literal 'null' in the prompt", { skip: jqAvailable ? false : "jq not installed on PATH — this check cannot run" }, () => {
  // The program's own trailing "\n" plus jq's output newline; `fetchIssue` trims (see the trim in sh()).
  const out = runJq({ title: "no body yet", body: null });
  assert.equal(out, "no body yet\n--- body ---\n\n");
  assert.equal(out.trim(), "no body yet\n--- body ---");
  assert.equal(out.includes("null"), false);
});

test("the program carries no source code — the exact shape of the dfd13f4 regression", { skip: jqAvailable ? false : "jq not installed on PATH — this check cannot run" }, () => {
  // A splice is only detectable structurally if something asserts the program's boundaries: one expression, two
  // string literals plus the fallback, and never an import statement or a bare newline escape gone sideways.
  assert.doesNotMatch(ISSUE_TEXT_JQ, /\bimport\b/, "a jq program contains no JavaScript import — this string was corrupted that way once");
  assert.doesNotMatch(ISSUE_TEXT_JQ, /[\r\n]/, "the program must be a single line; a spliced newline is what broke it");
  assert.match(ISSUE_TEXT_JQ, /^\.title \+ "\\n--- body ---\\n" \+ \(\.body \/\/ ""\)$/);
});
