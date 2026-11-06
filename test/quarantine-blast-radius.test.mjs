// #185 — one repo's unreadable config must not take the fleet down.
//
// On 2026-11-03 a typo in ONE repo's runtime config (`_comment_setup`; only `_comment` and `_notes` are inert)
// produced exactly this sequence:
//
//   [factory:lalanikarim/engram] err: ... fatal: Error: unknown config field: _comment_setup
//   [supervisor] factory:lalanikarim/engram exceeded 10 restarts — giving up and exiting non-zero
//   [supervisor] terminating 2 child process group(s): factory:lalanikarim/drydock, adapter
//
// `drydock` was healthy. It had a route the funnel was serving and merged work in its store. It died because
// its neighbour could not parse a JSON key — via MAX_RESTARTS on one repo calling the global shutdown path,
// which also killed the adapter, the only component that could have reported the outage.
//
// The tests are ordered cheapest-first; the last spawns REAL processes, because the defect is process death
// and "the function returned without throwing" would have described the old code just as happily.
//
//   node --experimental-strip-types --test test/quarantine-blast-radius.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { buildRoutes } from "../fleet/supervisor.ts";
import { makeRouteDispatch, policyFingerprint, makeRoutesDriftCheck, routesFileHash } from "../factory/adapter.ts";
import { startIntakeServer, RepoUnavailableError } from "../factory/intake.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const tmp = () => mkdtempSync(join(tmpdir(), "quarantine-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REGISTRY = { repos: [{ repo: "o/a", eligibilityLabel: "agent" }, { repo: "o/b", eligibilityLabel: "agent" }] };
const FACTORIES = [{ repo: "o/a", secret: "sa", token: "ta" }, { repo: "o/b", secret: "sb", token: "tb" }];

// --- buildRoutes: the marker travels, and only for the sick repo -------------------------------
test("a quarantined repo keeps its route and carries the reason; siblings are untouched (#185)", () => {
  const bases = new Map([
    ["o/a", "http://127.0.0.1:1111"],
    ["o/b", "http://127.0.0.1:2222"],
  ]);
  const sick = new Map([["o/b", "unknown config field: _comment_setup"]]);

  const clean = buildRoutes(FACTORIES, bases, REGISTRY, {}, new Map());
  assert.ok(clean.every((r) => r.quarantined === undefined), "no quarantine means the route shape is unchanged");

  const routes = buildRoutes(FACTORIES, bases, REGISTRY, {}, sick);
  assert.equal(routes.length, 2, "the quarantined repo is NOT removed — removing it would make its webhook secret unknown to the adapter");
  assert.equal(routes.find((r) => r.repo === "o/b").quarantined, "unknown config field: _comment_setup");
  assert.equal(routes.find((r) => r.repo === "o/a").quarantined, undefined);
  assert.equal(routes.find((r) => r.repo === "o/a").target, "http://127.0.0.1:1111", "the healthy sibling keeps serving");
});

// --- policy fingerprint: quarantine is runtime state, not authority -----------------------------
test("marking a repo sick does NOT change the policy fingerprint (otherwise it kills the adapter)", () => {
  const base = [{ repo: "o/a", secret: "s", token: "t", eligibilityLabel: "agent", target: "http://127.0.0.1:1" }];
  const sickened = [{ ...base[0], quarantined: "unknown config field: x" }];
  assert.equal(policyFingerprint(sickened), policyFingerprint(base), "a repo going sick is runtime state like target (#81), not an authority change");

  // ...and the fields that ARE authority must still move it, so this exclusion cannot be smuggled in.
  for (const [what, mutated] of [
    ["secret", [{ ...base[0], secret: "rotated" }]],
    ["token", [{ ...base[0], token: "other" }]],
    ["eligibilityLabel", [{ ...base[0], eligibilityLabel: "build" }]],
  ]) {
    assert.notEqual(policyFingerprint(mutated), policyFingerprint(base), `${what} must still change the fingerprint`);
  }
});

// --- dispatch + HTTP layer: distinguishable refusal over a real server --------------------------
/** A stand-in for a running factory instance; records whether anything reached it. */
async function startUpstreamStub(name) {
  const hits = [];
  const { server, port } = await startServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: true, kind: "issue", requestId: "issue-7", servedBy: name }));
  });
  return { port, hits, close: () => new Promise((r) => server.close(r)) };
}

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

test("a delivery to a quarantined repo is refused 503 with a code; its sibling is served normally", async () => {
  const upstream = await startUpstreamStub("instance-a");
  let server = null;
  try {
    const routes = [
      { repo: "o/a", secret: "sa", token: "ta", target: `http://127.0.0.1:${upstream.port}`, eligibilityLabel: "agent" },
      { repo: "o/b", secret: "sb", token: "tb", eligibilityLabel: "agent", quarantined: "unknown config field: _comment_setup" },
    ];
    const started = await startIntakeServer({ port: 0, host: "127.0.0.1", routes, dispatch: makeRouteDispatch(routes) });
    server = started.server;

    const post = async (repo, secret) => {
      const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: repo }, issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent" }] } }));
      const res = await fetch(`http://127.0.0.1:${started.port}/webhook/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    }

    const sick = await post("o/b", "sb");
    assert.equal(sick.status, 503, `expected a refusal that GitHub will retry, got ${sick.status}`);
    assert.equal(sick.json.code, "repo_quarantined", `refusal must be greppable by code, got ${JSON.stringify(sick.json)}`);
    assert.match(sick.json.error, /_comment_setup/, "the reason the supervisor recorded reaches the delivery log");

    const healthy = await post("o/a", "sa");
    assert.equal(healthy.status, 202, `sibling must still be served, got ${healthy.status} ${JSON.stringify(healthy.json)}`);
    assert.deepEqual(upstream.hits, ["/factory/intake"], "only the healthy repo's instance may be contacted");
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await upstream.close();
  }
});

test("dispatch refuses a quarantined repo with RepoUnavailableError before any GitHub read", async () => {
  const routes = [{ repo: "o/b", secret: "sb", eligibilityLabel: "agent", quarantined: "port already in use" }];
  const dispatch = makeRouteDispatch(routes);
  await assert.rejects(
    () => dispatch("o/b", { action: "opened", repository: { full_name: "o/b" }, issue: { number: 1, labels: [{ name: "agent" }] } }),
    (e) => e instanceof RepoUnavailableError && e.httpStatus === 503 && e.code === "repo_quarantined",
  );
});

// --- live adoption: quarantine appears while the adapter is running ------------------------------
test("a quarantine written after the adapter started is adopted in place — no adapter restart, no sibling outage", async () => {
  const dir = tmp();
  let server = null;
  try {
    const routesFile = join(dir, "routes.json");
    const routes = [
      { repo: "o/a", secret: "sa", eligibilityLabel: "agent", target: "http://127.0.0.1:1" },
      { repo: "o/b", secret: "sb", eligibilityLabel: "agent" },
    ];
    writeFileSync(routesFile, JSON.stringify(routes, null, 2));
    const terminated = [];
    const check = makeRoutesDriftCheck({ routesFile, startupHash: routesFileHash(routesFile), terminate: () => terminated.push(1), liveRoutes: routes });

    const started = await startIntakeServer({ port: 0, host: "127.0.0.1", routes, dispatch: makeRouteDispatch(routes), routesDriftCheck: check });
    server = started.server;

    // The supervisor quarantines o/b and rewrites the file (target removed, reason added).
    writeFileSync(routesFile, JSON.stringify([{ ...routes[0] }, { ...routes[1], quarantined: "unknown config field: x" }], null, 2));

    const post = async (repo, secret) => {
      const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: repo }, issue: { number: 9, labels: [{ name: "agent" }] } }));
      return fetch(`http://127.0.0.1:${started.port}/webhook/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
    };

    const res = await post("o/b", "sb");
    assert.equal(terminated.length, 0, "adopting a quarantine must not look like an authority change — that would take every sibling down (#185)");
    const json = await res.json().catch(() => ({}));
    assert.doesNotMatch(String(json.error ?? ""), /routes file changed/, "the adapter must not treat a quarantine as policy drift");
    assert.equal(res.status, 503, `expected the adopted quarantine to refuse, got ${res.status} ${JSON.stringify(json)}`);
    assert.equal(json.code, "repo_quarantined");
  } finally {
    if (server) await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- real processes: the defect is process death -------------------------------------------------
async function freePort() {
  const { server, port } = await startServer(() => {});
  await new Promise((r) => server.close(r));
  return port;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("supervisor with two repos: the sick one quarantines, the healthy one keeps serving, supervisor stays up, operator is alerted", async () => {
  const dir = tmp();
  let child = null;
  let alertServer = null;
  try {
    // Two registered repos, each with its own instances root so nothing touches production factory-instances/.
    // The registry is written into the redirected config dir below, so "registered" here means the fixture, not
    // whatever this machine happens to manage.
    // A self-contained model catalog (#47/#171): the kernel builds its catalog from $PI_AGENT_DIR/models.json
    // and refuses to boot a pinned ref that is not in it, so the healthy sibling needs a provider that really
    // resolves — declared here rather than read from the operator's home directory, which keeps this test
    // runnable on a machine with no inference configured. No endpoint is contacted: nothing sends a completion.
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { testprov: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "stub-key", models: [{ id: "test/model", name: "Test Model" }] } } }));

    // Runtime config is resolved from $DRYDOCK_CONFIG_DIR/<owner>_<repo>.json, and the supervisor pre-flights
    // exactly that path for every repo in the fleet before it writes a single route ("nothing was started").
    // Pointing the variable at a temp directory with the conventional names keeps this hermetic: on my machine
    // the real ~/.drydock/configs exists and the test passed for the wrong reason; on CI it failed loudly, which
    // is the value of running the suite somewhere that has none of your setup.
    const cfgDir = join(dir, "configs");
    mkdirSync(cfgDir, { recursive: true });
    // The repo registry lives beside the runtime configs now, so the same DRYDOCK_CONFIG_DIR redirect makes
    // policy hermetic too. Naming exactly these two repos is also what keeps a production entry — with its
    // autoMerge and pathAllowlist — out of a test that spawns real processes.
    writeFileSync(
      join(cfgDir, "repo-registry.json"),
      JSON.stringify({
        repos: [
          { repo: "lalanikarim/factory-fixture", enabled: true, autoMerge: false },
          { repo: "lalanikarim/factory-fixture-2", enabled: true, autoMerge: false },
        ],
      }),
    );
    const goodConfig = join(cfgDir, "lalanikarim_factory-fixture.json");
    writeFileSync(goodConfig, JSON.stringify({ repo: "lalanikarim/factory-fixture", models: { provider: "testprov", modelId: "test/model" } }));
    // The exact incident: one unknown key. Strict-at-boot is correct, so this child dies immediately, every time.
    const badConfig = join(cfgDir, "lalanikarim_factory-fixture-2.json");
    writeFileSync(badConfig, JSON.stringify({ repo: "lalanikarim/factory-fixture-2", models: { provider: "test-provider", modelId: "test/model" }, _comment_setup: "typo: only _comment and _notes are inert" }));

    const port = await freePort();
    const routesFile = join(dir, "routes.json");
    const alertHits = [];

    // Alerts go to a local stub through the drill seam (TELEGRAM_API_BASE), so this proves the whole notifier
    // path — event kind, dedupe key, rendering, HTTP send — without messaging a real operator.
    alertServer = await startServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += String(d)));
      req.on("end", () => {
        alertHits.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 9004 } }));
      });
    });

    writeFileSync(
      join(dir, "fleet.json"),
      JSON.stringify({
        adapter: { port, routesFile, logPath: join(dir, "adapter.jsonl") },
        factories: [
          { repo: "lalanikarim/factory-fixture", secret: "secret-good", instancesRoot: join(dir, "inst-good"), config: goodConfig },
          { repo: "lalanikarim/factory-fixture-2", secret: "secret-bad", instancesRoot: join(dir, "inst-bad"), config: badConfig },
        ],
      }),
    );

    const log = [];
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "fleet", "supervisor.ts"), "run", join(dir, "fleet.json")], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so teardown can prove no orphan is left behind (runbook §7)
      env: {
        ...process.env,
        FACTORY_SUPERVISOR_LOCK: join(dir, "supervisor.lock"),
        FACTORY_MAX_RESTARTS: "1", // quarantine after one retry instead of ten
        FACTORY_RESTART_BACKOFF_MS: "250",
        DRYDOCK_CONFIG_DIR: cfgDir,
        PI_AGENT_DIR: agentDir,
        DEFAULT_MODEL: "testprov:test/model",
        // The env-driven provider is registered from OPENAI_BASE_URL + OPENAI_API_KEY as PI_PROVIDER_ID ??
        // "aurora"; leaving them unset keeps the catalog exactly the one declared above, so nothing in this
        // test can reach a real endpoint by accident.
        OPENAI_BASE_URL: "",
        OPENAI_API_KEY: "",
        // Alerts go to the local stub through the drill seam. Fake credentials plus a fake chat id, because a
        // test that messages a real operator is a defect (#162) — and this run would otherwise inherit .env.
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "111111",
        TELEGRAM_API_BASE: `http://127.0.0.1:${alertServer.port}`,
      },
    });
    const capture = (s) => s.on("data", (d) => log.push(String(d)));
    capture(child.stdout);
    capture(child.stderr);

    const supervisorPid = child.pid;
    assert.ok(supervisorPid > 0);

    // Wait for both halves of the observable end state.
    // Wait for BOTH halves of the end state. The quarantine lands in seconds (the bad config dies at parse
    // time); a real instance takes longer to boot and publish its port, so breaking out on the first condition
    // alone would race the sibling it is supposed to prove still works.
    const deadline = Date.now() + 120_000;
    let routes = [];
    let quarantined = null;
    let goodTarget = null;
    while (Date.now() < deadline) {
      if (existsSync(routesFile)) {
        try {
          routes = JSON.parse(readFileSync(routesFile, "utf8"));
          quarantined = routes.find((r) => r.repo === "lalanikarim/factory-fixture-2")?.quarantined ?? null;
          goodTarget = routes.find((r) => r.repo === "lalanikarim/factory-fixture")?.target ?? null;
          if (quarantined && goodTarget) break;
        } catch {
          /* mid-write: read again */
        }
      }
      if (!alive(supervisorPid)) break; // died — fall through to the assertions, which will say how
      await sleep(250);
    }

    const text = log.join("");
    assert.ok(alive(supervisorPid), `the supervisor must NOT exit when one repo cannot boot. Output:\n${text}`);

    assert.ok(quarantined, `expected factory-fixture-2 marked quarantined in routes.json. Routes: ${JSON.stringify(routes)}\nOutput:\n${text}`);
    assert.match(text, /QUARANTINE factory:lalanikarim\/factory-fixture-2/, "the quarantine must be loud in the supervisor log");
    assert.match(quarantined, /unknown config field: _comment_setup/, "the reason must name the actual fault, not just 'exit 1'");

    // The healthy sibling: still a live child, still holding a route with a target that answers.
    const good = routes.find((r) => r.repo === "lalanikarim/factory-fixture");
    assert.ok(goodTarget, `healthy repo should have published its port while its neighbour was being quarantined. Routes: ${JSON.stringify(routes)}\nOutput:\n${text}`);
    // /health is bearer-gated like every other instance surface (#122): the token in the routes file is what
    // the adapter would use, so asking with it answers the real question — can this repo still be served?
    const healthRes = await fetch(`${good.target.replace(/\/$/, "")}/health`, {
      headers: { authorization: `Bearer ${good.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(healthRes.status, 200, "the healthy repo is still serving its own /health while its neighbour is quarantined");

    // And the adapter — the component that used to die with everything else — refuses the sick repo by code.
    const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "lalanikarim/factory-fixture-2" }, issue: { number: 3, labels: [{ name: "agent" }] } }));
    const refusal = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "secret-bad").update(body).digest("hex")}`,
      },
      body,
    });
    assert.equal(refusal.status, 503, "deliveries to a quarantined repo are refused, not accepted-and-dropped");
    assert.equal((await refusal.json()).code, "repo_quarantined");

    // The alert: one message, through the real notifier, containing the repo and the reason.
    const alerted = await waitFor(() => alertHits.length > 0, 15_000);
    assert.ok(alerted, `expected one quarantine alert via the Telegram API; hits=${alertHits.length}\nOutput:\n${text}`);
    assert.match(alertHits.join("\n"), /factory-fixture-2/);
    assert.match(alertHits.join("\n"), /quarantined/i);
  } finally {
    if (child && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM"); // whole group: supervisor + adapter + instance
      } catch {
        /* already gone */
      }
      const exited = await waitFor(() => !alive(child.pid), 15_000);
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    if (alertServer) await new Promise((r) => alertServer.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}
