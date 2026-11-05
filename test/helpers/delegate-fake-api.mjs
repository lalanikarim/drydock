// Shared fakes for `delegate`'s guard tests (#141 / #222 / #230).
//
// Extracted from test/delegate-replan-guard.test.mjs because #230 needs the same stubs and two copies of a fake
// that encodes "a refused call must touch nothing" will drift — and then a green suite describes whichever fake
// it happened to load. The hostile-by-design parts are deliberate: everything past the boundary throws, so a
// refusal can only pass by genuinely creating and committing nothing.
export const NOW = () => Date.now();

export const textOf = (result) => result?.output?.[0]?.text ?? "";

/** Ledger state carrying one wall-clock abort and no PR — the exact state drydock#220 was left in. */
export function ledgerAfterOneBudgetAbort(extra = {}) {
  return {
    issues: {
      220: {
        budgetAborts: 1,
        operatorAborts: 0,
        lastAt: NOW() - 60_000,
        lastReason: "wall-clock budget exceeded (2400s)",
        stopped: false,
        ...extra,
      },
    },
  };
}

/** An api stub where everything past the boundary explodes. A test passes only if delegate touches nothing. */
export function beyondBoundaryThrows(calls, { commit = true } = {}) {
  const boom = (name) => {
    calls.push(name);
    throw new Error(`delegate must not ${name} — a refused call creates nothing and commits nothing`);
  };
  return {
    taskId: "task-caller",
    snapshot: async () => {
      calls.push("snapshot");
      throw new Error("snapshot must have been read before this point in the test setup");
    },
    ...(commit ? { commit: async () => boom("commit") } : {}),
    createTask: async () => boom("createTask"),
    waitForTask: async () => boom("waitForTask"),
  };
}

/** A cooperating api over a live ledger object, so assertions can read what the tool actually recorded. */
export function ledgerApi(ledger, { outcome, captureAtCreate, refuseToSpawn = false } = {}) {
  const created = [];
  const settledOutcome = outcome ?? { status: "completed", result: { answer: "done" } };
  return {
    created,
    api: {
      taskId: "task-caller",
      snapshot: async () => ledger,
      commit: async (fn) => fn({ doc: async () => ledger }),
      createTask: async (_def, input) => {
        if (refuseToSpawn) throw new Error("delegate must not spawn a second worker for an issue that is busy");
        created.push(input);
        // Observe the claim while the child exists — the guard is worthless if it is written after the spawn.
        captureAtCreate?.(ledger);
        return "task-child";
      },
      waitForTask: async () => ({ state: { outcome: settledOutcome } }),
    },
  };
}

/** Capture what `delegate` put on stderr — #230's whole claim is that the two authorization paths are
 *  distinguishable in the log, which is only testable if the test can read it. */
export async function captureLogs(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}
