---
name: incident-response
description: Use when production breaks — calling an alert's severity, running a live incident, or writing the blameless postmortem after the fix lands.
metadata:
  added: 2026-05-24
  last_reviewed: 2026-05-24
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-24"
  related: [debugging, root-cause, observability-essentials, observability-sentry]
  owns: incident-response
---

# Incident Response

`debugging` and `root-cause` find the cause. This skill owns the _process_ wrapped around it: the minutes when production is degraded and the team needs a severity, roles, a communication cadence, and — afterward — a blameless postmortem that converts the outage into a permanent fix.

**Iron rule:** an incident is not over when the symptom stops. It is over when the blameless postmortem ships with action items that have owners and dates.

## When to use

- An alert fired and someone has to decide how loud to be about it.
- Production is degraded or down right now and people are scrambling without roles.
- A customer-visible failure needs a status update and you don't have a cadence.
- The fix landed and you owe a postmortem (do not skip this — it is the point).

## Phase 1 — Triage (first 5 minutes)

Assign a severity first; everything else (who wakes up, how often you update) keys off it. Pick the highest row that matches.

| Sev      | Trigger                                                     | Response                                |
| -------- | ----------------------------------------------------------- | --------------------------------------- |
| **SEV1** | Full outage / data loss / security breach / revenue stopped | Page now, all-hands, exec comms         |
| **SEV2** | Major feature broken, no workaround, many users             | Page on-call, war room, status updates  |
| **SEV3** | Degraded or partial; workaround exists; some users          | Business-hours response, ticket + watch |
| **SEV4** | Minor / cosmetic / single user / internal-only              | Backlog, fix in normal flow             |

Then assign roles — even a two-person incident benefits from naming them, because it stops everyone from doing comms and nobody doing mitigation:

- **Incident Commander (IC)** — owns the incident, makes calls, is _not_ hands-on-keyboard. The IC's job is coordination, not fixing.
- **Comms** — owns status updates to stakeholders/customers so responders aren't interrupted.
- **Responders** — the hands on keyboard investigating and mitigating.

One person can hold two hats on a small incident, but the IC role is never skipped.

## Phase 2 — Communicate

Silence during an incident reads as "nobody is handling this." A boring, regular update beats a perfect one that comes too late.

- **Cadence by severity:** SEV1 every 15–30 min, SEV2 every 30–60 min, SEV3 on state change. Set it explicitly and keep it even when there's "nothing new" — "still investigating, next update HH:MM" is a valid update.
- **Internal vs external:** internal updates carry detail (suspected cause, what's been tried). Customer-facing updates carry impact and ETA only — never speculate on cause publicly, never blame, never commit to a fix time you can't keep.
- **One channel of record.** A dedicated war-room channel is the single source of truth; the timeline is reconstructed from it later, so narrate actions there as you take them.

## Phase 3 — Mitigate

**Stop the bleeding before you find the cause.** Rolling back, failing over, disabling a feature flag, or draining a node restores users faster than diagnosing root cause live — and mitigation is reversible while a half-understood "fix" is not.

- Log every action with a timestamp as you take it: "14:32 rolled back to v2.3.1", "14:40 error rate back to baseline." This _is_ the postmortem timeline.
- Mitigation ≠ resolution. Note clearly when you've mitigated (users OK) vs resolved (cause fixed). Many incidents are safely downgraded to SEV3 once mitigated, then worked normally.
- Confirm resolution against the signal that opened the incident, not a proxy. If error rate triggered it, watch error rate return to baseline — don't declare victory off "looks fine."
- Diagnosis is `debugging`; the underlying cause is `root-cause`. Hand off to them; don't try to do four-phase debugging while also running comms.

## Phase 4 — Postmortem (blameless)

Write it within a couple of days, while memory is fresh. **Blameless means the analysis targets systems and gaps, not people** — "the deploy had no canary stage" not "Sam deployed without checking." People tell the truth when they aren't on trial, and the truth is what makes the fix real.

Structure:

1. **Summary** — what broke, who was affected, how long, severity.
2. **Timeline** — reconstructed from the war-room log: detection → triage → mitigation → resolution, with timestamps.
3. **Root cause** — the actual cause via `root-cause`'s five-whys, not the trigger. The commit that broke it is the trigger; the missing test/unclear invariant/unsafe API that let it merge is the cause.
4. **What went well / what hurt** — detection speed, tooling gaps, comms friction.
5. **Action items** — each with an **owner and a date**. An action item with neither is a wish. Prefer items that add a detector (test/alert) over items that say "be more careful."

## Anti-patterns

- **Blameful postmortems.** They teach people to hide information, which guarantees the next one is worse.
- **No severity rubric** — every incident treated as either a five-alarm fire or a shrug, with no consistency.
- **Postmortem with no owners or dates** on action items — it documents the outage and changes nothing, so the same outage returns.
- **"We'll just monitor it"** as a resolution, with no threshold for what would re-open the incident.
- **Fixing the symptom and closing the incident** without `root-cause` — the trigger is patched, the cause is live, recurrence is scheduled.
- **IC on the keyboard.** When the coordinator is also debugging, comms drop and the incident drifts.
- **Skipping the postmortem because "it's resolved."** Resolution without a postmortem is how the same class of incident happens three times.
