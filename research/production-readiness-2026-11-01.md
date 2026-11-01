# Production readiness assessment + session handoff — 2026-11-01

**Purpose:** start a fresh session from one file. Everything below was verified by running commands on
2026-11-01, not recalled. Re-verify anything marked ⚠️ before acting on it; the fleet is a live process and
changes between sessions.

Related documents: `research/multi-repo-factory-plan.md` (design record, §5.1–§5.27),
`research/decision-log.md` (risks R1–R13), `research/work-queue.md` (ranked items),
`fleet/enable-self-work.md` (operator runbook, §1–§8).

---

## 1. Verdict

**Not production-ready.** Closer than a week ago, and now specific about which claim is unproven.

| bar | distance |
|---|---|
| Single-operator, single-host fleet that takes a labeled issue → reviewed draft PR unattended, cannot merge what it wasn't allowed to, and announces when it stops | **P0 items 1–4: ~3–4 days + one full verification cycle** (estimates; the battery has added work every time it has been run) |
| Trustworthy without a human watching | P1 as well: **2+ weeks and infrastructure that isn't a laptop.** A laptop, one inference endpoint, and an open public funnel are not production infra regardless of code quality |

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
| **last full nine-gate battery** | ⚠️ **`main` = `2596e9e`, 2026-10-28.** Everything since is unverified by the battery | plan §5.9 / §5.18 |

Open issues: **#122** transcript poisoning · **#110** shutdown handle/SIGTERM · **#64** notification end-to-end
proof · #120 (real doc work, specified by a refinement brief) · #78 deferred · #42 parked · #41 hold.

---

## 3. P0 — blockers before any "production" claim

### P0-1 · #122 silent task loss (transcript poisoning) — ~1 day
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

*Candidate fixes (undecided — decide, don't drift):* route each task kind to a fresh, capability-minimal
conversation (matches this repo's capability-removal posture); or expose `Conversation.reset()`/compaction over
HTTP (kernel API exists, app server has no route). **Do not** fix with more prompt text — the transcript
produces the counter-example.

### P0-2 · Re-run the nine-gate battery on current `main` — ~half a day wall time
Last PASS was 105 commits and ~29 merged PRs ago. Gates: `gates/g{0..5}-*.mjs`, `gates/m1-two-repos.mjs`,
`gates/m2-isolation.mjs`, `gates/m4-budget.mjs`. G1/G4 mutate fixtures → need explicit sign-off. Expect new
findings; budget for them rather than treating a red gate as surprise noise.

### P0-3 · Deploy path: `SIGTERM` ignored — ~half a day
Two reproductions on 2026-11-01: routine restart alive after **>8 s** (bound is 3 s), and after exhausting the
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

- **Second real repo wired; still nothing dispatched there.** M1/M2/M4 passed on purpose-built fixtures
  (`factory-fixture`, `factory-fixture-2`), and drydock remains the only repo that has done real self-work.
  Fixtures prove mechanics, not usefulness. engram is now managed (below) — what is missing is one labeled issue
  taken end to end there, with its own verification run.
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
- **Fixture protection posture (queue 8b):** both fixtures have **no branch protection at all** and
  `autoMerge: true`. Decide: protect them, or mark them permanently disposable.
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

**Standing risk that stays accepted:** R13/#95 — untrusted text is fenced (`<untrusted>`), not sandboxed. A
hostile issue can waste a run or fail one cleanly; it cannot widen what a run may touch. AGENTS.md is
self-writable by operator decision; enforcement reads the registry at process start, never workspace files.

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

- **Restart recipe:** `kill -TERM $(cat fleet/data/routes.json.lock)`; if still alive after ~5 s, `kill -9`
  (P0-3), then **check for orphaned children** — `ps -eo pid,ppid,etime,command | grep factory/main.ts` and kill
  anything at `ppid 1` (#125, two harnesses on one store) — then start and confirm the three boot lines +
  `/health`. Verify exactly one supervisor by lock owner and exactly one instance child by `PPID`.
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
- **3 undelivered deliveries pending review** at handoff: re-drive with `node fleet/redeliver-failed.mjs --only
  <id>` after looking at each, or add the id to `fleet/data/acknowledged-deliveries.txt` with a reason. GitHub
  redacts delivery payloads, so correlate by timestamp against issue activity.

---

## 9. Suggested order of work from cold

1. #122 (design decision first: fresh conversation per task kind vs reset endpoint) → implement → verify live on
   this instance, including a real `/refine` that reaches the tool through intake.
2. P0-3 shutdown fix + a deploy that needs no `kill -9`.
3. P0-4 backup procedure + one executed restore drill.
4. P0-2 full battery on current `main`, fixtures included, with sign-off for G1/G4 mutations.
5. Then P1: second real repo onboarded behind protected `main`, exposure posture written down, #64 closed on an
   observed ping.

Definition of "production-ready" to argue against: *a labeled issue reaches a reviewed draft PR unattended; no
path exists by which the factory merges or widens its own authority; every failure mode is announced rather than
inferred; the state survives host loss and a restore has been performed, not designed.*
