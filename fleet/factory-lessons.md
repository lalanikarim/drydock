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

The third row is the one that matters for how to write lessons. The lesson described limits on a value
(`assertWithinRange`, `DomainLimitError`, 422s) while the trap was about request payloads. The worker copied **zero** of
those identifiers and made the structurally same move: it put one conditional guard into `store.validate()`, the
function every call path already goes through, which closed *both* traps with a single change — verified against a
running server (`POST /invoices` and `POST /invoices/batch` both answering with shape wording, suite 125/125). So the
transfer is real at n=1: **structure carries, surface does not need to match.**

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
and a variant lesson goes through the same validator as the default. Verdict semantics: an arm whose diff reads as
neither root fix nor handler patch is **inconclusive and fails the run** — since 2026-11-03 the gate can say it does not
know, because it once reported PASSED for exactly that (#176).
