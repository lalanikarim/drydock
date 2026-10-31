# Enabling webhook-driven self-work on drydock

Date: 2026-10-31. Everything below is the remaining deployment path; the code side is finished and verified on `main`.

**Transport is deliberately not part of this design.** The factory listens on `127.0.0.1` and knows nothing about how a request reached it. Anything that gives GitHub an HTTPS URL whose requests arrive at that socket is acceptable — reverse proxy, hosted tunnel, cloud load balancer, tailnet funnel. Nothing here names or recommends one, because a runbook that hardcodes a transport quietly turns an operator choice into an architectural dependency, and the security properties below have to hold regardless of which one is picked.

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

- **Credential: GitHub App (B1-rev), no PAT.** `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` / `GITHUB_APP_INSTALLATION_ID` in `.env` describe the installation the factory is meant to use. Until queue item 3b wires them up, nothing reads them — which is why the next bullet still fires on this machine.
- `FACTORY_GITHUB_TOKEN` — when unset, clone and push do not fail; git uses the machine's credential helper. Verified on this host: with no token anywhere in the environment, a private repo still cloned, because `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` sets `credential.helper=osxkeychain` and that keychain entry is an **account-wide** token. Setting the variable makes the factory's actual credential explicit and lets it be scoped to one repo; leaving it unset means "which token pushed that?" has no answer in config. **Since #70:** boot no longer stays silent about this — `factory/main.ts` logs the resolved credential path, and the host-helper fallback is a `WARNING … ACCOUNT-WIDE` line you cannot miss in the startup log (e.g. `WARNING — git credential: NO factory token configured — clone/push will fall back to the host credential helper(s): osxkeychain (…)`)
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

**Known false positive (#81):** a cold start currently costs one adapter restart. The supervisor writes routes with no `target` (nothing is ready yet), the adapter records that hash, then the first factory becoming ready rewrites the file with its target — and the drift guard treats *any* change as policy drift, so it refuses requests (503) and exits for a restart that converges ~13 s later. It self-heals and GitHub retries, so publishing is safe; what it costs is an alarming line in every boot log plus a short window where deliveries depend on retry. The fix belongs in the adapter: classify a target-only change as a reload and keep hard drift for repo-set / secret / label / sender changes.

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

## 5. Smoke test, and what a failure looks like

Pick or create an issue genuinely worth doing, then:

```bash
gh issue edit <n> -R lalanikarim/drydock --add-label build
tail -f fleet/data/intake-adapter.jsonl      # one line per inbound event, with reason on refusal
```

Dispatch → worker clones, runs `npm ci`, implements, is independently reviewed → **draft PR**, and it stops there. A rejected event (wrong label, bad signature, cross-repo naming) is logged with a reason; GitHub retries 5xx, so an instance that is down does not silently lose work — `requestId = issue-<n>` makes the redelivery idempotent.

Two operational facts worth remembering: re-labeling an issue **cannot** re-run it (same `requestId`, permanently deduplicated in the durable store — use a fresh issue or a manual `POST /tasks`), and removing the eligibility label after merge is still manual, as it is for the fixtures.

## Rollback

```bash
gh api -X PATCH repos/lalanikarim/drydock/hooks/<hook-id> -f active=false   # stop intake at the source
# then unpublish/stop whatever forwards to 127.0.0.1:9700, per that tool's own commands
```

Disabling self-work entirely is one line in the registry (`enabled: false`), which both the supervisor and `factory/main.ts` enforce before any child spawns — demonstrated live when the first self-run refused to start.
