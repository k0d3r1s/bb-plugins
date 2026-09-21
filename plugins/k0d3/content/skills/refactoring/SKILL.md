---
name: refactoring
description: Use when restructuring code without changing behavior — tests green throughout, small steps, frequent commits.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [tdd, debugging, code-review]
  owns: refactoring
---

# Refactoring

Change the structure of code without changing its behavior. Tests stay green throughout.

**Core principle:** if tests aren't green before and after every step, you're not refactoring — you're rewriting (badly).

## The iron law

```
Tests MUST be green at every commit during a refactor.
```

If they're red, you're mid-rewrite, not mid-refactor. Get back to green before continuing.

## Preconditions

1. **Tests exist** and cover the behavior you're preserving. No tests? Write characterization tests first using `Skill(tdd)`. Don't refactor undertested code.
2. **Tests pass** before you start. Baseline. If they don't, that's a different problem.
3. **You have a reason.** Refactor when something needs to change: a new feature is awkward to add, a bug keeps appearing in the same area, the code gets reread often. Not "because it offends me."

## The two-hat rule

You wear one hat at a time:

- **Refactor hat**: structure changes, behavior preserved. Tests don't change (except renames/moves).
- **Feature hat**: behavior changes, tests change with it. Structure stays put.

Never both at once. If you find yourself wanting both, finish the current hat, commit, then switch.

## The cycle

For each refactoring step:

1. **Pick the smallest transformation that moves toward your goal.** Rename, extract function, inline variable, move method. Not "redesign this module" — one node at a time.
2. **Apply it.** Use the IDE refactor tool if available; it's more reliable than hand-editing.
3. **Run the tests.** All of them, not just the ones nearby. If anything went red, **revert the step** and try smaller.
4. **Commit.** Yes, that small. Use `Skill(k0d3:commit-writer)` for the message — extract style from `git log -5 | cat` first. Example subjects (match whatever the repo already uses): `Extracts validateEmail` (imperative-with-s prose), `refactor: extract validateEmail()` (conventional commits), `extract validateEmail()` (bare imperative). Easy to revert.
5. **Loop.**

## Common refactorings (and when)

| Smell                                               | Refactoring                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Function does multiple things                       | Extract function per thing                                              |
| Duplicate code in two places                        | Extract function or move to shared location                             |
| Variable name doesn't match its use                 | Rename                                                                  |
| Long parameter list                                 | Introduce parameter object or split function                            |
| Conditional based on type                           | Replace with polymorphism (cautiously — only if the type set is stable) |
| Big switch statement growing fast                   | Same; replace with strategy map                                         |
| Function reaches across module boundaries for state | Move function closer to the data                                        |
| Same comment repeated above similar code            | Extract function; let the name replace the comment                      |
| Test is hard to write                               | The design is hard to use — refactor the design, not the test           |

## What refactoring is NOT

- **Adding error handling** — that's a feature
- **Adding logging** — feature
- **Changing the algorithm** — feature
- **Optimizing performance** — feature (often)
- **Adding a configuration option** — feature
- **Rewriting from scratch** — that's not refactoring, it's rewriting; different rules apply (write tests first, ship in parallel, switchover)

If you're tempted to do these mid-refactor, **stop**, commit the in-progress refactor, switch hats explicitly, do the feature, then maybe continue refactoring.

## Boundaries

**Refactor within a module before across.** Changes to one file are easy to revert. Changes spanning modules require more discipline.

**Stop before the change set is too big to review.** If the diff would take a senior dev more than 20 minutes to grok, split it. PRs that say "this refactor touches 47 files" are unreviewable.

**Don't refactor and add features in the same PR.** Reviewers can't tell what's behavior-preserving vs new behavior. Two PRs, refactor merges first.

## Common rationalizations

| Excuse                                     | Reality                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| "Tests are slow, I'll run them at the end" | You'll find out you broke something at step 7 and won't know which step did it. Run them every step. |
| "It's just a rename, can't break anything" | Renames break things constantly (string references, reflection, serialized data). Run the tests.     |
| "I'll commit when it's all done"           | When it breaks, you can't revert one step — only everything. Commit per step.                        |
| "This refactor needs a redesign first"     | Fine. Stop refactoring. Do the design work (`Skill(brainstorming)` + `Skill(planning)`). Come back.  |
| "I'll add tests after the refactor"        | If the code isn't tested, you don't know if you preserved behavior. Don't refactor untested code.    |

## Red flags

- Tests red for more than one commit
- "This refactor is huge but trust me" — split it
- Renaming + restructuring + extracting all in one diff
- Refactoring code you don't understand — read it first
- "Let me just clean this up real quick" — that's how unscoped refactors eat days

## When stuck

| Problem                                                 | Solution                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Refactor exposes that two callers want different things | Stop. The design is the problem, not the refactor. Switch hats.                                                    |
| Tests fail in a place you didn't touch                  | You touched something they depend on — read the test, understand the coupling, revert if you can't fix in one step |
| Each step makes the code worse                          | You're going the wrong direction. Revert. Reconsider the goal.                                                     |
| Can't see how to get to the target shape in small steps | You may need a feature change first (e.g., new abstraction) before the refactor is possible. Switch hats.          |
