# Handoff — 2026-11-04 (evening)

Pick this up cold. Everything below was verified on the date above; anything you read here that contradicts the repo is a bug in this document.

## Ground truth

| | |
|---|---|
| drydock `main` | `23a3e19` — suite 611 tests / 610 pass / 0 fail, typecheck clean |
| fleet | running **`23a3e19`**, `/health` ok, inference reachable, 3 children parented, no quarantine. Supervisor PID = first line of `fleet/data/routes.json.lock` |
| fixture repo `main` | `1378884` (after #88), suite green |
| open drydock issues | **#168** (see spec below), **#147** passive, **#172** upstream-only, **#42** 🧑 design |
| open PRs | none in drydock. Fixture: **#95/#96 — do not merge or they vanish as specimens**; #59 predates everything here and is unexamined |

## What landed today (and why each thing exists)

- **`bdf0a4c` / #206 — #204.** The settlement window had been frozen since Nov 2: it refused to advance its watermark while anything alarmed, with no way to record "examined". Two mechanisms: retroactive approval-block attribution (asymmetric — reclassify only when exactly one alarming row shares a conversation) and `--ack <store/table:id> --ack-reason "…"`. Production drained immediately; `engram/task` acquired a family mark it never had. **My issue body predicted 268/475 would auto-reclassify; they don't** — all four failing rows share conversation 32 and its marker belongs to `open_draft_pr`. The ambiguity rule declined, which is the outcome that kept the report honest.
- **`c8830aa` / #208 — location-aware `rootFix`.** G5 printed `EXPERIMENT PASSED` on a diff where arm B defined its typed error in `src/server.mjs` beside the route while the domain function still threw engine errors for other callers. `rootFix` now requires a domain path; `boundaryTypedError` is reported as neither signal. Three tests, one of which proves the same class **does** count when moved — otherwise the rule could be satisfied by ignoring typed errors entirely.
- **`23a3e19` / #209 — standing lessons reach the reviewer.** The worker has read durable lessons since Phase 5; nothing downstream ever did, so contradicting a lesson was free. Reviewer now renders them (trusted section, after the untrusted envelope, fresh per review) with asymmetric rules: same defect reachable from another caller → `fail` citing the lesson verbatim; criteria met but better shape exists → concern on a pass, **never** a fail. Plus "never cite a lesson not present verbatim above" and a 4 KB cap.
- **Trap pair verified for real**: fixture#92 (`80f1073` era) — `?bucketDays=abc` → 500 `Invalid array length`; `?columns=id,customerId` → 500 `columns.join is not a function`, both reproduced with curl on a running server, suite green with the traps present. Issues #93/#94 carry symptoms only.
- **fixture#88 merged** (`1378884`) after rebase: reuses the shared unknown-field rule via `BATCH_FIELDS`; behavior verified live (`400 {"error":"unsupported field: bogus"}`). Closes fixture#87. **fixture#89 closed unmerged** — it is arm B's anti-pattern diff, kept as a drydock fixture; merging it would land the thing the experiment detects.

## Next action, in order

### 1. Measure the reviewer lever (closes or kills #168)

Spec with its controls: [#168 comment](https://github.com/lalanikarim/drydock/issues/168#issuecomment-6637803181). Summary: review `agent/issue-96` (boundary-only fix, passes its own tests) with one lesson in `lessonsFile`, modeled on `gates/g3-reviewer.mjs` T1's minimal-instance composition. **Both controls are mandatory** — same review with an empty lessons file, and the same review against `agent/issue-93`. A fail that doesn't quote the lesson demonstrates nothing; if it fails identically with and without lessons, hypothesis 2 is dead and #168 closes on "enforce in gates, not prompts".

**Fleet caveat:** both repos' lessons files are empty today, so live reviews currently carry no lessons (byte-stable by design). `note_lesson` changes live review behavior immediately — don't experiment on the fleet.

### 2. Then either a twin trap pair or close #168 on the review result

G5's pass condition is narrow: A must patch a handler *and* B must root-fix, and this 27B model often finds structural fixes unaided (which invalidates traps instead of measuring lessons). The last pair also differed in kind (#93 value passed through vs #94 list needing parsing), which confounds style with location. A twin pair = same defect shape twice, different parameter names.

### 3. C4 partial-run recovery

Design anchored in `research/work-queue.md` rank 5: bounded content enrichment at dispatch + once-only marker + byte cap, new `factory/resume-context.ts`. Largest remaining implementation; needs a session of its own, not a tail end.

### 4. #161 emit half

The ledger now names the cause (`modelUnavailable`, still alarming). Remaining: an instance raising the inference edge when a run settles that way, proven with a temp instance configured with an unserved `modelId` + a local Bot API stand-in (pattern: `gates/alert-drill.mjs`), asserting one message per edge rather than per submission. A naive gate-side alert was rejected in writing — it re-alerts forever (no watermark advance, in-memory dedupe, cron process exits).

## Things that will bite you

- **Never `pkill -f "server.mjs <port>"` from a shell whose own command line contains that string** — it kills your shell mid-script and looks like a hang. Capture `$!` or use `lsof -ti tcp:<port>`.
- **Merge-async is the only way stacked PRs land.** `gh pr merge` refuses even with `--admin`. `PUT /pulls/<n>/merge-async --input <file>` with `bypass_rules:true` and the head sha, one layer at a time, bottom-up; poll `state`, never the exit code. If a PR is `BEHIND`, update the branch first — the async request silently no-ops. A pending required check also blocks it: confirm `completed/success` before re-enqueuing (CI sat in GitHub's runner queue ~15 min today; that was capacity, not failure).
- **Draft PRs don't merge.** `gh pr ready <n>` first (cost me a cycle on fixture#88).
- **A green suite is not evidence about the remote.** Every defect this repo fixed in the last two weeks came from an assumption about an API or a diff. Run the real thing once and paste the output.
- `gh pr edit`/`gh issue close` reject `--json` in this CLI version; `gh pr close --comment-file` silently does nothing (use `gh api -X PATCH .../pulls/<n> -f state=closed`).
- Fleet restart recipe: **single SIGTERM**, never `-9`; verify zero orphans, `:9700` free, lock released, then relaunch and check `/health` reports the expected sha. A stale `build.sha` looked healthy once already.

## Reading order for a fresh session

`research/work-queue.md` (ranked, with acceptance criteria) → `research/decision-log.md` newest entries (mechanism corrections live here, not in changelogs) → `fleet/release-checklist.md` (release procedure; note the ack paragraph replaces the expired known-bad one) → `fleet/factory-lessons.md` (lesson authoring rule + evidence table) → this file.
