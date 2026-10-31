// Shared .env loading for fleet processes (queue item 6 / publish path).
//
// Why this exists as a module: `factory/main.ts` read the repo-root `.env` and `fleet/supervisor.ts`
// did not. The supervisor owns the webhook adapter and resolves each route's HMAC secret from
// `GITHUB_WEBHOOK_SECRET_<owner>_<repo>`, so starting it from a plain shell meant the adapter fell
// back to the fleet file's placeholder string — every delivery from GitHub then failed with
// "invalid signature", which reads like a GitHub or hook problem and is actually our own config
// never being loaded. One loader, called by both entry points, plus an explicit answer to "which of
// my two secrets is in force?".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parse and apply a simple KEY=value file without overwriting ambient variables.
 *  Returns the keys it set (for logging); silently no-ops when the file is absent. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const applied: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    // Trim first, then strip one layer of quotes — "KEY = 'v' " must not keep trailing spaces.
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) {
      env[m[1]] = v;
      applied.push(m[1]);
    }
  }
  return applied;
}

/** The repo-root `.env`, resolved relative to this module (`factory/` → repo root). */
export function loadRootEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return loadEnvFile(join(import.meta.dirname, "..", ".env"), env);
}

/** Values that are structurally not secrets: templates and instructions left in place of a secret. */
const PLACEHOLDER_SHAPE = /(placeholder|change[ _-]?me|see[-_]|example|todo|xxxx)/i;

/** The environment variable a route's secret is read from. */
export function webhookSecretVar(repo: string): string {
  return `GITHUB_WEBHOOK_SECRET_${repo.replace("/", "_")}`;
}

/**
 * Resolve one route's webhook secret and say where it came from.
 *
 * Precedence is env then fleet file, matching how the supervisor has always behaved — but a fleet
 * file value that looks like a placeholder is refused instead of silently used. That refusal is the
 * whole point: a wrong-but-non-empty secret produces HMAC failures forever with no hint that the
 * configured value was never meant to be a secret, whereas an error naming the variable to set is
 * self-explanatory. Never returns or logs the secret itself.
 */
export function resolveWebhookSecret(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  fleetFileValue?: string,
): { secret: string; source: "env" | "fleet-file" } {
  const variable = webhookSecretVar(repo);
  const fromEnv = typeof env[variable] === "string" ? env[variable] : undefined;
  const candidate = fromEnv ?? fleetFileValue;
  const source = fromEnv !== undefined ? "env" : "fleet-file";

  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(
      `repo ${repo} has no webhook secret — set ${variable} in the environment or .env, or put the real secret in the fleet file's .secret`,
    );
  }
  // Shape-based detection only. Secret *length* is deliberately not enforced — that is the operator's
  // call and a short-but-real secret fails loudly at HMAC time; a placeholder-shaped value instead
  // fails forever with an external-looking cause, which is the failure this function exists to catch.
  if (PLACEHOLDER_SHAPE.test(candidate)) {
    throw new Error(
      `repo ${repo} webhook secret (from ${source === "env" ? variable : "fleet file .secret"}) looks like a placeholder, not a secret — GitHub deliveries will fail HMAC with "invalid signature" and the cause will look external. Put the real shared secret in ${variable}.`,
    );
  }
  return { secret: candidate, source };
}
