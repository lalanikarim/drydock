# AGENTS.md — Working in this repository

This is a **research/documentation repository**, not a code project. The deliverables are markdown reports and one self-contained HTML report under `research/`.

## Conventions

- **Markdown is the source of truth.** `research/*.md` files hold the canonical content; `*.html` files are presentation renderings of the same material. When updating findings, update the `.md` first, then sync the `.html`.
- **Self-contained HTML only.** Reports must not reference external CSS/JS/fonts or remote images — they should render identically offline and in print.
- **Cite everything.** Every non-obvious claim needs a source URL (and a publication date where available). Customer-reported metrics must be labeled "customer-reported" and never presented as universal results.
- **Date-stamp research.** Each report carries a compilation date; refresh the date when content is materially updated.
- **Keep verdicts honest.** Separate verified facts from estimates, and state risks explicitly — including cases where the conclusion is "not feasible yet."

## Testing — a fake proves your assumption, not the API

Four defects were committed green in one week with a passing suite behind each. The pattern never varies: an injected double answered exactly what I assumed the remote would answer.

| defect | what the fake said | what the real thing said |
|---|---|---|
| commit identity from `GET /user` (#98) | 200 + a bot user, for every credential kind | **403** — an App installation token cannot read `/user` without user-read permission |
| enumerated `npm test` (R10, #102) | the list *was* the suite | one suite existed, passed when run directly, and ran in **no CI job at all** |
| webhook delivery sweep (#107, #109) | `page=2` is fine; ids are numbers | **422** — that endpoint rejects `page` and paginates by `Link` cursor; delivery ids are 19 digits and round through `JSON.parse`, so selecting one by id matched nothing |

So, for code that touches anything this repo does not control — the GitHub API, an HTTP endpoint we host, a subprocess contract:

- **Run it once for real before calling it done**, and put that evidence in the PR: a command and its output, not "should work". Cheap forms: one live call from a scratch script, a step in `gates/github-app-check.mjs`, a signed request against the published listener.
- Assert on **observable effects** (a record changed, a header present, a count moved) rather than that a stub was called with arguments.
- Where a fake is unavoidable, make it **hostile in the direction reality is**: refuse what reality refuses (`403` on `/user`, `422` on `page=`), and keep precision-sensitive values as strings end to end.
- A green suite over an assumed contract is a claim about your test, not about production. Corollary for gates that trust an exit code: **verify what the command collected** — "not collected" and "passing" are the same color (R6b, R10).

## Research workflow

1. Search/read primary sources (vendor docs, engineering blogs, GitHub repos) before writing or editing claims.
2. Cross-check numbers against at least one source; prefer official documentation over press coverage.
3. When assessing a technology, map its capabilities to concrete requirements with evidence — not marketing language.

## Git workflow

- Never commit on `main`. Work on feature branches (`feature/…`, `chore/…`) cut from an up-to-date `main`.
- Sign off all commits: `git commit -s -m "…"`.
- Stage only the files you intentionally changed (explicit paths, never `git add -A`).
- Push your branch and let the human open/merge the PR — agents do not merge.

**Verify a merge before deleting anything (learned the hard way, 2026-11-02).** `gh pr merge --admin` returning a
5xx does **not** mean the merge failed — GitHub may have accepted it and be processing asynchronously. Deleting the
head branch of a PR that is not confirmed merged closes the PR **unmerged**, and recovering means re-pushing the
branch, `gh pr reopen`, then clearing a stale "Merge already in progress" state before anything will land. So:

- Confirm outcome by reading state, never by exit code: `gh pr view <n> --json state,mergedAt,mergeCommit`.
- Delete a remote branch only after that says `state=MERGED`, and only when nothing above it points at that branch.
- Never chain a branch delete onto a merge with `&&`/`;` in one shell line — the delete runs on the failure path,
  which is precisely when it does the damage. Same rule as R6/R10: verify what actually happened, not that the
  command returned cleanly.
- If a merge wedges, land it with the verified async API instead of retrying blindly:
  `gh api -X PUT repos/OWNER/REPO/pulls/<n>/merge-async --input <file>` (`--input` takes a **file**, not an inline
  string; `bypass_rules:true`, and only for the bottom-most unmerged layer).

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
- **Never `--delete-branch` a lower layer while a PR above it still points at that branch.** The flag deletes the upper PR's *base*, and GitHub closes the upper PR unmerged. Reopening is refused until the base exists again, so recovery means re-pushing the deleted branch (`git push origin <sha>:refs/heads/<layer-branch>`), then `gh pr reopen`, then `gh pr edit --base main`. Delete each layer's branch only after its own PR merges and nothing above it references it — i.e. delete top-down, merge bottom-up. Observed 2026-11-01 with #102/#103; the web UI does not do this because branch deletion there is a per-merge choice you can decline.
- Run `gh stack sync` after a layer merges. Layers above it are stale until something rebases them, and bases are only retargeted on submit/sync.
- Do not rebase a layer that has unresolved review comments without saying so in the PR — a rebase destroys the "outdated" trail a reviewer uses to find what they already read.
- The factory pipeline is exempt: worker/reviewer branches are single-layer `agent/issue-<n>` refs pushed by the merge gate. Stacks are for work authored outside that pipeline.

**Landing under our branch protection — verified (stack #92, 2026-10-31).** A two-layer self-authored stack landed from the web UI with **zero approvals**: GitHub applies the admin bypass per layer, so the "1 approving review" ruleset does not block a stack. Three behaviors observed while it happened:

- Layers land **sequentially, bottom first** — and merging a lower layer **retargets** the PR above it to `main` on its own (#91's base went from `docs-stacked-pr-convention` to `main` with no intervention).
- Remote branches are deleted on merge. The local stack stays listed by `gh stack view`, marked `merged`; that is bookkeeping, not debris to clean up.
- `unit-suite` was required and green on **each layer independently** — the review bypass did not extend to CI, which is exactly the split we want.

`gh stack merge` states that *"Bypassing merge requirements is not supported for stacks"* — **now tested (stack #151, 2026-11-02), and it is true:**

```console
$ gh stack merge 150 --merge-method merge --yes
Merging #149, #150 into main via merge...
✗ merge failed: At least 1 approving review is required by reviewers with write access.
Stack merges are atomic, so nothing was merged.        ← atomicity held; nothing partially landed

$ gh pr merge 149 --admin --merge
GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API.
```

So a stacked PR cannot be landed with `gh pr merge` at all — not even with `--admin`. The documented path that **does** honor an admin's existing bypass, without weakening branch protection (which remains forbidden):

```bash
# ONE layer per call, BOTTOM-UP: only the bottom-most unmerged PR in a stack may bypass.
gh api -X PUT repos/OWNER/REPO/pulls/<bottom>/merge-async \
  --input '{"merge_method":"merge","bypass_rules":true,"sha":"<head sha of that branch>"}'
# → {"status":"pending","uuid":"…","bypass_rules":true}; poll with `gh pr view <n> --json state,mergedAt`
```

Merging the bottom layer makes GitHub retarget the next PR to `main` on its own (observed: #150's base went from `chore/config-driven-targets` → `main`), and both layers' remote branches were deleted on merge. Repeat per layer. Landing from the web UI still works and remains the default choice; this is the CLI fallback, and it is a **bypass the human already holds**, never an edit to the review requirement itself.
