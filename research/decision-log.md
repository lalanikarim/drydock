# Decision log

Dated record of decisions taken on `lalanikarim/drydock`, one entry per decision: what was decided, why, and what it unblocks or costs. IDs trace back to `decision-questionnaire-2026-10-31.html`; superseded choices are named so a future reader can see what changed.

Statuses: **adopted** · **adopted-with-risk** · **interpretation** (my reading of an answer, correct it cheaply) · **open** (still needs input).

---

## 2026-10-31 — deployment & transport

### A1 — Transport: Tailscale Funnel in front of the supervisor host · **adopted-with-risk**

GitHub reaches `127.0.0.1:9700` through a Funnel HTTPS URL. Requirements any front must satisfy stay documented in `fleet/enable-self-work.md` §3 (TLS, byte-for-byte body forwarding, no buffering ahead of GitHub payloads, 4xx passthrough) — the factory itself remains transport-agnostic.

Funnel was already proven end to end here (`/health` reached publicly, then torn down). Risk: a revocable public URL on a laptop; see A2 and R3. Supersedes "stay local / POST /tasks only".

### A2 — Supervisor runs on this laptop · **adopted-with-risk**

Accepted for the next stretch. Consequences accepted explicitly: sleep and IP churn affect a published listener, restart discipline is manual until #69 lands, and credentials live in a user keychain rather than a service context. Any move to an always-on host should re-derive this entry rather than inherit it.

### A3 — Fix #69 before publishing · **adopted**

The stale-routes defect is the one bug that can make a correctly-signed delivery be refused as unknown-repo while the listener reports healthy. Publishing after it lands removes the "restart and read the adapter's startup line" ritual from the critical path. #61/#62 are not prerequisites for publishing (they matter regardless — see C1/C2).

### A4 — Webhook secret stays in `.env` · **adopted**

Single-operator host; `fleet/fleet.local.json` and `.env` are gitignored. Revisit if the host becomes shared or always-on-public.

---

## 2026-10-31 — identity & credentials

### B1 — One fine-grained PAT scoped to exactly the managed repos · **superseded 2026-10-31 by B1-rev**

One secret, explicit repo list, no org-wide write. Scopes needed by the current flow: `contents:write`, `pull_requests:write`, `issues:read`. Supersedes "account-wide via gh keychain" (which is what actually runs today, per #70).

*Superseded because a GitHub App (`drydock-factory`) turned out to be configured already and satisfies the same requirement without a long-lived secret — see B1-rev. The PAT is never cut.*

### B1-rev — The GitHub App installation is the factory credential; no PAT · **adopted — verified 2026-10-31, code wiring pending**

Operator decision: "we have a GitHub App configured already and updated .env. we'll proceed with that instead of PAT." B3 (App for authorship) stops being a later phase and becomes the credential decision as well — one identity for both, which is cleaner than B1 + B3 coexisting.

**Verified against the live installation** (`gates/github-app-check.mjs`, read-only apart from one reversible ref probe):

| Property | Value | Verdict |
|---|---|---|
| App | `drydock-factory` (id 5557270), owned by `lalanikarim` | — |
| Installation | 177271737 on user `lalanikarim` | — |
| Permissions granted | `contents:write`, `issues:write`, `pull_requests:write`, `metadata:read` | **covers everything the factory needs**, incl. more than B1 asked (`issues:write` vs `issues:read`) |
| Write capability | created then deleted a branch ref on `lalanikarim/drydock` with an installation token (201 → 204) | **proven, not just granted** |
| Read access | issues + pulls HTTP 200 on drydock and both fixtures (private ones included) | ok |
| Token lifetime | installation tokens expire ~1 h; app JWT minted for ≤10 min from `GITHUB_APP_PRIVATE_KEY_PATH` | strictly better than a PAT that never expires |
| Repository selection (first check) | `all` — 172 repositories (5 private), including ones created later | ⚠ far wider in reach than B1 intended |
| **Repository selection (after narrowing)** | **`selected` — 6 repositories (2 private)**: drydock, factory-fixture, factory-fixture-2 + engram, collective, modelarena | ✅ account-wide exposure closed; 3 unmanaged repos still reachable (see R7 residual) |
| App webhook events | none subscribed | fine today (repo webhook + secret); relevant if we ever want app-driven wakeups instead |

**The honest part:** an App is often described as the scoped option, and out of the box it wasn't — `repository_selection: all` meant a leaked key could touch every repo in the account, which is *more* than the fine-grained PAT would have allowed. What an App does buy regardless: no never-expiring secret in any env var or keychain, 1-hour tokens, four permission types instead of an auth surface that can do anything the account can, and revocation by uninstalling rather than rotation. The scoping half has to be configured; it is now (queue item 3a done, reach 172 → 6).

**Reach is a different axis from routing, and the probe now checks both.** `factory/repo-registry.json` gates *routes* — an issue in an unmanaged repo is never dispatched — but it says nothing about what the credential could write if misused. Re-running the check after narrowing surfaced exactly that gap: **engram, collective and modelarena are reachable but unmanaged**. One of them is the vendored kernel. drydock pins a specific engram commit and protects `vendor/` unconditionally precisely because "which kernel are we running?" is meant to be a human decision; a credential able to push that repo's default branch (currently **unprotected**) bypasses the whole pin discipline. Routes would never do it — a leaked key could. So `gates/github-app-check.mjs` now diffs installation reach against the registry and names every reachable-but-unmanaged repo, with a specific warning when the set contains engram: remove it, or protect that branch. Keeping engram is defensible (queue item 9 sends upstream PRs) but it should be an explicit decision with a branch rule behind it, not an inheritance from "All repositories".

**Superseded 2026-11-01 — R8 CLOSED:** the paragraph below describes 2026-10-31. `factory/github-auth.ts` now reads `GITHUB_APP_*`, boot verifies the installation-token exchange before reporting ready, and the keychain fallback is no longer taken on this host. Kept as the record of what B1-rev decided.

**What is not true yet:** no drydock code reads `GITHUB_APP_*`. Runs today still fall back to the host keychain (#70's warning fires). The credential work is therefore *not* finished by this decision — it moves from "cut a PAT" (dropped) to "implement the token exchange and wire it into clone/push/PR authorship" (queue item 3b, promoted into the pre-publish sequence because R3 always required a non-keychain credential before publishing).

### B2 — Missing factory token: start, but log the credential path loudly · **adopted — implemented**

Boot must state which credential path it resolved (`FACTORY_GITHUB_TOKEN` set vs host credential helper) and that an unset variable means account-wide. Never silent, never fatal — local work stays friction-free. Implements #70.

Implemented: `factory/credential-source.ts` resolves the same order the pipeline uses (env → per-repo config → host helpers → none) and `main.ts` logs it at boot; the host-helper and none cases are `console.warn`. Live-verified on this machine's real configuration: boot now prints `WARNING — git credential: NO factory token configured — clone/push will fall back to the host credential helper(s): osxkeychain (file:/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig). On a developer machine that entry is typically ACCOUNT-WIDE; scope it (decision B1) or set FACTORY_GITHUB_TOKEN.`

### B3 — PRs should be authored by a GitHub App · **adopted — App now created and installed**

Answers #68 properly: PRs appear as the app, reviewable before merge by a human, with an identity distinct from the operator's. Originally sequenced after B1; superseded sequencing by B1-rev — the App is created, installed, permission-verified (2026-10-31), and is now both the credential and the author identity. Remaining for #68: implement the exchange in code and confirm PRs actually appear as `drydock-factory` rather than `lalanikarim` on the first app-authored run.

### I2 — interpretation: PAT now, App later · **superseded 2026-10-31 by B1-rev**

B1 and B3 could read as contradictory. Reading at the time: PAT = today's credential with a bounded blast radius; App = identity for authorship. *Rendered moot: no PAT is cut; the App does both.*

---

## 2026-10-31 — verification strategy (this is the load-bearing change)

### C1 — `open_draft_pr` runs the repo's test command and refuses to push on non-zero · **adopted — implemented**

Strongest option chosen: no PR without a passing verification run, exit code attached as evidence. Directly prevents the §5.16 failure (a PR body asserting "tests pass" over a crashing `npm test`).

Implemented in `factory/verification.ts` (+ wired into `open-draft-pr.ts`, gated by registry policy `requireVerification`, default **true**). Four things the decision text did not spell out, settled during implementation:

1. **A waiver is not a license to ship red.** `requireVerification: false` covers "this repo has nothing to run"; if a command *is* configured and exits non-zero — or times out — the push is refused anyway. Otherwise the escape hatch would have been a way to disable the gate entirely.
2. **Exit 0 with zero tests collected is not verification.** A runner that matches no files can succeed vacuously; the evidence records `vacuous` and the gate refuses, required *and* waived. This caught a real defect while writing the test: a nested `node --test` inheriting `NODE_TEST_CONTEXT` prints "skipping running files" and **exits 0 having run nothing** (reproduced on node 22). The child env is now stripped of that variable, with a regression test that would fail without the fix.
3. **Timeout ≠ red.** A suite terminated by our own ceiling is reported as TIMEOUT, not FAIL, so "slow" is never recorded as "broken" — but it still blocks the push.
4. **Ordering: verification before review.** Seconds versus minutes of inference, same reasoning as the path-scope gate. Both gates stay independent — a green suite says nothing about correctness, which is exactly what a wrong-but-passing implementation survives.

Evidence shape in the PR body: exact command, exit code, result line, output tail (60 lines on failure, deliberately long enough to contain the assertion error so the orchestrator's re-delegation carries something actionable). A waived repo gets `**NOT VERIFIED — nothing was executed**` plus "a human reviewing this PR is the only verification it has had".

### C2 — No GitHub Actions. All tests local only. · **superseded 2026-10-31 (same day) by C2-rev**

Budget decision; recorded verbatim: *"No github actions. we don't have the budget. all tests local only."* Recorded at the time with a factual note: `lalanikarim/drydock` is a **public** repo, where GitHub provides unlimited Linux-hosted Actions minutes (private repos get 2,000/month; both fixtures are private) — so if "no budget" refers to runner cost specifically, that constraint does not apply to drydock itself.

### C2-rev — CI gate: hermetic unit suite + kernel pin check · **adopted**

Operator re-decision after the note above: *"let's reconsider CI. if it is free, then let's add that as a gate."* `.github/workflows/ci.yml` runs on push to `main` and every PR: recursive submodule checkout → **pin integrity check** (logs which engram sha the suite actually ran against; fails if the checked-out submodule differs from the gitlink in HEAD) → `npm ci && npm test`.

Scope is deliberately hermetic, and C2's surviving sub-choice carries over: `submodule_pin` became the pin integrity step. Still excluded, for reasons that don't change with free minutes: `test:boot` needs a live inference endpoint + local sandbox image (host resources), and `gates/*` mutate fixture repos and burn inference — running them unattended is exactly the accident they prevent. First run failed on a git quirk (`git rev-parse vendor/engram` echoes the path instead of resolving the gitlink from the superproject); fixed to read the sha from inside the submodule. Second run: **green**, pin check reporting engram `a764e36` (v0.2.0).

**Remaining step (operator):** add check name `unit-suite` as a required status check on `main` in branch protection. Until then it is advisory — visible but not blocking.

### I3 — interpretation: #61 becomes the gate that CI would have been · **interpretation (weakened by C2-rev)**

Under C2, `open_draft_pr`'s verification evidence was the *only* automatic control before a human clicks merge. Under C2-rev it is still the only **pre-push** control — CI runs on every draft PR head, so by review time its status is visible, but nothing prevents pushing broken code in the first place. C1 stays mandatory; a repo without a test command cannot produce PRs unless we add an explicit escape hatch per repo config.

### R1 — risk: no CI + zero required reviews · **closed 2026-11-01**

Both halves are gone: `unit-suite` is a required, strict status check on `main` with `enforce_admins` on (#73/#62), and the `main-review-gate-admin-bypass` ruleset requires 1 approving review with admin bypass (E3 resolved). What remains of this risk is the asymmetry recorded under E3 — a red suite is non-negotiable, review can be stepped over by an admin — plus R9's residual (path scope cannot express intent).

Accepted posture for a single-operator repo. Mitigations in force: capability removal (`autoMerge:false` → `merge_pr` absent), path scope with `gates/` outside the allowlist, byte-scoped merge approvals (#47), and C1 evidence-on-push. What is *not* mitigated: nothing external re-runs tests after a draft PR exists.

---

## 2026-10-31 — code approach decisions

### C3 — #69: write routes before spawning; verify hash per request; exit loudly on drift · **adopted — implemented**

No silent hot-reload. A policy change becomes effective through an explicit restart, which keeps "policy reviews like code" true and makes the failure mode a dead listener instead of a healthy-looking one with stale authority.

Implemented: supervisor writes the routes file before spawning anything (atomic temp+rename, always overwrite — a leftover file can no longer survive); adapter hashes the file at start and on every webhook request; changed file → 503 + audited refusal + exit, supervisor restarts against current policy. Both sides log the hash. Live-verified: with a running adapter, a supervisor-style secret rotation made an old-secret-signed request return 503 ("startup bda868…, now 4cc916…") and terminate the process.

### C4 — §3.9 T1: preserve the branch, mark resumable, requeue once with the diff as context · **adopted**

Priced by measurement, not intuition: §5.17 showed rework cost 43% more than the first attempt (467K vs 326K tokens, 18 worker generations vs 12) because context has to be rebuilt from the branch. Resume beats restart on cost as well as on waste.

### C5 — Full gate battery before each kernel pin bump or major posture change · **adopted**

Matches actual usage (N2 was run exactly that way). G0 + unit suite stay per-merge; no scheduled full battery while the supervisor host is a laptop.

---

## 2026-10-31 — roadmap

### D1 — Next builds, in order: #67 PR-comment feedback loop → #65 issue triage/expansion → #68 GitHub App · **adopted**

Notable that all three ranked items are new capability rather than the open defect list; reconciled in I1.

### I1 — interpretation: in-flight correctness first, then the ranked features · **interpretation**

D1 ranks three capabilities while A3 gates deployment on #69 and C1 was chosen as the CI substitute. Combined with G3 ("wrap up all in-flight work as soon as possible and get this ready for production"), the queue ran: #69 → #70 → PAT → #61 → E1 allowlist → publish, then D1's ranked list. **Updated 2026-10-31:** #69, #70 and #61 are shipped; "PAT" became "App credential wired into code (3b) + narrow installation reach (3a)" under B1-rev, so the remaining pre-publish sequence is 3a → 3b → E1 allowlist → publish.

### D2 — Target 2 (#42): design document only, no build · **adopted**

Its stated N3 gate is met (drydock shipped self-work PR #59), so waiting is no longer justified by the gate — but capacity is. A written design/decision doc keeps the option open without displacing Target 1's gaps.

### D3 — Run fixture-1 #45 as the post-change confirmation · **adopted**

Exercises G2/G4 with everything merged since N2 applied. Costs ~10 min of aurora inference and produces one draft PR for a human merge. After it, both fixtures hold green oracles with no live targets — revisit their role (regression-only vs re-seeding) at that point.

### D4 — #41: send the upstream PR against engram ourselves · **adopted**

Two narrowings in the v0.2.0 destructive guard (interpreter-head matching, `/dev` redirection drop; tracked upstream as engram#63). We own the fix conversation instead of waiting on a release. No pin change until it lands and passes the battery.

**Update 2026-11-03 — landed and pinned.** engram tagged `v0.2.1` at `e8791af` (PR #70 closed both halves) and drydock re-pinned to it on the same day: full suite 555/554/0, typecheck clean, `npm run test:boot` green against real inference, and suite F of `test/n1-destructive-classification.test.mjs` inverted from gap-characterization to floor assertions. The bump also surfaced a dependency-class risk that no manifest diff would show: the vendored kernel now needs `croner`, resolved from *our* root `node_modules`, so drydock declares it too.

---

## 2026-10-31 — safety posture revisions

### E1 — Add root-level docs to drydock's self-work allowlist · **adopted-with-risk**

`pathAllowlist` gains `README.md` and `AGENTS.md` (existing: `factory/`, `fleet/`, `test/`, `research/`). `gates/` stays out; `gates/probes/` stays in `protectedPaths`; `vendor/` remains unconditionally protected.

**Implemented 2026-10-31.** Asked which way, the operator chose self-writable: *"Agents should be self writable."* So `AGENTS.md` is **not** moved to `protectedPaths`.

The safety argument, stated as mechanism rather than optimism: `AGENTS.md` is advisory text consumed by the model, whereas enforcement reads `factory/repo-registry.json` at process start and never consults the workspace's own files. Editing the instructions therefore cannot widen what a run may do — the push-time scope check refuses `vendor/`, dependency manifests, CI config, `gates/` and `gates/probes/` regardless of what any document claims. And because drydock has `autoMerge: false`, an edit to the operating rules changes future behaviour only after a human merges it, in a diff where self-modification is conspicuous. What remains genuinely risky is soft: a merged change that weakens *guidance* (e.g. deleting a rule about staging) is caught by review and CI, not by path scope. `test/path-scope.test.mjs` pins both halves — docs writable, capability files refused, and a bundle of `AGENTS.md` + an oracle edit rejected wholesale.

### E2 — `autoMerge` is never true, anywhere · **adopted**

Human merges, always. Consistent with capability removal being the enforcement mechanism: there is no repo config in which a destructive tool should appear in the worker's tool list.

### E3 — Review gate ON (1 approval), admin may bypass; CI stays required for everyone · **superseded 2026-10-31 by the operator's ruling**

Recorded verbatim at the time: *"This can be revisited once Github App integration is completed."* The App landed and authored its first merged PR (#83), so the precondition was met and the question came back. The operator's answer: **"CI gate is required — review gate should be optional for admin."**

Implemented as ruleset `main-review-gate-admin-bypass` (`pull_request`, 1 approving review, stale reviews dismissed on push) with `bypass_actors: [RepositoryRole/5 = Admin → always]`, layered on the existing classic protection (`unit-suite` strict, `enforce_admins: true`). The asymmetry is the point: a green suite is treated as non-negotiable and review as judgment that a solo maintainer may step over — with the caveat, recorded in the runbook, that GitHub refuses self-approval, so your own branches merge by bypass while factory-authored branches can be approved normally.

Implementation note worth keeping: classic branch protection has no per-rule admin bypass — `enforce_admins` is all-or-nothing for the branch — so expressing "CI for everyone, review optional for admin" required a ruleset. Rulesets and classic protection coexist and both are enforced, which is why CI did not need moving. Two API traps hit on the way: the review rule type is `pull_request` (not `required_reviews` or `pull_request_rule`), and the bypass actor type is `RepositoryRole` with `actor_id: 5` for admin — `RepositoryAdmin` is rejected as invalid.

**Evidence, operational rather than configured:** the operator merged #86 (docs-only, `unit-suite` green) with no approving review. Before the bypass the PR read `reviewDecision=REVIEW_REQUIRED`, `mergeStateStatus=BLOCKED`; after, it merged. CI was neither consulted as an exception nor waived. Follow-up found while wiring this: **#87** — factory commits carry a placeholder author (`factory-worker@localhost`) while the ruleset reports `require_extra_approval_for_unattributed_changes: true`, so B3's identity story is currently true of the pull request and false of the commits.

### E4 — Token budgets: warn and annotate, never abort · **adopted**

Collect a distribution before enforcing. Baselines exist now (§5.17: 160K–467K tokens per task, 78–88% cache reads), so an eventual ceiling can be set from data instead of guesses — and M4's lesson (a budget below task duration looks like a failure) is still true.

---

## 2026-10-31 — housekeeping & records

### F1 — Delete merged local branches · **adopted**

`chore/self-run-rework-detection` and `chore/self-work-enablement-runbook` removed (safe delete, both merged). `feature/drydock-self-manageable` (POC era) was not selected for deletion and stays.

### F2 — Decisions live in this file · **adopted**

One entry per decision with date and status, greppable by topic. Supersedes continuing the plan's §5.x prose for decisions; `research/multi-repo-factory-plan.md` keeps narrative/measurement/evidence sections and points here.

### F3 — md → html regeneration stays manual · **adopted**

Accepted drift risk on request-driven regeneration only. Accepted exception: `decision-questionnaire-2026-10-31.html` is a tool with no markdown source, so the "md is source of truth" rule does not apply to it.

---

## Open questions (not answered in the questionnaire)

### G2 — What am I most uneasy about in the current design? · **open**

Asked and left blank. It stays on the list; unspoken unease has a way of becoming the thing that breaks.

### G3 — "This is working" in a month: *wrap up all in-flight work ASAP, get this ready for production* · **adopted as the north star**

Concrete enough to check against `research/work-queue.md`: every in-flight item closed, listener published and smoke-tested, credential scoped.

### G4 — Anything else / corrections to premises · **open**

---

## Risk register (cross-cutting)

| # | Risk | In force because | Mitigation / trigger to revisit |
|---|---|---|---|
| R1 | ~~No CI~~ and ~~0 required approving reviews~~: nothing *required* re-ran tests after a draft PR existed | C2-rev + E3 | **CLOSED 2026-11-01**: `unit-suite` is required and strict on `main` with `enforce_admins` on (so admins cannot merge red, and direct pushes are refused), and ruleset `main-review-gate-admin-bypass` requires 1 approving review with admin bypass. C1 remains the pre-push control. Residual is E3's deliberate asymmetry — review can be stepped over by an admin, a red suite cannot |
| R2 | Self-work can edit `AGENTS.md`, the file that constrains it | E1 (accepted 2026-10-31) | Accepted deliberately: the file is advisory, enforcement reads the registry at process start, and a merged edit only takes effect through a human merge. Residual risk is guidance erosion caught by review/CI, not path scope |
| R3 | Public listener (Funnel) on a laptop — credential was account-wide at time of writing, now short-lived App installation tokens (#79), reach `selected`/6 repos with residual in #78 | A1 + A2 | Was "B1 PAT first"; now **B1-rev: App-based credential wired into the code before publishing** (queue item 3b), since the keychain fallback is exactly what the warning in #70 describes. Funnel URL is revocable; `allowedSenders` stays on |
| R7 | ~~App installation reach is all 172 account repos~~ → **residual: 3 reachable-but-unmanaged repos** (`engram`, `collective`, `modelarena`), one of which is the vendored kernel | B1-rev after narrowing to `selected` (6 repos, 2 private) | Account-wide exposure closed 2026-10-31. Residual: drop those three from the installation, **or** keep `engram` deliberately for upstream PRs (queue item 9) and protect its `main` — it currently has no branch protection at all, so the App could push the kernel's default branch with routes never involved. `gates/github-app-check.mjs` diffs reach against the registry and says this out loud on every run. **Deferred 2026-10-31 by the operator** — engram is intended to become a managed repo, so leaving it installed is the shape of the next step rather than an oversight; tracked in #78. The residual stands until then: a leaked key could write an unprotected kernel `main`. When engram is onboarded, protect its `main` **before** dispatching any work there |
| R8 | ~~App credential configured but not consumed~~ — **CLOSED**: `factory/github-auth.ts` resolves and uses it; boot verifies the exchange before ready | closed by queue 3b | Boot prints `git credential: GitHub App 5557270 (installation 177271737)` + `installation token exchange verified`; the keychain warning is gone from this path |
| R4 | ~~Stale policy accepted between fleet change and restart~~ | **#69 closed** (this PR) | Supervisor writes fresh routes before spawn (atomic, always overwrite); adapter re-hashes per request and exits on drift. Residual: fleet-file changes still need a supervisor restart (fleet is read once at start) — documented in the runbook |
| R5 | ~~Re-verification of a draft PR after rework relies on the same worker-run command~~ | **closed** by C1 + C2-rev | Verification now runs host-side at push time (not inside the worker's sandbox), and CI runs the same suite on the resulting PR head independently of the factory. Byte-scoped approval (#47) means an approval names the commit that was tested |
| R13 | Untrusted text can still steer a model through **prose**. `<untrusted>` delimiters are a fence, not a sandbox — #95 closed the structural escape (a body closing its own envelope) but an issue can still say "ignore the working rules" in words no marker prevents | #95 (§5.24) | Accepted residual. The controls with teeth are structural and unchanged: path scope before review, verification exit code, independent review, `merge_pr` removed by policy, refusal budget (#100). A hostile issue can waste a run or fail cleanly; it cannot widen what a run may touch — that is the property being protected, not "the model was politely influenced" |
| R12 | A **transient** intake failure is permanent data loss: GitHub does not automatically redeliver failed webhook deliveries, and nothing surfaced them | #107 (docs + live hook log) | Guarded and now observable: single-instance lock on the supervisor (`fleet/single-instance.ts`, `routes.json.lock`) so concurrent supervisors cannot churn the shared routes file; `fleet/redeliver-failed.mjs` sweeps non-`OK` deliveries and re-POSTs them (report-only default, `--only` for surgical recovery); runbook §7 states the commands and the one-supervisor check. Baseline from the first sweep: **34 undelivered events in two days**, all invisible until counted. Residual: the sweep is not yet on a schedule (cron/launchd decision open), and shutdown still leaves a child handle open long enough that only the ref'd 3s deadline ends the process — bounded, not explained |
| R10 | ~~Enumerated `npm test` silently skipped suites~~ — **CLOSED by #102**: discovery is structural and a guard fails on an empty or partial match | C1/C2-rev trust an exit code, so the suite list is load-bearing | The list had dropped `test/git-identity.test.mjs`: it passed when run directly and appeared in no CI job, which is part of how the #87 regression (#98) shipped green. Lesson generalizes R6(b): **a gate that trusts a command must also verify what that command collects** — "not collected" and "passing" are the same color. `test/suite-discovery.test.mjs` asserts pattern-based discovery, disk-vs-collected set equality, and non-zero collection |
| R11 | A self-task can be **unsatisfiable by construction** while every individual control behaves correctly, and the run has no budget to notice | path scope + enumerated suites + no retry cap (#100) | Issue #99: worker adds a test → registering it needs `package.json` → allowlist refuses → root agent re-delegates → six full worker+review cycles on an identical refusal, stopped by hand. Three separate layers behaved; only the composition was wrong. Mitigations: #102 (the trap), #103 (worker is told its scope up front). **CLOSED by #100**: refusals are classified (`path_scope` non-retryable, `verification`/`review` retryable, `infrastructure` never charged) and two ceilings stop a run — 2 identical signatures or 4 counted refusals per issue — enforced at the top of `open_draft_pr` so a stopped run costs no clone, no test command and no reviewer inference. Residual: the budget is per-process memory (a restart clears it by design), and it cannot distinguish an unsatisfiable task from a merely hard one — only that a refusal repeated (§5.22) |
| R6 | Two latent fail-open coercions found while implementing C1 — both now fixed, kept here as the lesson | registry validation | (a) `Boolean("false") === true`, so a JSON typo like `"autoMerge": "false"` would have **granted** merge rights; safety flags are now type-checked. (b) A nested `node --test` inheriting `NODE_TEST_CONTEXT` skips every file and exits 0 — a green verification with zero tests behind it; the child env is stripped and zero collected tests is treated as failure. Both were found by testing, not review: suspect this class of bug in any flag coerced with `Boolean()` or any gate that trusts an exit code alone |
| R14 | **The fixture repos have no protection on `main`.** `lalanikarim/factory-fixture` and `factory-fixture-2` accept merges with no required checks and no reviews, and inherit `autoMerge: true`, so anything the factory lands there is landed unprotected — including by a run that was wrong. | **Accepted in writing on 2026-11-02 by the operator**, and it is load-bearing rather than convenient: `autoMerge:false` removes `merge_pr` from the toolset entirely (`factory/main.ts`, `factory/pipeline.ts`), so G1/G4 and #67 rework would stop at a draft PR and the gates that prove merge-gate behavior could not run unattended. GitHub rulesets answer `403 Upgrade to GitHub Pro` for these repos, so "add protection" is not on the current plan. | Scope is what keeps it survivable: fixtures hold disposable battery targets, no product code, and are a deployment source for nothing — and neither fixture is a supervisor child today, so the exposure exists only while a battery run has its instance up (which is exactly when merges happen). Revisit when the account gains rulesets, when a fixture is ever pointed at real code, or when a gate's claim starts *depending* on protection — and then move the fixtures to where protection exists instead of turning auto-merge off and losing the battery. |

---

## 2026-10-31 (later) — publishing the listener, and what it proved

Queue item 6 executed: `fleet/fleet.local.json` → supervisor → adapter on `127.0.0.1:9700` → public HTTPS in front (A1), existing hook `703101252` realigned to the env secret, and one real issue driven end to end by label.

**Adopted — published and verified.** Evidence: `issues.labeled` on #80 → `{"action":"labeled","requestId":"issue-80","accepted":true}` → worker in sandbox → independent review → **draft PR #83 authored by `app/drydock-factory`**, stopped there with no pending approval. Negative paths probed against the live URL: wrong signature 403, missing signature 403, correct-signature-but-cross-repo 403 (`signed for lalanikarim/drydock, payload names lalanikarim/factory-fixture`), correct-signature-but-unlisted-sender 403 (`sender not allowlisted for lalanikarim/drydock: someone-else`). Idempotency: replaying the accepted dispatch produced no second worker (setup count unchanged, zero containers, branch head unchanged).

**B3 — CLOSED.** The App authors the PRs it creates. This was the observable half of the credential decision and it is now a fact about output rather than about configuration.

**Defects found by publishing rather than by reading:** (1) `fleet/supervisor.ts` never loaded `.env` while `factory/main.ts` did, so the adapter signed with the fleet file's placeholder and every GitHub delivery failed `invalid signature` — fixed in PR #82 with a shared loader plus boot-time refusal of placeholder-shaped secrets; (2) #80, `defaultMismatchWarning()` comparing `provider:model` against `provider/model` and therefore firing on every boot — fixed by the factory itself in #83; (3) #81, the routes-drift guard treating the expected post-ready `target` fill as policy drift, so each cold start costs one self-healing adapter restart.

### New risk recorded: R9 — path scope cannot express intent

#83's worker changed `factory/verification.ts`, which issue #80 never asked for and which is inside drydock's allowlist. The reviewer caught and labelled it as bundled-in scope creep, which is the designed control working — but it marks the boundary precisely: `pathAllowlist` answers *"may this file ever change in a self-run?"*, not *"should this issue have changed it?"*. Residual risk is silent scope growth inside allowed directories; mitigations worth considering are per-issue expectations (an issue must name the files it expects to change, and drift beyond them is a review-blocking signal) or narrower allowlists per task rather than per repo. Neither exists yet.

### E3 is now an operator decision with real inputs

Authorship distinguishes factory PRs from human ones, which was the stated precondition for revisiting required reviews. The constraint that shapes the choice: GitHub branch protection cannot condition review requirements on PR author, so "one approving review, except bot PRs" isn't expressible — enabling reviews applies to human PRs too (approvable by the human for bot-authored work, which is exactly the pairing E3 anticipated). Left as the operator's call rather than changed unilaterally.

---

## 2026-11-01 — wiring `#67` live, and the first self-task that could not succeed

Three-step plan for the PR-comment feedback loop: restart supervisor/adapter from `main` (picks up the `prFeedback` route field), add `issue_comment` to hook `703101252`, then drive a real `/factory` comment end to end. Steps 1–2 succeeded; step 3 exposed two structural defects and one regression of mine.

### The credential that cannot read itself (#87 follow-up, fixed in #98)

The first issue dispatched after `#91` landed faulted in workspace preparation: `GET /user returned HTTP 403`. **An App installation token cannot read `/user`** unless the App holds user read permission, and `drydock-factory` has none — so deriving the commit identity from that endpoint was wrong for exactly the credential this deployment uses. Fourteen unit checks passed because every fake answered `/user` successfully: the test double encoded my assumption instead of GitHub's behaviour.

Fix (#98, merged): keep `GET /user` (correct for PATs) and fall back to app metadata — App slug from `GITHUB_APP_SLUG` or `/app` via the App JWT, then the public `/users/<slug>[bot]` for the numeric id. Boot now logs `commit identity: drydock-factory[bot] <350801583+…@users.noreply.github.com>` so the condition is visible at startup rather than 40 minutes into a run — **warn, not exit**, deliberately unlike the token-exchange check which stays fatal: a transient API failure should not keep the factory down, while a credential that does not work must never be announced as ready. And `gates/github-app-check.mjs` gained a live identity step, because the layer that injects fetches is structurally incapable of catching this class of bug:

```
IDENTITY: GET /user with an installation token -> HTTP 403 (401/403 expected unless the App holds user read)
IDENTITY: commits will be authored by drydock-factory[bot] <350801583+drydock-factory[bot]@users.noreply.github.com>
```

### `issue_comment` intake verified against the live listener (zero inference cost)

Before spending a run, the comment path was probed with signed deliveries through the public HTTPS front. Each refusal happened at the intended layer:

| Probe | Result | Layer proven |
|---|---|---|
| `/factory rebase` naming an unreadable PR | `200 accepted:false` then `refused after state check: cannot read PR #99999 … refusing without verified state` | route accepts comment events → PR state read with the App credential → **no** POST to the instance |
| comment without `/factory` | `200` `comment does not start with /factory` | parse gate, before any state read |
| sender is the App's own bot | `403 sender not allowlisted` | allowlist fires before the bot guard (both are correct; ordering matters for the comment-triggered loop this guard exists to prevent) |
| drydock signature naming another repo | `403 cross-repo naming` | the signature is still per-repo authorization for comment events too |

### A task that could not be completed, discovered by running it (#100, #101)

The replacement issue (README-only change) produced six worker cycles, each ending in:

```
{"refused":true,"reason":"path scope violation — nothing was pushed or reviewed",
 "offenders":[{"file":"package.json","why":"outside this repo's allowlist (…)"}]}
```

Cause: `package.json`'s test script **enumerated every suite by name**, so adding a test required editing a file the allowlist deliberately forbids (`scripts.test` *is* the verification gate — an agent that can edit it can pass the gate by deleting the tests). The task was unsatisfiable by construction; nothing pushed, ~six cycles of inference spent.

Two findings, both recorded as risks above: **R10** — the enumeration had already dropped `test/git-identity.test.mjs` from every CI run (discovery now structural, 177 → 194 checks, guard asserts collection); **R11** — correct controls composed into an infinite retry loop, because a permanent refusal is indistinguishable from a transient failure and there is no budget. Fixes: #102 (glob discovery + guard), #103 (worker is told its scope before working, including "declining for scope reasons is a correct outcome"). Retry budget remains open in #100.

**Process note, kept because it is the interesting part:** the root agent read the refusal five times and re-delegated anyway, reasoning correctly each time ("the worker keeps modifying package.json even though I've explicitly told it not to") about a constraint it could not see and a fix it was never given. Verbose reasoning is not a substitute for a budget, and neither is a substitute for telling the actor its boundary.

### Still open from this session

`/factory` comment on a real factory-authored draft PR (the last unverified half of #67) requires a successful self-run, which requires #102 and #103 merged. Hook `703101252` now subscribes to `issues` + `issue_comment`; supervisor/adapter run from `main` with `prFeedback: true` in the route table.

---

## 2026-11-01 (later) — #107: the retry that was never there

Wiring `/factory` comments live produced an unrelated and more interesting finding. While a self-task ran cleanly end to end (draft PR #106, then a `/factory instruct` comment that added one commit to it), **34 webhook events from the preceding two days had been dropped without trace**.

**Root cause chain.** Two supervisors were alive at once — an earlier `kill -TERM` had targeted the wrong pid and the old process kept running. Each supervisor mints its own per-route instance token and rewrites `fleet/data/routes.json`, so they alternately invalidated each other's adapter; the adapter's drift guard (correctly) refused deliveries during the churn with `503`. The comment above that code explained the recovery: *"GitHub retries the delivery."* It does not. [GitHub's own docs](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) say so twice, and the hook log confirms it — one attempt per refused delivery, then silence forever.

**The lesson generalizes.** A wrong assumption living inside a comment is worse than no comment, because it discourages the next reader from checking. The same week produced two more instances of "the test agreed with me instead of the world" (R10's dropped suite; #98's `/user` 403), and the sweep work added two more: that deliveries endpoint rejects `page=` in favor of `Link` cursors, and delivery ids being 19 digits — past `Number.MAX_SAFE_INTEGER`, so a plain `JSON.parse` silently relocates them and selecting a delivery by id matches nothing. All four are recorded as a standing rule in `AGENTS.md`: **run it once for real before calling API-touching code done.**

**What shipped.** Single-instance lock (`fleet/single-instance.ts`) taken *before* the routes file is written, distinguishing live owner / crashed owner / unparsable garbage — refusing rather than deleting in the last case, because "clear the stale lock automatically" is how this incident would recur. Bounded shutdown (the exit timer was `.unref()`, which is why a supervisor had to be `SIGKILL`ed). And `fleet/redeliver-failed.mjs`: report-only by default, `--apply` to act, `--only <id>` to name what it touches; policy refusals answer 2xx and are recorded `OK`, so replaying something we deliberately rejected is not reachable through this tool. Verified live with an inert `ping` re-drive (GitHub → funnel → adapter → refused as `not an eligible event`) so the proof cost nothing.

**Deliberate non-action.** The 34 failures were reviewed and **not** re-driven: they belong to issues already resolved or closed by hand during the outage window, and bulk redelivery would have dispatched work for dead tickets. Recovery is surgical from here — that is why `--only` exists and why the default is a report.

**Still open:** putting the sweep on a schedule (a cadence decision plus a cron/launchd unit), and ~~explaining why a child handle keeps the loop alive at shutdown — today that is bounded to 3s by a ref'd deadline rather than understood~~.

> **Closed 2026-11-04 (#196/#198).** The premise was wrong: no handle was leaking and nothing kept the loop alive past
> child settlement. The coordinator simply had no way to ask "is there anything left to wait for?", so the 3 s bound
> was paid in full on every shutdown. See the 2026-11-04 entry below for the measurement.


---

## 2026-11-02 — accepting R14: unprotected fixture `main`

The work queue's rank 1 asked for a decision on the two battery fixture repos. The operator's answer was to
**live with no branch protection on their `main`**, so it becomes a recorded risk rather than a task, and the
difference matters: a task implies someone can close it.

**What was verified before writing it down** (not from memory — the record is only worth as much as its evidence):

```console
$ gh api repos/lalanikarim/factory-fixture/branches/main --jq '.protection'
{"enabled":false,"required_status_checks":{"checks":[],"contexts":[],"enforcement_level":"off"}}

$ gh api repos/lalanikarim/factory-fixture/branches/main/protection
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.", …}
$ gh api repos/lalanikarim/factory-fixture/rulesets
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.", …}

$ python3 -c "import json;print(json.load(open('factory/repo-registry.json'))['defaults'])"
{'eligibilityLabel': 'agent', 'autoMerge': True, 'enabled': True}   # fixture entries do not override autoMerge
```

Identical on `factory-fixture-2`. So: protection is genuinely absent, protection is **not obtainable** on the
current plan, and `autoMerge` is inherited `true`.

**Why this is a trade and not an oversight.** The unattended battery depends on auto-merge. Setting
`autoMerge:false` for a repo removes `merge_pr` from that instance's toolset entirely (`factory/main.ts` gates
the tool list on the policy; `orchestratorInstructions`/`intakeToolNames` do the same), so G1, G4 and the #67
rework flow would stop at a draft PR waiting for a human — which is precisely the thing the battery exists to
prove happens without one. The alternative that keeps both properties is a host where rulesets exist, and that
is a plan/organization change, not a code change.

**What bounds the damage.** Fixtures contain throwaway targets written by the factory for the factory; nothing
there is consumed by a deployment, and no real repo's history can be rewritten through them. The residual that
remains after those bounds is *signal* rather than integrity: a bad merge into a fixture can make a gate look
wrong in either direction, which is why fixture hygiene already shows up as harness defects (#145) instead of
incidents.

**Triggers to re-open this row:** a fixture pointed at code that matters; the account gaining rulesets; or a
gate whose claim starting to depend on protection existing (at which point the gate is lying and must be fixed
or moved). Do not answer any of these by flipping `autoMerge:false` in place — that trades an integrity risk for
a silent loss of coverage, which is the worse of the two.

---

## 2026-11-04 — #196: the shutdown defect was a missing early-exit edge, not undrained pipes

**Context.** #110's hang had been bounded rather than understood since 2026-11-01: a ref'd 3 s deadline made shutdown
*finish*, which is not the same as making it *fast*. The #195 probe identified the handle class (a child's stdio pipe)
and #196 was written from that finding with a recipe — "drain-until-deadline instead of unhook-and-go" — on the theory
that the supervisor stopped draining at its deadline and children died blocked on a full pipe.

**What measurement said.** The recipe's mechanism is wrong, and it was wrong before anyone built anything. On an
isolated repro fleet with piped stdio, factory children reached their `SIGTERM` handlers in ~189 ms and the adapter in
~224 ms **with the parent's own pipe unread** — nobody was blocked on draining. The coordinator had no `settled()`
question to ask, so the bound was paid unconditionally.

**Decision.** Ship the diagnosis that measurement supports rather than the one the issue proposed: an early-exit edge
in `fleet/shutdown-coordinator.ts` (`maybeExitEarly()`, gated on an injected `settled()` defaulting to `false` so every
existing caller keeps the old behavior exactly), with the deadline left armed and ref'd as the backstop for a genuinely
hung child (#108/#125 unchanged). The stream-release half of the original recipe still ships, because that failure mode
*does* exist: a writer still blocked at the deadline must get `EPIPE` instead of hanging on a pipe whose reader is gone.
Both edges go through one release seam so teardown happens exactly once.

**Evidence, both sides on the real fleet (file-backed stdout, not the repro harness).**

```console
# old build bdf7e49 — TERM
exit latency: 3248 ms          # matches the PR's pre-fix 3243 ms; nothing was ever leaking

# new build 1c123d2 — TERM
exit latency: 224 ms
[supervisor] all child groups settled — exiting early (deadline was 3000 ms)
factory/main.ts remaining: 0 · listeners on :9700: 0 · routes.json.lock: gone
```

14× faster, and the improvement is *larger* in production than the piped-stdio repro predicted, which is the tell that
pipes were never the cause. Success criterion was met as written (probe reads `clean`, not `bounded`); the number just
came from a different mechanism than the one filed.

**The general rule.** An issue's recipe is a hypothesis written before the measurement. When the fix and the diagnosis
disagree, the fix has to follow the measurement — and the issue text gets corrected rather than quietly satisfied, or
the next person reads "undrained pipes" and goes looking for a drain. Third time this week the recorded diagnosis lost
an argument to a running process (#164's abort placement, #157's phantom reservation, this).

---

## 2026-11-03 — engram#68 (Linux lockfile) fixed upstream; the factory drops its install workaround

**Context.** `lalanikarim/engram`'s workspace-root `package-lock.json` recorded one TypeScript platform variant (`@typescript/typescript-darwin-arm64`). TypeScript 7 resolves its compiler through a platform-specific optional dependency, so on Linux `npm ci` installed no binary and died in `getExePath.js`. That is why the engram repo config ran `setupCommand: "npm ci --ignore-scripts"` and why its CI needed the same flag. Fail-closed setup was correct behavior — it just meant nothing in that repo could be built or tested off a Mac.

**Decision.** Fix upstream instead of keeping the local workaround ([engram#73](https://github.com/lalanikarim/engram/pull/73), merged `ce18106`): regenerate the root lock (zero version changes; 20 platform variants and pruned optionals restored, packages re-hoisted to the workspace root), delete the stale nested `app/package-lock.json`, drop `--ignore-scripts` from CI while adding `npm run build` and turning the platform-coverage diagnostic into a hard failure. Then set drydock's runtime config for engram back to `setupCommand: "npm ci"` (fleet restarted: `/health ok bdf7e49 inference reachable`, three children parented to the supervisor, no quarantine lines).

**Evidence.** Pre-fix `main` reproduced the failure on `node:24-slim`. Post-fix: `npm ci` exit 0 with `prepare → npm run build` actually executing, `npm run test:unit` exit 0 (RESULT 26/0, 58/0, 18/0; config 5/0), and `npm ci` exit 0 on the darwin-arm64 host that generated the lock. The x64 half — which an Apple Silicon container cannot exercise — came from CI on ubuntu-latest printing `platform entries: 20 | linux x64/arm64: …arm64, …x64`.

**The lesson that cost the time.** engram has *two* lockfiles and the complete one was the wrong one: `app/package-lock.json` (pre-workspace, never read by a root-level `npm ci`) carried all 20 variants while the root lock — the file npm actually uses — carried one. Checking "the lockfile" showed a healthy graph while installs kept failing. Two locks over one dependency graph is not redundancy; it is a plausible-looking second source of truth, and stale ones cost more than absent ones.

**Keep this one too.** A `--ignore-scripts` in a setup command is a load-bearing flag with no owner: nothing recorded why it was there, so removing the workaround never gets scheduled. Removing the workaround is part of fixing the defect. (engram's own `Dockerfile` also uses `--ignore-scripts`, deliberately, so the app image skips `prepare` without devDependencies — that one stays; this is not a general "flags bad" rule.)

---

## 2026-11-04 — #168: the default lesson becomes the shape that measured effective, and G5 finds two instrument defects

**Decision.** `LESSON_TEXT` in `gates/g5-traps.mjs` — what arm B receives when no `--lesson-file` is passed — was an
abstract principle. It is now the structure that measured effective: a typed error carrying its own status plus one guard
to define once, written on **value limits** rather than request payloads. The abstract sentence survives at
`test/fixtures/g5/lesson-abstract.md` as a labelled negative control. Option B ("keep it abstract, document the red gate
as intentional") was rejected because it left the battery permanently 8/9 for a reason no artifact stated, and because a
canonical run that is known-in advance to change nothing measures nothing.

**Why mismatched surface stays.** #176 proved transfer with a lesson whose identifiers the worker copied zero of. Making
the default speak the traps' vocabulary would reintroduce the ambiguity between "the rule transferred" and "the worker
matched words", so the mismatch is now asserted by test rather than incidental.

**The re-run failed, and both reasons are instrument problems, not lesson problems.** Fresh pair seeded on the fixture
repo (#86 `PUT /invoices/:id/status` answers 500 + V8 wording for a `null` body; #87 `POST /invoices/batch` accepts
top-level fields its siblings reject by name) — both verified live against a running server before spending the run,
because issue titles outlive their fixes and the two historical pairs are closed precisely because merged arms removed
the defects from `main`.

- **The fixture base was red.** `main` at `9d19c1f` fails 1 of 126: PR #82's handler guard and PR #83's store guard answer
  the same rule with different wording, and #83 asserted its own. Both arms therefore had "make the suite green" as an
  unstated extra requirement and both edited that unrelated assertion. Fixed in [fixture#91](https://github.com/lalanikarim/factory-fixture/pull/91)
  (126/126), with the underlying duplication left open as [fixture#90](https://github.com/lalanikarim/factory-fixture/issues/90)
  rather than silently picking a winner. Two locally-correct merged PRs colliding in the suite is the mechanism; a gate
  run from a red base measures contamination, not agents.
- **The classifier was blind to reuse.** Arm A — with *no* lesson — produced the structurally right fix: declare
  `BATCH_FIELDS`, call the module's existing `rejectUnknownFields` from the batch path, update README. It read as neither
  root fix nor handler patch, because every root-fix signal required something **new** in the diff. That asymmetry always
  lands on the good shape: a repository that already owns the helper can only produce reuse, so G5 would keep reporting
  "no improvement" for improvements it cannot see. `detectsExistingRuleReuse` now counts it (narrowly: an added call to a
  non-declared rule-named function **and** an added/referenced rule set), with the two arms' diffs captured as fixtures
  and an explicit anti-rubber-stamp test.

**Arm B's result stands as recorded, not re-scored:** it copied the inline sibling guard (`throw Object.assign(new Error(…),
{ statusCode: 400 })`) into `setInvoiceStatus` — handler patch, lesson verified present in its prompt from arm B's own
durable store (the entry carries the lessons header and the new text byte-for-byte). Kept as
`test/fixtures/g5/arm-b-handler-patch-issue-86.diff`. Two candidate explanations, both untested: three existing copies of
the exact inline guard outvote one lesson line, and #86's rule is transport-level with no domain function to move it into,
so "put the check beside the rule" has nowhere to land. Neither exonerates the default; both say the next run needs traps
whose root fix has a place to go.

**The general rule.** A measurement that fails twice for instrument reasons has still produced two facts worth more than
the reading it was chasing: **check the base is green before spending an agent run on it**, and **an instrument that can
only see novel code under-credits exactly the fixes a lesson is trying to cause**. Fourth time this week a running
process beat a recorded assumption — the assumption here was mine, written two hours earlier, that the traps I seeded were
sound.

---

## 2026-11-04 — #188: an issue's recorded blocker is a hypothesis, not a fact

**Decision.** Ship approval-block classification by reading the transcript in-task (`TaskRuntime.context()`), rather than
waiting on the upstream surface this issue had been parked behind (`api.pendingApprovals(conversationId)`, which does not
exist and was never needed). The kernel writes the refusal and its key into committed entries; that is how engram's own
`GET /approvals` finds pending approvals. `parseApprovalMarker` is re-exported from `app/src/core.ts`, so nothing crossed a
module boundary to do it.

**Why the wrong blocker survived.** One true sentence — "the reviewer's conversation handle exposes no transcript read", in
`factory/approval-watch.ts` — described `ConversationHandle`, and also described the task-phase handle returned by
`runtime.conversation()`. Nobody checked the third surface. A correct claim about one type hardened into a reason not to
look at another, and the row sat for weeks behind an "upstream" that was really a reading gap on our side.

**What it cost to be sure.** Not the tests — 23 of them pass against entries whose shape I captured from the store, which
proves my assumption about the kernel and nothing else. What proved it was `gates/approval-block-probe.mjs` running the
shipped detection over every real instance store: 5/5 blocked conversations explained, 0 drift, and the two engram tasks
whose only recorded reason was `reviewer never called submit_verdict` (conversations 269, 476) named by key. The probe
exits 2 when the kernel records `code:"blocked"` with no parseable marker — because this module's only dangerous failure is
silently answering "no block" and putting the blaming message back.

**The general rule.** Before accepting "blocked upstream", check whether the data is already in a surface you are allowed
to read. Then, when you ship it: leave a probe that fails loudly if the contract drifts, because a detection that quietly
returns nothing is indistinguishable from a world where nothing is blocked.

**Deviation recorded.** #188 proposed "new outcome status **or** `outcome.result.blocked`". There is no new status:
`TaskOutcome` is a closed union (`completed | failed | aborted`), so the kernel decided, and `failed` is honest — the run
did not complete. What had been dishonest was the message, not the status.

---

## 2026-11-04 — #204: an alarm needs a state for "examined", and attribution has to be able to decline

**Decision.** Two separate mechanisms, deliberately not merged into one clever feature.

1. **Read history back.** The ledger now reads approval markers out of the `entries` table (`readConversationApprovals`)
   and applies them to rows (#204), because #188's detector runs *inside* a task and therefore cannot see rows written
   before it shipped. The rule is asymmetric on purpose: reclassify to `waiting` only when **exactly one** alarming row
   exists in that conversation; otherwise keep the class and append the marker as context, with `attribution` naming
   which branch produced the claim. Markers belong to conversations — entry records carry `toolCallId`/`toolName` and
   nothing tying them to a task id — so "one candidate" is the only inference available, and taking it silently would be
   guessing dressed as data.
2. **Make looking an action.** `--ack <store/table:id> --ack-reason "…"` records a judgment in the state file. An acked
   row stays **counted** (`failing=4 … 4 acknowledged`) and stops alarming; it never rewrites history, needs a reason
   string to be accepted, and is undone by deleting one key. `--reset-watermark` is documented inside the gate's own
   instructions as *not* a substitute: it clears marks for every family, including ones tracked correctly, which makes
   the next real failure look like the one you just dismissed.

**Why the split.** "Alarm until someone looks" was written with an honest intent and no terminal state — looking is not
something you can DO, so four historical rows pinned the watermark from Nov 2 and `lalanikarim_engram/task` never had a
family mark at all. The fix is not a louder alarm; it is a way to finish alarming about a specific row.

**The prediction I got wrong.** This issue said two of the four rows would reclassify automatically. Against a copy of
the real stores: **0 attributed, 4 annotated as context** — all four failing tasks (46, 51, 268, 475) live in conversation
32, and its marker is `dc0fcf59f723` for `open_draft_pr`, unrelated to a reviewer's missing verdict. I had checked "does
this conversation have a marker" and not "is this conversation otherwise quiet". The ambiguity rule declined, which is
the outcome that kept the report honest; what actually unfroze the gate was the ack half.

**Evidence, because a mute button has to be proven not-mute.** After acking the four: `exit 0`, and the state file gained
`"lalanikarim_engram/task": 475`. Then a new failure was inserted into the copy — task 900, `brand new failure after the
acks` — and the gate exited 2 reporting **exactly that one row**, watermark held. A test asserts the ambiguous case is not
blamed on the approval; it exists because production paid for it, not because it was easy to write.

**The general rules.** (a) A prediction about historical data is a claim about data you have not read — run the read
before writing down what the fix will accomplish. (b) Suppressing an alarm is acceptable exactly when it keeps counting
and still fires on anything unseen; prove the second half by manufacturing one, not by arguing it.

---

## 2026-11-04 — G5 printed PASSED on a signal that measured style, not structure

**Decision.** Make `rootFix` location-aware rather than accept the pass: a typed error carrying its own status counts as a root fix only when it is added on a **domain path**. A typed error added at the transport boundary becomes its own reported signal, `boundaryTypedError`, and deliberately counts as neither root fix nor handler patch.

**What triggered it.** The first clean G5 run — green fixture base, symptoms verified against a running server, no shared rule available to wire — finished with arm A reproducing the anti-pattern and arm B producing `class InvalidColumnsError extends Error { this.statusCode = 400 }` plus one reusable guard. The gate printed `EXPERIMENT PASSED`. Reading the diff found the class in `src/server.mjs`, next to the route, with the domain function still throwing `columns.join is not a function` for every other caller. The lesson's claim is that the check belongs *beside the rule*; nothing had moved beside anything.

**Why the detector could not see it.** `rootFix = typedError || sharedRule || domainGuard || ruleReuse`, and `detectsTypedError` scanned all added lines with no notion of file. It answered a style question — "does this diff contain a status-carrying error class?" — under a name that promises structure. Same family as counting "the arm produced a diff" and calling it "the lesson worked".

**The test that keeps the fix from being a lie.** Alongside the two captured diffs (arm A reads `handlerPatch`; arm B reads neither signal), a third asserts **the same class rewritten into the domain path DOES read as a root fix**. Without it, both earlier assertions could be satisfied by a detector that simply ignores typed errors — a green suite proving nothing, which is the failure this repository has now been caught in four times.

**What the run still buys.** The trap design is fixed: baseline reproduced the anti-pattern rather than wiring an existing rule and invalidating the comparison. And a real open question, stated without inflation: arm B's *style* differed from arm A's (typed error + one guard vs inline `Object.assign`), but arms differed in trap as well as lesson — #93 was a value passed through, #94 a list needing parsing — so at n=1 that difference is not attributable. Next clean test needs a twin pair, same shape twice, different parameter names; or the reviewer-side lever, which is the only one downstream code enforces today.

**The rule.** A verdict you have not read belongs to your classifier, not to your experiment. Every signal in this gate now names the file set it read.

---

## 2026-11-04 — #168 measured dead, and the fixture could not have said otherwise

**Decision.** Close #168 on its own pre-registered wording — *prompt-side and review-side guidance both inert as levers; enforce in gates* — retire the queued twin trap pair, and move rule-placement discipline to `gates/fix-pattern.mjs` (#212). Also recorded: an approval-blocked run must not fault a worker for lacking a PR number (#214), and per-file destructive approvals make engram runs attended (evidence on engram#69).

**What triggered it.** The reviewer-side lever shipped in #209 was prompt presence proven, behavior unproven. Four arms ran: `agent/issue-94` (typed error + guard at the route) and `agent/issue-93` (inline `Object.assign` in the handler), each reviewed **with and without** one lesson, delivery proven from the durable store rather than logged as intended.

| arm | lessons | verdict | lesson quoted verbatim |
|---|---|---|---|
| controlA (`issue-94`) | empty | pass | — |
| specimen (`issue-94`) | one | pass | 0 words |
| controlB_nolesson (`issue-93`) | empty | fail | 0 words |
| controlB (`issue-93`) | one | fail | 24-word run ×3 |

Verdicts identical within each pair. Where the diff was genuinely broken, `reviewerPrompt` step 4's pre-existing "fix that addresses a symptom while leaving the root cause intact" instruction did the work with zero lessons — and did it *better*, naming `bucketDays=1e21` where the lesson arm said `4294967296`.

**The confound that mattered more than the result.** The lesson rule is "if the same defect stays reachable from another caller, the issue is NOT satisfied". In `factory-fixture`, `toCsv` and `agingBuckets` each have **exactly one caller — the route**. There is no second caller to be reachable from, so a boundary-only fix genuinely closes every live path; the reviewer applied the criterion, found it unmet in fact ("no other caller can reach the defect, so the guard covers every place the rule applies"), and passed. That verdict is correct *and* uninformative about lessons. The previous session's note — "#93/#94 differed in kind, confounding style with location" — was the same problem observed one level up: it was never about the pair differing, it was that neither trap had two callers. A twin pair of the same design would have produced another expensive non-result.

**The control I got wrong first.** The spec called for "same review, empty lessons" and "`agent/issue-93` with the lesson present". That leaves the informative cell empty: controlB failed *with* a lesson on a diff that is actually broken, which credits nothing to the lesson until you show it also fails without one. It does. A fail on a genuinely defective diff is evidence about the reviewer's competence, not about the intervention — so any experiment whose arms can differ in true-defect-ness needs the no-intervention arm on **the same artifact**.

**Incidental: running the experiment found a shipped defect.** `factory/reviewer.ts`'s jq program was corrupted by an automated edit spliced into the string literal (`dfd13f4`, deployed as `23a3e19`): every review died at SPAWN with `invalid escape sequence "\i"`. 611 tests and strict CI green; latent only because no review had executed since the deploy. Fixed in #211 and asserted against the real `jq` binary.

**The dispatch, which was the point.** Labeling `engram#65` produced **engram PR #74** — first factory-authored change in a second repo, draft, `unit-suite` pass, plus the first production `pr_opened` notification (`message_id=183`), the observation #64 was waiting on. It cost two human approvals (one per new file) and produced one new defect (#214). "Unattended" is false for engram today; the safety properties held throughout because `autoMerge: false` was never the thing being tested.

**The rules.**
- A string that only a *remote* tool interprets (jq, SQL, shell) is invisible to a type checker. Test it against the real interpreter, or assume it is broken.
- Before crediting an intervention with changing an outcome, show the same artifact failing/succeeding without it. Matched pairs, not before/after.
- A measurement instrument must be able to express the property it claims to measure. Traps with one caller cannot measure "reachable from another caller", no matter how the lesson is worded.
- Status documents expire. This file's own readiness verdict said "P0 items 1–4: ~3–4 days" when all four had shipped; a stale-but-once-true line misroutes effort worse than an obvious gap.

## 2026-11-05 — #230: authorization became a host-issued grant, because prose was never going to be a wall

**Decision.** A retry after a wall-budget abort is authorized by **state the model cannot write**, not by a string it can. `POST /factory/intake/reopen` on an issue that owes authorization appends exactly one durable grant; `delegate` spends it (after the concurrency claim succeeds) and records `replanSource:"operator"`. Model-authored `replan` text still unlocks the guard — blocking legitimately re-scoped work was #222's explicit acceptance failure — but is recorded as `replanSource:"model"` and logged as resting on the sentence alone. Grants are never issued for an issue with no prior abort, never for a **stopped** one, and buy one attempt each. What shipped deliberately does **not** include judging whether a claimed change is real; that residue is #238.

**What triggered it.** Ninety seconds after the reopen verb (#229) deployed, my own reopen reason — "slice reduced to assertion 4 only" — was injected into a fresh conversation as authoritative operator context and returned as the model's claim that the scope reduction *had happened*. It had not. #222's guard accepted it because the rule is "non-empty string", and `delegate` emitted one log line for that event indistinguishable from the line for a human authorizing a retry.

**The invariant I refined instead of deleting.** `test/intake-reopen.test.mjs` asserted reopen touches `BudgetLedgerDoc` **not at all**. That was a proxy for "a reopen cannot restore budget"; #230 legitimately needs an authorization field in the same document. The assertion now pins the counters themselves (`budgetAborts`, `operatorAborts`, `stopped`, byte-for-byte) while allowing `grants` to append, and the opposite direction got its own test (fresh issue ⇒ **zero** writes to that document), so the refinement cannot decay into "writes anything". A test that forbids the wrong thing gets deleted the first time it is inconvenient; one that forbids the right thing gets refined, in the open.

**The rules.**
- Provenance is the minimum honest control when a guard cannot judge truth. It converts "the system was fooled" into "the system recorded that nobody authorized this", which is auditable and does not pretend to be a wall.
- An authorization must cost something: one attempt per grant, consumed on use, never consumed by a call that was refused for an unrelated reason.
- A non-vacuity test belongs on the *observable* channel, not just the state: strip digits from both authorization log lines and assert they differ. "#230 changed nothing observable" is exactly the outcome that otherwise passes.
- Mutation-test your own guard before calling it coverage. Three mutations (provenance collapse to `model`, grants never marked spent, guard removed) each produced named failures — with `cp` restores, after `git checkout <file>` destroyed a day's work while reverting a mutation.

## 2026-11-05 — #220: deploy verification is one command, because I ran a gate that does not exist and it exited 0

**Decision.** "Deployed and verified" now means `node --experimental-strip-types fleet/verify-deploy-posture.mjs` printed seven rows with observed values and exited 0 (#237), plus `gates/deploy-posture.mjs` for policy-vs-disk drift (#236). Exit **2** is reserved for "could not run" and is never folded into pass/fail. Sub-gates are consumed by their **collection line**, not their exit code: a gate that exits 0 without stating what it inspected is a FAIL. The manual commands stay in the checklist as the fallback path and as what to read when a row is red.

**What triggered it.** While deploying #230 I ran `gates/gate-posture.mjs` — a filename I had invented, never present in this repository — through `… 2>&1 | tail -2`. Node printed `MODULE_NOT_FOUND`; the step exited **0**, because the pipe reported `tail`'s status; and I wrote "posture verified" into a PR. Both traps were already documented in this repo (the pipe-exit-code note in `runbook-aborts.md`, and R6b/R10 on "not collected" vs "passing") and I reproduced them within the hour of writing about them.

**What the new command found while being built.** Its first live run had three red rows: one **true** (fleet on `9b3a123` against a `9cade1c` checkout — the exact skew the issue names, which I had been eyeballing on every deploy for a week), and two bugs in the command itself: splitting the boot line on `,` mangled `edit(edits[].path,path)` into two tools and leaked `nothing scanned` from `submit_verdict(nothing scanned)`; and a too-permissive sub-gate summarizer that accepted exit 0 with no evidence of collection. Neither was relaxed to reach green.

**The rules.**
- A verification step must name a file that exists, and should be the only way to perform that check. A habit has no failure mode; a command does. This is the same lesson as eng#78 (nine suites no job ran) seen from the operator's side.
- Never take an exit code through a pipe. `set -o pipefail`, or check `$?` before piping.
- Consume another program's verdict only if it states what it inspected, and match that statement **explicitly** — a generic "contains a digit" heuristic is how a checker starts believing itself.
- An entry guard must survive path resolution: `import.meta.url === pathToFileURL(process.argv[1]).href` silently no-ops through symlinked paths (macOS `/var` → `/private/var`) — exit 0, zero output. Realpath both sides.
