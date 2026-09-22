# React Testing — Full Workflow

Linked from `Skill(react)`. The compact testing summary lives in the main skill. Use this reference for the full RTL + Vitest + MSW workflow, query priority, async patterns, hooks testing, and a11y.

**Iron Law: query by what the user sees (role, label, text). Test behavior, not implementation. `userEvent` over `fireEvent`.**

A test should pass after a refactor that preserves behavior and fail when behavior breaks. If a CSS class rename or hook → reducer migration breaks your test, you're testing the wrong layer.

## Stack

| Tool                               | Job                                                |
| ---------------------------------- | -------------------------------------------------- |
| `vitest`                           | Test runner — fast, ESM-native, Jest API           |
| `@testing-library/react`           | Render + queries that mirror users                 |
| `@testing-library/user-event`      | Realistic interaction (fires the full event chain) |
| `@testing-library/jest-dom/vitest` | `toBeInTheDocument`, `toHaveTextContent`, etc.     |
| `msw`                              | Mock the **network layer**, not `fetch` itself     |

## Minimal setup

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./vitest.setup.ts"], globals: true },
});

// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

## Query priority (top to bottom)

| Query                         | Use for                                                          | Skip when                                                |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `getByRole(role, { name })`   | **Default** — buttons, links, headings, regions                  | Element has no role/accessible name (fix the a11y first) |
| `getByLabelText`              | Form fields with associated labels                               | Field has no label (fix it)                              |
| `getByPlaceholderText`        | Input with placeholder and no label                              | A label exists                                           |
| `getByText`                   | Non-interactive content                                          | Multiple matches; text changes often                     |
| `getByDisplayValue`           | Current input value                                              | You're testing visible text, not input state             |
| `getByAltText` / `getByTitle` | Images, tooltips                                                 | —                                                        |
| `getByTestId`                 | **Last resort** — add `data-testid` only when nothing else works | A semantic query exists                                  |

- `getBy*` — throws if missing (use to assert presence)
- `queryBy*` — returns null (use to assert absence)
- `findBy*` — async, waits up to timeout (use for async appearance)

## userEvent vs fireEvent

```tsx
// fireEvent — one synthetic event, no realism
fireEvent.click(button);
fireEvent.change(input, { target: { value: "hi" } });

// userEvent — full event chain (pointerdown, mousedown, focus, click, input, change)
const user = userEvent.setup();
await user.click(button);
await user.type(input, "hi");
await user.tab();
await user.keyboard("{Enter}");
```

**Always reach for `userEvent`.** It catches focus, disabled, accessibility issues that `fireEvent` papers over. `fireEvent` only for things `userEvent` doesn't model (scroll, some media events).

## Async

| Need                            | Use                                    |
| ------------------------------- | -------------------------------------- |
| Element will appear soon        | `await screen.findByText(...)`         |
| Element will disappear          | `waitForElementToBeRemoved`            |
| Arbitrary assertion needs retry | `waitFor(() => expect(...).toBe(...))` |
| Wait N ms because "it works"    | **never** — root-cause the flake       |

## MSW — mock the network, not `fetch`

```ts
// test/handlers.ts
import { http, HttpResponse } from "msw";
export const handlers = [http.get("/api/users", () => HttpResponse.json([{ id: 1, email: "a@b" }]))];

// vitest.setup.ts
import { setupServer } from "msw/node";
import { handlers } from "./test/handlers";
const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

Per-test override:

```ts
server.use(http.get("/api/users", () => HttpResponse.error()));
```

Mocking `fetch` directly forces every test to re-implement the mock and decouples tests from the network contract. MSW is mocked at the right layer.

## Hooks

`renderHook(() => useCounter(0))` returns `{ result }`. Wrap state updates in `act(() => result.current.inc())`. Pass a `wrapper` for hooks needing context.

## What to assert

```tsx
// IMPLEMENTATION — breaks on refactor
expect(component.state.count).toBe(1);
// BEHAVIOR — survives refactor
expect(screen.getByText("Count: 1")).toBeInTheDocument();
```

If you'd rewrite the component (hooks → reducer, lib swap, props renamed) and your test would still pass, you're testing the right thing.

## A11y + snapshots

Because RTL pushes `getByRole` / `getByLabelText`, tests fail when elements lose labels or roles. For explicit a11y checks: `vitest-axe` / `jest-axe`. Snapshots: only tiny stable outputs (className strings, serialized config) — never full-DOM. Full-DOM snapshots get rubber-stamped and drown reviews in noise.

## Testing RSC + server actions

jsdom can't render async server components. Two practical paths:

1. **E2E with Playwright/Cypress** is the recommended boundary test — drive the real Next.js server, fill the form, assert resulting DOM. This covers the actual server/client serialization boundary.
2. **Extract action logic** into a plain async function (e.g., `createPostImpl(input, ctx)`) and unit-test that function in vitest; the `'use server'` wrapper itself becomes a thin pass-through (auth + validate + call impl). The impl is now jsdom-irrelevant pure logic.

Don't try to render `<ServerComponent />` directly in vitest/jsdom — the renderer doesn't support async function components.

## Anti-patterns

- `data-testid` everywhere — use roles + labels first; testids are an a11y smell
- `fireEvent` for user actions — skips focus/disabled/keyboard handling
- Mocking `fetch` directly per test — use MSW
- Mocking child components — your test no longer reflects real behavior
- Asserting on CSS classes for behavior — assert on what the user perceives
- `await new Promise(r => setTimeout(r, 200))` — flake. Use `findBy*` / `waitFor`
- Ignoring `act` warnings — they signal a real async problem
- `querySelector` to find elements — use semantic queries
- Sharing state across tests (forgot `cleanup`, didn't reset MSW handlers)
- Full-DOM snapshots in PRs — they hide more than they catch
