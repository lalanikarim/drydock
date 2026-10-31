# Work queue — 2026-10-31

Derived from `decision-log.md` (questionnaire answers) under the stated north star: **close every in-flight item and reach a production-ready posture as fast as possible.** IDs reference decisions that justify each row.

Owner: 🤖 = buildable now, no input needed · 🧑 = needs you (credential, click, or merge) · 🤖🧑 = I prepare, you execute the last step.

## Phase 1 — make publishing safe (A3 gates everything on this)

| # | Item | Owner | Depends on | Done when |
|---|---|---|---|---|
| 1 | **#69 stale routes — implemented (this PR).** Supervisor writes routes before spawning (atomic temp+rename, always overwrite); adapter re-hashes per request; drift → 503 + audited refusal + exit for supervisor restart. Unit tests + live E2E (old-secret-signed request after a secret rotation: 503 with both hashes, process exited) | 🤖 | — | A fleet edit cannot be validated against stale policy even accidentally — verified live |
| 2 | **#70 credential posture — implemented (this PR).** `factory/credential-source.ts` resolves env → config → host helper → none; boot logs the path, `WARNING … ACCOUNT-WIDE` for the fallback. Live-verified on this machine's real configuration | 🤖 | — | Startup output answers "which token is this?" without external inspection |
| 3a | **App installation narrowed 2026-10-31**: `repository_selection: selected`, reach down from 172 repos to **6** (2 private), all three managed repos present, write still proven by a reversible ref probe after the change | 🧑 (done) | — | Done: probe reports an explicit list instead of `all` |
| 3a-ii | **Decide the 3 reachable-but-unmanaged repos**: drop `engram`, `collective`, `modelarena` from the installation — or keep `engram` deliberately (upstream PRs, queue item 9) and **protect its `main`**, which currently has no branch protection so the App could push the kernel's default branch. Routes stay closed either way; this is leaked-key blast radius | 🧑 | — | Probe prints “Reach matches policy exactly”, or engram is intentionally listed *and* protected |
| 3b | **R8: configured ≠ consumed.** Implement App-based auth in the factory (was "cut a PAT", was "#68 later"): mint JWT from `GITHUB_APP_PRIVATE_KEY_PATH`, exchange for an installation token, use it for clone/push/PR creation; extend `factory/credential-source.ts` with an `app` kind so boot names it; keep the #70 warning for every non-App path. No code reads `GITHUB_APP_*` today — runs still fall back to keychain | 🤖 | 2 | Boot logs `git credential: GitHub App drydock-factory (installation …)` and no run depends on the host keychain |
| 4 | **#61 verification evidence — implemented (this PR).** `factory/verification.ts` runs the repo's command host-side before review, records command + exit code, and refuses the push on non-zero/timeout/zero-tests. Escape hatch: registry `requireVerification: false` (no checked-in repo uses it; test asserts that), which still cannot push a red run | 🤖 | — | A draft PR cannot exist without recorded verification; §5.16's failure mode is impossible — proven against a scratch repo where origin's tip is verified untouched |
| 5 | **E1 allowlist.** Add `README.md` (+ `AGENTS.md`, or move it to `protectedPaths` — see R2) to drydock's `pathAllowlist`; update registry tests for the widened set | 🤖🧑 | your call on `AGENTS.md` | Self-work can document itself; protected-path invariants still hold |
| 6 | **Publish.** Funnel in front of the laptop listener, register the webhook with the existing secret, smoke-test a real issue by adding the `build` label, verify signature + sender allowlist + exactly-once under redelivery (A1, A2, A4) | 🤖🧑 | 1–3b, 5 | One label→draft-PR cycle over the public listener, end to end, with logs |

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
| 14 | **#68 GitHub App identity** — App is created, installed and permission-verified (2026-10-31); the credential half is queue item 3b. What remains here: confirm PRs are actually **authored by `drydock-factory`** on the first app run, then revisit E3 (required reviews) now that authorship distinguishes factory work from human work | 🤖🧑 | 3b | A draft PR's author is the App, not `lalanikarim`; E3 re-decided in light of it |

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
