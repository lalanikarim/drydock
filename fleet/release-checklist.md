# Release checklist (C5) — one page, referenced from `enable-self-work.md` §13

Compiled 2026-11-04. Every number below was measured on this fleet, not copied from a spec. The point of this page is
that a release has an **order**, and the interesting failures are the steps that look green while measuring nothing.

## Step 0 — does this change need a release at all?

| your diff touches | local suite | gate battery | fleet restart |
|---|---|---|---|
| `research/**`, `fleet/*.md` docs | no (docs only) | no | **no** |
| `test/**`, `gates/**` (no runtime import) | yes | the gates you changed | **no** |
| `factory/**`, `fleet/*.ts`, `vendor/engram` pin, `factory/repo-registry.json`, `gate-policy.ts` | yes | **full battery for a pin bump or any posture change** | **yes — owed, not optional** |

"Posture change" = anything that alters what the agent may do or how it is verified: toolset, gates config, approval
tiers, auto-merge, test command, model pin. A pin bump changes runtime code you did not read, so it takes the full
battery even when the diff is one line.

## Step 1 — local, before anything is pushed

```bash
npm run verify        # typecheck + pipeline/intake tests + unit suite; expect "fail 0"
npm run test:boot     # real kernel + live inference: core spike, pipeline boot, intake boot
```

`test:boot` skips cleanly when the inference endpoint is unreachable. **A skip is not a pass** — if it skipped, say so
in the PR rather than reporting green. Both commands were last run against production data at `603553f`: 592 tests /
591 pass / 0 fail (one pre-existing skip).

## Step 2 — infrastructure truth, before your code is blamed for it

```bash
node --experimental-strip-types gates/github-app-check.mjs   # App installation + permission shape
node --experimental-strip-types gates/registry-targets.mjs   # every managed repo resolves and is reachable
curl -s http://127.0.0.1:9700/health                         # status, build.sha, inference state
```

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

Run gates **sequentially** and capture exit codes; two of nine historical failures were fast `exit 2`s that a naive
loop scored as done. G5's verdict is not final until both arms' diffs have been read by hand — the classifier can be
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

## Step 5 — prove the running thing is the thing you released

```bash
curl -s http://127.0.0.1:9700/health    # build.sha MUST equal the merge commit you deployed
ps -eo pid,ppid,command | grep -E "factory/main[.]ts|adapter[.]ts"   # every child's ppid = supervisor
grep -ci quarantin /tmp/fleet-*.log     # 0 unless a repo genuinely failed to boot (#185)
node --experimental-strip-types gates/approval-block-probe.mjs       # detection still explains real stores (#188)
node --experimental-strip-types gates/settlement-window.mjs          # read the ids, not just the color — see below
```

**Known state while #204 is open:** on this fleet the settlement window exits 2 with four *historical* engram rows
(two `setup command failed`, two `reviewer never called submit_verdict`) and cannot drain, because it refuses to advance
its watermark while anything alarms and there is no way to record that a row was examined. So "read the ids" is the step:
compare against those four, and treat only unseen ids as news. Do not paper over it with `--reset-watermark` — that clears
marks for every family, including ones being tracked correctly, and it makes the next real failure look like this one.
Delete this paragraph when #204 lands; until then, a red window is expected output and therefore not evidence.

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

Per-task token annotation (E4) is deferred P2 — spend is still reconstructible from durable records via
`gates/m5-token-report.mjs`, just not per task row. Fixture `main` has no branch protection at all (R14, accepted): a
battery run can land a bad commit with nothing between it and `main`, which is why fixtures hold disposable targets only.
