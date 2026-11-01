# Multi-Repo Factory Plan — Target 1 (N factories) spec, Target 2 as follow-up

_Date: 2026-10-26 · Status: signed off — Phase 0 done (PR #31), Phase 1 in flight (`feature/phase1-factory-core`)_
_Companions: [`poc-plan-factory.md`](poc-plan-factory.md) (completed PoC, G0–G5 + Phase 6), [`pi-durable-feasibility.md`](pi-durable-feasibility.md) (feasibility assessment). The single-repo factory this extends is fully built and measured: issue → sandboxed worker → independent review → evidence on the PR → approval-gated exactly-once merge → verified feedback loop, at 129–433s and ~81–145K tokens per bounded issue on one local GPU (plan doc §1g)._

## 1. Goal & non-goals

**Goal.** Manage **multiple repositories simultaneously** with the validated single-repo factory: each repo gets the full loop (webhook intake → worker → review → evidence → human-approved merge), independently supervised, sharing one inference endpoint.

**Non-goals (this phase):** cross-repo orchestration by a single orchestrator (Target 2, §4), HA/failover, Postgres-backed storage, parallel workers *within* a repo, browser/email/MCP. These carry over from the PoC plan's non-goals unchanged.

## 2. The two targets (decision context)

| | **Target 1 — N factories** | **Target 2 — one orchestrator, M repos** |
|---|---|---|
| Shape | One factory process per repo, running simultaneously; shared webhook adapter routes by repo | One factory process whose orchestrator knows all managed repos and can sequence work across them |
| Onboarding a repo | config + image + process + webhook route (~1h) | config entry + webhook secret only |
| Failure isolation | Per-repo: one stuck repo never blocks another | Shared queue: one stuck repo can head-of-line-block the rest (until governed) |
| Cross-repo work | **Human is the coordinator** — files/sequences issues in each repo; factories stay single-minded | Orchestrator sequences cross-repo chains itself; human reviews linked PRs |
| Blast radius of a bad run | One repo's factory | All managed repos' orchestration |
| Human checkpoint | Per-PR approval (unchanged) | Per-PR approval (unchanged — Target 2 automates sequencing, never approval) |

**Decision:** build Target 1 now. It reuses every validated gate with zero core changes, keeps the orchestrator single-repo (the exact condition under which G0–G5 passed on a local 27B), and its artifacts (config files, adapter map, budgets) are the same shapes Target 2 aggregates later. Target 2 is specified as a follow-up (§4) with an explicit decision rule for funding it.

## 3. Target 1 specification

### 3.1 Per-repo config file

*Status: implemented — `poc/lib/factory-config.mjs` + `poc/config/`, with legacy env fallback during transition.*

One validated JSON file per managed repo (factory-side, not in the target repo), e.g. `poc/config/<repo>.json`:

```json
{
  "repo": "owner/name",
  "sandboxImage": "factory-sandbox-node:latest",
  "setupCommand": "npm ci",                  // host-defined; runs in a sealed setup phase, §3.6
  "testCommand": "node --test",              // see open decision D1
  "gitToken": "${FACTORY_GIT_TOKEN_OWNER}",  // per-repo, minimal scopes (§3.5)
  "budgets": { "wallSecsPerIssue": 1800, "maxReviewRetries": 2 },
  "lessonsFile": "data/lessons-owner-name.md"
}
```

- **Validated at factory startup** (schema + fail-fast); env vars remain as overrides for the existing single-repo wiring during transition.
- Host concerns (image, setup, budgets, token) live here; repo *knowledge* (test command) is the candidate for in-repo declaration — open decision D1.
- Stale-config risk is loud, not silent: a wrong `testCommand` fails the host-verified suite and the review gate.

### 3.2 Webhook adapter routing (per-repo secrets)

*Status: implemented — `poc/lib/adapter.mjs` + routes mode in `poc/lib/intake.mjs`; G0 extended to 20/20 (M3 cross-repo rejection + sender allowlist).*

Extends the signature verification landed in the webhook PR (`poc/lib/intake.mjs`):

- Adapter holds a **`repo full_name → { secret, /tasks target }` map** (from its own config), one entry per managed repo.
- Verification stays **pre-parse**: the raw body is HMAC-checked against each configured secret in constant time; the matching secret identifies both authenticity *and* routing — signature validity doubles as per-repo authorization. An event signed with repo A's secret but naming repo B is rejected (403 + audit line), so a leaked per-repo secret cannot forge submissions into another factory.
- Secrets remain **per-repo, never global** (design decision already recorded in `poc/README.md`); org-level webhooks are deliberately avoided.
- **Sender allowlist:** signature validity proves GitHub sent the event, not who acted. Each route may declare `allowedSenders: [logins]`; non-matching `sender.login` is rejected 403 + audit line (checked post-signature, so the field is trusted). This gates both issue creation and label triage.
- `requestId = "issue-<n>"` stays as-is: each factory has its own durable namespace, so no cross-repo collisions.

### 3.3 Process model & supervision

*Status: implemented — `poc/supervise.mjs` (fleet file, restart-on-fault, status table); examples in `poc/fleet.example.json` / `poc/routes.example.json`; approval TTL auto-deny in `poc/lib/merge-gate.mjs` (2026-10-26).*

- **One factory process per repo** — the existing `lib/factory.mjs` needs no core changes; each instance gets its own port, sqlite db, lessons file, and config from §3.1.
- Supervision via compose/systemd: one unit per factory + one adapter unit; restart-on-fault (the durable harness already recovers in-process state from its db — crash-durability is the PoC's core property).
- **Status aggregation**: a small read-only script/endpoint that fans out to each factory's `/health`, `/approvals`, and `/tool-results` and prints one table: repo, current issue, state (working / awaiting approval / stuck), wall time so far. This is the operator dashboard for Target 1.
- **Approval expiry (TTL auto-deny)**: a pending merge approval no longer blocks a factory's single concurrency slot forever. `GET /approvals` resolves pending records against `approvalTtlHours` (per-repo config, §3.1; default **24 h**): expired records are durably auto-denied with `decidedBy: "ttl"` (idempotent, re-checked under concurrent decisions), and the `merge_pr` retry path reports EXPIRED so the orchestrator knows a fresh human approval is needed rather than looping. Records created before the field existed get their clock stamped on first observation. Pattern from engram approvals phase 3; decision logic unit-tested in `test/merge-gate-ttl.test.mjs`.

### 3.4 Shared-resource governance (the one new design problem)

*Status: implemented — `awaitIdleWithinBudget` in `poc/lib/factory-worker.mjs`, enforced in both worker and reviewer wait phases from `budgets.wallSecsPerIssue`; live-verified with a 5s budget (clean abort, partial branch preserved, no PR opened).*

All factories share one inference endpoint (Aurora/llama-server on the RTX 4090). Today there is no queueing or budgeting anywhere; a trap issue on repo A (issue #4 showed ~30 min of dead-ends in dev runs) would silently starve B and C.

- **Per-issue wall-clock budget** (`budgets.wallSecsPerIssue`): enforced host-side in the worker's and reviewer's wait phases — on overrun the conversation is aborted cleanly (`ConversationHandle.abort`), the sandbox is torn down, the partial branch stays on disk for the stale-branch rework path, and the overrun is recorded in the task outcome (surfaced to the orchestrator as a `delegate` error) plus an audit log line. This bounds worst-case starvation per issue.
- **Per-factory concurrency stays 1** (already true: one root conversation processes submissions sequentially). With N factories, total concurrent GPU demand is bounded by N; admission control beyond that is out of scope for the pilot.
- **Honest limit:** budgets cap the damage; they are not fair-share scheduling. If measured contention becomes a problem (Phase 6 instrumentation already extracts per-run tokens/wall time — extend `07-measurement.mjs` to aggregate across factories), revisit with a real queue.

### 3.5 Credential scoping

- Per-repo GitHub tokens in the config (§3.1), minimal scopes (`repo` for the managed repo only; no org-wide token).
- One leaked token compromises one repo's factory, matching the webhook-secret blast-radius decision (§3.2).

### 3.6 Sandbox images & dependency install

*Status: implemented — `poc/lib/setup-sandbox.mjs`, wired into both worker and reviewer spawn phases; image/mount-root allowlist in `poc/lib/sandbox-health.mjs` (2026-10-26).*

Default strategy: **ephemeral setup phase** — a one-shot disposable container runs the host-defined `setupCommand` (e.g. `npm ci`) with egress, then exits; the long-lived agent sandbox is created sealed (`network=none`). Dependency state persists via the host-mounted workspace volume, so the agent never runs in a networked container and the setup command comes from factory-side config, never repo content. Runs are idempotent (re-run on task resume) and fail closed before the agent conversation starts. Optimization (later): per-repo prebuilt images with deps baked in.

**Containment last line — sandbox allowlist** (pattern from engram phase 7): every container the factory spawns (setup, worker, reviewer — including supervised recreation) is validated against a **factory-level policy** before any podman call: the base image must be on `SANDBOX_ALLOW_IMAGES` (comma-separated env; default `factory-sandbox:latest`) and the workspace must live under `SANDBOX_MOUNT_ROOT` (default: the factory's work dir). The policy is deliberately **not** per-repo config — a repo entry may select from the allowlist but can never widen it, so a stale or compromised `<repo>.json` fails fast with a clear message instead of spawning an arbitrary container. Unit-tested in `test/sandbox-allowlist.test.mjs` (incl. mount-root prefix-trickery).

### 3.7 Gates & acceptance criteria

| Gate | Check |
|---|---|
| **M1 — two repos live** | Two real repos onboarded; each completes label → draft PR (evidence complete) → approve → merge exactly once, on the same machine simultaneously |
| **M2 — isolation** | Factory A SIGKILLed or budget-stuck mid-run while factory B completes an issue end-to-end unaffected |
| **M3 — cross-repo signature rejection** | Event signed with repo A's secret naming repo B → 403, not routed; valid per-repo events route correctly |
| **M4 — budget enforcement** | A long-running issue hits `wallSecsPerIssue`, is aborted cleanly (partial branch preserved), and the other repo's runs are unaffected |

### 3.8 Effort & risks

| Work | Estimate |
|---|---|
| Adapter routing map + M3 checks | 0.5d |
| Per-repo config loading + validation | 0.5d |
| Setup-phase sandbox (ephemeral network) | 1d |
| Supervision + status aggregation | 0.5d |
| Budgets + M4 enforcement | 0.5–1d |
| Two pilot repos end-to-end (M1, M2) incl. tuning | 1–1.5d |

**Total: ~3–5 focused days.** Risks: (1) per-repo image/setup differences surface only at M1 — mitigated by picking two similar-stack pilot repos first; (2) GPU contention worse than budgets assume — measured, not predicted, via the extended metrics script; (3) supervision gaps (zombie sandboxes after hard kills) — the existing per-conversation sandbox teardown already handles in-process faults; host-level kill cleanup is a known small gap to verify in M2.

### 3.9 Open recovery tasks (surfaced by the drydock self-run)

- **T1 — Recover from partial runs:** when a task aborts mid-work (e.g., wall-clock budget exceeded) after changes have been made, preserve the partial work and resume/requeue rather than treating the run as a clean failure. Currently the abort lands in a terminal task state and the orchestrator concludes; there is no recover-from-partial path. Surfaced by the drydock self-run (issue #18 → aborted at the 1800s budget; fix + regression test written but uncommitted; no PR opened).

## 4. Target 2 as follow-up (one orchestrator, M repos)

### 4.1 What carries over from Target 1

Worker/reviewer roles (repo-parameterized), merge gate + single-use approvals (stable keys already hash tool+args — adding `repo` namespaces them), config files (become one registry of the same shape), adapter map (simplifies: `repo → secret`, one target), sandbox images, budgets, and all G0–G5 per-role evidence. **Target 1 is a strict subset; nothing built for it is wasted if Target 2 fails.**

### 4.2 The delta

| Work | Estimate | Type |
|---|---|---|
| Repo-parameterized tools (`delegate({repo,…})` etc.), workspaces re-keyed `work/<repo>/issue-<n>`, requestIds `repo-issue-n` | 1–2d | Plumbing, low risk |
| Shared-queue governance inside one process (Target 1 got isolation free from processes) | 1–2d | Design + plumbing |
| Cross-repo planning: approval-gated `file_issue` host tool, durable `cross-repo-plan` doc family tracking A→B chains, repo-aware orchestrator instructions, iteration until reliable | 3–5d | **Model capability — the open question** |
| Second fixture repo + G6 battery (cross-repo issue → correctly sequenced linked PRs → both merged exactly once) | 1d | Plumbing |
| Docs + gate write-up | 0.5d | Writing |

**Total: ~7–11 focused days; realistically 2–3 calendar weeks** — the long pole is iterating until the local 27B sequences reliably (the PoC's own experience: the model skips optional steps; cross-repo sequencing needs structural enforcement — durable plan doc + gate checks — not prompt trust).

### 4.3 The hybrid (de-risking option)

One process, but **one root conversation per repo plus a dedicated coordinator conversation** for cross-repo work (pi-durable supports multiple owner-linked conversations per harness; the PoC has always used one). This keeps Target 1's failure isolation *inside* a single deployment and confines cross-repo intelligence to one role — which is exactly the role Phase 6's sizing conclusion flagged for cloud offload first. Estimated at **~60% of the §4.2 delta for ~80% of Target 2's value**.

### 4.4 Decision rule (when to fund Target 2)

Run the Target 1 pilot and **count Journey D**: how often does a human have to manually sequence work across repos (issues filed in repo B because repo A's change needs it)?

- **Rare (≲ once/week):** stay on Target 1; the human-as-coordinator cost is two extra issue filings.
- **Frequent:** fund the **hybrid first** (§4.3), pointing the coordinator role at a cloud frontier model if local-model sequencing proves unreliable under G6; full single-orchestrator Target 2 only after the coordinator role passes its gate.

### 4.5 Open decisions (to close before implementation)

| # | Decision | Default in this spec |
|---|---|---|
| D1 | Test command: factory-side config (B) vs repo-declared `factory.yaml` (C) — C is only safe if **all** test execution moves into sandboxes (incl. the host-side PR verification, which today runs on the host) | **Resolved 2026-10-25: B adopted and implemented** (`poc/lib/factory-config.mjs`, argv-only command validation). Revisit C with sandboxed host-verification after M1 |
| D2 | Per-repo token provisioning (who issues/rotates) | Operator-managed in config; secret manager integration later |
| D3 | Pilot repo pair (prefer similar stacks to de-risk images) | TBD at implementation start |
| D4 | Second fixture repo for G6 | Only if Target 2 is funded per §4.4 |

## 5. Migration to engram core (drop poc wiring for a proper composition)

_Date: 2026-10-26 · Status: Phase 0 complete — Phase 1 pending start. Full issue: [#30](https://github.com/lalanikarim/drydock/issues/30)._

**Decision (owner, 2026-10-26):** drydock is built **on an engram core**, not the other way around. The explicit poc-era wiring — hand-rolled registry composition, raw http shim, own approval plumbing, imports of `vendor/engram/poc/lib/*` helpers — is dropped in favor of a proper composition against the core's public seam `createCoreInstance()` (engram issue #42 / PR #43). **Boundary: engram provides the core; all factory business logic stays in drydock.** Nothing factory-specific moves upstream.

### 5.1 The seam (pin target `cde8bb7`)

`createCoreInstance({ config, modelsConfig?, extraExtensions?, host?, port?, rootAgent?, rootInit? }) → { harness, server, actualPort, rootConversationId, close }`, plus `loadConfig(overrides?)`. Stability contract (engram `src/core.ts`): lifecycle + injection point stable; config additive; breaking seam changes get a major bump. **Import rule for factory code: only `vendor/engram/app/src/core.ts` and `config.ts`** — nothing from `app/src/` internals or `poc/lib`. Reference doc: engram `docs/ecosystem-flows.md`, Flow 4 (this migration) — supersedes the flow sections of `product-core-split.md`, which remains the seam API record (PR #43).

### 5.2 Dropped vs. kept

| Dropped (replaced by core wiring) | Kept in drydock (business logic, ported to TS extensions) |
|---|---|
| `MergeApprovalDoc` + JSON `/approvals` endpoint (+ §3.3 TTL port, PR #28) → core approval machinery: tiers, destructive guard, allow-rules, TTL, batching, Telegram/Web surfaces | Webhook intake: HMAC pre-parse verification, per-repo routing, sender allowlist (`intake.mjs`, `adapter.mjs`) — routes retarget core `/tasks` |
| Raw node-http shim in `factory.mjs` (`/tasks`, `/health`, …) → core HTTP/SSE server + Web UI + Telegram | Worker/reviewer task defs, prompts, tool filtering |
| Hand-rolled sandbox allowlist (PR #29) → core `SandboxManager` allowlists | Merge gate git semantics: `gh` ops, draft→ready, verified PR-state idempotency (merge = destructive-tier gated tool) |
| Imports of `vendor/engram/poc/lib/{model,env,podman-sandbox}.mjs` → `loadModelsConfig` / `loadConfig(overrides)` / core per-conversation env | Wall-clock budgets (`awaitIdleWithinBudget`) |
| `supervise.mjs` `/approvals` fan-out for stuck detection → `GET /board` + client surfaces (thin fleet aggregator may remain) | Lessons feedback loop; supervised sandbox health wrapper over `SandboxManager`; per-repo config validation → per-instance `loadConfig(overrides)` + factory budgets |

### 5.3 Decisions (locked 2026-10-26)

| # | Decision | Resolution |
|---|---|---|
| D2 | Merge approval consumption | **Drop single-use consumption.** Keys are per-args and the tool is idempotent via verified PR state (stays in drydock); exactly-once rests on GitHub state. Behavior delta: an approved-but-never-executed merge auto-passes if the identical call recurs — matches core semantics for all tools |
| D3 | Repo layout | **New tree:** `vendor/engram/` + `factory/` (main, intake, worker, reviewer, merge-gate, budgets, lessons, config) + `fleet/`; `poc/` decommissioned after cutover. Gate letters (G0–G5, M1–M3) remain the acceptance vocabulary |
| D4 | Composition language | **TS** (matches core; shares types with `core.ts`/`config.ts`; type-stripping runtime verified in Phase 0) |

### 5.4 Phases

- **Phase 0 — Spike: DONE (PR #31, merged 2026-10-26).** Pin bumped to `cde8bb7`; `poc/core-spike.test.ts` passes 8/8: single pi-durable copy across the vendor boundary (the vendored copy resolves bare imports into drydock's `poc/node_modules` — no dual-package hazard; standing rule: never install node_modules inside the submodule), drydock-defined `extraExtensions` visible to root, core tools coexist, board does not leak into the bare core, `/health` on ephemeral port, idempotent `close()` + port release. Pre-existing suite 30/30 unaffected.
- **Phase 1 — Port the pipeline as extensions: DONE (branch `feature/phase1-factory-core`, 2026-10-26).** New `factory/` TS tree on the root package layout (submodule at `vendor/engram`, single `node_modules`): `main.ts` (per-repo instance via `createCoreInstance({ extraExtensions: [factoryPipeline], port: 0, rootAgent })`), `pipeline.ts` (the `factory` extension: worker/reviewer tasks + `delegate`/`open_draft_pr`/`merge_pr`/`note_lesson` + reviewer role tools), `worker.ts`/`reviewer.ts` (durable task defs; sandboxed via core `ConversationMeta.sandbox` + `cwd`, container lifecycle owned by the core's `SandboxManager`), `open-draft-pr.ts` (structural review gate before push, idempotent draft PR), `merge-gate.ts` (D2: destructive-tier approval via instance `gates.json`, exactly-once via verified PR state — no consumption doc), `intake.ts`/`adapter.ts` (HMAC + sender allowlist unchanged; routes gain a per-instance `token` for the core's Bearer-auth `/tasks`), `budgets.ts`, `lessons.ts`, `setup-sandbox.ts`, `factory-config.ts` (per-repo config now carries an explicit `models` ref). Evidence: `factory/pipeline.test.ts` (extension shape) + `factory/intake.test.ts` (signature/cross-repo/allowlist, gate M3) pass; `factory/pipeline-boot.test.ts` boots the full pipeline on the core — `/health`, root conversation listed, `/tasks` accepted a submission against the factory root agent, idempotent close + port release; `main.ts` smoke: factory-fixture instance boots, `/health` 200 with generated Bearer token, graceful SIGTERM. **Known pending:** dead-container supervision (#20) is not yet reachable from the seam — engram issue #44 requests `ConversationMeta`/`SandboxManager` on the core export; until then a dead container surfaces as an exec error (matches current engram product behavior). Sandbox-flag doc is imported from `app/src/meta.ts` TEMP pending #44.
- **Phase 2 — Parity: DONE (PR #34, merged 2026-10-27).** Gate suite retargeted to exercise the PRODUCTION entrypoint (`factory/main.ts` as a supervised child process via `gates/lib.ts`; nothing re-implements composition): G0–G5 + M1/M2/M4 scripts + measurement all rewritten; M3 is covered inside G0. **Pin bumped to `51b4d39`** (engram #48 fix: `overrides.configDir` honored for per-instance `gates.json`; also brings the additive app-route seam, PR #46). Two live-run defects found and fixed during G1 re-runs (commit `9160d64`): (a) our instance `gates.json` had a destructivePattern matching `{"issueNumber":N}` — identical arg shape to `delegate()`, so every delegate call was classified destructive and unattended runs stalled; pattern removed (merge_pr stays prompt-tiered via tiers, D2 unchanged). (b) worker wrote its own e2e script that hung ~15 min in the sealed sidecar (bash tool has no default exec timeout; only the wall-clock budget catches it) — worker prompt now forbids self-written long-running scripts. **Results so far:** G0 PASS 20/20; G1 PASS — unattended label→draft PR #15 for issue #3 in **597 s** (baseline ceiling 433 s; drift to be explained with the full battery + Phase 6 metrics). **G2 first run (superseded):** #16 PASS; #17/#18 FAIL — root cause was NOT the factory: fixture issues #16–#19 were mis-seeded on GitHub (all four carried issue #16's customer-filter title/body, a variable-reuse bug in the seeding command), so workers faithfully implemented #16's spec three times; verified via the worker conversation entries in the instance sqlite (prompt for "issue #17" contained #16's body) and `gh api` on the live issues. Fixtures corrected 2026-10-27: #17 = summary openCents/paidCents breakdown, #18 = idempotent no-op status transitions (paid→voided stays 409), #19 = unknown-status PUT returns 4xx not 500; stale draft PRs #21/#22/#23 closed and branches deleted. **G2 re-run: PASS 3/3** — #16 PR #25 (309 s), #17 PR #26 (228 s), #18 PR #27 (195 s); suite/scope/behavior/zeroEdits all ok per issue. **G3: PASS** — T1 negative on seeded-bad branch: verdict=fail with reason naming the root cause (non-2xx treated as success → status never surfaced → retries never fire); T2 positive on known-good #1: verdict=pass. Two gate-script defects fixed in `gates/g3-reviewer.mjs`: (a) TS-only syntax + wrong `node:fs/promises` import crashed load; (b) the local `review` tool was passed only via `rootAgent.tools`, but agent tool filters resolve by name against the registry — unregistered definitions are silently dropped, so the root agent saw no tools; fixed by registering it in the gate's extension. **G4: PASS** — T1 happy path (approve → merge `7c3e776`, exactly-one-merge verified, durable decision recorded; 19 s) and T2 crash (SIGKILL while approval pending → restart over the same store → **approval state survived the restart** → approve → merge `0d2a5d5`, exactly-one-merge verified; 18 s). Merge mode targets existing draft PRs (#25/#26 for issues #16/#17) and makes no inference calls. **G5: PASS (321 s), attribution=strong** — trap issue #19 (unknown status on PUT → 4xx, not 500). Step A (no lesson): worker applied the handler-level anti-pattern (catch `TypeError` in the route and rethrow with `statusCode: 400`) — exactly the concern raised on PR #12; orchestrator recorded a standing lesson. Step B (lesson fed to the worker prompt): root-cause fix instead — new `UnknownStatusError` error class with `statusCode = 400` thrown from the store; the handler patch did not recur. The feedback loop demonstrably changed behavior, not just prose. **Measurement vs baseline (post-migration, 2026-10-27):** wall time per bounded issue — #16: 293/304 s, #17: 211/212 s, #18: 170/179 s, #19 (G5 steps A/B): 109/204 s; **all inside the pre-migration 129–433 s band** on the same single-GPU endpoint (aurora, Qwen3.8-27B GGUF). Tokens per issue (total incl. cache reads): 119K–220K vs baseline ~81–145K — higher, driven by cache-read-dominated context re-sends on the worker conversation (worker totals 76K–183K); non-cached in+out is ~24K–56K per issue. G1's 597 s remains the outlier vs the band and stays open for explanation (single unattended run, includes label→intake latency). M1/M2/M4 need a second onboarded repo — they run with Phase 3 cutover (scripts ready; env-parameterized). **Honesty note: prior G0–G5 evidence is superseded by this rewire until Phase 2 passes.**
- **Phase 3 — Cutover & decommission: DONE (branch `feature/phase3-cutover`, 2026-10-28).** Second pilot repo is a purpose-built fixture (`lalanikarim/factory-fixture-2`: dependency-free Node job-queue service, `node --test`; config `factory/config/lalanikarim_factory-fixture-2.json`) rather than drydock itself — dogfooding drydock stays a post-cutover goal. **Fleet supervisor ported to TS** (`fleet/supervisor.ts`): one `factory/main.ts` child per repo + optional webhook adapter, restart-on-fault with backoff (max 10), ephemeral ports learned from each child's ready line, supervisor-owned routes file (all repos listed at boot so the adapter validates before instances are ready; `target` filled on ready, removed on exit; per-repo webhook secret required in the fleet file — env override `GITHUB_WEBHOOK_SECRET_<owner>_<repo>`); `status` subcommand reports up/awaiting-approval per repo via authenticated `/health` + `/approvals`. Smoke: adapter listening with 2 routes, both factories up, status shows both, SIGTERM shuts everything down cleanly. **M-gates (live, both repos):** M1 PASS — fixture#30 (`?limit=` pagination) ∥ fixture-2#10 (tags array), each full chain label→worker→review→draft PR→approve→merge with evidence + exactly-one-merge verified; 182 s / 180 s. M2 PASS — A SIGKILLed mid-run (6 s in, worker just spawned), B (#2 priority validation) completed unaffected: PR #14 merged, single-merge verified. M4 PASS — A aborted by a 30 s `wallSecsPerIssue` budget (`wall-clock budget exceeded`, durable abort outcome, no PR; partial branch discarded later), B (#16 ageSeconds) completed: PR merged, exactly-once; 112 s. **M4 lesson:** the first attempt set a 120 s budget on a task the worker finished in ~86 s — nothing to abort, gate waited on a pattern that never came (test-design miss, not a product defect; budgets fire when the budget is below task duration). **Gate-helper bug found via M2:** `gates/lib.ts rootConversationId()` assumed `/conversations` returns oldest-first — it returns newest-first, so with worker/reviewer conversations present the gate polled the reviewer's conversation and wedged until timeout; fixed to select `isRoot`. **Decommission:** `poc/` deleted in full (JS gates/lib/factory tree, runtime state, 828 MB); sandbox Dockerfile moved to `factory/sandbox-image/`; `.env` + `.env.example` moved to repo root (all loaders updated); poc-era unit tests retargeted (`sandbox-allowlist` → `factory/setup-sandbox.ts`; TTL test keeps only the config field — decision logic lives in core; `sandbox-health` deleted, container supervision is core-owned pending #44). Unit suite green post-deletion. **Open posture note:** with the core's built-in approvals extension active, some compound worker bash commands (e.g. `ls /sandbox && cat README`) are classified DESTRUCTIVE and block until approved, despite our `gates.json` gating only `merge_pr` — observed twice, workers recovered by rephrasing; needs investigation (core default rule matching vs factory gate policy) before fully unattended fleets. **Update (2026-10-28): root-caused and stopgapped** — see [`n1-bash-destructive-misclassification.md`](n1-bash-destructive-misclassification.md) (two core defects: destructive floor applies to ungated tools, substring-not-shell-aware matching); worker prompt now avoids the triggering shapes and a characterization test pins the behavior. Upstream fix still pending.
- **Phase 4 — Pin discipline (ongoing).** One gate script runs the full suite; every submodule bump re-validated against the stability contract.

### 5.5 Effort & risks

~1–2 focused weeks for Phases 1–3. Risks: upstream churn (mitigated by SHA pin + gate script + stability contract); evidence reset at Phase 2 (stated explicitly, baseline recorded); `extraExtensions` run with full core privilege (vet like first-party code; consequential actions registered as approval-gated tools — the "human is the control boundary" invariant must survive into consumer extensions); per-instance human surfaces grow attack surface (bearer token + LAN bind posture; destructive tier keeps merges human-gated).

### 5.6 Follow-on effects

- **§3.9 T1 (partial-run recovery) stays parked** until after migration — the resume/requeue design is cleaner on the core's task machinery.
- **Target 2 (§4) becomes the board/collective story:** engram's Project 0 board + Collective A1–A4 (member domain memory, peer trust tiers, untrusted peer input, containment of a bad member) are built and tested upstream; per-repo instances become members via the M2 federation seam. Revisit the §4.4 decision rule after Phase 3.
- PRs #28 (approval TTL) and #29 (sandbox allowlist) are **absorbed by the core** once Phases 1–3 land — they were manual ports of exactly the machinery the composition now provides; their tests move with the code or are retired at cutover.

### 5.7 Post-cutover roadmap (agreed 2026-10-28, after PR #35)

Migration Phases 0–3 are DONE and merged (`main` = `acbfdb5`). Remaining work, in priority order:

| # | Item | Why it matters | Status |
|---|---|---|---|
| N1 | **Bash DESTRUCTIVE misclassification** — repro the compound-command blocks against pin `51b4d39`, root-cause (core built-in approvals default rules vs factory `gates.json` tier policy), fix factory-side or file upstream | Only known blocker to fully unattended fleets (observed twice in M2/M4; workers self-recovered by rephrasing) | **Closed for factory scope** — merged to `main` via PR #37 (`15b2248`, 2026-10-28); upstream fix still pending [engram#53](https://github.com/lalanikarim/engram/issues/53). Root cause (2026-10-28, [`n1-bash-destructive-misclassification.md`](n1-bash-destructive-misclassification.md)): two core defects — the built-in destructive floor is evaluated before the tier table so it gates tools with NO tier entry (and `destructivePatterns` is append-only: no opt-out), and matching is unanchored substring regex over the raw command line (`>/dev/null`, `grep -rn shutdown src/`, SQL in a string all match). Factory-side stopgap: worker prompt shell-hygiene rule + `test/n1-destructive-classification.test.mjs` (safety-floor guard / false-positive TODOs / pin characterization / hygiene test, wired into `npm test`). Upstream issue **filed**: [engram#53](https://github.com/lalanikarim/engram/issues/53) (Ask 1 shell-aware matching, Ask 2 declarable floor) — **FIXED UPSTREAM**: [engram#53](https://github.com/lalanikarim/engram/issues/53) closed by PR #57 in kernel **v0.2.0**; this branch bumps the pin to it and flips suite B from TODOs to real assertions (see §5.8) |
| N1a | **Stall detection for pending bash approvals** — fail loud when an instance holds a pending approval with `tool === "bash"` beyond N minutes (supervisor `status` already reports awaiting-approval) | Until the core guard is fixed, a false positive is a *silent* stall; this makes it a visible failure | Deprioritized (2026-10-28): kernel v0.2.0 removes the false-positive stall this was defending against. Re-scope to generic pending-approval-age alerting as fleet observability, or drop |
| N2 | **Full-battery confirmation run + Phase 6 metrics** — G0–G5 + M1/M2/M4 back-to-back on the final tree; consolidated wall/token table | Closes the two open honesty items: G1's 597 s drift vs the 433 s ceiling, and replacing piecemeal per-gate numbers with one post-migration table | **Done** (2026-10-28) — all nine gates pass on `main` = `2596e9e`; results, six harness defects found while running it, and the remaining token-accounting gap are in §5.9 |
| N3 | **Drydock dogfooding** — onboard drydock as a managed repo under its own factory: per-repo config (`setupCommand`, submodule-aware clone), branch protection on `main`, real webhook secret + GitHub webhook, first self-assigned issue end-to-end | Original goal of the whole exercise; also the moment the **live webhook path** gets real (adapter is built + unit-tested, but every gate so far posts `/tasks` directly — no live GitHub signature has ever been verified) | Open — **scope corrected 2026-10-28**: the adapter and supervisor are already built and unit-tested (§5.11); what is left is deployment (fleet file, webhook secret, token scope); the enforcement side — registry-checked supervisor startup and `autoMerge:false` removing `merge_pr` — is done (§5.11) |
| N4 | **Pin discipline script** (Phase 4) — single `gates/all.mjs` runner re-validating the suite per submodule bump | Makes the SHA-pin stability contract mechanical instead of ritual | Open |
| N5 | **engram #44 watch** — `ConversationMeta`/`SandboxManager` on the core seam; then remove the TEMP import in `factory/worker.ts` and revisit dead-container supervision (#20) | Last known boundary gap to vendored internals | **Unblocked** — engram #44 closed in kernel v0.2.0 (`CoreInstance.sandbox` = `lookup`/`disposeAll`/`sweepOrphans`); the TEMP `ConversationMeta` imports are gone (now via the declared seam) and dead-container supervision (#20) is ours to build |
| N6 | **T1 partial-run recovery (§3.9)** — resume/requeue design on the core's task machinery | Parked until post-migration; migration is now done | Unblocked, not started |
| N7 | **Board/Collective story after the kernel split** — decide whether Target 2 (§4) depends on [lalanikarim/collective](https://github.com/lalanikarim/collective) as a *second* upstream (its own pin/seam) or is retired; §4 and §5.6 currently assume capability the kernel deliberately no longer ships | The split (kernel v0.1.0, PR #55) moved board.ts + all six board suites out of engram; our roadmap text now contradicts upstream reality | Open — written up in [#42](https://github.com/lalanikarim/drydock/issues/42) (client-only federation; no collective dependency; gated on N3) |
| N8 | **Upstream review: two narrowings in the v0.2.0 guard** — quoted payloads through non-shell interpreter heads (`python3 -c "…os.system('rm -rf …')"`, `node -e "…rmSync…"`) classify as data; and the redirection drop is broad enough that `echo x > /dev/sda` classifies as data (the pre-v0.2.0 pattern guarded it). Suggest: extend the live-code head table, narrow the drop to `/dev/null|/dev/stdout|/dev/stderr|/dev/fd/*` | Not our exposure (worker bash runs in the sealed sidecar) but it weakens the floor for uncontained consumers of the kernel we vendored | Open — written up in [#41](https://github.com/lalanikarim/drydock/issues/41) with a ready-to-paste upstream note; still needs filing on engram |

### 5.8 Kernel v0.2.0 (engram): what changed for us (audited 2026-10-28)

`v0.1.0` (board-free split) and `v0.2.0` (`a764e36`, PR #57) landed the same day our Phase 3 cutover merged. Audited by diffing every seam we consume **and** by running the tag's/main's actual gate code in a scratch dir against our own policy — conclusions measured, not inferred.

- **v0.1.0 — repo split.** engram is now kernel + solo executable; the board and its suites moved to `lalanikarim/collective`, which consumes the kernel as `"engram": "github:lalanikarim/engram#<tag>"` with `app/dist/` built by `prepare`. Deep `app/src/*.ts` imports still work but are internals, not the blessed path (board.ts deletion is the empirical argument). A declared public seam was added at `app/src/core.ts` (`loadConfig`, `ConversationMeta`, model helpers, `AppRoute`/`readJsonBody`, approval machinery, `compileGates`).
- **v0.2.0 — N1 fixed (#53) both halves.** (1) *Command matching*: bash lines are reduced to simple-command candidates first — quote-aware split on `&&`/`||`/`|`/`;`/`&`/newline, `/dev/*` redirections dropped, quoted spans masked unless the head is a shell interpreter or `eval`, `reboot`/`shutdown` demoted to head-position commands. (2) *Declarable floor*: a tier may declare `"containment": "sandbox"`, and when `ConversationMeta.sandbox === true` the tool is ungated for that conversation — loud at startup, once-per-conversation log, **uncontained conversations keep the absolute floor**. Free-form pattern exclusion was deliberately rejected (agreed: tokenization removed its justification).
- **Measured before/after with our own policy `{tiers:[{tool:"merge_pr"}]}`:** `npm ci >/dev/null 2>&1`, `cd /sandbox && npm test 2>/dev/null`, `grep -rn 'shutdown' src/`, SQL inside a string literal, and the printf/heredoc case all went **destructive → ungated**; `rm -rf /var`, `mkfs`, `dd if=`, `git push --force`, `git reset --hard`, fork bombs, chains (`ls && rm -rf /data`), `sudo`/`VAR=` prefixes, `xargs`, `sh -c "…"`, `$(…)` and backticks all stay **destructive**. Only `rm -rf node_modules && npm install` still blocks — correctly, it is an `rm -rf`; workers avoid it by policy.
- **v0.2.0 — #44 closed.** `CoreInstance.sandbox: SandboxSupervision { lookup, disposeAll, sweepOrphans }` — exactly the surface needed for dead-container supervision and post-crash orphan sweeping (closes our last known boundary gap to vendored internals).
- **Classifier (approvals phase 5) is inert for us**: it only scores `prompt`-tier actions and `compileClassifier(undefined)` → `{enabled:false}`; our factory-written `gates.json` sets no classifier key. If ever enabled, the extra model call would land on `merge_pr` approvals. Invariants are real code (fail-safe, escalation-only, approval key unchanged so crash-retry idempotency survives).
- **Pin bump verification on this branch (`chore/engram-v020-pin`):** unit suite green (16 N1 checks incl. new containment-semantics and known-narrowing suites), `npm run test:boot` green (8 checks: `/health`, root conversation, `/api/tasks`, idempotent close), **G0 PASS 20/20**. Boot works without `preact`/`htm` installed — those are static Web-UI assets served from `node_modules`, not imports; the per-instance Web UI would need them if we ever surface it. Live gates that mutate fixtures (G1 creates a draft PR, G4 merges) were **not** run here — they need a free fixture issue/PR and explicit sign-off.
- **Open policy question:** adopt `{"tool":"bash","containment":"sandbox"}` in the factory-written `gates.json`? Safe here — only sandboxed conversations ever get bash (orchestrator tools are `delegate`/`open_draft_pr`/`merge_pr`/`note_lesson`; reviewer has no shell) — and it immunizes us against future floor false positives; the tradeoff is that a hypothetical uncontained bash conversation would stall rather than run. **Adopted — [#40]: `factory/gate-policy.ts` is now the single source of truth for the instance gate policy** (`{tiers:[{tool:"merge_pr"},{tool:"bash",containment:"sandbox"}]}`), written by `factory/main.ts` and consumed unchanged by the boot test (they had drifted: the boot test carried the old `{"issueNumber":N}` destructivePattern that also matched `delegate()` — now impossible, pinned by `test/gate-policy.test.mjs`). The worker prompt's Shell hygiene stopgap was **deleted**: a missing declaration fails as a visible stall, not an unsafe run, so prose workarounds would only hide whether safety came from the guard or from the model complying. Runtime evidence: a real boot logs `[gates] containment-gated floor suppression declared for: bash`. Trade-off accepted knowingly — with the declaration present, an *uncontained* conversation gets `prompt` tier on every bash call (asserted in `test/gate-policy.test.mjs`), and no conversation we create has bash outside the sidecar.

### 5.9 N2 — full-battery confirmation on the final posture (run 2026-10-28)

Posture under test: `main` = `2596e9e` (kernel pin `v0.2.0`, `containment:"sandbox"` declared for worker bash, **no** prompt-level destructive-guard workarounds anywhere), aurora endpoint `Qwen3.8-27B` GGUF on one GPU, Podman sidecars. Fixtures: `factory-fixture` + `factory-fixture-2`. Nine gates, run back-to-back against the real production entrypoint (`factory/main.ts` as a supervised child); every merge below is a real merge into a fixture's `main`.

| Gate | Result | Wall | Evidence |
|---|---|---|---|
| G0 intake exactly-once | **PASS** 20/20 | — (no inference) | retry-dedup, untrusted-delimiting, webhook signature, M3 routing, sender allowlist |
| G1 label → draft PR | **PASS** | **64 s** | fixture #28 → PR #37 (later merged in G4 T1), unattended |
| G2 worker quality | **PASS 2/3** | 97 / 144 / 128 s | #33 PASS, #35 PASS, #34 FAIL on scope only (6 files > bound of 5; suite 53/53, behavior ok, zero human edits). Same PR passes at `--max-files 6` |
| G3 independent reviewer | **PASS** | 46 / 40 / 240 s | T1 caught the seeded trap (verdict=fail naming the root cause); T2 known-good pass; T3 closed loop on live issue #36: worker → review pass → draft opened, gate held, **no merge** |
| G4 merge gate + crash | **PASS** ×2 runs | 19 s / 19 s (re-run: 38 s) | T1 approve → merge, exactly one merge commit; T2 SIGKILL while approval pending → restart over same store → **key survived** → approve → merged exactly once |
| G5 feedback loop | **PASS**, attribution **strong** | 151 s | fixture #19: step A produced the handler-level `instanceof TypeError` patch; after one durable `note_lesson`, step B produced the root fix (`statusCode` on the error class) and the patch did not recur |
| M1 two repos live | **PASS** | 189 s ∥ 161 s | fixture-1 #29 ∥ fixture-2 #18, both evidence-complete, each merged exactly once, simultaneously |
| M2 failure isolation | **PASS** | B: 78 s | A SIGKILLed 6 s into its run; B completed the full chain unaffected and merged once |
| M4 budget enforcement | **PASS** | B: 202 s | A durably aborted by budget (`M4_BUDGET_SECS=20`) with zero side effects (no PR); B completed and merged once |

**Both open honesty items are closed.** (1) G1's 597 s outlier is gone — 64 s unattended on the final tree, comfortably inside the pre-migration 129–433 s band; the earlier number was a single cold run that included intake latency, not drift. (2) This table replaces the piecemeal per-gate numbers in §5.4.

**Six harness defects found while running it** — all fixed here, and each one is the kind of thing that only surfaces when the battery is run end-to-end on a tree where the *fixtures* have moved on:

1. **G2 could not evaluate any issue other than #16–#18.** `checkBehavior()` throws for unknown issues, so newly seeded targets reported `RUN FAIL — no behavior check defined` after a perfectly good worker run. Behavior checks added for #28, #29, #33, #34, #35, #36 (spec-derived from each issue's acceptance criteria, not from the implementation) — and then **removed as a design** in favor of label-keyed oracles, see §5.10.
2. **G2's scope bound was hardcoded and its failure message ambiguous.** Now `--max-files` (default unchanged at 5) and the output distinguishes *out of scope* files from *too many* files. Finding rather than defect: an issue that adds a route legitimately spans six files (`server.mjs`, `invoices.mjs`, `store.mjs`, two test files, README).
3. **G3's T3 "closed loop" leg was vacuous and unasserted.** It hardcoded issue #4 — merged long ago — so the worker produced nothing, it printed `verdict=null draftPR=false gateHeld=false` for ~100 s, and the gate still reported PASS because T3 was never in the verdict. Now parameterized (`--t3-issue`) and a leg that runs without producing a verdict **fails** the gate; verified live on #36.
4. **G3's T2 positive control is also going stale (open).** `agent/issue-1` is merged into main, so its diff vs main is empty — the reviewer said so twice ("git_diff returned an empty changed-file list") and passed it by inspecting state instead of a delta. Needs a policy decision on what "known good" means once branches land; not fixed here.
5. **G4 never exited.** After the crash test it printed `GATE G4: PASS` and then hung indefinitely (one such process was still alive 1 h later, another for 23 h from an earlier session): the SIGKILLed instance's 2 s log-flush interval is only cleared in `close()`, and the crash path re-assigned `instance` without closing the dead one. Fixed by closing before respawn; the re-run exits 0. Also: `--skip-crash` still demanded a valid T2 target (default issue #2) at preflight; now it validates only what will run.
6. **M4's default budget was longer than a typical successful run.** With `M4_BUDGET_SECS=120`, bounded fixture issues finish first, no abort ever fires, and the script waits out its full 20-minute delegate-wait with no diagnostic. Default lowered to 30 s (verified: clean abort, zero side effects) with a comment stating the invariant.

**Fixture bookkeeping.** Targets were seeded as ordinary issues *without* the `agent` label (`factory-fixture` #33 offset paging, #34 PATCH amountCents, #35 status history, #36 413 body cap, #42 `totalCount`, #44 customer-scoped summary, #45 sort; `factory-fixture-2` #18 `?status=` filter, #19 unknown `?priority=` → 400). G1/G2 synthesize the `agent` label inside the webhook event they deliver, so no fixture labeling is needed to drive them. One real defect was found while probing for G5 material and is now fixed by the G5 run: `PUT /invoices/:id/status` with an unknown status returned **500** instead of 4xx (bare `TypeError` from the store translated per-handler) — that is fixture issue #19, still open as a draft PR (#43).

### 5.10 G2's behavior oracles are label-keyed, not issue-number-keyed (2026-10-28)

The nine `if (issueNumber === N)` blocks inside `gates/g2-worker-quality.mjs` were the harness's worst coupling: they hardwired fixture issue numbers into gate code, and a target without a block only announced itself **after** a full worker run (`RUN FAIL — no behavior check defined for issue #34`). They are now twelve modules in `gates/probes/`, selected by labels.

| Label | Role |
|---|---|
| `agent` | **selection** — the same label production intake already gates on, deliberately reused rather than inventing a second selection label that could drift from it. No `--issues` flag means "every open `agent` issue is a target". |
| `probe:<key>` | **oracle key** — exactly one per issue; names `gates/probes/<key>.mjs`. Two is an error (two oracles for one issue means nobody knows which judges it). |

Preflight resolves everything **before any inference call** and fails on: a target with no `probe:*` label; a `probe:*` label with no module (typo, or an oracle deleted under review); more than one probe label; and — the strong one — **an oracle that already passes against fixture `main`**. That last check is fail-to-pass: an oracle which holds on main specifies nothing outstanding, so either the work merged (stale target) or the probe is vacuous. It also caught three brand-new probes in the act of being wrong-or-right rather than letting them quietly judge nothing. `--preflight-only` stops there; `--skip-fail-to-pass` overrides it.

`--regression` runs every oracle against main and classifies: oracles with no live target specify **shipped** work and must still hold (`REGRESS` = a feature broke); an oracle that fails on main while its issue is still open is `UNTARGET` (unsatisfied, should be labeled); one that passes while its issue is a live target is `STALE`. This needed a third category because of what it found immediately: **fixture issue #18 (idempotent status transitions) is not satisfied on main** — its draft PR #27 was opened during the Phase 2 work and never merged, so the oracle failed while the issue stayed open. That is exactly the state a number-keyed harness hides; #18 is now a labeled live target.

Two deliberate choices worth keeping:

- **Oracles live in drydock, not in the fixture repo.** The oracle must not be reachable by the pipeline whose work it judges — a spec an agent can edit is a tautology waiting to happen. Adding or changing an oracle is therefore a reviewed PR here, never a fixture edit. (`sourceIssue` on each module is provenance only — used for regression classification, never for selection.) Caveat recorded honestly: worker bash runs `network=none` and pushes happen orchestrator-side in `factory/open-draft-pr.ts`, so this is tautology-avoidance and defense-in-depth, not a hostile-actor control; labels are GitHub state readable by the instance token, which is why they are resolved once at preflight rather than re-read mid-run.
- ~~**`withServer` still hardcodes `src/server.mjs`**, so oracles only cover `factory-fixture` today.~~ **Closed** — boot recipes moved to `factory/repo-registry.json` (`oracleBoot`) and every probe declares its repo; see §5.11.

Current fixture posture: 6 live targets (`#18`, `#34`, `#35`, `#42`, `#44`, `#45`), 6 further oracles held as regression checks for merged work; verified with `--preflight-only` (all six fail against main) and `--regression` (PASS).

```
node --experimental-strip-types gates/g2-worker-quality.mjs --preflight-only      # resolve + fail-to-pass
node --experimental-strip-types gates/g2-worker-quality.mjs                        # label-discovered full run
node --experimental-strip-types gates/g2-worker-quality.mjs --regression           # oracles vs main
```

**Remaining measurement gap (honest).** The gates record wall time but **not tokens**, so this table cannot be compared token-for-token against the §5.4 numbers (baseline ~81–145K, post-migration 119–220K per issue). The data exists — per-entry `totalTokens` is persisted in the instance's durable store (`entries.record`) — it is simply never snapshotted before the gate tears the instance down. Concrete fix: a helper in `gates/lib.ts` that sums `totalTokens` over the run's conversation tree and returns it alongside `wallSecs`, called by each gate before `instance.close()`. Also unmeasured: contention with >2 concurrent factories on one endpoint, and any model other than the single 27B GGUF we run.

### 5.11 Repo registry: policy separated from deployment, and fixture-2 becomes judgeable (2026-10-28)

§5.10 left one gap — `withServer` hardcoded `src/server.mjs`, so only `factory-fixture` could be judged. Closing it turned into a question the harness had been avoiding: *which repo are we judging, under what rules?* That answer is now a checked-in registry rather than an env var default.

**Three config artifacts, deliberately separate:**

| File | Holds | Checked in? | Failure mode if wrong |
|---|---|---|---|
| `factory/config/<owner>_<repo>.json` | per-repo **runtime** config: model provider, `testCommand`, `setupCommand`, sandbox image, budgets | yes | a run fails or uses the wrong model |
| `fleet/fleet.example.json` (per deployment) | **deployment**: one entry per running factory + its webhook secret + instance token; supervisor rewrites the derived routes file | no (secrets) | nothing starts |
| `factory/repo-registry.json` | **policy**: which repos are managed, `eligibilityLabel`, `autoMerge`, `oracleBoot` | yes | something gets merged that should not have been |

Separating policy from deployment is the point: the registry contains no secrets, so it can be reviewed like code, and "is anything else auto-merging?" is a one-screen question instead of a grep across per-repo files. Two rules make it fail closed (`test/repo-registry.test.mjs`, 12 checks): a **disabled entry may not declare `autoMerge=true`** (a leftover grant on a repo someone disabled is a surprise for whoever re-enables it), and an **enabled entry requires `configFile`**, whose existence is checked at load. Unknown fields are rejected — `{automerge: true}` must not silently mean "not set".

**Oracles are now per-repo.** Each probe exports `repo`, and each registry entry declares `oracleBoot` with explicit port discovery, because the two fixtures genuinely differ: fixture-1 binds port 0 and logs `127.0.0.1:<bound>`, while fixture-2 reads `PORT` and logs **the requested value** — meaningless when we ask for 0. So `portFrom` is either `"stdout"` (parse the log) or `"env"` (we reserve a free port, export it, and wait for the socket to accept). A probe whose `repo` does not match the repo being judged is refused rather than run: an invoice oracle against the jobs service would judge nothing, and might accidentally "pass".

That made fixture-2 judgeable — `gates/probes/jobs-sort-priority.mjs` + issue #11 labeled `agent` + `probe:jobs-sort-priority`, verified **in both directions**: fails against fixture-2 `main`, passes against a locally patched copy (patch never pushed; the point is to prove the oracle is not vacuous in the pass direction, which fail-to-pass alone cannot show). `--regression --repo all` now sweeps every registered repo in one run: 12 oracles hold on fixture-1 `main`, fixture-2's target reports as expected-fail.

**Correction, and it materially shrinks N3.** I reported on 2026-10-28 that "no webhook receiver exists" and that repos come only from a `FIXTURES_REPO` env var. Both were wrong: I grepped the vendored kernel and the gates, not `factory/`. In reality drydock already ships

- `factory/intake.ts` — GitHub webhook adapter with `X-Hub-Signature-256` HMAC verification **before parsing** (constant-time, fails closed on missing, malformed, or mismatched), **per-repo secrets** where signature validity doubles as repo authorization (a payload naming a different repo than the secret that signed it is rejected 403), optional `allowedSenders`, stable `requestId = issue-<n>` for exactly-once under redelivery, JSONL audit log, and a **refusal to bind any non-loopback host without auth**;
- `fleet/supervisor.ts` — one factory instance per managed repo + the adapter, restart-on-fault with backoff, learning each child's ephemeral port from its ready line and rewriting the routes file;
- `gates/g0-intake.mjs`, which already exercises signed delivery, bad-signature rejection, cross-repo rejection and the bind-without-secret refusal — against a local adapter, **never against GitHub**.

So N3 is mostly *operations*, not code: write the deployment fleet file, create the webhook + secret on the repo, decide token scope, run it. Two code gaps were identified — nothing reconciled the supervisor's fleet file with the registry, so **a deployment could run a factory for a repo the policy marks disabled**; and `autoMerge=false` was enforced nowhere in the merge path. **Both closed the same day** (follow-up PR):

1. `fleet/supervisor.ts` calls `checkRegistryPolicy` on every fleet entry **before spawning anything**. The two files mean different things — the fleet file says what should be *running*, the registry says what is *allowed* — and now an unregistered repo fails with the list of permitted ones, while a registered-but-disabled one fails carrying its own `note`.
2. `autoMerge:false` became **capability removal**. `factory/main.ts` resolves policy *first* — before reading per-repo runtime config, so a disabled repo gets a policy explanation instead of a confusing `ENOENT` — and registers `merge_pr` only when the entry allows it. The orchestrator prompt is generated from the same flag (`orchestratorInstructions({autoMerge})`), because an agent told to call a tool it does not have goes looking for another way, and `gh pr merge` is sitting in the worker's shell; the draft-only prompt names those bypass routes explicitly rather than trusting "must not merge" to be read broadly.

Evidence: booting a factory for `lalanikarim/drydock` now dies with `is in the repo registry but disabled: …`; fixture-1 boots unchanged (`ready on http://127.0.0.1:…`); G0 still 20/20; `test/repo-enforcement.test.mjs` (4 checks) covers tool absence, that the two prompt shapes differ only in step 6, and that one disallowed entry poisons an entire fleet file before any child starts.

What this does **not** cover, stated so nobody assumes otherwise: it is not branch protection — a human or any other tool with write access can still merge, and GitHub-side rules remain the only defense there. The check also runs at process start, so an instance already up when policy changes keeps its tools until it restarts (supervisor restart-on-fault makes that window short, not zero). And no live GitHub signature has ever been verified: every G0 delivery is signed locally by the test itself.

```
node --experimental-strip-types gates/g2-worker-quality.mjs --repo lalanikarim/factory-fixture-2 --preflight-only
node --experimental-strip-types gates/g2-worker-quality.mjs --regression --repo all
node --experimental-strip-types --test test/repo-registry.test.mjs      # registry shape + probe/registry cross-checks
node --experimental-strip-types --test test/repo-enforcement.test.mjs   # policy → capabilities
```

### 5.12 What drydock-as-a-managed-repo actually requires (measured 2026-10-28)

N3 has always been described as "onboard drydock under its own factory", which invites thinking about it as a big change. The pipeline's contract with any repo is three things: **clone → setup → `testCommand`**, everything else (review, draft PR, approval) is repo-agnostic. So the question is empirical: can that chain succeed on *this* repo? Measured on a clean clone of `main`, not inferred:

| Step | Result |
|---|---|
| Host clone | `factory/worker.ts` already clones with `--recurse-submodules`, so `vendor/engram` arrives at the pinned tag (`a764e36`, v0.2.0) — the "submodule-aware clone" item on N3's row needed **no code** |
| Dependency install | `npm ci` in the clean clone succeeds (lockfile present; warm npm cache made it ~2 s) |
| Verification command | `npm test` → **exit 0** in that clean clone, with no `.env`, no running supervisor and no container-side work — so a worker's success criterion is satisfiable on drydock as-is |
| Setup container | sandbox image has node v24.22.1 / npm 11.19.1 and the registry is reachable from it (`--network bridge`, `npm ping` → PONG 474 ms), so `setupCommand: "npm ci"` works and lands `node_modules` in the mounted workspace before the sealed run |

Added: `factory/config/lalanikarim_drydock.json` (`testCommand: npm test`, `setupCommand: npm ci`, `wallSecsPerIssue: 2400` — real drydock work spans more files than a fixture issue) and the registry entry now points at it. New invariant in `test/repo-registry.test.mjs`: **every** entry's `configFile` must parse against the runtime schema and agree on repo identity, *including disabled repos* — finding a bad field in drydock's config on the day we enable it is the worst possible time.

**Status: enabled, deliberately narrowly.** The drydock entry is now `enabled: true` — a statement about what policy permits to run here, not a deployment. **(Updated 2026-11-01: this paragraph originally read "there is no fleet entry and no published listener" — both have since changed.)** Dispatch now requires an eligible event from an allowlisted sender — the `build` label on an issue, or a `/factory` comment on an open factory PR — and runs are additionally started locally by hand (`gates/self-run-task.mjs`). What replaced "disabled" as the safety story is capability removal: `autoMerge: false` means `merge_pr` is absent from a self-run's tool list, so landing anything requires a person. Two tests had encoded the old state; one of them (the supervisor refusing drydock) coupled a mechanism to a policy decision — flipping the decision broke the test, and deleting the test would have concealed the enforcement — so the refusal case now runs against a synthetic disabled entry and stays true whichever repos we allow. Before webhook-driven self-work: create the `build` label, publish the listener only after #57 had landed (the transport is an operator choice and is deliberately not part of the design — see `fleet/enable-self-work.md`), and move off the account-wide token (done: App installation tokens, #79; the keychain fallback is no longer taken on this host).

Three risks worth naming:

- **Recursion.** A repo's own `testCommand` must never include gates that mutate GitHub (G1 opens PRs, G4 merges). `npm test` is safe today precisely because it is unit-only — that is a property to preserve, not an accident to rediscover.
- **A green suite is a weak judge here.** For fixtures we have behavior oracles; for drydock the worker would be graded by the same suite it can edit. G2/G3 should stay in the loop for self-work rather than trusting `npm test` alone. Partly closed since: `gates/` — including `gates/probes/*.mjs`, the oracles — is outside drydock's path allowlist, so a self-run cannot soften the checks that judge it (§5.13). Editing assertions in `test/` remains possible and is accepted; those are the factory's own unit tests, which a change to the factory often legitimately updates.
- **~~Nothing stops a worker touching `vendor/engram`.**~~ Was: the 5-file / `src|test` scope rule lived in the G2 harness, not the pipeline, and submodule pointer changes are exactly the kind of edit that passes tests while being unacceptable. Now enforced by path scope (§5.13): `vendor/` is protected unconditionally for every repo, before any allowlist is consulted.

### 5.13 Path scope: the pipeline cannot change what it is not allowed to touch (2026-10-28)

§5.12 named the risk that stayed unfixed: nothing stopped `open_draft_pr` pushing a branch whose only change was the **`vendor/engram` submodule pointer** — every test passes, and the vendored kernel changes underneath us. Pin discipline is a human decision (tags, review, rollback), so it should be structurally impossible rather than prompted for.

Two mechanisms in `factory/path-scope.ts`, different default posture on purpose:

| Mechanism | Default | Semantics |
|---|---|---|
| `ALWAYS_PROTECTED_PATHS = ["vendor/"]` | **on everywhere**, before any config is consulted | never changeable; forgetting to configure a repo cannot expose the pin, and an allowlist naming `vendor/` does not override it |
| registry `pathAllowlist` | per repo; absent = anything non-protected | fixtures: `src/`, `test/`, `README.md`. drydock: `factory/ fleet/ gates/ test/ research/` — which deliberately excludes `package.json`/`package-lock.json` (dependency and lockfile changes are human-only for self-runs) and `AGENTS.md`/.github |

Prefix matching only (trailing `/` = directory, otherwise exact). No globs: every dialect considered needed its own security review, and top-level prefixes express what we actually want. Registry validation rejects an **empty** allowlist (`[]` would silently forbid all changes), absolute paths, `..`, backslashes and shell metacharacters — same posture as `factory-config.ts`.

The gate runs in `open_draft_pr` **before the reviewer**, so a run that touched something off-limits costs seconds instead of minutes of inference, and it **fails closed** when the diff basis against `origin/main` cannot be computed: pushing unchecked is the unsafe option.

**Verified at three levels.** (1) Unit semantics + registry wiring — `test/path-scope.test.mjs`, 7 checks. (2) The git assumption this rests on is itself pinned by a test that builds a throwaway repo with a real submodule, bumps the pointer, and asserts `git diff --name-only base..branch` reports exactly `["vendor/engram"]` — if git ever surfaces gitlinks differently, the test fails here rather than silently un-enforcing the rule. (3) **Live end-to-end**: a workspace whose only change was `notes.txt` (outside fixture-1's allowlist), a real instance, and a task instructing the orchestrator to open the PR:

```
open_draft_pr result: {"refused":true,"reason":"path scope violation — nothing was pushed or reviewed",
  "offenders":[{"file":"notes.txt","why":"outside this repo's allowlist (src/, test/, README.md)"}], …}
branch pushed to origin? NO — nothing was pushed
```

**Considered and declined:** making the G2 harness read its scope rule from the registry. The harness rule is intentionally stricter (it also bounds file *count*, and it runs on a checkout rather than pre-push), and silently unifying them would couple a review heuristic to a safety control — if one day they must agree, that should be an explicit decision, not a refactor side effect.

**Drydock's own allowlist excludes `gates/`** — it is `factory/ fleet/ test/ research/`. The reason is specific to self-hosting: `gates/` holds the G-harnesses and `gates/probes/*.mjs`, the oracles that decide whether work passes. For a fixture repo that was harmless, because G2 runs from *outside* the graded repo; drydock is its own graded repo, so a diff that softened an oracle would be judged by the thing it softened — and with zero required approving reviews the human gate is one click on one's own PR. `gates/probes/` is additionally declared protected for drydock, so re-adding `gates/` later cannot quietly unlock the oracles.

**The eligibility label is policy, read per route.** GitHub does not auto-create labels and intake matches on name, so enabling a repo also means creating its label in that repo. The label now flows from the registry through `buildRoutes()` (`fleet/supervisor.ts`) into each adapter route; the fleet file cannot set it, because a deployment typo there would silently stop one repo's work while the adapter reported healthy. Before this threading the trigger was hardcoded to `agent` while drydock declared `build` — that combination yields a factory which boots cleanly, passes every health check, and never receives anything.

**Still true after this:** scope is about paths, not content. A worker can still write terrible code inside `src/`; that is what the reviewer and G2/G3 are for. And `autoMerge` remains separately enforced (§5.11) — path scope says what may change, auto-merge says whether it may land.

### 5.14 Approvals are byte-scoped: `merge_pr` only lands the commit it was approved for (2026-10-30, #47)

**The defect.** `open_draft_pr` force-with-leases its branch (deleting it instead would auto-close the tracking PR), so when main moves and an issue is retried, head goes H1 → H2 *and the PR body's evidence is regenerated for H2*. An approval that said "merge PR #N" was therefore an approval of no particular bytes: observed 2026-10-28 on stale drafts for issues #35/#18/#34, where exactly-once merge held but `single-merge-verified` reported `ok:false` — the commit that landed was not the commit whose review and test evidence had been checked, and the old head became unreferenced. The only guard was a head comparison inside the G4 harness, which protects a battery run and nothing else.

**The fix uses the kernel's own mechanism instead of adding a second one.** `approvalKeyFor(name, args)` hashes the tool arguments (vendor/engram `app/src/extensions/approvals.ts`), so putting the verified head sha in `merge_pr`'s arguments makes the durable decision byte-scoped by construction:

| Change | Why |
|---|---|
| `merge_pr({ issueNumber, headSha })`, `headSha` required, full 40 hex | the approval key now *is* commit-scoped; approving means "merge this commit" |
| exact full-length comparison only (`headShaMatches`) | shas are machine-supplied, so accepting a 7-char prefix would buy nothing and weaken the binding |
| new read-only `pr_status` tool | the orchestrator must be able to read the current head *without* triggering a destructive approval; otherwise every merge burns one on discovery. Registered for `autoMerge:false` repos too — it is how a human checks a draft-only repo's branch |
| refusal discloses the real head | a mismatch is recoverable in one round trip, and the retry needs its own approval — which is the point: re-approval now requires looking at the new commit |
| merge commit parents verified to contain the approved sha (`approvedCommitLanded`) | closes the residual window by proof, not prevention (see below) |
| G4 asserts the pending approval's `args.headSha` equals the head whose evidence it verified | the guarantee is now checked in the gate, not assumed |

**Residual window, stated rather than glossed.** Between our `gh pr view` and GitHub actually merging (seconds) the head can still move, and GitHub's merge API accepts no expected-head precondition — so this is *detected*, not prevented: the landed merge commit's parents are checked for the approved sha, and a mismatch or an unverifiable parent list reports `approvedCommitLanded: false`/`"unknown"` with a warning instead of a clean success. `alreadyMerged` retries behave the same way (`landedHeadMatched`), so a stale retry can never claim success for different bytes.

**Verified.** `test/merge-head-binding.test.mjs`: comparison semantics (case-insensitive, prefix-rejecting), schema shape (`headSha` required; `pr_status.replay === "safe"`), and — against real PRs — the terminal-state path on merged fixture-2 #11 (`alreadyMerged: true, landedHeadMatched: false` + warning) and the refusal path on open draft fixture-1 #48:

```
pr_status  : {"prNumber":48,"state":"OPEN","isDraft":true,"headSha":"990bf283…","mergeStateStatus":"CLEAN"}
merge_pr   : {"error":"HEAD MISMATCH: PR #48 head is 990bf283… but merge_pr was called with headSha="ffff…"
              No merge attempted. … call merge_pr again with {"issueNumber": 42, "headSha": "990bf283…"}"}
state=OPEN draft=true mergedAt=null      ← nothing mutated
```

**Found on the way:** `withServer`'s stdout-port timeout called a `reject` that was never in scope (`new Promise((resolve) => …)`), so a server that failed to log its port crashed the whole G2 process with `ReferenceError` instead of failing one check — and the timer leaked 15 s after success. Fixed; it fired during this work while running issue #42, which is how it was caught.

### 5.15 The model is pinned, and boot fails if it isn't runnable (2026-10-30)

While re-running G4 T1 to verify #47, the gate hung: no approval ever appeared. The task had settled instantly and quietly — durable store, `tasks` table:

```
{"state":{"status":"terminal","outcome":{"status":"failed","error":
  {"message":"Model aurora/unsloth/gemma-4-12b-it-GGUF is not available","detail":{"reason":"no_model"}}}}}
```

**Causal chain (three independent resolutions that only worked by coincidence):**

1. `factory/config/*.json` said `modelId: "auto"`, which probes `GET $OPENAI_BASE_URL/models` and takes the model reported as **loaded**.
2. The kernel builds its catalog from `<agentDir>/models.json` (`PI_AGENT_DIR`, default `~/.pi/agent/models.json`), where this machine declares provider `aurora` with exactly one model: `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF`. A declared provider **wins** over the env-driven auto-registration (`vendor/engram/app/src/model.ts`: `if (!customIds.has(providerId)) …`), so that single id was the whole catalog for `aurora`.
3. The root agent inherited `defaultModelRef()` = `DEFAULT_MODEL` env, else the *loaded* model from discovery — and `rootAgent` in `factory/main.ts` never set a model at all.

So the orchestrator ran whatever aurora happened to have loaded. That matched the catalog for weeks; loading gemma-4 on aurora made every task settle `unanswered / no_model`, and because nothing surfaces that state, **G4 waited out its full 25-minute approval timeout** instead of failing. Three fixes:

| Fix | Why it's the right shape |
|---|---|
| Repo configs pin an explicit `modelId` (`ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF`) | measurement baselines (81–145K vs 119–220K tokens) are model-specific anyway — a factory that follows the endpoint's loaded model cannot produce comparable numbers. A test now rejects `"auto"` in any `factory/config/*.json` |
| `rootAgent.model = { provider, modelId }` | without it, core.ts falls back to the default (§chain 3). Note `AgentChange.model` is a `ModelRef` **object**, not the `"<provider>:<id>"` string used by config roles — passing a string produced `Model undefined/undefined is not available` |
| readiness gated on the catalog (`factory/model-catalog.ts`) | `assertModelAvailable()` fetches the instance's own `GET /models` and exits **before printing "ready"**, so spawners fail immediately with both sides named, instead of announcing readiness and then refusing to generate. `defaultMismatchWarning()` reports a differing instance default rather than letting the next reader rediscover it |

The self-check module is pure except for one fetch (`catalogModelIds` / `isModelAvailable` / `unavailableModelError` / `defaultMismatchWarning` are all table-testable); payload flattening degrades to "not found" on unknown shapes, i.e. fails closed rather than matching something by accident. `test/model-catalog.test.mjs`, 6 checks, includes a tripwire that `main.ts` still passes an explicit `ModelRef` and gates readiness.

**Verified end to end:** after pinning, G4 T1 on fixture-1 issue #42 — `approval-bound-to-commit {headSha: 990bf283…, key: b8ef33e9d80d}` → `head-still-verified` → merged `bc82200e`, exactly one merge commit, landed non-merge sha equal to the verified head, and the merge commit's parents include the approved sha. **GATE G4: PASS in 24s.** That run is also the first evidence for #47's byte-scoped approval *and* closes the last live target on fixture-1 except #45.

**Standing lesson:** an availability question ("can I run this model?") answered by two components independently, with the disagreement surfacing as a terminal task state nobody polls, is invisible until a gate hangs. Check at the boundary where the process can still refuse to start.

### 5.16 First drydock self-work run: the factory fixes drydock (2026-10-30 → 10-31)

The goal of N3 was not "drydock is listed in a registry" but "drydock's own pipeline can land a change to drydock". It did, including one full rework cycle. Sequence:

| Step | What happened |
|---|---|
| Enablement | Registry entry flipped `enabled: true` (PR #58). Safety no longer rests on the repo being disabled: it rests on `autoMerge:false` **capability removal** (`merge_pr` absent from the tool list, §5.11) plus path scope (§5.13) with `gates/` categorically outside the allowlist and `gates/probes/` additionally protected |
| Task | Issue #57 — intake hardening for a published listener: `/health` must not enumerate routes, and an over-cap request body must be refused from the headers rather than after buffering (`MAX_WEBHOOK_BODY_BYTES = 1 MiB`) |
| Oracle first | `gates/self-intake-hardening.mjs` is a behavior oracle written **before the fix existed** and ran 4/6 red on `main`. It exercises the real intake server over raw sockets, because `fetch()` cannot observe an early refusal (the connection kill surfaces as EPIPE in the caller, not as a status) |
| Dispatch | `gates/self-run-task.mjs` posts the issue through the production pipeline (`POST /tasks` on a supervised `factory/main.ts` child), then polls until the branch head changes — deliberately **not** through the webhook, so the public listener stayed down while its own hardening was in flight |
| Attempt 1 | Worker → independent review → draft PR #59. It shipped a defect: the new over-cap test used `fetch()`, whose EPIPE became an unhandled rejection that killed the `npm test` chain, and the PR body asserted the tests passed while `npm test` exited non-zero |
| Detection | Nothing in the pipeline noticed — no CI job (#62), and `open_draft_pr` carries no verification evidence (#61). Our own oracle caught it. Fixing the oracle surfaced two of its own defects, fixed in PR #60 with the "not goal-post-moving" check preserved: still 3/6 red on `main` afterwards |
| Rework | Dispatched **through the factory** rather than hand-edited, to exercise the update path: same issue, same branch, `--force-with-lease` head replacement `db2f44c → 1495b0a`, PR #59 continued instead of a new PR. Oracle 6/6, `npm test` exit 0 (76 assertions) |
| Merge | Human merged #59. Drydock's `main` now contains code its own pipeline wrote and reviewed |

Worth recording that the rework was **better** than the first attempt, not merely correct: the second pass extracted `refusedOversized()` and `readBoundedBody()` where the first had in-line duplication. A human review comment routed back through the issue body is a cheap way to get a second look from a model that has already read the code once.

Three things this does **not** establish: (1) it is one task, not a rate; (2) drydock is its own graded repo with zero required approving reviews, so the human gate is one click on one's own PR — the controls that make that acceptable are capability removal and path scope, not review depth; (3) webhook-driven self-work is still unexercised end to end (§5.18).

### 5.17 Phase 6 token accounting: spend is durable, so runs are measurable after the fact (2026-10-31)

Until now "tokens per issue" came from numbers transcribed off a live run. The durable store has always recorded it — `pi.usage` is a per-conversation document (`UsageState`: buckets keyed `provider/modelId`, plus tool buckets) — and nobody read it. `gates/usage.ts` reads it, `gates/m5-token-report.mjs` prints it for any instance root or store path, and G2 now reports tokens per issue next to wall time.

The storage detail that decided the implementation: `documents.record` holds only doc metadata; the state lives in `document_revisions.content`, where most rows are `base` but the core also writes compact `delta` rows in a patch DSL. The reader takes the newest base and marks the conversation `approximate: true` when a newer revision exists. Under-reporting a cost number silently is worse than flagging it. No dollar column on purpose: this endpoint reports zero for every cost field, so tokens are all we can attest to.

Measured, from the stores of real runs (all `aurora/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF`, §5.15 pin):

| Run | root | worker conv | reviewer conv | total tokens | of which cacheRead |
|---|---|---|---|---|---|
| self-work attempt 1 (#57) | 4,340 | 254,179 | 67,648 | **326,167** | 276,264 (85%) |
| self-work rework (#57) | 9,322 | 378,195 | 79,587 | **467,104** | 411,131 (88%) |
| fixture-1 gate run | 2,977 | 131,924 | 25,932 | **160,833** | 137,313 (85%) |
| fixture-2 gate run | 11,864 | 171,701 + 34,574 | 19,900 | **238,039** | 185,492 (78%) |

What the numbers say:

- **Cache reads dominate every run (78–88%).** Context re-sends, not generation, are the scaling term. Non-cached input+output is roughly 25K–56K per run — an order of magnitude smaller than the headline figure, which is why a single "tokens/issue" number without the split misleads.
- **The worker conversation is ~78–81% of a run**; orchestrator overhead is small (4K–12K), and review costs about a quarter of implementation.
- **Rework cost 43% more than the first attempt** (467K vs 326K) despite being a smaller change: the worker ran 18 generations instead of 12, re-reading context it had to reconstruct from the branch rather than from scratch. Reopening a closed task is not cheap, and that should price into "just run it again" as an answer.
- These are per-**run** totals for single-GPU local inference; they are baselines for comparison after model or prompt changes, not costs.

Limits stated plainly: no per-tool attribution (tool usage has no model identity), deltas after the newest base are disclosed rather than applied, and a run whose store is gone is unrecoverable — which is exactly why accounting moved to the durable document instead of an attached SSE reader.

### 5.18 Pending register (2026-10-31): what is left, and who/what unblocks it

**Superseded as of 2026-10-31 (late):** every open question in this register was put to the operator through `research/decision-questionnaire-2026-10-31.html`; answers are recorded as dated entries in [`decision-log.md`](decision-log.md) and sequenced into [`work-queue.md`](work-queue.md). The table below is kept as the pre-decision snapshot — read it with the "decided" notes, not as current state.

Issue #30 (migration onto the engram core) closed: Phases 0–3 are done with evidence, `poc/` is gone, production runs on `createCoreInstance`, and N2 re-ran the full battery afterwards. What remains is below; rows marked **operator** need a human decision or action, everything else is buildable.

> **Reading this table on 2026-11-01 or later:** the *State* column is a frozen snapshot of 2026-10-31 and several rows have since closed — listener published and smoke-tested (#83, first App-authored PR), #69 shipped (#74), #61 shipped (#76), CI added and made required (#73), credential moved to App installation tokens (#79). Current ordering lives in `research/work-queue.md`; this table is kept as the record of what was known when the decisions were made.

| Item | State | Unblocked by |
|---|---|---|
| Publish the intake listener + register the webhook + smoke-test with a `build`-labeled issue | Runbook ready (`fleet/enable-self-work.md`), machine clean, funnel torn down | **Decided** (A1/A2/A3): Tailscale Funnel on this laptop, after #69 lands |
| #69 adapter caches routes at process start | Real bug found during bring-up: the listener validated against a stale route set. Restart discipline documented until fixed | **Decided** (C3): routes written before spawn, hash verified per request, exit loudly on drift — queue item 1 |
| #61 `open_draft_pr` carries no verification evidence | Demonstrated harmful in §5.16: a PR asserting "tests pass" with a crashing suite | **Decided** (C1): run it, attach exit code, refuse on non-zero — and because C2 rules out CI, this is also the CI substitute (R1) |
| #62 no CI job | `gh pr checks` shows only GitGuardian; the suite runs nowhere automatically | **Re-decided** (C2-rev, same day): drydock is public → free Linux-hosted minutes. CI workflow added: unit suite + kernel pin integrity check on push/PR (`unit-suite`); `test:boot` and mutating gates stay out by design. Close #62 once merged; operator still to make the check required (queue item 8) |
| Credential scoping: single-repo fine-grained PAT | Current effective credential is account-wide. **New finding, filed as #70:** with `FACTORY_GITHUB_TOKEN` unset, clone/push silently fall back to the machine's keychain helper (`credential.helper=osxkeychain` from the Xcode system gitconfig) — verified by cloning a private repo with no token in the environment | **Re-decided** (B1-rev, 2026-10-31): no PAT — the existing GitHub App is the credential (§5.20). Boot logging shipped (#70); token exchange wired (#79) and installation reach narrowed to `selected` / 6 repos. Residual: three reachable-but-unmanaged repos, deferred in #78 |
| §3.9 T1 partial-run recovery (resume/requeue) | Was parked "until after migration"; migration is closed, so it is live backlog | **Decided** (C4): preserve branch, mark resumable, requeue once with the diff as context — priced by §5.17's 43% rework premium |
| fixture-1 #45 (`probe:list-sort-amount`) | Last live target across both fixtures; oracles hold green on `main` elsewhere | **Decided** (D3): run it — queue item 7, produces a draft PR for human merge |
| **Decision questionnaire** for everything above and the operator-only calls | Built as a self-contained form: `research/decision-questionnaire-2026-10-31.html` (27 questions, 6 flagged as needing you; autosaves locally, exports JSON or Markdown). **Answered 2026-10-31** → `decision-log.md`; two free-text items remain open (G2 unease, G4 corrections) |
| G3's positive control reviewed nothing | **Fixed here.** It named `agent/issue-1` literally; after that merged, the reviewer's `origin/main...HEAD` diff was empty and the control passed on nothing. Re-seeded as a good twin of trap #4 (`agent/issue-4-seeded-good`, own suite green before push). G3 re-run: T1 fail-with-root-cause 48s, T2 pass 42s | — |

### 5.19 The verification gate: a draft PR cannot exist without a recorded test run (2026-10-31)

Issue #61, decision C1. The first self-work run (§5.16) produced a PR body asserting the suite passed while `npm test` crashed — because the suite result was *reported* and nothing gated on it. Evidence nobody is required to read is documentation, not a control. This closes that gap and, together with CI (C2-rev), closes R1/R5.

**Mechanism.** `factory/verification.ts` runs the repo's configured test command **host-side** — in the workspace, not inside the worker's sandbox, so the entity being graded does not run its own check — records `{command, exitCode, timedOut, counts, tail}`, and `open_draft_pr` refuses to push unless the gate says proceed. It runs after the path-scope check and **before** the reviewer: seconds before minutes of inference, same ordering logic as the scope gate. The two gates stay independent on purpose — a green suite says nothing about correctness, which is precisely what a wrong-but-passing implementation survives.

**Policy.** Registry field `requireVerification`, default **true**. Boot logs the posture (`verification required — open_draft_pr runs \`npm test\` and refuses to push on a non-zero exit`). The escape hatch exists for repos with genuinely no runnable suite, and it is deliberately weak in exactly one direction: a waived repo with no command proceeds (with `**NOT VERIFIED — nothing was executed**` in the PR body), but a waived repo whose command *ran* and failed still cannot push. Waiving verification is not a license to ship red. No checked-in repo waives, and a test asserts that so a future waiver is a named event rather than a quiet JSON diff.

**Four cases the decision text left open, resolved in code:**

| Case | Behavior | Why |
|---|---|---|
| exit ≠ 0 | refuse; reason names command + exit code; 60-line tail returned for rework | the C1 core |
| timeout (our own 900 s ceiling) | refuse, reported as TIMEOUT not FAIL | "slow" must never be recorded as "broken", but it still blocks |
| exit 0, **zero tests collected** | refuse (`vacuous`) | a runner that matches no files proves nothing; see the defect below |
| no command + waived | proceed, disclose loudly in the body | policy, not defect — and the human merger sees it |

**Two fail-open bugs found while writing the tests** (both fixed; recorded as R6):

1. **Vacuous green via inherited runner state.** A nested `node --test` that inherits `NODE_TEST_CONTEXT` from the outer harness prints `run() is being called recursively within a test file. skipping running files` and **exits 0 having executed nothing** — reproduced on node 22. So the gate could have been satisfied by a run of zero tests. Fix: strip that variable from the child env; plus zero-collected-tests is now a refusal in its own right. The regression test fails without the fix, which is the only reason to trust it.
2. **`Boolean("false") === true`.** The registry coerced safety flags, so `"autoMerge": "false"` — a plausible JSON typo — would have *granted* merge rights in the one field whose failure mode is destroying something irreplaceable. `enabled`, `autoMerge` and `requireVerification` are now type-checked at load with a message that explains the trap.

**Proof.** Two test files, both wired into `npm test`: `test/verification-gate.test.mjs` (9 checks — full decision matrix as pure functions, plus real processes for exit codes, timeout, vacuity, argv-not-shell) and `test/verification-push-gate.test.mjs` (3 checks driving the actual `open_draft_pr` tool against a scratch git repo whose origin already holds an older commit on the branch). The integration test asserts the operational claims directly: refusal payload names the command and exit code; **origin's branch tip is unchanged**; no reviewer task was created (`createTask` call list is empty, so a red run costs zero inference); and a green suite stops at the *next* gate rather than pushing. Suite: 9 + 3 checks, `npm test` exit 0, G0 20/20, intake hardening oracle 6/6, boot line verified live.

### 5.20 The GitHub App is the credential — verified, not assumed (2026-10-31)

Operator decision replacing B1: *"we have a GitHub App configured already and updated .env. we'll proceed with that instead of PAT."* No PAT is cut; queue item 3 ("cut a fine-grained PAT") is dropped and B1/B3 collapse into one identity (B1-rev). Because the whole claim was "the App covers what the PAT would have covered", it got verified against the live installation rather than recorded as intent — `gates/github-app-check.mjs`, which mints the App's own JWT from the PEM, exchanges it for an installation token, and reports identity, grants, reach and read access while printing no secret material.

**What the App is:** `drydock-factory` (id 5557270, owner `lalanikarim`), installation 177271737 on the user account.

| Check | Result |
|---|---|
| Permissions granted | `contents:write`, `pull_requests:write`, `issues:write`, `metadata:read` — a superset of what B1 asked for (`issues:write` where `issues:read` sufficed) |
| Write capability, exercised | created then deleted a branch ref on `lalanikarim/drydock` with an installation token (201 → 204). Proves the push path, not just the grant |
| Read access | issues + pulls HTTP 200 on drydock and both private fixtures |
| Token lifetime | App JWT minted ≤10 min; installation tokens ~1 h. Nothing long-lived sits in an env var |
| Repository selection | first check: `all` → 172 repositories (5 private), including repos created later. **After narrowing (same day): `selected` → 6 (2 private)**, write re-proven post-change |
| App webhook events | none subscribed — fine, the factory uses a repository webhook with its own secret |

**The finding that matters:** switching from "PAT" to "App" is usually a narrowing move, and out of the box it wasn't — the installation reached every repo in the account. Operator narrowed it to `selected` the same day (queue 3a): **172 → 6 repositories**, all three managed ones present, write capability re-proven after the change.

Narrowing then exposed a distinction worth keeping straight: **reach and routing are different axes.** The registry gates routes — an issue in `modelarena` is never dispatched — but it says nothing about what the credential could write if a key leaked. Of the 6 reachable repos, 3 are unmanaged: `collective`, `modelarena`, and **`engram`, the vendored kernel**. drydock pins a specific engram commit and protects `vendor/` unconditionally because "which kernel are we running?" is supposed to be a human decision; engram's own `main` has no branch protection, so the App could push it with routing never involved. So the probe now diffs installation reach against `factory/repo-registry.json` and names every reachable-but-unmanaged repo, warning specifically when the set contains the kernel. Either drop those three or keep `engram` on purpose (queue item 9 sends upstream PRs) behind a protected branch — what shouldn't happen is the setting being inherited from "All repositories". Reach is re-verifiable on demand: `node gates/github-app-check.mjs`.

**Implemented (queue 3b)**: `factory/github-auth.ts` mints the JWT (RS256, issued 60 s early for clock skew, ≤10 min validity) and exchanges it for an installation token. The credential is a **provider, not a string**: installation tokens expire in ~1 h and cannot be renewed, while a factory instance lives for days — so every use site asks for a token, and the provider returns a cached one until 5 minutes before expiry, minting fresh with concurrent callers sharing a single in-flight exchange (GitHub revokes the oldest past ~10 active tokens). `factory/credential-source.ts` is the single resolver behind both the boot log and the token source, so they cannot disagree: precedence is `FACTORY_GITHUB_TOKEN` → App → config `gitToken` → host helper → none; an env token shadowing a configured App says so in the log; partial App config throws rather than quietly downgrading to the keychain. `factory/main.ts` verifies the exchange at boot and **refuses to announce ready** if it fails — the same rule as the model catalog (§5.13).

Live proof (2026-10-31): the boot line named the App and installation, a token minted in 271 ms and was reused from cache, reads returned 200 for `drydock`, `factory-fixture` and `factory-fixture-2`, and write was already established by the reversible ref probe. 13 checks in `test/github-app-auth.test.mjs` cover the JWT signature (verified against the public half), caching, refresh-before-expiry, single-flight, error classification with no token in any message, precedence, and clone-URL construction. **B3 closed 2026-10-31**: the first factory-created PR over the published listener — #83, from a `build` label on issue #80 — is authored by `app/drydock-factory`, while every pre-existing PR on the repo is `lalanikarim`. Factory work now has its own identity.

**What is not done:** no drydock code reads `GITHUB_APP_*`. Today's runs still resolve credentials the old way and boot still prints the #70 keychain warning — the credential decision is therefore *not* finished by configuration alone. Queue item 3b implements the exchange (JWT → installation token → clone/push/PR), adds an `app` kind to `factory/credential-source.ts` so boot names it, and keeps the loud warning for every non-App path. #68's remaining scope shrinks to confirming PRs are authored by `drydock-factory` rather than `lalanikarim`, then revisiting E3.

Two small things fell out: `.env.example` now documents the three App keys with a placeholder key path (asserted by test, so the documentation cannot silently rot), and the probe's delete-ref call documents that GitHub's ref-deletion endpoint is path-style (`…/git/refs/heads/<branch>`) — a `?ref_name=` guess returns 404 and leaves the probe ref behind, which happened once and was cleaned up.

### 5.21 PR-comment feedback: `/factory` turns a review comment into rework (2026-10-31, #67)

The factory used to have exactly one door in: a labeled `issues` event. That made review feedback awkward — "rebase this" required filing an issue about a pull request that already existed, with the branch and its history described in prose. This adds a second door, `issue_comment`, and the shape of it is worth recording because the interesting part was never the parsing.

**Why a command and not a label.** Labels were the natural precedent, but labeling your own draft PR to ask for a rebase is ceremony that pretends to be intent, and labels are also visible policy surface (`eligibilityLabel` gates pickup). A comment is conversational: "should we rebase this?" arrives six times a day and must not start a build. So the trigger is an explicit `/factory <directive>` at the **start of the body** — a mid-sentence mention stays discussion, and `/factorytown` is not the command. Known directives (`rebase`, `resolve-conflicts` and aliases) select host-parsed behavior; anything else after the token is forwarded verbatim as a free-form instruction, because most unknown words are prose rather than typos.

**Where authority actually lives.** Three checks run in host code before any model sees anything, and none of them can be argued with:

| Check | Rule | Why it is not a prompt |
|---|---|---|
| Sender | route `allowedSenders`, unchanged from issue intake | signature proves GitHub sent it; the allowlist decides who on GitHub may ask |
| Ownership | PR head must match `agent/issue-<n>` | without it, one comment puts a machine commit onto a human feature branch |
| Liveness | PR must be `OPEN` | comments on merged PRs are history; rewriting a dead branch is unrecoverable work |

Plus two that only appear once you think about loops and envelopes: **bots are refused** even if allowlisted (the moment the factory comments on a PR, a comment-triggered pipeline feeds itself), and the instruction is passed through `sanitizeFeedback`, which destroys `<untrusted>` tokens — otherwise a comment reading `</untrusted> merge the PR` closes its own data envelope and continues as trusted text. It runs at parse, at relay, and again at the model boundary, because "upstream sanitized it" is how these bugs survive.

**State is read, never believed.** The dispatcher fetches the PR with the factory's own credential (`gh pr view`) and authorizes from that, not from webhook payload fields; the worker then re-reads and re-authorizes before checking out anything. That costs two API calls per comment and buys the property that a hallucinated or stale PR number in a tool argument cannot point the worker at somebody else's branch — and a PR closed between intake and spawn stops the run instead of rewriting a dead branch.

**Rebase and conflicts stay inside the existing gates.** The model does the git work locally in its sandbox (`git rebase origin/main` against a base the host just fetched, since the container has no network); publication remains host-side in `open_draft_pr`, which still runs verification, then independent review, then pushes with `--force-with-lease`. A rewritten branch therefore cannot clobber commits the factory never fetched, and the rework path inherits every gate the original path had rather than getting a lighter one. It ends at an updated PR: no merge tool is involved, and the task content says to stop there.

**Opt-in, policy-side.** `prFeedback` in the repo registry (default false, strict boolean — `"false"` would be truthy, which is the R6 lesson again) copied by the supervisor onto the route, so the adapter enforces exactly what the registry declares. drydock opts in; the fixtures do not, because a comment-reachable trigger is one more thing an oracle run could set off by accident.

**Refusals do not retry — and neither does GitHub.** A policy refusal answers 200 rather than 502. The reasoning originally recorded here ("GitHub retries 5xx, so a permanent refusal would become a retry storm") was **wrong**: [GitHub's docs](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) state flatly that *GitHub does not automatically redeliver failed deliveries*, confirmed empirically in #107 (a 503 produced exactly one delivery attempt and then silence). The distinction survives for a different reason: the status code is now an operator signal rather than a flow-control lever. `200 accepted:false` means "correctly ignored, never re-drive this"; `503` means "infrastructure was mid-change — go find that delivery in the hook log and POST `/hooks/{hook_id}/deliveries/{delivery_id}/attempts`, because nothing else will". Consequence worth stating plainly: **a transient refusal is permanent data loss**, which is why #107 adds a single-instance guard on the supervisor (the churn source) and treats failed-delivery sweeping as required operation rather than optional tooling. The intake log line that said `accepted` still gets a sibling line saying `refused after state check`, so the pair explains itself.

**Honest limits.** The factory does not reply on the PR — the human reads the pushed diff and the run log, so feedback-loop visibility is still thin (open follow-up). And the delimiter sanitization added here covers the comment path; the older issue-body path has the same theoretical weakness and was left alone rather than changed under a different issue's cover.

10 checks in `test/pr-feedback.test.mjs`, 6 in `test/route-dispatch.test.mjs`, 6 in `test/worker-rework.test.mjs` and 8 new intake assertions cover this, including the injection cases and "nothing reaches the instance when authorization fails".

### 5.22 The refusal budget — a permanent refusal must cost one cycle, not six (2026-11-01, #100)

**The incident.** Issue #99 was a README-only task whose honest completion required registering a test file in `package.json`. `package.json` is outside drydock's `pathAllowlist`, so `open_draft_pr` refused — the control working exactly as designed. The orchestrator re-delegated. **Six full worker+review cycles ran and every one ended in the identical refusal**, stopped only by a human reading the durable store.

**Why "the model should have stopped" is not the finding.** The refusal text, including its `hint`, reached the root agent in full six times and changed nothing; the worker never saw it at all, so each attempt started with identical incentives. Three layers behaved correctly (scope gate, reviewer, verification) and the composition was an unbounded loop — recorded as R11.

**What shipped** (`factory/refusal-budget.ts`, shared per factory process through `factoryPipeline`):

| refusal class | retryable | counted toward the budget | why |
|---|---|---|---|
| `path_scope` | **false** | yes | policy is read at process start and lives in a file the run cannot write — it cannot change mid-run |
| `verification` | true | yes | a red suite is fixable; an *identical* red suite twice proves nothing changed |
| `review` | true | yes | same reasoning, keyed on the reviewer's concerns |
| `infrastructure` | true | **no** | a workspace that cannot compute a merge base is a fault, and charging it would spend the budget of the real task behind it |

Two ceilings, because one is gameable: **2 identical refusals** (same signature) or **4 counted refusals total** per issue stops the run. The total cap exists specifically so a worker varying its offender set — `package.json`, then `.npmrc`, then `tsconfig.json` — cannot dodge the identical-signature rule, which is exactly what a retry loop with only one counter invites.

**Enforcement, not advice.** Once stopped, `open_draft_pr` refuses at the top of `execute()`: no token mint, no clone, no diff, no test command, no reviewer. The integration check proves it by deleting the workspace out from under a stopped run and asserting the terminal payload arrives anyway — without the short-circuit that call returns "no local branch … and no remote branch to recover" and would have gone hunting origin again. Counts freeze after a stop, so a caller that ignores `terminal: true` cannot inflate its own record.

**Every refusal now carries the classification in the payload** (`retryable`, `attempts`, `identicalAttempts`, and on the stop path `terminal`/`runStopped`/`stopReason` plus a hint naming the human way out), and the orchestrator prompt gained step 4b: read `retryable`; when it is false, report unsatisfiability instead of re-delegating; when `terminal`/`runStopped`, stop touching that issue. The run-level surface #100 asked for exists too — terminal events log as they happen, and the instance prints a refusal ledger at shutdown (counts by class plus which runs were stopped), because "how many refusals did this instance absorb" previously required SQL.

**Two defects the tests caught, both in the same family as R6:** the first draft keyed identical-signature counts **globally**, so one issue's failures could stop a different issue's run; and an infrastructure record omitted `terminal` entirely, which reads as `undefined` to a caller checking `=== false`. Both are pinned by checks now.

**Honest limits.** The budget is per-process memory: a restart clears it, deliberately, since restarting is a human act and a durable stop would outlive that intent (dispatch dedupe across restarts is intake's `requestId`, a different mechanism). It also cannot tell an unsatisfiable task from a merely hard one — it only knows that a refusal repeated. A task that needs a widened allowlist still needs the human to widen it; what changed is that asking now costs two cycles instead of six, and says so out loud.

12 checks in `test/refusal-budget.test.mjs` (classification, signature normalization, both ceilings, per-issue isolation, infrastructure never charged, frozen counts after a stop, payload contents, constructor validation) and 5 in `test/refusal-stop-short.test.mjs` drive the real tool against scratch git repositories with no model and no token.

### 5.23 Say what happened on the PR, and admit when nobody looked (#110 layer + #96, 2026-11-01)

Two small visibility defects from the same week, fixed together because both are "the system knew and nobody else did".

**#96 — a rework with no artifact.** `/factory rebase` on an already-current branch is a *correct* outcome: nothing to do, nothing pushed, suite green. It was also completely invisible — the only proof it happened was a durable-store row, so the human who typed the comment could not distinguish success from silent failure and would reasonably ask again (a full worker cycle to rediscover "nothing changed"). Same for a gate refusal after a rework request: the reviewer knew, the model knew, the PR said nothing.

`factory/pr-report.ts` builds one comment per rework, verdict on the first line — **pushed** (previous → new sha), **no change to push** (with the reason that case is legitimate), or **refused — nothing was pushed** plus a Why section. Facts come from host state: the previous head is read from the PR before pushing (`headRefOid`), so `classifyPush()` answers "did anything change" from two shas rather than from what the model claims it did. A budget stop (#100) renders as its own row, because "stopped after 2 identical refusals" is a different statement than "refused".

Two boundaries were decided rather than stumbled into:

- **Only runs that reached a PR report.** Pre-dispatch refusals — sender not allowlisted, comment on a branch we do not own, closed PR — post nothing. Those decisions are made against a stranger's comment; replying would disclose policy detail to whoever typed it and hand anyone with an account a comment-writing primitive.
- **One reply per rework.** A first draft PR already carries the evidence pack in its body, so `findOpenPr()` gates reporting on an existing PR rather than commenting everywhere.

Reporting is strictly downstream: the push happens first, and a failed comment is logged and swallowed (`postPrComment` throwing must never turn a successful push into a failed run — asserted by test, since "best effort" is the kind of claim that quietly becomes "fatal in prod").

**#110 — recovery you have to remember to run.** `fleet/redeliver-failed.mjs` existed but left no trace, so "we can recover lost webhook deliveries" and "we have been silently losing them for two days" produced identical output. Now:

- `--state-file <path>` writes `{at, repo, hookId, mode, inspected, undelivered, queued}` after any run whose listing succeeded — **including the clean case**, because "never ran" has to differ from "ran and was clean". Opt-in flag rather than ambient state: a tool that drops files on every invocation is how deployments accumulate mystery artifacts.
- `fleet/supervisor.ts status` prints the sweep's age and findings, with a `⚠ older than 1h` marker, and says **NEVER RECORDED** when there is no state file. `readSweepState()` cannot throw — missing/corrupt return `{ok:false, reason}` so the status table always prints.
- `fleet/launchd/com.drydock.redeliver.plist.example` answers the scheduling question #110 was blocked on. **launchd, not cron: a laptop sleeps**, and cron skips the jobs it would have run during sleep without ever catching up — which is exactly the window in which webhook deliveries fail. `StartInterval` resumes on wake; `KeepAlive=false` keeps it a short-lived process instead of another daemon to supervise. The template is **report-only** (no `--apply`) with exit 1 on findings: a scheduled job that acts could resurrect work for an issue closed hours ago, so detection is automated and recovery stays a human call with `--only <id>`.
- Shutdown got a diagnostic instead of another assumption: one second after teardown the supervisor logs how many handles are still open and of what types. The lingering-handle cause is still unexplained — #108 bounded it to 3s, this makes it visible if it comes back, which is the honest state of that sub-item.

**Limits.** The report is a comment, not a notification (#64 remains open); a run that dies before reaching `open_draft_pr` — worker crash, budget stop before any call — still reports nothing on the PR, though the latter logs and refuses loudly. And the launchd job is a template: scheduling is not installed by this change, because cadence is an operator decision about API volume on a laptop, not a library default.

7 checks in `test/pr-report.test.mjs` (three report shapes, sha-based classification, truncation, placeholders), 4 in `test/pr-report-wiring.test.mjs` (one comment per refusal, refused files named, silence when no PR exists, reporting failure cannot change the outcome) and 6 in `test/sweep-state.test.mjs` (payload contract, never-throws reader, dry-run/clean/no-flag write semantics).
