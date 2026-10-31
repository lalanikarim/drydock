// Model-catalog self-check (#47 follow-up, 2026-10-30).
//
// Why this exists: `modelId: "auto"` in a repo config asked the endpoint which model it currently
// has loaded, while the kernel built its catalog from `<agentDir>/models.json` — and a provider
// declared there *wins* over the env-driven single-model registration (vendor/engram app/src/model.ts:
// `if (!customIds.has(providerId))`). Two independent sources of truth. On this machine `aurora` is
// declared with one model (ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF), so the factory only ever ran while
// that happened to be the loaded model. Loading a different model on aurora made every task settle
// `unanswered / no_model` — and because nothing surfaces that state, G4 waited out its full 25-minute
// approval timeout instead of failing.
//
// The rules this enforces: pin an explicit model id per repo (measurement baselines are
// model-specific anyway), and refuse to boot when the pinned id is not in the catalog the kernel was
// handed. Both sides of the coupling are named in the error, because "no_model" alone told us nothing.

export interface ModelRefLike {
  provider: string;
  modelId: string;
}

/**
 * Flatten a GET /models response into `provider/modelId` strings.
 *
 * Tolerant of both shapes the app has used over time (array of "prov/id" strings, or objects with
 * id/provider) so a payload change degrades to "not found" — which fails closed — rather than to a
 * false positive.
 */
export function catalogModelIds(payload: unknown): string[] {
  const raw = Array.isArray(payload)
    ? payload
    : ((payload as { models?: unknown })?.models ?? []);
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      ids.push(entry.trim());
    } else if (entry && typeof entry === "object") {
      const e = entry as { id?: unknown; provider?: unknown };
      const id = typeof e.id === "string" ? e.id.trim() : "";
      if (!id) continue;
      ids.push(typeof e.provider === "string" && e.provider ? `${e.provider.trim()}/${id}` : id);
    }
  }
  return ids.filter(Boolean);
}

/** Is this ref present in the catalog? Exact provider/id match, no prefix or case games. */
export function isModelAvailable(ref: ModelRefLike, payload: unknown): boolean {
  const wanted = `${ref.provider}/${ref.modelId}`.toLowerCase();
  return catalogModelIds(payload).some((id) => id.toLowerCase() === wanted);
}

/** Actionable failure text: what was asked for, what exists, and which file decides. */
export function unavailableModelError(ref: ModelRefLike, payload: unknown): string {
  const available = catalogModelIds(payload);
  return (
    `model ${ref.provider}/${ref.modelId} is not in this instance's model catalog — it would settle every task as ` +
    `"unanswered / no_model" instead of running. The catalog comes from <agentDir>/models.json ` +
    `(PI_AGENT_DIR, default ~/.pi/agent/models.json) plus config/models.json next to the repo config; a provider declared ` +
    `there wins over the OPENAI_BASE_URL auto-registration, so "the endpoint serves it" is not enough — it has to be listed. ` +
    `Available now: ${available.length ? available.join(", ") : "(catalog reported none)"}. ` +
    `Fix: pin modelId to a listed id in factory/config/<owner>_<repo>.json, or add this model to that provider's entry in models.json.`
  );
}

/**
 * Model identity for comparison, independent of separator formatting: the instance reports its
 * default as `provider:modelId`, while refs are formatted here as `provider/modelId` — both name
 * the same model. Split at the first separator so a colon inside the model id itself still survives.
 */
function modelIdentity(s: string): string {
  const sep = s.search(/[/:]/);
  return (sep === -1 ? s : `${s.slice(0, sep)}/${s.slice(sep + 1)}`).toLowerCase();
}

/**
 * Warn (do not fail) when the instance's default model differs from the pinned one. The root agent
 * and every task get the pinned ref explicitly, so a differing default is usually harmless — but it
 * has already been the cause of one silent outage, so say it out loud rather than let the next reader
 * rediscover it.
 */
export function defaultMismatchWarning(ref: ModelRefLike, payload: unknown): string | null {
  const def = (payload as { default?: unknown })?.default;
  if (typeof def !== "string" || !def) return null;
  // Compare identity, not formatting (`provider:model` vs `provider/model` name the same model);
  // keep each side's raw form in the message — "what did each side say" is the diagnostic.
  return modelIdentity(def) === modelIdentity(`${ref.provider}/${ref.modelId}`)
    ? null
    : `instance default model is ${def} but this repo pins ${ref.provider}/${ref.modelId} — the factory runs the pinned ref; anything inheriting the default (a new role, a manual /tasks call) will not`;
}

/**
 * Fetch the instance's own catalog and assert the ref is runnable.
 * Call this BEFORE announcing readiness: a process that prints "ready" and then silently refuses to
 * generate is the failure mode that cost 25 minutes of wall clock per attempt.
 */
export async function assertModelAvailable(ref: ModelRefLike, baseUrl: string, token: string): Promise<unknown> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET /models from ${baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = (await res.json()) as unknown;
  if (!isModelAvailable(ref, payload)) throw new Error(unavailableModelError(ref, payload));
  return payload;
}
