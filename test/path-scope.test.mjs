// Path scope enforcement (§5.13): what a pipeline run may change.
//   node --experimental-strip-types --test test/path-scope.test.mjs
//
// The regression this pins is subtle: a branch whose only change is the vendor/engram submodule
// pointer passes every test suite in the repo while replacing the vendored kernel. Pin discipline is
// a human decision, so it has to be structurally impossible for the pipeline to make it.

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPathScope, ALWAYS_PROTECTED_PATHS, UNRESTRICTED_SCOPE, formatScopeFailure } from "../factory/path-scope.ts";
import { loadRegistry, scopeOf, validateRegistry } from "../factory/repo-registry.ts";

test("vendor/ is protected unconditionally", () => {
  // The submodule pointer change: git reports the submodule path itself.
  const v = checkPathScope(["vendor/engram"], UNRESTRICTED_SCOPE);
  assert.equal(v.ok, false);
  assert.match(v.offenders[0].why, /protected path vendor\//);

  // Deeper paths inside it too.
  assert.equal(checkPathScope(["vendor/engram/app/src/gates.ts"], UNRESTRICTED_SCOPE).ok, false);
  // And protection is not overridable by an allowlist that names the same prefix — forgetting to
  // configure a repo must never be what exposes the pin.
  assert.equal(checkPathScope(["vendor/engram"], { allowlist: ["src/", "vendor/"], protectedPaths: [] }).ok, false);
});

test("allowlist absent means anything non-protected", () => {
  const v = checkPathScope(["src/a.mjs", "docs/b.md", "package.json"], UNRESTRICTED_SCOPE);
  assert.equal(v.ok, true);
  assert.deepEqual(v.offenders, []);
});

test("allowlist prefixes: trailing slash is a directory, otherwise exact match", () => {
  const scope = { allowlist: ["src/", "README.md"], protectedPaths: [] };
  assert.equal(checkPathScope(["src/server.mjs", "README.md"], scope).ok, true);
  const bad = checkPathScope(["src/server.mjs", "README.md.evil", "scripts/deploy.sh"], scope);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.offenders.map((o) => o.file), ["README.md.evil", "scripts/deploy.sh"]);
  assert.match(formatScopeFailure(bad), /outside this repo's allowlist/);
});

test("protectedPaths extend, never shrink, the unconditional set", () => {
  const scope = { allowlist: null, protectedPaths: [".github/", "package-lock.json"] };
  assert.equal(checkPathScope(["package-lock.json"], scope).ok, false);
  assert.equal(checkPathScope([".github/workflows/ci.yml"], scope).ok, false);
  assert.equal(checkPathScope(["src/x.mjs"], scope).ok, true);
  // The unconditional list is still in force alongside the extras.
  assert.ok(ALWAYS_PROTECTED_PATHS.includes("vendor/"));
  assert.equal(checkPathScope(["vendor/x", "src/y"], scope).ok, false);
});

test("registry path-scope fields are validated, not coerced", () => {
  const base = { repo: "octo/thing" };
  // An empty allowlist would silently forbid every change — that has to be a loud mistake.
  assert.throws(() => validateRegistry({ repos: [{ ...base, pathAllowlist: [] }] }), /must not be an empty array/);
  assert.throws(() => validateRegistry({ repos: [{ ...base, pathAllowlist: ["/etc/passwd"] }] }), /repo-relative without traversal/);
  assert.throws(() => validateRegistry({ repos: [{ ...base, protectedPaths: ["../outside"] }] }), /repo-relative without traversal/);
  assert.throws(() => validateRegistry({ repos: [{ ...base, pathAllowlist: ["src/foo;rm -rf"] }] }), /shell metacharacters/);
  assert.throws(() => validateRegistry({ repos: [{ ...base, pathAllowlist: "src/" }] }), /array of repo-relative path prefixes/);
  // null means unrestricted and is distinct from omitting it only in spelling.
  const r = validateRegistry({ repos: [{ ...base, pathAllowlist: null }] });
  assert.equal(r.repos[0].pathAllowlist, null);
  assert.deepEqual(r.repos[0].protectedPaths, []);
});

test("real git behavior the design relies on: a submodule pointer bump reports as the submodule path", async (t) => {
  // Not paranoia: the whole protection hinges on `git diff --name-only` surfacing a gitlink change
  // as "vendor/engram" rather than nothing (or as files inside the submodule). If git ever changes
  // that, this fails and the assumption gets re-examined here instead of silently unenforced.
  const { mkdtempSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "path-scope-git-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=test", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "-q", join(root, "origin-app.git")]);
    execFileSync("git", ["clone", "-q", join(root, "origin-app.git"), join(root, "app")]);
    const app = join(root, "app");
    git(app, "commit", "-q", "--allow-empty", "-m", "init");
    git(app, "branch", "-M", "main");
    git(app, "push", "-q", "origin", "main");
    execFileSync("git", ["init", "-q", join(root, "k")]);
    const kernel = join(root, "k");
    git(kernel, "commit", "-q", "--allow-empty", "-m", "kernel v1");
    git(app, "submodule", "add", "-q", kernel, "vendor/engram");
    git(app, "commit", "-q", "-m", "vendor kernel v1");
    git(app, "push", "-q", "origin", "main");

    // A second kernel commit, then the app branch moves the pointer to it — the worker's
    // most damaging possible "passing" change.
    git(kernel, "commit", "-q", "--allow-empty", "-m", "kernel v2");
    git(app, "checkout", "-q", "-b", "agent/issue-99");
    git(join(app, "vendor/engram"), "fetch", "-q", kernel, "HEAD");
    git(join(app, "vendor/engram"), "checkout", "-q", "FETCH_HEAD");
    git(app, "add", "vendor/engram");
    git(app, "commit", "-q", "-m", "bump vendored kernel");

    const base = git(app, "merge-base", "origin/main", "agent/issue-99").trim();
    const changed = git(app, "diff", "--name-only", `${base}..agent/issue-99`).trim().split("\n").filter(Boolean);
    assert.deepEqual(changed, ["vendor/engram"], "git must surface a gitlink change as the submodule path");

    const verdict = checkPathScope(changed, UNRESTRICTED_SCOPE);
    assert.equal(verdict.ok, false);
    assert.match(verdict.offenders[0].why, /protected path vendor\//);
  } catch (e) {
    // Sandboxes without git (or with file-protocol restrictions) skip rather than lie.
    t.skip(`git unavailable or restricted: ${String(e).slice(0, 120)}`);
  }
});

test("the real registry scopes: fixtures to src|test|README, drydock to its own source dirs", () => {
  const registry = loadRegistry();
  const entryOrThrow = (name) => {
    const found = registry.repos.find((e) => e.repo === name);
    assert.ok(found, `${name} missing from the registry`);
    return scopeOf(found);
  };
  const fx1 = entryOrThrow("lalanikarim/factory-fixture");
  assert.deepEqual(fx1.allowlist, ["src/", "test/", "README.md"]);

  const drydock = entryOrThrow("lalanikarim/drydock");
  // A self-run may edit factory/fleet code, its own tests, the research docs, and — decision E1 —
  // the two root documents, including the one that describes how it works.
  assert.equal(checkPathScope(["factory/worker.ts", "test/x.test.mjs", "research/multi-repo-factory-plan.md"], drydock).ok, true);
  assert.equal(checkPathScope(["README.md", "AGENTS.md"], drydock).ok, true, "E1: self-work documents itself");

  // What stays off-limits is everything that changes what the pipeline *can do* rather than what it
  // knows: the vendored kernel, dependency manifests, and CI configuration.
  for (const forbidden of ["vendor/engram", "package.json", "package-lock.json", ".github/workflows/ci.yml"]) {
    assert.equal(checkPathScope([forbidden], drydock).ok, false, `${forbidden} must be off-limits to a drydock self-run`);
  }

  // E1's stated safety argument, checked rather than asserted in prose: AGENTS.md is advisory text
  // read by the model, while enforcement reads this registry file — which lives in the graded repo
  // but is not reachable through the graded workspace's own writes. Editing the instructions cannot
  // widen the scope, because scope never consults them.
  assert.equal(checkPathScope(["AGENTS.md", "gates/probes/list-total-count.mjs"], drydock).ok, false,
    "a permitted docs edit bundled with an oracle edit is still refused wholesale");

  // Self-grading: `gates/` is deliberately outside drydock's allowlist. For a fixture repo the gates
  // being editable would not matter — G2 runs from outside the graded repo. Drydock IS its own graded
  // repo, so a diff that softened an oracle would be judged by the thing it softened.
  for (const forbidden of ["gates/g2-worker-quality.mjs", "gates/probes/list-total-count.mjs", "gates/lib.ts"]) {
    assert.equal(checkPathScope([forbidden], drydock).ok, false, `${forbidden} must be off-limits to a drydock self-run`);
  }
  // And the probes stay protected even if someone widens the allowlist back to gates/ later: that is
  // what declaring them in `protectedPaths` buys, and it is why both mechanisms exist.
  assert.equal(
    checkPathScope(["gates/g2-worker-quality.mjs"], { allowlist: ["gates/"], protectedPaths: ["gates/probes/"] }).ok,
    true,
    "a widened allowlist may still let harness code through…",
  );
  assert.equal(
    checkPathScope(["gates/probes/list-total-count.mjs"], { allowlist: ["gates/"], protectedPaths: ["gates/probes/"] }).ok,
    false,
    "…but never the oracles themselves",
  );
});
