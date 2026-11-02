// #141 — the operator's abort lever, at the handler seam.
//
// The kernel contract these fakes mirror is read off `node_modules/@earendil-works/pi-durable/dist/types.d.ts`
// and `harness/types.d.ts`, not invented: `TaskState.status` is one of
// pending | running | waiting | completing | terminal, and `Harness.abortTask()` returns "marked" when it
// committed an abort mark and "terminal" when the task was already terminal. Where reality is hostile, the
// fake is hostile the same way: a task that never settles must be reported as *not settled*, because a
// route that says "aborted" about a run that is still burning inference is precisely the green-that-means-
// nothing this repo keeps getting bitten by.
import assert from "node:assert/strict";
import test from "node:test";

const { createRunControlRoute, validateAbortRequest } = await import("../factory/run-control.ts");

/** Minimal IncomingMessage stand-in: readJsonBody consumes the body as an async iterable of chunks. */
const jsonReq = (body) => {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return { method: "POST", [Symbol.asyncIterator]: async function* () { yield buf; } };
};

/** A harness shaped like the real one on exactly the calls this route makes. */
function fakeHarness({ task, abortReturn = "marked", settleTo = "terminal", settleAfterMs = 0, conversation }) {
  const calls = [];
  const startedAt = Date.now();
  let conv = conversation ?? null;
  return {
    calls,
    async getTask(id) {
      calls.push(`getTask:${id}`);
      if (!task) return undefined;
      const status = settleAfterMs && Date.now() - startedAt >= settleAfterMs ? settleTo : task.state.status;
      return { state: { status } };
    },
    async abortTask(id) {
      calls.push(`abortTask:${id}`);
      if (task) task.state.status = settleAfterMs ? task.state.status : settleTo;
      return abortReturn;
    },
    async conversation(id) {
      calls.push(`conversation:${id}`);
      return conv
        ? { async abort() { calls.push("conv.abort"); conv.abortCalls += 1; } }
        : undefined;
    },
    async commit(fn) {
      calls.push("commit");
      await fn({
        async doc() {
          const state = { issues: {} };
          // Capture what the operator-abort note wrote so the test can assert the ledger was touched.
          return new Proxy(state, {
            get(target, prop) {
              if (prop === "issues") {
                return new Proxy(target.issues, {
                  set(t, key, value) {
                    t[key] = value;
                    return true;
                  },
                });
              }
              return target[prop];
            },
          });
        },
      });
    },
  };
}

async function call(route, body, harness) {
  let status = 0;
  let payload;
  const res = {};
  const rctx = {
    harness,
    ctx: {},
    json(_res, code, obj) {
      status = code;
      payload = obj;
    },
  };
  await route.handle(jsonReq(body), res, rctx);
  return { status, payload };
}


test("POST /factory/runs/abort aborts a live task and reports the terminal status it read back", async () => {
  const task = { state: { status: "running" } };
  const harness = fakeHarness({ task });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });

  const { status, payload } = await call(route, { taskId: 141, reason: "spinning" }, harness);

  assert.equal(status, 200);
  assert.equal(payload.aborted, true);
  assert.equal(payload.statusBefore, "running");
  assert.equal(payload.statusAfter, "terminal", "reported from the record read back, not from the request");
  assert.equal(payload.settled, true);
  assert.ok(harness.calls.includes("abortTask:141"));
});

test("an unknown task id is a 404 that says so — never a silent success", async () => {
  const harness = fakeHarness({ task: undefined });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });
  const { status, payload } = await call(route, { taskId: 999 }, harness);

  assert.equal(status, 404);
  assert.match(String(payload.error), /no task 999/);
  assert.ok(!harness.calls.some((c) => c.startsWith("abortTask")), "nothing may be aborted for an id that names nothing");
});

test("an already-terminal task reports aborted:false — it does not claim to have stopped something", async () => {
  const task = { state: { status: "terminal" } };
  const harness = fakeHarness({ task, abortReturn: "terminal" });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });

  const { status, payload } = await call(route, { taskId: 7 }, harness);
  assert.equal(status, 200);
  assert.equal(payload.aborted, false);
  assert.equal(payload.alreadyTerminal, true);
});

test("a task that never settles is reported as NOT settled (the honesty case)", async () => {
  // Reality: the abort mark is committed but the run invocation has not reached a terminal state yet. A
  // route that answered "aborted" here would be reporting a stop that has not happened.
  const task = { state: { status: "running" } };
  const harness = fakeHarness({ task, settleAfterMs: 10_000 });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });

  const started = Date.now();
  const { payload } = await call(route, { taskId: 8 }, harness);
  const waited = Date.now() - started;

  assert.equal(payload.aborted, true, "the mark WAS committed");
  assert.equal(payload.settled, false, "…but the run is not terminal, and that has to be said");
  assert.match(String(payload.note), /re-check/);
  assert.ok(waited >= 1000 && waited < 20_000, `bounded wait expected, saw ${waited}ms`);
});

test("a task still waiting on a child is NOT treated as settled", async () => {
  // "waiting" and "completing" are non-terminal in the kernel's TaskState union; treating them as done
  // would report a live run as stopped.
  const task = { state: { status: "waiting" } };
  const harness = fakeHarness({ task, settleAfterMs: 10_000 });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });
  const { payload } = await call(route, { taskId: 9 }, harness);
  assert.equal(payload.settled, false);
});

test("conversation abort goes through the conversation's own scope", async () => {
  const conv = { abortCalls: 0 };
  const harness = fakeHarness({ task: undefined, conversation: conv });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });

  const { status, payload } = await call(route, { conversationId: 3 }, harness);
  assert.equal(status, 200);
  assert.equal(payload.scope, "conversation");
  assert.equal(conv.abortCalls, 1);
});

test("an unknown conversation is a 404", async () => {
  const harness = fakeHarness({ task: undefined, conversation: null });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });
  const { status } = await call(route, { conversationId: 404 }, harness);
  assert.equal(status, 404);
});

test("malformed bodies are refused before the harness is touched at all", async () => {
  const harness = fakeHarness({ task: undefined });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });
  for (const body of [{}, { taskId: 1, conversationId: 2 }, { taskId: 0 }, { taskId: "nope" }]) {
    const { status } = await call(route, body, harness);
    assert.equal(status, 400, `${JSON.stringify(body)} must be refused`);
  }
  assert.deepEqual(harness.calls, []);
});

test("an operator abort is recorded against the issue but never charged to the budget cap", async () => {
  const task = { state: { status: "running" } };
  const harness = fakeHarness({ task });
  const route = createRunControlRoute({ repo: "probe/o", log: () => {} });
  await call(route, { taskId: 5, issueNumber: 141, reason: "by hand" }, harness);
  assert.ok(harness.calls.includes("commit"), "the intervention is written to the durable ledger");

  // And the ledger's own rule: an operator note never stops an issue.
  const { emptyBudgetLedger, isBudgetStopped, noteOperatorAbort } = await import("../factory/budget-ledger.ts");
  const state = emptyBudgetLedger();
  noteOperatorAbort(state, 141);
  noteOperatorAbort(state, 141);
  assert.equal(isBudgetStopped(state, 141), false);
});

test("validateAbortRequest accepts a numeric string id and rejects everything that cannot name a record", () => {
  assert.equal(validateAbortRequest({ taskId: "42" }).ok, true);
  assert.equal(validateAbortRequest({ taskId: "4.5" }).ok, false);
  assert.equal(validateAbortRequest({ conversationId: "-3" }).ok, false);
});
