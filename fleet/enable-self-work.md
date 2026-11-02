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

## 1. Deployment files (not checked in)

**1a. Per-repo runtime config — `$DRYDOCK_CONFIG_DIR`, outside the repository.** One file per managed repo, named `<owner>_<repo>.json`, default directory `~/.drydock/configs/`. Copy `factory/config.example.json` (the shape reference; it is never loaded) and set at least `models` and `testCommand`:

```bash
mkdir -p ~/.drydock/configs
cp factory/config.example.json ~/.drydock/configs/lalanikarim_drydock.json
$EDITOR ~/.drydock/configs/lalanikarim_drydock.json   # repo, models.provider, models.modelId, testCommand
```

**This is not a style preference.** `testCommand` is executed to decide whether a branch may be pushed. While these files lived at `factory/config/…` they were inside drydock's own path allowlist (`factory/`), so a self-run could have changed the command used to verify itself — see [`research/multi-repo-factory-plan.md`](../research/multi-repo-factory-plan.md) §5.28. Keep the directory outside any path scope a run can write, and treat it like `.env`: real values, never committed.

Set `DRYDOCK_CONFIG_DIR` in `.env` to relocate it (a second machine, a CI box). The supervisor checks this **before** it takes the lock or writes routes: a missing file is one message naming every path, and nothing starts — children that boot, die, and respawn behind live routes is the failure this prevents.

**1b. Fleet file — `fleet/fleet.local.json`.** Keep the real secret in the environment (the supervisor prefers `GITHUB_WEBHOOK_SECRET_<owner>_<repo>` over the file value) and copy the shape from `fleet/fleet.example.json`. Note there is no `config` key: runtime config is found by naming convention, which is the point — policy cannot point at a file inside the tree.

```json
{
  "adapter": { "port": 9700, "routesFile": "data/routes.json", "logPath": "data/intake-adapter.jsonl" },
  "factories": [
    {
      "repo": "lalanikarim/drydock",
      "secret": "placeholder-read-from-env",
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

### Gotcha found while verifying this live: capabilities and a long-lived root conversation (#122)

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

Diagnostic when a task seems ignored: check the boot log for the capability line, then read the conversation
that event landed in (below). If it claims a tool is missing, do not trust it — compare against the request the
endpoint actually received before changing any code.

**What changed because of it (#122).** The root conversation used to be where every webhook event in the fleet
landed, so one transcript carried every issue, every PR comment and every refinement ever handled. That is what
made the second failure mode above self-reinforcing: a refusal written while working on issue A was evidence
against a tool on issue B. Webhook intake no longer posts to root. The adapter calls the factory's own
`POST /factory/intake` with `{ kind, subject, requestId, content }`, and the instance opens one conversation per
`(kind, subject)` — `issue:#123`, `pr-feedback:#45`, `refine:#123` — created with exactly the tools that kind is
allowed (`refine:*` gets `refine_issue` and nothing else; orchestration gets the orchestrator's set, minus
`merge_pr` when policy says so). Root keeps its re-asserted capabilities and remains what the gates and an
operator driving `/tasks` talk to.

Two properties that are the reason for the split, both worth remembering when changing this path:

- **Scope of poisoning.** A conversation can only be misled by its own history now, and a refinement
  conversation has never contained a turn where `refine_issue` was absent.
- **Exactly-once survives.** `requestId` settlement is *per conversation* in the kernel. That is why the key is
  `(kind, subject)` and not one-conversation-per-event: GitHub redelivers, and a stable conversation is what lets
  the core absorb the duplicate. The adapter must keep sending a stable `subject`.

Where an event went:

Two quoting traps in the store will silently return nothing if you guess — both were guessed wrong here before being verified, and a query that returns no rows looks exactly like "the feature recorded nothing":

- `documents.kind` stores the kind **JSON-encoded**, quotes included: it is `"factory.intake-ledger"`, not `factory.intake-ledger`. Use `json_quote('…')` rather than escaping quotes inside shell quoting.
- `documents.record` holds only the doc **envelope** (id, kind, scope, createdAt). The state lives in `document_revisions.content` — one `base` row plus `delta` rows, newest `seq` last. Reading `record` and concluding "it's empty" is reading the wrong table.

```bash
# routes.json is a top-level list; port and token are per route (they change on every restart)
PORT=$(python3 -c "import json;print(json.load(open('fleet/data/routes.json'))[0]['target'].split(':')[-1].strip('/'))")
TOKEN=$(python3 -c "import json;print(json.load(open('fleet/data/routes.json'))[0]['token'])")

# Intake conversations, by their stable names (`intake refine:#133`, `intake issue:#4`)…
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/conversations \
  | python3 -c "import json,sys;[print(c['id'], repr(c.get('name'))) for c in json.load(sys.stdin)['conversations'] if str(c.get('name','')).startswith('intake')]"

# …the durable (kind,subject) → conversation map and the handled-request tail…
sqlite3 factory-instances/lalanikarim_drydock/engram-data/agent.sqlite \
  "select r.seq, r.kind, substr(r.content,1,200) from documents d
     join document_revisions r on r.document_id = d.id
    where d.kind = json_quote('factory.intake-ledger') order by r.seq;"
# 8072|base|{"entries":{"refine:#133":1023},"requests":[]}
# 8075|delta|[["s",["requests"],[{"id":"issue-133-refine","key":"refine:#133","conversationId":1023,…

# …and the thing #122 is actually about: which tools a given conversation can call. `tools` on the agent
# doc is a hard kernel filter, so this is proof, not a log line to believe.
sqlite3 factory-instances/lalanikarim_drydock/engram-data/agent.sqlite \
  "select json_extract(r.content,'\$.tools') from documents d
     join document_revisions r on r.document_id = d.id
      and r.seq = (select max(seq) from document_revisions where document_id = d.id)
    where d.kind = json_quote('pi.agent')
      and json_extract(d.record,'\$.scope.conversationId') = 1023;"
# ["refine_issue"]        ← a refine conversation: one tool, cannot delegate
```

The boot log states the posture once at startup: `intake routing — issue/pr-feedback open an orchestration
conversation per issue (N tools), refine opens a refinement conversation per issue (1 tool); the root
conversation is no longer on the webhook path`.

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

**Check for orphaned children too — the lock does not cover them (#125).** `SIGKILL`ing a supervisor leaves its
per-repo instance processes running, reparented to launchd: HTTP server up, durable store open, invisible to
`routes.json`. Two harnesses over one `agent.sqlite` is unsafe by construction even when the bytes survive
(`pragma quick_check` said `ok` after an hour of exactly that), because in-memory state — refusal budgets,
resolved capabilities, task graphs — diverges between them.

```bash
cat fleet/data/routes.json.lock                                      # the one supervisor
ps -eo pid,ppid,etime,command | grep "factory/main.ts" | grep -v grep # children with parents
```

Any `factory/main.ts` whose `PPID` is `1` — or anything other than the lock owner — is an orphan (and check `factory-instances/<repo>/orphan-events.log`, which now records the event even when the supervisor log cannot): `kill -TERM`
it (children honour `SIGTERM`; it is supervisors that don't, #110) and confirm exactly one remains. The count
alone is not evidence; the `PPID` column is what distinguishes a live child from an orphan.

**Check for orphans AFTER a restart is complete, not only after a crash (#125).** A restart that *looked*
clean left two instance processes running behind a new supervisor on 2026-11-01, and the symptom appeared
hours later as tasks with no result — which is why this check belongs at the end of every deploy rather than
in an incident runbook. Since #130 the children self-terminate within ~2 s of losing their supervisor, so a
survivor now means the watchdog did not work (or someone started an instance by hand) rather than "the build
was from before we fixed that":

```bash
pgrep -fl "factory/main[.]ts"                     # survivors of the previous generation (see note below)
ps -eo pid,ppid,lstart,command | grep factory/main.ts | grep -v grep
# PPID must equal the CURRENT supervisor's pid (fleet/data/routes.json.lock); an old START time is a survivor
lsof -- factory-instances/lalanikarim_drydock/engram-data/agent.sqlite   # who shares the durable store
ls -la factory-instances/*/engram-data/*.sqlite*  # stray -wal/-shm next to a running store means two openers
cat factory-instances/*/orphan-events.log         # the watchdog's own record, if it ever fired
```

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

## 9. Pre-flight checklist (a fresh machine, or before a demo)

| # | Check | Command | Passes when |
|---|---|---|---|
| 1 | Runtime config exists for every repo in the fleet | `ls ~/.drydock/configs` (or `$DRYDOCK_CONFIG_DIR`) | one `<owner>_<repo>.json` each; see §1a |
| 2 | Core is installed at the pinned version | `engram-core --version` | matches the pin in `docs/` / the runbook header |
| 3 | `.env` complete | compare against `.env.example` | model base URL + key, App id/key/installation, per-repo webhook secrets, Telegram pair (optional) |
| 4 | Registry says the repo is enabled | `node --experimental-strip-types factory/audit-registry.ts` | enabled, `eligibilityLabel: "agent"`, `autoMerge: false` |
| 5 | App permission posture | `node gates/github-app-check.mjs` | every managed repo answers `200` on both read and write probes; `Can merge? YES` |
| 6 | Nothing already holds the lock or the port | `cat fleet/data/routes.json.lock` (a bare pid; `ps -p <pid>` must fail), `lsof -nP -i :9700` | lock file absent or stale, listener port free |
| 7 | Webhook points at the current funnel URL | `gh api repos/<repo>/hooks --jq '.[].config.url'` | URL matches `tailscale funnel status` |

Steps 1 and 5 are the two that fail loudest when skipped: the supervisor refuses to start without runtime config, and a missing App permission turns every worker clone into an auth failure mid-run.

## 10. Shutdown & restart — what actually happens (2026-11-02)

**Order:** stop the supervisor — `kill -TERM $(cat fleet/data/routes.json.lock)`, since that file holds the live supervisor pid. Children are in the supervisor's process group and are asked to exit before it returns.

**What a clean stop looks like** (captured from a real supervisor run, not hand-written):

```
[supervisor] shutting down (received SIGTERM)
[supervisor] terminating 2 child process group(s): factory:lalanikarim/drydock, adapter
[factory:lalanikarim/drydock] [factory] SIGTERM — closing lalanikarim/drydock
[adapter] adapter: SIGTERM — closing
```

After it: the lock file is gone, `lsof -nP -i :9700` is empty, and no `factory/main.ts` remains. Children are started `detached`, each leading its own process group, which is why the supervisor can terminate the *group* rather than hope one pid covers a harness and whatever it spawned.

**A second `SIGTERM` exits immediately** and `SIGKILL`s whatever is left — the old behavior was to swallow repeated signals, which is why deploys historically ended in `kill -9` anyway (and that is what produced the orphans in #125).

**If the supervisor is `SIGKILL`ed**, each child notices within ~2 s (`ppid === 1`, or the recorded supervisor pid no longer existing), closes the core, and exits — so no harness is left serving an Engram store nobody dispatched. That teardown also checkpointed sqlite in testing (`agent.sqlite-wal`/`-shm` disappear on a clean close and survive a crash), which is how you can tell after the fact which kind of death happened.

**Where that event is recorded — read this when the log is empty.** A child's stdout is a pipe *into the supervisor*, so when the supervisor dies the pipe dies with it and the explanatory line has nowhere to go: an orphaned instance closing cleanly can leave zero trace in the supervisor log. It therefore appends the same line to a file the dead pipe cannot reach:

```bash
cat factory-instances/lalanikarim_drydock/orphan-events.log
# 2026-11-01T17:47:18.470Z [factory lalanikarim/drydock] orphaned (reparented-to-init): supervisor pid 4452 is gone, my ppid is 1 — exiting rather than serving unmanaged (#127). Runbook §7: check for other instances on this store.
```

A non-empty `orphan-events.log` means the safety net fired at least once: something was serving work with no supervisor, then stopped. Check whether another instance is on that store (`pgrep -fl 'factory/main[.]ts'`) before restarting, and treat a growing file as a sign the supervisor keeps dying.

**Restart budget: N restarts per repo, then the supervisor gives up — and what that costs.** On 2026-11-02 this fired for real during a deploy: both instances failed to boot because the inference host was unreachable, the budget exhausted in ~50 s, `giveUp()` asked everything to shut down, the adapter died with it, and every public webhook delivery hit a closed port — which GitHub records as a failed delivery and does **not** retry. The comment above `giveUp()` says "the operator must restart manually", and that is accurate; what it does not say is that deliveries are lost between the give-up and the human noticing. Check `inference` on `/health` before concluding an outage was caused by the code you just deployed.

**Known gaps.**
- **Inference reachability is probed and reported (#133).** The adapter probes the endpoint(s) every enabled repo pins and puts the result on `GET /health` as `inference: {state, reachable, total, checkedAt}` — state only, no provider id or hostname, because that response is reachable through the funnel. Per-provider detail (which host, what failed: `no-route` / `refused` / `dns` / `http-401` / `timeout`) is on `GET /health/inference`, which requires `Authorization: Bearer $ADAPTER_ADMIN_TOKEN`; **with no token configured the route does not exist** (404). It is *not* address-gated — see the warning below, this bit went wrong once. Tune with `INFERENCE_PROBE_INTERVAL_MS` (default 60000) and `INFERENCE_PROBE_TIMEOUT_MS` (default 5000). State *changes* are announced through the Telegram notifier, so an outage is heard when it happens rather than inferred from a stalled task. What this still cannot see: a host that answers `/models` but has not loaded the pinned model — and `status:"ok"` continues to mean "the listener lives", not "work will complete".
- **`/health/inference` is token-gated, never address-gated.** It shipped gating on a loopback peer address and leaked `aurora.infinidigm` plus 27 loaded model ids to an unauthenticated curl through the funnel, because Tailscale terminates the connection at the adapter *from* 127.0.0.1. Verify after any change: `curl -s https://<funnel>/health/inference` must be 404, and `curl -H "authorization: Bearer $ADAPTER_ADMIN_TOKEN" http://127.0.0.1:9700/health/inference` must be 200.
- The supervisor exits after its restart budget, taking the adapter with it; there is no decay window, so an outage longer than ~10 × boot time stops trying permanently (#133).
- A second supervisor is still refused only by the lock file; nothing detects a manually-started instance that never takes the lock.
- `orphan-events.log` has no rotation (it grows one short line per event, so it is slow — but it is never inspected automatically).
- The watchdog notices within its poll interval (~1 s), which is far shorter than any GitHub retry window but not zero.

**Verify, don't assume:**

```bash
cat fleet/data/routes.json.lock   # gone, or a pid `ps -p` cannot find
lsof -nP -i :9700                 # listener released
pgrep -fl "factory/main[.]ts|adapter[.]ts"   # nothing left holding an Engram store
```

**Why the bracket in `factory/main[.]ts`:** `pgrep -f` matches full command lines, and the command line of the
shell running the check *contains* the pattern — so `pgrep -fl "factory/main.ts"` counts the check itself. Seen
on 2026-11-02 reporting "3" instances where two existed, which is exactly the kind of number that makes an
orphan check look like it found something when it found nothing. The bracket matches a literal dot without
matching the pattern text. Same trap applies to `supervisor.ts run`: a `bash -c` wrapper left over from
launching the fleet matches it too, so compare pids against `routes.json.lock` rather than counting lines.

**Restart:** `nohup node --experimental-strip-types fleet/supervisor.ts run fleet/fleet.local.json >> log 2>&1 & disown`.
It reads `.env` at the repo root (gitignored), and since #138 that file should define `ADAPTER_ADMIN_TOKEN` —
without it `/health/inference` simply does not exist (that is the safe default, not a failure; public `/health`
is unaffected). If you restart from a shell that never sourced `.env`, expect a 404 there and set the variable
before assuming the probe broke. If the funnel URL changed while it was down, re-point the webhooks (§4) — GitHub does not retry deliveries that failed against the old URL, and §7 is how you find out which ones.

**Recovery if orphans do exist** (a pre-watchdog build, or a `SIGKILL` plus a hung child): see [`orphan-recovery-2026-11-01.md`](orphan-recovery-2026-11-01.md) — kill the old tree, confirm nothing shares the Engram store, then start one supervisor. Two harnesses over one durable store is the failure this whole section exists to prevent; the lock catches a second supervisor, and it does not catch anything else.

## 11. Backup and restore — the drill, not the intention (P0-4, 2026-11-02)

Everything the factory knows lives in four sqlite stores plus a config directory that is deliberately not in git:

| what | where |
|---|---|
| durable harness state (conversations, entries, tasks, submissions, documents) | `factory-instances/<owner>_<repo>/engram-data/agent.sqlite` |
| per-repo runtime config (`testCommand`, model pin, budgets) | `$DRYDOCK_CONFIG_DIR/<owner>_<repo>.json` (default `~/.drydock/configs/`) |
| fleet file + live routes | `fleet/fleet.local.json`, `fleet/data/routes.json` |
| standing lessons | `factory-instances/<owner>_<repo>/lessons.md` |

**Run the drill** (backup → verify → restore → boot from the restore):

```bash
node gates/backup-drill.mjs --keep 5              # backup + verify + restore drill
node gates/backup-drill.mjs --keep 5 --boot       # also boots an instance against the restored store
```

`--boot` needs a reachable inference endpoint — a factory instance refuses to start without its model (correct behavior, and see #133 for why that fact is currently invisible). Without it the drill still proves everything except "the application accepts this store".

**What each step asserts, and why:**

1. **`VACUUM INTO`, never `cp`.** The stores are in WAL mode: copying `agent.sqlite` alone can capture a database whose newest transactions are still sitting in `-wal`, and it restores as an *older* store with no indication anything is missing. `VACUUM INTO` folds the WAL in and produces one self-contained file.
2. **`PRAGMA integrity_check` on the copy**, not the source — a snapshot of corrupt data is corrupt and exits 0.
3. **Restore into a scratch tree and compare observable effects**: row counts per table and per-kind document counts against the manifest written at backup time. Counts, not exit codes — "the copy command succeeded" says nothing about what was copied.
4. **The restored store must be writable** (an `INSERT` inside a transaction that is rolled back). A harness does not read its database and stop; it commits within seconds of starting.
5. **`--boot` starts a real instance against the restored tree only**, via `FACTORY_INSTANCES_ROOT` — the same isolation seam the gates use. This is also the guard against the runbook's own worst case (§10: two harnesses over one store): the drill can never touch the live stores because it never points at them.

**Verified run (2026-11-02, real state, real model host):**

```
[1] snapshot each durable store (sqlite backup API, not cp)
  ok    lalanikarim_drydock: integrity_check ok, … bytes
        conversations=15 entries=460 tasks=430 submissions=28 documents=89 document_revisions=90
[3] restore drill: rebuild a working tree from the backup alone and verify it
  ok    lalanikarim_drydock: all table counts match (15, 460, 430, 28, 89, 90)
  ok    lalanikarim_drydock: document kinds match (6 kinds)
  ok    lalanikarim_drydock: writable (insert inside a rolled-back transaction)
[4] booting an instance against the RESTORED store (lalanikarim/drydock)
  ok    restored instance is serving with 15 conversation(s) recovered (backup held 15)
BACKUP DRILL PASSED
```

**Where backups go, and the limit that matters.** Default `~/drydock-backups/<timestamp>/`, mode `0700`. They contain webhook secrets and instance tokens (`fleet.local.json`, `routes.json`) — treat the directory as secret material, never commit it, never sync it to a shared drive unencrypted.

And the honest limit: **that directory is on the same physical disk as the stores.** The drill protects against operator error, a bad migration, and store corruption — it does not survive the machine dying. Off-host copies (encrypted, e.g. `age` + object storage) are the remaining gap; until then "we have backups" means "we can recover from our own mistakes", which is what P0-4 claimed and nothing more.

**Scheduling:** unattended runs belong to launchd like the delivery sweep (`com.drydock.redeliver`). Not installed yet — a backup job nobody has watched is how you find out it has been failing for a month, so if you schedule it, schedule `--keep` pruning and check the manifest after the first few runs.
