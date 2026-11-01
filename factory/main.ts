// One engram core instance per managed repository (issue #30, phase 1).
//
//   node --experimental-strip-types factory/main.ts <owner/repo> [--config path]
//
// Layout created/expected under factory-instances/<repo>/:
//   engram-data/   pi-durable data dir for this instance's harness
//   config/        gates.json (written here by the factory), optional models.json
//   work/          per-issue workspaces (issue-<n>/, review-<branch>/)
//   lessons.md     standing lessons for this repo (note_lesson target)
//
// The core provides harness + server (approvals, sandbox manager, /tasks,
// board, web UI). factoryPipeline() adds the business logic as an extension.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceGatesConfig } from "./gate-policy.ts";
// Both symbols come from the kernel's declared public surface (app/src/core.ts), not internal modules.
import { createCoreInstance, loadConfig } from "../vendor/engram/app/src/core.ts";
import { CONFIG_DIR_ENV, loadFactoryConfig, resolveFactoryConfigPath } from "./factory-config.ts";
import { factoryPipeline, orchestratorInstructions } from "./pipeline.ts";
import { loadRegistry, requireEnabledRepo, scopeOf } from "./repo-registry.ts";
import { assertModelAvailable, defaultMismatchWarning } from "./model-catalog.ts";
import { createGitAuth } from "./github-auth.ts";
import { resolveGitIdentity } from "./git-identity.ts";
import { loadRootEnv } from "./env-file.ts";
import { RefusalBudget } from "./refusal-budget.ts";
import { createNotifier } from "./notify-telegram.ts";
import { syncRootCapabilities } from "./root-capabilities.ts";
import { startParentWatchdog, SUPERVISOR_PID_ENV } from "./parent-watchdog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const args = [...argv];
  const repo = args.shift();
  if (!repo || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
    console.error("usage: node factory/main.ts <owner/repo> [--config path]");
    process.exit(1);
  }
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      configPath = args[++i];
      if (!configPath) { console.error("--config requires a path"); process.exit(1); }
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(1);
    }
  }
  return { repo, configPath };
}

function loadFactoryEnv(): void {
  // Shared with fleet/supervisor.ts (factory/env-file.ts): the two entry points must agree on which
  // .env they applied, or a secret can be visible to one and not the other.
  loadRootEnv();
}

/** Resolve the factory's model ref. "auto" probes the inference endpoint and
 * prefers the currently-loaded model (the old factory's behavior); an explicit
 * id is used as-is. */
async function resolveModelRef(ref: { provider: string; modelId: string }): Promise<{ provider: string; modelId: string }> {
  if (ref.modelId !== "auto") return ref;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!baseUrl) throw new Error("models.modelId=\"auto\" requires OPENAI_BASE_URL in the environment");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET /models failed: ${res.status} — check OPENAI_BASE_URL/OPENAI_API_KEY`);
  const j = (await res.json()) as { data?: Array<{ id: string; loaded?: boolean }> };
  const list = j.data ?? [];
  if (!list.length) throw new Error("endpoint reported no models");
  const m = list.find((x) => x.loaded) ?? list[0];
  console.log(`[factory] resolved auto model: ${m.id}`);
  return { provider: ref.provider, modelId: m.id };
}

async function main() {
  const { repo, configPath } = parseArgs(process.argv.slice(2));
  loadFactoryEnv();

  // The core server requires an API token. A stable one comes from the env
  // (supervisor-provided); otherwise generate a per-boot random one and log it.
  if (!process.env.API_TOKEN) {
    process.env.API_TOKEN = randomBytes(16).toString("hex");
    console.log(`[factory] generated API_TOKEN for this boot: ${process.env.API_TOKEN}`);
  }

  // Repo POLICY (factory/repo-registry.json) is resolved FIRST — before the per-repo runtime config
  // is even read — for two reasons: an unregistered or disabled repo gets a policy explanation rather
  // than a confusing "config file missing" ENOENT, and everything below can trust `policy` instead of
  // re-checking it. Consequences: only registered+enabled repos start at all, and autoMerge:false
  // removes merge_pr from the tool list entirely so honoring it is not something a caller can forget.
  const policy = requireEnabledRepo(loadRegistry(), repo);

  // Runtime config lives outside the repository (factory/factory-config.ts explains why: `testCommand` used to
  // sit inside drydock's own path allowlist). Explicit --config wins; otherwise $DRYDOCK_CONFIG_DIR/
  // <owner>_<repo>.json. Nothing resolves into the source tree.
  const resolvedConfigPath = resolveFactoryConfigPath(repo, { explicit: configPath });
  if (!existsSync(resolvedConfigPath)) {
    console.error(
      `[factory] no runtime config for ${repo} at ${resolvedConfigPath}. Copy factory/config.example.json there ` +
        `(or pass --config <path>). Set ${CONFIG_DIR_ENV} to move the directory.`,
    );
    process.exit(1);
  }
  const factoryCfg = loadFactoryConfig(resolvedConfigPath);
  if (factoryCfg.repo !== repo) {
    console.error(`[factory] config at ${configPath} declares repo ${factoryCfg.repo}, but was started for ${repo}`);
    process.exit(1);
  }
  // FACTORY_INSTANCES_ROOT: gate scripts and tests use isolated per-run roots;
  // production leaves it unset (repo-root factory-instances/).
  const root = join(process.env.FACTORY_INSTANCES_ROOT ?? join(__dirname, "..", "factory-instances"), repo.replace("/", "_"));
  const dataDir = join(root, "engram-data");
  // The instance's OWN config dir under factory-instances/<repo>/ (gates.json, models.json) — not to be
  // confused with $DRYDOCK_CONFIG_DIR, which holds the per-repo runtime config outside the repository.
  const instanceConfigDir = join(root, "config");
  const workRoot = join(root, "work");
  for (const d of [dataDir, instanceConfigDir, workRoot]) mkdirSync(d, { recursive: true });

  // Factory-owned gate policy (see factory/gate-policy.ts for why merge_pr is prompt-tiered
  // and bash declares containment:"sandbox"). Written verbatim from the shared object so the
  // boot test and production cannot drift.
  const gatesPath = join(instanceConfigDir, "gates.json");
  writeFileSync(gatesPath, JSON.stringify(instanceGatesConfig(), null, 2));

  const image = factoryCfg.sandboxImage ?? process.env.FACTORY_SANDBOX_IMAGE ?? "factory-sandbox:latest";
  // Per-instance declarative files (gates.json) are read from the instance config dir —
  // honored since engram #48 (current pin: kernel v0.2.0).
  const config = loadConfig({
    dataDir,
    configDir: instanceConfigDir,
    workRoot,
    sandbox: {
      image,
      network: "none",
      allowImages: [image],
      allowMountRoot: workRoot,
    },
    ...(factoryCfg.approvalTtlHours !== undefined ? { approvalTtlHours: factoryCfg.approvalTtlHours } : {}),
  });

  // Optional per-repo model catalog override for the CORE's own default
  // (config/models.json); the factory pipeline uses the explicit ref from the
  // repo config.
  const modelsPath = join(instanceConfigDir, "models.json");
  const modelsConfig = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : undefined;

  // Resolve the model ref here (not inline) so readiness can be gated on it below.
  const modelRef = await resolveModelRef(factoryCfg.models);

  // Credential posture (#70 / B2) and the App credential itself (B1-rev, queue 3b). One resolver
  // decides, so this line cannot drift from what the tools actually use.
  const gitAuth = createGitAuth(process.env, factoryCfg.gitToken);
  if (gitAuth.kind === "none") {
    console.warn(`[factory] ${repo}: WARNING — ${gitAuth.describe()}`);
  } else {
    console.log(`[factory] ${repo}: ${gitAuth.describe()}`);
  }
  // Prove the App credential before claiming ready (same reasoning as the model-catalog check): a
  // wrong installation id or unreadable key should fail at boot, not 40 minutes into a run. The
  // token itself is discarded — this only demonstrates that an exchange succeeds.
  if (gitAuth.kind === "app") {
    try {
      await gitAuth.token();
      console.log(`[factory] ${repo}: installation token exchange verified`);
    } catch (e) {
      console.error(`[factory] ${repo}: ${gitAuth.describe()} — but the token exchange failed: ${(e as Error).message}`);
      console.error(`[factory] refusing to announce ready on a credential that does not work`);
      process.exit(1);
    }
  }

  // Commit identity (#87 follow-up), resolved with the same derivation worker preparation uses and
  // logged here because "which author will my commits get" is a startup question. Warning rather than
  // exit: a transient API failure should not keep the factory down, and the run-time path fails loudly
  // with the identical message if it still cannot resolve.
  try {
    const identity = await resolveGitIdentity({ token: await gitAuth.token() });
    console.log(`[factory] ${repo}: commit identity: ${identity.name} <${identity.email}>`);
  } catch (e) {
    console.warn(`[factory] ${repo}: WARNING — commit identity unresolved; runs will fault before pushing. ${(e as Error).message}`);
  }

  // Retry budget (#100): one per process, shared with open_draft_pr through the pipeline so a stop is
  // attached to the issue rather than to a tool instance. Terminal events are logged as they happen;
  // the ledger is printed at shutdown, because "how many refusals did this instance absorb" used to be
  // answerable only by reading the durable store (that is how #99's six cycles were found).
  const refusalBudget = new RefusalBudget({ log: (m) => console.warn(`[factory] ${repo}: refusal budget — ${m}`) });

  // Operator notification (#64): deployment-level, not repo policy — who to tell, not what is allowed. It is
  // absent rather than no-oping when unconfigured, so "notifications disabled" stays a state in the log
  // instead of a function that quietly did nothing.
  const notifier = createNotifier({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    log: (line) => console.log(`[factory] ${repo}: ${line}`),
  });
  console.log(
    notifier
      ? `[factory] ${repo}: telegram notifications on (chat ${String(process.env.TELEGRAM_CHAT_ID).slice(-6)}) — draft PRs, stopped runs and refinement briefs`
      : `[factory] ${repo}: notifications disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be told when a draft PR opens or a run stops`,
  );

  const pipelineOpts = {
    refusalBudget,
    workDir: workRoot,
    fixturesRepo: factoryCfg.repo,
    autoMerge: policy.autoMerge,
    requireVerification: policy.requireVerification,
    // Refinement (#65) is registry policy like the two above, so the tool exists exactly when the route
    // accepts a refinement trigger — no drift between "what can start this" and "what can it then do".
    refine: policy.refine,
    notify: notifier,
    pathScope: scopeOf(policy),
    gitAuth,
    modelRef,
    image,
    testCommand: factoryCfg.testCommand,
    setupCommand: factoryCfg.setupCommand,
    wallSecsPerIssue: factoryCfg.budgets.wallSecsPerIssue,
    lessonsFile: factoryCfg.lessonsFile ?? join(root, "lessons.md"),
    sandboxPolicy: { allowImages: [image], mountRoot: workRoot },
  };
  const ext = factoryPipeline(pipelineOpts);
  const rootToolNames = [
    "delegate",
    "open_draft_pr",
    "pr_status",
    ...(policy.autoMerge ? ["merge_pr"] : []),
    "note_lesson",
    ...(policy.refine ? ["refine_issue"] : []),
  ] as string[];
  const rootTools = (ext.tools ?? []).filter((t) => rootToolNames.includes(t.name));
  if (!policy.autoMerge) {
    console.log(`[factory] ${repo}: registry policy autoMerge=false — merge_pr is not offered; runs stop at the draft PR for a human to merge`);
  }
  // Refinement posture (#65), stated the same way: what a trigger can and cannot lead to.
  console.log(
    policy.refine
      ? `[factory] ${repo}: refinement enabled — a \`${policy.refineLabel}\` label or \`/refine\` issue comment runs a read-only expansion pass that posts a comment and starts no work`
      : `[factory] ${repo}: refinement disabled — only the eligibility label starts anything`,
  );
  // Verification posture (#61, decision C1) logged the same way: what open_draft_pr will require.
  console.log(
    policy.requireVerification
      ? `[factory] ${repo}: verification required — open_draft_pr runs \`${factoryCfg.testCommand}\` and refuses to push on a non-zero exit`
      : `[factory] ${repo}: WARNING — verification waived by registry policy; draft PRs may be opened with no test run at all`,
  );
  // Retry posture (#100) stated at boot, the same way the merge and verification postures are: what
  // a human needs to know before a run starts, not after it has been retrying for an hour.
  console.log(
    `[factory] ${repo}: refusal budget — a run stops after ${refusalBudget.maxIdentical} identical refusals or ${refusalBudget.maxTotal} total (path-scope refusals are non-retryable by class)`,
  );

  // The root agent's whole configuration, built once because it is asserted twice: at creation (below)
  // and again on the existing conversation after boot (`syncRootCapabilities`). The second assertion is
  // what makes `autoMerge=false` and a newly shipped tool take effect on restart rather than only the one
  // time this instance's database was created.
  const rootAgentChange = {
    instructions: orchestratorInstructions({ autoMerge: policy.autoMerge, refine: policy.refine }),
    tools: rootTools,
    model: { provider: modelRef.provider, modelId: modelRef.modelId },
  };

  createCoreInstance({
    config,
    modelsConfig,
    extraExtensions: [ext],
    port: 0, // ephemeral; the supervisor records actualPort per instance
    // Pin the orchestrator's model explicitly. Without `model`, core.ts falls back to
    // defaultModelRef() = DEFAULT_MODEL env, else whatever OPENAI_BASE_URL reports as *loaded* —
    // which resolved independently of the catalog and silently pointed the root agent at a model that
    // wasn't registered ("unanswered / no_model", 2026-10-30). The repo config's modelId now decides,
    // for the orchestrator as well as for worker/reviewer tasks.
    rootAgent: rootAgentChange,
  }).then(async (instance) => {
    // Check the model against the catalog THIS instance actually built, before announcing readiness.
    // Announcing ready and then settling every task as "unanswered / no_model" is what made a config
    // coupling invisible for a day: the harness waited 25 minutes for an approval that could never
    // exist. Exiting pre-readiness means spawners fail immediately with the reason in their log.
    try {
      const catalog = await assertModelAvailable(modelRef, `http://127.0.0.1:${instance.actualPort}`, process.env.API_TOKEN ?? "");
      const warn = defaultMismatchWarning(modelRef, catalog);
      if (warn) console.warn(`[factory] warning: ${warn}`);
    } catch (e) {
      console.error(`[factory] fatal: ${(e as Error).message}`);
      await instance.close().catch(() => {});
      process.exit(1);
    }

    // Re-assert the root agent's capabilities (#65 live finding). `harness.root()` applies its `agent`
    // options only when the root conversation is CREATED; for an existing root it returns early and the
    // options are discarded without a word. A restarted instance therefore kept whatever tools,
    // instructions and model its root conversation was born with — which is why the live orchestrator,
    // booted with "refinement enabled" logged, replied that `refine_issue` does not exist.
    //
    // Fail closed on a mismatch: an instance whose actual capability set differs from the registry's is
    // exactly the thing this project refuses to run. The error prints both lists, so the difference is
    // visible instead of being inferred later from behavior.
    try {
      const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
      const synced = await syncRootCapabilities({
        conversation: () => instance.harness.conversation(instance.rootConversationId as never, BACKGROUND_CONTEXT),
        change: rootAgentChange,
        expected: rootToolNames,
        ctx: BACKGROUND_CONTEXT,
        log: (line) => console.log(`[factory] ${repo}: ${line}`),
      });
      if (synced.tools.length === 0) {
        throw new Error("root capability sync offered zero tools — an orchestrator with no tools cannot run a task");
      }
    } catch (e) {
      console.error(`[factory] fatal: ${(e as Error).message}`);
      await instance.close().catch(() => {});
      process.exit(1);
    }

    console.log(`[factory] ${repo} ready on http://127.0.0.1:${instance.actualPort}/ (data: ${dataDir})`);

    let keepAlive: NodeJS.Timeout | undefined;
    // Idempotence guard (#127). Without it, a second event — a repeated signal, or the orphan watchdog
    // firing while a graceful close is already running — called `instance.close()` twice against a store
    // whose handles were half-released. Teardown races are exactly the class of bug this repo keeps
    // finding late, so the guard lives here rather than in each caller.
    let closing: Promise<void> | null = null;
    const shutdown = (signal: string) => {
      if (closing) {
        // The operator asked twice; the first close is not progressing in their eyes. Bound it and go.
        console.log(`[factory] ${signal} received while already closing — exiting now`);
        process.exit(1);
      }
      console.log(`[factory] ${signal} — closing ${repo}`);
      // Refusal ledger on the way out (#100): counts by class, and which runs were stopped. Zero
      // refusals prints nothing, so a healthy shutdown stays quiet.
      const ledger = refusalBudget.ledger();
      if (ledger.length > 0) {
        const byClass = new Map<string, number>();
        for (const r of ledger) byClass.set(r.class, (byClass.get(r.class) ?? 0) + 1);
        const parts = [...byClass.entries()].map(([cls, n]) => `${n} ${cls}`).join(", ");
        console.log(`[factory] ${repo}: refusals this process: ${ledger.length} (${parts}); runs stopped: ${refusalBudget.stoppedIssues().join(", ") || "none"}`);
        const stoppedSummary = refusalBudget.summary();
        if (stoppedSummary !== "no runs stopped by the refusal budget") console.log(stoppedSummary);
      }
      if (keepAlive) clearInterval(keepAlive);
      closing = instance
        .close()
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(`[factory] close failed:`, e);
          process.exit(1);
        });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    keepAlive = setInterval(() => {}, 1 << 30);

    // Orphan self-check (#125 → #127). The supervisor cannot clean up after `SIGKILL`, and until deploys
    // stop finishing that way, the child is the only process that can notice it has become unmanaged. An
    // instance at `ppid 1` keeps its HTTP server up and this repo's `agent.sqlite` open while `routes.json`
    // points at a replacement — two harnesses over one durable store.
    //
    // Armed only when FACTORY_SUPERVISOR_PID is present, so a manual foreground run behaves exactly as
    // before. The callback goes through the same `shutdown()` path as a signal: one teardown, guarded.
    let stopWatchdog: () => void = () => {};
    stopWatchdog = startParentWatchdog({
      supervisorPid: process.env[SUPERVISOR_PID_ENV],
      label: `factory ${repo}`,
      // The pipe to the supervisor dies with it, so this instance's own directory carries the record. Without
      // it, an orphaned-and-self-closed instance leaves no trace at all — which is how #125 stayed invisible.
      durableLogPath: join(root, "orphan-events.log"),
      onOrphaned: () => {
        stopWatchdog();
        shutdown("orphaned");
      },
    });

    // Surface unhandled rejections instead of dying silently (parity with the
    // old supervise).
    process.on("unhandledRejection", (e) => console.error(`[factory] unhandled rejection:`, e));
  }).catch((e) => {
    console.error(`[factory] failed to start ${repo}:`, e);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(`[factory] fatal:`, e);
  process.exit(1);
});
