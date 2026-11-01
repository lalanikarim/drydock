// Failed-delivery sweep tests (#107 layer 2).
//   node --experimental-strip-types --test test/redeliver-failed.test.mjs
//
// The tool exists because GitHub does not automatically redeliver failed webhook deliveries, so the only
// recovery path is a sweep over the hook log. These tests run against fakes and assert the two properties
// that matter operationally: a dry run never POSTs, and a policy refusal (which GitHub records as OK)
// can never be swept — otherwise re-driving refusals would replay comments and labels we rejected on
// purpose.

import test from "node:test";
import assert from "node:assert/strict";
import { main, parseLink, redeliver, resolveToken, safeParse, selectFailedDeliveries, summarize, listDeliveries } from "../fleet/redeliver-failed.mjs";

const ok = (id, over = {}) => ({ id, status: "OK", response_code: 200, event: "issues", delivered_at: "2026-11-01T02:00:00Z", ...over });
const fail = (id, status, over = {}) => ({ id, status, response_code: null, event: "issues", delivered_at: "2026-11-01T02:03:01Z", ...over });

test("only non-OK deliveries are selected, oldest first, honouring --since and --skip", () => {
  const rows = [
    ok(5),
    fail(3, "Invalid HTTP Response: 503"),
    fail(4, "timeout", { delivered_at: "2026-10-31T23:00:00Z" }),
    ok(6, { status: "ok" }), // case-insensitive match on the success marker
  ];
  const sel = selectFailedDeliveries(rows);
  assert.deepEqual(sel.map((d) => d.id), [4, 3], "both failures, oldest first");

  const bounded = selectFailedDeliveries(rows, { since: "2026-11-01T00:00:00Z" });
  assert.deepEqual(bounded.map((d) => d.id), [3]);

  assert.deepEqual(selectFailedDeliveries(rows, { skip: [3] }).map((d) => d.id), [4]);
  assert.deepEqual(selectFailedDeliveries([]), []);
  assert.throws(() => selectFailedDeliveries(rows, { since: "not-a-date" }), /not a valid timestamp/);
});

test("summarize groups by failure reason with the events involved", () => {
  // summarize receives what selectFailedDeliveries returned — successes are already gone upstream.
  const selected = selectFailedDeliveries([fail(1, "Invalid HTTP Response: 503"), fail(2, "Invalid HTTP Response: 503", { event: "issue_comment" }), ok(3)]);
  assert.equal(selected.length, 2, "the success row is filtered before grouping");
  const s = summarize(selected);
  assert.equal(s.length, 1);
  assert.equal(s[0].count, 2);
  assert.deepEqual(s[0].events.sort(), ["issue_comment", "issues"]);
});

function fakeFetch(script) {
  const calls = [];
  const impl = async (path, { token, method = "GET" } = {}) => {
    calls.push({ path, method, token });
    const hit = script[path];
    if (hit === undefined) return { ok: false, status: 404, body: { message: `unexpected ${method} ${path}` } };
    // A scripted entry may be a bare body (wrapped as 200 OK) or a full response shape (passed through),
    // so tests can script Link headers and non-2xx statuses.
    if (typeof hit === "function") return hit();
    if (hit && typeof hit === "object" && "status" in hit) return hit;
    return { ok: true, status: 200, body: hit };
  };
  return { impl, calls };
}

test("a dry run reports and POSTs nothing", async () => {
  const { impl, calls } = fakeFetch({
    "/repos/o/r/hooks/9/deliveries?per_page=100": [ok(1), fail(2, "Invalid HTTP Response: 503"), fail(3, "timeout")],
  });
  const out = [];
  const res = await main({ argv: ["--repo", "o/r", "--hook", "9"], env: { GITHUB_TOKEN: "t" }, fetchImpl: impl, log: (l) => out.push(l) });

  assert.equal(res.code, 1, "a dry run with failures exits nonzero so a scheduled run surfaces");
  assert.equal(res.failed.length, 2);
  assert.equal(res.applied.length, 0);
  assert.ok(calls.every((c) => c.method === "GET"), "dry run must not POST anything");
  assert.match(out.join("\n"), /DRY RUN/);
  assert.match(out.join("\n"), /policy refusal is NOT listed/);
});

test("--apply re-POSTs each failed delivery and reports per-item status", async () => {
  const posted = [];
  const { impl, calls } = fakeFetch({
    "/repos/o/r/hooks/9/deliveries?per_page=100": [ok(1), fail(7, "timeout"), fail(8, "server_error")],
    "/repos/o/r/hooks/9/deliveries/7/attempts": () => { posted.push(7); return { ok: false, status: 202, body: {} }; },
    "/repos/o/r/hooks/9/deliveries/8/attempts": () => { posted.push(8); return { ok: false, status: 422, body: { message: "no" } }; },
  });
  const out = [];
  const res = await main({ argv: ["--repo", "o/r", "--hook", "9", "--apply"], env: { GITHUB_TOKEN: "t" }, fetchImpl: impl, log: (l) => out.push(l) });

  assert.deepEqual(posted, [7, 8], "only the failures are re-driven, oldest first");
  assert.equal(res.applied.filter((a) => a.ok).length, 1, "202 counts as queued");
  assert.equal(res.code, 1, "one item failed, so the run is not green");
  assert.match(out.join("\n"), /redeliver 7 \(issues\) -> HTTP 202 queued/);
  assert.match(out.join("\n"), /accepted != delivered/, "must not claim delivery");
  assert.ok(calls.some((c) => c.method === "POST" && c.path.includes("/attempts")));
});

test("non-vacuity: a policy refusal (GitHub status OK) is never swept", async () => {
  // The shape our own refusals produce: intake answered 200/403, so GitHub logged them as delivered.
  const refused = [ok(11, { response_code: 403 }), ok(12, { response_code: 200 })];
  const { impl, calls } = fakeFetch({ "/repos/o/r/hooks/9/deliveries?per_page=100": refused });
  const out = [];
  const res = await main({ argv: ["--repo", "o/r", "--hook", "9", "--apply"], env: { GITHUB_TOKEN: "t" }, fetchImpl: impl, log: (l) => out.push(l) });
  assert.equal(res.failed.length, 0);
  assert.equal(res.code, 0);
  assert.ok(!calls.some((c) => c.method === "POST"), "replaying a refusal would re-run something we rejected deliberately");
  assert.match(out.join("\n"), /0 not delivered/);
});

// The live API rejects `page` on this endpoint (422 "page" is not a permitted key) and paginates with
// Link cursors. A fake that accepted page=2 hid exactly that, so these assert cursor-following AND that
// no synthesized page parameter is ever sent.
test("listing follows Link cursors and never sends a page parameter", async () => {
  const nextUrl = "https://api.github.com/repositories/1/hooks/9/deliveries?per_page=100&cursor=abc";
  const full = Array.from({ length: 100 }, (_, i) => ok(1000 + i));
  const tail = [fail(2000, "timeout")];
  const { impl, calls } = fakeFetch({
    "/repos/o/r/hooks/9/deliveries?per_page=100": { ok: true, status: 200, body: full, headers: { get: (h) => (h === "link" ? `<${nextUrl}>; rel="next"` : null) } },
    [nextUrl]: { ok: true, status: 200, body: tail, headers: { get: () => null } },
  });
  const rows = await listDeliveries({ repo: "o/r", hookId: 9, token: "t", fetchImpl: impl });
  assert.equal(rows.length, 101);
  assert.ok(!calls.some((c) => /[?&]page=/.test(c.path)), "this endpoint answers 422 to page=");
});

// The bug this pins: delivery ids are 19 digits. JSON.parse rounds them, so --only never matched a real
// id and a redelivery POST would have addressed a number that does not exist.
test("safeParse keeps 19-digit delivery ids exact", () => {
  const raw = '[{"id":3851475922366504960,"status":"timeout","event":"issues","repository":{"id":123}}]';
  const parsed = safeParse(raw);
  assert.equal(String(parsed[0].id), "3851475922366504960", "no rounding at the precision edge");
  // Non-vacuity: the naive parse really does move the value (…4960 → …5000), which is why this exists.
  assert.equal(String(JSON.parse(raw)[0].id), "3851475922366505000");
  assert.equal(parsed[0].repository.id, 123, "small ids stay numeric");

  const sel = selectFailedDeliveries(parsed);
  assert.deepEqual(sel.map((d) => d.id), ["3851475922366504960"]);
});

test("parseLink reads rel targets and tolerates an absent header", () => {
  const l = parseLink('<https://x/next?c=1>; rel="next", <https://x/first>; rel="first"');
  assert.equal(l.next, "https://x/next?c=1");
  assert.equal(l.first, "https://x/first");
  assert.deepEqual(parseLink(null), {});
});

test("--only re-drives named deliveries and says what it skipped", async () => {
  const posted = [];
  const { impl } = fakeFetch({
    "/repos/o/r/hooks/9/deliveries?per_page=100": [fail(7, "timeout"), fail(8, "timeout")],
    "/repos/o/r/hooks/9/deliveries/8/attempts": () => { posted.push(8); return { ok: false, status: 202, body: {} }; },
  });
  const out = [];
  const res = await main({ argv: ["--repo", "o/r", "--hook", "9", "--only", "8", "--apply"], env: { GITHUB_TOKEN: "t" }, fetchImpl: impl, log: (l) => out.push(l) });
  assert.deepEqual(posted, [8], "surgical recovery touches only what it names");
  assert.equal(res.code, 0);
  assert.match(out.join("\n"), /--only: keeping 1 of 2/);
});

test("listing surfaces an API failure rather than reporting a clean sweep", async () => {
  const { impl } = fakeFetch({}); // every path 404s
  await assert.rejects(() => listDeliveries({ repo: "o/r", hookId: 9, token: "t", fetchImpl: impl }), /listing deliveries failed/);
});

test("usage and token resolution fail loudly instead of sweeping nothing quietly", async () => {
  const out = [];
  assert.equal((await main({ argv: [], env: { GITHUB_TOKEN: "t" }, log: (l) => out.push(l) })).code, 2);
  assert.match(out.join("\n"), /usage:/);
  assert.equal(resolveToken({ GITHUB_TOKEN: " explicit " }), "explicit");
  assert.equal(resolveToken({ GH_TOKEN: "fallback" }), "fallback");
});

test("redeliver() reports the delivery id it acted on", async () => {
  const { impl } = fakeFetch({ "/repos/o/r/hooks/9/deliveries/42/attempts": () => ({ ok: false, status: 202, body: {} }) });
  const r = await redeliver({ repo: "o/r", hookId: 9, deliveryId: 42, token: "t", fetchImpl: impl });
  assert.deepEqual(r, { deliveryId: 42, ok: true, status: 202 });
});
