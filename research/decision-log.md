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

### R1 — risk: no CI + zero required reviews · **open**

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
| R1 | ~~No CI~~ and 0 required approving reviews: nothing *required* re-runs tests after a draft PR exists | C2-rev + E3 | **Mostly closed by C2-rev**: CI runs on every draft PR head. Residual gap until the operator makes `unit-suite` a required status check (advisory today); C1 still covers the pre-push path |
| R2 | Self-work can edit `AGENTS.md`, the file that constrains it | E1 (accepted 2026-10-31) | Accepted deliberately: the file is advisory, enforcement reads the registry at process start, and a merged edit only takes effect through a human merge. Residual risk is guidance erosion caught by review/CI, not path scope |
| R3 | Public listener (Funnel) on a laptop holding an account-wide credential | A1 + A2 | Was "B1 PAT first"; now **B1-rev: App-based credential wired into the code before publishing** (queue item 3b), since the keychain fallback is exactly what the warning in #70 describes. Funnel URL is revocable; `allowedSenders` stays on |
| R7 | ~~App installation reach is all 172 account repos~~ → **residual: 3 reachable-but-unmanaged repos** (`engram`, `collective`, `modelarena`), one of which is the vendored kernel | B1-rev after narrowing to `selected` (6 repos, 2 private) | Account-wide exposure closed 2026-10-31. Residual: drop those three from the installation, **or** keep `engram` deliberately for upstream PRs (queue item 9) and protect its `main` — it currently has no branch protection at all, so the App could push the kernel's default branch with routes never involved. `gates/github-app-check.mjs` diffs reach against the registry and says this out loud on every run |
| R8 | ~~App credential configured but not consumed~~ — **CLOSED**: `factory/github-auth.ts` resolves and uses it; boot verifies the exchange before ready | closed by queue 3b | Boot prints `git credential: GitHub App 5557270 (installation 177271737)` + `installation token exchange verified`; the keychain warning is gone from this path |
| R4 | ~~Stale policy accepted between fleet change and restart~~ | **#69 closed** (this PR) | Supervisor writes fresh routes before spawn (atomic, always overwrite); adapter re-hashes per request and exits on drift. Residual: fleet-file changes still need a supervisor restart (fleet is read once at start) — documented in the runbook |
| R5 | ~~Re-verification of a draft PR after rework relies on the same worker-run command~~ | **closed** by C1 + C2-rev | Verification now runs host-side at push time (not inside the worker's sandbox), and CI runs the same suite on the resulting PR head independently of the factory. Byte-scoped approval (#47) means an approval names the commit that was tested |
| R6 | Two latent fail-open coercions found while implementing C1 — both now fixed, kept here as the lesson | registry validation | (a) `Boolean("false") === true`, so a JSON typo like `"autoMerge": "false"` would have **granted** merge rights; safety flags are now type-checked. (b) A nested `node --test` inheriting `NODE_TEST_CONTEXT` skips every file and exits 0 — a green verification with zero tests behind it; the child env is stripped and zero collected tests is treated as failure. Both were found by testing, not review: suspect this class of bug in any flag coerced with `Boolean()` or any gate that trusts an exit code alone |

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

