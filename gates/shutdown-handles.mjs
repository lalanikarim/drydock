// #110 — what is actually still open when the supervisor shuts down?
//
// Background. `SIGTERM` to the supervisor used to be able to hang: the teardown deadline timer was
// `.unref()`'d, so if any handle kept the event loop alive the process sat there forever (observed: alive
// 13 seconds after shutdown, needing SIGKILL). #108 made the timer ref'd, which BOUNDS the problem at ~3s.
// Bounding is not understanding, and #110 asked the open question: *which handle was still open?*
//
// This answers it measurably, on real processes, without a model endpoint or a dispatch. Run it against an
// ISOLATED fleet (temp instancesRoot, temp routes file, spare port) — never production, because it TERM's
// whatever supervisor it is pointed at.
//
// Usage (see the recipe printed by --help):
//   node --experimental-strip-types gates/shutdown-handles.mjs \
//     --fleet /tmp/110-repro/fleet/fleet.repro.json --at 1,2,3
//
// What it measures per run: latency from SIGTERM to process exit, and `process.getActiveResourcesInfo()`
// at the signal and past the teardown deadline. The interesting distinction is between handle classes that
// are *expected* (PipeWrap/ProcessWrap = the children we are killing) and classes that would mean a leak
// (SocketWrap/TTYWrap/FSEventHandle/Timeout = something we opened and forgot).
//
// Result recorded on 2026-11-03 (macOS, node 22.23.1, two fixture factories, nothing dispatched):
//   at-signal: total=9 {"PipeWrap":6,"ProcessWrap":3}   → stdio pipes + child handles, exactly the children
//   exit latency: 18–23 ms at idle and during boot (TERM at 1s, 2s, 3s)
//   past-deadline sample: never emitted — nothing kept the loop alive
//   durable stores afterwards: 0 non-terminal task rows in both instances
// So the 13-second hang is not reproducible with children idle or booting, and no unexplained handle class
// is present. What IS observable is a short window where a child outlives the supervisor (it self-exits via
// its parent watchdog) — teardown ordering, not a leaked handle.
//
// The mechanism, found by running this probe twice with different stdio. Redirected to a FILE, the supervisor
// exits 18–23 ms after SIGTERM. With stdout as a PIPE held by a live parent, it took 3.2 s — exactly the
// ref'd deadline — and the surviving resources were 2 PipeWrap + 1 Timeout. That is the answer #110 was
// asking for: the handle that used to keep the loop alive is a **child's stdio pipe**, and the reason it can
// stay open is classic — the child blocks writing a log line into a pipe nobody is draining, so it never gets
// to its own SIGTERM handler. Pre-#108 (unref'd deadline) that combination hung forever; now the timer fires
// and the supervisor leaves at 3 s regardless. Classification lives in `classifyTeardown`: pipes + a Timeout =
// bounded by design; pipes with NO timer = the old hang condition; anything else = ours.
//
// Result recorded on 2026-11-04, AFTER #196 (same machine, isolated fleet, piped stdio):
//   at-signal: total=10 {"PipeWrap":7,"ProcessWrap":3} — children + their pipes, nothing else
//   exit latency: 152–221 ms at TERM points 1 s and 2 s (was the full 3.2 s deadline pre-#196)
//   past-deadline sample: never emitted
//   verdict: CLEAN at every TERM point
// #196's measurement found the supervisor had in fact been draining all along — the pump listeners live for
// the process lifetime, and children reached their SIGTERM handlers in ~200 ms. What was missing was an
// early-exit path: the coordinator paid the full deadline even after every child group had settled. It now
// exits on settlement and releases the read ends on every exit path, so a writer still blocked at the
// deadline gets EPIPE instead of hanging on a pipe whose reader is gone.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

/** The instrumentation injected into the supervisor via `--import`. */
export const INSTRUMENT_SOURCE = `
const t0 = Date.now();
const stamp = () => "+" + (Date.now() - t0) + "ms";
const snap = (label) => {
  const r = process.getActiveResourcesInfo();
  const counts = {};
  for (const kind of r) counts[kind] = (counts[kind] ?? 0) + 1;
  console.log("[handles " + label + " @" + stamp() + "] total=" + r.length + " " + JSON.stringify(counts));
};
process.on("exit", () => console.log("[handles exit @" + stamp() + "]"));
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    snap(sig + " received");
    const t = setInterval(() => { if (Date.now() - t0 >= 3200) { snap("PAST-3s-DEADLINE"); clearInterval(t); } }, 400);
    t.unref?.();
  });
}
snap("boot");
`;

export function parseArgs(argv) {
  const out = { fleet: "", at: [0], healthPort: 0, deadlineMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fleet") out.fleet = argv[++i] ?? "";
    else if (a === "--at") out.at = String(argv[++i] ?? "").split(",").map((n) => Number(n)).filter((n) => Number.isFinite(n));
    else if (a === "--health-port") out.healthPort = Number(argv[++i] ?? 0);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** Parse the probe's own log lines into structured samples. */
export function parseHandleLog(text) {
  const samples = [];
  for (const line of String(text).split("\n")) {
    const m = /\[handles (.+?) @\+(\d+)ms\] total=(\d+) (\{.*\}|\{\})/.exec(line);
    if (!m) continue;
    samples.push({ label: m[1], atMs: Number(m[2]), total: Number(m[3]), kinds: JSON.parse(m[4]) });
  }
  return samples;
}

/** Handle classes that would indicate a leak rather than ordinary child teardown. */
export function suspiciousKinds(kinds) {
  const expected = new Set(["PipeWrap", "ProcessWrap", "TCPWrap", "SignalWrap"]);
  return Object.keys(kinds ?? {}).filter((k) => !expected.has(k));
}

/**
 * Classify what survived the teardown deadline.
 *
 * `PipeWrap` + one `Timeout` surviving to the deadline is the design working, not failing: the Timeout IS the
 * ref'd shutdown deadline (#108) and the pipes are children whose stdout nobody drained — a child blocked
 * writing a log line cannot process SIGTERM promptly. That is bounded teardown with a slow child. A leak is a
 * class we opened and forgot (socket, fs watcher, TTY), or pipes plus NO timer, which is exactly the pre-#108
 * condition that hung 13 seconds. Distinguishing them is the entire point of the probe: everything else cries
 * wolf and gets ignored.
 */
export function classifyTeardown({ pastDeadline, childCount }) {
  if (!pastDeadline) return { level: "clean", why: "teardown finished inside the deadline" };
  const kinds = Object.keys(pastDeadline.kinds ?? {});
  const onlyPipesAndTimer = kinds.every((k) => k === "PipeWrap" || k === "Timeout");
  const pipesAtMostChildren = (pastDeadline.kinds?.PipeWrap ?? 0) <= Math.max(1, (childCount ?? 3) * 2 + 1);
  if (onlyPipesAndTimer && pastDeadline.kinds?.Timeout && pipesAtMostChildren) {
    return { level: "bounded", why: "deadline timer fired with child stdio pipes still open — a child was blocked writing its log; #108 bounds this, so the supervisor exits anyway" };
  }
  if (onlyPipesAndTimer && !pastDeadline.kinds?.Timeout) {
    return { level: "leak", why: "pipes open with NO deadline timer — the pre-#108 hang condition" };
  }
  return { level: "leak", why: `unexpected handle class still open: ${kinds.join(", ")}` };
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.fleet) {
    console.log(`#110 shutdown-handle probe

  node --experimental-strip-types gates/shutdown-handles.mjs --fleet <fleet.json> [--at 0,1,2] [--health-port N]

Runs the REAL supervisor under an --import instrumentation module, once per value in --at (seconds after
start to send SIGTERM; 0 = do not TERM, just report boot), and prints exit latency plus the handle snapshot.

SAFETY: this terminates the supervisor it starts. Point --fleet at an isolated deployment (temp
instancesRoot, temp routesFile, spare port). Never point it at production.`);
    return opts.help ? 0 : 2;
  }

  const instrumentPath = join(tmpdir(), `drydock-handle-instrument-${process.pid}.mjs`);
  await import("node:fs/promises").then((fs) => fs.writeFile(instrumentPath, INSTRUMENT_SOURCE));

  // Read the fleet file for its adapter port so "healthy" means what production means.
  const fleet = JSON.parse(readFileSync(opts.fleet, "utf8"));
  const port = opts.healthPort || fleet?.adapter?.port;
  if (!port) throw new Error("no adapter.port in the fleet file and no --health-port given");

  const results = [];
  for (const atSec of opts.at.length ? opts.at : [0]) {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(instrumentPath).href, "fleet/supervisor.ts", "run", resolve(opts.fleet)], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DRYDOCK_CONFIG_DIR: process.env.DRYDOCK_CONFIG_DIR ?? join(tmpdir(), "drydock-configs") },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));

    const healthy = await waitHealthy(port, 60_000);
    if (atSec > 0) await new Promise((r) => setTimeout(r, atSec * 1000));

    let exitLatencyMs = null;
    const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
    if (atSec > 0) {
      const t0 = Date.now();
      child.kill("SIGTERM");
      const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 20_000))]);
      exitLatencyMs = Date.now() - t0;
      if (!done) {
        console.log(`TERM at ${atSec}s: STILL ALIVE after 20s — this is the #110 hang. Killing.`);
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGTERM");
      await exited;
    }

    const samples = parseHandleLog(out);
    const atSignal = samples.find((s) => /SIGTERM received/.test(s.label));
    const pastDeadline = samples.find((s) => /PAST-3s-DEADLINE/.test(s.label));
    results.push({ atSec, healthy, exitLatencyMs, atSignal, pastDeadline, suspicious: suspiciousKinds(atSignal?.kinds ?? {}) });

    console.log(`\n=== TERM at ${atSec}s ===`);
    console.log(`  reached /health:      ${healthy}`);
    console.log(`  exit latency:         ${exitLatencyMs === null ? "n/a (boot-only run)" : `${exitLatencyMs} ms`}`);
    console.log(`  handles at signal:    ${atSignal ? `total=${atSignal.total} ${JSON.stringify(atSignal.kinds)}` : "not captured"}`);
    const verdict = classifyTeardown({ pastDeadline, childCount: atSignal?.kinds?.ProcessWrap });
    results.at(-1).verdict = verdict;
    console.log(`  past 3s deadline:     ${pastDeadline ? `total=${pastDeadline.total} ${JSON.stringify(pastDeadline.kinds)}` : "nothing — teardown finished inside the deadline"}`);
    console.log(`  non-child handle cls: ${results.at(-1).suspicious.length ? results.at(-1).suspicious.join(", ") : "none"}`);
    console.log(`  classification:       ${verdict.level} — ${verdict.why}`);
  }

  const anyLeak = results.some((r) => r.verdict?.level === "leak" || r.suspicious.length);
  const bounded = results.some((r) => r.verdict?.level === "bounded");
  console.log(`\nverdict: ${anyLeak ? "LEAK — a handle class we own is still open (see classification)" : bounded ? "BOUNDED — deadline timer did its job; children were slow to die, not leaked" : "CLEAN — nothing survived the deadline"}`);
  if (existsSync(instrumentPath)) await import("node:fs/promises").then((fs) => fs.unlink(instrumentPath));
  return anyLeak ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
}
