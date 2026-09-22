---
name: requirements-gathering
description: Use FIRST when a request is ambiguous or vague — surface what's actually needed via targeted questions, before `brainstorming` assumes the goal is known.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [brainstorming, planning, interview-first, verify-before-asserting]
  owns: requirements
---

# Requirements Gathering

Use this BEFORE brainstorming when the request is too vague to start designing. The goal is to extract enough information that brainstorming has something concrete to chew on.

**Core principle:** the question to ask is the one whose answer would change your approach.

## When to use

- User request is one sentence and could mean three different things ("add notifications", "make it faster", "fix the auth")
- You catch yourself making assumptions about what they want
- Multiple plausible interpretations exist
- You'd build different things depending on the answer

**Skip when:**

- Request is already specific ("rename `validateEmail` to `validateAddress` in `user/auth.ts`")
- User has provided a spec or detailed brief
- You can answer the ambiguity yourself with a quick file read

## The five questions

In order, until you have enough to start design work:

1. **What problem are you actually trying to solve?**
   - "Add notifications" — what are users missing today that notifications would give them?
   - "Make it faster" — slow how? slow when? slow for whom?
   - The answer often reveals the request is solving the wrong problem.

2. **Who is the user, and what are they doing when this matters?**
   - One person who needs it once? Thousands who hit it every day? Different shape entirely.
   - "Notifications" for the operator at 3am ≠ notifications for an end-user on their phone.

3. **What does success look like — concretely?**
   - "When X happens, the user sees Y, and Z is recorded."
   - If you can't write a concrete success scenario, the request isn't ready to build.

4. **What's the smallest thing that would be useful?**
   - Forces them to separate must-have from would-be-nice.
   - Often the answer is much smaller than the original request — and that's the version you should build first.

5. **What's NOT in scope?**
   - "Notifications, but not via email. We're not adding email infrastructure right now."
   - Explicit non-scope prevents both you and the user from sliding into "while we're at it…"

You don't need all five every time. Stop when you can describe what to build in a sentence and the user agrees.

## How to ask

- **One question per message.** Multiple questions overwhelm and dilute answers.
- **Multiple choice when possible.** Open-ended for the first question; multiple-choice once you've narrowed.
- **Echo back** what you heard before asking the next: "So you want X for Y users so they can Z — is that right?" Catches misinterpretation early.
- **Don't propose solutions yet.** That's brainstorming's job. Here you're only gathering requirements.

## Common traps

| Trap                                                          | Symptom                                                                           | Fix                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Assuming the request is literal                               | "Add a notification system" → you start designing a generic notification platform | First question: what notifications, when, for whom?                                                         |
| Asking too many questions                                     | User trails off, gets frustrated                                                  | Cap at 3–5 questions. If still ambiguous, propose a narrow interpretation and ask "should I run with this?" |
| Letting the user describe the solution instead of the problem | "I want a webhook with retries and a queue"                                       | "What event would the webhook deliver, and what would the receiver do with it?"                             |
| Skipping #5 (non-scope)                                       | Scope creeps mid-implementation                                                   | Always ask what's not in scope before committing to a plan                                                  |
| Pretending to understand                                      | You write a design that's subtly wrong because you didn't ask                     | If you'd build a different thing depending on the answer, ask.                                              |

## When you can't ask (async context)

If you're operating in a context where the user can't answer (long-running script, batch job, etc.):

1. List your assumptions explicitly — "I'm assuming X, Y, Z."
2. Propose the narrowest reasonable interpretation.
3. Build to a checkpoint, then surface for confirmation before going further.

Never "just guess" silently. Surface your assumptions; let them be corrected cheaply.

## Output

When you have enough to proceed, summarize in one paragraph:

> **What we're building:** A `<thing>` so that `<user>` can `<outcome>` when `<trigger>`.
> **Success criteria:** `<concrete behavior>`.
> **Out of scope:** `<list>`.

Then hand off to `Skill(brainstorming)`.
