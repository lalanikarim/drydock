// Refusal classification and retry budget (#100).
//
// The incident: issue #99 was a README-only task that required registering a test file in
// `package.json`, which is outside drydock's path allowlist. `open_draft_pr` refused — correctly —
// and the orchestrator re-delegated. **Six full worker+review cycles ran and every one ended in the
// identical refusal**, stopped only by hand. Three separate layers behaved; the composition was an
// unbounded retry loop (recorded as R11).
//
// So this module answers two questions the tool result used to leave implicit:
//
//   1. **Can this ever succeed?** A path-scope refusal will not change during a run — policy is read
//      at process start and lives in a file the run cannot write. Verification and review refusals
//      are genuinely fixable, so they stay retryable. Infrastructure refusals (a diff basis that
//      could not be computed) are neither: they are retried freely and never counted, because
//      counting them would let a transient fault consume the budget of a real task.
//   2. **Should this run try again at all?** Even a retryable refusal stops being worth its cost once
//      it repeats identically — an identical red test run means nothing changed between attempts. And
//      because a flailing worker can vary its offender set to dodge an identical-signature cap, there
//      is a second, absolute ceiling per issue.
//
// Scope and honesty about it: the budget lives in memory for the life of one factory instance
// process. A restart clears it — deliberately, since restarting is a human act and a durable stop
// state would outlive the operator's intent. Cross-restart dispatch dedupe is a separate mechanism
// (intake's `requestId`), not this.

export type RefusalClass = "path_scope" | "verification" | "review" | "infrastructure";

export interface RefusalSignal {
  class: RefusalClass;
  /** Refused paths, for a path-scope refusal. Order-insensitive in the signature. */
  offenders?: readonly { file: string; why?: string }[];
  /** Short reason; normalized into the signature for the non-path classes. */
  reason?: string;
}

export interface RefusalRecord {
  issueNumber: number;
  class: RefusalClass;
  signature: string;
  /** How many times *this signature* has been seen for this issue. 0 means "not counted" (infrastructure). */
  count: number;
  /** Total counted refusals for this issue, any signature. 0 for infrastructure. */
  total: number;
  retryable: boolean;
  /** True when the run must stop: further attempts are refused without doing any work. */
  terminal: boolean;
  /** Why it stopped, when terminal — wording meant for both the model and a human reading the log. */
  stopReason?: string;
  reason?: string;
}

/** Whitespace-collapsed, bounded reason text. Identical means identical, so normalization stays
 *  minimal: only what varies between two renderings of the same failure (wrapping, trailing output). */
export function normalizeReason(reason = ""): string {
  return String(reason).replace(/\s+/g, " ").trim().slice(0, 400);
}

/** A signature is identity for counting purposes: same signature ⇒ a retry would produce the same
 *  refusal from the same state. */
export function refusalSignature(signal: RefusalSignal): string {
  if (signal.class === "path_scope") {
    const files = [...new Set((signal.offenders ?? []).map((o) => o.file))].sort();
    return `path_scope:${files.join(",")}`;
  }
  if (signal.class === "infrastructure") return "infrastructure:not-counted";
  return `${signal.class}:${normalizeReason(signal.reason)}`;
}

/** Is a retry plausibly informative? Path scope is policy, and policy does not move mid-run. */
export function isRetryable(signal: RefusalSignal): boolean {
  return signal.class !== "path_scope";
}

export interface RefusalBudgetOptions {
  /** Stop the run once this many *identical* refusals have been seen for one issue. Default 2 —
   *  one refusal tells the orchestrator what went wrong, the second proves it did not listen. */
  maxIdentical?: number;
  /** Absolute ceiling per issue across all signatures, so varying offenders cannot dodge the cap.
   *  Default 4. Set higher only with a reason. */
  maxTotal?: number;
  /** Sink for terminal events (the run summary surface). Defaults to console.warn. */
  log?: (message: string) => void;
}

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return value;
}

export class RefusalBudget {
  readonly maxIdentical: number;
  readonly maxTotal: number;
  private readonly log: (message: string) => void;
  private readonly counts = new Map<string, number>();
  private readonly totals = new Map<number, number>();
  private readonly stops = new Map<number, RefusalRecord>();
  private readonly entries: RefusalRecord[] = [];

  constructor({ maxIdentical = 2, maxTotal = 4, log = (m) => console.warn(m) }: RefusalBudgetOptions = {}) {
    this.maxIdentical = assertPositiveInt("maxIdentical", maxIdentical);
    this.maxTotal = assertPositiveInt("maxTotal", maxTotal);
    this.log = log;
  }

  /** True once this issue's run has been stopped. Checked at the top of open_draft_pr so a stopped
   *  run costs no clone, no test command and no reviewer inference. */
  isStopped(issueNumber: number): boolean {
    return this.stops.has(issueNumber);
  }

  stopRecord(issueNumber: number): RefusalRecord | undefined {
    return this.stops.get(issueNumber);
  }

  /** Issues whose runs this process has stopped — the run-summary surface #100 asked for. */
  stoppedIssues(): number[] {
    return [...this.stops.keys()];
  }

  /** Every refusal seen, in order, including infrastructure ones (which are recorded but not
   *  counted) — an operator reading this should see the whole picture, not only the failures that
   *  were charged to a budget. */
  ledger(): readonly RefusalRecord[] {
    return [...this.entries];
  }

  /** Record one refusal and decide whether the run continues. */
  note(issueNumber: number, signal: RefusalSignal): RefusalRecord {
    const signature = refusalSignature(signal);
    const retryable = isRetryable(signal);
    const counted = signal.class !== "infrastructure";

    if (!counted) {
      const record: RefusalRecord = { issueNumber, class: signal.class, signature, count: 0, total: this.totals.get(issueNumber) ?? 0, retryable: true, terminal: false, reason: normalizeReason(signal.reason) };
      this.entries.push(record);
      return record;
    }

    // A stopped run does not accumulate further counts; the short-circuit path reports the original
    // stop reason, and inflating numbers after the fact would misreport what happened.
    const alreadyStopped = this.stops.get(issueNumber);
    if (alreadyStopped) return alreadyStopped;

    // Counts are per issue *and* per signature. A global signature count would let one issue's
    // failures stop a different issue's run — which the first draft of this file did, and the
    // "budgets are per issue" check caught.
    const key = `${issueNumber}|${signature}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    const total = (this.totals.get(issueNumber) ?? 0) + 1;
    this.totals.set(issueNumber, total);

    let terminal = false;
    let stopReason: string | undefined;
    if (count >= this.maxIdentical) {
      terminal = true;
      stopReason =
        `stopped after ${count} identical ${signal.class} refusals (same signature: ${signature}). ` +
        `A retry from the same state produces the same refusal, so further attempts cost inference and change nothing.`;
    } else if (total >= this.maxTotal) {
      terminal = true;
      stopReason =
        `stopped after ${total} refusals on this issue (no single signature reached ${this.maxIdentical}). ` +
        `Varying the offender set is not a path to success: the repo's policy is fixed for the life of this process.`;
    }

    const record: RefusalRecord = {
      issueNumber,
      class: signal.class,
      signature,
      count,
      total,
      retryable,
      terminal,
      ...(stopReason ? { stopReason } : {}),
      reason: normalizeReason(signal.reason),
    };

    if (terminal) {
      this.stops.set(issueNumber, record);
      this.log(`issue #${issueNumber}: ${stopReason}`);
    }
    this.entries.push(record);
    return record;
  }

  /** One line per issue that has been stopped — for a boot/shutdown summary or an operator log. */
  summary(): string {
    const stopped = this.stoppedIssues();
    if (stopped.length === 0) return "no runs stopped by the refusal budget";
    return stopped
      .map((n) => `issue #${n}: ${this.stops.get(n)!.stopReason ?? "stopped"}`)
      .join("\n");
  }
}

/** The payload a stopped run gets back. Kept as a function so the short-circuit path and the
 *  refusal path describe a stop identically. */
export function terminalRefusalPayload(record: RefusalRecord): Record<string, unknown> {
  return {
    refused: true,
    terminal: true,
    retryable: false,
    runStopped: true,
    reason: record.stopReason ?? "run stopped by the refusal budget",
    attempts: record.total,
    identicalAttempts: record.count,
    class: record.class,
    hint:
      "Do not re-delegate this task and do not call open_draft_pr again for it: the answer will be this same payload. " +
      "Report to the human that the task is unsatisfiable under this repo's current policy, naming the offending paths, " +
      "and that a person can widen factory/repo-registry.json's pathAllowlist (or rewrite the issue) if the task is wanted.",
  };
}
