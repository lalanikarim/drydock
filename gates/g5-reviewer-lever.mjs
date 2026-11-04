#!/usr/bin/env node
// #168 hypothesis 2, measured: now that standing lessons reach the REVIEWER (#209), does a review fail a
// boundary-only fix — and does it cite the lesson while doing so?
//
//   node --experimental-strip-types gates/g5-reviewer-lever.mjs                 # all three arms, control A first
//   node --experimental-strip-types gates/g5-reviewer-lever.mjs --arms controlA # one arm (hermetic; run again)
//   node --experimental-strip-types gates/g5-reviewer-lever.mjs --out DIR       # keep artifacts somewhere specific
//
// Why an order, and why it is not cosmetic. `reviewerPrompt` step 4 already tells the reviewer — with NO lessons
// present — to look for "fixes that address a symptom while leaving the root cause intact". So a fail on the
// lesson arm proves nothing on its own; the only clean separation is (a) control A, which measures how often the
// pre-existing rubric rejects this diff by itself, and (b) whether the lesson arm QUOTES the lesson. A fail with no
// quote is scored `no_result`, not as support: it is the reviewer agreeing with us for a reason we did not supply.
//
// Arms:
//   controlA  fixture agent/issue-94, EMPTY lessons file   — the discriminator; run it first.
//   specimen  fixture agent/issue-94, one lesson           — PR#96: typed error + guard in src/server.mjs while
//                                                            toCsv still throws engine errors for direct callers.
//   controlB  fixture agent/issue-93, one lesson           — PR#95: inline Object.assign at the route handler.
//
// Delivery is PROVEN from the durable store, never assumed: after each review the gate lists conversations, finds
// the one carrying the reviewer prompt, and records whether the trusted lessons header is inside that same
// conversation. Control A must say `false` — an unverified delivery would let an empty arm and a broken arm look
// identical, which is the failure mode this repository keeps paying for.
//
// LIMITATION, stated where it can't be missed: in this fixture each domain function has exactly ONE caller (the
// route), so "the same defect stays reachable from another caller" is not instantiated as a live second path. A
// lesson-arm fail therefore enforces rule PLACEMENT (the exported contract of toCsv/reporting.mjs stays unfixed),
// not a second reachable 500. Read the artifacts before writing any conclusion.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCoreInstance } from "../vendor/engram/app/src/core.ts";
import { loadConfig } from "../vendor/engram/app/src/config.ts";
import { factoryReviewerTask, makeReviewerRoleTools } from "../factory/reviewer.ts";
import { loadFactoryEnv } from "./lib.ts";
import { LESSON_TEXT, lessonsContent, validateLessonText } from "./g5-traps.mjs";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const ctx = BACKGROUND_CONTEXT;
loadFactoryEnv();

const fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const image = process.env.FACTORY_SANDBOX_IMAGE ?? "factory-sandbox:latest";
const argv = process.argv.slice(2);
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : mkdtempSync(join(tmpdir(), "lever-"));
mkdirSync(outDir, { recursive: true });

// The header `reviewerLessonsSection` emits (factory/lessons.ts). Matched as a substring; if it drifts, the unit
// tests in test/reviewer-lessons.test.mjs go red before this silently reports "no lessons delivered".
const LESSONS_HEADER = "Standing factory lessons from prior review findings";
const REVIEWER_MARKER = "independent code reviewer";

const ARMS = [
  { label: "controlA", branch: "agent/issue-94", issueNumber: 94, withLesson: false },
  { label: "specimen", branch: "agent/issue-94", issueNumber: 94, withLesson: true },
  { label: "controlB", branch: "agent/issue-93", issueNumber: 93, withLesson: true },
  // Added after the first three arms ran (2026-11-04): controlB failed WITH a lesson and cited it verbatim, but it
  // found a real reproducible defect (`?bucketDays=4294967296` → 500 Invalid array length, curl-verified). A fail on
  // a diff that is actually broken does not prove the lesson caused it — this arm attributes causality. Without it,
  // "lever_supported" on controlB is a claim about the reviewer's competence, not about lessons.
  { label: "controlB_nolesson", branch: "agent/issue-93", issueNumber: 93, withLesson: false },
];
const selected = argv.includes("--arms")
  ? String(argv[argv.indexOf("--arms") + 1]).split(",").map((s) => s.trim())
  : ARMS.map((a) => a.label);
for (const s of selected) if (!ARMS.some((a) => a.label === s)) die(`unknown arm "${s}" (want one of: ${ARMS.map((a) => a.label).join(", ")})`);

function die(msg) {
  console.error(`\ng5-reviewer-lever: ${msg}`);
  process.exit(2);
}

async function resolveModelRef() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) die("OPENAI_BASE_URL is not set — reviews need live inference; a stub here would measure the stub.");
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) die(`GET /models failed: ${res.status} — no inference, no measurement`);
  const list = (await res.json()).data ?? [];
  if (!list.length) die("endpoint reported no models");
  const m = list.find((x) => x.loaded) ?? list[0];
  console.log(`model: ${m.id}`);
  return { provider: "aurora", modelId: m.id };
}

// ---------------------------------------------------------------------------
// Citation detection. A model that follows the rule quotes a FRAGMENT, not the whole lesson, so "verbatim" is
// measured as the longest contiguous word-run of the lesson found in the reviewer's own text. Report the number and
// the matched runs; do not collapse it to a boolean before a human has read the artifacts.
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function longestLessonRun(lessonText, reviewText, { minWords = 6 } = {}) {
  const lesson = norm(lessonText).split(" ");
  const hay = ` ${norm(reviewText)} `;
  let best = { words: 0, text: "" };
  for (let size = Math.min(lesson.length, 24); size >= minWords; size--) {
    if (size <= best.words) break;
    for (let i = 0; i + size <= lesson.length; i++) {
      const run = lesson.slice(i, i + size).join(" ");
      if (run && hay.includes(` ${run} `)) return { words: size, text: run };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// One arm: compose a minimal core instance carrying the PRODUCTION reviewer task (#209's lessonsFile seam), drive it
// with a root tool mirroring open_draft_pr's createTask+waitForTask, then read ground truth from the store.
// ---------------------------------------------------------------------------
async function runArm({ label, branch, issueNumber, withLesson }, modelRef) {
  console.log(`\n=== ${label}: review ${branch} (issue #${issueNumber}), lessons=${withLesson ? "ONE" : "EMPTY"} ===`);
  const root = join(outDir, label);
  const dataDir = join(root, "engram-data");
  const configDir = join(root, "config");
  const workRoot = join(root, "work");
  for (const d of [dataDir, configDir, workRoot]) mkdirSync(d, { recursive: true });

  // Same content rules the G5 arms are held to — a lesson file that names a file/issue/trap token is rejected here
  // rather than silently becoming "solve this bug by name".
  const lessonsPath = join(root, "lessons.md");
  const content = lessonsContent(withLesson, withLesson ? LESSON_TEXT : "");
  if (withLesson) {
    const problems = validateLessonText(LESSON_TEXT);
    if (problems.length) die(`lesson text fails its own rules: ${problems.join("; ")}`);
  }
  writeFileSync(lessonsPath, content, { mode: 0o600 });
  console.log(`  lessons file: ${content.length} bytes`);

  const reviewerTaskDef = factoryReviewerTask({ workDir: workRoot, fixturesRepo, image, lessonsFile: lessonsPath });
  const reviewerRoleTools = makeReviewerRoleTools({ workDir: workRoot });
  const reviewTool = defineTool({
    name: "review",
    description: "Run the independent reviewer on a branch. Returns the verdict JSON.",
    parameters: Type.Object({ branch: Type.String(), issueNumber: Type.Integer() }),
    replay: "unsafe",
    execute: async (args, api, c) => {
      const id = await api.createTask(
        reviewerTaskDef,
        { branch: args.branch, issueNumber: args.issueNumber, ...modelRef },
        { ownership: { kind: "task", taskId: api.taskId } },
        c,
      );
      const settled = await api.waitForTask(id, c);
      return { output: [{ type: "text", text: JSON.stringify(settled.state.outcome?.result ?? { error: String(settled.state.status) }) }] };
    },
  });

  process.env.API_TOKEN = randomBytes(16).toString("hex");
  const config = loadConfig({ dataDir, configDir, workRoot, sandbox: { image, network: "none", allowImages: [image], allowMountRoot: workRoot } });
  const ext = defineExtension({ name: "factory-reviewer", tools: [...reviewerRoleTools, reviewTool], tasks: [reviewerTaskDef] });
  const inst = await createCoreInstance({
    config,
    extraExtensions: [ext],
    port: 0,
    rootAgent: {
      model: modelRef,
      thinkingLevel: "medium",
      tools: [reviewTool],
      instructions:
        "You run one review per message. Call review with the branch and issue number given in the message, wait for its result, then answer with exactly the verdict JSON the tool returned (no other text).",
    },
  });

  try {
    const rootConv = await inst.harness.conversation(inst.rootConversationId, ctx);
    const t0 = Date.now();
    const sub = await rootConv.submit(
      { type: "input", content: `Review branch ${branch} for issue #${issueNumber}. Call review({branch: "${branch}", issueNumber: ${issueNumber}}).`, requestId: `lever-${label}` },
      ctx,
    );
    const settled = await sub.wait(ctx);
    const wallSecs = Math.round((Date.now() - t0) / 1000);

    // Ground truth #1: the reviewer task's durable outcome (not the root agent's prose).
    const page = await rootConv.commit((tx) => tx.scanTasks({ kind: "factory.reviewer" }, 10), ctx);
    const verdict = page.items.length > 0 ? page.items[page.items.length - 1].state.outcome?.result ?? null : null;

    // Ground truth #2 (delivery): find the reviewer conversation in the store and look for the trusted header IN THAT
    // CONVERSATION. Self-identifying via the prompt marker, so it does not depend on checkpoint plumbing.
    const convIds = await inst.harness.commit(async (tx) => (await tx.scanConversations({ order: "descending" }, 100)).items.map((c) => c.id), ctx);
    let reviewerPromptFound = false;
    let lessonsDelivered = false;
    let deliveredFragment = "";
    for (const id of convIds) {
      const conv = await inst.harness.conversation(id, ctx);
      if (!conv) continue;
      const view = await conv.context(ctx);
      const text = norm(JSON.stringify(view ?? ""));
      if (!text.includes(REVIEWER_MARKER)) continue;
      reviewerPromptFound = true;
      lessonsDelivered = text.includes(norm(LESSONS_HEADER));
      deliveredFragment = text.match(/Reformatting an error[^"]{0,80}/)?.[0]?.slice(0, 120) ?? "";
      break;
    }

    const reviewText = [...(verdict?.concerns ?? []), ...(verdict?.evidence ?? [])].join("\n");
    const citation = longestLessonRun(withLesson ? LESSON_TEXT : "", reviewText);

    // Scoring. A fail that cannot quote is not evidence for the lever; see header comment.
    let score;
    if (!verdict || !verdict.verdict) score = "no_result";
    else if (label === "controlA") score = verdict.verdict === "fail" ? "rubric_alone_fails" : "rubric_alone_passes";
    else if (verdict.verdict === "fail" && citation.words >= 8) score = "lever_supported";
    else if (verdict.verdict === "fail") score = "no_result_uncited_fail";
    else score = "lesson_arm_passed";

    const record = {
      label, branch, issueNumber, withLesson, wallSecs,
      settledStatus: settled.status,
      verdict,
      delivery: { reviewerPromptFound, lessonsDelivered, deliveredFragment },
      citationWords: citation.words,
      citationRun: citation.text,
      reviewText,
      score,
    };
    writeFileSync(join(outDir, `${label}.json`), JSON.stringify(record, null, 2));
    console.log(`  verdict=${verdict?.verdict ?? "null"} (${wallSecs}s) delivery={prompt:${reviewerPromptFound},lessons:${lessonsDelivered}} citation=${citation.words}w → ${score}`);
    if (reviewText) console.log(`  concerns/evidence:\n${reviewText.split("\n").map((l) => `    ${l}`).join("\n")}`.slice(0, 2400));
    return record;
  } finally {
    await inst.close();
  }
}

// ---------------------------------------------------------------------------
console.log("G5 reviewer-lever (#168 hypothesis 2)");
console.log(`repo=${fixturesRepo} out=${outDir}`);
try {
  for (const b of new Set(ARMS.map((a) => a.branch))) {
    await sh("gh", ["api", `repos/${fixturesRepo}/git/ref/heads/${b}`, "--jq", ".ref"]);
  }
} catch (e) {
  die(`specimen branch not found on ${fixturesRepo}: ${String(e).slice(0, 200)}`);
}
const modelRef = await resolveModelRef();

const results = [];
for (const arm of ARMS) {
  if (!selected.includes(arm.label)) continue;
  results.push(await runArm(arm, modelRef));
}

writeFileSync(join(outDir, "lever-summary.json"), JSON.stringify({ date: new Date().toISOString(), fixturesRepo, model: modelRef.modelId, results }, null, 2));
console.log(`\nsummary: ${join(outDir, "lever-summary.json")}`);
for (const r of results) {
  console.log(`  ${r.label.padEnd(9)} verdict=${String(r.verdict?.verdict ?? "null").padEnd(5)} lessons_delivered=${r.delivery.lessonsDelivered} citation=${r.citationWords}w ${r.score}`);
}
console.log("\nRead the per-arm JSON before drawing a conclusion; the limitation in the header applies to every outcome here.");
