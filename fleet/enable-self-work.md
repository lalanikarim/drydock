# Enabling webhook-driven self-work on drydock

Date: 2026-10-31. Everything below is the remaining deployment path; the code side is finished and verified on `main`.

**Transport is deliberately not part of this design.** The factory listens on `127.0.0.1` and knows nothing about how a request reached it. Anything that gives GitHub an HTTPS URL whose requests arrive at that socket is acceptable — reverse proxy, hosted tunnel, cloud load balancer, tailnet funnel. Nothing here names or recommends one, because a runbook that hardcodes a transport quietly turns an operator choice into an architectural dependency, and the security properties below have to hold regardless of which one is picked.

## Merge policy on `main` (what gates a merge, and who can step over it)

Two mechanisms are in force at once — GitHub enforces both:

| Gate | Requirement | Applies to admins? | Set by |
|---|---|---|---|
| CI | `unit-suite` must pass, **strict** (branch up to date first) | **Yes** | classic branch protection, `enforce_admins: true` |
| Review | 1 approving review | **No — repo admin may bypass** | ruleset `main-review-gate-admin-bypass` (`pull_request` rule, `bypass_actors: [RepositoryRole/5 = Admin, always]`) |
| Force push / branch deletion | refused | Yes | classic branch protection |

The asymmetry is deliberate. A green suite is the one claim this repo treats as non-negotiable — it is cheap, deterministic, and the only gate that says nothing about correctness *or* anything else if it is missing. Review carries judgment, and on a single-maintainer repository "waiting for a second opinion that cannot arrive" turns a review gate into an outage; so review is required by default (it disciplines the author, and makes factory PRs genuinely reviewed) while an admin can step over it when the human is also the only reviewer.

Two consequences worth knowing before they surprise you:

- **Your own PRs cannot be approved by you.** GitHub refuses self-approval, so a `lalanikarim`-authored branch reaches merge through the admin bypass, not through an approval. That is expected, not a malfunction.
- **Factory PRs (`app/drydock-factory`) can be approved normally**, because the author differs — which is the pairing decision E3 anticipated: bot authorship plus one human approval is a real control; "approve your own work as a second human" mostly adds latency.

**Exercised, not just configured (2026-10-31).** PR #86 was merged by the repo admin with `unit-suite` green and **no approving review**: the merge stayed `BLOCKED` / `REVIEW_REQUIRED` until the bypass was taken, then landed. CI refused nothing and permitted nothing — it simply had to be green, which is the asymmetry working as designed.

One caveat found while setting this up, tracked as **#87**: factory *commits* are authored by a placeholder (`factory-worker <factory-worker@localhost>`), while the ruleset reports `require_extra_approval_for_unattributed_changes: true`. The admin bypass covers it today, but an email that resolves to nobody is what "unattributed" means, so expect surprises until commits carry the App's bot identity.

To inspect or undo (rulesets and classic protection coexist; both are enforced, so remove the ruleset to drop the review gate without touching CI):

```bash
gh api repos/lalanikarim/drydock/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
gh api repos/lalanikarim/drydock/branches/main/protection --jq '"CI strict=\(.required_status_checks.strict) enforce_admins=\(.enforce_admins.enabled)"'
gh api -X DELETE repos/lalanikarim/drydock/rulesets/<id>     # drop the review gate only
```

## Prerequisites

| Item | Status | Evidence |
|---|---|---|
| Registry entry enabled, `autoMerge: false` | done | `factory/repo-registry.json`; capability removal means a self-run has no `merge_pr` tool at all |
| Eligibility label threaded per route | done | `buildRoutes()` in `fleet/supervisor.ts`, `test/fleet-routes.test.mjs` |
| `build` label exists on the repo | done | created 2026-10-31 (GitHub does not auto-create labels; intake matches on name) |
| Path scope excludes `gates/`; `gates/probes/` protected | done | registry + `test/path-scope.test.mjs` |
| `/health` discloses nothing; bodies capped at 1 MiB | done | #59 — oracle `gates/self-intake-hardening.mjs` 6/6 on `main`, G0 20/20, `npm test` exit 0 |
| Verification gate on push (C1) | done | #61 — `factory/verification.ts`; boot logs `verification required — open_draft_pr runs \`npm test\` …` |
| Routes cannot go stale under a running adapter (C3) | done | #69 — supervisor writes before spawn, adapter re-hashes per request and exits on drift |
| CI + required status check on `main` | done | PR #73; `unit-suite` made required 2026-10-31 (`required_status_checks: [unit-suite]`, strict, admins enforced) |
| **Credential: GitHub App, not a PAT** (B1-rev) | done — wired and boot-verified | `factory/github-auth.ts` exchanges the App JWT for an installation token; boot prints `git credential: GitHub App <id> (installation <n>)` then `installation token exchange verified`, and refuses to announce ready if the exchange fails. The #70 keychain warning is gone from this path. Reach still needs the operator's eye: 3 reachable repos are unmanaged (queue 3a-ii, R7) |
| Commit identity resolves (no unattributed commits) | done — logged at boot | `factory/git-identity.ts`; boot prints `commit identity: <app>[bot] <id+…@users.noreply.github.com>`. Installation tokens are refused by `GET /user`, so the bot account comes from app metadata (`GITHUB_APP_SLUG` or the App JWT → `/app`). A `WARNING — commit identity unresolved` at boot means every run will fault in workspace preparation before pushing — fix the credential or set the slug, and do not paper over it with `FACTORY_GIT_*` unless a different author is actually intended |
| Sandbox image present | required | `docker build -t localhost/factory-sandbox:latest factory/sandbox-image` — the worker image is built from that Dockerfile, not pulled; a missing image fails at worker spawn, not at boot. Also tag `factory-sandbox:latest` when `FACTORY_SANDBOX_IMAGE` is unset (the default resolves unqualified) |
| Webhook secret actually matches GitHub | required | Prove it with a GitHub-signed ping rather than by reading config: `gh api -X POST repos/<owner>/<repo>/hooks/<id>/pings`, then check that delivery. **200/OK means the HMAC matched.** The adapter logs a ping as `not an agent issue event`, which is correct (events are issues-only). 403 with `reason: "invalid signature"` means the two sides disagree — see §Secret mismatch |

Verify the credential situation before publishing, every time — it prints no secrets:

```bash
node gates/github-app-check.mjs                    # identity, grants, reach-vs-registry check, read probes
node gates/github-app-check.mjs --probe-push <owner/repo>   # optional: create+delete a ref to prove contents:write
```

## 1. Fleet file (deployment, not checked in)

Create `fleet/fleet.local.json`. Keep the real secret in the environment — the supervisor prefers `GITHUB_WEBHOOK_SECRET_<owner>_<repo>` over the file value — and copy the shape from `fleet/fleet.example.json`:

```json
{
  "adapter": { "port": 9700, "routesFile": "data/routes.json", "logPath": "data/intake-adapter.jsonl" },
  "factories": [
    {
      "repo": "lalanikarim/drydock",
      "secret": "placeholder-read-from-env",
      "config": "../factory/config/lalanikarim_drydock.json",
      "instancesRoot": "../factory-instances",
      "allowedSenders": ["lalanikarim"]
    }
  ]
}
```

`allowedSenders` is defense in depth, not decoration: the signature proves GitHub sent the request, the sender allowlist additionally requires that the actor is you. On a published listener both are cheap and they fail differently.

Required environment: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `GITHUB_WEBHOOK_SECRET_<owner>_<repo>`. **Since PR #82 the supervisor loads the repo-root `.env` itself** (non-overriding, same loader as `factory/main.ts`), so starting from a plain shell is fine; before that fix it was not, and the symptom was §Secret mismatch. Expected boot lines, in order:

```
[supervisor] loaded 7 variable(s) from .env (ambient values not overwritten)
[supervisor] lalanikarim/drydock: webhook secret from GITHUB_WEBHOOK_SECRET_lalanikarim_drydock (value not logged)
```


Two more are **optional but should be set explicitly**, because their fallbacks are invisible rather than absent:

- **Credential: GitHub App (B1-rev), no PAT.** `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` / `GITHUB_APP_INSTALLATION_ID` in `.env` describe the installation the factory uses (`factory/github-auth.ts` mints the JWT and exchanges it for a short-lived installation token; boot verifies the exchange and refuses ready without it). On this host boot prints `git credential: GitHub App 5557270 (installation 177271737) — short-lived installation tokens`, and the keychain fallback below is **not** taken.
- `FACTORY_GITHUB_TOKEN` — an escape hatch that overrides the App (precedence: env → App → config → host helper → none). Historically dangerous because leaving it unset on this machine meant git silently used `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig`'s `credential.helper=osxkeychain`, whose entry is an **account-wide** token; that is why boot now logs the resolved path. With a complete App config in `.env` the helper is never consulted, so leave this unset unless you are deliberately testing a different credential. **Since #70:** boot no longer stays silent about this — `factory/main.ts` logs the resolved credential path, and the host-helper fallback is a `WARNING … ACCOUNT-WIDE` line you cannot miss in the startup log (e.g. `WARNING — git credential: NO factory token configured — clone/push will fall back to the host credential helper(s): osxkeychain (…)`)
- `FACTORY_SANDBOX_IMAGE` — defaults to `factory-sandbox:latest` (`factory/main.ts`). Fine on a machine where exactly that image is built; name it when the image lives under a registry prefix.

## 2. Start the supervisor

```bash
node --experimental-strip-types fleet/supervisor.ts run fleet/fleet.local.json
```

(`run` is a subcommand — bare `supervisor.ts <file>` prints usage and exits.) Expect, in order: the adapter listening line, then `[factory] lalanikarim/drydock ready on http://127.0.0.1:<port>/`, then `wrote 1 route(s) to …/data/routes.json`. Readiness also runs the model-catalog self-check (#54): if the pinned model is absent from the instance's own `/models` it exits **before** announcing ready, so "ready" means what it says.

Two posture lines are worth reading rather than skimming, both printed before `ready`:

```
[factory] lalanikarim/drydock: WARNING — git credential: NO factory token configured — clone/push will fall back to the host credential helper(s): osxkeychain (…). On a developer machine that entry is typically ACCOUNT-WIDE; use the App (B1-rev) or set FACTORY_GITHUB_TOKEN.
[factory] lalanikarim/drydock: verification required — open_draft_pr runs `npm test` and refuses to push on a non-zero exit
```

The first is the #70 credential warning (loud, not fatal — see §Prerequisites). The second is the #61 verification gate; if it ever says `WARNING — verification waived by registry policy`, that repo can open draft PRs with no test run at all.

### Gotcha found while bringing this up: stale routes in a running adapter

The adapter reads its routes file when it starts; the supervisor writes that file when factories come up. On a machine that previously ran a different fleet, the adapter boots against the **leftover** file and logs the old repositories — then the supervisor overwrites the file underneath it and nothing reloads. Observed on first bring-up:

```
[adapter] adapter listening on http://127.0.0.1:9700 (routes: lalanikarim/factory-fixture, lalanikarim/factory-fixture-2)
[supervisor] wrote 1 route(s) to /Users/…/fleet/data/routes.json
```

**Fixed 2026-10-31 (#69, decision C3).** The supervisor now writes the routes file *before* spawning anything — atomically (temp + rename, so a reader never sees partial JSON) — and always overwrites on adapter start, so a leftover file can no longer survive. The adapter hashes the file at startup and re-hashes it on **every** webhook request; a changed file means the in-flight request is refused with 503 (audited), the adapter exits, and the supervisor restarts it against current policy. Both sides log the hash, so "which write does the running adapter not match?" is answerable from logs alone.

**Fixed (#81): the drift guard now distinguishes policy from runtime state.** A cold start used to cost one adapter restart, because the supervisor writes routes with no `target` (nothing is ready yet), each factory becoming ready rewrites the file with its ephemeral port, and the guard treated *any* change as an authority change — refuse 503, exit, get restarted. Convergence by crash-loop on the happy path meant every boot looked alarming and a short window of deliveries relied on GitHub retry.

The adapter now classifies the diff: `target` is runtime state, so a change whose policy projection (repo set, secret, token, eligibility label, sender allowlist) is unchanged is adopted in place — live routes are mutated so dispatch follows the new port rather than a dead one — and logged with both hashes. Everything else stays hard drift: 503, audit, exit for supervisor restart. An unparsable file is never benign, and without the in-memory snapshot to compare against the check falls back to refusing. Startup logs carry two hashes because they answer different questions:

```
[adapter] adapter listening on http://127.0.0.1:9700 (routes: lalanikarim/drydock, routes-hash 941dbce90bd7061e, policy-hash cd91dc18f9c49c36)
[adapter] routes refreshed at runtime: target-only change adopted in place (policy cd91dc18f9c49c36, file f7924b7be37cd065; lalanikarim/drydock:http://127.0.0.1:63573)
```

Note the policy hash is unchanged while the file hash moved — that line *is* the fix, and it is what a reader should expect to see once per factory ready-transition. Verified live on this machine: one `starting adapter` line instead of two, GitHub's delivery answered 200 on the first attempt, and the same change with the snapshot withheld throws `RoutesDriftedError` (so the new tests are not vacuous).

What remains manual: **fleet-file changes** (adding/removing factories) still require a supervisor restart — the fleet file is read once at start. Registry changes (labels, allowlists) take effect on the next supervisor or factory restart. The startup-line check stays as cheap confirmation: it must list exactly the repos you expect, and the adapter's `routes-hash` should match the supervisor's last `wrote N route(s) … (hash …)` line.

## 3. Publish the listener, then prove what it discloses

Requirements on whatever sits in front — these follow from how the intake server works, not from any particular product:

- **TLS terminated publicly**, forwarding to `127.0.0.1:9700`. The factory itself must never bind a public interface; the intake server refuses non-loopback binds without a secret and that should stay true.
- **Request body forwarded unmodified.** Signature verification is an HMAC over the exact bytes GitHub sent; a proxy that rewrites, pretty-prints, or reorders JSON produces valid-looking requests that all fail with `invalid signature`.
- **`POST /webhook/github` reachable**, method preserved, request body not buffered beyond the 1 MiB cap (a proxy-side cap set lower than GitHub's payloads silently drops work; set higher and our own cap does the refusing).
- **4xx responses passed through**, so GitHub's delivery log shows real outcomes instead of a proxy-generated 200.

With Tailscale Funnel (this machine's choice under A1) the command has to be detached — foreground `tailscale funnel <port>` holds the tunnel open and dies with the shell, which reads as "Available on the internet … Command aborted" and publishes nothing:

```bash
tailscale funnel --bg 9700      # https://<node>.<tailnet>.ts.net/ → http://127.0.0.1:9700
curl -sS https://<node>.<tailnet>.ts.net/health   # {"status":"ok"} and nothing else
```

Requests from the hosting machine to its own published hostname may hairpin, so intermittent TLS resets there say nothing about the public path; GitHub's delivery log is the authority because GitHub connects from outside.

Then verify from outside your own process:

```bash
curl -s https://<your-public-endpoint>/health     # must print {"status":"ok"} and NOTHING else
```

That is the production acceptance test for #57: before the fix the same request enumerated every configured repository. `/health` has no auth by design — liveness must be pollable — which is exactly why it says nothing.

One caveat when testing from the machine that hosts the listener: traffic to your own published hostname may be hairpinned through the provider's edge or even resolved onto the private network, so intermittent TLS resets or HTTP/2 failures there say more about the test path than the server (loopback was consistently 200 in exactly that situation). Two answers that don't depend on local quirks: the adapter's own log (`fleet/data/intake-adapter.jsonl` records every inbound request and its refusal reason), and GitHub's delivery log, since GitHub connects from the public internet:

```bash
gh api repos/lalanikarim/drydock/hooks/<hook-id>/deliveries --jq '.[0] | {delivered_at, code, event}'
```

## 4. Register the webhook

Events: **issues** only (all intake consumes; more events cost signature work and log volume for nothing). Secret must match `GITHUB_WEBHOOK_SECRET_lalanikarim_drydock`.

This repo already has hook `703101252` (events `issues`) pointed at the funnel URL — inspect and update it rather than creating duplicates. Note that `gh api -f active=true` is rejected (`"true" is not a boolean`), so send real JSON; the payload file contains the secret, so keep it mode 600 and delete it when done:

```bash
gh api repos/lalanikarim/drydock/hooks --jq '.[] | {id, active, events, url: .config.url}'
# build /tmp/hook.json from .env (active=true, events=["issues"], config.url=<funnel>/webhook/github,
# config.content_type=json, config.secret=$GITHUB_WEBHOOK_SECRET_lalanikarim_drydock, insecure_ssl="0")
gh api -X PATCH repos/lalanikarim/drydock/hooks/703101252 --input /tmp/hook.json && rm /tmp/hook.json
```

### Secret mismatch, and why it looks like GitHub's fault

Symptom: every delivery is refused, the adapter logs `reason: "invalid signature"`, GitHub shows 403 — while both sides look correct in isolation. Observed here with the hook holding a secret from an earlier setup and the adapter having **no** secret at all (supervisor not loading `.env`), so it HMAC'd against the fleet file's placeholder text.

Both halves are now enforced in code (PR #82): the supervisor loads `.env` before resolving secrets, and a placeholder-shaped secret is refused at boot instead of being silently used. To diagnose from scratch, compare three things — the ping result (200 ⇒ HMAC agrees), the adapter's refusal reason, and the boot line naming which source supplied the secret.

```bash
gh api repos/lalanikarim/drydock/hooks -f active=true \
  -f "events[]=issues" -H "Accept: application/vnd.github+json" \
  -f config[url]=https://<your-public-endpoint>/webhook/github \
  -f config[content_type]=json -f config[secret]=<same-secret> -f config[insecure_ssl]=0
```

## 5. Smoke test — done on the published listener (2026-10-31)

The first public-driven run went end to end: issue **#80** → `build` label → signed delivery → worker in sandbox → independent review → **draft PR #83 authored by `app/drydock-factory`**, which stopped there. Nothing merged, no approval was pending (`GET /approvals` → `{"approvals":[]}`, consistent with `autoMerge: false` having removed the merge tool entirely).

| Probe | Result |
|---|---|
| GitHub-signed ping after secret realignment | **200 OK**; adapter logs `not an agent issue event`, which is correct for issues-only intake |
| Public `/health` | `{"status":"ok"}` and nothing else — #57's acceptance test over the public path |
| Wrong signature | 403 `invalid signature` (checked before the payload is read) |
| Missing signature | 403 `invalid signature` |
| Signed for drydock, payload names another repo | 403 `cross-repo naming: signed for lalanikarim/drydock, payload names lalanikarim/factory-fixture` |
| Correct signature, sender not in `allowedSenders` | 403 `sender not allowlisted for lalanikarim/drydock: someone-else` |
| Replay of the accepted dispatch (same issue, label, allowed sender) | adapter replies 202 `accepted, requestId: issue-80`; **no second worker started** (setup count stayed at 2, zero factory containers, `agent/issue-80` head unchanged) — dedupe happens below the adapter, in the durable store keyed by `requestId` |
| PR authorship (decision B3) | **confirmed**: `#83 [app/drydock-factory] draft=true` — every earlier PR on this repo is `[lalanikarim]`, so factory work is now distinguishable from human work by identity rather than by convention |

Two things this does not prove, stated plainly: the adapter's 202 means "handed off", not "will run" — idempotency lives in the durable store, so a probe that never reaches eligibility (e.g. missing top-level `label`, which is what eligibility reads) proves nothing about dedupe; and one successful run is one run, on one repo, with one model pinned.

Operational facts learned:

- Re-labeling an issue **cannot** re-run it (same `requestId`, permanently deduplicated). To retry deliberately: fresh issue, or a manual task submission.
- A worker may touch files the issue did not name as long as they are inside the path allowlist — #83's run also modified `factory/verification.ts` and the reviewer flagged it as bundled-in scope creep. Path scope answers "may this file change at all?", not "should this issue change it?"; review is the control for that (recorded as R9).
- Reviewer output includes the verification block (`npm test`, exit code, tail) from decision C1, so a green claim is attached to a command rather than asserted.

## 6. Asking for rework on a pull request (`/factory`, #67)

A comment on an open PR can now drive the factory:

```text
/factory rebase
/factory resolve-conflicts
/factory rename totalAmount to subtotalAmount and update the tests
```

**Enable it in three places**, each of which fails silently if skipped:

1. **Registry policy** — `prFeedback: true` on the repo entry in `factory/repo-registry.json` (default `false`; must be a real boolean).
2. **Routes** — automatic: the supervisor copies the flag onto the route, and the adapter refuses comment events for repos without it. Restart the supervisor after changing the registry, since routes are written at start.
3. **Webhook events** — the hook must subscribe to `issue_comment` in addition to `issues`:

```bash
gh api -X PATCH repos/lalanikarim/drydock/hooks/<hook-id> -f name=webhook \
  -f 'events[]=issues' -f 'events[]=issue_comment' -f active=true \
  -f 'config[url]=https://<your-public-host>/webhook/github' \
  -f 'config[content_type]=json' -f "config[secret]=$WEBHOOK_SECRET" -f 'config[insecure_ssl]=0'
```

**What will not trigger, by design** — and each of these is asserted in tests rather than merely intended:

| Comment | Result |
|---|---|
| `should we rebase this?` | refused: the command must start the body |
| `/factory …` from any login outside `allowedSenders` | 403 before parsing |
| `/factory …` from a bot, even an allowlisted one | refused — comment-triggered pipelines loop |
| on a PR whose head is not `agent/issue-<n>` | refused: the factory only reworks branches it created |
| on a closed or merged PR | refused, with the state named in the reason |
| anything at all, if `prFeedback` is off for that repo | refused, and the PR is never even read |

**What happens when it does trigger:** the worker checks out the PR's current branch (not a fresh one from `main`), applies the instruction, runs the repo's test command, and `open_draft_pr` pushes — running verification and independent review first, exactly as on the first pass. Because a PR already exists for the branch, it is updated in place; no second PR appears and nothing merges. The run logs `[factory.worker] REWORK issue #<n> on agent/issue-<m> (PR #<p>, directive <kind>)`, which is the fastest way to see whether intake accepted a comment.

**If a comment seems ignored,** read `data/intake-adapter.jsonl`: every delivery lands there with `accepted`, `reason` and (for refusals decided after reading PR state) `refused after state check: …`. A 200 with `accepted: false` is a policy decision; a 5xx is a broken listener or instance.

## 6b. Asking for a refinement pass (`/refine`, #65)

Where `/factory` reworks a pull request, `/refine` improves an **issue** — and starts no work. It exists
because ticket quality, not model quality, decided the outcome of #99 (six worker+review cycles spent on a
task that required a file the path scope forbids) versus #105 (same goal, written narrowly, merged in one
pass).

### Triggers

| what you do | what happens |
|---|---|
| add the **`refine`** label to an issue | one refinement pass; brief posted as a comment |
| comment **`/refine <guidance>`** on an issue | one pass per comment, with your guidance folded in |
| comment **`/refine`** with nothing after it | a plain "expand this" pass — the common case |

Both are opt-in per repository (`refine: true` in `factory/repo-registry.json`; label name configurable via
`refineLabel`). The registry **refuses to load** if `refineLabel` equals `eligibilityLabel`: one gesture must
never be able to mean both "expand this" and "go build it".

The label exists on GitHub before first use, same as `build`:

```bash
gh api -l repos/lalanikarim/drydock/labels -f name=refine -f color=ededed \
  -d '{"name":"refine","color":"ededed","description":"Ask the factory to expand this issue into an actionable brief (no work started)"}'
```

### What the refiner can and cannot do

It gets **one tool: `read`**, against a host clone of the default branch with the remote URL scrubbed — so it
can cite real files and cannot change a byte, push anything, comment, or label. It has no network. The brief
is posted by the factory host after parsing succeeds, and only if the issue is still open at that moment.

**A brief grants nothing.** Nothing consumes it automatically. To act on a refined issue you add the
repository's eligibility label (`build` for drydock), and the change then passes path scope, verification and
independent review like any other. That is what makes an expansion pass safe to allow on issues anyone can
open: a bad refinement can mislead a reader, it cannot widen what a run may touch.

### Reading the output

The comment has a fixed shape — brief, goal, acceptance criteria, explicitly out of scope, verification, and
optional follow-ups/questions — with a footer stating that nothing was changed. Two sections are load-bearing
and are the reason to use this:

- **OUT OF SCOPE** is never allowed to be empty. Most wasted cycles in #99 came from nobody having written
  down what the task did *not* include.
- **VERIFICATION** must name a command or manual check per criterion, so "done" is decidable before inference
  starts.

Adjacent work lands under **FOLLOW-UPS**: file it as its own issue if you want it, ignore it otherwise. The
refiner is told not to write criteria requiring files outside the repo's `pathAllowlist`, and to say so under
QUESTIONS instead — which is precisely the failure mode that cost #99 six attempts.

### When no comment appears

Deliberate silence means the brief did not parse (missing section, or an acceptance/verification list with no
items) — a partial brief would read like an approved plan, so nothing is posted and the raw text stays in the
task outcome for debugging:

```bash
sqlite3 factory-instances/lalanikarim_drydock/engram-data/agent.sqlite \
  "select id, kind, substr(payload,1,300) from tasks where kind like '%refine%' order by id desc limit 3"
```

Other refusals, all before any inference is spent: sender is a bot; the issue is closed (checked twice — at
dispatch and immediately before posting); `/refine` directive longer than 2000 characters (refused rather than
truncated, because the directive *is* the request); repository has `refine: false`.

### Gotcha found while verifying this live: capabilities and a long-lived root conversation

Two separate things can make a refinement (or any newly shipped tool) unreachable, and they look identical
from the outside — the boot log says the feature is enabled either way.

1. **The tool never reached the agent.** `harness.root()` applies its agent options only when the root
   conversation is *created*, so a restart used to deliver neither new tools nor revised instructions nor a
   re-pinned model. Boot now re-asserts them and reads the result back (`root capabilities synced: …`); if the
   set does not match the registry, the instance refuses to start rather than run with authority nobody chose.
   If that line is missing from a boot log, the instance is older than the fix.
2. **The tool reached the agent and the model refused to use it anyway.** The root conversation accumulates
   its own past refusals; once it has written "I don't have `refine_issue`" twice, it cites that as evidence
   even with the tool present in the request (verified by capturing the outbound request through a logging
   proxy). Nothing in the transcript is proof of what the model was offered.

Diagnostic when a task seems ignored: check the boot log for the capability line, then read the root
conversation's newest assistant turn in the instance store. If it claims a tool is missing, do not trust it —
compare against the request the endpoint actually received before changing any code.

## 7. Failed deliveries are not retried — re-drive them yourself (#107)

**Assumption that was wrong, and is now gone from the codebase:** that GitHub retries a failed webhook delivery. It does not — [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) states it twice. A 503 from an adapter mid-restart, a timeout while the laptop slept, a funnel blip: recorded once, never attempted again. Our own drift path answered 503 *because* of the old comment claiming that bought recovery; it buys nothing.

Run the sweep after any supervisor restart, and on a schedule otherwise:

```bash
# report only (default) — nothing is re-driven
node fleet/redeliver-failed.mjs --repo lalanikarim/drydock --hook <hook_id> --since 2026-11-01T00:00:00Z

# re-drive everything it found
node fleet/redeliver-failed.mjs --repo lalanikarim/drydock --hook <hook_id> --since … --apply

# re-drive named deliveries only (preferred once the window holds real work)
node fleet/redeliver-failed.mjs --repo lalanikarim/drydock --hook <hook_id> --only 3851475922366504960 --apply

# leave a breadcrumb `supervisor status` can read (this is what the scheduled job does)
node fleet/redeliver-failed.mjs --repo lalanikarim/drydock --hook <hook_id> --state-file fleet/data/last-sweep.json
```

What the output means:

- **A policy refusal is never listed.** Those answer 2xx, GitHub records them as `OK`, and re-driving them would replay something we rejected on purpose. The sweep only ever sees infrastructure failures (`timeout`, `failed to connect to host`, `Invalid HTTP Response: 50x`).
- **`HTTP 202 queued` is not delivered.** Check again next run; the second run's report is the confirmation.
- **Re-driving an already-consumed issue is safe.** Intake deduplicates on `requestId` (`issue-<n>`), so a redelivered `labeled` event for work that already ran does not start a second worker. Re-driving a `ping` or any non-eligible event is inert — it lands as `not an eligible event`.
- **Delivery ids are 19 digits, and jq cannot be trusted with them either.** They exceed `Number.MAX_SAFE_INTEGER`, so anything that parses the delivery log as JSON numbers rounds them and then addresses a record that does not exist. Not hypothetical — observed on this hook: `gh api … --jq '.[0].id'` prints `3851559675096989696` where the response's own digits are `3851559675096989700`, because jq parses numbers as float64 and `tostring` cannot undo it. The tool quotes oversized ids before parsing (`safeParse`) for exactly that reason; don't reimplement it with `jq -r .id`, `Number(id)`, or a column typed `int`.

First run against this deployment, 2026-11-01: **72 delivery records inspected, 34 not delivered since 2026-10-31** — 18 connection failures (funnel down), 5×`503`, 4×`502`, 4 connect failures, 3×`403` (the secret-mismatch window). Every one of those was an event the factory never saw, and nothing in any log said so. Treat that number as a baseline to drive toward zero, not as reassuring history.

### Scheduling it (#110)

The decision #110 was waiting on, made: **launchd, not cron**. A laptop sleeps, and `cron` skips the jobs it would have run during sleep without ever catching up — which is precisely the window in which webhook deliveries fail. `StartInterval` resumes on wake, and `KeepAlive=false` keeps each run a short-lived process instead of another daemon to supervise.

**Installed on this machine (2026-11-01):** label `com.drydock.redeliver`, every 900s + at load, `--since 24h --skip-file fleet/data/acknowledged-deliveries.txt --state-file fleet/data/last-sweep.json`, report-only, log at `~/Library/Logs/drydock-redeliver.log`.

```bash
cp fleet/launchd/com.drydock.redeliver.plist.example ~/Library/LaunchAgents/com.drydock.redeliver.plist
# edit the __PLACEHOLDER__s: node path, repo paths, hook id, interval (default 900s = 15 min)
plutil -lint ~/Library/LaunchAgents/com.drydock.redeliver.plist   # a typo'd plist fails silently otherwise
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drydock.redeliver.plist
launchctl kickstart -k gui/$(id -u)/com.drydock.redeliver        # run once, now
launchctl print gui/$(id -u)/com.drydock.redeliver | grep -E "state|last exit code"
tail -20 ~/Library/Logs/drydock-redeliver.log
launchctl bootout gui/$(id -u)/com.drydock.redeliver             # stop
```

Two things that only show up under launchd, both found by installing it rather than by reading docs:

- **No login-shell PATH.** `gh` on a Homebrew machine lives in `/opt/homebrew/bin`, so resolving the token by bare name worked all afternoon interactively and would have failed the moment the job got scheduled. `resolveToken` now tries `gh`, `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`.
- **`ProgramArguments` needs absolute paths**, including for node itself — use the real binary (`readlink -f "$(command -v node)"`), not a shim that depends on shell environment.

The template is deliberately **report-only** — no `--apply`. A job that acts on a schedule can resurrect work for an issue closed hours ago, so detection is automated and recovery stays a human call with `--only`. It **exits 1 when it finds something**, which is what makes the log greppable and mail useful. That claim was false for exactly one day: `main()` returned `{code: 1}` while the CLI wrapper exited only on a thrown error, so every invocation — including one that had just reported 35 undelivered events — left status 0. Fixed by `runCli()`, which maps the verdict onto `process.exit` (checks: findings→1, clean→0, usage→2, thrown listing→2). Lesson for any gate that trusts an exit code: confirm something actually sets it.

Then check freshness without remembering the tool exists:

```bash
node --experimental-strip-types fleet/supervisor.ts status fleet/fleet.local.json
# …
# failed-delivery sweep: 4 min ago (dry-run) — inspected 81, undelivered 0, queued 0, since 2026-10-31T09:22:17.675Z, 16 acknowledged
# failed-delivery sweep: NEVER RECORDED — run fleet/redeliver-failed.mjs with --state-file …/last-sweep.json
```

`⚠ older than 1h` marks a stale sweep. "Never recorded" is printed as loudly as the others on purpose: before this, an unrun recovery tool and a healthy system looked identical.

#### The window and the acknowledge list (why exit code 1 has to be steerable)

The installed job passes **`--since 24h`**. A plist cannot compute "yesterday", so without a rolling window a scheduled sweep either reports the same ancient failures forever — or hardcodes a date that rots. `--since` takes `24h` / `90m` / `7d` / `30s` or an absolute timestamp, resolved at run time, and the resolved lower bound is written to the state file so "undelivered 16" can be read as *16 in this window* rather than *16 ever*.

Then the real problem appeared: **16 events were genuinely undelivered and genuinely needed no action** — ping checks, funnel-down connect failures during listener republishing, and 502/503s from supervisor restart windows. A weekly-always-red alarm is an ignored alarm, so acknowledgement is a first-class input:

```bash
node fleet/redeliver-failed.mjs --repo … --hook … --since 24h \
  --skip-file fleet/data/acknowledged-deliveries.txt   # one id per line, # comments allowed
```

Acknowledged ids are excluded from the exit code **but still counted** in the state file and on `status` (`16 acknowledged`). That distinction is the point: acknowledging is a recorded decision, not a way to make the record look like a clean hook. A missing or unreadable skip file yields *no* acknowledgements plus a warning — the failure direction is always towards alarming, never towards silence.

What acknowledgement does **not** give you: GitHub redacts delivery request payloads, so a failed record shows event type and failure reason but **not the issue number**. The actionable question is therefore not "which event was lost" but *"does an open issue sit carrying the eligibility label without having been dispatched?"* — check with:

```bash
gh issue list -R lalanikarim/drydock --state open --json number,labels \
  --jq '.[] | select([.labels[].name] | index("build")) | "#\(.number)"'
```

Empty output is what clean looks like. When the 16 were reviewed, both `build` issues (#105 shipped as PR #106, #97 closed as superseded) were already closed, which is why that file carries rationale per id rather than bare ids.

Verifying exactly one supervisor is running (the churn that started #107):

**Trust the lock, not `ps`.** A `grep -c` over `ps` output counts any shell whose command line mentions the supervisor — including the `nohup … &` wrapper that launched it, which stayed alive next to a healthy instance and reported "2" while exactly one supervisor existed:

```bash
cat fleet/data/routes.json.lock                                    # authoritative: the pid holding it
ps -p "$(cat fleet/data/routes.json.lock)" -o pid,lstart,command    # that process, in full
pgrep -fl "node .*fleet/supervisor.ts run"                          # node processes only, no wrappers
```

A second supervisor now refuses to start and names the live pid rather than rewriting the shared routes file; if the lock is stale after a crash it is reclaimed automatically, and if it is unparsable the new process refuses until a human looks at it.

## Rollback

Two independent switches, and both are worth using — disabling the hook stops *work*, unpublishing stops *exposure*:

```bash
tailscale serve reset                    # clears the published path (funnel rides on the serve config)
gh api -X PATCH repos/lalanikarim/drydock/hooks/703101252 -f active=false   # stop intake at the source
# then unpublish/stop whatever forwards to 127.0.0.1:9700, per that tool's own commands
```

Disabling self-work entirely is one line in the registry (`enabled: false`), which both the supervisor and `factory/main.ts` enforce before any child spawns — demonstrated live when the first self-run refused to start.

**What stays published is a decision, not a default.** A funnel URL is an HTTPS listener on a laptop that anyone on the internet can post signed-looking requests to; the refusals above are what makes that tolerable, and they only hold while the secret stays secret and the loopback bind stays loopback. If self-work is driven in bursts rather than continuously, tear the funnel down between bursts and re-run `tailscale funnel --bg 9700` when needed — GitHub retries failed deliveries with backoff, but that is not a durable queue you should rely on: if the window matters, re-add the label once the listener is back (nothing was recorded while it was down, so the same issue dispatches cleanly — `requestId` only deduplicates against work that actually started).

## 8. Operator notifications (Telegram, #64)

Optional outbound pings so the factory does not have to be polled. Enabled by two variables in `.env`; with
either missing the boot log says `notifications disabled` and nothing else changes.

```
TELEGRAM_BOT_TOKEN=...      # from @BotFather
TELEGRAM_CHAT_ID=...        # your chat id, see .env.example for the getUpdates one-liner
```

Exactly three things are announced, because a channel that carries everything is read by nobody:

| you get told when | the line contains |
|---|---|
| a draft PR opens (`pr_opened`) | issue, PR number, URL, verification result, head sha |
| a run is stopped by the refusal budget (`run_stopped`) | issue and the reason it will not produce anything further |
| a refinement brief is posted (`refine_posted`) | issue and the comment URL (#65) |

Everything else stays where it already lives: PR comments, `fleet/data/intake-adapter.jsonl`, durable task
state. Notifications are deployment configuration (who to tell), never repository policy (what is allowed) —
`factory/repo-registry.json` remains the only place capability decisions are made.

### Properties worth knowing before you rely on it

- **It cannot fail a run.** Failures are logged (`telegram notification not delivered …`) and dropped. If a PR
  is missing a ping, check that log line before suspecting the pipeline.
- **The bot token never appears in a log line**, including inside error text — the Telegram API puts it in the
  URL path, so naive fetch errors echo it. Redaction is asserted by tests.
- **Connection resets are normal here and are retried** (this host answers Node's `fetch` with `ECONNRESET`
  where `curl` succeeds). A `400` is not retried: a bad token or blocked bot fails identically forever.
- **One message per event per 10 minutes.** A retried code path cannot spam you; a different issue is a
  different event.

### Verify the credentials any time, without running anything

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node --experimental-strip-types -e '
const { sendTelegramMessage } = await import("./factory/notify-telegram.ts");
console.log(JSON.stringify(await sendTelegramMessage("drydock notification channel check", {
  token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, log: console.log,
})));"
```

Expected: `{"ok":true,"status":200,"attempts":1}`. Deliberately sends a message — a notification feature whose
delivery path is unverified is a notification feature you find out about by not hearing from it.
