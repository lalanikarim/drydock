/**
 * Fix-pattern classification for G5 (#145) — property-based, not spelling-based.
 *
 * The old detector asked: "did `this.statusCode = 4\d\d` appear in src/store.mjs?" That matched one historical fix
 * (issue #19's `UnknownStatusError`) and nothing else, so a genuinely correct fix — validation enforced once in a
 * shared place, which is what the lesson *should* encourage — could not satisfy it. Same failure class as the
 * `if (issueNumber === N)` blocks G2 used to have, just moved from issue number to file-and-field.
 *
 * So this asks about structure instead:
 *
 *   handlerPatch — a status was attached where the error was *caught*: `instanceof`, a new `catch`, or an
 *                 `Object.assign(…, { statusCode })` in a handler-layer file. The client-facing symptom is fixed for
 *                 one call path and every other path keeps the old behavior.
 *   rootFix      — the domain gained the knowledge: a typed error carrying its own status, or validation defined once
 *                 and called from more than one place in the same diff. Independent of which file it landed in,
 *                 because "domain layer" is a role, not a path.
 *
 * Both can be true of one diff (a fix that does the right thing and still patches a handler); G5 reports both
 * rather than collapsing them, because "improved, still inconsistent" is a real result and pretending otherwise
 * hides half of it.
 *
 * Every rule here is exercised against **real captured diffs** in `test/g5-harness.test.mjs`: commit 7bdb147 (the
 * historical handler patch), 33ac879 (the historical typed-error fix), and PR #57 (shared validation). If a matcher
 * is wrong, one of those tests goes red instead of the gate reporting a confident fiction.
 */

/** Content lines a diff adds ('+'), excluding file headers. */
export function addedLines(diffText) {
  return String(diffText ?? "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}

/** Files touched by a unified diff, with the lines each one added. */
export function changedFiles(diffText) {
  const out = new Map();
  let current = null;
  for (const line of String(diffText ?? "").split("\n")) {
    const m = /^\+\+\+ b\/(.*)$/.exec(line);
    if (m) {
      current = m[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (/^--- /.test(line) || /^diff --git/.test(line) || /^index /.test(line) || /^@@/.test(line)) continue;
    if (current && line.startsWith("+") && !line.startsWith("+++")) out.get(current).push(line);
  }
  return out;
}

function matchesAny(lines, patterns) {
  return patterns.some((p) => {
    const re = p instanceof RegExp ? p : new RegExp(p);
    return lines.some((l) => re.test(l));
  });
}

/**
 * A typed error that carries its own client status: `class X extends Error` plus a status assignment, in the same
 * diff. This is the shape a lesson should produce — the knowledge travels with the error, so every call path gets
 * it for free.
 */
export function detectsTypedError(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
  // Scan forward from each newly declared Error subclass rather than searching the whole diff: a class that carries
  // its status is the signal, and a diff that happens to contain both an unrelated class and an unrelated assignment
  // must not produce it.
  const declares = /^\+\s*(?:export\s+)?class\s+\w+\s+extends\s+(?:\w*\.)?Error\b/;
  // Any spelling the codebase uses — literal (`this.statusCode = 400`) or passed through (`this.status = status`, as
  // src/retry.mjs's HttpError does), on its own line or inline in a one-line constructor. Null/undefined excluded so
  // a class that only declares the slot doesn't count.
  const carries = /\bthis\.(?:statusCode|status)\s*=\s*(?!\s*(?:null|undefined)\b)(?:\d{3}\b|[A-Za-z_$][\w$.]*)/;
  for (let i = 0; i < list.length; i++) {
    if (!declares.test(list[i])) continue;
    // A constructor body is short; 25 added lines is generous without reaching into the next declaration.
    if (list.slice(i, i + 25).some((l) => carries.test(l))) return true;
  }
  return false;
}

/**
 * Validation defined once and used from more than one place in the same diff — the "shared rule" fix. Counted by
 * call sites of a newly added function/method, so it does not care whether the file is called store.mjs or
 * invoices.mjs.
 */
export function detectsSharedRule(lines) {
  const text = lines.join("\n");
  const decl = /\+\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of text.matchAll(decl)) {
    const name = m[1];
    const calls = [...text.matchAll(new RegExp(`(?<![.\\w])${name}\\s*\\(`, "g"))].length;
    // One declaration + at least two uses means the rule lives in one place and both paths go through it.
    if (calls >= 3) return { name, callSites: calls - 1 };
  }
  return null;
}

/** The anti-pattern: status attached where the error was caught, rather than carried by the error. */
export function detectsHandlerPatch(lines) {
  const reasons = [];
  const text = lines.join("\n");
  if (/^\+\s*.*\binstanceof\b/m.test(text)) reasons.push("added an `instanceof` test in the handler layer");
  if (/^\+\s*}?\s*catch\s*\(/m.test(text)) reasons.push("added a `catch` block in the handler layer");
  // `[^)]*` used to stop the scan at the first closing paren, so the common
  // Object.assign(new Error(msg), { statusCode: 400 }) form slipped through and the anti-pattern read as clean.
  if (/\+.*Object\.assign\s*\(.*\b(?:statusCode|status)\s*:/.test(lines.join("\n")))
    reasons.push("attached a status with Object.assign at the call site");
  return reasons;
}

/**
 * Classify one arm's diff against its trap contract.
 *
 * @param {string} diff            unified diff, merge-base..arm-head (content, not transcripts)
 * @param {object} contract        { domainPaths: string[], handlerPaths: string[] } — path prefixes, matched loosely
 */
export function classifyFixPattern(diff, contract = {}) {
  const domainPaths = contract.domainPaths ?? ["src/store.mjs"];
  const handlerPaths = contract.handlerPaths ?? ["src/invoices.mjs", "src/server.mjs"];

  const files = changedFiles(diff);
  const allLines = [...files.values()].flat();
  const measured = allLines.length > 0;

  const linesFor = (prefixes) =>
    [...files.entries()]
      .filter(([path]) => prefixes.some((p) => path === p || path.startsWith(p)))
      .flatMap(([, ls]) => ls);

  const domainLines = linesFor(domainPaths);
  const handlerLines = linesFor(handlerPaths);
  const domainChanged = domainLines.length > 0;
  const handlerChanged = handlerLines.length > 0;

  const typedError = detectsTypedError(allLines);
  const sharedRule = detectsSharedRule(allLines);
  const handlerPatchReasons = detectsHandlerPatch(handlerLines);

  return {
    measured,
    rootFix: typedError || Boolean(sharedRule),
    handlerPatch: handlerPatchReasons.length > 0,
    // Why a verdict was reached — printed by the gate so a reviewer can disagree with the classification instead of
    // having to re-derive it from a diff.
    reasons: {
      rootFix: [
        ...(typedError ? ["a typed error carrying its own status code was added"] : []),
        ...(sharedRule ? [`validation defined once (${sharedRule.name}) and called from ${sharedRule.callSites} places`] : []),
      ],
      handlerPatch: handlerPatchReasons,
    },
    signals: {
      domainChanged,
      handlerChanged,
      typedError,
      sharedRule: sharedRule ? sharedRule.name : null,
      filesTouched: [...files.keys()],
    },
  };
}

/** One line for a log/PR: what was measured and how it read. */
export function formatClassification(c) {
  if (!c.measured) return "NOT MEASURED (empty diff — nothing was produced to compare)";
  const bits = [`rootFix=${c.rootFix}`, `handlerPatch=${c.handlerPatch}`];
  const why = [...c.reasons.rootFix.map((r) => `+${r}`), ...c.reasons.handlerPatch.map((r) => `-${r}`)];
  return why.length ? `${bits.join(" ")} (${why.join("; ")})` : bits.join(" ");
}
