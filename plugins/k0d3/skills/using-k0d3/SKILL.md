---
name: using-k0d3
description: How to use the k0d3 plugin on bb — discover skills with k0d3_find_skills, load them with k0d3_load_skill, and the old Claude-Code name → new invocation mapping. Read this first.
---

# Using k0d3 on bb

k0d3's skill library is **located on demand, not autoloaded**. Only a few skills (this one,
`honest-completion`) are always visible. The rest of the library (~165 skills) is reachable
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
| `/k0d3:review:review-code` | `bb k0d3 review code` (or `k0d3_load_skill({ slug: "review-code" })`) |
| `/k0d3:review:review-impl` | `bb k0d3 review impl <base>..<head>` |
| `/k0d3:review:review-plan` | `bb k0d3 review plan <path>` |
| `/k0d3:experts:go-expert` | `k0d3_load_skill({ slug: "go-expert" })` |

> `bb k0d3 review …` **prints the review workflow instructions for a coding agent to run** —
> it does not produce a report by itself. Run it inside an agent, or load
> `k0d3_load_skill({ slug: "review-code" })` and follow it.

## Other surfaces

- **Docs lookup:** `k0d3_docs({ query })` or `k0d3_docs({ libraryId: "/vercel/next.js" })` —
  current library/framework documentation via Context7.
- **CLI:** `bb k0d3 skills list | find <topic> | show <slug>` to browse the library from a
  shell, and `bb k0d3 review <code|impl <base>..<head>|plan <path>>` to run the calibrated
  multi-perspective review (also driven by the `auto-review` plugin's `reviewMode: "k0d3"`).
- k0d3's Claude-Code **agents** (experts, reviewers, workflow) are reframed as skills here —
  experts are `k0d3_load_skill` slugs; reviewer calibrations load as references
  (`k0d3_load_skill({ reference: "reviewer-senior-dev" })`).

## Notes

- If `k0d3_find_skills` returns nothing, broaden the term; it also lists the domain categories
  it covers.
