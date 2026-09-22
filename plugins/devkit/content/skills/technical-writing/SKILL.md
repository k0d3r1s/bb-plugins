---
name: technical-writing
description: Use when writing engineering docs — a README, runbook, ADR, API reference, or onboarding guide — and you want it read, trusted, and kept current.
metadata:
  added: 2026-05-24
  last_reviewed: 2026-05-24
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-24"
  related: [pr-description, architecture-essentials, commit-writer]
  keywords: [documentation, docs, readme, runbook, adr, api-docs, onboarding-guide]
  owns: documentation
---

# Technical Writing

`pr-description` explains a single change; `commit-writer` explains a single commit. This skill is for the standing documents — the README, runbook, ADR, API reference, onboarding guide — that outlive any one change and that someone reads when they're stuck, paged, or new.

**Iron rule:** docs state present-tense _what + why_ — never provenance, history, or migration phases. A doc is a description of how the system works now and why it's that way, not a changelog of how it got here. And a doc that has drifted from reality is worse than no doc: it actively misleads someone who trusts it.

## Principles

1. **Write for the reader, not the author.** Name who reads this and what they need from it. A runbook is read at 3am by someone who didn't write the system — write for that person.
2. **Lede first.** The most useful sentence goes at the top. Don't make the reader scroll past context to reach the answer.
3. **Show, don't tell.** A copy-pasteable command, a real request/response, a concrete example beats a paragraph describing it.
4. **Keep it current or delete it.** Stale docs erode trust in _all_ docs. If you can't keep a section true, cut it.
5. **Link, don't duplicate.** Two copies of a fact means one is wrong soon. Reference the canonical source.

## Doc-type shapes

Pick the shape that matches the job; each answers a different question.

| Type           | Reader's question                       | Must contain                                                          |
| -------------- | --------------------------------------- | --------------------------------------------------------------------- |
| **README**     | "What is this and how do I start?"      | What it is + why it exists; quick-start to first success in < 5 min   |
| **Runbook**    | "It's on fire — what do I do?"          | When to use it, prereqs/access, numbered steps, rollback, escalation  |
| **ADR**        | "Why is it built this way?"             | Context, the decision, alternatives rejected, consequences            |
| **API doc**    | "How do I call this?"                   | Request/response examples, errors, auth, pagination/rate limits       |
| **Onboarding** | "I'm new — how does this fit together?" | Env setup, key systems + how they connect, first tasks, who owns what |

### README

Lead with one sentence: what this is and the problem it solves. Then the shortest path to a working result — the quick-start. Configuration, full usage, and contributing come _after_ the reader has seen it work. If first success takes more than five minutes of reading, the quick-start is too long.

### Runbook

Written for the responder, not the expert. State **when this runbook applies** up front (which alert, which symptom), the access/prereqs needed, then numbered steps that don't assume prior context. Always include a rollback path and an escalation path ("if step 4 doesn't resolve it, page X"). Pairs with `incident-response`.

### ADR (Architecture Decision Record)

One decision per record, written when the decision is made. Capture **context** (the forces in play), **the decision** (what you chose, stated plainly), **alternatives** considered and why rejected, and **consequences** (what this makes easier and harder). The value is the rejected alternatives and the trade-off — that's what a future reader can't reconstruct. ADRs are append-only: supersede with a new ADR, don't rewrite the old one. For the decision content itself, see `architecture-essentials`.

### API doc

Every endpoint: a real request and a real response, the error shapes and status codes, how auth works, and pagination/rate-limit behavior. Examples must be copy-pasteable and correct — a wrong example is worse than none. Never paste real tokens or keys; use obvious placeholders.

## Anti-patterns

- **Docs that narrate history** — "originally we used X, then migrated to Y in Q2." The reader needs how it works now and why; the migration belongs in git history, not the doc. (See the present-tense-what-why rule above.)
- **Stale docs left standing** — a confidently wrong doc costs more than a missing one. Delete what you can't maintain.
- **Duplicated content** — the same fact in three docs guarantees two go stale. Link to one canonical source.
- **Buried lede** — the answer on line 60 after setup, rationale, and history. Put it first.
- **Aspirational docs** — describing how it _should_ work, not how it does. Document reality.
- **"We should document this someday" placeholders** — an empty section with a marker promising future content is noise; either write it or omit the section.
- **Wall-of-prose where a table or example fits** — structure is part of the writing, not decoration.
- **AI-tell prose** — throat-clearing openers, business jargon, manufactured drama ("Not X. Y."). Phrase + structure checklist: `references/prose-anti-slop.md`.
