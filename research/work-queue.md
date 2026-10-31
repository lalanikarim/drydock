# Work queue — 2026-10-31

Derived from `decision-log.md` (questionnaire answers) under the stated north star: **close every in-flight item and reach a production-ready posture as fast as possible.** IDs reference decisions that justify each row.

Owner: 🤖 = buildable now, no input needed · 🧑 = needs you (credential, click, or merge) · 🤖🧑 = I prepare, you execute the last step.

## Phase 1 — make publishing safe (A3 gates everything on this)

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| 1 | **#69 stale routes — implemented (this PR).** Supervisor writes routes before spawning (atomic temp+rename, always overwrite); adapter re-hashes per request; drift → 503 + audited refusal + exit for supervisor restart. Unit tests + live E2E (old-secret-signed request after a secret rotation: 503 with both hashes, process exited) | 🤖 | — | A fleet edit cannot be validated against stale policy even accidentally — verified live |
| 2 | **#70 credential posture — implemented (this PR).** `factory/credential-source.ts` resolves env → config → host helper → none; boot logs the path, `WARNING … ACCOUNT-WIDE` for the fallback. Live-verified on this machine's real configuration | 🤖 | — | Startup output answers "which token is this?" without external inspection |
| 3a | **App installation narrowed 2026-10-31**: `repository_selection: selected`, reach down from 172 repos to **6** (2 private), all three managed repos present, write still proven by a reversible ref probe after the change | 🧑 (done) | — | Done: probe reports an explicit list instead of `all` |
| 3a-ii ⏸ | **Deferred 2026-10-31** (operator): the 3 reachable-but-unmanaged repos stay installed because **engram is intended to join the factory as a managed repo**, so the reach is forward-looking rather than stray permission. Tracked in #78. Condition carried forward: when engram goes live, protect its `main` *before* the first dispatch there — today it has no branch protection at all, so the leaked-key blast radius includes the vendored kernel's default branch | 🧑 | engram onboarding | Either the probe prints “Reach matches policy exactly”, or engram is listed in the registry *and* protected |
| ~~3b~~ ✅ | **R8 CLOSED — App auth implemented.** `factory/github-auth.ts` mints the JWT and exchanges it for an installation token via a **refreshing provider** (tokens expire ~hourly and cannot be renewed; concurrent callers share one in-flight exchange because GitHub revokes the oldest past ~10). Threaded through worker / reviewer / `open_draft_pr` / merge-gate, so every host-side call resolves a current token. `credential-source.ts` is now the single resolver for both the boot log and the credential (precedence env → App → config → helper → none; partial App config throws rather than falling back to keychain). Boot verifies the exchange and refuses ready if it fails | 🤖 | 2 | ✅ Boot logs `git credential: GitHub App 5557270 (installation 177271737)`; live reads 200 on all three managed repos; 13 checks in `test/github-app-auth.test.mjs` |
| 4 | **#61 verification evidence — implemented (this PR).** `factory/verification.ts` runs the repo's command host-side before review, records command + exit code, and refuses the push on non-zero/timeout/zero-tests. Escape hatch: registry `requireVerification: false` (no checked-in repo uses it; test asserts that), which still cannot push a red run | 🤖 | — | A draft PR cannot exist without recorded verification; §5.16's failure mode is impossible — proven against a scratch repo where origin's tip is verified untouched |
| ~~5~~ ✅ | **E1 allowlist — DONE.** `README.md` and `AGENTS.md` added to drydock's `pathAllowlist`; operator chose self-writable over `protectedPaths` for `AGENTS.md` (R2 accepted, see decision-log E1) | 🤖🧑 | done | Self-work can document itself; capability files (`vendor/`, manifests, CI config, `gates/`) still refused — pinned in `test/path-scope.test.mjs` |
| ~~6~~ ✅ | **Publish — DONE 2026-10-31.** Supervisor + adapter on loopback behind a public HTTPS front, existing hook `703101252` realigned to the env secret, one real issue driven by label: #80 → draft PR **#83 authored by `app/drydock-factory`**. Signature/sender/cross-repo refusals probed live; replaying the delivery started no second worker. Publishing also surfaced three defects (supervisor `.env` not loaded → PR #82; #80 spurious model warning → fixed in #83; #81 drift-on-cold-start → open) | 🤖🧑 | done | Evidence table in `fleet/enable-self-work.md` §5 |

## Phase 2 — finish in-flight evidence

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| 7 | **fixture-1 #45** (`?sort=amountCents`) through G2/G4 (D3) — the last live target in either fixture; produces a draft PR for you to merge | 🤖🧑 | aurora available (confirmed) | Merged, `agent` label removed, `probe:list-sort-amount` retained as a regression oracle |
| 8 | **#62 closed + `unit-suite` made required 2026-10-31** via `gh api -X PUT …/branches/main/protection`: required checks `[{context: unit-suite, app_id: 15368}]`, `strict: true`, and every pre-existing setting preserved (0 approving reviews, enforce_admins on, force-push off, deletion off). Side effect worth knowing: direct pushes to `main` are now refused for admins too — everything goes through a PR | 🧑 (done) | done | Done: the check blocks merges when red |
| 8b | **Consider requiring the check on fixture repos too** — they are private (Actions minutes still free at this volume) and currently have no protection at all; their runs auto-merge today via `autoMerge: true` | 🧑 | — | Either protected or explicitly accepted as disposable |
| 9 | **#41 upstream PR** against engram for the two destructive-guard narrowings (interpreter heads, `/dev` redirection drop); link from drydock #41 / engram#63 (D4). No pin change until it lands and passes the battery | 🤖 | — | Upstream PR open with our characterization test as evidence |
| 10 | **§3.9 T1 partial-run recovery**: preserve branch, mark resumable, requeue once with the diff as context (C4) | 🤖 | 4 | A budget-aborted run leaves recoverable work and one automatic resume attempt, tested |
| 11 | **E4 token annotation**: attach per-task spend to task outcomes from `pi.usage` (§5.17 reader), warn-only against a soft threshold; no abort | 🤖 | — | Every run reports tokens without anyone reading a store by hand |

## Phase 3 — ranked capabilities (D1)

| # | Item | Owner | Notes |
|---|---|---|---|
| 12 | **#67 PR-comment feedback loop** — rebase, conflict resolution, free-form instructions from PR comments | 🤖 | Formalizes the §5.16 rework, which is the shape most self-work takes. Must reuse byte-scoped approvals (#47), not bypass them |
| 13 | **#65 issue triage/expansion label** — research + refine an issue before it is actionable | 🤖 | Highest-leverage quality change available: improves worker input rather than output |
| 14 | **#68 GitHub App identity** — App created, installed, permission-verified, and now **consumed by the code** (3b done). What remains: confirm PRs are actually **authored by `drydock-factory`** on the first factory-created PR, then revisit E3 (required reviews) now that authorship distinguishes factory work from human work | 🤖🧑 | 3b ✅ | A draft PR's author is the App, not `lalanikarim`; E3 re-decided in light of it |

## Phase 4 — documentation-only

| # | Item | Owner | Done when |
|---|---|---|---|
| 15 | **Target 2 design doc** (#42, D2): client-only federation, no collective dependency; decision rule for when to fund it | 🤖 | A doc exists; #42 either scheduled or closed with a reason |
| 16 | **Release checklist** encoding C5 (full battery before pin bump / posture change) + the restart step until #69 ships | 🤖 | One page, referenced from the runbook |

## Production posture snapshot (what "ready" means as of these decisions)

| Control | Status |
|---|---|
| Merges are human-only | ✅ enforced by capability removal (`merge_pr` absent), not convention |
| Approvals name a commit | ✅ #47, byte-scoped; parents verified after merge |
| Change scope limited | ✅ path allowlist + unconditional `vendor/` protection; `gates/` out of scope, `gates/probes/` protected |
| Intake hardening | ✅ 1 MiB cap with header-only refusal, liveness-only `/health`, HMAC + sender allowlist |
| Independent review before push | ✅ reviewer runs pre-push; fail = no push |
| Verification evidence on PRs | ⏳ Phase 1 item 4 — and it is the CI substitute (R1) |
| Credential scoping | ⏳ Phase 1 items 2–3 (currently account-wide via keychain) |
| External test re-run after draft | ✅ CI on every push/PR (C2-rev); advisory until `unit-suite` is made a required check (R1 residual) |
| Required approving reviews | 0, by decision (E3), revisit with #68 |
| Host | Laptop (A2) — sleep/IP/credential consequences accepted |
| Secrets | `.env`, gitignored (A4) |

## Explicitly not queued

Scheduled full-battery runs (C5 says per-release, and the host is a laptop) · GitHub Actions of any kind (C2) · `autoMerge` anywhere (E2) · Target 2 implementation (D2) · deleting the POC-era local branch (F1 did not select it).

## Follow-ups created by publishing (2026-10-31)

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| P1 | Review and merge #83 (first App-authored PR; reviewer flagged an out-of-scope `factory/verification.ts` change to look at) | 🧑 | — | merged or sent back with review comments |
| P2 | Decide whether the public listener stays published between self-work bursts or is torn down (`tailscale serve reset`) and restored per burst | 🧑 | — | stated posture, reflected in the runbook |
| ~~P3~~ ✅ | #81 — routes-drift classified: `target` is runtime state (adopted in place, both hashes logged), policy fields stay hard drift; unparsable files never benign | 🤖 | — | ✅ cold start served with **one** adapter attempt and a 200 on first delivery; 7 new checks incl. cold-start integration + non-vacuity proof |
| P4 | R9 — path scope cannot express intent: consider requiring an issue to name the files it expects to change, or per-task allowlists | 🧑🤖 | P1 (evidence) | decision recorded, then implemented or explicitly deferred |
| ~~P5~~ ✅ | **E3 decided and implemented:** 1 approving review required, repo admin may bypass (ruleset `main-review-gate-admin-bypass`); `unit-suite` stays strict-required for admins via classic protection. Posture table + undo commands in the runbook | 🧑 | — | ✅ ruleset 26288740 active; CI unchanged |
