# TypeScript — Advanced Type Patterns

Linked from `Skill(typescript)`. The daily patterns (discriminated unions, branded types, const-as arrays, `satisfies`) live in the main skill. This reference covers mapped, conditional, template literal types, and the patterns you reach for monthly rather than daily.

## The pattern decision table

| You have...                                                    | Use                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| A value that's one of N variants, each carrying different data | Discriminated union + `assertNever` (in main skill)   |
| Distinct ID types that are all strings at runtime              | Branded type (in main skill)                          |
| A fixed list of values used at both type and value level       | `as const` array + `typeof X[number]` (in main skill) |
| A constant that must satisfy a type AND keep its narrow shape  | `satisfies` (in main skill)                           |
| Validated input crossing a trust boundary                      | Type guard returning `x is T`                         |
| Transform every property of an existing type                   | Mapped type (or built-in: `Partial`, `Pick`, `Omit`)  |
| Type depends on another type                                   | Conditional type with `infer` — sparingly             |
| Compile-time string template                                   | Template literal type                                 |

## Type guards + assertion functions

```ts
function isUser(x: unknown): x is User {
  return typeof x === "object" && x !== null && "id" in x && "email" in x;
}
function assertString(x: unknown): asserts x is string {
  if (typeof x !== "string") throw new TypeError("not a string");
}
```

After `if (isUser(p))` or `assertString(x)`, the type is narrowed (in-place for assertion functions — no `if` wrap). **Don't lie in either.** If they return true / don't throw for things that aren't `T`, you've punched a hole in the type system. For real validation at trust boundaries, use `zod` / `valibot` — they generate guards from schemas.

## Mapped types

Reach for built-ins first: `Partial<T>`, `Required<T>`, `Readonly<T>`, `Pick<T,K>`, `Omit<T,K>`, `Record<K,V>`. Custom mapped types:

```ts
type Nullable<T> = { [K in keyof T]: T[K] | null };
type Stringify<T> = { [K in keyof T]: string };
```

Use the `as` clause to filter or rename keys:

```ts
type NonFunctionKeys<T> = { [K in keyof T as T[K] extends Function ? never : K]: T[K] };
```

## Conditional types with `infer`

```ts
type ElementOf<T> = T extends (infer U)[] ? U : never;
type ReturnTypeOf<F> = F extends (...args: any[]) => infer R ? R : never;
type Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T; // built-in
```

If a custom conditional reads like a riddle, **write a function with a clear name** — it beats a clever alias nine times in ten.

## Template literal types

```ts
type ApiRoute = `/api/${"v1" | "v2"}/${string}`;
type EventName<T extends string> = `on${Capitalize<T>}`; // EventName<"click"> = "onClick"
type CssSize = `${number}px` | `${number}rem` | `${number}%`;
```

Great for routes / CSS / events; don't overdo (compile times balloon with deep recursion).

## DeepReadonly — the trap

```ts
// Naive — DON'T use as-is: recurses into Date, RegExp, Map, Set, Function, etc.
// (all satisfy `extends object`), producing wrong types.
// type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };

// Production: prefer type-fest's ReadonlyDeep (handles Date/Map/Set/Function correctly).
// If you must roll your own, exempt non-plain objects:
type DeepReadonly<T> = T extends Date | RegExp | Map<any, any> | Set<any> | Function
  ? T
  : { readonly [K in keyof T]: DeepReadonly<T[K]> };
```

## Built-in utility roll-call

`Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Record`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters`, `ConstructorParameters`, `InstanceType`, `Awaited`, `Uppercase`, `Lowercase`, `Capitalize`, `Uncapitalize`.

For richer recipes (`type-fest`): `ReadonlyDeep`, `MergeDeep`, `OverrideProperties`, `SetRequired`, `SetOptional`, `Promisable`, `Jsonifiable`, `Tagged` (their version of branded types).

## Anti-patterns

- Conditional-type ladders four levels deep — write a function, name the steps
- Inheritance hierarchies of types — use composition and intersection
- `as` casts scattered through the codebase — concentrate at validated boundaries
- Reinventing `type-fest` utilities — install the package; it's tree-shaken
- Mapped types over giant unions (>200 members) — compile time explodes; refactor the union
