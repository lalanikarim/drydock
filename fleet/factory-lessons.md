# Writing a factory lesson (`note_lesson`) — what actually changes behavior

Date: 2026-11-03. Everything below is measured with G5 (`gates/g5-feedback.mjs`), against the fixture repository, one
worker model per arm. Nothing here is opinion about how models *should* respond; it is what this fleet's worker did.

## The rule that survived measurement

**A lesson needs a structure to imitate, not a policy to agree with.** The shape that worked in both of its forms:

1. name an error type that **carries its own status**, written out as code, and
2. name **one guard** to define once, also as code, whose whole job is to raise that type.

```
class SomeError extends Error { constructor(message) { super(message); this.statusCode = 400; } }

function assertSomething(value, what) {
  if (bad(value)) throw new SomeError(`${what} must …`);
  return value;
}
```

Prose around it is fine. Prose *instead* of it is what failed.

## Evidence (n=1 per arm; the baseline repeated three times)

| trap pair | arm A (no lesson) | arm B: abstract principle | arm B: imitable shape |
|---|---|---|---|
| fixture #62 / #63 | `handlerPatch` | **`handlerPatch`** — no change (#168) | — |
| fixture #71 / #72 | `handlerPatch` | — | **`rootFix`** (PR #74) |
| fixture #71 / #72 (re-run) | `handlerPatch` | — | **`rootFix`** with a *mismatched-surface* recipe (PR #83, #176) |
| fixture #87 / #86 (2026-11-04) | **neither** — and it was the best diff of the run (see below) | — | `handlerPatch`, lesson verified in the prompt. **Run void: base suite red 1/126** |

The last row is kept although it proves nothing, because the two reasons it proved nothing are the operational content:
fixture `main` was failing before either arm started (so "make the suite green" became an unstated task for both arms),
and arm A's fix — wiring the module's *existing* shared rule into the path that lacked one — was invisible to a classifier
whose signals all require new code. Reuse is now a root-fix signal (`detectsExistingRuleReuse`, with both diffs captured as
fixtures); a lesson encouraging reuse in a repo that already has the helper was structurally unable to be credited.

The third row is the one that matters for how to write lessons. The lesson described limits on a value
(`assertWithinRange`, `DomainLimitError`, 422s) while the trap was about request payloads. The worker copied **zero** of
those identifiers and made the structurally same move: it put one conditional guard into `store.validate()`, the
function every call path already goes through, which closed *both* traps with a single change — verified against a
running server (`POST /invoices` and `POST /invoices/batch` both answering with shape wording, suite 125/125). So the
transfer is real at n=1: **structure carries, surface does not need to match.**

## The default follows this rule (#168)

`LESSON_TEXT` in `gates/g5-traps.mjs` — the text arm B gets when no `--lesson-file` is passed — used to be the abstract
principle that the second row of the table above shows changing nothing. It now carries the shape: a typed error with its
own status plus one guard to define once, written on **value limits**, not request payloads.

The mismatched surface is deliberate and is asserted by test. If the default spoke the traps' language, a green run would
be ambiguous between "the rule transferred" and "the worker matched vocabulary from the lesson" — row three exists to
keep that ambiguity out of the default. Re-measuring either form is one flag away:

- abstract negative control: `test/fixtures/g5/lesson-abstract.md` (kept, with its own note; it lost, it is not deleted)
- imitable payload-surface variant: `test/fixtures/g5/lesson-imitable.md`

What a green canonical G5 now claims: the feedback loop delivers a lesson, and that lesson changes what the worker does.
What it never claims: that the factory learns on its own, or anything at n>1. Three data points, one model, one
repository — and every one of them cost a pair of issues.

## What still must not be in a lesson

- **No filename, no symbol from the repository, no issue number.** A lesson that says "in `src/store.mjs` add
  `statusCode`" is the answer to one bug; whether a worker follows instructions is not the feedback loop. Enforced
  mechanically: `validateLessonText()` in `gates/g5-traps.mjs` rejects variants that name a source file, an issue, or a
  trap identifier, and `test/g5-harness.test.mjs` asserts the same of the default text.
- **No claim about scope it can't see.** A lesson is trusted guidance in the prompt; it does not override the issue's
  acceptance criteria, and a worker optimizing for those literal criteria may reasonably rank it second (#168's
  hypothesis 3, still untested).

## Recording one

`note_lesson` writes `- [YYYY-MM-DD] text`, which is the shape `readLessons` passes into the worker prompt verbatim.
Keep it to one entry per lesson and keep the code snippet short enough that it survives being read once. Lessons files
are deployment configuration (`lessonsFile` in the runtime config), not repository files — an empty file reads as "no
lessons" and adds no section at all.

## Measuring it, if you change this advice

`npx tsx gates/g5-feedback.mjs --repo lalanikarim/factory-fixture --issue-a <trap> --issue-b <equivalent-trap>
--lesson-file <path> --keep`. Traps are consumables (each arm's PR moves fixture `main`), arms must be different issues,
and a variant lesson goes through the same validator as the default. Before spending a run, confirm the traps still exist
by **running the service**, and confirm the suite is **green** on that commit: issue titles outlive their fixes (both
historical pairs are closed because merged arms removed the defect from `main`), and a red base silently adds "make the
tests pass" to every arm's task list. Neither failure looks like a measurement problem from the output — they look like
results.

Which issue goes to which arm is a measurement choice, not a free variable. `classifyFixPattern` sees a root fix that
adds a guard in a domain file or declares a shared helper, and is blind to a correct fix that calls an *existing* helper
from one new site. Put the lesson on the trap whose honest fix the instrument can see, say so in the writeup, and read
both diffs by hand instead of accepting the printed verdict. Verdict semantics: an arm whose diff reads as
neither root fix nor handler patch is **inconclusive and fails the run** — since 2026-11-03 the gate can say it does not
know, because it once reported PASSED for exactly that (#176).
