// Per-repo factory configuration (multi-repo plan §3.1), ported to TS.
//
// One JSON file per managed repo, loaded and validated at instance startup.
// Host concerns live here (repo identity, sandbox image, test command,
// budgets); the core's own settings (data dirs, gates, approval TTL) come from
// loadConfig(overrides) in main.ts — this file only carries factory-specific
// fields and maps the shared ones into core overrides.
//
// Security note: `testCommand`/`setupCommand` are executed as argv (never
// through a shell) and must not contain shell metacharacters. They come from
// factory-side trusted config, but we keep the surface strict regardless.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where per-repo runtime config lives: OUTSIDE the source tree. Two facts drove this:
 *
 * 1. `testCommand` is executed to decide whether a branch may be pushed, and it lived at
 *    `factory/config/<owner>_<repo>.json` — inside drydock's own path allowlist (`factory/`). A self-run could
 *    therefore open a draft PR that changed the command used to verify itself. A human merge was the only thing
 *    between that and a run grading its own work with `true`. Config outside the tree means path scope is no
 *    longer even asked that question.
 * 2. These files are deployment state — which model this host serves, what a sandbox image is called here, how
 *    much wall clock an issue gets on this laptop. They were reviewed like code without being code.
 *
 * `DRYDOCK_CONFIG_DIR` overrides the default so a second machine (or a test) can point somewhere else entirely.
 */
export const CONFIG_DIR_ENV = "DRYDOCK_CONFIG_DIR";

/** The directory holding `<owner>_<repo>.json` runtime configs. Never inside the repository. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[CONFIG_DIR_ENV]?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), ".drydock", "configs");
}

/** `lalanikarim/drydock` → `lalanikarim_drydock`. */
export function configSlug(repo: string): string {
  return repo.replace("/", "_");
}

/** Default runtime-config path for a repo, inside the config dir. */
export function defaultConfigPathFor(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), `${configSlug(repo)}.json`);
}

/**
 * Resolve which runtime config an instance should load: an explicit `--config` path if the operator passed one,
 * otherwise `<configDir>/<owner>_<repo>.json`. Two cases, deliberately — the only way to point an instance at a
 * different file is a flag a human typed, so nothing read from policy or from a repository can redirect it.
 */
export function resolveFactoryConfigPath(
  repo: string,
  opts: { explicit?: string | null; env?: NodeJS.ProcessEnv } = {},
): string {
  if (opts.explicit) return resolve(opts.explicit);
  return defaultConfigPathFor(repo, opts.env ?? process.env);
}

export const DEFAULTS = {
  sandboxImage: "factory-sandbox:latest",
  testCommand: "node --test",
  budgets: { wallSecsPerIssue: 1800, maxReviewRetries: 2 },
  approvalTtlHours: 24,
};

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NO_SHELL_RE = /[;&|`$<>(){}[\]*!#~]/;

function validateCommand(cmd: unknown, field: string): asserts cmd is string {
  if (typeof cmd !== "string" || !cmd.trim()) throw new Error(`${field} must be a non-empty string`);
  if (NO_SHELL_RE.test(cmd)) throw new Error(`${field} must not contain shell metacharacters (executed as argv, not via a shell): ${JSON.stringify(cmd)}`);
}

/** Split a validated command into argv (whitespace-separated, no quoting support by design). */
export function commandArgv(cmd: string): string[] {
  return cmd.trim().split(/\s+/);
}

export interface FactoryConfig {
  repo: string;
  sandboxImage: string;
  setupCommand: string | null;
  testCommand: string;
  models: { provider: string; modelId: string };
  gitToken: string;
  budgets: { wallSecsPerIssue: number; maxReviewRetries: number };
  lessonsFile: string | null;
  approvalTtlHours: number;
}

/** Validate and normalize one repo's config object. Throws on any violation. */
export function validateFactoryConfig(raw: unknown): FactoryConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const known = new Set(["repo", "sandboxImage", "setupCommand", "testCommand", "models", "gitToken", "budgets", "lessonsFile", "approvalTtlHours"]);
  for (const key of Object.keys(obj)) {
    // Two exact names may carry prose. A config that lives outside the repository has no diff to explain it,
    // so the file explains itself — but only these two, because a blanket "leading underscore is ignored"
    // would let `_testCommand` sit in a file doing nothing, which is the R6 failure mode this check exists to
    // catch ("I set it and it did nothing").
    if (key === "_comment" || key === "_notes") continue;
    if (!known.has(key)) throw new Error(`unknown config field: ${key}`);
  }
  if (typeof obj.repo !== "string" || !REPO_RE.test(obj.repo)) {
    throw new Error(`repo must be "owner/name", got: ${JSON.stringify(obj.repo)}`);
  }
  const testCommand = (obj.testCommand ?? DEFAULTS.testCommand) as string;
  validateCommand(testCommand, "testCommand");
  if (obj.setupCommand !== undefined) validateCommand(obj.setupCommand, "setupCommand");
  const sandboxImage = (obj.sandboxImage ?? DEFAULTS.sandboxImage) as string;
  if (typeof sandboxImage !== "string" || !sandboxImage.trim()) throw new Error("sandboxImage must be a non-empty string");
  // Model ref for worker/reviewer tasks. The core resolves its own default
  // separately; the factory pipeline needs an explicit one (provider/modelId).
  if (!obj.models || typeof obj.models !== "object" || Array.isArray(obj.models)) {
    throw new Error("models must be { provider: string, modelId: string }");
  }
  const models = obj.models as Record<string, unknown>;
  if (typeof models.provider !== "string" || !models.provider.trim() || typeof models.modelId !== "string" || !models.modelId.trim()) {
    throw new Error("models must be { provider: string, modelId: string } (modelId may be \"auto\")");
  }
  if (models.modelId !== "auto" && !/^[\w.-]+(\/[\w.-]+)*$/.test(models.modelId)) {
    throw new Error(`models.modelId must be a model id or "auto": ${JSON.stringify(models.modelId)}`);
  }
  if (obj.gitToken !== undefined && (typeof obj.gitToken !== "string" || !obj.gitToken)) {
    throw new Error("gitToken must be a non-empty string when present");
  }
  const budgets = { ...DEFAULTS.budgets, ...(obj.budgets as object ?? {}) };
  if (!Number.isInteger(budgets.wallSecsPerIssue) || budgets.wallSecsPerIssue <= 0) {
    throw new Error("budgets.wallSecsPerIssue must be a positive integer");
  }
  if (!Number.isInteger(budgets.maxReviewRetries) || budgets.maxReviewRetries < 0 || budgets.maxReviewRetries > 5) {
    throw new Error("budgets.maxReviewRetries must be an integer in 0..5");
  }
  if (obj.lessonsFile !== undefined && (typeof obj.lessonsFile !== "string" || !obj.lessonsFile.trim())) {
    throw new Error("lessonsFile must be a non-empty string when present");
  }
  let approvalTtlHours = DEFAULTS.approvalTtlHours;
  if (obj.approvalTtlHours !== undefined) {
    if (typeof obj.approvalTtlHours !== "number" || !Number.isFinite(obj.approvalTtlHours) || obj.approvalTtlHours <= 0) {
      throw new Error(`approvalTtlHours must be a positive number, got: ${JSON.stringify(obj.approvalTtlHours)}`);
    }
    approvalTtlHours = obj.approvalTtlHours;
  }
  return {
    repo: obj.repo as string,
    sandboxImage,
    models: { provider: models.provider, modelId: models.modelId },
    setupCommand: (obj.setupCommand as string) ?? null,
    testCommand,
    gitToken: (obj.gitToken as string) ?? "",
    budgets,
    lessonsFile: (obj.lessonsFile as string) ?? null,
    approvalTtlHours,
  };
}

/** Load + validate a config file. Returns the normalized config. */
export function loadFactoryConfig(path: string): FactoryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read/parse factory config at ${path}: ${(e as Error).message}`);
  }
  return validateFactoryConfig(raw);
}
