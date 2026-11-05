/**
 * Deterministic model selection for the boot suites (#241).
 *
 * Both boot tests used to take `data[0].id` from `/models`. That is not a model choice, it is a dependency on the
 * order an inference server happens to return today: when Unsloth Studio's list reordered, `intake-boot` selected
 * `unsloth/gemma-4-E4B-it-GGUF`, submissions were accepted, two user entries appeared, `waitForIdle` returned, and
 * **no assistant turn was ever produced** — while the same endpoint answered a raw completion for that model in
 * 5.9 s. The suite's own message blamed "a provider whose host is unreachable", which was false, and no CI job runs
 * the suite, so it stayed red unnoticed. Three defects in one line: selection by position, a failure message that
 * misdiagnoses, and coverage nobody consumes.
 *
 * So: name the model you want (env), or read the pin production actually uses ($DRYDOCK_CONFIG_DIR/<repo>.json),
 * verify it is served, and **skip loudly** rather than fall back to something else. A boot suite that silently runs
 * against a different model than production is measuring a different system.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseProviderCatalog, providerForBaseUrl } from "./model-catalog.ts";

export type BootModelRef = { provider: string; modelId: string };

export type BootModelResolution =
  | { ok: true; ref: BootModelRef; source: "DEFAULT_MODEL" | "drydock-config"; served: true }
  | { ok: false; reason: string };

/** Where the per-repo runtime config lives (same rule `factory/factory-config.ts` uses). */
export function operatorConfigPath(repo = "lalanikarim/drydock", env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.DRYDOCK_CONFIG_DIR ?? join(homeDir(env), ".drydock", "configs");
  return join(dir, `${repo.replace("/", "_")}.json`);
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

/** The pin production boots from. Undefined when the config or its `models` block is absent — a caller must then
 *  skip, not guess. */
export function pinnedModelFromConfig(path = operatorConfigPath()): BootModelRef | undefined {
  if (!existsSync(path)) return undefined;
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const models = (cfg as { models?: unknown })?.models as { provider?: unknown; modelId?: unknown } | undefined;
  const provider = typeof models?.provider === "string" ? models.provider : undefined;
  const modelId = typeof models?.modelId === "string" ? models.modelId : undefined;
  return provider && modelId ? { provider, modelId } : undefined;
}

/** List what the endpoint serves. Throws are the caller's problem on purpose: "could not list" and "listed but the
 *  pin is missing" must not collapse into the same skip. */
export async function listServedModels(baseUrl: string, apiKey = process.env.OPENAI_API_KEY ?? ""): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body?.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean);
}

/**
 * Resolve the boot-test model. Precedence: `DEFAULT_MODEL=provider:id`, then the operator's production pin. The
 * result must be present in `served`; anything else is a loud skip with the reason and the fix, never a fallback.
 */
export function chooseBootModel(opts: {
  served: string[];
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  catalogRaw?: string | null;
}): BootModelResolution {
  const env = opts.env ?? process.env;
  const explicit = env.DEFAULT_MODEL;
  let ref: BootModelRef | undefined;
  let source: "DEFAULT_MODEL" | "drydock-config";

  if (explicit?.includes(":")) {
    const provider = explicit.split(":")[0]!;
    const modelId = explicit.split(":").slice(1).join(":");
    ref = { provider, modelId };
    source = "DEFAULT_MODEL";
  } else {
    ref = pinnedModelFromConfig(opts.configPath ?? operatorConfigPath());
    source = "drydock-config";
  }

  if (!ref) {
    return {
      ok: false,
      reason:
        `no model pin to test with: DEFAULT_MODEL is unset and ${opts.configPath ?? operatorConfigPath()} has no models.provider/modelId. ` +
        "Refusing to pick one from /models — list order is not a policy (#241).",
    };
  }

  if (opts.served.length > 0 && !opts.served.includes(ref.modelId)) {
    return {
      ok: false,
      reason:
        `pinned model ${ref.provider}:${ref.modelId} is not served by ${opts.baseUrl}. Served: ${opts.served.slice(0, 5).join(", ")}` +
        `${opts.served.length > 5 ? `, … (${opts.served.length} total)` : ""}. Load it, or set DEFAULT_MODEL=provider:id. ` +
        "Not falling back to another model: a boot suite testing a different model than production proves nothing about production.",
    };
  }

  // A ref naming an unregistered provider is accepted and never runs (#171) — the exact silence that made this
  // suite's failure look like an outage. Warn when the catalog declares a different provider for this base URL.
  const declared = providerForBaseUrl(parseProviderCatalog(opts.catalogRaw ?? null), opts.baseUrl);
  if (declared && declared !== ref.provider) {
    return {
      ok: false,
      reason:
        `model ref names provider "${ref.provider}", but the kernel's catalog declares "${declared}" for ${opts.baseUrl}. ` +
        "A ref naming an unregistered provider is accepted and never produces an assistant turn (#171) — that is a silent " +
        "green, so this resolves as a skip instead.",
    };
  }

  return { ok: true, ref, source, served: true };
}
