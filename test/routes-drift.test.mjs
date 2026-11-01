// #69: the adapter must never serve on stale policy. The supervisor writes the routes file before
// spawning anything (atomically), and the adapter re-hashes it on every webhook request; a changed
// file means refuse with 503 and exit, so the supervisor restarts against current policy.
//
//   node --experimental-strip-types --test test/routes-drift.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routesFileHash, makeRoutesDriftCheck, policyFingerprint, makeRouteDispatch } from "../factory/adapter.ts";
import { RoutesDriftedError, startIntakeServer } from "../factory/intake.ts";
import { writeRoutesFile } from "../fleet/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "routes-drift-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ROUTES_FILE = join(dir, "routes.json");
const initialRoutes = [{ repo: "octo/one", secret: "s1" }, { repo: "octo/two", secret: "s2" }];
writeFileSync(ROUTES_FILE, JSON.stringify(initialRoutes, null, 2));

// --- writeRoutesFile --------------------------------------------------------
test("writeRoutesFile writes valid JSON and returns the sha256 of exactly what it wrote", () => {
  const hash = writeRoutesFile(join(dir, "fresh.json"), [{ repo: "octo/x", secret: "s" }]);
  const onDisk = readFileSync(join(dir, "fresh.json"), "utf8");
  assert.equal(routesFileHash(join(dir, "fresh.json")), hash);
  JSON.parse(onDisk); // a reader must always see complete policy, never a partial document
});

test("writeRoutesFile overwrites in place and leaves no temp files behind", () => {
  const target = join(dir, "over.json");
  writeFileSync(target, "[{\"repo\":\"stale/old\",\"secret\":\"x\"}]");
  writeRoutesFile(target, [{ repo: "octo/new", secret: "y" }]);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), [{ repo: "octo/new", secret: "y" }]);
  const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp-"));
  assert.equal(leftovers.length, 0, `temp files left behind: ${leftovers.join(", ")}`);
});

// --- makeRoutesDriftCheck ---------------------------------------------------
test("no change to the routes file passes the check", () => {
  const startup = routesFileHash(ROUTES_FILE);
  const terminateCalls = [];
  const check = makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup, terminate: () => terminateCalls.push(1) });
  assert.doesNotThrow(check);
  assert.equal(terminateCalls.length, 0);
});

test("a changed routes file throws RoutesDriftedError and schedules termination", () => {
  const startup = routesFileHash(ROUTES_FILE);
  writeFileSync(ROUTES_FILE, JSON.stringify([...initialRoutes, { repo: "octo/three", secret: "s3" }], null, 2));
  const terminateCalls = [];
  const check = makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup, terminate: () => terminateCalls.push(1) });
  assert.throws(check, RoutesDriftedError);
  assert.equal(terminateCalls.length, 1, "drift must schedule exactly one termination");
});

test("a missing routes file is drift too — the policy behind the adapter is gone", () => {
  const startup = "0".repeat(64);
  rmSync(join(dir, "gone.json"), { force: true });
  const terminateCalls = [];
  const check = makeRoutesDriftCheck({ routesFile: join(dir, "gone.json"), startupHash: startup, terminate: () => terminateCalls.push(1) });
  assert.throws(check, RoutesDriftedError);
  assert.equal(terminateCalls.length, 1);
});

// --- intake server honors the drift check ------------------------------------
test("a webhook request during drift is refused with 503 and never dispatched", async () => {
  const startup = routesFileHash(ROUTES_FILE);
  writeFileSync(ROUTES_FILE, JSON.stringify(initialRoutes.slice(0, 1), null, 2)); // policy shrank out from under us
  const dispatched = [];
  const terminated = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: initialRoutes, // the snapshot the adapter started with
    dispatch: async (repo) => { dispatched.push(repo); return {}; },
    routesDriftCheck: makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup, terminate: () => terminated.push(1) }),
  });
  try {
    const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "octo/one" }, issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent" }] } }));
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": `sha256=${createHmac("sha256", "s1").update(body).digest("hex")}` },
      body,
    });
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.match(payload.error, /routes file changed since adapter start/);
    assert.equal(dispatched.length, 0, "a stale route set must never reach dispatch");
    assert.equal(terminated.length, 1, "the checker scheduled termination for the supervisor to act on");
  } finally {
    server.close();
  }
});

test("with an unchanged routes file the same request flows through normally", async () => {
  const startup = routesFileHash(ROUTES_FILE); // hash of whatever is on disk now; no further changes
  const dispatched = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: initialRoutes.slice(0, 1),
    dispatch: async (repo) => { dispatched.push(repo); return {}; },
    routesDriftCheck: makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup }),
  });
  try {
    const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "octo/one" }, issue: { number: 8, title: "t", body: "b", labels: [{ name: "agent" }] } }));
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": `sha256=${createHmac("sha256", "s1").update(body).digest("hex")}` },
      body,
    });
    assert.equal(res.status, 202);
    assert.deepEqual(dispatched, ["octo/one"]);
  } finally {
    server.close();
  }
});


// --- #81: policy changes are fatal; runtime state (target) is not ------------
// A cold start writes routes with no target, then each factory becoming ready rewrites the file with
// its port. That is the designed sequence, so it must not look like an authority change — but every
// field that actually carries authority still has to be fatal.
const freshFile = (name, routes) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(routes, null, 2));
  return path;
};

test("policyFingerprint ignores target and key order, and notices everything else", () => {
  const base = [{ repo: "o/a", secret: "s1", token: "t1", eligibilityLabel: "build", allowedSenders: ["me"], target: "http://127.0.0.1:1" }];
  assert.equal(policyFingerprint(base), policyFingerprint([{ token: "t1", repo: "o/a", allowedSenders: ["me"], secret: "s1", eligibilityLabel: "build", target: "http://127.0.0.1:9999" }]),
    "a different port, or keys in a different order, is the same authority");

  const changes = {
    secret: [{ ...base[0], secret: "rotated" }],
    token: [{ ...base[0], token: "other" }],
    eligibilityLabel: [{ ...base[0], eligibilityLabel: "agent" }],
    allowedSenders: [{ ...base[0], allowedSenders: ["someone-else"] }],
    "repo added": [...base, { repo: "o/b", secret: "s2" }],
    "repo removed": [],
  };
  for (const [what, mutated] of Object.entries(changes)) {
    assert.notEqual(policyFingerprint(mutated), policyFingerprint(base), `${what} must change the policy fingerprint`);
  }
});

test("a target-only change is adopted in place and dispatch follows the new port", async () => {
  // The mock instance is the only thing listening; the route starts pointed at a dead port, which is
  // exactly what "the factory has not reported ready yet" looks like from the adapter's side.
  const hits = [];
  const instance = await new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
  const realTarget = `http://127.0.0.1:${instance.address().port}`;

  try {
    const liveRoutes = [{ repo: "o/a", secret: "s1", target: "http://127.0.0.1:1" }];
    const file = freshFile("target-only.json", liveRoutes);
    const startup = routesFileHash(file);
    const terminated = [];
    const check = makeRoutesDriftCheck({ routesFile: file, startupHash: startup, terminate: () => terminated.push(1), liveRoutes });

    // Supervisor fills in the target when the factory reports ready.
    writeRoutesFile(file, [{ repo: "o/a", secret: "s1", target: realTarget }]);
    assert.doesNotThrow(check, "a target-only refresh is runtime state, not a policy change");
    assert.equal(terminated.length, 0, "no termination for a benign refresh");
    assert.equal(liveRoutes[0].target, realTarget, "the live route follows the new port instead of routing to a dead one");

    // And dispatch really uses it: makeRouteDispatch captured the same array at startup.
    const dispatch = makeRouteDispatch(liveRoutes);
    // A genuinely eligible event: since #67 the dispatcher re-applies intake's own classifier rather
    // than trusting that the caller already checked, so a bare {action:"labeled"} is refused.
    const result = await dispatch("o/a", { issue: { number: 3 }, action: "labeled", label: { name: "agent" } });
    assert.deepEqual(result, { ok: true });
    assert.equal(hits.length, 1, "the task reached the instance that is actually listening");
    assert.match(hits[0].body, /"requestId":"issue-3"/);

    // A second identical write changes nothing and must stay quiet-and-passing.
    assert.doesNotThrow(check);
  } finally {
    instance.close();
  }
});

test("every authority field is still fatal drift even when liveRoutes are supplied", () => {
  const mutations = {
    secret: (r) => (r[0].secret = "rotated"),
    token: (r) => (r[0].token = "swapped"),
    eligibilityLabel: (r) => (r[0].eligibilityLabel = "agent"),
    allowedSenders: (r) => (r[0].allowedSenders = ["attacker"]),
    "repo added": (r) => r.push({ repo: "o/extra", secret: "s9" }),
    "repo removed": (r) => r.pop(),
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const liveRoutes = [{ repo: "o/a", secret: "s1", token: "t1", eligibilityLabel: "build", allowedSenders: ["me"] }];
    const file = freshFile(`mut-${what.replace(/[^a-z]/gi, "")}.json`, liveRoutes);
    const startup = routesFileHash(file);
    mutate(liveRoutes); // change policy on disk, keeping target identical in some cases
    writeFileSync(file, JSON.stringify(liveRoutes, null, 2));
    const terminated = [];
    const check = makeRoutesDriftCheck({ routesFile: file, startupHash: startup, terminate: () => terminated.push(1), liveRoutes: [{ repo: "o/a", secret: "s1", token: "t1", eligibilityLabel: "build", allowedSenders: ["me"] }] });
    assert.throws(check, RoutesDriftedError, `${what} must refuse to keep serving`);
    assert.equal(terminated.length, 1, `${what} must schedule termination`);
  }
});

test("a change that mixes target and policy is drift — classification is not first-match-wins", () => {
  const liveRoutes = [{ repo: "o/a", secret: "s1", target: "http://127.0.0.1:1" }];
  const file = freshFile("mixed.json", liveRoutes);
  const startup = routesFileHash(file);
  writeRoutesFile(file, [{ repo: "o/a", secret: "rotated", target: "http://127.0.0.1:2" }]);
  const terminated = [];
  const check = makeRoutesDriftCheck({ routesFile: file, startupHash: startup, terminate: () => terminated.push(1), liveRoutes });
  assert.throws(check, RoutesDriftedError);
  assert.equal(terminated.length, 1);
});

test("an unparsable routes file is never mistaken for a benign refresh", () => {
  const liveRoutes = [{ repo: "o/a", secret: "s1", target: "http://127.0.0.1:1" }];
  const file = freshFile("broken.json", liveRoutes);
  const startup = routesFileHash(file);
  writeFileSync(file, "{ this is not json");
  const terminated = [];
  const check = makeRoutesDriftCheck({ routesFile: file, startupHash: startup, terminate: () => terminated.push(1), liveRoutes });
  assert.throws(check, RoutesDriftedError);
  assert.equal(terminated.length, 1);
});

test("a target removed from the file clears it, so dispatch refuses rather than posting to a dead port", async () => {
  const liveRoutes = [{ repo: "o/a", secret: "s1", target: "http://127.0.0.1:4321" }];
  const file = freshFile("cleared.json", liveRoutes);
  const startup = routesFileHash(file);
  writeRoutesFile(file, [{ repo: "o/a", secret: "s1" }]); // factory exited; supervisor drops the target
  const terminated = [];
  const check = makeRoutesDriftCheck({ routesFile: file, startupHash: startup, terminate: () => terminated.push(1), liveRoutes });
  assert.doesNotThrow(check);
  assert.equal(terminated.length, 0);
  assert.equal(liveRoutes[0].target, undefined, "the adapter must stop believing in a route that no longer exists");
  await assert.rejects(() => makeRouteDispatch(liveRoutes)("o/a", { issue: { number: 1 } }), /no \/tasks target|no .*target/);
});

test("cold start end to end: serve, fill in the target, keep serving — no restart (#81)", async () => {
  const instance = await new Promise((resolve) => {
    const srv = createServer((_req, res) => { res.writeHead(202); res.end("{}"); }).listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    // 1. Supervisor writes policy with no target; adapter starts against it.
    const liveRoutes = [{ repo: "o/a", secret: "s1", eligibilityLabel: "agent" }];
    const file = freshFile("cold.json", liveRoutes);
    const startup = routesFileHash(file);
    const terminated = [];
    const { server, port } = await startIntakeServer({
      port: 0,
      host: "127.0.0.1",
      routes: liveRoutes,
      dispatch: makeRouteDispatch(liveRoutes),
      routesDriftCheck: makeRoutesDriftCheck({ routesFile: file, startupHash: startup, terminate: () => terminated.push(1), liveRoutes }),
    });
    const send = async (n) => {
      const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "o/a" }, issue: { number: n, title: "t", body: "b", labels: [{ name: "agent" }] } }));
      return fetch(`http://127.0.0.1:${port}/webhook/github`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": `sha256=${createHmac("sha256", "s1").update(body).digest("hex")}` },
        body,
      });
    };

    // 2. Before any factory is ready the request cannot be delivered — but that is a routing failure,
    //    not drift, and it must not be reported as one.
    const early = await send(11);
    assert.notEqual(early.status, 503, "no target is not a policy violation");

    // 3. The factory becomes ready; the supervisor rewrites the file with its port.
    writeRoutesFile(file, [{ repo: "o/a", secret: "s1", eligibilityLabel: "agent", target: `http://127.0.0.1:${instance.address().port}` }]);

    // 4. The next request is served. Before #81 this is where the adapter exited instead.
    const after = await send(12);
    assert.equal(after.status, 202, "a post-ready target fill must not cost an adapter restart");
    assert.equal(terminated.length, 0, "the drift guard stays asleep for runtime state");
    server.close();
  } finally {
    instance.close();
  }
});
