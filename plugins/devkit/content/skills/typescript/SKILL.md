---
name: typescript
description: Use when writing any TypeScript — strict-mode flags, async patterns, ESM/CJS, Node interop, type patterns (unions, brands, `satisfies`).
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [typescript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [react, bun-essentials, node-essentials, ts-zod, ts-vite, ts-vitest, ts-zustand, ts-tauri]
---

# TypeScript

**Iron Law: `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Non-negotiable. ESM-only for new projects. Make invalid states unrepresentable — discriminated unions for state, branded types for opaque IDs.**

**Versions:** Supported `5.6`+ (DT floor) · Current `5.9` · Next `6.0` — _`using` / `await using` (explicit resource management); `isolatedDeclarations`; `--module node20` default for new tsconfigs; `--erasableSyntaxOnly` for Node type-stripping compat._

## tsconfig baseline (copy this)

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  }
}
```

| Flag                         | Why                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `strict: true`               | Bundle: `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `useUnknownInCatchVariables`, more. |
| `noUncheckedIndexedAccess`   | `arr[0]` is `T \| undefined`. Forces empty-array handling.                                              |
| `exactOptionalPropertyTypes` | `{ x?: number }` means missing OR `number`, never `number \| undefined`.                                |
| `verbatimModuleSyntax`       | Forces `import type` for type-only imports. Faster transpile.                                           |
| `moduleResolution: Bundler`  | When Vite/esbuild/Bun resolves. Use `NodeNext` for Node-native ESM.                                     |

`module: NodeNext` + `moduleResolution: NodeNext` requires writing `.js` in imports even though source is `.ts` — that's what runs.

## Async patterns

```ts
import { z } from "zod";

const UserSchema = z.object({ id: z.string(), email: z.string().email() });
type User = z.infer<typeof UserSchema>;

async function fetchUser(id: string, signal?: AbortSignal): Promise<User> {
  const res = await fetch(`/users/${id}`, { signal });
  if (!res.ok) throw new HttpError(res.status);
  return UserSchema.parse(await res.json()); // Zod parses; never `as` cast network bytes
}
```

Caught values are `unknown`. Narrow, never `as`:

```ts
try {
  await fetchUser(id);
} catch (e) {
  if (e instanceof HttpError) handleHttp(e);
  else if (e instanceof Error) log(e.message);
  else throw e;
}
```

| Need                                | Pick                                        |
| ----------------------------------- | ------------------------------------------- |
| Sequential (next depends on prev)   | `await` in series                           |
| Independent, all-or-nothing         | `Promise.all([...])`                        |
| Independent, partial failures OK    | `Promise.allSettled([...])`                 |
| First to finish (including timeout) | `Promise.race([...])`                       |
| First success (Node 22+)            | `Promise.any([...])`                        |
| Cancellation                        | `AbortController` + `signal` everywhere     |
| Bounded concurrency                 | `p-limit` / `p-queue` (don't roll your own) |

**Every long-running async function takes an optional `AbortSignal`.** Compose with `AbortSignal.any([userCtrl.signal, timeoutCtrl.signal])`.

## ESM-only (new projects)

`package.json`: `{ "type": "module" }` → `.js` is ESM, `.cjs` is CJS. Top-level `await`, `import.meta.dirname` (Node 20.11+), no `__dirname` dance. Importing ESM from CJS: dynamic `await import("pkg")` only. Don't dual-package unless publishing a library — use `tsdown` (preferred), `tsup`, or `unbuild`; verify with `npx @arethetypeswrong/cli yourpkg`.

## Node interop

```ts
import { readFile } from "node:fs/promises"; // always use node: prefix
import express from "express"; // CJS default — esModuleInterop handles it
```

No types? Augment in `src/types/legacy.d.ts`:

```ts
declare module "legacy-lib" {
  export function doThing(input: string): { result: string };
}
```

## Running TS directly

| Tool          | When                                            |
| ------------- | ----------------------------------------------- |
| `bun`         | Native TS. Fastest. Preferred for new projects. |
| `tsx`         | Drop-in `node` replacement for dev              |
| `vitest`      | Tests — no compile step                         |
| `tsc && node` | Production: build then run                      |

## Type design — the daily patterns

**Discriminated unions + `assertNever`** — the single most useful pattern. Add a variant, miss a case, the compiler tells you:

```ts
type FetchState<T> =
  { status: "idle" } | { status: "loading" } | { status: "success"; data: T } | { status: "error"; error: Error };

function assertNever(x: never): never {
  throw new Error(`unhandled: ${JSON.stringify(x)}`);
}

function render<T>(s: FetchState<T>) {
  switch (s.status) {
    case "idle":
      return "—";
    case "loading":
      return "...";
    case "success":
      return s.data;
    case "error":
      return s.error.message;
    default:
      return assertNever(s);
  }
}
```

Never write a switch on a union without `assertNever` default.

**Branded (opaque) types** — distinguish IDs that are all `string` at runtime. The factory is the trust boundary; cast nowhere else:

```ts
type UserId = string & { readonly __brand: "UserId" };
function makeUserId(s: string): UserId {
  if (!/^u_[a-z0-9]{20}$/.test(s)) throw new Error("bad UserId");
  return s as UserId;
}
getUser("123"); // type error
getUser(makeUserId(input)); // OK
```

**Const-as arrays over enums** — `enum` is a footgun (numeric ones especially: `Status.Pending === 0`, comparable to anything). Use literal unions:

```ts
const STATUSES = ["pending", "shipped", "cancelled"] as const;
type Status = (typeof STATUSES)[number];
```

**`satisfies`** — type-check without widening. `const config = { port: 3000, hosts: ["a","b"] } satisfies Config;` keeps `hosts` as `string[]` instead of widening to `Config["hosts"]`.

Mapped types, conditional types with `infer`, template literal types, and `DeepReadonly`-style recipes live in `references/typescript-types-advanced.md`. Reach for built-ins first: `Partial`, `Pick`, `Omit`, `Record`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters`, `Awaited`.

## Errors when migrating to strict

| Error                                  | Fix                                   |
| -------------------------------------- | ------------------------------------- |
| `Object is possibly 'null'`            | Guard: `if (x) ...` or `?.`           |
| `'x' is of type 'unknown'`             | Narrow: `if (x instanceof Error) ...` |
| `Element implicitly has an 'any' type` | Type the index or use a typed lookup  |

Use **`// @ts-expect-error`**, not `// @ts-ignore`. `expect-error` fails build when the underlying error is fixed — surfaces dead suppressions automatically.

## Anti-patterns

- `any` anywhere outside the smallest possible boundary — use `unknown` and narrow
- `// @ts-ignore` — use `// @ts-expect-error` instead
- `as` to silence an error — use a type guard or fix the type
- `enum` (especially numeric) — use literal unions or `as const` arrays
- `namespace` — use ES modules
- Forgotten `await` — enable `@typescript-eslint/no-floating-promises`
- Async in `forEach` — doesn't await. Use `for of`
- `switch` on a union without `assertNever` default — missing cases pass silently
- Branded type without a validating factory — you've hidden a `string`

## Red flags

| Thought                                | Reality                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| "I'll loosen strict to ship faster"    | You'll pay later with interest. Fix the type.                            |
| "I'll dual-package to be safe"         | Dual-package hazard — `instanceof` fails. ESM-only is safer.             |
| "Just cast it with `as`"               | You just lied to the compiler. It will believe you and crash at runtime. |
| "ESM is too painful, stay on CJS"      | The pain compounds. The ESM-only library ecosystem isn't coming back.    |
| "Async constructor"                    | Not a thing. Use a static async factory: `static async create()`.        |
| "Enums are fine, they're a TS feature" | They emit JS, break tree-shaking, and numeric ones compare to anything.  |

## Hand-off

For React: `Skill(react)`. For runtime/test/build tools: `Skill(bun-essentials)`, `Skill(node-essentials)`, `Skill(ts-vite)`, `Skill(ts-vitest)`. For schema validation at boundaries: `Skill(ts-zod)`. For state: `Skill(ts-zustand)`. For desktop apps: `Skill(ts-tauri)`. For advanced type-level recipes (mapped, conditional, template literal, `DeepReadonly`, recipe library): `references/typescript-types-advanced.md`.
