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
  never clears. **On a `deferred` thread this is not an unstick — it cancels.** That phase
  is a normal wait that resolves on its own (see *Shared checkouts*); resetting it throws
  away that turn's pending review and commit.

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

## Shared checkouts

Threads sharing an environment share one working tree, so a review that staged and
committed while another thread was mid-edit could capture a half-written file or commit
work that isn't its own. When a turn ends and a sibling is still running, auto-review
**defers** that turn rather than skipping it: the turn-start cursor is kept, and the review
fires — in full — as soon as the checkout goes quiet. If the thread takes another turn
while deferred, the earlier cursor is carried forward, so one review covers both turns.

Deferred turns are released one at a time, as each sibling goes idle; the released thread
then holds the checkout itself.

If a sibling never goes idle — a long-running turn, or a thread whose idle auto-review never
sees because it is a child, plugin-origin or hidden thread — the turn is still not stranded.
A background sweep runs every 5 minutes and picks up any deferral older than 30 minutes, so
the review fires without needing another thread event. Because the sweep is on a fixed
5-minute clock rather than anchored to each deferral, the real worst case is ~35 minutes,
not exactly 30. The sweep releases at most one turn per checkout per pass, for the same
reason idle-release does. That review is **contention-aware**:
review, fixes, scoped staging and the secret scan all run as normal, and only the two steps
that need an uncontested tree — continuing the plan, and the local merge — are replaced with
an instruction to stop and report what remains. It still commits; the scoped pathspec and the
"skip any file carrying edits you did not make" rule are what keep that safe, and they are
deliberate, not an oversight.

`bb auto-review status` shows a parked turn as phase `deferred`, with how long it has waited
and what will release it. `bb auto-review reset <thread-id>` drops the turn instead — its
review and commit then never run.

## `reason` values in `status`

- `fired` — a review was injected.
- `contended` — a review was injected while another thread was still running in the same
  checkout, after the turn had waited out the defer window. Review, scoped staging and the
  secret scan still ran; continuing the plan and merging were dropped (see *Shared
  checkouts*).
- `sibling-active` — another thread is running in the same checkout. Paired with outcome
  `deferred`, this turn is parked and will be reviewed when the checkout goes quiet. Not a
  skip — nothing is lost.
- `no-authorship` — the agent changed no files this turn.
- `empty-scope` — the files it changed are no longer uncommitted or ahead (e.g. reverted).
- `no-turn-start` — no turn-start cursor was recorded (a missed start event); stood down, fail-safe.
- `disabled` — disabled globally or for this project.
- `skipped` — this thread has a skip flag set.
Outcomes are `fired`, `deferred` (parked, will still run) and `stood-down` (will not run).
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
