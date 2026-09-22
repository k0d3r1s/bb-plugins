---
name: auto-review
description: Control bb's automatic post-turn review, commit, and local merge — enable/disable globally or per project, skip a thread, and read why it did or did not fire.
---

# Auto review

Auto-review reviews, commits, and — on a personal mainline (e.g. `master`) — locally merges
the feature branch's changes an agent made during a turn, in a worktree or the primary
checkout alike. It fires on turn end for top-level, git-branch, user coding threads, and
attributes work only to that thread's own edits.

When it commits, the injected turn then judges — from the thread's own plan — whether the
work is actually finished, and continues any genuinely-remaining planned work (reviewing and
committing each further step) rather than halting mid-plan. It never invents work: if the
plan is complete or unclear, it stops and reports done. In the protected-mainline no-commit
case it does not auto-continue.

It ships **enabled** (opt-out).

## CLI

All commands accept `--json`.

- `bb auto-review status` — effective state and last-fire outcome for the current thread
  (enabled, skipped, reviewMode, loop-guard phase, last-fire reason and time).
- `bb auto-review show` — full effective settings for the current project (global
  defaults, project override, resolved values).
- `bb auto-review enable [--global | --project <id>]` — turn it on. **Bare `enable`
  defaults to `--global`** (the kill switch). `--project <id>` (or `--project` inside a
  thread) sets a per-project override.
- `bb auto-review disable [--global | --project <id>]` — turn it off, same scoping rules.
- `bb auto-review skip <thread-id>` — skip auto-review for one thread.
- `bb auto-review unskip <thread-id>` — clear that thread's skip.
- `bb auto-review reset <thread-id>` — clear a wedged loop-guard latch (and skip) for a
  thread whose review never completed. Use this if `status` shows a non-`idle` phase that
  never clears.

## Settings

- **Enabled** — global kill switch (default on).
- **Merge-eligible mainlines** — comma-separated branch names treated as personal
  mainlines a feature branch may be merged into locally, in a worktree or the primary
  checkout (default `master`).
- **Review mode** — `auto` (review-code workflow if present, else self-review), `devkit`
  (require the devkit review-code workflow), or `self` (always self-review).

Per-project overrides and per-thread skip are stored by the plugin, not in settings.

## Branch policy

| Where the thread runs | eligible mainline (e.g. `master`) | non-eligible mainline (e.g. `main`) |
|---|---|---|
| Worktree, feature branch | review + fixes + commit + local merge | review + fixes + commit |
| Worktree, on the mainline | review + fixes + commit | review + fixes + commit |
| Primary checkout, feature branch | review + fixes + commit + local merge | review + fixes, no commit |
| Primary checkout, on the mainline | review + fixes + commit | review + fixes, no commit |

A feature branch merges into an eligible mainline (e.g. `master`) whether it runs in a dedicated worktree or the primary checkout. When the root mainline is non-eligible (protected, e.g. `main`), auto-review never commits in the primary checkout — on any branch checked out there — so protected-mainline work stays in a dedicated worktree. Merge is local only — auto-review never pushes.

## `reason` values in `status`

- `fired` — a review was injected.
- `no-authorship` — the agent changed no files this turn.
- `empty-scope` — the files it changed are no longer uncommitted or ahead (e.g. reverted).
- `no-turn-start` — no turn-start cursor was recorded (a missed start event); stood down, fail-safe.
- `disabled` — disabled globally or for this project.
- `skipped` — this thread has a skip flag set.
- `sibling-active` — another thread is active in the same environment; stood down to avoid a race.
- `send-failed` — injecting the review turn failed; the latch was cleared.
- `not-a-branch` — the checkout is not on a git branch (detached/unborn/unknown).
- `status-unavailable` — the environment's git status could not be read.

(A thread that is not a top-level user coding thread is filtered out before evaluation and
records no last-fire entry.)

## Undoing an auto-review commit or merge

Auto-review only ever commits and merges **locally** (it never pushes). To undo:

- Undo the last commit but keep the changes staged: `git reset --soft HEAD~1`.
- Undo a local merge that produced a merge commit and was not yet integrated:
  `git reset --hard ORIG_HEAD` (this discards the merge; make sure ORIG_HEAD is the
  pre-merge state you want).
- Inspect what it did first: `bb auto-review status` reports the last-fire decision and
  the paths it scoped; `git log` and `git show HEAD` show the commit itself.
