# Factory throughput — baseline and pre-registered metrics

**Compiled 2026-11-04, before the batch it describes.** The definitions below are fixed in advance so the
batch cannot be scored generously afterwards. Results go in §5; if a metric turns out to be unmeasurable, that
is recorded as a defect of the metric, not quietly dropped.

## 1. Why pre-register

This repository's standing rule is that an unrun check must not look like a passing one, and that a green suite
over an assumed contract describes the test rather than production. Throughput claims are the same hazard with a
bigger audience: "the factory works unattended" has been implied by exactly **three landed changes**, and every
earlier number in this repo's documents counted *PRs opened*, which is an input, not an outcome.

## 2. Definitions (fixed)

| term | definition, deliberately narrow |
|---|---|
| **dispatch** | one `build`-labeled issue accepted by the intake adapter for one repo |
| **success** | a **draft PR exists** on the remote whose head branch is `agent/issue-<n>`, whose diff touches only allowlisted paths, and whose required CI job is `pass`. Not "the model said it finished". |
| **mergeable-without-editing** | the PR needed zero human edits before a human could reasonably click merge. Approvals taps are counted separately (§4), not as an edit. |
| **worker wall time** | `tasks.record.startedAt → endedAt` for `kind = factory.worker`, in minutes, read from the instance store — never from log impressions |
| **failure class** | the recorded `outcome.error`/`reason`, mapped onto the §3 taxonomy by substring rule fixed below. A run whose class is "pipeline defect" invalidates the batch's success rate for that repo until re-run |
| **approvals taps per issue** | count of destructive/prompt approval markers attributable to that dispatch's conversations. This is also the in-vivo test of engram#69 |
| **excluded from success rate** | deliberate aborts, runs against spent fixture specimens, and any run whose pinned model was unreachable (the #133 shape) — each listed explicitly in §5 if used |

Success is per dispatch. There is no partial credit: a faulted task with a nice commit on a branch is a failure
until it becomes a PR that CI accepts.

## 3. Failure taxonomy (fixed before the runs)

| class | substring rule on the recorded error/reason | meaning |
|---|---|---|
| `budget` | `wall-clock budget exceeded` | working as designed; not a defect, but a task too big for 2400 s |
| `abort-operator` | `aborted by operator`, `worker aborted` | information (#141) |
| `approval-blocked` | `blocked pending approval`, `requires human approval` | posture, not agent defect (#188) |
| `setup` | `setup command failed` | environment/lockfile/registry |
| `refusal-boundary` | `refuses to rework`, `refused at the tool boundary` | caller mistake refused without a fault (#214) |
| `model-unavailable` | `no_model`, `model_error`, `model unavailable` | inference, not the pipeline (#133) |
| `pipeline-defect` | anything else | ours. Each one gets an issue before another batch runs |

## 4. Baseline from existing stores (measured 2026-11-04, not estimated)

Extracted with `sqlite3` over `factory-instances/*/engram-data/agent.sqlite`, `tasks.record.{startedAt,endedAt}`:

| kind | n | completed | faulted | aborted | median wall | max wall |
|---|---|---|---|---|---|---|
| `factory.worker` | 20 | 12 | 7 | 1 | **1.5 min** | 357.3 min |
| `factory.reviewer` | 7 | 5 | 2 | 0 | 1.4 min | 2.2 min |
| `factory.refine` | 2 | 2 | 0 | 0 | 2.8 min | 4.7 min |

Completed worker wall times, sorted (min): `0.6, 0.8, 0.8, 1.0, 1.4, 1.6, 2.2, 4.4, 4.5, 11.3, 14.2, 18.4`.

Every non-completed run is attributable, and **all but one class were fixed after the run**:

| cause | n | status as of `c993bdd` |
|---|---|---|
| `erased(...).abort is not a function` | 2 | **fixed** — `ce2ed10` (2026-11-02), 14 h after these two faults. Upstream asks remain in #172; nothing local to build |
| `wall-clock budget exceeded (2400s)` | 1 | by design |
| `reviewer never called submit_verdict` | 2 | **fixed** — #188 approval-block detection |
| npm setup failure in sandbox | 2 | **fixed upstream** — engram#68, vendored in v0.2.2 |
| `GET /user` HTTP 403 (git identity) | 2 | **fixed** — #98 |
| `feedback.prNumber … (0)` | 1 | **fixed today** — #214 |

Two claims this retires, recorded because they were mine and were wrong:

- **"Throughput is n=2/n=3."** True for *landed PRs* (three), false for *runs*: there are 20 worker runs. The
  honest statement is **60 % of historical worker runs completed**, on a fleet whose failure modes have since been
  fixed one by one — so the old rate describes an older build, and is not a prediction.
- **"The batch will be dominated by #172."** It will not. Both `erased(...).abort` faults predate `ce2ed10`, and
  `assertAbortable()` now refuses to boot a factory whose task definitions cannot abort (pinned by 18 tests in
  `test/task-definition-contract.test.mjs`).

The one number that still deserves suspicion is the **357-minute** run: it *started* at the same hour as the two
pre-fix faults and ended only because something else gave out. Whatever its cause, a wall budget of 2400 s should
have ended it in 40 minutes, so if a batch run exceeds ~2× budget the batch stops and that is investigated first.

## 5. Batch design (fixed)

- **n = 4 dispatches, sequential.** One inference endpoint; parallel runs would contend on it and poison every
  latency number in the table.
- Two per repo (`lalanikarim/drydock`, `lalanikarim/engram`), smallest task first, so a bad discovery costs an
  hour rather than an evening.
- Every task must be **real work already wanted**, inside the registry allowlist. drydock excludes `gates/`
  deliberately — a self-run must not edit the oracles that judge it — so no batch item may touch it even though two
  gate defects found this week would have fit there. Those are filed for human hands instead.
- Approvals taps are recorded per issue: after v0.2.3 + `c993bdd`, a code-writing task should need **zero** approvals
  below `merge_pr`. Any tap is a finding about the #69 rollout, not noise.
- Nothing is merged by the factory (`autoMerge: false` in both repos). "Unattended" here means *up to and including a
  reviewed draft PR with green CI*, and the human decision to merge stays a human decision.

### What would change my mind

If success lands below 3/4 with `pipeline-defect` as the class, the conclusion is "not ready for unattended use",
and the next step is that defect, not another batch. If success is 4/4 but taps > 0 or a wall time exceeds 2×
budget, the conclusion is "works, with an unresolved rough edge" and the rough edge gets an issue before any claim
about production use.

### Results

_Filled in after the runs — see §6._
