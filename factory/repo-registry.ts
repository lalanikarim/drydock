// Repo registry (multi-repo plan §5.11): the checked-in list of repos the factory manages, plus
// the two policy decisions that only make sense per managed repo:
//
//   eligibilityLabel     — which GitHub label makes an issue workable for this repo
//   autoMerge            — whether the pipeline may merge its own PRs here
//   requireVerification  — whether a passing test run is required before a branch may be pushed
//   oracleBoot           — how to start that repo's server so a behavior probe can judge it
//
// Three config artifacts exist and they are deliberately separate, because their failure modes and
// secrecy differ:
//
//   factory/config/<owner>_<repo>.json  per-repo RUNTIME config (model, test command, sandbox image)
//   fleet/fleet.example.json            per-DEPLOYMENT supervision file: one entry per running
//                                       factory plus its webhook secret and instance token. Contains
//                                       secrets, is environment-specific, and is not checked in.
//   factory/repo-registry.json (here)   POLICY: what we allow, independent of what happens to be
//                                       running. No secrets, so it can be reviewed like code.
//
// The registry points at the runtime file via configFile rather than absorbing it, so "what is in
// the fleet" stays answerable without globbing. It does NOT yet generate the supervisor's file —
// which means nothing today prevents a deployment from running a factory the policy marks disabled.
// That gap is called out here rather than left implicit; closing it means deriving routes from this
// registry and refusing to start an entry that is not enabled.
//
// Why autoMerge is here rather than in the per-repo config: it is the one setting whose failure
// mode is destroying something irreplaceable. Fixtures are disposable; drydock holds the research
// record. Keeping it in a single file that lists every repo makes "is anything else auto-merging?"
// a one-screen question instead of a grep.
//
// Security note, same as factory-config.ts: oracleBoot is executed as argv (never through a
// shell) and rejected outright if any element contains shell metacharacters.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathScope } from "./path-scope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = join(HERE, "repo-registry.json");

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NO_SHELL_RE = /[;&|`$<>(){}[\]*!#~]/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORT_FROM = new Set(["stdout", "env"]);

export const REGISTRY_DEFAULTS = {
  eligibilityLabel: "agent",
  autoMerge: true,
  enabled: true,
  requireVerification: true,
  // Comments on this repo's open PRs are NOT a trigger unless a repo opts in (#67).
  prFeedback: false,
  // Refinement (#65) is opt-in for the same reason: it turns an issue label and an issue comment into an
  // inference-costing trigger. Its only output is a comment on the issue.
  refine: false,
  refineLabel: "refine",
};

export interface OracleBoot {
  command: string;
  args: string[];
  /** "stdout": the server logs its bound port (match stdoutPattern). "env": we choose a free
   * port and pass it in envPortVar — required for servers that log the *requested* port, which
   * is useless with 0 (factory-fixture-2 does exactly that). */
  portFrom: "stdout" | "env";
  stdoutPattern?: string;
  envPortVar?: string;
}

export interface RepoEntry {
  repo: string;
  enabled: boolean;
  autoMerge: boolean;
  eligibilityLabel: string;
  /**
   * Opt-in for `/factory …` comments on open pull requests as a rework trigger (#67). Policy, not
   * deployment: it decides whether a conversational surface can start work in this repo at all. The
   * supervisor copies it onto the route so the adapter enforces exactly what the registry declares.
   */
  prFeedback: boolean;
  /**
   * Opt-in for refinement (#65): `<refineLabel>` on an issue, or a `/refine …` comment on an issue, runs a
   * read-only expansion pass whose sole output is a comment. Never a path to implementation — that still
   * requires `eligibilityLabel` and every gate behind it.
   */
  refine: boolean;
  /** Label that requests refinement. Must differ from eligibilityLabel (enforced at load). */
  refineLabel: string;
  /** Path to the per-repo factory config, relative to the drydock repo root. Null only for a
   * disabled entry (enabling a repo without runtime config is a validation error). */
  configFile: string | null;
  oracleBoot: OracleBoot | null;
  /**
   * Prefixes a pipeline run may change; null = any non-protected path. See factory/path-scope.ts.
   * A repo holding its own grading code must leave that code out: drydock omits `gates/` so a
   * self-run cannot edit the oracles that judge it. Narrowing here is policy, not preference.
   */
  pathAllowlist: string[] | null;
  /** Never-change prefixes in addition to the unconditional `vendor/` protection. */
  protectedPaths: string[];
  /**
   * Decision C1 (#61): open_draft_pr must run this repo's test command and refuse to push on a
   * non-zero exit. True by default — a draft PR may not exist without verification.
   * Setting false is the escape hatch for a repo with no runnable suite, and it hides nothing:
   * the PR body must then state that nothing was verified.
   */
  requireVerification: boolean;
  note?: string;
}

export interface Registry {
  defaults: typeof REGISTRY_DEFAULTS;
  repos: RepoEntry[];
}

/** Validate a list of repo-relative path prefixes (allowlist or protected). */
function validatePathList(raw: unknown, field: string, { allowNull = false }: { allowNull?: boolean } = {}): string[] | null {
  if (raw === undefined || raw === null) return allowNull ? null : [];
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array of repo-relative path prefixes`);
  if (raw.length === 0) throw new Error(`${field} must not be an empty array — omit it to mean "unrestricted"`);
  for (const p of raw) {
    if (typeof p !== "string" || !p.trim()) throw new Error(`${field} entries must be non-empty strings`);
    if (isAbsolute(p) || p.startsWith("./") || normalize(p).startsWith("..")) {
      throw new Error(`${field} entries must be repo-relative without traversal, got: ${p}`);
    }
    if (p.includes("\\")) throw new Error(`${field} entries must use "/" separators, got: ${p}`);
    checkNoShell(p, `${field} entry`);
  }
  return [...raw] as string[];
}

/**
 * Safety flags must be real booleans. Loose coercion (`Boolean(x)`) is unsafe here specifically:
 * `"autoMerge": "false"` in JSON coerces to TRUE, so a typo would grant merge rights — in the one
 * field whose failure mode is destroying something irreplaceable. Fail loudly at load instead.
 */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean (not ${JSON.stringify(value)} — a string like "false" would otherwise coerce to true)`);
  return value;
}

function checkNoShell(value: string, field: string): void {
  if (NO_SHELL_RE.test(value)) {
    throw new Error(`${field} must not contain shell metacharacters (executed as argv, not via a shell): ${JSON.stringify(value)}`);
  }
}

function validateOracleBoot(raw: unknown, repo: string): OracleBoot | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${repo}: oracleBoot must be an object`);
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["command", "args", "portFrom", "stdoutPattern", "envPortVar"].includes(key)) {
      throw new Error(`${repo}: unknown oracleBoot field: ${key}`);
    }
  }
  if (typeof obj.command !== "string" || !obj.command.trim()) throw new Error(`${repo}: oracleBoot.command must be a non-empty string`);
  checkNoShell(obj.command, `${repo}: oracleBoot.command`);
  const args = obj.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error(`${repo}: oracleBoot.args must be an array of strings`);
  for (const a of args) checkNoShell(a, `${repo}: oracleBoot.args`);

  if (!PORT_FROM.has(obj.portFrom as string)) {
    throw new Error(`${repo}: oracleBoot.portFrom must be one of ${[...PORT_FROM].join(", ")}`);
  }
  const boot: OracleBoot = { command: obj.command, args: [...args] as string[], portFrom: obj.portFrom as "stdout" | "env" };
  if (boot.portFrom === "stdout") {
    if (typeof obj.stdoutPattern !== "string" || !obj.stdoutPattern) throw new Error(`${repo}: oracleBoot.stdoutPattern is required when portFrom="stdout"`);
    try {
      new RegExp(obj.stdoutPattern);
    } catch (e) {
      throw new Error(`${repo}: oracleBoot.stdoutPattern is not a valid regular expression: ${(e as Error).message}`);
    }
    boot.stdoutPattern = obj.stdoutPattern;
  } else {
    if (typeof obj.envPortVar !== "string" || !ENV_VAR_RE.test(obj.envPortVar)) {
      throw new Error(`${repo}: oracleBoot.envPortVar must be a valid environment variable name when portFrom="env"`);
    }
    boot.envPortVar = obj.envPortVar;
  }
  return boot;
}

/** Validate and normalize a registry object. Pure — no filesystem access (loadRegistry does that). */
export function validateRegistry(raw: unknown): Registry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("repo registry must be a JSON object");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["$comment", "defaults", "repos"].includes(key)) throw new Error(`unknown registry field: ${key}`);
  }

  const d = (obj.defaults ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (!["eligibilityLabel", "autoMerge", "enabled", "requireVerification", "prFeedback", "refine", "refineLabel"].includes(key)) throw new Error(`unknown registry defaults field: ${key}`);
  }
  const defaults = {
    eligibilityLabel: typeof d.eligibilityLabel === "string" && d.eligibilityLabel.trim() ? d.eligibilityLabel.trim() : REGISTRY_DEFAULTS.eligibilityLabel,
    autoMerge: d.autoMerge === undefined ? REGISTRY_DEFAULTS.autoMerge : requireBoolean(d.autoMerge, "defaults.autoMerge"),
    enabled: d.enabled === undefined ? REGISTRY_DEFAULTS.enabled : requireBoolean(d.enabled, "defaults.enabled"),
    requireVerification: d.requireVerification === undefined ? REGISTRY_DEFAULTS.requireVerification : requireBoolean(d.requireVerification, "defaults.requireVerification"),
    prFeedback: d.prFeedback === undefined ? REGISTRY_DEFAULTS.prFeedback : requireBoolean(d.prFeedback, "defaults.prFeedback"),
    refine: d.refine === undefined ? REGISTRY_DEFAULTS.refine : requireBoolean(d.refine, "defaults.refine"),
    refineLabel: typeof d.refineLabel === "string" && d.refineLabel.trim() ? d.refineLabel.trim() : REGISTRY_DEFAULTS.refineLabel,
  };

  if (!Array.isArray(obj.repos) || obj.repos.length === 0) throw new Error("registry.repos must be a non-empty array");
  const seen = new Set<string>();
  const repos: RepoEntry[] = obj.repos.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`registry.repos[${i}] must be an object`);
    const r = entry as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!["repo", "enabled", "autoMerge", "eligibilityLabel", "configFile", "oracleBoot", "pathAllowlist", "protectedPaths", "requireVerification", "prFeedback", "refine", "refineLabel", "note"].includes(key)) {
        throw new Error(`registry.repos[${i}]: unknown field: ${key}`);
      }
    }
    if (typeof r.repo !== "string" || !REPO_RE.test(r.repo)) throw new Error(`registry.repos[${i}].repo must be "owner/name", got: ${JSON.stringify(r.repo)}`);
    const repo = r.repo;
    if (seen.has(repo)) throw new Error(`duplicate registry entry for ${repo}`);
    seen.add(repo);

    const enabled = r.enabled === undefined ? defaults.enabled : requireBoolean(r.enabled, `${repo}: enabled`);
    const autoMerge = r.autoMerge === undefined ? defaults.autoMerge : requireBoolean(r.autoMerge, `${repo}: autoMerge`);
    // Fail closed: a repo the factory does not run must never carry a merge grant. If someone
    // disables an entry but forgets to drop autoMerge, that leftover is a latent surprise for
    // whoever re-enables it — make them state it again instead.
    if (!enabled && autoMerge) throw new Error(`${repo}: disabled registry entry must not declare autoMerge=true`);

    let configFile: string | null = null;
    if (r.configFile !== undefined && r.configFile !== null) {
      if (typeof r.configFile !== "string" || !r.configFile.trim()) throw new Error(`${repo}: configFile must be a non-empty string or null`);
      if (isAbsolute(r.configFile) || normalize(r.configFile).startsWith("..")) {
        throw new Error(`${repo}: configFile must be a repo-relative path, got: ${r.configFile}`);
      }
      configFile = r.configFile;
    }
    if (enabled && !configFile) throw new Error(`${repo}: enabled registry entry requires configFile`);

    const eligibilityLabel = typeof r.eligibilityLabel === "string" && r.eligibilityLabel.trim()
      ? r.eligibilityLabel.trim()
      : defaults.eligibilityLabel;

    const refineEnabled = r.refine === undefined ? defaults.refine : requireBoolean(r.refine, `${repo}: refine`);
    // Present-but-blank is refused rather than defaulted: a policy field that silently becomes something
    // else is how "I set it and it did nothing" debugging starts.
    if (r.refineLabel !== undefined && r.refineLabel !== null && !(typeof r.refineLabel === "string" && r.refineLabel.trim())) {
      throw new Error(`${repo}: refineLabel must be a non-empty string when present`);
    }
    const refineLabelValue = typeof r.refineLabel === "string" && r.refineLabel.trim() ? r.refineLabel.trim() : defaults.refineLabel;
    // One gesture must not be able to mean both "expand this" and "go build it". Caught at load rather
    // than left to the classifier's runtime guard, because a registry that says `refine: true` while the
    // two labels collide is a misconfiguration someone should have to fix, not a feature quietly off.
    if (refineEnabled && refineLabelValue === eligibilityLabel) {
      throw new Error(`${repo}: refineLabel and eligibilityLabel must differ (both are "${eligibilityLabel}") — one label cannot mean both "refine this" and "implement this"`);
    }

    return {
      repo,
      enabled,
      autoMerge,
      eligibilityLabel,
      configFile,
      oracleBoot: validateOracleBoot(r.oracleBoot, repo),
      pathAllowlist: validatePathList(r.pathAllowlist, `${repo}: pathAllowlist`, { allowNull: true }),
      protectedPaths: validatePathList(r.protectedPaths, `${repo}: protectedPaths`) ?? [],
      requireVerification: r.requireVerification === undefined ? defaults.requireVerification : requireBoolean(r.requireVerification, `${repo}: requireVerification`),
      prFeedback: r.prFeedback === undefined ? defaults.prFeedback : requireBoolean(r.prFeedback, `${repo}: prFeedback`),
      refine: refineEnabled,
      refineLabel: refineLabelValue,
      ...(typeof r.note === "string" ? { note: r.note } : {}),
    };
  });

  return { defaults, repos };
}

/** Load and validate the registry, checking that each enabled entry's configFile exists. */
export function loadRegistry(path: string = DEFAULT_REGISTRY_PATH): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read repo registry at ${path}: ${(e as Error).message}`);
  }
  const registry = validateRegistry(raw);
  const root = resolve(dirname(path), ".."); // repo-registry.json lives in <root>/factory/
  for (const entry of registry.repos) {
    if (entry.enabled && entry.configFile && !existsSync(join(root, entry.configFile))) {
      throw new Error(`${entry.repo}: configFile ${entry.configFile} does not exist (resolved to ${join(root, entry.configFile)})`);
    }
  }
  return registry;
}

export function registryRepoNames(registry: Registry): string[] {
  return registry.repos.map((r) => r.repo);
}

export function enabledRepos(registry: Registry): RepoEntry[] {
  return registry.repos.filter((r) => r.enabled);
}

/** One entry by exact repo name, with a message that lists what IS in the registry. */
export function requireRepo(registry: Registry, repo: string): RepoEntry {
  const hit = registry.repos.find((r) => r.repo === repo);
  if (!hit) throw new Error(`${repo} is not in the repo registry (known: ${registryRepoNames(registry).join(", ")})`);
  return hit;
}

/** The path scope a pipeline run must obey for this repo (see factory/path-scope.ts). */
export function scopeOf(entry: RepoEntry): PathScope {
  return { allowlist: entry.pathAllowlist, protectedPaths: entry.protectedPaths };
}

/** Like requireRepo but rejects disabled entries — use for anything that would act on a repo. */
export function requireEnabledRepo(registry: Registry, repo: string): RepoEntry {
  const entry = requireRepo(registry, repo);
  if (!entry.enabled) throw new Error(`${repo} is in the repo registry but disabled${entry.note ? `: ${entry.note}` : ""}`);
  return entry;
}
