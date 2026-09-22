---
name: cmd-plan
description: Command — Write a comprehensive implementation plan from an approved spec.
---

# /plan

Invokes `Skill(devkit:planning)` against an approved spec to produce a bite-sized implementation plan with file paths, code, tests, and commits.

Argument `[spec-path]` (optional): path to the spec doc to plan from. If omitted, looks for the most recent spec in `docs/specs/`.

After the plan is written and self-reviewed, run a calibrated review before the execution handoff: invoke `/devkit:review-plan <saved-plan-path>` to dispatch the four reviewers, disposition their findings per `references/review-finding-disposition.md`, and apply every valid revision to the plan document. **Then** present the execution options. (The planning skill drives this step; native plan mode reaches the same review via the `review-plan-before-exit` hook.)

Output: a reviewed plan saved to `docs/plans/YYYY-MM-DD-<feature-name>.md` and a prompt to execute via `Skill(subagent-driven-development)` (recommended) or inline.

## Arguments

`[spec-path]`
