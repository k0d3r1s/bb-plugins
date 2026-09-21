---
name: using-k0d3
description: How to use the k0d3 plugin on bb — discover skills with k0d3_find_skills, load them with k0d3_load_skill, and the old Claude-Code name → new invocation mapping. Read this first.
---

# Using k0d3 on bb

k0d3's skill library is **located on demand, not autoloaded**. Only a few skills (this one,
`honest-completion`) are always visible. The rest of the library (~150 skills) is reachable
through two tools, so their descriptions never flood your context.

## The two-step discovery model

1. **Find** — call `k0d3_find_skills({ topic })` with what you're working on (a language,
   framework, tool, or task). It returns ranked `slug: description` lines.
2. **Load** — call `k0d3_load_skill({ slug })` to read the chosen skill's body. For a skill
   that points to a deeper reference doc, call `k0d3_load_skill({ slug, reference })` with the
   reference's bare name.

Do this **before answering a domain/language/tooling question from memory** — if a k0d3 skill
covers it, load the skill and follow it.

## Old Claude-Code names → bb invocation

On Claude Code, k0d3 exposed skills and commands as `Skill(k0d3:<slug>)` and
`/k0d3:...` slash commands. On bb those become:

| Claude Code | bb |
|---|---|
| `Skill(k0d3:go-essentials)` | `k0d3_load_skill({ slug: "go-essentials" })` |
| `Skill(k0d3:skill-discovery)` | `k0d3_find_skills({ topic: "…" })` |
| `/k0d3:review:review-code` | `k0d3_load_skill({ slug: "code-review" })` for the review guidance |

> Note: a calibrated, multi-perspective `bb k0d3 review` command (the equivalent of
> k0d3's Claude-Code review commands) is planned but **not yet available** in this plugin.
> The `auto-review` plugin's `reviewMode: "k0d3"` also drives a k0d3-style review when enabled.

## Notes

- k0d3's Claude-Code **agents** (experts, reviewers, workflow) are reframed as skills here —
  find them the same way (e.g. `k0d3_find_skills({ topic: "go expert" })`).
- If `k0d3_find_skills` returns nothing, broaden the term; it also lists the domain categories
  it covers.
