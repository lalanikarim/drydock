// Inference reachability probing (#133).
//
// Why this exists. On 2026-11-02 the inference host went away and nothing in the fleet said so. `/health`
// answered `{"status":"ok"}`, `GET /providers` answered `"available": true` for a provider whose machine had
// no route, and a submission accepted with 202 sat unsettled forever — no assistant turn, no error line. The
// outage was discovered because a boot test skipped, not because anything reported it. That is the same
// failure family as #122 (silent task loss) arriving from the network instead of the transcript.
//
// What "available" actually means upstream: `models.getAvailable()` reports *configured and credentialed*,
// which is a statement about a JSON file, not about a host. So this module asks the only question that
// matters with the only instrument that can answer it — an HTTP request to the endpoint the repo config pins.
//
// Deliberate limits, stated rather than discovered later:
//   - This is `/models` with credentials, not a generation. It catches DNS failure, no-route, refused
//     connection, TLS trouble, wrong key and endpoint-down-500s. It does NOT catch "host up, model unloaded",
//     which needs a 1-token completion or comparing the endpoint's loaded-model list against the pin. The
//     comparison hook is here (`loadedModelIds`); the generation probe is not, because it costs inference to
//     run every interval and that decision should be explicit.
//   - A hung-but-listening host shows up as a timeout, which is reported as unreachable with reason
//     `timeout` — distinguishable from refusal, because "it refused" and "it is thinking" lead to different
//     operator actions.

/** One provider an enabled repo actually pins, resolved to something probeable. */
export type ProviderEndpoint = {
  id: string;
  baseUrl: string;
  apiKey?: string;
};

export type ProbeResult = {
  id: string;
  reachable: boolean;
  checkedAt: number;
  latencyMs: number;
  /** HTTP status when a response arrived. */
  status?: number;
  /** Machine-readable reason when it did not: `timeout` | `dns` | `refused` | `no-route` | `http-<n>` | `error`. */
  reason?: string;
  /** Model ids the endpoint reported, for callers that want to compare against a pin. Never contains secrets. */
  loadedModelIds?: string[];
  /** Hostname only, for the loopback detail view. Public health never carries this. */
  host?: string;
};

export type InferenceAggregate = {
  state: "reachable" | "degraded" | "unreachable" | "unknown";
  reachable: number;
  total: number;
  checkedAt: number | null;
};

/**
 * Resolve a models.json `apiKey` value. The kernel's rules: literal, or `$NAME` / `${NAME}` env
 * interpolation, and `!command` is not supported. Re-implemented here (rather than imported) because the
 * probe must run in the adapter process without dragging in the model catalog; the shapes are pinned by a
 * test so drift shows up as a failure rather than as a probe that silently has no credential.
 */
export function interpolateSecret(value: unknown, env: Record<string, string | undefined> = process.env): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value.startsWith("!")) return undefined; // unsupported by the kernel too; never executed here
  const envRef = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
  if (envRef) return env[envRef[1]!] || undefined;
  return value;
}

/** Parse `<agentDir>/models.json` into probeable endpoints. Tolerates an absent/odd file: no providers. */
export function parseModelProviders(text: string | undefined): Array<{ id: string; baseUrl?: string; apiKey?: string }> {
  if (!text) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const providers = (doc as { providers?: Record<string, unknown> })?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out: Array<{ id: string; baseUrl?: string; apiKey?: string }> = [];
  for (const [id, raw] of Object.entries(providers)) {
    if (!raw || typeof raw !== "object") continue;
    const cfg = raw as { baseUrl?: unknown; apiKey?: unknown };
    out.push({
      id,
      baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined,
      apiKey: interpolateSecret(cfg.apiKey),
    });
  }
  return out;
}

/** Map a fetch failure to a reason an operator can act on. Node puts the code on the cause/err itself. */
export function classifyFetchError(e: unknown): string {
  const anyErr = e as { name?: string; cause?: { code?: string }; code?: string };
  if (anyErr?.name === "AbortError" || anyErr?.name === "TimeoutError") return "timeout";
  const code = anyErr?.cause?.code ?? anyErr?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "EHOSTDOWN" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "no-route";
  if (typeof code === "string" && code) return code.toLowerCase();
  return "error";
}

/** One probe: GET <baseUrl>/models with credentials. Cheap, authenticated, and endpoint-specific. */
export async function probeProvider(
  p: ProviderEndpoint,
  { fetchImpl = fetch, timeoutMs = 5000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const started = Date.now();
  const base = p.baseUrl?.replace(/\/$/, "");
  if (!base) {
    return { id: p.id, reachable: false, checkedAt: started, latencyMs: 0, reason: "no-base-url" };
  }
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    /* leave blank rather than echo a malformed url */
  }
  try {
    const res = await fetchImpl(`${base}/models`, {
      headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { id: p.id, reachable: false, checkedAt: Date.now(), latencyMs, status: res.status, reason: `http-${res.status}`, host };
    }
    let loadedModelIds: string[] | undefined;
    try {
      const body = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
      const list = Array.isArray(body) ? body : (body?.data ?? []);
      const ids = list.map((m) => m?.id).filter((x): x is string => typeof x === "string" && x.length > 0);
      loadedModelIds = ids.length ? ids.slice(0, 64) : undefined;
    } catch {
      /* a model list we cannot parse still counts as reachable — the question was reachability */
    }
    return { id: p.id, reachable: true, checkedAt: Date.now(), latencyMs, status: res.status, loadedModelIds, host };
  } catch (e) {
    return { id: p.id, reachable: false, checkedAt: Date.now(), latencyMs: Date.now() - started, reason: classifyFetchError(e), host };
  }
}

/** Aggregate for public health. No ids, no hosts: this response is reachable through the public funnel. */
export function aggregate(results: readonly ProbeResult[]): InferenceAggregate {
  const checkedAt = results.reduce<number | null>((acc, r) => (r.checkedAt && (!acc || r.checkedAt > acc) ? r.checkedAt : acc), null);
  if (results.length === 0) return { state: "unknown", reachable: 0, total: 0, checkedAt: null };
  const reachable = results.filter((r) => r.reachable).length;
  const state = reachable === results.length ? "reachable" : reachable === 0 ? "unreachable" : "degraded";
  return { state, reachable, total: results.length, checkedAt };
}

export interface ProberOptions {
  providers: ProviderEndpoint[];
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called when the aggregate state changes (and on the first result, so "unreachable at startup" is heard). */
  onTransition?: (next: InferenceAggregate, previous: InferenceAggregate | null, results: readonly ProbeResult[]) => void;
  log?: (line: string) => void;
}

/**
 * Periodic prober with transition edges. The edge matters more than the value: a health endpoint that says
 * `unreachable` is only useful if somebody reads it, and nobody reads health endpoints until something has
 * already gone wrong. Notification on the edge is what makes an outage at 03:00 knowable at 03:01.
 */
export class InferenceProber {
  private readonly opts: ProberOptions;
  private latest: readonly ProbeResult[] = [];
  private lastAggregate: InferenceAggregate | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: ProberOptions) {
    this.opts = opts;
  }

  async check(): Promise<InferenceAggregate> {
    const results = await Promise.all(
      this.opts.providers.map((p) => probeProvider(p, { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs })),
    );
    this.latest = results;
    const agg = aggregate(results);
    const prev = this.lastAggregate;
    if (!prev || prev.state !== agg.state) {
      this.opts.log?.(`inference ${agg.state} (${agg.reachable}/${agg.total})`);
      try {
        this.opts.onTransition?.(agg, prev, results);
      } catch (e) {
        // A broken notification must not take the prober — and therefore the health disclosure — down.
        this.opts.log?.(`inference transition handler failed: ${(e as Error).message}`);
      }
    }
    this.lastAggregate = agg;
    return agg;
  }

  current(): InferenceAggregate {
    return this.lastAggregate ?? aggregate(this.latest);
  }

  /** Full per-provider detail. Loopback-only surface: it names internal hosts. */
  details(): readonly ProbeResult[] {
    return this.latest;
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Which providers this deployment actually depends on: the ones pinned by the runtime config of every
 * ENABLED registry entry. Probing only those keeps the interval cheap and — more importantly — means the
 * answer is about the hosts work will be dispatched to, not about every provider pi happens to know.
 *
 * Inputs are passed in (registry entries, a config reader, models.json text) so this stays testable without
 * touching the filesystem; the caller resolves paths exactly once.
 */
export function resolvePinnedProviders({
  repos,
  readRuntimeConfig,
  modelsJsonText,
  defaultBaseUrl,
  defaultApiKey,
}: {
  repos: readonly string[];
  readRuntimeConfig: (repo: string) => { models?: { provider?: string; modelId?: string } } | null;
  modelsJsonText?: string;
  /** The env-driven provider (`OPENAI_BASE_URL`), used when a config pins no custom provider. */
  defaultBaseUrl?: string;
  defaultApiKey?: string;
}): ProviderEndpoint[] {
  const byId = new Map<string, ProviderEndpoint>();
  for (const repo of repos) {
    let cfg: { models?: { provider?: string } } | null | undefined;
    try {
      cfg = readRuntimeConfig(repo);
    } catch {
      continue; // unreadable config is a deployment error the supervisor already reports loudly
    }
    if (cfg == null) continue; // no runtime config at all: that repo cannot boot, so probing does not help it
    const provider = cfg.models?.provider || undefined;
    if (!provider) {
      // No pin → the instance resolves through env/default. Probe that endpoint instead of skipping it.
      if (defaultBaseUrl && !byId.has("$env")) byId.set("$env", { id: "$env", baseUrl: defaultBaseUrl, apiKey: defaultApiKey });
      continue;
    }
    if (byId.has(provider)) continue;
    const found = parseModelProviders(modelsJsonText).find((p) => p.id === provider);
    const baseUrl = found?.baseUrl ?? (provider === "openai-completions" || provider === "openai" ? defaultBaseUrl : undefined);
    if (!baseUrl) {
      // Declared-but-unresolvable is reported as a probe with no base url rather than dropped: dropping it
      // would make the aggregate look healthier than the deployment is.
      byId.set(provider, { id: provider });
      continue;
    }
    byId.set(provider, { id: provider, baseUrl, apiKey: found?.apiKey ?? defaultApiKey });
  }
  return [...byId.values()];
}

/** Redact anything credential-shaped before a probe result is logged or rendered. */
export function redact(text: string): string {
  return text.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>").replace(/sk-[A-Za-z0-9._-]{6,}/g, "sk-<redacted>");
}
