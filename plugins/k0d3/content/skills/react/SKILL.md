---
name: react
description: Use when writing React — hooks, composition, performance, RSC boundary, testing.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [react, typescript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [typescript, ts-zod, ts-vite, ts-vitest, frontend-design-essentials, tdd]
  keywords: [typescript, frontend, frontends, spa, ssr, next, server-action]
---

# React

**Iron Law: composition over configuration. Many small components, not one with 20 boolean props. In RSC frameworks (Next.js App Router, Remix v2+), server components by default; client only when interactive. In a Vite SPA, every component is a client component. Test what the user sees (role/label/text), not implementation.**

**Versions:** LTS `18.3` · Current `19` · Next `19.x` — _RSC stable; Actions + `useActionState`; `use()` for promises/contexts; `ref` is a regular prop (no more `forwardRef`); `<Context>` shorthand without `.Provider`._

## Hook decision tree

| Need                                        | Use                                | Don't                                            |
| ------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Local state                                 | `useState`                         | `useEffect` to sync external sources you control |
| State derivable from props/state            | compute in render or `useMemo`     | `useEffect` + `setState`                         |
| Reset state when prop changes               | `key={prop}` on the component      | `useEffect(() => setX(...), [prop])`             |
| Non-trivial state machine                   | `useReducer` + discriminated union | sprawling `useState` calls                       |
| Sync with external system (DOM, sub, timer) | `useEffect` with cleanup           | run-once init logic                              |
| Stable identity across renders              | `useRef`                           | extra state that triggers renders                |
| Reusable stateful logic across components   | custom hook (`useX`)               | copy-paste, render-prop indirection              |
| Mark update as non-urgent                   | `useTransition`                    | manual `setTimeout` scheduling                   |
| Subscribe to external store                 | `useSyncExternalStore`             | `useState` + `useEffect` polling                 |

## Rules of hooks (non-negotiable)

1. Top-level only. No loops, conditions, nested functions.
2. Only from React functions (components or other hooks).
3. Names start with `use` — enables the lint rule.

Enable `eslint-plugin-react-hooks` (`rules-of-hooks` + `exhaustive-deps`). Both non-negotiable.

## useEffect: only for synchronization

Effects are for **synchronizing with external systems** (DOM, network, subscriptions, timers). If the answer is derivable from props/state, **don't use an effect** — compute in render.

```tsx
useEffect(() => {
  const ctrl = new AbortController();
  fetch(`/users/${id}`, { signal: ctrl.signal })
    .then((r) => r.json())
    .then(setUser);
  return () => ctrl.abort();
}, [id]);
```

For async inside effects, wrap an inner IIFE with a cancellation flag — `useEffect`'s return must be sync cleanup.

## Composition over configuration

```tsx
// Config explosion — every new layout adds a prop
<Modal title="x" hasCloseButton showFooter footerLeftText="Cancel" />

// Composition — extensible without changing Modal
<Modal>
  <Modal.Header>x</Modal.Header>
  <Modal.Body>...</Modal.Body>
  <Modal.Footer><Button>Cancel</Button></Modal.Footer>
</Modal>
```

| Prop API rule                                    | Apply when                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `children: ReactNode` first                      | Default — try this before inventing named slots                    |
| Named slots (`header`, `sidebar` as `ReactNode`) | When `children` isn't enough                                       |
| Compound components (`Tabs.Tab`, `Tabs.Panel`)   | Related pieces under one namespace                                 |
| `as` polymorphic prop                            | Sparingly — types get hairy fast                                   |
| Two components instead of one with a boolean     | Whenever the boolean changes "what it is", not just "how it looks" |

## State location

| Where                                      | When                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Locally (`useState` in leaf)               | Default — most state                                                                                     |
| Lifted to common parent                    | Two siblings need to read or set it                                                                      |
| Context                                    | Genuinely tree-global (theme, locale, current user) AND many depths read it AND intermediates don't care |
| Server state library (TanStack Query, SWR) | Network-derived data with caching                                                                        |
| Reducer + context (or Zustand/Jotai)       | Complex shared state with many actions                                                                   |

**Prop drilling is fine for 2-3 levels** — explicit, traceable, type-checked. Reach for context only when it stops being. **Context pitfalls:** every consumer re-renders on value change. Memoize the value or split contexts (state vs setters). Context is a transport, not state management.

## Performance — profile first

Most React apps are fast enough. Verify with the **DevTools Profiler** before optimizing. Re-rendering is cheap when output is small.

| Use                                        | When                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `React.memo`                               | Profiler shows wasted child re-renders AND parent passes stable refs               |
| `useMemo`                                  | Measurably expensive compute, OR result is a hook dep, OR passed to `memo`'d child |
| `useCallback`                              | Passed to `memo`'d child as a prop, OR is a hook dep                               |
| Push state down                            | State at root re-renders huge subtree — local it to the leaf                       |
| `children` slot                            | Parent's state changes don't re-render children passed in from above               |
| `useTransition`                            | Update is OK to be interrupted (filter, search)                                    |
| `react-window` / `@tanstack/react-virtual` | List has >500 visible rows                                                         |
| `lazy` + `Suspense`                        | Route-level splits; heavy modals; rarely-used widgets                              |

**Don't `useMemo` arithmetic.** The wrapper costs more than `a + b`. **Don't wrap every callback** in `useCallback` — it does nothing unless the consumer cares about reference equality.

## Custom hooks

A custom hook is "a function that calls other hooks." Extract before reaching for a library:

```tsx
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
```

## Server Components (RSC frameworks only)

**Server components are `async`, run on the server, ship zero JS, can `await fetch` / DB / secrets, and can't use `useState`/`useEffect`/event handlers/browser APIs.** `'use client'` at the top of a file marks **everything in that file and everything it imports** as client-bundled — put it **as low in the tree as possible**.

```tsx
// app/dashboard/page.tsx — server
import { getMetrics } from "@/lib/db";
import { Chart } from "./chart"; // 'use client'

export default async function Dashboard() {
  const data = await getMetrics();
  return <Chart data={data} />; // server wraps; client interacts
}
```

**Server actions are public endpoints.** Anyone can post to them. Always: (1) authenticate the caller, (2) validate inputs with Zod (`safeParse`, don't return `error.message` to the client — that leaks schema/fields), (3) authorize the operation. After a mutation: `revalidatePath` or `revalidateTag` or your UI shows stale data.

Slot pattern: `<ClientShell><ExpensiveServerThing /></ClientShell>` keeps `ExpensiveServerThing` server-rendered even though the shell is client.

Hydration mismatches: server HTML must equal first client render. `Date.now()`/`Math.random()` in render, `typeof window` branches outside effects, or locale-dependent formatting will break it.

Full RSC workflow (server-vs-client cheatsheet, `'use client'` boundary rules, server action auth/validate/authorize pattern, four Next.js caching layers, Suspense streaming, `useFormStatus` / `useActionState`): `references/react-server-components.md`.

## Testing

**Query by what the user sees** (role > label > text). `userEvent` over `fireEvent`. **Test behavior, not implementation** — a test that breaks on hook→reducer refactor tests the wrong layer.

Stack: `vitest` + `@testing-library/react` + `@testing-library/user-event` + `@testing-library/jest-dom/vitest` + `msw` (mock the network layer, not `fetch`).

```tsx
// IMPLEMENTATION — breaks on refactor
expect(component.state.count).toBe(1);
// BEHAVIOR — survives refactor
expect(screen.getByText("Count: 1")).toBeInTheDocument();
```

Async: `findBy*` (waits for appearance), `waitForElementToBeRemoved` (disappearance), `waitFor(() => expect(...))` (arbitrary retry). Never `await new Promise(r => setTimeout(r, 200))` — root-cause the flake.

**RSC + server actions are not unit-testable in jsdom.** Two paths: (a) E2E with Playwright/Cypress drives the real Next.js server, fills the form, asserts DOM; or (b) extract action logic into a plain async function and unit-test that — the `'use server'` wrapper stays a thin pass-through.

Full testing workflow (query priority table, MSW setup + per-test overrides, `renderHook`, snapshot rules, accessibility checks): `references/react-testing.md`.

## Preact compatibility

Preact 10 is a 3 KB runtime that mirrors the React API: hooks, function components, and JSX transfer unchanged once the bundler aliases `react`/`react-dom` to `preact/compat`. Watch the gaps — event timing and some `react-dom` internals are not byte-identical, and Suspense/RSC are not first-class. `@preact/signals` is Preact's reactive primitive (finer-grained than `useState`) but a Preact-specific API, not React. Reach for Preact when bundle size dominates (embedded widgets, an Electron tray UI — `Skill(k0d3:ts-electron)`); stay on React for the full ecosystem (RSC, React Native). Everything else in this skill applies unchanged.

## Anti-patterns

- `useEffect` to derive state from props — compute inline or `useMemo`
- `useEffect` + `setState` to sync two pieces of state you already have
- Setting state in render without a guard — infinite loop
- Index as `key` in reorderable lists — React confuses items, state leaks
- Inline `{ ... }` / `[ ... ]` / arrow fns as `memo`'d-child props — refs change every render
- Wrapping the whole app in `memo` "just in case" / `useCallback` on every handler — pure noise
- Context for everything — re-render storm + tangled global
- Async function passed directly to `useEffect` — wrap with inner IIFE + cancellation
- `'use client'` at the top of `layout.tsx` — collapses everything to client
- Adding `'use client'` "to be safe" — pollutes the client bundle
- `useEffect + fetch` for data loading in an RSC framework — use a server component
- Treating server actions as private endpoints — they're public; always auth + validate + authorize
- Passing functions or class instances as props from server to client — not serializable
- `data-testid` everywhere — use roles + labels first; testids are an a11y smell
- `fireEvent` for user actions — skips focus/disabled/keyboard handling
- Mocking `fetch` directly per test — use MSW
- Mocking child components — your test no longer reflects real behavior
- Full-DOM snapshots — they hide more than they catch

## Red flags

| Thought                                     | Reality                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| "I'll add `useEffect` to keep them in sync" | If one derives from the other, compute it. No effect needed.           |
| "I'll memoize this to be safe"              | Without profiling, you're adding cost without benefit.                 |
| "I'll fetch in a client component for now"  | You skipped the speed-up RSC gives you. Move it to the server.         |
| "Server action — no one knows the URL"      | It IS the URL. Treat it like any public endpoint.                      |
| "Hydration mismatch is just a warning"      | It silently re-renders the entire subtree. Fix it.                     |
| "I'll just add `data-testid` to grab it"    | Try `getByRole` first. If no role, fix the markup.                     |
| "`fireEvent` is faster"                     | And wrong — it misses focus, disabled, key sequences. Use `userEvent`. |

## Hand-off

For TypeScript foundations (strict-mode, generics, discriminated unions, satisfies): `Skill(typescript)`. For zod-validated boundaries (server-action inputs, fetch responses): `Skill(ts-zod)`. For build tooling: `Skill(ts-vite)`. For test runner setup: `Skill(ts-vitest)`. For design tokens / variants / typography: `Skill(frontend-design-essentials)`. For TDD: `Skill(tdd)`. For deep RSC + Next.js caching + server-action pending UI: `references/react-server-components.md`. For full RTL/Vitest/MSW workflow: `references/react-testing.md`.
