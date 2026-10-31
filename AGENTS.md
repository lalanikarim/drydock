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

**Known collision with our branch protection — check before relying on it.** `gh stack merge` documents that *"Bypassing merge requirements is not supported for stacks"*, and GitHub refuses self-approval. Under the current ruleset (1 approving review, admin may bypass) an `gh stack merge` of a self-authored stack may therefore be refused even though the identical PR merges from the web UI through the admin bypass. If that happens, merge the layers individually in the UI — do **not** answer it by removing the review requirement.
