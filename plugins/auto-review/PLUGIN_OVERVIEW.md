# Auto review

Server-side plugin. When an agent changes files during a turn, auto-review runs a
code review, applies fixes, and commits only the paths that turn touched — and, in a
personal worktree, merges the branch into the mainline locally. It replaces provider-
specific Stop hooks with one provider-neutral implementation driven by bb's
`thread.idle` event.

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads only.
- Attributes work strictly to the thread's own timeline (`file-change` rows after the
  turn's start cursor), so a sibling thread's or a human's edits are never claimed.
- Chooses commit / merge from a branch policy keyed on the mainline name and whether
  the thread runs in a dedicated worktree.
- Injects one review-and-commit turn into the same thread, guarded by a per-thread
  latch (persisted in plugin metadata) so it never reviews its own review turn. When that
  turn commits, it judges from the thread's plan whether work remains and continues any
  genuinely-unfinished planned work instead of halting mid-plan (never inventing work).
- Ships enabled (opt-out). Turn it off globally or per project, or skip a single
  thread, with `bb auto-review`.

## Surfaces

- Settings: global `enabled`, default `mergeEligibleMainlines`, default `reviewMode`.
- Per-project overrides and per-thread skip live in the plugin's own storage.
- CLI: `bb auto-review status|show|enable|disable|skip|unskip|reset` (all `--json`).

See `skills/auto-review/SKILL.md` and `docs/configuration.md` for details.
