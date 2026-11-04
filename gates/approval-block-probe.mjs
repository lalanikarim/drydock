#!/usr/bin/env node
// #188 probe — run the shipped approval-block detection against REAL instance stores and report what it finds.
//
// Why this exists and not just unit tests: `test/approval-block.test.mjs` pins the parser to entry shapes I captured
// by hand. A hand-written fixture proves my assumption about the kernel, not the kernel. This probe reads live stores
// through the same public read a task uses (`Conversation.context()` → `{entries, messages}`) and runs them through the
// exact functions `factory/reviewer.ts` and `factory/worker.ts` call, then prints what each blocked conversation WOULD
// have been told versus what its store actually recorded. That difference is the defect being fixed, measured on data
// nobody authored for the test.
//
//   node --experimental-strip-types gates/approval-block-probe.mjs                 # every fleet instance store
//   node --experimental-strip-types gates/approval-block-probe.mjs --store <path>  # one agent.sqlite (read-only copy)
//
// Exit codes: 0 = detection agrees with the data (every blocked diagnostic explained); 1 = findings reported but the
// run is healthy; 2 = drift — a blocked diagnostic whose marker could not be parsed, meaning #188 detection has
// silently degraded and the blaming message is back in production.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Harness, createRegistry } = await import("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { blocksFromContextView, blockedOutcomeFor, anyBlockedOutcome, countUnparsedBlocks } = await import("../factory/approval-state.ts");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

function discoverStores() {
  const one = flag("--store");
  if (one) return existsSync(one) ? [one] : [];
  // Same discovery rule the settlement ledger and backup drill use. Copied to a temp file first: reading a live store
  // through Harness.open would take a write lock, and two harnesses over one store is a known way to corrupt state.
  return globSync(join(process.cwd(), "factory-instances", "*", "engram-data", "agent.sqlite"));
}

function conversationsWithBlocks(dbPath) {
  // Raw sqlite first (cheap, read-only), then the API path for the actual detection. Selecting by conversation id only;
  // ids are integers here, not the 19-digit delivery ids that broke #107.
  const out = execFileSync("sqlite3", [`file:${dbPath}?mode=ro`,
    "select distinct conversation_id from entries where record like '%Approval request%' or record like '%\"code\":\"blocked\"%' order by conversation_id;"],
    { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
}

const stores = discoverStores();
if (stores.length === 0) {
  console.error("no instance stores found (pass --store <agent.sqlite>, or run from the repo root with fleet data present)");
  process.exit(2);
}

let totalBlocked = 0;
let explained = 0;
let drifted = 0;
const tmp = mkdtempSync(join(tmpdir(), "188-probe-"));

for (const dbPath of stores) {
  const storeName = dbPath.split("factory-instances/")[1]?.split("/")[0] ?? dbPath;
  const copy = join(tmp, `${storeName}.sqlite`);
  let harness;
  try {
    copyFileSync(dbPath, copy);
    const wanted = conversationsWithBlocks(dbPath);
    harness = await Harness.open(await openNodeSqliteStorage(copy), { registry: createRegistry() }, BACKGROUND_CONTEXT);
    console.log(`\n=== ${storeName}: ${wanted.length} conversation(s) carry approval blocks ===`);
    for (const convId of wanted) {
      const conv = await harness.conversation(convId, BACKGROUND_CONTEXT);
      if (!conv) { console.log(`  conv ${convId}: NOT RESOLVABLE via API`); drifted++; continue; }
      const view = await conv.context(BACKGROUND_CONTEXT);
      // The exact production calls.
      const blocks = blocksFromContextView(view);
      const unparsed = countUnparsedBlocks(view);
      totalBlocked++;
      // What the reviewer/worker would now record, for their respective critical tools.
      const reviewOutcome = blockedOutcomeFor(blocks, "submit_verdict", "review");
      const workerOutcome = anyBlockedOutcome(blocks, "worker");
      const label = reviewOutcome ? "review→blocked (names key)" : workerOutcome ? "worker→blocked (names key)" : "NO BLOCK PARSED";
      console.log(`  conv ${convId}: ${label}`);
      if (reviewOutcome || workerOutcome) {
        explained++;
        const chosen = reviewOutcome ?? workerOutcome;
        console.log(`     would report: ${chosen.error.message.slice(0, 150)}`);
        // Which kernel calls in THIS conversation were refused — a direct query on rows that carry the conversation id,
        // not a join across the ownership chain. (Attempted the latter first: `factory.reviewer` task 268 has
        // conversation_id 32, the orchestrator's, while its reviewer runs in 269, and the only link is `$.owner`, which
        // points at an intermediate run task. A diagnostic built on guessing that link would print "(none)" forever —
        // the #147 shape, a probe that always finds nothing and therefore always looks fine.)
        const refused = execFileSync("sqlite3", [`file:${dbPath}?mode=ro`,
          `select json_extract(record,'$.input.callId') from tasks where conversation_id=${convId} and kind='"pi.tool"' limit 5;`],
          { encoding: "utf8" }).split("\n").filter((s) => s.trim()).length;
        if (refused > 0) console.log(`     kernel tool-task rows in this conversation: ${refused}`);
      }
      if (unparsed > 0) {
        drifted++;
        console.log(`     ⚠ DRIFT: ${unparsed} blocked diagnostic(s) with no parseable marker — detection degraded, not absent`);
      }
    }
  } catch (e) {
    console.error(`  ${storeName}: probe failed — ${e.message}`);
    drifted++;
  } finally {
    if (harness) { try { await harness.close(BACKGROUND_CONTEXT); } catch { /* read-only copy, nothing to settle */ } }
  }
}
rmSync(tmp, { recursive: true, force: true });

// How many historical runs carry the messages #188 says blame the agent. This is a truthful fleet-wide count rather
// than a per-conversation attribution: the runtime does that join naturally (a stage scans its own conversation at
// settle time), and an offline re-creation of it would need the ownership link we just declined to guess at.
console.log("\n--- historical messages #188 replaces (fleet-wide) ---");
for (const dbPath of stores) {
  const storeName = dbPath.split("factory-instances/")[1]?.split("/")[0] ?? dbPath;
  for (const [phrase, label] of [["reviewer never called submit_verdict", "review misattribution"], ["worker produced no final answer", "worker misattribution"]]) {
    const n = Number(execFileSync("sqlite3", [`file:${dbPath}?mode=ro`,
      `select count(*) from tasks where kind='"factory.reviewer"' or kind='"factory.worker"';`], { encoding: "utf8" }).trim() || 0);
    const hits = execFileSync("sqlite3", [`file:${dbPath}?mode=ro`,
      `select count(*) from tasks where (kind='"factory.reviewer"' or kind='"factory.worker"') and record like '%${phrase}%';`], { encoding: "utf8" }).trim();
    if (Number(hits) > 0) console.log(`  ${storeName}: ${hits} of ${n} stage task(s) recorded "${phrase}" — candidates for ${label}`);
  }
}

console.log(`\n${totalBlocked} blocked conversation(s): ${explained} explained by detection, ${drifted} drifted/failed`);
if (drifted > 0) {
  console.error("DRIFT — the marker format or the read surface changed; #188 detection is silently degraded and runs will be blamed on agents again.");
  process.exit(2);
}
if (explained === 0) {
  console.error("Nothing explained: either no blocks exist in these stores (expected on a fresh fleet) or detection is broken. Distinguish by seeding one deliberately before trusting this run.");
  process.exit(1);
}
console.log("OK — every blocked conversation in real stores is explained by the shipped detection path.");
