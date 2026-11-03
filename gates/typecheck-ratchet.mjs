#!/usr/bin/env node
/**
 * Typecheck ratchet — the compiler runs on every push and can only get quieter (#173).
 *
 * Why a ratchet instead of "typecheck in CI, green or fail": turning on `strict` over this codebase found 81 real
 * errors on the first run — including two live defects (the reviewer's `run_tests` tool calling `exec()` with two
 * of three arguments, and a tool refusal that reached the model as `[object Object]`). Blocking CI on all of them
 * would have meant no typecheck at all, which is how the errors happened in the first place. So:
 *
 *   - `npm run typecheck`         full strict compile, for humans (and CI once it reaches zero)
 *   - `npm run typecheck:ratchet` same compile, compared against a committed baseline; RED on any increase
 *
 * The baseline is per-file as well as total, so errors cannot be laundered by moving them to another file. When
 * you fix some, run `node gates/typecheck-ratchet.mjs --update` and commit the smaller number — that diff IS the
 * progress report.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "gates", "typecheck-baseline.json");
const UPDATE = process.argv.includes("--update");

function runTsc() {
  const tscBin = path.join(ROOT, "node_modules", ".bin", "tsc");
  if (!existsSync(tscBin)) {
    console.error("gates/typecheck-ratchet: cannot find node_modules/.bin/tsc — run `npm ci` first.");
    process.exit(2);
  }
  const proc = spawnSync(tscBin, ["-p", path.join(ROOT, "tsconfig.json"), "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (proc.error) {
    console.error(`gates/typecheck-ratchet: tsc could not run (${proc.error.message})`);
    process.exit(2);
  }
  return `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
}

/** Count `file(line,col): error TSxxxx: ...` lines and group them by file. */
export function tally(output) {
  const byFile = {};
  let total = 0;
  for (const line of output.split("\n")) {
    const m = /^([^(]+)\((\d+),\d+\): error TS\d+:/.exec(line);
    if (!m) continue;
    const file = m[1].replace(/^\.\//, "");
    total += 1;
    byFile[file] = (byFile[file] ?? 0) + 1;
  }
  return { errors: total, byFile };
}

const output = runTsc();
const current = tally(output);

if (UPDATE) {
  const sorted = Object.fromEntries(Object.entries(current.byFile).sort((a, b) => b[1] - a[1]));
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ errors: current.errors, byFile: sorted }, null, 2)}\n`);
  console.log(`typecheck baseline set to ${current.errors} errors across ${Object.keys(current.byFile).length} file(s)`);
  process.exit(0);
}

if (!existsSync(BASELINE_FILE)) {
  console.error(`gates/typecheck-ratchet: no baseline at ${path.relative(ROOT, BASELINE_FILE)}. Run with --update once.`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));

const regressions = [];
for (const [file, count] of Object.entries(current.byFile)) {
  const allowed = baseline.byFile[file] ?? 0; // a file with no recorded errors must have none
  if (count > allowed) regressions.push(`  ${file}: ${allowed} → ${count} (+${count - allowed})`);
}

if (regressions.length || current.errors > baseline.errors) {
  console.error(`typecheck REGRESSION: ${current.errors} errors now, baseline is ${baseline.errors}`);
  for (const line of regressions) console.error(line);
  console.error("\nnew errors:");
  for (const line of output.split("\n")) {
    if (/error TS\d+:/.test(line)) console.error(`  ${line.trim()}`);
  }
  console.error("\nThe compiler is not optional. Fix them, or — if you are certain a check is wrong — say so in the PR.");
  process.exit(1);
}

const improved = baseline.errors - current.errors;
console.log(`typecheck ratchet OK: ${current.errors} error(s), baseline ${baseline.errors}${improved > 0 ? ` (${improved} fewer — run with --update to bank the improvement)` : ""}`);
