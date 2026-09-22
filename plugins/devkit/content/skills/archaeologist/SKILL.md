---
name: archaeologist
description: Use when you need to understand WHY code is the way it is — "safe to change?", "who added this?" — via git history.
metadata:
  added: 2026-06-27
  last_reviewed: 2026-06-27
  type: meta
  status: draft
  related: [debugging, root-cause, tooling-git-advanced]
  owns: code-history
---

# Archaeologist

This skill uncovers the WHY behind existing code. Use it when you (or the user) are
looking at code and thinking: "Why was this done this way?", "Is it safe to change
this?", "When was this added and by whom?", "What broke that caused this workaround?",
"What's the history of this file/function/feature?"

Every line of code was written for a reason. When that reason isn't obvious, people
either break it by "fixing" what isn't broken (regressions) or leave it alone out of
fear (cruft). Reconstructing the decision context prevents both — it answers the most
important question in software: **"Why is it like this?"**

Use only read-only git: `git log`, `git blame`, `git show`, `git diff`, `git rev-parse`,
`git rev-list`, `git ls-files`, `git cat-file`. Never run a git write operation; report
what would need to change and let a human or write-enabled tool execute it.

## Investigation process

### Step 1: Git blame

```bash
# Who wrote this and when?
git blame [file] -L [start],[end]
# What was the commit message?
git log --oneline [commit-hash] -1
# What else changed in that commit?
git show --stat [commit-hash]
```

### Step 2: Commit archaeology

```bash
# Full history of this file
git log --follow --oneline [file]
# When was this specific code added?
git log -S "[search string]" --oneline
# What did the code look like before this change?
git show [commit-hash]^:[file]
```

### Step 3: Context reconstruction

For each significant change found:

1. Read the commit message — does it explain the WHY?
2. Read the diff — what was BEFORE vs AFTER?
3. Check for related commits on the same day — part of a larger change?
4. Look for issue/PR references in commit messages (#123, JIRA-456)
5. Check if there are comments in the code explaining the change

### Step 4: Pattern recognition

- **Workaround**: code working around a bug/limitation. Signs: "workaround", "hack",
  "temporary" comments, defensive null checks, try/catch around simple operations.
- **Optimization**: made complex for performance. Signs: caching, memoization, batching,
  denormalization.
- **Backward compatibility**: kept for old consumers. Signs: deprecated annotations, dual
  code paths, feature flags.
- **Copy-paste inheritance**: duplicated from elsewhere. Signs: similar structure across
  files, comments referencing other files.
- **Defensive coding**: protecting against known bad states. Signs: extra validation,
  assertions, guard clauses that seem unnecessary.

## Output format

```markdown
## Archaeological Report: [file:function or file:lines]

### Timeline

| Date   | Author | Change         | Reason                              |
| ------ | ------ | -------------- | ----------------------------------- |
| [date] | [who]  | [what changed] | [why, from commit msg or inference] |

### Why It's Like This

[2-3 paragraphs reconstructing the decision context]

**Original intent:** [what the code was supposed to do when first written]
**Evolution:** [how it changed and why]
**Current purpose:** [what it does now — may differ from original intent]

### Is It Safe to Change?

**Verdict:** [SAFE / CAUTION / DANGEROUS]

- [Specific risk 1 — what could break]
- [Specific risk 2 — what depends on this behavior]

### Recommendations

- [What to preserve (and why)]
- [What can safely be modernized]
- [What needs tests before touching]
```

## Rules

- **Always read git history before making conclusions.** Don't guess — investigate.
- **Distinguish fact from inference.** "The commit message says..." vs "Based on the diff,
  it appears..."
- **Respect the original author.** Code that looks "wrong" often had good reasons. Find
  those reasons before judging.
- **Flag Chesterton's Fences.** If code exists and you can't find why, assume there's a
  reason you haven't discovered. Flag it as CAUTION, not SAFE.
- **Don't just report history — provide actionable guidance.** "Is it safe to change?" is
  the question that matters.
- **If git history is unavailable** (no git repo, squashed history), say so and analyze the
  code structurally instead.
