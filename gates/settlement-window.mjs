#!/usr/bin/env node
// Settlement window gate (#161): fail when work was accepted and produced nothing.
//
// Lifetime totals are monotone, and a monotone number is useless as an alert — the question an operator can act on
// is "did anything break *since last time*". So this keeps a watermark of the highest row id seen per store per
// table (ids come from one shared allocator, so they only ever increase) and alarms only on new rows.
//
// Exit codes:
//   0  window clean (or baseline established — see below)
//   2  alarming settlements in the window, OR nothing was collected, OR the watermark is corrupt
//
// "Nothing collected" exiting 0 is the defect this repo has been bitten by three times (R6b/R10): a sweep that
// examined zero stores and a sweep that found nothing wrong must not be the same color.
//
// First run establishes a baseline and exits 0 on purpose: without it, every historical failure from the last week
// alarms at once, and the operator's rational response to that is to delete the gate. Use --no-baseline to demand
// an alarm anyway.
//
//   node gates/settlement-window.mjs [--json] [--all-kinds] [--state-file f] [--reset-watermark]
//                                    [--no-advance] [--no-baseline]
import { rmSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ledger = await import(`${ROOT}/factory/settlement-ledger.ts`);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = has("--json");
const stateFile = val("--state-file") ?? `${ROOT}/fleet/data/last-settlements.json`;
// Same override the instances themselves honor (`factory/main.ts` reads FACTORY_INSTANCES_ROOT), so a test — or a
// fleet whose stores live off-repo — can point this gate somewhere real instead of trusting a fixture.
const instancesRoot = val("--instances-root") ?? process.env.FACTORY_INSTANCES_ROOT ?? ROOT;
const kinds = has("--all-kinds") ? null : ["factory."];

const out = (s) => { if (!asJson) console.log(s); };
function die(msg, extra) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, ...(extra ? { detail: extra } : {}) }, null, 2));
  else {
    console.error(`GATE FAILED: ${msg}`);
    if (extra) console.error(typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
  }
  process.exitCode = 2;
}

if (has("--reset-watermark")) {
  rmSync(stateFile, { force: true });
  out(`watermark removed (${stateFile}); the next run re-baselines`);
}

const stores = ledger.discoverStores(instancesRoot);
if (stores.length === 0) {
  die("no instance stores found — nothing was examined", [
    `looked under ${instancesRoot}/factory-instances/*/engram-data/agent.sqlite`,
    "This is not a pass. Either the fleet's instances have never run here, or FACTORY_INSTANCES_ROOT moved,",
    "or the store layout changed — in which case this gate is silently blind and must be fixed before it is trusted.",
  ]);
  process.exit(2);
}

let watermark;
try {
  watermark = ledger.readWatermark(stateFile);
} catch (e) {
  die(String(e?.message ?? e));
  process.exit(2);
}

const isBaseline = !watermark.updatedAt;

// Read everything, then look at only what the watermark has not seen. Reading all rows costs one query per store and
// keeps "what changed" independent of "what exists".
const all = [];
const readFailures = [];
for (const s of stores) {
  try {
    all.push(...ledger.readStore(s.store, s.dbPath, { kinds }));
  } catch (e) {
    // One unreadable store must not erase the others' verdict — but it must not be silent either.
    readFailures.push({ store: s.store, error: String(e?.message ?? e) });
  }
}

if (readFailures.length === stores.length) {
  die("every store failed to read — nothing was examined", readFailures);
  process.exit(2);
}

const fresh = ledger.unseen(all, watermark);
const summaryFresh = ledger.summarize(fresh, stores.length - readFailures.length);
const summaryAll = ledger.summarize(all, stores.length - readFailures.length);

const alarming = summaryFresh.alarms;

if (!isBaseline && alarming.length > 0) {
  die(
    `${alarming.length} settlement(s) in this window produced no work`,
    {
      instructions: [
        "failing = a task failed or faulted; unanswered = a submission no model answered (the #133 shape).",
        "modelUnavailable = the endpoint never served the pinned model, or errored mid-generation (kernel reasons",
        "no_model / model_error). It alarms because accepted work was lost, but it is NOT an agent defect: fix the pin",
        "or load the model. If a whole repo shows only these, its models.modelId names something not served — check",
        "GET /health/inference (token-gated) before reading any worker log.",
        "aborted and restarted are reported separately and never alarm — an operator using POST /factory/runs/abort",
        "(#141) is information, not an incident. inFlight (a task still running) and unsettled (a queued/placed",
        "submission) never alarm either, and the watermark does not advance past them, so a run that fails after",
        "this pass still shows up in the next one (#186). If inFlight is large and permanent, look at the fleet,",
        "not at this gate.",
        "waiting (a terminal run a gate stopped for a human approval, #188) never alarms either, and its detail names",
        "the key: GET /approvals to see it, POST /approvals/<key> {\"decision\":\"approved\"} to clear it. A large",
        "waiting count means the fleet is idle on you, not broken.",
        "Look at one:  sqlite3 \"file:factory-instances/<store>/engram-data/agent.sqlite?mode=ro\" \\",
        "               \"select json_extract(record,'$.state') from tasks where id=<id>;\"",
      ],
      alarms: alarming.slice(0, 25),
    },
  );
} else if (isBaseline && alarming.length > 0 && has("--no-baseline")) {
  die(`${alarming.length} historical settlement(s) would alarm (baseline suppressed by --no-baseline)`, {
    alarms: alarming.slice(0, 25),
  });
} else {
  process.exitCode = 0;
}

if (!has("--no-advance") && process.exitCode !== 2) {
  // Advance only when we are not reporting a failure: rows that alarmed must alarm again until someone looks.
  ledger.writeWatermark(stateFile, ledger.advance(watermark, all));
} else if (process.exitCode === 2) {
  out("(watermark left where it was — an unexamined failure alarms again next run)");
}

const payload = {
  ok: process.exitCode !== 2,
  baseline: isBaseline,
  stateFile,
  storesScanned: stores.length - readFailures.length,
  storesFailed: readFailures,
  kindsScoped: kinds ? kinds.join(",") : "ALL",
  window: { rowsNew: fresh.length },
  countsWindow: summaryFresh.counts,
  countsLifetime: summaryAll.counts,
  byFamilyWindow: summaryFresh.byFamily,
  alarming: alarming.map((a) => ({ store: a.store, table: a.table, id: a.id, kind: a.kind, status: a.status, detail: a.detail })),
  // Samples come from the window when there is one. Printing lifetime samples next to "window clean" reads like
  // four live problems in a run that found none — which is how alert output gets ignored.
  samples: (isBaseline ? summaryAll : summaryFresh).samples.map((s) => ({
    store: s.store, table: s.table, id: s.id, kind: s.kind, status: s.status, cls: s.cls,
  })),
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  out(`stores: ${payload.storesScanned}/${stores.length} read-only${readFailures.length ? ` (${readFailures.length} FAILED)` : ""}  kinds: ${payload.kindsScoped}`);
  for (const f of readFailures) out(`  ! unreadable store ${f.store}: ${f.error}`);
  if (isBaseline) {
    out("BASELINE RUN — every row is new; counts below are lifetime");
    console.log(ledger.formatSummary(summaryAll));
  } else {
    // Only the window gets the alarm-formatted treatment. Lifetime numbers stay on one line, as context.
    out(`window: ${fresh.length} new row(s) since last run`);
    console.log(ledger.formatSummary(summaryFresh));
    const a = summaryAll.counts;
    out(`lifetime (context only): completed=${a.completed} failing=${a.failing} unanswered=${a.unanswered} aborted=${a.aborted} restarted=${a.restarted} unsettled=${a.unsettled} inFlight=${a.inFlight}`);
  }
  if (process.exitCode !== 2) {
    out("");
    out(isBaseline
      ? "baseline established — future runs alarm only on rows newer than this one"
      : "window clean");
    out("note: aborted/restarted are reported, never alarmed; failing/unanswered alarm (#161).");
  }
}
