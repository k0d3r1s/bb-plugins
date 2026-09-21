---
name: pr-description
description: Use when opening a pull request — generates a reviewer-focused description covering why, what, how to verify, and what to watch for.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [commit-writer, finishing-a-development-branch, code-review]
  owns: pr-descriptions
---

# PR Description

A PR description is a contract with the reviewer. It tells them what to look at, what to ignore, and how to verify the change works. The diff doesn't do that on its own.

**Core principle:** a senior reviewer should be able to read your PR description (without opening the diff) and know what kind of review this needs.

## Format

```markdown
## Summary

<1–3 bullets: what changed, at a higher level than the diff>

## Why

<2–4 sentences: the problem or motivation>

## How it works

<Optional, for non-trivial changes — point at the key files / approach>

## Test plan

- [ ] <Concrete steps a reviewer can run>
- [ ] <Edge case considered>
- [ ] <Tests added/updated>

## Out of scope

<Optional: things this PR could have touched but deliberately doesn't>

## Notes for reviewers

<Optional: anything subtle, risky, or worth a second look>
```

## Section-by-section

### Summary (always)

1–3 bullets, one sentence each. Imperative or descriptive — match the style of the codebase's existing PRs.

✅ "Add bulk-cancel endpoint to the orders API for operator use."
✅ "Extract token validation into `AuthValidator`; remove duplication between middleware and WebSocket handshake."
❌ "Various changes" / "WIP" / "Updates"

### Why (always for non-trivial PRs)

What problem this PR solves, in 2–4 sentences. Link to the issue if there is one, but don't substitute the link for the explanation — your reviewer shouldn't need to context-switch to understand.

✅ "Operators currently cancel orders one at a time via the admin UI, which becomes untenable when a batch ingest fails and they need to undo 500 orders. This adds a bulk endpoint. Closes #2410."
❌ "Closes #2410." (with no explanation)

### How it works (for non-trivial changes)

Point reviewers at the heart of the change. Reviewers shouldn't have to read every file to know which one is load-bearing.

✅ "The validation logic lives in `api/orders/bulk_cancel.py:42-91`. Cancellations are processed in a single DB transaction; failures roll back the whole batch unless `?partial=true` is passed."

Skip when the diff is small and obvious (a rename, a docs fix).

### Test plan (always)

A checklist the reviewer can actually walk through:

```markdown
- [ ] `pytest tests/orders/test_bulk_cancel.py` — 4 new tests
- [ ] Manual: POST /orders/bulk-cancel with a list of 3 valid IDs → all return cancelled
- [ ] Manual: POST with one invalid ID and `?partial=false` → 400 + no orders cancelled
- [ ] Manual: POST with one invalid ID and `?partial=true` → 207 + 2 cancelled, 1 reported failed
```

Specific commands, specific URLs, specific expected outcomes. "I tested it" is not a test plan.

### Out of scope (when relevant)

Explicitly call out what this PR doesn't do, especially when reviewers might expect it to:

✅ "Out of scope: rate-limit configuration UI. The endpoint is rate-limited at 1000 orders/request, but exposing that limit as a setting is a follow-up (#2412)."

Prevents the "while you're here…" review feedback loop.

### Notes for reviewers (when relevant)

Anything subtle, risky, performance-sensitive, or non-obvious. This is where you flag the parts of the diff that need extra eyes.

✅ "Notes for reviewers: the `partial` flag changes the return code from 200/400 to 207. Check that downstream clients (admin-ui in particular) handle 207."
✅ "Notes for reviewers: the `order_lock_timeout` was bumped from 5s to 30s. Larger batches need it; smaller batches are unaffected but the lock window is wider."

## Length

Match the change. A one-line CSS fix gets a one-paragraph description. A 1500-line schema migration gets a long description with sections. Don't pad either way.

## Common rationalizations

| Excuse                                   | Reality                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "The commits explain it"                 | Reviewers read the PR description first; many never click through commits. Put it in the description. |
| "I'll let the diff speak for itself"     | The diff says what changed; you need to say why.                                                      |
| "Reviewer will ask if they want details" | They will ask, and you'll go back-and-forth for an hour. Front-load the answer.                       |
| "Test plan is in the commits"            | Reviewers want a single checklist to walk through. Make it easy.                                      |

## Anti-patterns

- Empty / one-line PR descriptions on non-trivial changes
- Pasting a stack trace and nothing else — context required
- "Improvements" / "Refactor" / "Cleanup" with no specifics
- Linking to a Slack thread / private doc for the explanation — the PR should be self-contained
- Marketing copy ("this is a huge improvement", "much cleaner") — leave that out, let the diff speak for the quality
- Promises that aren't reflected in the diff ("this also fixes X" — if it does, show the fix)
- **Pasting credentials from the diff into the PR body.** API keys, tokens, connection strings, env-variable VALUES (not names) — never copy these into the description. If the diff contains a secret, the commit itself is the problem; rotate the secret and amend before opening the PR. Reference values by env-variable NAME (e.g., `$DATABASE_URL`, `STRIPE_SECRET_KEY`) in the description.

## CI / hand-off

Many PR templates exist for a reason — if the repo has one, use it. If it doesn't, the format above is a sensible default.

For changelog-driven projects, use `Skill(commit-writer)` for individual commits and let the PR title summarize. Final commit message often becomes the squash-merge subject, so write the commit body well.

## When the change is risky

Add a `## Rollback` section:

```markdown
## Rollback

Revert this PR; no schema migration. Long-running batch cancellations
will fail mid-flight but no data corruption.
```

Reviewers (and oncall) will thank you.

For AI-tell phrases to keep out of the description (throat-clearing, jargon, manufactured drama): `references/prose-anti-slop.md`.
