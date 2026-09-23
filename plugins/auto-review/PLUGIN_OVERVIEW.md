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
- Defers rather than drops only when another thread's review is queued or running in the
  same (shared) working tree — never because other threads are merely active, and never
  behind the thread itself. The turn-start cursor is kept and the full review fires when
  the blocking review ends, one deferred thread released per idle (or failure/archive).
  Parked turns are indexed in plugin storage and swept every 5 minutes, so a release whose
  event was missed still happens. A review that fires while another user coding thread is
  running is contention-aware: review, scoped staging, secret scan and commit intact,
  plan-continuation and merge replaced with an instruction to stop and report.
- Injects one review-and-commit turn into the same thread, guarded by a per-thread
  latch (persisted in plugin metadata) so it never reviews its own review turn. When that
  turn commits, it judges from the thread's plan whether work remains and continues any
  genuinely-unfinished planned work instead of halting mid-plan (never inventing work).
- Reviews plans too: fires on `interaction.pending` for a plan approval, holds the
  first presentation back (queues a review-plan turn, then denies the approval), and
  releases the revised plan to the user on its re-presentation.
- Ships enabled (opt-out). Turn it off globally or per project, or skip a single
  thread, with `bb auto-review`.

## Surfaces

- Settings: global `enabled`, default `mergeEligibleMainlines`, default `reviewMode`.
- Per-project overrides and per-thread skip live in the plugin's own storage.
- CLI: `bb auto-review status|show|enable|disable|skip|unskip|reset` (all `--json`).

See `skills/auto-review/SKILL.md` for details.
