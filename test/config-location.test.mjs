// Runtime config lives outside the source tree — these tests pin that, because the property is the security
// argument and a silent regression (someone re-adding factory/config/x.json "just for the tests") would erase
// it while every existing test stayed green.
//
// Why it moved: `testCommand` is executed to decide whether a branch may be pushed. While per-repo config sat
// at factory/config/<owner>_<repo>.json it was inside drydock's own path allowlist (`factory/`), so a self-run
// could open a draft PR that changed the command used to verify itself. Human merge was the only control
// between that and a run grading its own work. Out of the tree, path scope is never asked the question.
//
//   node --experimental-strip-types --test test/config-location.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_DIR_ENV,
  configDir,
  configSlug,
  defaultConfigPathFor,
  loadFactoryConfig,
  resolveFactoryConfigPath,
} from "../factory/factory-config.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------------------

test("no per-repo runtime config is tracked in the repository", () => {
  const dir = join(REPO_ROOT, "factory", "config");
  let leftovers = [];
  try {
    leftovers = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    // Directory gone entirely — the expected state.
  }
  assert.deepEqual(leftovers, [], `runtime config must not live in the tree; found: ${leftovers.join(", ")}`);
  // The template is the one artifact that stays: it documents the shape and carries no deployment values.
  assert.ok(existsSync(join(REPO_ROOT, "factory", "config.example.json")), "factory/config.example.json must exist as the shape reference");
});

test("the default config dir is outside the repository and under $HOME", () => {
  const dir = configDir({});
  assert.equal(dir, join(homedir(), ".drydock", "configs"));
  assert.ok(!dir.startsWith(REPO_ROOT), `default config dir must not be inside the checkout: ${dir}`);
});

test(`${CONFIG_DIR_ENV} relocates the whole thing (a second machine, or a test)`, () => {
  const alt = mkdtempSync(join(tmpdir(), "drydock-altcfg-"));
  try {
    assert.equal(configDir({ [CONFIG_DIR_ENV]: alt }), resolve(alt));
    assert.equal(defaultConfigPathFor("octo/thing", { [CONFIG_DIR_ENV]: alt }), join(resolve(alt), "octo_thing.json"));
    // Blank/whitespace is not a relocation; it must not become "" and start resolving relative to cwd.
    assert.equal(configDir({ [CONFIG_DIR_ENV]: "   " }), join(homedir(), ".drydock", "configs"));
  } finally {
    rmSync(alt, { recursive: true, force: true });
  }
});

test("configSlug maps owner/name to the on-disk name used everywhere", () => {
  assert.equal(configSlug("lalanikarim/drydock"), "lalanikarim_drydock");
  assert.equal(configSlug("octo-org.sub/deep.nested-2"), "octo-org.sub_deep.nested-2");
});

test("resolution order: explicit --config, then the config dir. Never the source tree.", () => {
  const alt = mkdtempSync(join(tmpdir(), "drydock-resolve-"));
  try {
    const explicit = join(alt, "somewhere-else.json");
    assert.equal(resolveFactoryConfigPath("octo/thing", { explicit }), explicit);
    assert.equal(
      resolveFactoryConfigPath("octo/thing", { env: { [CONFIG_DIR_ENV]: alt } }),
      join(resolve(alt), "octo_thing.json"),
    );
    // Only two inputs exist: a flag a human typed, or convention. Policy has no way to name a file, which is
    // what makes "enabled entry pointing somewhere else" unrepresentable rather than merely unchecked — and
    // with no flag, resolution is a pure function of (repo, dir).
    const twice = resolveFactoryConfigPath("octo/thing", { env: { [CONFIG_DIR_ENV]: alt } });
    assert.equal(twice, resolveFactoryConfigPath("octo/thing", { env: { [CONFIG_DIR_ENV]: alt } }));
    assert.equal(twice.split("/").pop(), "octo_thing.json");

    // The property that motivated the change, stated directly: nothing a run can point at is under path scope.
    const resolved = resolveFactoryConfigPath("lalanikarim/drydock", { env: {} });
    assert.ok(!resolved.startsWith(REPO_ROOT), `resolved config escaped into the checkout: ${resolved}`);
  } finally {
    rmSync(alt, { recursive: true, force: true });
  }
});

test("config validation stays strict: only _comment and _notes are inert", () => {
  const base = { repo: "octo/thing", models: { provider: "p", modelId: "m-model" }, testCommand: "node --test" };
  const dir = mkdtempSync(join(tmpdir(), "drydock-strict-"));
  const writeAndLoad = (obj) => {
    const path = join(dir, `cfg-${Object.keys(obj).length}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(obj));
    return loadFactoryConfig(path);
  };
  try {
    assert.equal(writeAndLoad({ ...base, _comment: "why this command" }).testCommand, "node --test");
    assert.equal(writeAndLoad({ ...base, _notes: "context" }).repo, "octo/thing");
    // The exception must not become a hole: an underscore-prefixed typo of a real field is the R6 bug
    // ("I set it and it did nothing"), so it is refused rather than quietly ignored.
    assert.throws(() => writeAndLoad({ ...base, _testCommand: "true" }), /unknown config field: _testCommand/);
    assert.throws(() => writeAndLoad({ ...base, testComand: "true" }), /unknown config field: testComand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no shipped entrypoint resolves runtime config from inside the checkout (source pin)", () => {
  // Two cheap invariants: every entrypoint goes through the shared resolver, and none of them names the old
  // in-tree location. (A local variable named for an instance's own config dir under factory-instances/ is a
  // different thing and stays legal — hence matching the path literal rather than any "config" join.)
  for (const rel of ["factory/main.ts", "fleet/supervisor.ts", "gates/lib.ts"]) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.match(src, /from "[^"]*factory-config\.ts"/, `${rel} must resolve runtime config through factory/factory-config.ts`);
    assert.ok(!src.includes('"factory/config/'), `${rel} references the removed in-tree config location`);
    assert.ok(!src.includes('"factory", "config"'), `${rel} joins the removed in-tree config directory`);
  }
});

test("configs present on this machine are readable by the same resolver the factory uses", (t) => {
  const dir = configDir();
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    t.skip(`no config dir at ${dir} (deployment files; absent on a CI runner)`);
    return;
  }
  if (files.length === 0) {
    t.skip(`no runtime configs in ${dir}`);
    return;
  }
  for (const file of files) {
    const cfg = loadFactoryConfig(join(dir, file));
    assert.equal(defaultConfigPathFor(cfg.repo, {}), join(configDir({}), file), `${file} is not named for the repo it declares`);
  }
});
