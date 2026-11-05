# Handoff — 2026-11-05

Pick this up cold. Everything below was verified on the date above by running it; anything here that contradicts the repo is a bug in this document. Ordering lives in `research/work-queue.md` (fourteenth refresh = live); this file is state, traps, and reading order.

## Ground truth

| | |
|---|---|
| drydock `main` | **`d647c3c`** — suite **643 tests / 0 fail** (one pre-existing skip), typecheck clean, boot tests run against live inference |
| fleet | running **`6ce582e`**; the delta to `main` is docs + `.gitignore`, so **no restart owed**. `/health` ok, inference reachable, drydock + engram + adapter parented to the supervisor, 0 quarantine. Supervisor PID = first line of `fleet/data/routes.json.lock`. Log: `/tmp/fleet-6ce582e.log` |
| gate posture | printed at every boot and verified by `gates/gate-posture.mjs` (exit 0): destructive floor judges **effect-bearing args only** for known tools — `write(path)`, `edit/multi_edit(edits[].path,path)`, `delegate/refine_issue/open_draft_pr(issueNumber)`, empty-list tools judged on all args; **unknown tools stay strict**; `merge_pr` keeps prompt tier *and* full floor deliberately |
| engram | vendored at tag **`v0.2.4`** (`2072958`). Its `main` is `43b1350` — two docs commits past the tag, which per the version-truth rule (documented in its README) needs no release. Releases shipped this week: **v0.2.2** (rootAgent options re-asserted every boot), **v0.2.3** (#69 prose-vs-execution gate fix), **v0.2.4** (`docs/gates.md` + inert example payloads) |
| open issues | drydock: **#230** replan provenance · **#220** deploy-posture verifier (needs re-slicing) · **#217** fleet supervision (deferred by you) · **#213** off-host backups (**parked, risk accepted**) · **#212** gates enforcement (blocked on fixture specimen) · #147 passive · #172 upstream-only · #42 design. engram: **#78** nine unrun test files · #72 · #66 · #61/#60/#59 · #58 |
| open PRs | none besides this documentation refresh. Everything lands as a draft for you unless you say "merge" for that round |
| scheduled jobs | `com.drydock.redeliver` (15 min) and `com.drydock.backup` (daily) — both committed under `fleet/launchd/`. **Backups land on the same disk** (#213, accepted). **The supervisor itself has no launchd unit** (#217): a reboot leaves the factory down silently |
| fixture repo | `main` unchanged. **Specimens spent:** #95/#96 (`agent/issue-93`/`agent/issue-94`) were consumed by the #168 measurement — artifacts, not controls |

## What landed since the last handoff, and why each thing exists

- **#211 `723161b` — the shipped defect that stopped every review.** `dfd13f4` spliced an import statement *into a jq string literal* in `factory/reviewer.ts`; `gh --jq` couldn't parse it, so `fetchIssue` threw and **every review died at spawn**. 611 tests were green because nothing called `fetchIssue`. The jq program is now exported and asserted against the **real `jq` binary** (`test/reviewer-issue-text.test.mjs`) — a contract interpreted by a remote tool is invisible to a type checker.
- **#168 measured and closed:** four arms, two matched pairs, verdicts identical with and without a lesson. Where the diff was broken, the rubric's existing symptom-vs-root-cause step did the work; where the lesson's rule mattered, **the fixture can't instantiate it** (`toCsv`, `agingBuckets` have one caller each). Disposition: enforce in gates → #212.
- **engram v0.2.3 / #69 — the destructive floor was judging prose.** 18 recorded trips across 4 stores, 7 distinct calls, **zero destructive effects**: every one was a task description *containing* `rm -rf /`. Now only effect-bearing args are judged for known tools, derived from policy rather than hardcoded (`PATH_DESTRUCTIVE_PATTERNS`), unknown tools strict. Deployed config replayed against the recorded calls: **7/7 destructive → 0/7**, and 8/8 genuinely dangerous cases still trip.
- **#218 — `delegate` refuses an impossible `feedback.prNumber` at the tool boundary** as an actionable tool result instead of faulting at spawn (which consumed failure budget for a non-defect).
- **#222 / #225 — one worker per issue, and no silent retry after a wall-budget abort.** Durable claim (TTL = wall budget + 120 s, released in `finally`) plus: after one abort with no PR, `delegate` requires a non-empty `replan`.
- **#226 / #229 — `POST /factory/intake/reopen {"issueNumber":N,"reason":"…"}`.** An issue's intake `requestId` is constant and durable, so re-applying `build` after an abort silently did nothing — one dispatch per issue per store, ever. The verb appends `issue-<n>#reopen-k`, opens a **fresh** conversation (a transcript containing an abort treats it as evidence, #122), and writes nothing to the budget ledger — asserted by instrumenting the fake's `commit`, not by comparing values afterward.
- **#230 — found while verifying #229, still open.** Within 90 seconds of deploy, my own reopen reason ("slice reduced to assertion 4 only") came back as the model's *false* claim of completed scope reduction, and #222's guard accepted it because the rule is "non-empty string". Fix direction: host-issued grants consumed on use, `replanSource` provenance in ledger + log, and the one mechanical check available (did the issue body change since the abort).
- **Throughput batch run and cancelled at n=2** (`research/factory-throughput-baseline.md` §6–§7): definitions pre-registered in §5 before dispatching; engram#76→#77 was the first multi-file unattended run under the narrowed floor (3 files, CI green, **zero approvals-taps**); drydock#220 failed on budget and exposed #222. Cancelled because dispatches 3–4 would have needed tasks invented to fit the wall — measuring tasks invented to be measurable measures the invention.
- **#213 parked as an accepted risk**, in writing, with a revisit trigger (any restore drill against off-host media). Single-disk fleet: one disk or one house loses stores *and* code.
- **`fleet/runbook-aborts.md`** — the abort ladder (`taskId` settles a task; **`conversationId` stops the orchestration loop**), what an operator abort costs (nothing, deliberately, #141), attribution requiring `issueNumber`, and how to read current ledger state from a delta chain.

## Next action, in order

1. **eng#78** — wire-or-declare nine engram test files that no CI job runs (`hardening`, `sandbox`, `core-instance`, …) and add the check that fails when an unrun test file appears. Highest known risk: a containment regression lands green today.
2. **#230** — replan provenance. Small, fully specified in the issue, evidence already banked.
3. **#220 sliced to assertion 4 only** (policy vs on-disk `gates.json` drift + its test). Dispatch it by editing #220's body down and reopening (produces real `reopen-2` evidence) or as a fresh issue. **The spec must permit registering its own test** — see traps.
4. **#217** when you want it: supervisor launchd unit with `KeepAlive`. ~30 min.
5. #212 remains blocked on authoring a two-caller fixture specimen.

## Things that will bite you

- **Never forbid a worker from touching test wiring.** eng#76's spec said "don't touch `package.json` scripts"; the worker produced a green test file that **no CI job collected**. If a task may add a test, its spec must permit registering it — otherwise the artifact is decoration.
- **A reopen reason is injected as authoritative operator context.** Write it as a fact you have already made true in the issue body, or as explicit operator intent. "Slice reduced to X" came back as the model's assertion that X had happened (#230).
- **Aborts: `taskId` settles a task, `conversationId` stops the loop.** A task abort mid-loop was followed by a fresh worker 0.8 min later; it took two conversation aborts and ~2× budget to stop. Include `issueNumber` in the abort body or the intervention is recorded nowhere (the code refuses to guess).
- **Current document state lives in `document_revisions` deltas.** Reading the last *base* snapshot shows a stale value — I misread one and wrongly concluded attribution was broken. Use a read-only connection (`file:…?mode=ro`).
- **Gates that collect nothing look like passing gates.** `registry-targets.mjs` and `behavior-probes.mjs` are libraries; `shutdown-handles.mjs` exits 0 without `--fleet`. "Not collected" and "passing" are the same color — verify what a check gathered.
- **Example payloads must be inert.** `rm -rf ./node_modules`, never `rm -rf /`: a quoted example is a literal execution candidate under an arg-name-blind floor. The detector's own pattern list keeps the real string (it must match reality).
- **Approvals are per-file** (`sha1(tool + exact args)`), so N new files used to mean N Telegram alerts. Prose no longer trips the floor, so multi-file runs are quiet now — eng#76/77 needed zero taps. `merge_pr` still prompts; that is intentional.
- **`/tmp` is not mounted into podman sandboxes** (use Node's `os.tmpdir()`); **`timeout` doesn't exist on macOS** (`gtimeout`); `cmd | grep …; echo $?` reports grep's status.
- Still true from prior handoffs: never `pkill -f "server.mjs <port>"` from a shell whose own command line matches; stacked PRs land via the async merge REST API (`gh pr merge --admin` refuses stacks); drafts need `gh pr ready`; **a green suite is not evidence about the remote**; fleet restart = single SIGTERM, then verify orphans / lock released / `:9700` / `build.sha` / 3 children parented / 0 quarantine.

## Reading order for a fresh session

`research/work-queue.md` (fourteenth refresh = live ordering) → this file → `fleet/runbook-aborts.md` (abort ladder, reopen verb, ledger gotchas) → `fleet/release-checklist.md` (procedure; three of its "gates" are libraries, noted inline) → `research/factory-throughput-baseline.md` §5–§7 (pre-registered definitions, n=2 results, why it stopped) → `research/production-readiness-2026-11-01.md` §1 (verdict; old one collapsed in a `<details>`) → `research/decision-log.md` newest entries → `vendor/engram/docs/gates.md` (what the gate layers actually do, with the #69 rationale) → `fleet/factory-lessons.md` (lesson authoring rule — describes *context*, not enforcement, per #212).
