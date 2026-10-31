# Work queue — 2026-10-31

Derived from `decision-log.md` (questionnaire answers) under the stated north star: **close every in-flight item and reach a production-ready posture as fast as possible.** IDs reference decisions that justify each row.

Owner: 🤖 = buildable now, no input needed · 🧑 = needs you (credential, click, or merge) · 🤖🧑 = I prepare, you execute the last step.

## Phase 1 — make publishing safe (A3 gates everything on this)

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| 1 | **#69 stale routes — implemented (this PR).** Supervisor writes routes before spawning (atomic temp+rename, always overwrite); adapter re-hashes per request; drift → 503 + audited refusal + exit for supervisor restart. Unit tests + live E2E (old-secret-signed request after a secret rotation: 503 with both hashes, process exited) | 🤖 | — | A fleet edit cannot be validated against stale policy even accidentally — verified live |
| 2 | **#70 credential posture — implemented (this PR).** `factory/credential-source.ts` resolves env → config → host helper → none; boot logs the path, `WARNING … ACCOUNT-WIDE` for the fallback. Live-verified on this machine's real configuration | 🤖 | — | Startup output answers "which token is this?" without external inspection |
| 3 | **Cut one fine-grained PAT** scoped to the managed repos (`contents:write`, `pull_requests:write`, `issues:read`); set `FACTORY_GITHUB_TOKEN`; confirm no run still depends on the keychain entry (B1) | 🧑 | 2 | Factory runs with a scoped token; account-wide credential no longer in the path |
| 4 | **#61 verification evidence — implemented (this PR).** `factory/verification.ts` runs the repo's command host-side before review, records command + exit code, and refuses the push on non-zero/timeout/zero-tests. Escape hatch: registry `requireVerification: false` (no checked-in repo uses it; test asserts that), which still cannot push a red run | 🤖 | — | A draft PR cannot exist without recorded verification; §5.16's failure mode is impossible — proven against a scratch repo where origin's tip is verified untouched |
| 5 | **E1 allowlist.** Add `README.md` (+ `AGENTS.md`, or move it to `protectedPaths` — see R2) to drydock's `pathAllowlist`; update registry tests for the widened set | 🤖🧑 | your call on `AGENTS.md` | Self-work can document itself; protected-path invariants still hold |
| 6 | **Publish.** Funnel in front of the laptop listener, register the webhook with the existing secret, smoke-test a real issue by adding the `build` label, verify signature + sender allowlist + exactly-once under redelivery (A1, A2, A4) | 🤖🧑 | 1–3 | One label→draft-PR cycle over the public listener, end to end, with logs |

## Phase 2 — finish in-flight evidence

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| 7 | **fixture-1 #45** (`?sort=amountCents`) through G2/G4 (D3) — the last live target in either fixture; produces a draft PR for you to merge | 🤖🧑 | aurora available (confirmed) | Merged, `agent` label removed, `probe:list-sort-amount` retained as a regression oracle |
| 8 | **#62 closed 2026-10-31.** CI landed and runs on push to `main` + every PR (unit suite + kernel pin check); closing comment cites the re-decision and the day-one failure CI caught that local missed. **Remaining: operator adds `unit-suite` as a required status check on `main`** — until then it reports but does not block | 🧑 | done (merge) | Check appears green on every draft PR and blocks merges when red |
| 9 | **#41 upstream PR** against engram for the two destructive-guard narrowings (interpreter heads, `/dev` redirection drop); link from drydock #41 / engram#63 (D4). No pin change until it lands and passes the battery | 🤖 | — | Upstream PR open with our characterization test as evidence |
| 10 | **§3.9 T1 partial-run recovery**: preserve branch, mark resumable, requeue once with the diff as context (C4) | 🤖 | 4 | A budget-aborted run leaves recoverable work and one automatic resume attempt, tested |
| 11 | **E4 token annotation**: attach per-task spend to task outcomes from `pi.usage` (§5.17 reader), warn-only against a soft threshold; no abort | 🤖 | — | Every run reports tokens without anyone reading a store by hand |

## Phase 3 — ranked capabilities (D1)

| # | Item | Owner | Notes |
|---|---|---|---|
| 12 | **#67 PR-comment feedback loop** — rebase, conflict resolution, free-form instructions from PR comments | 🤖 | Formalizes the §5.16 rework, which is the shape most self-work takes. Must reuse byte-scoped approvals (#47), not bypass them |
| 13 | **#65 issue triage/expansion label** — research + refine an issue before it is actionable | 🤖 | Highest-leverage quality change available: improves worker input rather than output |
| 14 | **#68 GitHub App identity** — app-authored PRs; then revisit E3 (required reviews) as you noted | 🤖🧑 | You create the App + installation; I do the token exchange and wiring. Supersedes B1's PAT for authorship |

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
