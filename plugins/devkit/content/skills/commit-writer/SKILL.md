---
name: commit-writer
description: Use when writing a git commit message — extract style from git log first. Subjects are imperative; bodies explain WHY, not WHAT.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [pr-description, finishing-a-development-branch]
  owns: commits
---

# Commit Writer

**NEVER invent a commit style. ALWAYS match the existing one.** Run `git log -5 | cat` first; copy what you see. A repo with imperative "Adds X" / "Refines Y" subjects gets the same — do not introduce `feat:` or `fix:` prefixes. A repo using conventional commits gets conventional commits. A repo with one-line subjects and no bodies gets the same minimalism — until a change earns more — provided those subjects are specific; a lone `init` or other bare generic placeholder is not a style to copy (see the fallback below).

**Core principle:** a future engineer reading `git log` should understand the intent without reading the diff. The diff already shows _what_ — the message says _why_.

## Secrets check (before anything else)

Before drafting any commit message, scan staged content for credentials. Use two greps — one for high-confidence platform prefixes (no false positives), one for generic substrings (some false positives, manually triage):

```bash
# High-confidence: platform-specific token prefixes. Any match here is almost always real.
git diff --cached | grep -iE 'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}|sk-(live|test|proj)[_-][A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|glpat-[A-Za-z0-9_-]{20}|gldt-[A-Za-z0-9_-]{20}|AKIA[0-9A-Z]{16}|xox[bpsar]-[A-Za-z0-9-]{20,}|eyJhbGci[A-Za-z0-9+/=]{50,}|"private_key":[[:space:]]*"-----BEGIN'

# Generic: substrings that often (but not always) indicate credential values. Manual triage.
git diff --cached | grep -iE '\b(api[_-]?key|secret|password|token|private[_-]?key|bearer|basic[[:space:]]+auth)\b[[:space:]]*[:=]'

# Connection-string passwords in URLs
git diff --cached | grep -E '://[^:[:space:]]+:[^@[:space:]]+@'
```

If the high-confidence grep returns anything, STOP unconditionally — these prefixes are not legitimate substrings in non-secret content. Tell the user a credential is staged, identify the file, and let them unstage / scrub.

If the generic grep matches, triage: an env-variable NAME (`STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY`) is fine; a literal value (`STRIPE_SECRET_KEY=sk_live_abc...`) is not. When in doubt, STOP and ask.

If a credential reaches a commit that's already been pushed to a remote, `git commit --amend` + force-push is INSUFFICIENT — the reflog and any forks retain it. Use `git filter-repo` (or BFG) plus rotation of the leaked credential via the platform's revoke-and-reissue flow.

## Iron rule: extract style first

Before drafting any commit message:

```bash
git log -5 | cat            # full recent messages — see subject + body shape
git log --oneline -20       # subject patterns at a glance
```

Extract and use:

- **Verb form**: imperative ("Add"), imperative-with-s ("Adds"), past tense ("Added"), or prefix ("feat:"). Pick whichever the repo already uses.
- **Capitalization**: sentence case vs. lowercase first word vs. all-lowercase. Match.
- **Subject length**: roughly 50–72 chars; some repos run shorter or longer. Match.
- **Body shape**: prose paragraphs, bullet lists, or no body at all. Match.
- **Co-author / footer style**: only include footers the repo already uses. Solo work without prior co-author tags gets no co-author tag.

If the repo has **zero commits** (true fresh `git init`) — or, after ignoring housekeeping (version bumps, merge/squash commits), every sampled subject is a **bare generic placeholder** that names nothing specific (a lone `init` / `Initial commit`, `wip`, `update`, `stuff` standing alone, or a lone verb like `add` / `create` with no object; illustrative, not exhaustive) — fall back to imperative-present-with-s ("Adds X") + prose body. A single vague commit is not a style: don't copy its genericity, and don't introduce conventional-commits prefixes as a default — they are a project-wide editorial decision, not a sensible default. Match a short, no-body style only when its subjects are _specific_ (e.g. "Fix off-by-one in pagination cursor"); the bare placeholders above are the anti-patterns below, not a convention. If the sample holds _any_ specific subject, that is the style — learn from it, not from the noise.

## Format (after extracting)

```
<subject — matches repo style, ≤72 chars, no trailing period>

<body — wraps ~80 chars, explains WHY; omit for truly trivial changes>

<footer — only if repo uses one: BREAKING CHANGE, Refs, Co-authored-by>
```

## Subject line rules

- ≤ 72 characters (some repos prefer ≤ 50; match)
- Imperative or imperative-with-s mood — never future tense
- No trailing period
- Specific: "Fixes off-by-one in pagination cursor" beats "Fixes bug"
- Match the repo's first-word capitalization

## Body rules

Wrap around 80 characters (some repos run tighter; match). Use prose paragraphs unless the repo uses bullets. Cover:

- **Why** the change was needed (the problem or motivation)
- **What** the change does, at a higher level than the diff
- **Why this approach** rather than alternatives, if non-obvious
- **Trade-offs** if any

Skip the body for truly trivial changes (single-line typo, version bump). Most "tiny" changes aren't actually trivial; default to a body.

## Examples — by repo style

**Imperative-with-s, prose body (e.g., this repo + the toolkit repo):**

```
Adds plan mode support to review commands

Detects plan mode at command start and switches behavior: validation is
read-only, findings append to the active plan file instead of triggering
edits. Preserves the existing flow when plan mode is inactive.
```

**Imperative, no prefix, no body (small repos):**

```
Fix off-by-one in pagination cursor
```

**Conventional commits (only if the repo already uses them):**

```
fix(pagination): off-by-one in next-page cursor

The cursor was being incremented before the page was returned, so
clients always got page N+1 when requesting page N. Move the
increment to after the response is constructed.

Closes: #2341
```

## Anti-patterns

- **Invented prefix.** Adding `feat:` to a repo whose history is `Adds X` / `Refines Y` is style fragmentation. Do not introduce a new convention; ask the user first if you think the repo should switch.
- **Empty body on a non-trivial change** — write the why.
- **Vague subject** — "Fixes bug", "Updates stuff", "WIP", "Final commit", or a bare placeholder standing alone (`init`, `add`, `update`). Do not _learn_ a style from these either — see the zero-/low-signal fallback above.
- **Mixed concerns in one commit** — "Fix bug and add feature and rename X". Split.
- **Co-author tag on solo work** — only when there was an actual collaborator.
- **Future tense** — "Will add X". Use imperative present.
- **Capital letters and punctuation in subject for repos that don't use them** — match the repo's casing.

## When working with a series

For a feature branch with many commits:

- **Commit per logical unit** — not "commit per save". Each commit should be reviewable and revertable on its own.
- **20–25 files maximum per commit** — split larger changesets into focused commits for reviewability and bisect.
- **Squash before merge** when intermediates are noise (typos, WIP fixes); preserve when they're a useful series.
- **The merge commit** (or final squashed commit) gets the long-form body. Intermediate commits can be shorter.

## Red flags (stop and re-read the repo's history)

- About to type `feat:` or `fix:` without confirming the repo uses conventional commits → re-run `git log --oneline -20`
- About to write a body in bullet form when the repo uses prose → match prose
- About to add `Co-Authored-By:` on a solo change → check if the repo has any prior co-author tags; if not, drop it
- About to invent a new "style" because the user said "make it better" → ask them first
- About to copy the style of a lone `init` (or other bare placeholder) commit → that is not a style; use the fallback default

## Hand-off

Often the final commit on a branch becomes the PR description's "Summary" section. Use `Skill(pr-description)` to expand it.

For AI-tell phrases to keep out of the body (throat-clearing, jargon, manufactured drama): `references/prose-anti-slop.md`.
