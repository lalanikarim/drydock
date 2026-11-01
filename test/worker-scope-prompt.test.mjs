// The worker must be told its path scope (#100), not have it enforced only at push time.
//   node --experimental-strip-types --test test/worker-scope-prompt.test.mjs
//
// Why: issue #99 burned six full worker+review cycles on one file. The worker added a test, had to
// register it in package.json, and `open_draft_pr` refused the whole change — every time. The gate was
// right; the worker simply had no way to know the boundary existed, so "smallest change that satisfies
// the issue" pointed straight at the forbidden file.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workerPrompt } from "../factory/worker.ts";
import { UNRESTRICTED_SCOPE } from "../factory/path-scope.ts";

const base = { issueNumber: 99, issueText: "Document the implementation directories in README.md", lessons: "", testCommand: "npm test" };
const drydockScope = { allowlist: ["factory/", "fleet/", "test/", "README.md"], protectedPaths: ["gates/probes/"] };

test("a scoped repo names the allowed prefixes in the worker prompt", () => {
  const p = workerPrompt({ ...base, pathScope: drydockScope });
  for (const entry of drydockScope.allowlist) assert.ok(p.includes(entry), `allowlist entry ${entry} must be stated to the worker`);
  assert.match(p, /accepts changes ONLY under/, "must be phrased as a hard boundary, not a suggestion");
  assert.match(p, /refuses the WHOLE change/, "the cost of an out-of-scope edit must be stated, not implied");
});

test("protected paths are named separately from the allowlist", () => {
  const p = workerPrompt({ ...base, pathScope: drydockScope });
  assert.match(p, /Never change these.*gates\/probes\//, "protected paths need their own line — they override apparent scope");
  const withoutProtected = workerPrompt({ ...base, pathScope: { allowlist: ["test/"], protectedPaths: [] } });
  assert.ok(!/Never change these/.test(withoutProtected), "no protected-paths line when there is nothing protected");
});

test("declining for scope reasons is offered as a correct outcome", () => {
  const p = workerPrompt({ ...base, pathScope: drydockScope });
  assert.match(p, /stop and say exactly that in your final answer/);
  assert.match(p, /Declining for scope reasons is a correct outcome/);
});

test("an unrestricted repo is not told it is restricted", () => {
  for (const scope of [UNRESTRICTED_SCOPE, undefined]) {
    const p = workerPrompt({ ...base, pathScope: scope });
    assert.ok(!/accepts changes ONLY under/.test(p), "a repo with no allowlist must not claim one");
    assert.ok(!/Declining for scope reasons/.test(p));
  }
});

test("non-vacuity: the scope actually changes the prompt", () => {
  const scoped = workerPrompt({ ...base, pathScope: drydockScope });
  const open = workerPrompt({ ...base });
  assert.notEqual(scoped.length, open.length);
  assert.ok(scoped.length > open.length, "the scoped prompt must add text, not swap equivalents");
});

test("the scope is threaded to both the worker and the push gate (source pin)", () => {
  const src = readFileSync(new URL("../factory/pipeline.ts", import.meta.url), "utf8");
  const uses = (src.match(/pathScope: opts\.pathScope/g) ?? []).length;
  assert.ok(uses >= 2, `expected pathScope on both the worker and open_draft_pr wiring, found ${uses}`);
});
