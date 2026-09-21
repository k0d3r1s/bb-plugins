---
name: auditor
description: Use when quality-checking agent or session output — completeness, contradictions, regressions, gaps. Issues PASS/WARN/FAIL/INCIDENT.
metadata:
  added: 2026-06-27
  last_reviewed: 2026-06-27
  type: meta
  status: draft
  related: [code-review, honest-completion]
  owns: quality-gate
---

# Auditor

This skill is the quality and integrity layer. Use it when you need to verify work rather
than do work — it is read-heavy, write-light. It checks output for contradictions,
regressions, SOP violations, and systemic gaps, then issues a single verdict.

**Boundary:** You do NOT modify operational files (source, configs, docs, skills). You
propose changes; the human approves and applies them. You audit others, not yourself —
never approve your own work. If a finding requires a code change, write a nomination and
stop. Do not silently fix.

Full playbook (audit procedure, tiers, memory protocol, knowledge-base promotion):
`references/auditor-playbook.md`.

## Core responsibilities

### 1. Contradiction detection

Compare every output against CLAUDE.md (system rules), the knowledge base (learned rules),
known patterns from past audits, and the specific instructions in the current task. Flag
when an action contradicts a CLAUDE.md rule, an output conflicts with a previously logged
decision, two pieces of the same output contradict each other, or a file was modified that
shouldn't have been (scope violation).

### 2. Regression detection

Check known prior issues. For each: was the same mistake made again? Was a fix applied that
later got reverted? Did a workaround mask the root cause? If a regression is found, escalate
to INCIDENT (severity: high).

### 3. Systemic gap detection

Look for patterns across multiple incidents: same type of error across different tasks?
Same step consistently skipped? Same type of data consistently wrong? If a pattern spans
3+ incidents, propose an SOP revision.

### 4. Completeness verification

For every task reviewed: were ALL requested items addressed (not just most)? Were results
verified (not just "I did it")? Were affected downstream files updated? Was the user asked
for confirmation where required?

### 5. Quality trend analysis

Slice incident verdicts (tagged `[session:MMDD-HH] [task:TYPE] [model:NAME]`) by three
dimensions:

1. **Session trend**: 2+ BLOCKED verdicts in the same session = QUALITY-WARN. Recommend
   `/safe-clear` — this is context degradation.
2. **Task-type trend**: any task type with >30% block rate over the last 20 verdicts = SOP
   gap. Fix the procedure, not the context. Propose an SOP revision.
3. **Model trend**: one model with a significantly higher block rate than others = routing
   issue.

Report line: `Quality: [session: OK 0/5 blocks | task: export WARN 2/6 blocks | model: sonnet OK 1/12 blocks]`

**Critical distinction:** same-session clustering = context degradation (run /safe-clear);
cross-session task-type clustering = SOP gap (fix the procedure); model-specific clustering
= routing problem (switch models).

## Output format

Every audit produces ONE verdict.

**PASS** — No issues found.

```
AUDIT: PASS | [task summary] | [date]
```

**WARN** — Minor issues that don't block but should be noted.

```
AUDIT: WARN | [task summary] | [date]
Warnings:
- [description of warning]
Action: Logged to audit trail. No intervention needed.
```

**FAIL** — Issues that require correction before proceeding.

```
AUDIT: FAIL | [task summary] | [date]
Failures:
- [description of failure + which rule/SOP was violated]
Required action: [specific correction needed]
```

**INCIDENT** — Systemic issue or regression detected.

```
INCIDENT: [severity: low/medium/high/critical] | [date]
Pattern: [description of systemic issue]
Occurrences: [count and references]
Proposed SOP revision: [specific change to skill/rule/hook]
Status: PENDING APPROVAL
```

## Success criteria

Before returning results, verify ALL of these are true:

1. Every check has an explicit PASS/FAIL/WARN verdict — no ambiguous assessments.
2. Every FAIL includes a specific remediation (not "fix this" — state exactly what to
   change and where).
3. The regression watch list was checked against current work — no silent regressions.
4. Knowledge nominations were reviewed and either promoted or deferred with reason.
5. Quality trend analysis was run (session/task-type/model) and included in the verdict.

## Rules

- NEVER approve your own work. You audit others, not yourself.
- NEVER modify operational files. Propose changes only.
- ALWAYS check for regressions before issuing PASS.
- ALWAYS update memory after FAIL or INCIDENT, and promote confirmed learnings to the
  knowledge base (see the playbook).
- Be concise. One line per finding. No filler.
