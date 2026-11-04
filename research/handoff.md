# Handoff — 2026-11-04 (late)

Pick this up cold. Everything below was verified on the date above by running it; anything here that contradicts the repo is a bug in this document.

## Ground truth

| | |
|---|---|
| drydock `main` | **`723161b`** — suite 615 tests / 614 pass / 0 fail (one pre-existing skip), typecheck clean, boot tests executed against live inference (no skips) |
| fleet | running **`723161b`**, `/health` ok, inference reachable, drydock + engram + adapter parented to the supervisor, 0 quarantine. Supervisor PID = first line of `fleet/data/routes.json.lock`. Log: `/tmp/fleet-723161b.log` |
| fixture repo `main` | `1378884`, suite green (132/132). **Specimens spent:** PRs #95/#96 (`agent/issue-93`/`agent/issue-94`) were consumed by the #168 measurement — they are no longer controls, they are artifacts |
| open drydock issues | **#212** gates-enforcement · **#213** off-host backups · **#214** `feedback.prNumber` fault-vs-refusal · **#147** passive · **#172** upstream-only · **#42** 🧑 design |
| open PRs | drydock: none. **engram: #74 — draft, CI green, awaiting your review.** Fixture #59 predates all of this, unexamined |
| scheduled jobs | `com.drydock.redeliver` (15 min) and **`com.drydock.backup` (daily, new)** — both have committed sources under `fleet/launchd/` |

## What landed, and why each thing exists

- **`723161b` / #211 — a shipped defect that stopped every review.** `dfd13f4` (#209) spliced an import statement *into a jq string literal* in `factory/reviewer.ts`; `gh --jq` could not parse it, so `fetchIssue` threw and **every review died at SPAWN** on the deployed build (`23a3e19`). 611 tests and strict CI were green because nothing called `fetchIssue`, and it was latent only because no review had run since the 17:44 UTC deploy. The jq program is now exported and asserted against the **real `jq` binary** (`test/reviewer-issue-text.test.mjs`): title+body, null body, and a structural guard against that exact splice. This is AGENTS.md's rule with a new instance — a contract interpreted by a *remote* tool is invisible to a type checker.
- **`gates/g5-reviewer-lever.mjs`** — the four-arm gate that found it by executing for real, and that answers #168. Composition mirrors `g3-reviewer.mjs` T1 (minimal core instance + production `factoryReviewerTask`), injects `lessonsFile`, and **proves delivery from the durable store** (locate the reviewer conversation by its prompt marker, then check for the trusted lessons header) instead of logging intent.
- **#168 measured and closed.** Two matched pairs: `agent/issue-94` (boundary guard) and `agent/issue-93` (inline handler patch), each reviewed with and without one lesson. Verdicts identical regardless of lessons — pass/pass and fail/fail. Where the diff was genuinely broken, `reviewerPrompt` step 4's pre-existing symptom-vs-root-cause instruction did the work unaided; where the lesson's rule would have mattered, **the fixture cannot instantiate it** (`toCsv`, `agingBuckets`: one caller each — the route). Closed on its own pre-registered wording: *enforce in gates, not prompts* → **#212**.
- **Backups are scheduled and restore-proven.** `com.drydock.backup` runs `gates/backup-drill.mjs --keep 7` daily; proven under launchd (`BACKUP DRILL PASSED`, four stores: sqlite-API snapshot → integrity_check → restore to scratch → row/document-kind count compare → rolled-back write test). The plist is committed as `fleet/launchd/com.drydock.backup.plist.example`, following the `com.drydock.redeliver` convention that exists because an installed-only unit silently skipped a newly onboarded repo.
- **engram did real work for the first time.** `engram#65` labeled `build` at 19:33 UTC → adapter accepted (`requestId=issue-65`) → setup `npm ci` in the one-shot networked container → worker → review → **engram PR #74** (draft, `+159/-5`, `app/src/core.ts` + `app/test/root-agent-reapply.test.ts` wired into `test:unit`, `unit-suite` pass). First production `pr_opened` Telegram delivery (`message_id=183`) — the observation #64 was explicitly waiting on.

## Next action, in order

1. **Review and merge engram #74** (🧑). It is a correct fix for a real kernel defect: `harness.root()` applies `agent` options only at creation, so every later boot silently discarded them; the PR re-asserts via `root.configure(rootAgent, ctx)` with a three-boot test on one data directory. Merging makes engram's `main` carry factory work for the first time.
2. **#214** — smallest well-specified code task left. `delegate` takes `feedback.prNumber` from the model's own arguments; `0` currently throws in the worker's spawn phase (`factory/worker.ts:334`). The guard is right, its failure mode is wrong: refuse at the tool boundary with an actionable result, keep the spawn guard for direct `/tasks` input.
3. **#212** — turn "the guard belongs where the rule lives" into a diff-position check in `gates/fix-pattern.mjs`. Its acceptance criterion needs a **two-caller specimen**, which does not exist yet; authoring one means adding a second route calling `toCsv` directly so a boundary-only fix leaves a curl-provable 500.
4. **#161 emit half** — most self-contained remaining item (temp instance with an unserved `modelId`, local Bot API stand-in à la `gates/alert-drill.mjs`, assert one message per edge).
5. **C4 partial-run recovery** — largest implementation; see the specimen warning under "Things that will bite you".

## Things that will bite you

- **Never pass `--out /tmp/…` to a gate that runs a sandboxed review.** `/tmp` is not mounted into the podman VM, so every reviewer tool fails with `podman run failed (125): Error: statfs …/work/review-agent-issue-94: no such file or directory` — and the model dutifully reports "environment is broken" instead of the diff being judged. Node's default `os.tmpdir()` (`/var/folders/…`) works; that is what `g3-reviewer.mjs` uses. Symptom to recognize: verdict null in ~40 s with `delivery={prompt:true}`.
- **Approvals are per-file, and engram runs are therefore attended.** Each destructive write produces a distinct key (`sha1(tool + exact args)`), so N new files = N gates = N Telegram alerts. Approve with `POST /approvals/<key> -d '{"decision":"approved"}'` (bearer token from `fleet/data/routes.json`). Production evidence is on **engram#69**; the fix path is a repo-scoped rule pre-approving `write` into registry-allowlisted paths, not disabling the tier.
- **A "rework" with no PR faults the worker.** After an approval-blocked run (no PR exists), the orchestrator called `delegate` with `feedback.prNumber = 0`. The guard refused — correctly — but as a SPAWN fault, so it consumed failure budget for a non-defect. #214.
- **`gates/registry-targets.mjs` is a library**, not a runnable gate: no entry point, prints nothing, exits 0. It was listed in the release checklist's step 2 until this session; that line is fixed. If you add a "verification" command, make it print what it collected — R6b/R10.
- **`timeout` does not exist on macOS** (`gtimeout` from coreutils if needed); `cmd | grep … ; echo exit=$?` reports grep's status, not the command's. Both of these produced a false "no output, presumably fine" this session.
- Everything in the previous handoff still holds: never `pkill -f "server.mjs <port>"` from a shell whose own command line matches; merge-async is the only way stacked PRs land (and `gh pr merge` refuses even with `--admin`); draft PRs need `gh pr ready`; a green suite is not evidence about the remote; fleet restart = single SIGTERM, verify orphans/lock/`:9700`/`build.sha`.

## Reading order for a fresh session

`research/work-queue.md` (twelfth refresh = live ordering) → this file → `fleet/release-checklist.md` (release procedure, corrected step 2) → `research/production-readiness-2026-11-01.md` §1 (verdict refreshed; old one collapsed in a `<details>`) → `research/decision-log.md` newest entries → `fleet/factory-lessons.md` (lesson authoring rule — and note it describes *context*, not enforcement, per #212).
