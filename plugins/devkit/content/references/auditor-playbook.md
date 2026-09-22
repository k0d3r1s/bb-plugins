# Auditor Playbook

Long-form companion to the `auditor` skill. Covers the audit procedure, tiers, the
self-improvement (memory) protocol, and the knowledge-base promotion protocol. The skill
body holds the persona, core responsibilities, output verdicts, and rules.

## Audit procedure

1. Read prior audit memory (known patterns and past issues). **If empty, skip regression checks.**
2. Read the knowledge base. **If empty, skip — nothing to enforce yet.**
3. Read the audit log (last 20 entries) for recent context.
4. Examine the work product being audited.
5. **Select tier** based on scope (T1-T4):
   - T1: Quick scan — obvious issues only (daily)
   - T2: Standard review — completeness + consistency (after features/tasks)
   - T3: Deep review — regression check + knowledge sweep (weekly)
   - T4: Full infrastructure audit — cross-file coherence + via negativa (monthly)
6. Cross-reference against CLAUDE.md and the knowledge base.
7. Produce verdict.
8. Append to the audit log.
9. If FAIL or INCIDENT: append to the incident log + identify one adjacent vulnerability
   (antifragile response).
10. If WARN that could have been FAIL: log as **NEAR-MISS** in the incident log.
11. If a new pattern is detected: update audit memory.
12. If a regression is detected: escalate severity and update audit memory.
13. **Review knowledge nominations** — promote valid ones, discard stale ones.
14. **Knowledge base promotion** (see below).
15. If T4 audit: run a **via negativa scan** — flag rules that have never triggered for
    DEPRECATION review.

## Write boundary

Writes are restricted to the auditor's own bookkeeping:

- `.claude/agent-memory/auditor/*` — audit memory
- `.claude/logs/audit-trail.md` — append-only audit log
- `.claude/logs/incident-log.md` — append-only incident log
- `.claude/knowledge-nominations.md` — append-only nominations

Any other write target — source code, configs, docs, skills, agents, commands — is
forbidden. Propose; humans (or write-enabled agents) execute.

## Self-improvement protocol

Audit memory is institutional knowledge. Maintain it as:

```markdown
# Auditor Memory

## Known Patterns

- [pattern]: [how it manifests] | [first seen: date] | [count: N]

## Resolved Patterns

- [pattern]: [resolution] | [resolved: date]

## SOP Revisions Proposed

- [revision]: [status: pending/approved/rejected] | [date]

## Regression Watch List

- [issue]: [originally fixed: date] | [last checked: date]
```

When memory exceeds 150 lines, curate it:

- Move resolved patterns older than 30 days to a `resolved-archive.md` file.
- Merge similar patterns into single entries.
- Remove watch-list items that haven't recurred in 30 days.

## Knowledge base promotion protocol

The knowledge base (`.claude/knowledge-base.md`) is the system-wide memory that ALL agents
read. The auditor is the ONLY writer. This is how the system learns.

### When to promote

A learning gets promoted when ALL of these are true:

1. It has been confirmed through at least one audit cycle (not speculative).
2. It applies broadly — to a category of work, not just one task.
3. It prevents a concrete error — not just "nice to know."

### Consolidation checks (before every write)

1. **Dedup**: Does this fact already exist? Merge or strengthen the existing entry.
2. **Contradiction**: Does it contradict an existing entry? Resolve using the provenance
   hierarchy (user override > empirical > agent inference).
3. **Subsumption**: Specific case of a general rule? Add as a note to the existing entry.
4. **Provenance tag**: `(Source: [user override | empirical | agent inference] — [how confirmed])`

### What goes where

| Type                                         | Goes to               | Example                                            |
| -------------------------------------------- | --------------------- | -------------------------------------------------- |
| Error pattern still being tracked            | Audit memory          | "API rate limit hit at 100 req/min — watching"     |
| Confirmed rule that prevents recurring error | **knowledge-base.md** | "Always check rate limits before batch operations" |
| One-off mistake, already fixed               | Audit memory only     | "Typo in config — corrected"                       |
| Tool behaviour discovered                    | **knowledge-base.md** | "npm ci is faster than npm install in CI"          |

### Promotion format

```
- [MMDDYY] [Category]: [Concise fact or rule] (Source: [how confirmed])
```

### Curation (includes staleness review)

During each audit, review the knowledge base for:

- Entries now outdated — remove.
- Contradictions — resolve using the provenance hierarchy.
- Over 200 lines — curate (merge, archive stale entries).
- **Staleness**: entries older than 90 days unreferenced — flag for review.
