// Durable standing lessons from prior review findings (Phase 5 — feedback loop),
// ported to TS. File-based on purpose: per-run sqlite databases are wiped
// between battery runs, but lessons must outlive them. The file is host-side
// committed state of the factory process; the orchestrator writes it through
// note_lesson only, and the worker prompt reads it at spawn (trusted section,
// outside <untrusted>).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

/** Current lessons document ("" when absent/empty). */
export function readLessons(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The reviewer's view of the same lessons document (#168, hypothesis 2).
 *
 * The worker has read standing lessons since Phase 5; nothing downstream ever did. That asymmetry is the whole reason a
 * recorded lesson can be ignored with no consequence: the reviewer's rubric never mentioned them, so a fix that patched a
 * symptom and left the rule unprotected elsewhere passed review in every measured arm — including the run where the lesson
 * was verifiably present in the worker's prompt. This is the enforcing half.
 *
 * Two rules are load-bearing and deliberately asymmetric:
 *  - "the same defect is still reachable from another caller" is an unmet requirement, not a style opinion → fail;
 *  - "there is a better shape for this" is a concern on a pass → never a fail.
 * Without the second rule, adding lessons to a rubric converts a reviewer into a style cop that fails arbitrary diffs,
 * which is worse than not measuring anything. Citing verbatim (and only from the text above) keeps the model from
 * inventing authority — the failure mode a "trusted guidance" section invites.
 */
export const REVIEW_LESSONS_CAP_BYTES = 4096;

export function reviewerLessonsSection(lessons: string): string {
  const body = String(lessons ?? "").trim();
  if (body.length === 0) return "";
  const bytes = new TextEncoder().encode(body).length;
  const clipped =
    bytes > REVIEW_LESSONS_CAP_BYTES
      ? `${body.slice(0, REVIEW_LESSONS_CAP_BYTES)}\n…[lessons truncated at ${REVIEW_LESSONS_CAP_BYTES} bytes so a growing file cannot crowd the diff out of the review prompt]`
      : body;
  return [
    "Standing factory lessons from prior review findings (trusted guidance — they do not override the issue's acceptance criteria):",
    "",
    clipped,
    "",
    "How to weigh these lessons while reviewing:",
    "- A lesson names a rule and where that rule belongs. If the diff fixes only the path the issue happens to name and the same defect stays reachable from another caller, the issue is NOT satisfied: verdict \"fail\", and quote the relevant lesson line verbatim in `concerns` so the rework says which rule was left unprotected.",
    "- If the acceptance criteria are met and a lesson merely suggests a better shape, that is a concern recorded on a pass — never a fail. A lesson is not a style policy.",
    "- Never cite a lesson that is not present verbatim above. You may not invent, paraphrase-attribute, or imply guidance you cannot quote.",
  ].join("\n");
}

/** Orchestrator-facing tool: record one standing lesson distilled from a review
 *  finding. Idempotent — an identical line is not appended twice. */
export function noteLessonTool(file: string) {
  return defineTool({
    name: "note_lesson",
    description:
      "Record ONE standing lesson distilled from a review finding, so future worker runs avoid the same mistake. The lesson is one imperative sentence (it may mention the issue number). It is appended durably to the factory's lessons document, which every future worker reads before starting.",
    parameters: Type.Object({
      lesson: Type.String(),
    }),
    replay: "unsafe", // file append; deduplicated by identical line
    execute: async ({ lesson }) => {
      const text = String(lesson).trim().replace(/\s+/g, " ");
      if (!text) return { output: [{ type: "text" as const, text: JSON.stringify({ error: "lesson must be non-empty" }) }], isError: true };
      mkdirSync(dirname(file), { recursive: true });
      const line = `- [${new Date().toISOString().slice(0, 10)}] ${text}`;
      const existing = readLessons(file);
      if (existing.split("\n").some((l) => l.trim() === line.trim())) {
        return { output: [{ type: "text" as const, text: JSON.stringify({ recorded: false, reason: "identical lesson already recorded" }) }] };
      }
      appendFileSync(file, (existing ? "\n" : "") + line + "\n");
      return { output: [{ type: "text" as const, text: JSON.stringify({ recorded: true, line }) }] };
    },
  });
}
