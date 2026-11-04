// Factory-owned approval gate policy, written into every per-repo instance's config/gates.json.
//
// This is the single source of truth: factory/main.ts writes it, factory/pipeline-boot.test.ts
// boots with the same object, and test/gate-policy.test.mjs pins its shape. They had drifted
// before — the boot test carried a destructivePattern matching {"issueNumber":N}, which also
// matches delegate()'s identical arg shape and stalled unattended runs (plan §5.7, Phase 2
// defect (a)). Never add a pattern that matches an arg shape shared by more than one tool.
//
// merge_pr — the only gated tool. Prompt tier: the first call blocks until a human approves its
//   key (D2: no single-use consumption; exactly-once comes from the verified PR state inside the
//   tool, and an approved call re-executes idempotently on crash-retry).
//
// bash — declared `containment: "sandbox"` (kernel v0.2.0, engram#53). Worker bash executes in a
//   sealed Podman sidecar (network=none, workspace-only mount) and `ConversationMeta.sandbox` is
//   precisely the flag that routes it there, so for those conversations the destructive floor is
//   skipped: the container is the protection. This is not "no gate" — an *uncontained*
//   conversation with bash falls back to the prompt tier and stalls (asserted in
//   test/n1-destructive-classification.test.mjs suite D), which is the safe direction, and no
//   conversation we create has bash outside the sidecar: orchestrator tools are
//   delegate/open_draft_pr/merge_pr/note_lesson and the reviewer has no shell. The kernel warns
//   loudly at startup whenever a containment declaration is present (asserted in
//   test/gate-policy.test.mjs), so it can never be enabled silently.
//
// Because this declaration exists, the worker prompt carries NO destructive-guard hygiene rules:
// a missing declaration fails as a visible stall, not as an unsafe run, so prose workarounds
// would only hide whether safety came from the guard or from the model behaving.
export type InstanceGateTier = { tool: string; default?: "prompt"; containment?: "sandbox" };

/**
 * Effect-bearing argument paths for the destructive floor (engram#69, vendored in v0.2.3).
 *
 * The kernel used to run its payload patterns against EVERY string argument of every call, so a call was judged on
 * text that merely described something dangerous. In production that blocked: `write` of a test whose cleanup is
 * `rmSync(dir,{recursive:true})`; `edit` of a file quoting a shell command; `submit_verdict` whose evidence array
 * quoted the exploit the reviewer had just reproduced; `open_draft_pr` whose summary described device-write
 * detection. Destructive keys can never be allow-listed, so each false positive cost a fresh human approval — and
 * the count scaled with how precisely an agent documented risk (18 markers across four stores, 0 destructive
 * effects).
 *
 * Declaring a tool here means the floor judges ONLY the listed arg paths for it. The values are the arguments that
 * carry the effect; prose is not an effect. `[]` means "nothing this call carries can be destructive".
 *
 * What remains enforced for these tools is what actually constrains them: path scope and protected paths (§5.13),
 * draft-only PR creation, the refusal budget, registry-declared capabilities, and — for merging — merge_pr below,
 * which is deliberately NOT narrowed: a merge is the one effect in this factory that cannot be undone by closing a
 * branch, so it keeps both its prompt tier and the full floor.
 */
export type InstanceGatePolicy = { tiers: InstanceGateTier[]; destructiveArgs: Record<string, string[]> };

/** The exact object serialized to each instance's gates.json. */
export function instanceGatesConfig(): InstanceGatePolicy {
  return {
    tiers: [{ tool: "merge_pr" }, { tool: "bash", containment: "sandbox" }],
    destructiveArgs: {
      // Both act on an issue number; the rest of their args are relayed prose (a reviewer's instruction may well
      // quote the payload it is objecting to, which is exactly what blocked #63).
      delegate: ["issueNumber"],
      refine_issue: ["issueNumber"],
      // Pushes the branch derived from this same integer and opens a DRAFT. title/summary are prose; what could
      // ever be pushed is decided by path scope, not by a substring of the PR description.
      open_draft_pr: ["issueNumber"],
      // A verdict is a record of what the reviewer observed, and a review that cannot quote `rm -rf` cannot
      // reject an `rm -rf`. Same for a lesson note. Neither call has any effect outside its own record.
      submit_verdict: [],
      note_lesson: [],
      // Deliberately absent: merge_pr (the one irreversible effect), pr_status, git_diff, and every kernel tool
      // not listed — undeclared means the full floor still applies.
    },
  };
}
