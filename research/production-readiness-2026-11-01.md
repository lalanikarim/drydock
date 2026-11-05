# Production readiness assessment + session handoff — 2026-11-01

> **Updated 2026-11-05 — §1 re-verdicted: the blockers changed shape, and one of last week's two reasons is measured fixed.** Verified state: drydock `main` = **`d647c3c`**, suite **643 tests / 0 fail** (one pre-existing skip), typecheck clean; fleet on **`6ce582e`** (delta to main is docs-only — no restart owed), `/health` ok, inference reachable, 0 quarantine, gate-posture and approval-block probes exit 0. engram vendored at **v0.2.4** (`2072958`); its `main` is two *docs* commits past the tag, which under the version-truth rule now written into its README is correct rather than drift. Shipped since the previous update: engram **v0.2.2 / v0.2.3 / v0.2.4**, drydock **#218** (tool-boundary refusal), **#222/#225** (one worker per issue; no silent retry after a wall-budget abort), **#226/#229** (`POST /factory/intake/reopen`), `fleet/runbook-aborts.md`, and the **throughput batch run then cancelled at n=2** (`research/factory-throughput-baseline.md` §6–§7).
>
> Two claims in this document were falsified by that work, both in the favorable direction: **per-file approvals no longer make ordinary runs attended** (engram v0.2.3 narrowed the floor to effect-bearing args; `engram#76 → PR #77` touched 3 files with **zero approval taps**), and engram is no longer "a repo where nothing has been dispatched". One new gap was found and is open as **#230**: `delegate` cannot distinguish an operator's authorization from the model's assertion about one — my own reopen reason came back as a false claim of scope reduction and #222's guard accepted it, in production, within 90 seconds of deploy. Also discovered while verifying: **eng#78**, nine engram test files (incl. `hardening`, `sandbox`, `core-instance`) executed by no CI job — which weakens "CI green" exactly where the trust story leans on it.
>
> **Updated 2026-11-04 (late) — §1 verdict rewritten; the old one cited P0s that had all shipped.** Verified state: drydock `main` = **`723161b`**, suite **615 tests / 614 pass / 0 fail** (one pre-existing skip), typecheck clean, boot tests genuinely executed (live model answered; no skips). Fleet restarted onto `723161b`: `/health` → `{status: ok, build.sha: 723161b, inference: reachable}`, lock held by the supervisor pid, 0 quarantine lines, approval probe 5/5 explained, settlement window clean (exit 0).
>
> Four things changed the picture materially. **(1) A shipped defect was killing every review.** #209 (`dfd13f4`, deployed as `23a3e19`) spliced an import statement into a jq string literal in `factory/reviewer.ts`; `gh --jq` could not parse it, so **every review died at SPAWN** — 611 tests and strict CI green, latent only because no review had run since the deploy. Found by running the real thing (#211). **(2) The second repo did real work for the first time.** `engram#65` was labeled `build` at 19:33 UTC; at ~20:00 **engram PR #74** existed — draft, `+159/-5`, `app/src/core.ts` + a new 150-line test wired into `test:unit`, `unit-suite` pass. It needed **two destructive-write approvals** (one per new file) and delivered the first production `pr_opened` notification (`message_id=183`), which is the observation #64 was waiting on. **(3) #168 closed on its own pre-registered criterion**: reviewer-side lessons produced no discrimination across two matched pairs → enforce in gates (#212). The queued twin trap pair is **retired**. **(4) Backups are now scheduled and restore-proven** (`com.drydock.backup`, daily, `--keep 7`, proven via `launchctl kickstart`), with the off-host gap filed as #213.
>
> **Updated 2026-11-05 (afternoon).** Since the morning refresh: **eng#78 closed** (engram#82 — collection check in CI), **#230 shipped** (`replanSource` + one-use operator grants, deployed `43aed60`), **#222 closed on live evidence** (its refusal branch produced deterministically, no worker spawned), **#220 closed** (deploy verification is a command: `fleet/verify-deploy-posture.mjs`, seven rows with observed values, plus `gates/deploy-posture.mjs` for policy-vs-disk drift). Filed: **#235** (intake reuses an aborted conversation where reopen forces a fresh one — the two doors disagree about #122) and **#238** (the retry guard still cannot tell that a claimed scope change is false). Suite **685 pass / 0 fail**. The day's own defect, told in full in #236: I "verified" a deploy by running `gates/gate-posture.mjs` — a file that has never existed — through a pipe, and it exited 0.
>
> Two defects came out of the dispatch and are open: **#214** (model-supplied `feedback.prNumber = 0` faults a worker at SPAWN instead of refusing at the tool boundary) and **engram#69** (both since closed: #218 and v0.2.3 respectively — the latter is what changed the Bar B reasoning below).
>
> **Updated 2026-11-03.** Since the 2026-11-02 update: **#141 shipped and live** (durable per-issue wall-budget cap + `POST /factory/runs/abort`, #153, proven against a real running task), **#120 shipped** (runbook §7c containment, commands executed against production, #158), **#143 closed** (supervisor survives a bad config read in its own recovery path, #150), **#133 closed for items 1–2** with two alert-swallowing defects found and fixed on the way (#160: a catch-all dedupe key plus a time window that deleted the all-clear), and **#64 closed** — production made its first auditable Telegram send (`message_id=121`). Battery final tally recorded as **8 of 9**. New issue **#161**: settlements that produced no work are counted nowhere. Suite **448 pass / 0 fail**; fleet on `e4d89e1`.
>
> **Updated 2026-11-02.** Shipped since compilation: **P0-3 closed** (process-group ownership, bounded shutdown,
> child-side orphan watchdog — #130), **runtime config moved outside the source tree** to `$DRYDOCK_CONFIG_DIR`
> (#129, see §5.28 of the plan: `testCommand` was inside drydock's own path allowlist), **engram onboarded** as a
> managed repo (#128), and the Tailscale funnel recovered (a delivery sweep found nothing needing redelivery). A
> deploy has since been performed with no `kill -9`. **P0-1 (#122) shipped, deployed and proven live**: webhook intake no
> longer shares one transcript — the adapter posts `{kind, subject, requestId, content}` to a factory-owned
> `/factory/intake`, which opens a conversation per `(kind, subject)` with only that kind's tools (§5.29 of
> the plan). The live end-to-end proof is still owed: it needs inference, and **`aurora.infinidigm:8888` was
> unreachable** while this was authored (`ping: sendto: No route to host`) — which also means no factory work
> can run at all until that endpoint answers. **P0-4 is closed by an executed drill, not an intention**: `gates/backup-drill.mjs` snapshots with `VACUUM INTO`, checks integrity on the copy, restores into a scratch tree, compares row and per-kind document counts, proves the restored store is writable, and (with `--boot`) starts a real instance from the restored data — 15 conversations recovered. Runbook §11. The remaining gap is stated there: backups live on the same disk as the stores. Deploying #132 while inference was down also revealed that a dead model host prevents instances from booting at all and, after 10 restart attempts, takes the supervisor and adapter down with it — evidence posted to #133; the fleet is offline until aurora returns or config fails over to spark. Sections marked DONE keep their original findings — they are
> why the fix looks the way it does.

**Purpose:** start a fresh session from one file. Everything below was verified by running commands on
2026-11-01, not recalled. Re-verify anything marked ⚠️ before acting on it; the fleet is a live process and
changes between sessions.

Related documents: `research/multi-repo-factory-plan.md` (design record, §5.1–§5.27),
`research/decision-log.md` (risks R1–R13), `research/work-queue.md` (ranked items),
`fleet/enable-self-work.md` (operator runbook, §1–§10).

---

## 1. Verdict (refreshed 2026-11-05; earlier verdicts preserved below)

**Bar A: met, and demonstrated repeatedly across two repositories rather than once. Bar B: no — three named blockers now (two weeks ago this was a general condition; yesterday it was four). None is code quality: one is supervision, one is an accepted disk risk, one is a guard that is deliberately soft.**

Two closures since the morning verdict: **eng#78 shipped** (engram#82 — nine unrun suites triaged, wired or declared manual, plus a CI-enforced collection check that fails when an unrun test file appears), and **#230's first half shipped** (`replanSource` + one-use operator grants, `43aed60`). **#220 also closed**: deploy verification is now one command printing seven rows with observed values (`fleet/verify-deploy-posture.mjs`), which does not move Bar B but removes a class of false "I verified it" claims — including one I made the same day, running a gate filename that has never existed, piped so it exited 0.

| bar | distance |
|---|---|
| Single-operator, single-host fleet: labeled issue → reviewed draft PR, cannot merge what it wasn't allowed to, announces when it stops | **Met.** All four P0s shipped (P0-4 scheduled *and* restore-proven). Proven in drydock (`agent/issue-80`, `agent/issue-105` merged) and repeatedly in a second repo: `engram#65` → **#74** (merged), plus `engram#76` → **#77** and **#79** — multi-file, unattended, `unit-suite` green. The safety property held throughout: `autoMerge: false` everywhere, protected mains in both repos, and `merge_pr` deliberately keeps **both** the prompt tier and the full destructive floor, so nothing lands without a human |
| Trustworthy without a human watching | **No.** Last week's reason **(a) — one destructive approval per file written — is fixed and measured**: the floor judges effect-bearing args only (engram v0.2.3), and `#76 → PR #77` touched 3 files with **zero approval taps**. What remains is four specific things, table below. Infrastructure and verification depth, not code quality |

**The four blockers on Bar B, ranked by cost to close:**

| | gap | why it blocks the claim | cost |
|---|---|---|---|
| 1 | **#217 — nothing supervises the supervisor**: no launchd unit, no `KeepAlive`, no liveness alert | a reboot leaves the factory down **silently**. Every alert that exists is event-driven (`pr_opened`, run failures), so absence of alerts ≠ presence of service. This is also why #226's reopen gap mattered so much: recovery was manual in two ways at once | ~30 min, one plist + one install |
| 2 | **#238 — a retry can still assert an unverified change.** #230 made authorization attributable (`replanSource`, one-use grants); nothing checks the claim itself, so "the issue has been sliced down to assertion 4" passes on model-authored prose about an untouched issue body | same demonstration as before: a false scope claim derived from my own reopen wording bought a full-budget run in 90 seconds. Provenance now tells you nobody authorized it — it cannot tell you the claim was false | hours; spec + acceptance in #238 (the mechanical part is cheap: hash the body at abort, compare on retry) |
| 3 | *(closed 2026-11-05)* ~~**eng#78 — nine engram suites executed by no CI job**~~ → shipped in engram#82: all nine triaged and passing (213 assertions), `classifier` wired into CI, the rest marked `// manual-only:` with scripts by prerequisite, and `app/test/script-coverage.test.ts` failing when a suite exists that no job reaches. Remaining scheduling gap is **eng#81** (nightly live tiers via a committed launchd plist) | "CI green" was load-bearing and weaker than assumed for containment/gate suites; that hole is now closed by a check rather than by attention | ~2 h of host work, eng#81 |
| 4 | **#213 — one disk holds stores and backups (operator-accepted)** | restore-proven ≠ recoverable; nobody has rebuilt on a clean host. Parked deliberately on 2026-11-05, so this is a stated risk, not pending work — but it stays a Bar B fact until someone else's hardware holds a copy | needs a destination + key custody decision 🧑 |

**What the old verdict got wrong.** It said "Not production-ready — P0 items 1–4: ~3–4 days". All four shipped; a reader taking that line at face value would have queued work that was already done. The lesson is the same one this repo keeps learning: **a status document is a claim with an expiry date**, and the honest failure mode is not "wrong" but "stale in a way that misroutes effort".

Against the definition of "production-ready" argued at the bottom of this document — *"the state survives host
loss and a restore has been performed, not designed"* — we now fail exactly one clause, and fail it on purpose
(#213). Everything else in that sentence is either satisfied or listed above.

**What is still unproven, stated without spin:**

- **Throughput.** Still no distribution behind the word "unattended". The batch that was supposed to produce one was **cancelled at n=2** (`factory-throughput-baseline.md` §7): dispatch 3+ would have needed tasks invented to fit the wall budget, and measuring tasks invented to be measurable measures the invention. What two runs did establish: a drydock-sized task does not fit 2400 s (setup alone is ~4 min), an over-large task costs ~2× without #222; engram#76 completed in **3.3 min**. Latency variance is still only #147 (one 900 s stall, 48 s on re-run).
- **"CI green" as a proxy for safe.** Narrowed, not eliminated. The hermetic suites and the collection check run in CI (engram#82), so a suite existing-but-unreachable now fails the build; the **live** tiers (model, sandbox, webui — 200 checks, ~4 min) still run only when a human invokes them, which is eng#81. A containment regression that only the sandbox tier would catch is currently caught on operator initiative rather than by every push.
- **Off-host recovery — ACCEPTED RISK (2026-11-05).** Restore is proven on the same disk as the data. Nobody has rebuilt the factory from backups on a clean host. The operator chose to park #213 rather than choose a destination and key custody, so disk loss or host loss means losing the stores; restore-proven does **not** mean recoverable. Revisit if the store ever holds something worth more than re-creating it by hand.
- **Reach discipline.** `gates/github-app-check.mjs` still reports `modelarena` and `collective` as reachable-but-unmanaged; intake refuses them, so this is leaked-key blast radius, not ordinary operation.
- **The feedback loop as a lever.** Both prompt channels (worker-side #168 hypothesis 1 at n=1, reviewer-side hypothesis 2 across two matched pairs) produced no reliable discrimination. Enforcement of rule placement moves to gates (#212).

<details>
<summary>Original verdict (2026-11-01), preserved because it explains why the fixes look the way they do</summary>

**Not production-ready.** Closer than a week ago, and now specific about which claim is unproven.

| bar | distance |
|---|---|
| Single-operator, single-host fleet that takes a labeled issue → reviewed draft PR unattended, cannot merge what it wasn't allowed to, and announces when it stops | **P0 items 1–4: ~3–4 days + one full verification cycle** (estimates; the battery has added work every time it has been run) |
| Trustworthy without a human watching | P1 as well: **2+ weeks and infrastructure that isn't a laptop.** A laptop, one inference endpoint, and an open public funnel are not production infra regardless of code quality |

</details>

---

## 2. Verified state at handoff (2026-11-01)

| thing | value | how to re-check |
|---|---|---|
| `main` | `6037f75` (feat: operator notifications #64), no open PRs | `git log --oneline -1` |
| unit suite | **317 checks, 0 failures** | `npm test` |
| CI | `unit-suite` required + strict on `main`, green | `gh api repos/lalanikarim/drydock/commits/main/check-runs --jq '[.check_runs[]|"\(.name): \(.conclusion)"]'` |
| supervisor | pid 16273 holding the lock, one instance ready ⚠️ | `cat fleet/data/routes.json.lock` (never `ps \| grep -c`) |
| instance boot lines | `root capabilities synced: delegate, open_draft_pr, pr_status, note_lesson, refine_issue`; `telegram notifications on (chat 675626)` | `/tmp/sup*.log`, or restart and read |
| public listener | funnel → `127.0.0.1:9700`, `/health` → `{"status":"ok"}` | `curl -s https://karims-macbook-air-2.tail109ba6.ts.net/health` |
| webhook hook | 703101252, events `issues` + `issue_comment` | `gh api repos/lalanikarim/drydock/hooks` |
| delivery sweep | launchd `com.drydock.redeliver`, last run inspected 94, **3 undelivered** (403/503/502, restart-window collateral), 16 acknowledged. Exit code 1 = findings present, by design | `python3 -c "import json;print(json.load(open('fleet/data/last-sweep.json')))"` |
| kernel pin | `vendor/engram` @ `v0.2.0` (`a764e36`) | `git submodule status` |
| credential | App `drydock-factory` (5557270), installation 177271737, hourly installation tokens, PEM outside the tree | `node gates/github-app-check.mjs` |
| drydock registry entry | `enabled:true`, `autoMerge:false`, eligibility `build`, `refine:true`, `prFeedback:true`, allowlist `factory/ fleet/ test/ research/ README.md AGENTS.md`, protected `gates/probes/`, verification required | `factory/repo-registry.json` |
| **last full nine-gate battery** | ✅ **8 of 9 green on 2026-11-02**: G0, G1, G2, G3, M1, M2, M4 PASS and **G4 PASS on re-run** (T1 merged with exactly one merge commit; T2 passed in 48 s after a first attempt that stalled for the full 900 s — instrumentation owed by #147, pass recorded in #148). G5 red — its two arms ran on one branch, so its "attribution" number was measured off a no-op diff (#145) | runbook §12; #144 (fix), #145, #147, #148 |
| **fixture supply** | ⚠️ The battery consumes its own targets: every fixture issue in both repos was closed/implemented, and M-gates refuse to run without `M_REPO_B`/`M_ISSUE_B`. Eight issues were seeded for this run from live `curl` transcripts (`battery-seed`, never `agent`) | runbook §12 |

Open issues (2026-11-03, later): **#145** G5 arms share one branch · **#147** G4-T2 retry stall (flaked once) · **#164** worker teardown faults with `erased(...).abort is not a function` (two occurrences; call site traced into `pi-durable`, likely shares a root with #157) · **#157** a SIGKILLed task stays `running` in the store · **#110** shutdown handle root cause · #78 deferred · #42 parked · #41 hold.

Closed since: **#161** — settlements are counted, classified and window-gated (`gates/settlement-window.mjs`, runbook §7d). Its first run found four faulted factory workers that had been reported by nothing (`completed=48 failing=4 aborted=6 unanswered=0`), two of which became #164. The gate's watermark alarms on new rows only, never advances on an unexamined failure, and exits 2 when zero stores were examined.

Closed since this document was written: **#143** (supervisor config resilience, #150) · **#141** (durable wall-budget cap + `POST /factory/runs/abort`, #153) · **#120** (containment runbook §7c, #158) · **#133** (inference probe and `/health` disclosure #136/#138; edges proven to deliver in #160 — item 3 split to #161) · **#64** (Telegram end-to-end: `telegram delivered inference_state message_id=121 attempts=1` from production, 2026-11-03).

Hygiene note, because it is the kind of finding this document exists to record: a **public** repo was publishing the operator's real Telegram chat id in `test/notify-telegram.test.mjs` with GitGuardian green on every run — its patterns match credentials, not identifiers. Redacted in #162, rule added to `AGENTS.md`; the value remains in git history, and the bot token was never in a tracked file.

---

## 3. P0 — blockers before any "production" claim

### P0-1 · #122 silent task loss (transcript poisoning) — DONE, deployed, proven live
The root agent refused `refine_issue` three times while a wire capture proved the tool was in the request:

```
tools = ['delegate', 'open_draft_pr', 'pr_status', 'note_lesson', 'refine_issue']
```

A fresh conversation called it on the first attempt and produced a brief. The poisoned root cited its own
earlier refusals as evidence, so **the condition strengthens with every failed attempt**. Blocks two
notification paths (`refine_posted`) and can silently swallow any task whose capability arrived after the root
conversation recorded a contrary claim.

*Repro recipe:* in issue #122 (and §5.26.1). Discriminating test: `POST /conversations` (fresh) + submit
"Call refine_issue …" → works; same instruction to conversation 1 → refused.

*What shipped (#132, deployed 2026-11-02):* structural, not a prompt. `factory/intake-router.ts` puts each
intake kind in **its own conversation per (kind, subject)** — e.g. `intake refine:#133` — created with exactly
that kind's tool registrations. `AgentChange.tools` is a hard kernel filter, so a refinement conversation
cannot call `delegate`; it is not being asked politely. Subject-scoping rather than per-event keeps stable
identity, and the core's per-conversation `requestId` settlement still provides exactly-once across GitHub
redeliveries.

*Live proof (production fleet, real label event, real model):*

```
[factory] lalanikarim/drydock: intake — opened refine conversation 1023 for #133 (1 tool(s))
[factory.refine] posted refinement for #133 -> https://github.com/lalanikarim/drydock/issues/133#issuecomment-6566383239
```

And at the data layer, where a log line does not have to be believed — conversation 1023's agent doc:

```json
{"model":{"provider":"aurora",…},"thinkingLevel":"medium","tools":["refine_issue"], …}
```

One tool. Root (conversation 1) still reports `["delegate","open_draft_pr","pr_status","note_lesson","refine_issue"]`,
which is the point: the poisoned context and the work no longer share a transcript. Ledger row verified in
`document_revisions` (`{"entries":{"refine:#133":1023}}` plus a delta recording request `issue-133-refine`).

*What this does not fix:* root is still what gates and operators drive, and it can still accumulate refusals
that color later root turns. Production webhook intake no longer lands there, so the silent-loss path is gone;
a root conversation that has refused things remains a thing to notice (runbook §6b has the queries). The posted brief was read before closing: it names the right goal, four testable criteria, and correctly
excluded vendor/engram from scope — i.e. it is usable input, not filler.

**What shipped.** The first option, taken: `factory/intake-router.ts` adds `POST /factory/intake`, registered via
`createCoreInstance({ routes })` so it sits behind the kernel's bearer gate, and the adapter posts
`{ kind, subject, requestId, content }` there instead of to `/tasks`. The instance opens one conversation per
`(kind, subject)` — `issue:#123`, `pr-feedback:#45`, `refine:#123` — created with exactly that kind's tools: a
refinement conversation is born with `refine_issue` and nothing else, so no transcript it could ever have
written contains "I don't have refine_issue". `(kind, subject)` rather than per-event because the kernel settles
`requestId` *per conversation*; a stable conversation is what GitHub redelivery dedupe attaches to. Root keeps
its re-asserted capabilities and remains what the gates and an operator on `/tasks` drive. Full reasoning, the
residual crash window, and the verification status: §5.29 of the plan; operator-facing "where did my event go":
runbook §6b.

*Still owed:* one real `refine` label producing a brief from a one-tool conversation, on the deployed fleet. The
real-kernel check for it (`factory/intake-boot.test.ts`) is written and skips without an inference endpoint.

### P0-2 · Re-run the nine-gate battery on current `main` — **DONE with two open tails (2026-11-02)**

Run on `main` `398385f` → `626de7a`, sequential, ~5.5 h wall including fixture seeding and one fix shipped mid-run.
Sign-off for G1/G4 fixture mutations was given by the operator before starting; it cost 8 seeded issues plus merges of
fixture PRs #52/#57-era drafts.

| gate | result | what it proved |
|---|---|---|
| G0 | **PASS** 20/20 | exactly-once intake under simulated retry, signature verification, multi-repo routing/M3, sender allowlist |
| G1 | **PASS** 190 s | label → unattended draft PR (fixture #49 → PR #52) |
| G2 | **PASS** 1/1 | #45 → PR #53; suite 98/0, scope ok, behavior ok, `zeroEdits=true`, 281K tokens |
| G3 | **PASS** | negative arm caught the seeded bad fix and named the root cause; positive arm passed |
| M1 | **PASS** | two repos completed the full chain **simultaneously**, evidence complete, one merge commit each |
| M2 | **PASS** | A SIGKILLed mid-run at 6 s; B completed end-to-end unaffected |
| M4 | **PASS** | A aborted cleanly by a 120 s budget (`abortedByBudget=true`, no PR); B completed |
| G4 | **PASS** (re-run) | T1: evidence on PR → approve → merge, `mergeCommits=1` verified. T2: approval survived the SIGKILL and re-verified the head sha; first attempt's retry stalled 900 s without explanation, re-run merged in 48 s with exactly one merge commit (#147) |
| G5 | **FAIL (harness)** | baseline arm exhibited the handler patch and the lesson arm did not — but both arms ran on `agent/issue-55`/PR #57, which had one commit total, so "did not recur" was measured off a no-op diff (#145) |

**What the run bought, beyond a green checkbox:** the first thing it caught was that three gates were failing on a
duplicated literal (`## Test suite (host-verified at PR creation)` vs the heading production emits), with exactly-once
merge, isolation and budget abort all passing underneath — fixed by putting the contract in `factory/pr-evidence.ts`
with producer and consumer sharing it (#144, +5 tests, mutation-checked). The second was G5's arm coupling (#145).
Both are harness defects: the properties under test held in every case.

**Bottom line: 8 of 9 green.** Only G5 stayed red, and on a harness defect (#145).

**Open tails:** #147 (G4-T2's one-off 900 s retry stall: if a durable approval is recorded but nothing re-drives the
merge, the Telegram-button flow silently stalls and looks like "nobody approved"), and #145.

### P0-3 · Deploy path: `SIGTERM` ignored — **DONE (2026-11-02, #130)**

Closed by `fleet/proc-group.ts` (children `detached`, each leading its own process group; teardown enumerates via `pgrep -g`, escalates `TERM → KILL`, reports survivors), `fleet/shutdown-coordinator.ts` (first signal graceful + bounded timer, **second signal exits immediately and `SIGKILL`s what is left**, give-up exits non-zero), and `factory/parent-watchdog.ts` (the child stops itself when its supervisor disappears — the only half that survives `SIGKILL` of the supervisor). Verified on the live fleet: a routine `SIGTERM` produced `terminating 3 child process group(s)`, all children closed, lock released and `:9700` free within ~12 s, no survivors; restart clean. Running this also exposed that an orphaned-and-self-closed instance left **no log trace at all** (its stdout is a pipe into the dead supervisor), hence `factory-instances/<repo>/orphan-events.log`. Detail: plan §5.28-era notes and PR #130.

*Original finding, kept because it explains the design:* Two reproductions on 2026-11-01: routine restart alive after **>8 s** (bound is 3 s), and after exhausting the
child-restart budget alive after **>24 s** (six checks) while still serving `/health`. Both deploys required
`kill -9`; recovery was safe only because lock reclaim worked (`reclaimed stale supervisor lock (previous pid N
is not running); held by pid M`). Hypothesis in issue #110: the bounded-exit timer is armed once and a second
signal has nothing to do — re-arm on every signal, and make "gave up restarting children" a bounded shutdown
instead of a zombie that keeps accepting webhooks.

**Consequence, filed as #125:** because `kill -9` is currently how deploys finish, **the supervisor's children are
orphaned**. Found live on 2026-11-01: an instance from a `SIGKILL`ed supervisor still running an hour later at
`ppid 1`, HTTP server up and `agent.sqlite` open, while `routes.json` pointed at its replacement — two harnesses
over one durable store. `pragma quick_check` returned `ok`, so no damage was done, but that is luck-shaped: SQLite
locks protect bytes, not invariants like "one process owns this issue's refusal budget". The #108 lock guards the
supervisor role and routes file, **not** the per-repo store. Fix either by owning the process group (children die
with the supervisor) or by a second lock at store granularity taken before the harness opens. Until then, every
deploy must end with the orphan check in §8 of the runbook.

### P0-4 · No backup/restore story for the durable store — ~half a day + one real drill
`factory-instances/<repo>/engram-data/agent.sqlite` **is** the factory: approvals, submissions, lessons,
refusal budgets, task graph. Zero mentions of backup or restore anywhere in `fleet/*.md` or the plan. Needs: a
dump/copy procedure, an off-box location, a restore run **executed once for real**, and a statement of what is
lost if the file dies (durable state vs rebuildable state — workspaces and clones are rebuildable; decisions
are not).

---

## 4. P1 — before "multi-repo production"

- **Second real repo wired, used, and shipping.** M1/M2/M4 passed on purpose-built fixtures
  (`factory-fixture`, `factory-fixture-2`), and the "fixtures prove mechanics, not usefulness" gap closed: engram
  has taken labeled issues end to end four times — `#65 → PR #74` (merged as v0.2.2), `#76 → #77`, `#79`, plus
  `#69`'s gate fix released as v0.2.3/v0.2.4 — with the factory's own pin discipline holding (`vendor/engram` at
  tags, drydock bumping per release). What is left of this P1 is not "does it work there" but **eng#78**: nine
  engram suites run in no CI job, so green there means less than it should.
- **engram is a managed repo (#78 narrowed, 2026-11-01).** The registry carries `lalanikarim/engram`
  (`enabled:true`, `autoMerge:false`, eligibility label `build`, `poc/lib/` protected because drydock vendors the
  kernel and a run must not break the pin discipline), with a fleet entry, a per-repo webhook secret in `.env`,
  and a webhook (706043067, events `issues` + `issue_comment`) on the same funnel. The first-dispatch
  precondition is met: engram's `main` has branch protection — verified live via
  `gh api repos/lalanikarim/engram/branches/main/protection` (`unit-suite` required and strict,
  `enforce_admins: true`, force-push and deletions off) — and `gates/github-app-check.mjs`, which now derives its
  managed list from the registry, reads engram with an installation token (issues/pulls 200).
  **#78 stays open with a narrower residual: `lalanikarim/collective` and `lalanikarim/modelarena` are still
  reachable-but-unmanaged.** Also unresolved by onboarding: #41 was "hold until engram is a managed repo", so it
  is now internal work rather than an upstream PR.
- **Fixture protection posture (queue 8b) — DECIDED 2026-11-02: accepted, recorded as R14.** Both fixtures
  have **no branch protection at all** and `autoMerge: true`. The operator chose to live with it: the unattended
  battery needs auto-merge (turning it off removes `merge_pr` from the toolset, so G1/G4 and #67 stop at a draft),
  and rulesets are unavailable on this plan (`403 Upgrade to GitHub Pro`). What makes the acceptance defensible
  is scope — fixtures hold disposable targets, no product code, and feed no deployment.
- **Listener exposure (P2, queue item 7):** funnel currently stays published between bursts by operator
  instruction. If that becomes per-burst, document the open/close procedure and the delivery loss it causes.
- **#64 end-to-end ping:** transport verified live (`{"ok":true,"status":200,"attempts":1}`) but no production
  `pr_opened`/`refine_posted` has fired. Closes when one is observed in the chat with its store record.
- **C5 release checklist** (queue 13): "full battery before pin bump or posture change" + the restart step, one
  page referenced from the runbook.
- **§3.9 / C4 partial-run recovery** (queue 11): preserve branch, mark resumable, requeue once with the diff as
  context.

## 5. P2 — deliberately deferred

Per-task token annotation (E4, partial: `factory/usage.ts`, `gates/m5-token-report.mjs`) · R9 path-scope-cannot-
express-intent (control is post-hoc review; see §5.12/R9) · #41 upstream kernel PR (hold until engram is a
managed repo) · #42 client-only federation design doc.

---

## 6. What is genuinely strong (don't re-litigate these)

Each has live evidence, not intent: path scope enforced pre-review with `vendor/` unconditionally protected;
host-side verification gate refusing push on non-zero exit; independent read-only review; `merge_pr` **removed
by capability** when policy says no merging; byte-scoped merge approvals (sha in tool args → approval key);
refusal budget stopping runs structurally; single-instance lock with crash reclaim (proved twice 2026-11-01);
delivery sweep + acknowledge workflow under launchd with exit-code propagation; capability assert-and-read-back
at boot; App credential with hourly installation tokens, PEM outside the tree, placeholder secrets refused at
boot; hermetic CI (no model endpoint, no containers, no fixture mutation).

Added 2026-11-05, each with production evidence rather than intent: the destructive floor judging **effect-bearing
args only for known tools while unknown tools stay strict** (deployed-config replay: 7/7 recorded false positives →
0/7, 8/8 genuinely dangerous calls still trip); a **boot-time posture line naming every narrowed tool**, checked by
a gate rather than remembered; an **operator abort ladder** where `conversationId` demonstrably stops the
orchestration loop and interventions are attributed in the durable ledger (`document_revisions` delta observed);
and a **reopen verb that appends history instead of deleting it**, with a test that fails if the budget ledger is
touched at all.

**Standing risk that stays accepted:** R13/#95 — untrusted text is fenced (`<untrusted>`), not sandboxed. A
hostile issue can waste a run or fail one cleanly; it cannot widen what a run may touch. AGENTS.md is
self-writable by operator decision; enforcement reads the registry at process start, never workspace files.

**Also standing, accepted 2026-11-02:** R14 — the fixture repos are unprotected on `main` and auto-merge.
The blast radius is bounded by what lives there (throwaway targets), not by any control we enforce. Do not point a
fixture at code that matters without re-opening this row.

---

## 7. The three defects that defined this week (patterns, not trivia)

1. **`root()` applies agent options only at creation** (engram#65, filed upstream). Restart delivered no new
   tools, instructions or model — including capability *removals*. Fixed downstream by assert + read-back, fatal
   on mismatch either direction: a stale root still offering `merge_pr` is worse than one missing a feature.
2. **A model refuses a tool it was given** (#122) because its own transcript says it can't. Self-reports are not
   evidence; capture the outbound request.
3. **A gate that trusts an exit code must verify what the command collected** (R10/R12). Enumerated `npm test`
   silently dropped a suite; a sweep returned 0 for lost deliveries because `main()` returned `{code:1}` instead
   of exiting 1. "Not collected" and "passing" are the same colour.

Corollary that keeps paying: **registry, route, boot log and task registration can all report success while the
feature is unreachable.** Drive the real path; when a model's account contradicts yours, read bytes.

---

## 8. Operating notes for the next session (things that cost time to learn)

- **Restart recipe:** `kill -TERM $(cat fleet/data/routes.json.lock)`; a second `SIGTERM` means "now" (immediate
  exit + `SIGKILL` to what is left) — that replaced the old advice of reaching for `kill -9`, which is what used to
  create orphans. Still verify: no `factory/main.ts` remaining, `lsof -nP -i :9700` empty, lock file gone. Then
  start and confirm the boot lines + `/health`. **If in doubt, read
  `factory-instances/<repo>/orphan-events.log`** — it records an orphaning even when the supervisor log cannot
  (the child's stdout is a pipe into the supervisor). Runbook §10 has the captured output.
- **Runtime config lives outside the repository:** `$DRYDOCK_CONFIG_DIR/<owner>_<repo>.json`, default
  `~/.drydock/configs/`. The supervisor refuses to start — naming every missing path, before taking the lock —
  if a fleet repo has no config there. It is not in git, so a fresh machine needs it created (§1a of the runbook);
  the reason is in plan §5.28.
- **Never run two supervisors** — they rewrite the shared routes file with different per-route tokens and every
  in-flight adapter refuses deliveries (#107). The lock does this job; don't disable it to "just try something".
- **Poll intervals ≤30 s, never sleep >30 s at a time.**
- **PR/issue bodies via `--body-file`** (never heredoc/inline). `gh pr edit`/`gh issue close` in this CLI version
  reject `--json`.
- **Drydock work issues must not carry the `agent` label** or the factory picks them up. Eligibility label for
  drydock is `build`; refinement label is `refine`; both are distinct by registry enforcement.
- **Stacked PRs:** use the `gh stack` extension (`github/gh-stack`). Merge bottom-up, delete branches top-down —
  deleting a base closes the PR above it unmerged. Squash-merging a layer breaks the next layer's base; repair
  with `git rebase --onto origin/main <layer-commit>^`.
- **GitHub delivery ids are 19 digits** — exceed `MAX_SAFE_INTEGER`; jq and `JSON.parse` corrupt them silently.
  Use `safeParse()` in `fleet/redeliver-failed.mjs` for anything touching them.
- **Model catalog comes from `~/.pi/agent/models.json`** (`PI_AGENT_DIR`); a declared provider beats env
  auto-registration, so overriding `OPENAI_BASE_URL` alone changes nothing. That's how you route traffic through
  a logging proxy when you need ground truth about a request.
- **Tests:** `npm test` uses glob discovery (`test/*.mjs`) — adding a file is enough; never reintroduce an
  enumerated list, and never edit `package.json`'s `scripts.test` from agent work (it *is* the verification gate,
  so it stays outside the path allowlist on purpose).
- **Run `npm run verify` (typecheck + suite), not just `npm test`.** CI runs `npm run typecheck` as a hard gate; the
  suite does not compile anything. Pushing on a green suite once shipped a red CI (#183's first run).
- **`npm run test:boot` runs LOCALLY ONLY — CI has no model.** The boot tests (`factory/*.test.ts`) need a reachable
  inference endpoint and skip cleanly when there isn't one; GitHub-hosted CI never has, so no job can run them. That
  is why `intake-boot.test.ts` stayed red at trunk for days (#171). Run it before shipping anything that touches core
  wiring, intake routes, or model resolution — and remember its assertions are non-vacuity checks: a submission being
  *accepted* proves nothing, because a ref naming an unregistered provider is accepted and never runs. Provider names
  come from `<agentDir>/models.json` (a declared provider beats env auto-registration); `providerForBaseUrl()` in
  `factory/model-catalog.ts` is the resolver.
  The script now runs all three boot tests — `core-spike`, `pipeline-boot`, `intake-boot`. It previously omitted
  `intake-boot.test.ts`, which is to say the one file that was red (#171) was excluded from the command named after
  it: a check nobody runs cannot fail, and a script that skips its most recently broken case will not catch a
  regression in intake wiring.
- **3 undelivered deliveries pending review** at handoff: re-drive with `node fleet/redeliver-failed.mjs --only
  <id>` after looking at each, or add the id to `fleet/data/acknowledged-deliveries.txt` with a reason. GitHub
  redacts delivery payloads, so correlate by timestamp against issue activity.

---

## 9. Suggested order of work from cold

1. #122 (design decision first: fresh conversation per task kind vs reset endpoint) → implement → verify live on
   this instance, including a real `/refine` that reaches the tool through intake.
2. ~~P0-3 shutdown fix + a deploy that needs no `kill -9`.~~ **Done 2026-11-02** (#130; the deploy was performed
   and captured — see P0-3 above).
3. P0-4 backup procedure + one executed restore drill.
4. P0-2 full battery on current `main`, fixtures included, with sign-off for G1/G4 mutations.
5. Then P1: second real repo onboarded behind protected `main`, exposure posture written down, #64 closed on an
   observed ping.

Definition of "production-ready" to argue against: *a labeled issue reaches a reviewed draft PR unattended; no
path exists by which the factory merges or widens its own authority; every failure mode is announced rather than
inferred; the state survives host loss and a restore has been performed, not designed.*
