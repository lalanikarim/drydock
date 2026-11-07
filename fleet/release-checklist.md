# Release checklist (C5) — one page, referenced from `enable-self-work.md` §13

Compiled 2026-11-04. Every number below was measured on this fleet, not copied from a spec. The point of this page is
that a release has an **order**, and the interesting failures are the steps that look green while measuring nothing.

## Step 0 — does this change need a release at all?

| your diff touches | local suite | gate battery | fleet restart |
|---|---|---|---|
| `research/**`, `fleet/*.md` docs | no (docs only) | no | **no** |
| `test/**`, `gates/**` (no runtime import) | yes | the gates you changed | **no** |
| `factory/**`, `fleet/*.ts`, `vendor/engram` pin, `gate-policy.ts` | yes | **full battery for a pin bump or any posture change** | **yes — owed, not optional** |
| `$DRYDOCK_CONFIG_DIR/repo-registry.json` (policy) | n/a — not in the tree (§5.31), so no diff touches it | `npm run gate:registry` on this host | **yes — routes and scope are read at start** |

"Posture change" = anything that alters what the agent may do or how it is verified: toolset, gates config, approval
tiers, auto-merge, test command, **where the test command runs** (#247), model pin. If your diff touches
`factory/container.ts`, `factory/verification.ts` or a repo's `verificationMode`, run `npm run gate:verification` on the
factory host — it is one command and it checks containment against the real runtime, not against a stub. A pin bump changes runtime code you did not read, so it takes the full
battery even when the diff is one line.

## Step 1 — local, before anything is pushed

```bash
npm run verify        # typecheck + pipeline/intake tests + unit suite; expect "fail 0"
npm run test:boot     # real kernel + live inference: core spike, pipeline boot, intake boot
```

`test:boot` is **host-tier** (#241): it needs live inference, GitHub runners cannot reach the endpoint, and CI therefore
never runs it — which is exactly how all three of its suites sat red with a green pipeline above them. Two things make
that blind spot structural now rather than a reminder:

- `test/test-collection.test.mjs` (part of `npm test`, so CI enforces it) fails if any suite is neither collected from
  CI's own commands nor declared host-tier with a `// manual-only:` header naming the script that runs it. Deleting the
  marker, or letting a suite become an orphan, is red.
- The suites no longer choose their own model. They resolve `DEFAULT_MODEL`, else production's pin at
  `$DRYDOCK_CONFIG_DIR/lalanikarim_drydock.json`, verify it is served, and skip with a reason rather than falling back
  to whatever `/models` returns first. Taking `data[0].id` is what broke: the list reordered, the chosen model accepted
  submissions and never generated, and the printed diagnosis ("provider unreachable") was false.

When you change **how configuration is resolved**, run the suite the way a runner does — an empty home and no
deployment env — because that is the only run that can tell a seam from a decoration:

```bash
mkdir -p /tmp/cihome
env -u DRYDOCK_CONFIG_DIR -u DRYDOCK_REGISTRY_PATH -u PI_AGENT_DIR HOME=/tmp/cihome npm test
```

A resolution change verified only on the factory host passes for the wrong reason: your `~/.drydock` answers
whatever the code asked. This caught #259's first push, where one of two calls in a test still read the default.

Policy changes are not diffs any more. The repo registry is deployment state (§5.31), so `git diff` cannot show you
that auto-merge or a path scope changed; `npm run gate:registry` reads the live file and fails on the posture rules CI
used to assert when the registry was tracked (nothing waives verification, no allowlist grants `.github`, drydock
cannot self-merge, `gates/probes/` protected), and `--self-test` proves those rules can still fire.

Because a skip exits 0, count results instead of trusting the exit code — and never take an exit code through a pipe:

```bash
set -o pipefail
npm run test:boot 2>&1 | tee /tmp/boot.log
grep -c "all checks passed" /tmp/boot.log   # must be 3 — one per suite, same shape in all three (#241)
grep -c "SKIP" /tmp/boot.log                # must be 0; a skip is not a pass (#241)
```

Last run on the host at `0cb9382` (2026-11-07): `npm run verify` → 728 tests, 0 fail (one pre-existing skip);
`test:boot` → both boot suites "all checks passed", 0 skips, model resolved from `drydock-config`;
`npm run gate:registry` → inspected 5 enabled of 5 entries, 2 known warnings (#259 residual: `factory/` in drydock's
own scope, fixtures without a webhookId); `npm run gate:verification` → all #247 checks passed against the real
runtime; `fleet/verify-deploy-posture.mjs` → PASS.

## Step 2 — infrastructure truth, before your code is blamed for it

```bash
node --experimental-strip-types gates/github-app-check.mjs   # App installation + permission shape, per managed repo
curl -s http://127.0.0.1:9700/health                         # status, build.sha, inference state
```

**Corrected 2026-11-04:** this page used to list `node gates/registry-targets.mjs` as a step. That file is a **library** —
it exports `registryRepoNames()` for `github-app-check.mjs` and `test/config-driven-targets.test.mjs`, has no entry point,
prints nothing, and exits 0. Running it verified nothing while reporting success, which is the exact failure mode §R6b/R10
exists to catch ("not collected" and "passing" are the same color). Per-repo reachability is `github-app-check`'s job: it
prints one line per registry-derived repo (`lalanikarim/engram: issues HTTP 200, pulls HTTP 200`) and warns when the App's
reach exceeds the registry.

Read `inference.state` before diagnosing anything else. A boot that fails because the endpoint is down exhausts the
restart budget, and `giveUp()` takes the adapter with it — **webhook deliveries during that window are lost, GitHub
does not retry them** (§10). Check this before suspecting the commit you just landed.

## Step 3 — the battery (only for pin bumps and posture changes)

Prerequisites in §12 are load-bearing; the two that bite hardest:

- **Targets are consumables.** Fixture issues get merged by the run that consumes them. List what is open *first*
  (`gh issue list --repo lalanikarim/factory-fixture --state open`) and seed from the **running app** — start it and
  `curl` candidates until a defect is verifiably absent, then paste the transcript into the issue body.
- **The fixture base must be green.** Run its own suite on that commit before spending agent time. A red base silently
  adds "make the tests pass" to every arm's task list and edits unrelated files; it invalidated a full G5 run on
  2026-11-04, and both arms looked like results.

| change | minimum honest battery |
|---|---|
| model pin (`models.modelId`) | `g0` intake, `g1` orchestration, `g2` worker quality, `m5` token report |
| gates/tiers/toolset | `g1`, `g3` reviewer, `g4` merge gate, `behavior-probes`, `shutdown-handles` |
| adapter/transport/supervisor | `m1` two repos, `m2` isolation, `m4` budget, plus §10's shutdown verification |
| lessons/feedback loop | `g5` — needs a fresh **equivalent pair**, one issue per arm (see `fleet/factory-lessons.md`) |

**Corrected 2026-11-04: two names in that table are not runnable gates.** `gates/behavior-probes.mjs` is a **library**
(its own header says "deliberately no invocation example: running this file does nothing") — it is read by
`g2-worker-quality.mjs`. `gates/shutdown-handles.mjs` is a CLI but requires `--fleet <isolated fleet.json>` and, given
none, prints its usage text and **exits 0**. Invoking either from a script reports green while measuring nothing — the
third instance of this pattern alongside `registry-targets.mjs` above. Run the gate that *consumes* the library
(`g2`), and give `shutdown-handles` an isolated fleet file before believing it.

Run gates **sequentially** and capture exit codes; two of nine historical failures were fast `exit 2`s that a naive
loop scored as done. An `exit 0` from a gate that printed no assertions belongs in the same distrust bucket: check what
it collected. G5's verdict is not final until both arms' diffs have been read by hand — the classifier can be
blind to a correct fix (reuse of an existing shared rule was invisible to it until #201).

## Step 4 — merge, then restart (§8/§10 recipe; this part is not skippable)

```bash
kill -TERM $(cat fleet/data/routes.json.lock)   # ONE TERM. Never start with -9.
# watch: "all child groups settled — exiting early (deadline was 3000 ms)"  → ~2 s on a healthy fleet
cat fleet/data/routes.json.lock 2>/dev/null || echo "lock released"
lsof -nP -i :9700 || true                        # listener released
pgrep -fl "factory/main[.]ts|adapter[.]ts" || echo "no orphans"
podman ps --filter name=engram-sbx --format "{{.Names}} {{.Status}}"   # no sandbox outlived the instance

nohup node --experimental-strip-types fleet/supervisor.ts run fleet/fleet.local.json > /tmp/fleet-$(git rev-parse --short HEAD).log 2>&1 &
```

A second `SIGTERM` exits immediately and `SIGKILL`s what is left — that is the supported escalation. Going straight to
`kill -9` is what produced the orphans in #125. If you must inspect after a crash, `factory-instances/*/orphan-events.log`
records deaths the dead stdout pipe could not (§10).

**Stopping one run instead of the fleet:** `POST /factory/runs/abort` has two shapes and they are not equivalent —
`taskId` settles a task while the orchestration conversation keeps delegating, `conversationId` stops the loop.
See [`runbook-aborts.md`](runbook-aborts.md) before reaching for either (#222, learned at 2× budget).

## Step 5 — prove the running thing is the thing you released

If the release touched the retry guard or the issue projection (`factory/issue-body-sha.ts`, `gh-read.ts`), run the
#238 live gate before believing the hermetic suite: `node gates/scope-claim-live.mjs <owner/repo> <issue>` must print
`abort == retry : yes`. That single line is what the unit tests structurally cannot prove — that the bytes hashed at
abort and the bytes re-read at retry come from the same projection. It found two defects the suite passed over.

**Run the command, not your memory of it:**

```bash
node --experimental-strip-types fleet/verify-deploy-posture.mjs   # seven rows, observed values, PASS/FAIL (#220)
```

It asserts build identity, process parenting, quarantine, gate-posture drift, the kernel's startup posture line, and the
approval/settlement probes — printing what each one *collected*, so a check over an empty set cannot read as green. Exit 1
means a row failed; exit 2 means it could not run (no lock file), which is deliberately not the same as failing. The manual
commands below stay as the fallback and as what to read when a row is red.

```bash
curl -s http://127.0.0.1:9700/health    # build.sha MUST equal the merge commit you deployed
ps -eo pid,ppid,command | grep -E "factory/main[.]ts|adapter[.]ts"   # every child's ppid = supervisor
grep -ci quarantin /tmp/fleet-*.log     # 0 unless a repo genuinely failed to boot (#185)
node --experimental-strip-types gates/approval-block-probe.mjs       # detection still explains real stores (#188)
node --experimental-strip-types gates/deploy-posture.mjs             # on-disk gates.json == gate-policy.ts, per instance (#220)
node --experimental-strip-types gates/settlement-window.mjs          # exits 0 only when every alarming row is examined
npm run gate:verification                                            # the push gate still runs repo code SEALED, and leaves nothing behind (#247)
```

`gate:verification` needs no model endpoint and no GitHub credential — it drives `verifyWorkspace` directly against podman
and asserts the four things that matter: the suite ran in the container (observable: a file written from inside), no host
secret crossed the boundary, there is no egress, and a timed-out run leaves zero containers behind. It fails if the runtime
is missing, because on this host the runtime is a dependency of verification.

**Why `deploy-posture.mjs` is on this list (#220, 2026-11-05).** Each instance's `config/gates.json` is written at boot by
whichever build was running, so the file describes *that* build — if main narrows or widens the destructive floor and nobody
restarts, disk and code disagree and nothing says so. I had been "verifying posture" with `gates/gate-posture.mjs`, a command
that has never existed in this repository, piped into `tail -2` — which reports `tail`'s exit status, so Node's
`MODULE_NOT_FOUND` traceback exited **0** and the step looked green. Two lessons, both already written down elsewhere and both
reproduced anyway: a verification step must name a file that exists, and never take an exit code through a pipe (`cmd; echo $?`
or `set -o pipefail`, not `cmd | tail`). The gate prints `inspected N of M declared instance(s)` on every run and refuses to
exit 0 when `M` is zero, because "not collected" and "passing" are the same color.

**Reading it (#204).** The window alarms only for rows nobody has examined, and "examined" is now a recorded state:

```console
$ node --experimental-strip-types gates/settlement-window.mjs \
      --ack lalanikarim_engram/task:46 --ack-reason "sandbox npm build failed then; historical, not an incident"
```

An ack keeps the row **counted** and stops it alarming; un-acking is deleting one key from
`fleet/data/last-settlements.json`. `--reset-watermark` is not a shortcut for this — it clears marks for every family,
including ones being tracked correctly, and makes the next real failure look like the one you just dismissed. Four pre-#188
engram rows were acknowledged on 2026-11-04 with reasons in that file, so a red window means news again. Verify that claim
rather than trusting it: after any ack, `exit 0` must be accompanied by the watermark advancing in the state file — the
class of bug here was an alarm that could never finish, and "I muted it" looks identical to "it drained" until you read the
file. Rows attributed from conversation evidence say so in their detail; rows sharing a conversation with a marker are
annotated, not reclassified, because attribution to a task id is not available in the store.

`status:"ok"` means the listener lives, **not** that work will complete. What `/health` cannot see is a host answering
`/models` without the pinned model loaded — those failures surface as task outcomes carrying
`error.detail.reason: "no_model"`, not as an outage (#161 follow-up).

## Step 6 — record it, while the evidence is on screen

Decision log entry (what shipped, what you measured, what you did **not** claim), queue refresh, and the deploy SHA.
Undated findings are rumors. If a step behaved differently than this page, fix the page in the same PR — a runbook that
drifts from the system is worse than no runbook.

## Rollback

§"Rollback" of `enable-self-work.md`. Short version: revert the merge commit, restart with the same recipe, and confirm
`/health` reports the older `build.sha`. The store format is owned by the kernel; a pin **down** bump needs
`gates/backup-drill.mjs`'s restore path rehearsed before you rely on it (§11), because old code reading new records is
the one direction nobody tests by default.

## What this checklist does not cover

Stopping an individual run or an orchestration loop is [`runbook-aborts.md`](runbook-aborts.md), not this file.

Per-task token annotation (E4) is deferred P2 — spend is still reconstructible from durable records via
`gates/m5-token-report.mjs`, just not per task row. Fixture `main` has no branch protection at all (R14, accepted): a
battery run can land a bad commit with nothing between it and `main`, which is why fixtures hold disposable targets only.
