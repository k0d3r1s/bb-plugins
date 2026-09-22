---
name: root-cause
description: Use when a bug is fixed but you don't know WHY, or the same bug keeps returning. Forces past the symptom to the actual cause.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [debugging]
  owns: root-cause
---

# Root Cause

The `debugging` skill walks you through the four phases of finding a fix. This skill is narrower: given that you have a fix (or a guess that worked), is the cause the actual cause? Or did you patch the symptom and leave the disease?

**Core principle:** a fix is not a root cause. A root cause is the answer to "why was the system in a state where the symptom became possible?"

## When to use

- A test was failing; your change makes it pass. Why was it failing?
- Logs showed an exception. You wrapped it in try/except. Why was it thrown?
- A user reported a bug. You fixed the visible behavior. Why did it happen?
- The same bug keeps coming back in different forms.
- You feel relieved instead of curious about your fix.

## The five whys (deliberately)

For each fix, ask "why?" until you reach something that's either:

1. A genuine design decision (then: is the decision still right?), OR
2. A constraint outside your control (then: how do you protect against it next time?).

The cliché says "five whys" — sometimes it's three, sometimes seven. Stop when the next "why" stops giving new information.

### Example

> **Symptom**: The `/api/orders` endpoint returns 500 on Tuesdays.
> **Fix**: Added a retry loop in the client.
>
> **Why does it 500 on Tuesdays?**
> The order service is overloaded on Tuesdays.
>
> **Why is it overloaded on Tuesdays?**
> The weekly reporting job runs Tuesday at 9am and floods it.
>
> **Why does the reporting job flood the order service?**
> It pulls every order one at a time instead of batch-querying.
>
> **Why does it pull one at a time?**
> It was written before batch-query support existed.
>
> **Why hasn't it been updated?**
> Nobody owns the reporting job.

The fix (retry loop) addressed the symptom. The root cause is the ownership gap → the inefficient query pattern → the periodic flood. The retry loop will mask the problem until something else trips on it.

## Symptom-fix vs root-cause-fix

| Aspect              | Symptom fix                                                        | Root cause fix |
| ------------------- | ------------------------------------------------------------------ | -------------- |
| Time to ship        | Fast                                                               | Slower         |
| Risk of recurrence  | High (often in different shape)                                    | Low            |
| When appropriate    | Production is on fire, ship the bandage now, fix the disease later | Anything else  |
| What you do with it | Open a follow-up ticket for the root cause, with a deadline        | Done           |

**Symptom fixes are valid emergency tools.** They are not valid as the _only_ response. If you ship a symptom fix, name it as such and schedule the root-cause work.

## Red flags that you stopped too early

- "It just works now, I'm not sure why" — keep asking
- "It was a race condition" without identifying the two things racing — keep asking
- "It was a flaky test" — flaky tests have causes. What was the cause?
- The fix is a `try/except` with no specific exception type
- The fix is a `time.sleep()`
- The fix is a feature flag that defaults to "disabled when broken"
- The fix is "added more retries"
- The fix is "increased timeout"

These are all symptom fixes wearing fix clothing. Not necessarily wrong, but acknowledge that the cause is still unknown.

## Defensive depth (once root cause is known)

Once you understand the cause, add defenses at multiple layers:

1. **The cause itself** — fix it where it actually is
2. **The detector** — add an assertion / test / monitor that would catch the cause's reappearance
3. **The graceful degradation** — when the cause recurs despite the fix, fail loudly and safely, not silently and badly

Not every bug needs all three. Critical-path bugs do.

## Anti-patterns

- **Cargo-cult fixing**: applying a fix you've seen work elsewhere without verifying the cause is the same
- **Bisecting commits and stopping at "the commit that introduced it"** — that commit is the trigger; the cause is whatever made that commit dangerous (a missing test, an unclear invariant, an unsafe API)
- **"Probably a race condition"** without identifying which two operations are racing on what shared state
- **Fixing the loudest symptom and leaving the quieter ones** — quiet symptoms become loud symptoms later

## When you genuinely can't find a root cause

Some causes are environmental, external, or intermittent in ways you can't fully control. When investigation is exhausted:

1. Document what you investigated and ruled out
2. Add monitoring/logging that will give you more data next time it happens
3. Implement a sensible graceful-degradation path
4. Note the limitation in the relevant doc / runbook

But: 95% of "no root cause" cases are incomplete investigation. Have you actually asked "why" five times?
