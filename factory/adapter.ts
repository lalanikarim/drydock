// Multi-repo webhook adapter (multi-repo plan §3.2), ported to TS.
//
// One reachable intake endpoint in front of N factory instances. Each managed
// repo's GitHub webhook points here with its OWN secret; the raw body's HMAC
// is verified against every configured secret BEFORE parsing, and the matching
// secret determines which instance's /tasks receives the event. A payload that
// names a different repo than the one whose secret signed it is rejected 403
// (gate M3).
//
// Routes file: JSON array of { repo, secret, target, token } where target is
// the owning instance's base URL (e.g. "http://127.0.0.1:9601") and token is
// that instance's API_TOKEN (the core server requires Bearer auth on /tasks).
//
// Standalone: node --experimental-strip-types factory/adapter.ts [port] <routesFile> [logPath]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  startIntakeServer,
  loadRoutes,
  intakeRequestId,
  renderIntakeContent,
  renderRefineContent,
  refineTriggerFromEvent,
  classifyWebhookEvent,
  directiveFromEvent,
  RoutesDriftedError,
  type Route,
} from "./intake.ts";
import { fetchIssueState } from "./gh-read.ts";
import { authorizePrFeedback, fetchPrFacts, prNumberFromEvent, renderPrFeedbackContent, type PrFacts } from "./pr-feedback.ts";
import { createGitAuth, gitAuthEnv, type GitAuth } from "./github-auth.ts";

/**
 * sha256 of a routes file. The supervisor and the adapter both report this hash in their startup
 * logs, so a drift event is diagnosable from logs alone: which write does the running adapter not
 * match? (#69)
 */
export function routesFileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The policy-relevant projection of a routes list: every field except `target`, serialized
 * deterministically. This exists because the routes file mixes two kinds of state — policy (which
 * repos are served, which secret signs for each, which label makes work eligible, who may send) and
 * runtime state (the ephemeral port a factory child learned after it became ready). Only the first
 * deserves a process boundary; treating the second as drift made every cold start cost an adapter
 * restart (#81), because "a factory finished booting" rewrites the file by design.
 *
 * Array order inside a route (e.g. `allowedSenders`) is significant here: a reordered allowlist is
 * treated as a change and forces the conservative path. Being occasionally over-strict about drift is
 * safe; being clever about it is how a policy reload gets missed.
 */
export function policyFingerprint(routes: unknown): string {
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        if (key === "target") continue; // runtime state, not authority
        out[key] = project((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  const list = Array.isArray(routes) ? routes : [];
  // Sort route entries by repo so the fingerprint does not depend on serialization order across
  // writers; a repo appearing or disappearing still changes the set, and therefore the fingerprint.
  const projected = list.map(project).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(projected)).digest("hex");
}

/**
 * Per-request drift check for a routes file (decision C3, #69), refined by #81.
 *
 * The adapter validates signatures and routes against the snapshot it loaded at start. If the file on
 * disk no longer hashes to that snapshot, the change is classified rather than assumed fatal:
 *
 *  - **policy unchanged** (only `target` values moved): adopt the new targets in place and keep
 *    serving. This is a factory becoming ready, not an authority change, and both hashes are logged so
 *    the reload is visible in exactly the same way a refusal is.
 *  - **anything else** — secret, token, eligibility label, sender allowlist, repo set, an unparsable or
 *    unreadable file: refuse the request (503) and stop, so the supervisor restarts against current
 *    policy. No silent reload of authority; "policy reviews like code" survives intact.
 *
 * `liveRoutes` is the array this process is actually routing with; it is mutated in place on a benign
 * reload so dispatch follows the new port instead of a dead one. Without it, a target-only change still
 * cannot be applied safely, so the check reports drift — conservative by construction.
 *
 * `terminate` is injectable so tests can observe the exit instead of dying; the default exits after a
 * short delay so the 503 response has a chance to flush first.
 */
export function makeRoutesDriftCheck({ routesFile, startupHash, terminate, liveRoutes, onReload }: {
  routesFile: string;
  startupHash: string;
  terminate?: () => void;
  liveRoutes?: Route[];
  onReload?: (routes: Route[]) => void;
}): () => void {
  const die = terminate ?? (() => setTimeout(() => process.exit(1), 250).unref());

  // Baseline authority: prefer the snapshot in memory (that is what we are routing with), else the
  // bytes at construction time. A baseline we cannot compute means every later change is drift.
  let knownPolicy: string | null;
  try {
    knownPolicy = policyFingerprint(liveRoutes ?? JSON.parse(readFileSync(routesFile, "utf8")));
  } catch {
    knownPolicy = null;
  }
  let knownHash = startupHash;

  return () => {
    let current: string;
    try {
      current = routesFileHash(routesFile);
    } catch {
      current = "<unreadable>"; // a missing file is drift too: the policy behind us is gone
    }
    if (current === knownHash) return;

    // Something changed. Before refusing, ask whether it touched authority at all.
    if (liveRoutes && knownPolicy !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(routesFile, "utf8"));
      } catch {
        parsed = undefined; // unparsable is never benign
      }
      if (parsed !== undefined && policyFingerprint(parsed) === knownPolicy) {
        const before = liveRoutes.map((r) => `${r.repo}:${r.target ?? "-"}`).join(", ");
        const next = parsed as Route[];
        for (const route of liveRoutes) {
          const fresh = next.find((r) => r?.repo === route.repo);
          if (fresh && typeof fresh.target === "string") route.target = fresh.target;
          else if (!fresh || fresh.target === undefined) delete route.target; // factory exited: refuse until it returns
        }
        knownHash = current;
        const changed = liveRoutes.map((r) => `${r.repo}:${r.target ?? "-"}`).join(", ");
        if (before !== changed) {
          console.log(`[adapter] routes refreshed at runtime: target-only change adopted in place (policy ${knownPolicy.slice(0, 16)}, file ${current.slice(0, 16)}; ${changed})`);
        }
        onReload?.(next);
        return;
      }
    }

    console.error(`[adapter] routes drift: ${routesFile} changed since start (startup ${knownHash.slice(0, 16)}, now ${String(current).slice(0, 16)}) — exiting for supervisor restart`);
    die();
    throw new RoutesDriftedError(`routes file changed since adapter start (startup hash ${knownHash.slice(0, 16)}, current ${String(current).slice(0, 16)})`);
  };
}

/**
 * Build a dispatch(repo, event) that forwards to the owning instance's /tasks.
 *
 * Two shapes of task come out of one webhook endpoint (#67):
 *
 *   - a labeled issue  → the issue content the factory has always run;
 *   - a refinement request (`refine` label or `/refine …` issue comment, #65) → a refine_issue task, after
 *     the host confirms the issue is still open; it posts a comment and does nothing else;
 *   - a `/factory …` comment on an open PR → a rework task, but only after the host reads the PR's
 *     real state and authorizes it (open, and head branch we own). Comments are cheap to make and
 *     expensive to act on, so authorization runs against `gh pr view`, never against the payload.
 *
 * A policy refusal returns { accepted: false, reason } instead of throwing: the intake answers 2xx so
 * GitHub stops retrying something that will be refused identically forever, while a thrown error
 * still means "502, retry me". `fetchPrFacts` and `gitAuth` are injectable so tests never shell out.
 */
export function makeRouteDispatch(
  routes: Route[],
  {
    fetchPr = fetchPrFacts,
    fetchState = fetchIssueState,
    gitAuth,
  }: {
    fetchPr?: (repo: string, prNumber: number, token: string) => Promise<PrFacts | null>;
    fetchState?: (repo: string, issueNumber: number, token: string) => Promise<string | null>;
    gitAuth?: GitAuth;
  } = {},
) {
  const byRepo = new Map(routes.map((r) => [r.repo, r]));
  const auth: GitAuth = gitAuth ?? createGitAuth();
  return async (repo: string, event: any) => {
    const route = byRepo.get(repo);
    if (!route?.target) throw new Error(`no /tasks target configured for ${repo}`);

    // Same classifier the intake used to accept this delivery — re-derived rather than trusted from
    // the caller, so a dispatcher invoked by anything else still applies the same rules.
    const verdict = classifyWebhookEvent(event, {
      eligibilityLabel: route.eligibilityLabel,
      prFeedback: route.prFeedback === true,
      refine: route.refine === true,
      refineLabel: route.refineLabel,
    });
    if (!verdict.accepted) return { accepted: false, reason: verdict.reason };

    let requestId: string;
    let content: string;
    if (verdict.kind === "refine") {
      // Refinement reads and writes prose, so it still gets a liveness check: an event for an issue that
      // closed while this was in flight would otherwise post a brief onto a dead thread.
      const issueNumber = event?.issue?.number;
      if (!Number.isInteger(issueNumber)) return { accepted: false, reason: "refinement event does not identify an issue" };
      const authEnv = await gitAuthEnv(auth);
      const state = await fetchState(repo, issueNumber, authEnv.GH_TOKEN ?? "");
      if (state === null) return { accepted: false, reason: `issue #${issueNumber} not found in ${repo}` };
      if (state !== "open") return { accepted: false, reason: `issue #${issueNumber} is ${state}, not open` };
      const { trigger, guidance, sender } = refineTriggerFromEvent(event);
      requestId = verdict.requestId;
      content = renderRefineContent(event, { trigger, guidance, sender });
    } else if (verdict.kind === "issue") {
      requestId = intakeRequestId(event);
      content = renderIntakeContent(event);
    } else {
      const prNumber = prNumberFromEvent(event);
      if (!prNumber) return { accepted: false, reason: "PR feedback event does not identify a pull request" };
      const authEnv = await gitAuthEnv(auth);
      const facts = await fetchPr(repo, prNumber, authEnv.GH_TOKEN ?? "");
      const authz = authorizePrFeedback(facts, { repo, prNumber });
      if (!authz.allowed) return { accepted: false, reason: authz.reason };
      requestId = verdict.requestId;
      content = renderPrFeedbackContent({
        repo,
        prNumber,
        issueNumber: authz.issueNumber,
        facts: facts as PrFacts,
        directive: directiveFromEvent(event),
        sender: event?.sender?.login ?? "unknown",
      });
    }

    const res = await fetch(`${route.target.replace(/\/$/, "")}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(route.token ? { authorization: `Bearer ${route.token}` } : {}),
      },
      body: JSON.stringify({ requestId, content }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`factory for ${repo} rejected task (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
}

// Standalone entrypoint.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = process.argv[2] ? Number(process.argv[2]) : 9700;
  const routesFile = process.argv[3];
  if (!routesFile) {
    console.error("usage: node factory/adapter.ts [port] <routesFile> [logPath]");
    process.exit(1);
  }
  const routes = loadRoutes(routesFile);
  // Hash the same bytes we just parsed, so startup and per-request checks compare like with like.
  const startupHash = routesFileHash(routesFile);
  const logPath = process.argv[4] ?? "data/intake-adapter.jsonl";
  startIntakeServer({
    port,
    host: process.env.ADAPTER_HOST ?? "127.0.0.1", // reachable only behind a TLS proxy with ADAPTER_HOST set
    routes,
    dispatch: makeRouteDispatch(routes),
    logPath,
    routesDriftCheck: makeRoutesDriftCheck({ routesFile, startupHash, liveRoutes: routes }),
  }).then(({ server, port: actualPort, host }) => {
    // Both hashes are printed because they answer different questions: routes-hash is "which bytes am
    // I serving?" and policy-hash is "which authority am I serving under?" — a target-only refresh
    // moves the first and must never move the second (#81).
    console.log(`adapter listening on http://${host}:${actualPort} (routes: ${routes.map((r) => r.repo).join(", ")}, routes-hash ${startupHash.slice(0, 16)}, policy-hash ${policyFingerprint(routes).slice(0, 16)})`);
    const shutdown = () => {
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((e) => {
    console.error("adapter failed to start:", e);
    process.exit(1);
  });
}
