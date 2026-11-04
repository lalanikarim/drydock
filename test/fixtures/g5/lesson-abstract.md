- [2026-11-03] When an API returns the wrong status or an internal error string for client input, fix the rule where the error originates — give the domain error a type that carries its own status, or enforce the check once in a place every path calls. Do not translate errors with instanceof/catch in one request handler: the other paths keep the bug.

<!--
  NEGATIVE CONTROL — not guidance to ship, and not the default since #168.

  This is the text G5 shipped with before it was measured. Kept so the negative result stays re-runnable: pass this
  file to the feedback gate's lesson override against a fresh pair of equivalent trap issues on the fixture repo.

  What it measured (n=1 per arm, delivery verified from arm B's durable store): the lesson reached the worker prompt
  and changed nothing — arm B patched a handler exactly as arm A did. That is why the default in the traps module now
  carries a code shape instead of a principle.

  Note on form: this file must clear the same validator as any real lesson, which scans the WHOLE content for
  source-file references — so these comments cannot spell a filename with its extension. The rule that exists to stop
  lessons naming the repo also governs the notes we keep beside them; write around it rather than weakening it.

  Delete this file only when someone re-measures the abstract arm, at which point this note should be replaced by the
  new result.
-->
