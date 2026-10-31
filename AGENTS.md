# AGENTS.md — Working in this repository

This is a **research/documentation repository**, not a code project. The deliverables are markdown reports and one self-contained HTML report under `research/`.

## Conventions

- **Markdown is the source of truth.** `research/*.md` files hold the canonical content; `*.html` files are presentation renderings of the same material. When updating findings, update the `.md` first, then sync the `.html`.
- **Self-contained HTML only.** Reports must not reference external CSS/JS/fonts or remote images — they should render identically offline and in print.
- **Cite everything.** Every non-obvious claim needs a source URL (and a publication date where available). Customer-reported metrics must be labeled "customer-reported" and never presented as universal results.
- **Date-stamp research.** Each report carries a compilation date; refresh the date when content is materially updated.
- **Keep verdicts honest.** Separate verified facts from estimates, and state risks explicitly — including cases where the conclusion is "not feasible yet."

## Research workflow

1. Search/read primary sources (vendor docs, engineering blogs, GitHub repos) before writing or editing claims.
2. Cross-check numbers against at least one source; prefer official documentation over press coverage.
3. When assessing a technology, map its capabilities to concrete requirements with evidence — not marketing language.

## Git workflow

- Never commit on `main`. Work on feature branches (`feature/…`, `chore/…`) cut from an up-to-date `main`.
- Sign off all commits: `git commit -s -m "…"`.
- Stage only the files you intentionally changed (explicit paths, never `git add -A`).
- Push your branch and let the human open/merge the PR — agents do not merge.

### Stacked PRs (several changes in flight at once)

Use the official `gh stack` extension (`gh extension install github/gh-stack`). Do **not** hand-roll a stack by cutting several branches off `main` and writing "Blocked by #NN" in the PR body. That is not a stack, and it fails in three specific ways: each layer's diff contains the layers below it (or conflicts with them), nothing on GitHub knows the intended merge order, and every merge leaves the remaining branches stale until someone rebases them by hand.

```bash
gh stack init <bottom-layer>       # layer 1, cut from trunk
#   ...commit one concern...
gh stack add <next-layer>          # layer 2, based on layer 1
#   ...commit...
gh stack push && gh stack submit --auto --open   # one PR per layer, linked as a stack
gh stack view                      # the whole stack: each layer, its PR, its base
gh stack sync                      # after ANY layer merges — rebase what is left above it
```

Rules here:

- **One layer = one committable concern**, and every layer has to leave CI green on its own. A layer that only makes sense together with the next one means the split is wrong.
- Keep stacks to **3–4 layers**. Past that reviewers lose the shape of the change, which was the entire reason for splitting it.
- Bodies stay as in every other PR here — written to a file, never inline or through a heredoc. `gh stack submit --auto` creates drafts with generated titles; then `gh pr edit <n> --body-file <f>` and `gh pr ready <n>` put the real content on them. `--open` skips the draft stage.
- Run `gh stack sync` after a layer merges. Layers above it are stale until something rebases them, and bases are only retargeted on submit/sync.
- Do not rebase a layer that has unresolved review comments without saying so in the PR — a rebase destroys the "outdated" trail a reviewer uses to find what they already read.
- The factory pipeline is exempt: worker/reviewer branches are single-layer `agent/issue-<n>` refs pushed by the merge gate. Stacks are for work authored outside that pipeline.

**Landing under our branch protection — verified (stack #92, 2026-10-31).** A two-layer self-authored stack landed from the web UI with **zero approvals**: GitHub applies the admin bypass per layer, so the "1 approving review" ruleset does not block a stack. Three behaviors observed while it happened:

- Layers land **sequentially, bottom first** — and merging a lower layer **retargets** the PR above it to `main` on its own (#91's base went from `docs-stacked-pr-convention` to `main` with no intervention).
- Remote branches are deleted on merge. The local stack stays listed by `gh stack view`, marked `merged`; that is bookkeeping, not debris to clean up.
- `unit-suite` was required and green on **each layer independently** — the review bypass did not extend to CI, which is exactly the split we want.

`gh stack merge` states that *"Bypassing merge requirements is not supported for stacks"* and has **not** been tested against the admin bypass (it offers no dry run, so testing it means merging). Prefer landing from the UI. If a CLI path does refuse someday, merge layers individually — do **not** answer it by dropping the review requirement.
