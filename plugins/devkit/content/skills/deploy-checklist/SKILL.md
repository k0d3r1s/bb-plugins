---
name: deploy-checklist
description: Use before shipping to production — readiness check, migration sequencing, rollback triggers.
metadata:
  added: 2026-05-24
  last_reviewed: 2026-05-24
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-24"
  related: [finishing-a-development-branch, ci-github-actions, ci-gitlab-ci, observability-essentials]
  owns: deploy-checklist
---

# Deploy Checklist

`finishing-a-development-branch` gets your work merged. This skill covers the step after: putting that merged change into production without it becoming an incident. The deliverable is a checklist you actually run, plus rollback triggers written _before_ the deploy — because the moment you need them is the moment you can't think clearly.

**Iron rule:** a deploy without a written, numeric rollback trigger isn't a deploy — it's a gamble. Decide what "this is going wrong" looks like _before_ you ship, not while staring at a climbing graph.

## When to use

- You're about to ship a release and want a readiness gate, not vibes.
- The change carries a database migration, a feature flag, or a breaking API change.
- You want rollback criteria agreed and written down before going live.

## Pre-deploy gate

Do not start the deploy until every box is true. A red box is a stop, not a "probably fine."

- [ ] CI green on the exact commit being deployed (not an earlier one).
- [ ] Reviewed and approved; no known critical bug in the release.
- [ ] Migration plan is **backward-compatible** and tested against prod-shaped data (see below).
- [ ] Feature flags created and defaulted **off**; new behavior ships dark.
- [ ] Rollback path verified — you know the exact command/steps and they work.
- [ ] On-call is aware the deploy is happening and who's driving it.

## Deploy

Ship in widening blast radius so a bad change hits the fewest users:

1. **Staging** — deploy, run smoke tests against real key flows, not just "it boots."
2. **Canary** — route a small slice of prod traffic; watch error rate and latency for a defined window (e.g. 10–15 min) before widening.
3. **Full rollout** — proceed only if canary signals held.
4. **Watch the window.** Don't walk away at 100% — the first minutes after full rollout are when load-dependent failures surface.

## Post-deploy

- [ ] Error rate and latency back at (or below) baseline, confirmed on the dashboard — not assumed.
- [ ] Key user flows manually verified once in prod.
- [ ] Changelog / release notes updated; related tickets closed.
- [ ] Flag flip (if the change ships behind one) is its own mini-deploy — repeat the watch window when you turn it on.

## Rollback triggers (write these before you deploy)

State them as numbers tied to the signal, so the call is mechanical under stress:

- Error rate exceeds **X%** over **N minutes** → roll back.
- p95 latency exceeds **Y ms** → roll back.
- A named critical flow (login, checkout, …) fails → roll back immediately, investigate after.

Rolling back is the default safe action, not an admission of failure. If you're debating whether it's bad enough to roll back, it's bad enough — roll back, then diagnose with `debugging` / `root-cause`.

## Migration & breaking-change addenda

- **Database migrations: expand → migrate → contract.** Add new columns/tables (expand) and deploy code that writes both old and new; backfill; only drop the old shape (contract) in a _later_ deploy once nothing reads it. Never couple a destructive schema change with the code change in one irreversible step — that's a deploy you can't roll back.
- **Breaking API change:** version it or dual-serve; notify consumers before, not after. A breaking change with no consumer notice is an outage you scheduled for someone else.

## Anti-patterns

- **No rollback plan** — "we'll figure it out if it breaks" means you'll figure it out slowly, during the outage.
- **Vague "we'll watch it"** with no threshold — nobody knows when to act, so nobody does until customers complain.
- **Friday-afternoon / pre-holiday deploys** of anything non-trivial — you've shipped a problem into the hours with the fewest people awake to fix it.
- **A checklist nobody runs** — copy-pasted, all boxes pre-ticked. A gate you don't honor is decoration.
- **Coupling a destructive migration with the code change** in one step — now the rollback corrupts data, so you can't roll back.
- **Deploying a commit that isn't the one CI passed on** — "it's basically the same" is how an untested change reaches prod.
- **Skipping canary because "it's a small change"** — small changes cause incidents too; the canary is cheap insurance, not ceremony.
