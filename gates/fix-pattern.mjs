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

/**
 * A guard added where the rule lives: a conditional throw inside a domain-path file. This is the third shape a root
 * fix takes, and the classifier missed it on 2026-11-03 — arm B put `if (not an object) throw new TypeError(...)`
 * into `store.validate()`, the one function every call path already goes through, and read as neither root fix nor
 * handler patch. It was verified to close both traps with a single change (`POST /invoices` and `POST /
 * invoices/batch`, suite 125/125), so "the detector cannot see it" is a measurement defect, not a property of the fix.
 *
 * Requires a condition plus a throw in the same added block: an unconditional throw in a domain file is usually a
 * removal or a refactor, and counting that as a guard would rubber-stamp anything.
 */
export function detectsDomainGuard(domainLines) {
  const lines = Array.isArray(domainLines) ? domainLines : String(domainLines ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\+\s*(?:if|for|while)\s*\(/.test(lines[i])) continue;
    // A guard's throw is one to three added lines below its condition in any normal formatting.
    if (lines.slice(i, i + 4).some((l) => /^\+\s*throw\s+new\s+[A-Za-z_$][\w$]*\s*\(/.test(l))) return true;
  }
  return false;
}

/**
 * An existing shared rule, wired into the path that had none — the fourth shape, and the one the classifier could not
 * see on 2026-11-04. Arm A (the *no-lesson* arm) fixed fixture #87 by adding `const BATCH_FIELDS = new Set(["invoices"])`
 * and calling the module's existing `rejectUnknownFields(body, BATCH_FIELDS)` from the batch handler: one rule, now
 * enforced on every path, with the contract updated in README. It read as neither root fix nor handler patch, because
 * every previous root-fix signal requires something **new** to appear — a declared error class, a declared guard,
 * a guard inside a domain file. Reuse is invisible by construction, and reuse is exactly what a codebase that already
 * has the helper should produce.
 *
 * That blind spot is asymmetric in the worst direction: it under-credits the good shape, so G5 can only ever be
 * disappointed by fixes it cannot see, and a lesson encouraging reuse looks like no improvement.
 *
 * Deliberately narrow, because "called some function that sounds validating" is how a rubber stamp is born. Requires
 * BOTH, in the same diff:
 *
 *   - an added call to an identifier named like a rule (`reject…`/`validate…`/`assert…`/`check…`/`enforce…`) that this
 *     diff does **not** declare — so it is pre-existing and shared, not a helper written for the occasion; and
 *   - an added rule set the call consults (`new Set([...])`, or an added constant passed as an argument), which is what
 *     distinguishes "the rule now covers this path" from "we called something validation-ish in a catch".
 *
 * It cannot tell, from a diff alone, whether the newly-covered path is the *right* path. G5 already requires a human to
 * read both arms' diffs; this signal says "look here, this looks structural", not "no need to look".
 */
export function detectsExistingRuleReuse(lines) {
  const text = lines.join("\n");
  const declared = new Set([...text.matchAll(/^\+\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const addsRuleSet = /^\+\s*(?:export\s+)?const\s+[A-Z0-9_]+\s*=\s*new\s+Set\s*\(/m.test(text);
  for (const m of text.matchAll(/^\+\s*.*?\b((?:reject|validate|assert|check|enforce)[A-Za-z0-9_$]*)\s*\(/gm)) {
    const name = m[1];
    if (declared.has(name)) continue; // defined by this diff — that is detectsSharedRule's case
    const passedArgs = /,\s*[A-Z][A-Z0-9_]*\s*\)/.test(m[0]);
    if (addsRuleSet || passedArgs) return { name, evidence: addsRuleSet ? "declared a rule set for it" : "passed an existing rule set" };
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
  const domainGuard = domainChanged && detectsDomainGuard(domainLines);
  const handlerPatchReasons = detectsHandlerPatch(handlerLines);
  const ruleReuse = detectsExistingRuleReuse(allLines);

  return {
    measured,
    rootFix: typedError || Boolean(sharedRule) || domainGuard || Boolean(ruleReuse),
    handlerPatch: handlerPatchReasons.length > 0,
    // Why a verdict was reached — printed by the gate so a reviewer can disagree with the classification instead of
    // having to re-derive it from a diff.
    reasons: {
      rootFix: [
        ...(typedError ? ["a typed error carrying its own status code was added"] : []),
        ...(sharedRule ? [`validation defined once (${sharedRule.name}) and called from ${sharedRule.callSites} places`] : []),
        ...(domainGuard ? ["a conditional guard was added where the rule lives (domain path)"] : []),
        ...(ruleReuse ? [`an existing shared rule (${ruleReuse.name}) was wired into a path that had none — ${ruleReuse.evidence}`] : []),
      ],
      handlerPatch: handlerPatchReasons,
    },
    signals: {
      domainChanged,
      handlerChanged,
      typedError,
      domainGuard,
      sharedRule: sharedRule ? sharedRule.name : null,
      ruleReuse: ruleReuse ? ruleReuse.name : null,
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
