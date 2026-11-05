# Stopping a run (operator levers, and what each one does *not* stop)

Compiled 2026-11-05 from live incident handling on build `c993bdd` (drydock#220 / #222). Every payload below is
copied from a real response, not written to illustrate.

There are two abort levers and they are **not interchangeable**. One stops a run; the other stops an issue from
being retried. Reaching for the wrong one is how a 40-minute task cost 80.

## Lever 1 — abort a task

```bash
BASE=$(node -e 'const j=JSON.parse(require("fs").readFileSync("fleet/data/routes.json","utf8"));const l=Array.isArray(j)?j:Object.values(j);const e=l.find(x=>String(x.repo??"").includes("drydock"));process.stdout.write(e.base??e.url??e.target)')
TOKEN=$(node -e 'const j=JSON.parse(require("fs").readFileSync("fleet/data/routes.json","utf8"));const l=Array.isArray(j)?j:Object.values(j);const e=l.find(x=>String(x.repo??"").includes("drydock"));process.stdout.write(e.token??e.apiToken??"")')

curl -sS -X POST "$BASE/factory/runs/abort" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"taskId":1788,"reason":"scope exceeded budget; stopping this cycle"}'
```

```json
{"aborted":true,"taskId":1788,"mark":"marked","statusBefore":"running","statusAfter":"terminal","settled":true}
```

`statusAfter:"terminal"` is a **read-back of the durable record**, not an echo of the request — the route reads
the task again before answering. Good: that is the shape every operator verb should have (#141).

**What it does not stop:** the orchestration conversation that delegated the task. Observed live — task 1788
settled at T, and a *new* `factory.worker` for the same issue was running at **T+0.8 min**. The orchestrator had
received `{budgetAborted:true, retryable:false}` and delegated again.

## Lever 2 — abort a conversation (this is the one that stops a loop)

```bash
curl -sS -X POST "$BASE/factory/runs/abort" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"conversationId":1545,"reason":"stop the orchestration loop; issue is over-scoped and will be resplit"}'
```

```json
{"aborted":true,"conversationId":1545,"scope":"conversation"}
```

This withdraws queued inputs and aborts that conversation's task scope, so nothing further gets delegated. Use
it when a task abort is followed by another run of the same issue. `taskId` and `conversationId` are mutually
exclusive — sending both is rejected with 400 rather than guessed.

## What an operator abort costs the issue: nothing (deliberately)

The wall-budget ledger (`factory/budget-ledger.ts`) counts **budget** aborts toward the cap that stops an issue;
operator aborts are recorded separately and never charged:

Two operational facts about that ledger, both learned by getting them wrong first:

**1. Attribution requires `issueNumber` in the abort body.** `noteOperatorAbort` runs only when the caller names
the issue — the code refuses to infer it from conversation names rather than invent data. My first two aborts
tonight omitted it, so they cost the issue nothing *and* left no trace of ever having happened:

```bash
curl -sS -X POST "$BASE/factory/runs/abort" -H "authorization: Bearer $TOKEN" \
  -d '{"conversationId":2059,"issueNumber":220,"reason":"operator: over-scoped, stopping before another 40 min"}'
```

**2. Read the newest revision, not a base snapshot.** The current state of a document lives in `document_revisions`
as a delta chain; querying for the last *base* snapshot shows an older value. I concluded from one that attribution
had failed, when it had worked:

```console
$ sqlite3 -excluded-names . "select seq, content from document_revisions where document_id=1779 order by seq desc limit 1"
25610|[["s",["issues","220","operatorAborts"],1],["s",["issues","220","lastReason"],
        "operator: reopen reason described a reduced slice that the issue body does not contain; …"]]
```

(The base snapshot at seq 20758 still said `operatorAborts: 0`. Both are correct for their point in time; only one
is current. A read-only connection — `file:…?mode=ro` — is the right way to poke at a live store.)

Rationale (#141): if pressing the stop button locked an issue, the button would go unused and runaway runs would
burn budgets while a human decided whether they were allowed to intervene. The consequence, which #222 fixed, is
that **the ledger cannot be the thing that stops a loop after a single abort** — it has one attempt of slack by
design.

## What the guards refuse, and what each payload means (`delegate`, #222)

| payload | meaning | what to do |
|---|---|---|
| `{refused:true, runStopped:true, attempts:2}` | two budget aborts; further calls return this without doing work | operator decision: raise `wallSecsPerIssue` or split the issue. Do not re-delegate. |
| `{refused:true, requires:"replan", attempts:1}` | one budget abort and **no PR produced** | only re-delegate if something changed, and say so in `replan`. Otherwise report to the human. |
| `{refused:true, alreadyRunning:true, owningTaskId}` | another delegate call owns this issue (claim TTL = one wall budget + 120 s) | wait, or abort the owner deliberately. Never poll in a loop. |

All three create **no task**, clone nothing, and cost no budget: they answer at the tool boundary (#214's rule —
a caller mistake gets an actionable result, not a faulted child that lands in the settlement ledger as an agent
defect).

## Finding which issue is why

```bash
grep -E "BUDGET|refused without work" /tmp/fleet-$(cd ~/Projects/drydock && git rev-parse --short HEAD).log | tail
```

Expected lines, all seen live:

```console
[factory.worker]   BUDGET: issue #220 exceeded wallSecsPerIssue=2400s — aborting run; partial branch preserved
[factory.delegate] issue #220 refused without work: 1 prior budget abort(s), no PR recorded — a non-empty `replan` is required (#222)
[factory.delegate] issue #220 refused without work: owned by task "task-caller" for 412s (#222)
```

## "Just label it again" does not work (#226)

After an orchestration conversation is aborted, re-applying the `build` label **does nothing**. Intake dedupes on
`requestId`, which for an issue is a constant (`issue-<n>`), and that ledger is a durable document — so the event
is swallowed at the door. Verified live 2026-11-05, not inferred:

```console
[factory:lalanikarim/drydock] [factory] lalanikarim/drydock: intake — requestId issue-220 already handled — no new submission
```

The dedupe is correct for webhook redelivery; the side effect was that an issue got **one dispatch per instance
store, ever**. The workarounds were all bad in a different way: file a replacement issue (what I did — history gets
split), hand-edit `IntakeLedgerDoc` in a live sqlite store (do not), or wipe the store (loses lessons and ledger).

### The supported verb (#226)

```bash
curl -sS -X POST "$BASE/factory/intake/reopen" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"issueNumber":220,"reason":"issue split to the drift check only; prior attempt spent 40 min on setup"}'
```

What it does, and what it pointedly does not:

| | |
|---|---|
| **Appends** a new requestId (`issue-220#reopen-1`, then `-2`) | never deletes the original record — attempt count stays readable from history |
| Opens a **fresh conversation** | never submits into the superseded one: a transcript containing an abort or a refusal treats that as evidence (#122) |
| Never changes `budgetAborts`, `operatorAborts` or `stopped` | a reopen that reset those would undo #141 and #222 in one convenient call; tests compare the counters byte-for-byte afterward |
| **Appends a one-use grant** when the issue actually owes authorization (#230) | `delegate` then proceeds without model-authored prose and records `replanSource:"operator"`. No grant for an issue with no prior abort (a latent grant would silently buy an attempt later), and none for a **stopped** issue — reopening does not lift #141 |
| Returns `budget`, the `grant`, and a `warning` when the issue is stopped or has prior aborts | you learn immediately what this call authorized, instead of finding out from a worker log 40 minutes later |

`reason` is required and non-empty. That is #222's rule applied upward: an authorized second attempt should say
what changed, and the string goes into the new conversation verbatim (quoted) plus the log line.

```console
{"reopened":true,"requestId":"issue-220#reopen-1","conversationId":1560,"supersededConversationId":1545,
 "budget":{"budgetAborts":1,"operatorAborts":1,"stopped":false,"prNumber":null},
 "warning":"budget ledger shows 1 prior abort(s): delegate will require a non-empty `replan` (#222) …"}
```

So the retry chain is: **reopen** (restores dispatchability, and grants one attempt) → **`delegate` spends the grant,
or refuses without a `replan`** (#222/#230) → **stop at two aborts** (#141). Each layer keeps its own job.

### Two doors for a second attempt (#235)

| you call | transcript you get | budget authorization? |
|---|---|---|
| `POST /factory/intake` with a **new requestId**, `kind:"issue"` | a **fresh** conversation; the response names `supersededConversationId`; the old transcript keeps its history | **No.** No grant is appended, so `delegate` refuses without a `replan` — and if you do supply prose it records `replanSource:"model"`. This is the cheap probe door: one orchestration turn, nothing spawned while the guard is armed |
| `POST /factory/intake/reopen` | a fresh conversation (it always was) | **Yes** — appends the one-use grant (#230) |

Before #235 the first row silently resumed the existing conversation: a probe dispatched at 14:28 landed in a transcript whose
last event was an abort, and `created:false` was the only hint. Identical requestIds are still answered `200 duplicate` before
any of this runs — which is what makes the rule safe — and `refine` / `pr-feedback` keep steering **one** shared conversation,
because their requestIds carry comment ids and sharing is the feature. The distinction is encoded as data in
`CONVERSATION_POLICY` (`factory/intake-router.ts`): per-attempt kinds open a conversation per attempt, per-event kinds share one.

### Who authorized this? `replanSource` (#230)

Before #230 the guard asked for a string and recorded it, so "a human decided" and "the model wrote a sentence"
decided nothing — and looked identical in the log. Now every retry records **who** authorized it:

| | ledger `replanSource` | log line |
|---|---|---|
| operator reopened the issue | `operator` | `… re-delegated after a budget abort on an OPERATOR GRANT — replanSource=operator (#230): "issue-220#reopen-1" granted <iso8601>: …` |
| orchestrator supplied prose, no grant on file | `model` | `… re-delegated after a budget abort on MODEL-AUTHORED text — replanSource=model (#230): no operator grant on file, so this attempt rests on the sentence alone: …` |

Reading that second line in production is not an alarm — legitimate re-scoping looks exactly like it, which is why
the prose path stays open. It is the audit trail that lets you tell, after the fact, whether a full-budget retry
had a human behind it. **If you mean to authorize one, reopen the issue.** That is the difference the field exists
to record.

### Write the reason as a fact, not an intention — your words become the model's justification

The reopen reason is injected into the fresh conversation as authoritative operator context. Ninety seconds after
#226 shipped, that produced this in production (build `6ce582e`):

```console
reopen — reopened issue #220 as issue-220#reopen-1 … : slice reduced to assertion 4 only (policy vs on-disk gates.json drift)
[factory.delegate] issue #220 re-delegated after a budget abort with replan: … the issue has since been sliced down
  to assertion 4 only …
```

The second line is #222's guard accepting a retry — and **the claim was false**. Issue #220's body still asked for
six assertions; nothing had been sliced. I had written "slice reduced to…" as an intention, the model restated it
as a completed fact, and `delegate` passed its "non-empty string" test. That is #222's own caveat ("prose with a
receipt, not a wall") reproduced live, plus a mechanism nobody had named: the operator authorizes, the model claims
the authorization, the guard sees a claim.

So, until [#230](https://github.com/lalanikarim/drydock/issues/230) separates host-issued authorization from
model-authored assertion:

- Write reasons as things that are **already true** — "issue body now covers only assertion 4" (after editing the
  body), not "slice reduced to assertion 4".
- Or write them as explicit operator intent, which is honest and still sufficient: "I am authorizing a second
  attempt at unchanged scope; accept the budget risk."
- Expect `delegate` to proceed on any non-empty reason. It is an audit trail, not a wall — and if you want the
  refusal path observed rather than assumed, that requires a delegate call *without* a replan, which a model that
  wants to continue will not produce.

What #230 changed about all this: your reopen is now **itself** the authorization rather than raw material for one.
Reopening an issue that owes authorization appends a grant worth exactly one attempt, `delegate` spends it and
records `replanSource:"operator"`, and a further attempt falls back to needing prose. What it did **not** change:
prose still unlocks the guard (blocking re-scoped work was an explicit acceptance failure in #222), and no grant
lifts #141's two-abort stop. The remaining honest gap is that nothing here judges whether a claimed scope change is
real — #230 lists verifying that as a non-goal, deliberately, because checking a claim with a string the claimant
supplies is theater with extra steps.

## Partial branches

A budget abort preserves the partial branch **locally** in `factory-instances/<instance>/work/issue-<n>/`. It is
not pushed, so nothing lands half-done. To keep the work: `cd` there, `git diff`, apply it somewhere you choose.
To discard: delete the directory. Either way say which in the issue, so nobody re-derives it later.
