---
name: frontend-tailwind
description: Use when working with Tailwind CSS — utility-first patterns, v4 CSS-first config, arbitrary values, plugins, `@apply` pitfalls.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [frontend-design-essentials, frontend-daisyui, frontend-shadcn-ui, react]
  keywords: [frontends]
---

# Tailwind

**Iron Law: utility-first. No `@apply` outside design tokens. Tailwind v4 config in CSS, not JS.**

Each class does one thing, predictably. Composing them in JSX trades CSS authoring for a constrained vocabulary that's hard to misuse.

## When it fits

| Fits                                     | Doesn't                                              |
| ---------------------------------------- | ---------------------------------------------------- |
| Component-driven (React/Vue/Svelte)      | Long-form content — use `@tailwindcss/typography`    |
| Design systems that think in tokens      | Teams allergic to className soup — pick another tool |
| Reviewers want to see style at call site | Policy forces styles into `.css` files               |

## v3 vs v4

| Aspect           | v3                                | v4                                                    |
| ---------------- | --------------------------------- | ----------------------------------------------------- |
| Config           | `tailwind.config.ts` (JS)         | CSS-first: `@theme` in your stylesheet                |
| Engine           | PostCSS plugin                    | Oxide (Rust) — much faster                            |
| Content scan     | `content: [...]` globs            | Automatic                                             |
| Imports          | `@tailwind base/components/utils` | `@import "tailwindcss"`                               |
| Plugins          | JS                                | `@plugin "..."`, JS still works                       |
| Browser baseline | Older                             | Modern only (Safari 16.4+, Chrome 111+, Firefox 128+) |

Starting fresh in 2025 → v4. Maintaining v3 → patterns below still apply, only the config surface changes.

## v4 CSS-first config

```css
@import "tailwindcss";
@theme {
  --color-action: oklch(60% 0.18 250);
  --color-surface: oklch(98% 0 0);
  --font-display: "Inter", system-ui, sans-serif;
  --radius-md: 0.5rem;
  --spacing-card: 1.5rem;
}
```

Anything under `@theme` becomes a CSS variable AND a utility (`bg-action`, `font-display`, `rounded-md`, `p-card`). This is the seam where design tokens become Tailwind utilities — single source. See `Skill(frontend-design-essentials)`.

## Utility-first

Build at the call site. Refactor when reuse appears.

```tsx
<button className="inline-flex h-10 items-center rounded-md bg-action px-4 font-medium text-white hover:bg-action-hover">
  Save
</button>
```

3+ usages → extract a `<Button>` component. Don't extract a CSS class — that fights the model.

## Utility cheatsheet

| Need                 | Class                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| Flex row, centred    | `flex items-center`                                                         |
| Grid 3-col equal     | `grid grid-cols-3 gap-4`                                                    |
| Full-bleed container | `mx-auto max-w-7xl px-4`                                                    |
| Centre absolutely    | `absolute inset-0 m-auto` (or parent `grid place-items-center`)             |
| Truncate one line    | `truncate`                                                                  |
| Sticky header        | `sticky top-0 z-10 bg-surface/80 backdrop-blur`                             |
| Disabled state       | `disabled:opacity-50 disabled:cursor-not-allowed`                           |
| Focus ring (a11y)    | `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action` |
| Arbitrary value      | `top-[117px]`, `bg-[oklch(60%_0.2_30)]` — use sparingly                     |

State variants: `hover:`, `focus-visible:`, `disabled:`, `aria-pressed:`, `data-[state=open]:`, `group-hover:`, `peer-checked:`, `dark:`. Stackable: `md:hover:focus-visible:ring-2`.

## `@apply` — the antipattern

```css
/* tempting, wrong */
.btn {
  @apply inline-flex h-10 rounded-md bg-action px-4 text-white;
}
```

Recreates the problem Tailwind solves: a class that means "look at the CSS to find out". Use only:

- Third-party styles you can't change (e.g. `.prose h2 { @apply ... }`)
- Tiny base layer (`body { @apply bg-surface text-default; }`)

For reuse, write a component, not a class.

## Plugins (v4)

```css
@plugin "@tailwindcss/typography";
@plugin "@tailwindcss/forms";
@plugin "@tailwindcss/container-queries";
```

## Content scanning

v3 globs miss a path → utilities purged. v4 walks the import graph; override with `@source "..."`. **Dynamic class names** (`bg-${color}-500`) are invisible to the scanner — in v3 use the `safelist` config option in `tailwind.config.ts`; in v4 there is no `safelist` config — use `@source inline("bg-red-500 bg-blue-500 bg-green-500")` in your CSS file instead.

## CVA + tailwind-merge

Long className strings → use **class-variance-authority** or **tailwind-variants**.

```ts
const button = cva("inline-flex items-center rounded-md font-medium", {
  variants: { variant: { primary: "bg-action text-white", ghost: "bg-transparent" } },
});
```

Pair with **`tailwind-merge`** so consumer overrides win:

```tsx
import { twMerge } from "tailwind-merge";
className={twMerge(button({ variant }), className)}
```

## Theming

1. **`dark:` variant** — class-based, two themes only. `<html class="dark">` + `bg-white dark:bg-neutral-900`.
2. **Semantic tokens + `@theme`** — define `--color-surface` per theme; never write `dark:` in components. Scales to 3+ themes. **Recommended.**

```css
[data-theme="dark"] {
  --color-surface: oklch(15% 0 0);
}
```

## Shared config

Multiple apps → preset. v3: `presets: [require("./tailwind-preset")]`. v4: `@import "./tailwind-preset.css"`.

## Anti-patterns

- `@apply` to "clean up" templates — re-introduces className-soup one level down
- Custom CSS components for one-off layouts — inline utilities at the call site
- Ignoring purge/scan config — dynamic classes get stripped
- 40-class strings without CVA/variants
- Hard-coded `[]` for repeated tokens — promote to `@theme`
- `dark:` everywhere when semantic tokens would scale
- Shipping components whose overrides silently lose — use `tailwind-merge`

## Red flags

| Thought                          | Reality                                          |
| -------------------------------- | ------------------------------------------------ |
| "I'll `@apply` this for now"     | "For now" = forever. Make a component.           |
| "I'll hardcode `[#3b82f6]` once" | You'll repeat it. Add a `@theme` token.          |
| "v3 is fine"                     | v4's Oxide is 10x+ faster. Migrate when you can. |
| "Dynamic classes are easier"     | Until production build purges them silently.     |

## Hand-off

Tokens, colour, type, variant patterns (CVA), design-system layering: `Skill(frontend-design-essentials)`. Semantic component kits: `Skill(frontend-daisyui)`. Copy-paste primitives on Tailwind: `Skill(frontend-shadcn-ui)`. React patterns: `Skill(react)`.
