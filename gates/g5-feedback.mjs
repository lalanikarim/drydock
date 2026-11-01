// Phase 2 battery — Gate G5: feedback loop ("the same mistake doesn't recur").
// Production entrypoint (factory/main.ts child processes via gates/lib.ts).
//
// The anchor finding (from a real prior run): on issue #11 (PR #12) the worker
// fixed "validation errors surface as 500" with a HANDLER-LEVEL patch —
// `catch (e) { if (e instanceof TypeError) throw Object.assign(new Error(...), { statusCode: 400 }) }`
// in createInvoice — instead of giving the error class a statusCode like
// InvoiceNotFoundError already has. The independent reviewer flagged exactly
// this fragility ("if store.add ever throws a non-TypeError validation error,
// it would again surface as 500").
//
// Similar issue for the re-run: fixture issue #13 — invalid status transitions
// return 500 (InvalidTransitionError has no statusCode) against the README's
// 4xx spec. The naive fix is the same handler-level patch; the corrected
// behavior is a root-level fix (statusCode on the error class).
//
// Experiment:
//   Step A (baseline, lessons file empty): work directive for issue #13.
//     Record the reviewer verdict + objective classification of the fix pattern
//     (rootFix vs handlerPatch) from a fresh clone's diff.
//   Lesson: ensure one standing lesson is recorded via note_lesson (the
//     orchestrator does this on refusal per its instructions; if it skipped,
//     the battery — acting as the human driver — submits a trusted instruction
//     to record the distilled finding. This is counted as an intervention.)
//   Step B (lessons active): fresh store, same lessons file, work directive
//     for issue #13 again. Expect review PASS and objective root-level fix.
//
// G5 passes when: the lesson was recorded durably AND step B's review passed
// AND step B's diff shows the root-level fix (no handler patch). Attribution
// strength is reported separately: "strong" if step A exhibited the handler
// patch that then disappeared, "single-trial" otherwise.
//
// Usage: node --experimental-strip-types gates/g5-feedback.mjs  (env: G5_ISSUE=19)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactoryEnv, spawnInstance, postTask, rootConversationId, waitForToolResult } from "./lib.ts";
import { defaultConfigPathFor } from "../factory/factory-config.ts";

const pexec = promisify(execFile);
loadFactoryEnv();
const fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";

const ISSUE = Number(process.env.G5_ISSUE ?? 19);
const runDir = mkdtempSync(join(tmpdir(), "gates-g5-"));
const LESSONS_FILE = join(runDir, "g5-lessons.md");

// Distilled lesson used by the human-driver fallback when the orchestrator does
// not record one itself. Derived from the PR #12 reviewer concern (issue #11).
const FALLBACK_LESSON =
  `Fix error-status bugs at the root: give the thrown error class a statusCode property (as InvoiceNotFoundError does for issue #11), not an instanceof/catch-and-rethrow patch in the route handler.`;

let failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
}

const parseJsonLoose = (text) => {
  const i = text.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i)); } catch { return null; }
};

/** Objective classification of the fix on agent/issue-N vs origin/main (fresh clone). */
async function classifyFix({ issueNumber }) {
  const dir = mkdtempSync(join(tmpdir(), "g5-clone-"));
  try {
    await pexec("git", ["clone", "-q", `https://github.com/${fixturesRepo}.git`, dir], { timeout: 90_000 });
    const branch = `origin/agent/issue-${issueNumber}`;
    await pexec("git", ["fetch", "-q", "origin", `agent/issue-${issueNumber}:refs/remotes/${branch}`], { cwd: dir, timeout: 60_000 });
    const storeDiff = (await pexec("git", ["diff", `origin/main..${branch}`, "--", "src/store.mjs"], { cwd: dir })).stdout;
    const invoicesDiff = (await pexec("git", ["diff", `origin/main..${branch}`, "--", "src/invoices.mjs"], { cwd: dir })).stdout;
    // root-level fix: a statusCode=4xx line added to src/store.mjs (error class carries the status)
    const rootFix = /^\+\s+this\.statusCode\s*=\s*4\d\d/m.test(storeDiff);
    // handler-level patch: new instanceof or catch-with-status in the route handler
    const handlerPatch = /instanceof/.test(invoicesDiff) || (/^\+.*catch/m.test(invoicesDiff) && /400|409|statusCode/.test(invoicesDiff));
    return {
      rootFix,
      handlerPatch,
      storeDiff: storeDiff.slice(0, 1500),
      invoicesDiff: invoicesDiff.slice(0, 1500),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Per-run factory config override: both steps share ONE lessons file even though
// each gets a fresh instance root/store.
// Runtime config is outside the tree now ($DRYDOCK_CONFIG_DIR); resolve it the way the factory does rather
// than reaching for a path in the checkout that no longer exists.
const baseCfgPath = new URL(`file://${defaultConfigPathFor(fixturesRepo)}`);
const cfg = JSON.parse(readFileSync(baseCfgPath, "utf8"));
cfg.lessonsFile = LESSONS_FILE;
const cfgPath = join(runDir, "factory-config-override.json");
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

async function runStep({ label, issueNumber }) {
  const instance = await spawnInstance({ repo: fixturesRepo, configPath: cfgPath });
  let draftText = null;
  let noteLessonResult = null;
  let lessonIntervention = false;
  try {
    await postTask(instance.base, instance.token, `Work issue number: ${issueNumber}`, `g5-${label}-${randomUUID()}`);

    // open_draft_pr settles with either a refusal (review failed) or a prUrl.
    const convId = await rootConversationId(instance.base, instance.token);
    draftText = await waitForToolResult(
      instance.base, instance.token, convId, "open_draft_pr",
      (t) => t.includes('"refused": true') || t.includes('"prUrl"'),
      15 * 60_000,
    );
    const draftJson = parseJsonLoose(draftText) ?? {};

    // If refused: the orchestrator should record a lesson via note_lesson.
    if (draftJson.refused) {
      try {
        const rec = await waitForToolResult(instance.base, instance.token, convId, "note_lesson", () => true, 120_000);
        noteLessonResult = parseJsonLoose(rec);
      } catch { /* orchestrator did not record one — fallback below */ }
    }

    // Human-driver fallback: ensure exactly one lesson is on the books.
    const lessonsBefore = existsSync(LESSONS_FILE) ? readFileSync(LESSONS_FILE, "utf8").trim() : "";
    if (!lessonsBefore) {
      await postTask(instance.base, instance.token, `Record this standing lesson with note_lesson now: "${FALLBACK_LESSON}"`, `g5-${label}-lesson-${randomUUID()}`);
      const rec = await waitForToolResult(instance.base, instance.token, convId, "note_lesson", () => true, 180_000);
      noteLessonResult = parseJsonLoose(rec);
      lessonIntervention = true;
    }

    return { label, draftJson, noteLessonResult, lessonIntervention };
  } finally {
    await instance.close();
  }
}

async function main() {
  console.log(`G5 feedback loop — issue #${ISSUE}, lessons file: ${LESSONS_FILE}`);
  const t0 = Date.now();

  // Preflight.
  try {
    await fetch(`${process.env.OPENAI_BASE_URL ?? ""}/models`, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error(`inference unreachable: ${e.message}`);
    process.exit(2);
  }

  // Step A — baseline, no lessons.
  const a = await runStep({ label: "A", issueNumber: ISSUE });
  console.log(`step A settled: refused=${a.draftJson.refused ?? "?"} prUrl=${a.draftJson.prUrl ?? "-"} note_lesson=${a.noteLessonResult?.recorded ?? "-"}`);

  // Objective classification of step A's fix (only if a branch exists).
  let classifyA = null;
  try {
    classifyA = await classifyFix({ issueNumber: ISSUE });
    console.log(`step A fix pattern: rootFix=${classifyA.rootFix} handlerPatch=${classifyA.handlerPatch}`);
  } catch (e) {
    console.log(`step A classification unavailable (${e.message}) — likely no branch (refused run)`);
  }

  const lessons = existsSync(LESSONS_FILE) ? readFileSync(LESSONS_FILE, "utf8").trim() : "";
  if (!lessons) fail("no lesson recorded after step A");

  // Step B — same issue, lessons active, fresh store.
  const b = await runStep({ label: "B", issueNumber: ISSUE });
  console.log(`step B settled: refused=${b.draftJson.refused ?? "?"} prUrl=${b.draftJson.prUrl ?? "-"}`);

  let classifyB = null;
  try {
    classifyB = await classifyFix({ issueNumber: ISSUE });
    console.log(`step B fix pattern: rootFix=${classifyB.rootFix} handlerPatch=${classifyB.handlerPatch}`);
  } catch (e) {
    fail(`step B classification failed: ${e.message}`);
  }

  // G5 checks.
  if (!lessons) fail("lesson not recorded durably");
  if (b.draftJson.refused) fail(`step B review did not pass: ${JSON.stringify(b.draftJson).slice(0, 400)}`);
  if (!b.draftJson.prUrl) fail("step B produced no PR");
  if (classifyB && !classifyB.rootFix) fail("step B fix is not root-level (no statusCode added to the error class in src/store.mjs)");
  if (classifyB && classifyB.handlerPatch) fail("step B still uses a handler-level patch (instanceof/catch-and-rethrow)");

  const attribution = classifyA?.handlerPatch ? "strong (baseline exhibited the handler patch; it did not recur)" : "single-trial (baseline did not exhibit the pattern; corrected behavior verified once with lessons active)";
  const passed = failures.length === 0;
  const result = {
    gate: "G5",
    issueNumber: ISSUE,
    anchorFinding: "PR #12 (issue #11) reviewer concern: handler-level instanceof patch instead of statusCode on the error class",
    lessonsFile: LESSONS_FILE,
    lesson: lessons.split("\n").map((l) => l.trim()).filter(Boolean),
    stepA: { refused: a.draftJson.refused ?? null, prUrl: a.draftJson.prUrl ?? null, noteLesson: a.noteLessonResult, lessonIntervention: a.lessonIntervention, fixPattern: classifyA ? { rootFix: classifyA.rootFix, handlerPatch: classifyA.handlerPatch } : null, diffExcerpts: classifyA ? { storeDiff: classifyA.storeDiff, invoicesDiff: classifyA.invoicesDiff } : null },
    stepB: { refused: b.draftJson.refused ?? null, prUrl: b.draftJson.prUrl ?? null, lessonIntervention: b.lessonIntervention, fixPattern: classifyB ? { rootFix: classifyB.rootFix, handlerPatch: classifyB.handlerPatch } : null, diffExcerpts: classifyB ? { storeDiff: classifyB.storeDiff, invoicesDiff: classifyB.invoicesDiff } : null },
    attribution,
    failures,
    wallSecs: Math.round((Date.now() - t0) / 1000),
    passed,
  };
  writeFileSync(join(runDir, "g5-results.json"), JSON.stringify(result, null, 2));
  console.log(`results: ${join(runDir, "g5-results.json")}`);
  console.log(`\nGATE G5: ${passed ? "PASS" : "FAIL"} (${result.wallSecs}s) attribution=${attribution}`);
  if (!passed) console.log(JSON.stringify(failures, null, 2));
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("G5 battery error:", e);
  process.exit(1);
});
