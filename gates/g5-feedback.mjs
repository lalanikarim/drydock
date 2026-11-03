#!/usr/bin/env npx tsx
/**
 * G5 — does a recorded lesson change what the worker does?
 *
 * Run twice against the same model on two **equivalent** trap issues: arm A with an empty lessons file, arm B with one
 * lesson recorded. If the feedback loop works, A reproduces the anti-pattern and B fixes the rule at its source.
 *
 * ```
 * npx tsx gates/g5-feedback.mjs --repo lalanikarim/factory-fixture --issue-a 62 --issue-b 63
 * npx tsx gates/g5-feedback.mjs --repo ... --issue-a .. --issue-b .. --keep     # keep clone/logs/lessons
 * ```
 * Roughly 10-40 minutes: two full worker+reviewer runs against the local inference node. It consumes its traps —
 * whichever arm produces a PR has it merged into the fixture by the fixture's own policy, so re-running needs a fresh
 * equivalent pair (see gates/g5-traps.mjs).
 *
 * ## Why this file was rewritten (#145)
 *
 * The previous version ran **both arms against one issue**. Arm A created `agent/issue-N` and its PR; arm B spawned a
 * fresh instance for the same issue, which found the work already done and produced nothing. Arm B's diff was then
 * computed as `origin/main..origin/agent/issue-N` — arm A's commit — so the two "arms" were one artifact measured
 * twice, and the gate printed "attribution=strong" over a measurement of nothing.
 *
 * Two more defects lived here, both silent:
 *
 * - Its fix detector looked for one string in one file (`this.statusCode = 4\d\d` in `src/store.mjs`) — the shape
 *   issue #19's fix happened to take. A correct fix that validated input once in a shared place could not satisfy it,
 *   so the gate could never have passed on new data. Classification now lives in `gates/fix-pattern.mjs` and is tested
 *   against three real captured diffs (`test/g5-harness.test.mjs`).
 * - It wrote a config override containing `lessons: { enabled, file }`, plus `ghCliPath`, `pipelineModelId`,
 *   `reviewerModelId`, `refine`. None of those are config fields; `loadFactoryConfig` throws on unknown fields at
 *   boot. The field the worker reads is `lessonsFile`, so arm B would have run with no lesson even if everything else
 *   had worked.
 *
 * ## What is enforced now
 *
 * - Two issues, two branches, two PRs — required, checked before anything spawns (`preflightArms` in g5-traps.mjs),
 *   and the run fails if an arm produced an empty diff or both arms resolved to one artifact. "Nothing measured" is a
 *   failure, never a pass.
 * - Each arm's diff is `merge-base(main, its own branch)..its own branch`, captured per arm — never `main..branch`
 *   after the fact, because A merging moves main underneath B and silently changes what B's diff contains.
 * - A refusal is read from `open_draft_pr`'s tool result as three states (refused / not refused / unknown), using the
 *   shapes production emits: a refusal carries `{refused:true, reason}` and a success carries `{prUrl,…}` — there is no
 *   `refused:false`. If nothing was seen in the root conversation the scan widens to every conversation, and if still
 *   nothing, a PR on the arm's own branch settles it as "not refused"; otherwise it stays `unknown` with the reason
 *   recorded in `g5-results.json` (`refusalReason`, `outcomeConversation`, `outcomeRaw`). Treating "no outcome" as "did
 *   not refuse" made an unfinished run look clean; reading a field that is never sent made every successful run read
 *   unknown, which is #169.
 * - Traps are described by symptom only, never by where the fix belongs — an issue that says "fix this in the domain
 *   layer" measures instruction-following, not the lesson.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startIntakeServer } from "../factory/intake.ts";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, rootConversationId, findToolResultAcrossConversations } from "./lib.ts";
import { classifyFixPattern, formatClassification } from "./fix-pattern.mjs";
import { contractFor, preflightArms, armBranch, lessonsContent, validateLessonText, experimentVerdict, refusalState, LESSON_TEXT } from "./g5-traps.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const REPO = flagValue("--repo") ?? process.env.G5_REPO;
const ISSUE_A = flagValue("--issue-a") ?? process.env.G5_ISSUE_A;
const ISSUE_B = flagValue("--issue-b") ?? process.env.G5_ISSUE_B;
const KEEP = argv.includes("--keep");
// Arm B's lesson text. Defaults to LESSON_TEXT in g5-traps.mjs; a file replaces it so the experiment can ask whether
// the *form* of a recorded lesson matters (#168) without editing the constant between runs. Held to the same rules as
// the default — no filename, no issue number, no trap identifier — because the escape hatch is the thing that needs
// guarding.
const LESSON_FILE = flagValue("--lesson-file") ?? process.env.G5_LESSON_FILE;
const ALLOW_STALE = argv.includes("--allow-stale-branches");
const TIMEOUT_MS = Number(process.env.G5_TIMEOUT_MS ?? 45 * 60_000);
const POLL_MS = 20_000;

const ARMS = [
  { label: "A", kind: "baseline", issue: ISSUE_A, lessons: false },
  { label: "B", kind: "with-lessons", issue: ISSUE_B, lessons: true },
];

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function die(msg) {
  console.error(`\n=== G5 FEEDBACK EXPERIMENT — FAIL ===\n${msg}\n`);
  process.exit(1);
}

async function gh(args, opts = {}) {
  try {
    const { stdout } = await exec("gh", args, { env: { ...process.env, GH_MAX_CONCURRENCY: "1" }, ...opts });
    return { out: stdout, code: 0 };
  } catch (e) {
    if (opts.allowFail) return { out: String(e.stdout ?? ""), err: String(e.stderr ?? e.message), code: 1 };
    throw e;
  }
}

/** Resolve arm B's lesson text (default constant, or --lesson-file), validated the same way either way. */
function resolveLesson() {
  if (!LESSON_FILE) return { text: LESSON_TEXT, source: "g5-traps.mjs LESSON_TEXT" };
  let raw;
  try {
    raw = readFileSync(LESSON_FILE, "utf8");
  } catch (e) {
    die(`--lesson-file ${LESSON_FILE} is not readable: ${e.message}`);
  }
  const problems = validateLessonText(raw);
  if (problems.length) die(`--lesson-file ${LESSON_FILE} is not a valid lesson:\n  - ${problems.join("\n  - ")}`);
  return { text: raw, source: LESSON_FILE };
}

/** Both arms get a lessons file — only arm B's has content. Same config shape either way. */
function writeLessonsFile(runDir, label, enabled, lessonText) {
  const p = join(runDir, `g5-lessons-${label}.md`);
  writeFileSync(p, lessonsContent(enabled, lessonText));
  return p;
}

/** Deliver one issue through the real intake path, exactly as G2/G3 do. */
async function deliverIssue({ instance, runDir, repo, issueNumber, label }) {
  const dispatch = async ({ requestId, content }) => {
    const res = await fetch(`${instance.base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.token}` },
      body: JSON.stringify({ requestId, content }),
    });
    if (!res.ok) throw new Error(`factory /tasks returned ${res.status}`);
    return res.json();
  };
  const { server, port } = await startIntakeServer({ logPath: join(runDir, `intake-arm-${label}.jsonl`), dispatch });

  const { out: titleOut } = await gh(["api", `repos/${repo}/issues/${issueNumber}`, "--jq", ".title"]);
  const { out: bodyOut } = await gh(["api", `repos/${repo}/issues/${issueNumber}`, "--jq", ".body // \"\""]);
  const event = {
    action: "opened",
    delivery_id: `g5-${label}-${issueNumber}-${Date.now()}`,
    repository: { full_name: repo },
    // The label is what makes intake treat this as work; identical in both arms.
    issue: { number: Number(issueNumber), title: titleOut.trim(), body: bodyOut, labels: [{ name: "agent" }] },
  };
  const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": event.delivery_id },
    body: JSON.stringify(event),
  });
  const body = await res.json();
  if (!body.accepted) {
    server.close();
    throw new Error(`arm ${label}: intake rejected issue #${issueNumber}: ${JSON.stringify(body)}`);
  }
  return { server, port };
}

/**
 * Run one arm end to end and collect its artifacts.
 *
 * The refusal signal comes from `open_draft_pr`'s tool result, which carries either `{ refused, review }` or
 * `{ prUrl }`. No result within the window is reported as `unknown`, not `false`: a run that never got there is not
 * evidence that the worker chose to work.
 */
async function runArm({ runDir, repo, arm, lessonText }) {
  const cfg = JSON.parse(readFileSync(defaultConfigPath(repo), "utf8"));
  // The ONLY difference between the arms. Everything else is byte-identical on purpose — this is a controlled
  // experiment and any other divergence measures configuration instead of the lesson.
  cfg.lessonsFile = writeLessonsFile(runDir, arm.label, arm.lessons, lessonText);
  const cfgPath = join(runDir, `factory-config-arm-${arm.label}.json`);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  log(`arm ${arm.label}: spawning instance (lessons=${arm.lessons ? "1 entry" : "empty file"})`);
  const instance = await spawnInstance({ repo, configPath: cfgPath });
  const t0 = Date.now();
  let intake = null;
  try {
    intake = await deliverIssue({ instance, runDir, repo, issueNumber: arm.issue, label: arm.label });
    log(`arm ${arm.label}: issue #${arm.issue} delivered`);

    // Scan every conversation for the tool result rather than polling the root one (#169). A result is recorded in the
    // conversation that ran the tool, and an intake-driven run gets a conversation of its own; a root-only poll waits
    // out the whole 45-minute budget on an arm that finished in 90 seconds somewhere else. Newest conversation first,
    // so the current run wins if an older one left a result behind.
    const rootConv = await rootConversationId(instance.base, instance.token);
    let outcome = null;
    let outcomeConv = null;
    let outcomeErrored = false;
    const deadline = Date.now() + TIMEOUT_MS;
    let lastProgress = Date.now();
    while (outcome === null && Date.now() < deadline) {
      const found = await findToolResultAcrossConversations(
        instance.base,
        instance.token,
        "open_draft_pr",
        () => true,
        (m) => log(`arm ${arm.label}: ${m}`),
      );
      if (found) {
        outcome = found.text;
        outcomeConv = found.conversationId;
        outcomeErrored = found.isError === true;
        break;
      }
      if (Date.now() - lastProgress > 60_000) {
        lastProgress = Date.now();
        log(`arm ${arm.label}: still waiting for open_draft_pr (${Math.round((Date.now() - t0) / 1000)}s, root conv ${rootConv})`);
      } else process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const wallSecs = Math.round((Date.now() - t0) / 1000);

    const branch = armBranch(arm.issue);
    const { out: prOut } = await gh(["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--json", "number,url,state,isDraft,headRefOid"]);
    const prs = JSON.parse(prOut || "[]");
    const pr = prs[0] ?? null;

    // Read refusal from the payload shapes production actually emits, falling back to the observable effect (a PR exists
    // on this arm's branch) when no tool result was visible at all. `unknown` now means "we could not tell", never
    // "it succeeded in the usual way" — which is what it meant before #169 and why every run ever made read unknown.
    const refusal = refusalState({ outcomeText: outcome, prNumber: pr?.number ?? null, toolErrored: outcomeErrored });
    const refused = refusal.refused;
    const review = refusal.parsed?.review ?? null;
    if (refused === "unknown") log(`arm ${arm.label}: refusal unknown after ${wallSecs}s — ${refusal.reason}`);
    else log(`arm ${arm.label}: refusal=${refused} (${refusal.reason})${outcomeConv ? ` [conv ${outcomeConv}]` : " [derived from PR listing]"}`);

    if (!pr) throw new Error(`arm ${arm.label}: no PR on ${branch} after ${wallSecs}s (refused=${refused}: ${refusal.reason}) — nothing to measure`);

    // Diff from merge base to this arm's own head, captured now. `main..branch` after the fact silently changes when
    // the other arm merges (#145).
    const clone = join(runDir, `clone-${arm.label}`);
    await exec("git", ["clone", "-q", `https://github.com/${repo}.git`, clone]);
    await exec("git", ["-C", clone, "fetch", "-q", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`, "refs/heads/main:refs/remotes/origin/main"]);
    const { stdout: baseOut } = await exec("git", ["-C", clone, "merge-base", "origin/main", `origin/${branch}`]);
    const mergeBase = baseOut.trim();
    const { stdout: diff } = await exec("git", ["-C", clone, "diff", `${mergeBase}..origin/${branch}`]);
    const { stdout: nameOnly } = await exec("git", ["-C", clone, "diff", "--name-only", `${mergeBase}..origin/${branch}`]);

    const classification = classifyFixPattern(diff, contractFor(arm.issue));
    log(`arm ${arm.label}: PR ${pr.url} in ${wallSecs}s — ${formatClassification(classification)}`);

    return {
      arm: arm.label,
      kind: arm.kind,
      issue: Number(arm.issue),
      branch,
      lessonsFile: cfg.lessonsFile,
      lessonsPresent: arm.lessons,
      wallSecs,
      refused,
      refusalReason: refusal.reason,
      rootConversation: rootConv,
      outcomeConversation: outcomeConv,
      outcomeRaw: (outcome ?? "").slice(0, 400),
      review,
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      headSha: pr.headRefOid,
      mergeBase,
      filesTouched: nameOnly.trim().split("\n").filter(Boolean),
      diffLines: diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length,
      classification,
      classified: formatClassification(classification),
    };
  } finally {
    if (intake) intake.server.close();
    await instance.close();
  }
}

function verdict(results) {
  const [a, b] = results.arms;
  // The decision rule lives in g5-traps.mjs (pure, unit-tested) so it can be argued with instead of re-derived here.
  const { status, attribution, fails } = experimentVerdict(results.arms);
  results.verdict = status;
  results.attribution = attribution;
  writeFileSync(join(process.cwd(), "g5-results.json"), JSON.stringify(results, null, 2));

  console.log(`\n--- RESULTS (${attribution} attribution) ---`);
  for (const arm of results.arms) {
    const refusal = arm.refused === "true" ? " REFUSED" : arm.refused === "unknown" ? " refusal=unknown" : "";
    console.log(`${arm.arm} (${arm.kind}) issue=#${arm.issue} PR=${arm.prNumber}${refusal} ${arm.wallSecs}s`);
    console.log(`  ${arm.classified}`);
    console.log(`  files: ${arm.filesTouched.join(", ") || "(none)"}`);
  }

  if (fails.length) {
    console.error("\n=== EXPERIMENT FAILED ===");
    fails.forEach((f) => console.error(`- ${f}`));
    console.error("g5-results.json written with per-arm artifacts.");
    process.exit(1);
  }
  console.log("\n=== EXPERIMENT PASSED ===");
  console.log("On equivalent traps: the baseline arm patched a handler, the lessons arm fixed the rule. The recorded lesson changed behavior.");
}

async function main() {
  if (!REPO) die("--repo is required (e.g. --repo lalanikarim/factory-fixture). No default: this gate clones and runs against whatever repository it is given, and that must never be a live repo by accident.");
  loadFactoryEnv();

  // Facts first; the pure rule set in g5-traps.mjs decides. Separating them is what makes the isolation rules
  // unit-testable without touching GitHub.
  const lesson = resolveLesson();
  log(`lesson variant: ${lesson.source}`);
  const facts = { lessonsFileExists: lessonsContent(true, lesson.text).trim().length > 0, existingBranches: [], issueStates: {} };
  const haveIssues = ARMS.every((a) => String(a.issue ?? "").trim() !== "");
  const baseCfg = defaultConfigPath(REPO);
  facts.baseConfigReadable = existsSync(baseCfg);
  if (haveIssues) {
    for (const arm of ARMS) {
      const { out } = await gh(["api", `repos/${REPO}/git/refs/heads/${armBranch(arm.issue)}`], { allowFail: true });
      if (/"sha"\s*:/i.test(out)) facts.existingBranches.push(armBranch(arm.issue));
      const { out: iv, code } = await gh(["issue", "view", String(arm.issue), "--repo", REPO, "--json", "state"], { allowFail: true });
      facts.issueStates[String(arm.issue)] = code === 0 ? (JSON.parse(iv).state ?? "UNKNOWN") : "UNREADABLE";
    }
  }
  let problems = preflightArms(ARMS, facts);
  if (ALLOW_STALE) problems = problems.filter((p) => !/already exists/.test(p));
  if (problems.length) die("preflight:\n  - " + problems.join("\n  - "));

  const runDir = mkdtempSync(join(tmpdir(), `g5-${Date.now()}-`));
  const results = {
    startedAt: new Date().toISOString(),
    repo: REPO,
    baseConfig: baseCfg,
    lessonSource: lesson.source,
    lessonText: lessonsContent(true, lesson.text).trim(),
    arms: [],
  };
  log(`preflight ok — arms ${ARMS.map((a) => `#${a.issue}`).join(" + ")}, run dir ${runDir}`);
  try {
    for (const arm of ARMS) {
      log(`=== arm ${arm.label} (${arm.kind}): issue #${arm.issue}, lessons=${arm.lessons ? "on" : "off"} ===`);
      results.arms.push(await runArm({ runDir, repo: REPO, arm, lessonText: lesson.text }));
    }
    verdict(results);
  } finally {
    if (KEEP) console.log(`run dir kept: ${runDir}`);
    else rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((e) => die(e.stack || e.message));
