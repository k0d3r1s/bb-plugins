# Auto review

Server-side plugin. When an agent changes files during a turn, auto-review runs a
code review, applies fixes, and commits only the paths that turn touched — and, on a
personal mainline (e.g. `master`), merges the feature branch into it locally, in a
worktree or the primary checkout alike. It replaces provider-specific Stop hooks with
one provider-neutral implementation driven by bb's `thread.idle` event.

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads only.
- Attributes work strictly to the thread's own timeline (`file-change` rows after the
  turn's start cursor), so a sibling thread's or a human's edits are never claimed.
- Chooses commit / merge from a branch policy keyed on the mainline name: a feature
  branch merges into a personal mainline (e.g. `master`) whether the thread runs in a
  dedicated worktree or the primary checkout; a non-personal mainline (e.g. `main`) is
  never a merge target.
- Defers rather than drops when a sibling thread is busy in the same (shared) working
  tree: the turn-start cursor is kept and the full review fires once the checkout goes
  quiet, one deferred thread released per idle. A turn that waits out the 30-minute defer
  window fires a contention-aware review instead — review, scoped staging and the secret
  scan intact, plan-continuation and merge replaced with an instruction to stop and report.
  Parked turns are indexed in plugin storage and swept every 5 minutes, so a turn behind a
  sibling that never goes idle is released on the deadline rather than waiting on an event.
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

See `skills/auto-review/SKILL.md` for details.
