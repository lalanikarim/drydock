# Work queue — 2026-11-01 (second refresh)

Refreshed against `main` after PRs #98–#111. The previous version of this file predated the whole 2026-11-01 session and still listed #67 and #68 as pending work; both shipped and are closed. Rationale for every row lives in `research/decision-log.md` (decision IDs quoted) — this file is ordering, not argument.

Owner: 🤖 = buildable now · 🧑 = needs you (credential, click, or merge) · 🤖🧑 = I prepare, you execute the last step.

## Open now, ranked

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| 1 ✅ in review | **#100 retry budget + `retryable:false`** — implemented in this stack's bottom layer; design record in plan §5.22, risk R11 closed. Classification (`path_scope` non-retryable, `verification`/`review` retryable, `infrastructure` never charged) plus two ceilings: 2 identical signatures or 4 counted refusals per issue. Enforcement is structural — a stopped run is refused at the top of `open_draft_pr`, before token mint, diff, test command and reviewer | 🤖 | — | An unsatisfiable task costs at most two cycles; the payload says `retryable:false` / `runStopped:true`; 17 checks across unit + real-tool integration |
| 2 ✅ in review | **#96 reply on the PR after a `/factory` rework** — stack layer 2; design in §5.23. One comment per rework with the verdict first: pushed (previous → new sha), **no change to push**, or refused with a Why section. Classification comes from shas read host-side, not from the model's account; a budget stop renders as its own row. Boundaries: only runs that reached an existing PR report (pre-dispatch refusals post nothing), and reporting failures can never change a run's outcome | 🤖 | — | Every `/factory` comment that reaches the gate gets exactly one reply: what changed, or why nothing did — 11 checks |
| 3 ✅ landed (one sub-item open) | **#110 leftovers from #107** — sweep writes `--state-file` breadcrumbs on every successful listing including the clean case; `supervisor status` prints age/findings and says **NEVER RECORDED** when there is none; scheduling decided (**launchd, not cron** — a laptop sleeps and cron never catches up) and **installed on this machine**: `com.drydock.redeliver`, 900s + at load, `--since 24h --skip-file …/acknowledged-deliveries.txt`, report-only, exit 0/1/2. Shutdown logs open handle types one second after teardown instead of silently timing out. **Still open: the lingering child handle's root cause** (bounded by #108, now observable) | 🤖🧑 | #109 | A failed delivery is noticed within one cadence interval without anyone remembering the tool exists |
| 4 ✅ in review | **#95 sanitize issue bodies** — stack layer 3; design in §5.24, new risk **R13** recorded as accepted residual. `factory/untrusted.ts` owns the delimiter pattern, the neutralization marker, the warning sentence and the renderer; both `fetchIssue()` paths sanitize on fetch *and* the renderer sanitizes again. A body containing `</untrusted> … <untrusted>` now yields exactly two envelope boundaries instead of four | 🤖 | — | Prompt-level checks assert exactly two boundary markers whatever the body claimed (non-vacuity pinned: the naive wrap yields four) |
| 5 | **fixture-1 #45** (`?sort=amountCents`) through G2/G4 (D3) — last live target in either fixture; produces a draft PR for you to merge, `probe:list-sort-amount` retained as a regression oracle | 🤖🧑 | aurora reachable | Merged, `agent` label removed |
| 6 | **8b — decide the fixtures' protection posture.** Both fixture repos have **no branch protection at all** and `autoMerge: true`. They are private, so Actions minutes are free at this volume | 🧑 | — | Either required checks on both, or an explicit "disposable, by design" line in the decision log |
| 7 | **P2 — listener exposure posture.** The funnel stays published between bursts today (operator instruction). If that becomes "per burst", the runbook needs the teardown/restore steps and a statement of what is exposed while down | 🧑 | — | Stated posture, reflected in `fleet/enable-self-work.md` |
| 8 | **P4 / R9 — path scope cannot express intent.** Scope answers "may this file change?", never "should this issue have changed it?". Live case: a self-task's worker bundled an unrelated `factory/verification.ts` edit into a PR and only review caught it. Candidate designs: require an issue to name the files it expects to touch, or per-task allowlists derived from the issue at dispatch. **Needs your decision before implementation** | 🧑🤖 | evidence exists (#83, R9) | Decision recorded, then implemented or explicitly deferred |
| 9 ✅ in review | **#65 refinement pass.** A `refine` label or `/refine <guidance>` comment runs a read-only expansion of an issue and posts the brief as a comment: goal, testable acceptance criteria, an explicitly non-empty OUT OF SCOPE, per-criterion verification, and FOLLOW-UPS for adjacent work. One tool (`read`) against a remote-scrubbed clone; the host posts after fail-closed parsing; a brief grants nothing — acting still needs `build` plus every gate. Also closed a #95 gap: `renderIntakeContent` was embedding issue text unsanitized. Design §5.25 | 🤖🧑 | #100 (classification is shared plumbing) | A `refine` label runs research and posts a refined issue; one live example |
| 10 | **#64 Telegram notify on PR creation** — needs channel/credential decision first | 🧑🤖 | credential | A draft PR creation produces exactly one notification |
| 11 | **§3.9 T1 partial-run recovery (C4)** — preserve the branch, mark resumable, requeue once with the diff as context | 🤖 | #100 | A budget-aborted run leaves recoverable work and exactly one automatic resume attempt, tested |
| 12 | **E4 per-task token annotation (§5.17).** Partial: offline accounting ships (`factory/usage.ts`, `gates/m5-token-report.mjs`, Phase 6 table). What is missing is spend attached to the *task outcome* at run end, warn-only against a soft threshold, no abort | 🤖 | — | Every run reports its tokens without anyone reading the store by hand |
| 13 | **C5 release checklist** — encode "full battery before pin bump or posture change" + the restart step; one page referenced from the runbook | 🤖 | — | Checklist exists and was followed for the last change it covers |
| 14 | **#42 Target 2 design doc (D2)** — client-only federation, no collective dependency, plus the decision rule for when to fund it. Documentation only; implementation stays unfunded | 🤖 | — | Doc exists; #42 scheduled or closed with a reason |
| 15 | **#41 upstream kernel PR** (two destructive-guard narrowings: interpreter heads, `/dev` redirection drop). **Hold**: once engram becomes a managed repo this stops being an upstream PR and becomes internal work (D4) | 🤖 | engram onboarding | Upstream PR open with our characterization test as evidence, or converted to internal change |
| 16 | **#78 ⏸ App reach residual** — three reachable-but-unmanaged repos stay installed because engram is intended to join as a managed repo. Condition carried forward: **protect engram's `main` before the first dispatch there** (it has no protection today) | 🧑 | engram onboarding | Probe prints "reach matches policy exactly", or engram is in the registry *and* protected |

## Landed since the previous refresh (2026-11-01)

Not re-doable work; listed so nobody reads the old Phase 1–3 tables and starts it again.

| Shipped | What it proved |
|---|---|
| #94 / **#67 closed** | `/factory <directive>` rework loop, live-verified twice (`rebase` no-op, `instruct` → commit `e8d043b`) plus four negative paths |
| #102 (R10) | Glob test discovery — an enumerated `npm test` had silently dropped a suite from every CI run; guard asserts disk-vs-collected equality |
| #103 | Worker is told its path scope before it starts, including "declining for scope reasons is a correct outcome" |
| #98 | Commit identity survives installation tokens (`/user` 403) via app metadata fallback |
| #106 | **First self-task content on `main`** — issue #105 → draft PR → `/factory instruct` commit → merged at `3439d03` |
| #108 / #109 (**#107 closed**) | Supervisor single-instance lock; failed-delivery sweep + runbook §7. GitHub does **not** redeliver failed deliveries — 34 lost events found and counted |
| #111 (R12) | `AGENTS.md` rule: a fake proves your assumption, not the API — four defects committed green in one week |

## Production posture snapshot (2026-11-01)

| Control | Status |
|---|---|
| Merges are human-only | ✅ capability removal (`merge_pr` absent), not convention |
| Approvals name a commit | ✅ #47 byte-scoped; parents verified after merge |
| Change scope limited | ✅ allowlist + unconditional `vendor/`; `gates/` out of scope, `gates/probes/` protected; worker told its scope up front (#103) |
| Intake hardening | ✅ HMAC + sender allowlist + 1 MiB cap + liveness-only `/health`; issue-body delimiter sanitization **open** (#95) |
| Independent review before push | ✅ reviewer pre-push; fail = no push |
| Verification evidence on PRs | ✅ #76 — host-side command run, exit code recorded, push refused on non-zero/timeout/zero-tests |
| CI as a gate | ✅ `unit-suite` required and **strict** on `main`, enforce_admins on (admins included) |
| Required approving reviews | ✅ 1 approval with admin bypass (E3 resolved); CI stays required for everyone |
| Credential scoping | ✅ GitHub App installation tokens, `repository_selection: selected` (6 repos); residual in #78 |
| Authorship distinguishes factory work | ✅ PRs authored `app/drydock-factory`, commits as `drydock-factory[bot]` |
| Exactly one control plane | ✅ supervisor single-instance lock (#108) |
| Delivery loss recovery | ✅ scheduled (launchd `com.drydock.redeliver`, 900s, report-only, 24h window + acknowledge list) — was: tool existed but nothing ran it |
| Retry discipline | ❌ none — #100, the worst remaining gap (R11) |
| Host / transport | Laptop behind a loopback listener with a public front (A1/A2) — sleep/IP/credential consequences accepted; exposure posture decision P2 open |

## Explicitly not queued

Scheduled full-battery runs (C5: per release, and the host is a laptop) · `autoMerge` anywhere (E2) · Target 2 *implementation* (D2) · GitHub Actions beyond the hermetic unit suite (C2-rev) · deleting the POC-era local branch (F1 did not select it).
