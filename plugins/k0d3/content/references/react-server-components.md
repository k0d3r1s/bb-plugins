# React Server Components — Deep Workflow

Linked from `Skill(react)`. The compact RSC summary lives in the main skill. Use this reference when actually building with RSC — Next.js App Router, server vs client boundaries, server actions, streaming, caching.

**Iron Law: server components by default. Add `'use client'` only when you need interactivity, state, or browser APIs.**

The client cost of a server component is **zero JS**. Every client component adds bytes, hydration work, and a bundle dependency. Default the other way.

## Server vs client — the cheat sheet

| Can do                                           | Server                   | Client          |
| ------------------------------------------------ | ------------------------ | --------------- |
| `await fetch` / DB / read secrets                | yes                      | no              |
| `useState` / `useEffect` / refs / event handlers | **no**                   | yes             |
| Run in the browser                               | no                       | yes (after SSR) |
| Bundled into client JS                           | **no**                   | yes             |
| Import a client component                        | yes                      | yes             |
| Be imported by a client component                | only via `children`/slot | yes             |

## Marking the boundary

`'use client'` at the top of a file marks **everything in that file and everything it imports** as client-bundled.

```tsx
"use client";
import { useState } from "react";
export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
```

Put `'use client'` as **low in the tree as possible**. A `'use client'` in `layout.tsx` collapses your whole app into the client bundle.

## Server wraps, client interacts

```tsx
// app/dashboard/page.tsx — server
import { getMetrics } from "@/lib/db";
import { Chart } from "./chart"; // 'use client'

export default async function Dashboard() {
  const data = await getMetrics();
  return <Chart data={data} />;
}
```

Server components are `async`. Awaiting in render is the whole point — **no `useEffect + fetch` dance**. Props to client must be serializable (no functions, no class instances).

## Slot pattern — keep children on the server

```tsx
// Page is server, ClientShell is client, ExpensiveServerThing stays server
<ClientShell>
  <ExpensiveServerThing />
</ClientShell>
```

`ClientShell` receives `children`. Those children stay as server components even though the shell is client. Use this to keep interactive shells (sidebars, tabs) thin while heavy content stays server-rendered.

## Decision: when to add `'use client'`

| Need                                                   | Pick                      |
| ------------------------------------------------------ | ------------------------- |
| Read DB, call internal services, use secrets           | Server (default)          |
| Render data once, no interaction                       | Server                    |
| `onClick`, `onChange`, drag, focus, hover              | Client                    |
| `useState`, `useEffect`, `useRef`, `useReducer`        | Client                    |
| `window`, `localStorage`, `IntersectionObserver`       | Client                    |
| Third-party lib that touches the DOM (charts, editors) | Client                    |
| Animation lib (`framer-motion`, `react-spring`)        | Client                    |
| Form submission                                        | Server action — see below |

## Server actions for mutations

```tsx
// app/actions.ts
"use server";
import { z } from "zod";
import { db } from "@/db";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";

const CreatePostInput = z.object({ title: z.string().min(1).max(200) });

export async function createPost(formData: FormData) {
  // Order matters: AUTH first (don't spend DB cycles on anon callers; don't leak schema
  // timing via "validation passed but auth failed"). Then VALIDATE. Then AUTHORIZE.

  // 1. AUTHENTICATE — server actions are public URLs; treat every call as untrusted
  const session = await auth();
  if (!session) throw new Error("unauthorized");

  // 2. VALIDATE — formData.get returns string|File|null; parse, never `as string`.
  // Don't return parsed.error.message — it exposes field paths + Zod schema rules
  // to the client. Log it server-side; return a generic message.
  const parsed = CreatePostInput.safeParse({ title: formData.get("title") });
  if (!parsed.success) {
    console.error("createPost validation failed", parsed.error.issues);
    throw new Error("invalid input");
  }

  // 3. AUTHORIZE — concrete check, not a comment.
  if (session.user.role !== "author") throw new Error("forbidden");

  await db.post.create({ data: { title: parsed.data.title, authorId: session.user.id } });
  revalidatePath("/posts");
}

// in a component
<form action={createPost}>
  <input name="title" />
  <button>Create</button>
</form>;
```

**Server actions are public endpoints.** Anyone can post to them. Authenticate the caller, validate inputs (`zod`), authorize the operation. Always. The three steps are NOT optional — the framework gives you a callable URL even if you forget any of them.

After a mutation: `revalidatePath` or `revalidateTag` to invalidate the cache, or your UI shows stale data.

## Streaming with Suspense

Wrap slow children in `<Suspense fallback={<Skeleton />}>`. The shell streams immediately; slow children stream in as data resolves. Pair with `loading.tsx` (App Router) for route-level loading UI.

## Pending UI for server actions

Use React 19's `useFormStatus` (inside the form's children) or `useActionState` (for state-returning actions) to render a pending indicator. Both require `'use client'`. **Imports differ**: `useFormStatus` from `react-dom`, `useActionState` from `react`.

```tsx
"use client";
import { useFormStatus } from "react-dom";
import { useActionState } from "react";

function SubmitBtn() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>{pending ? "Saving..." : "Create"}</button>;
}

// useActionState shape: [state, dispatch, isPending] = useActionState(serverAction, initialState)
// The dispatch is what you pass to <form action={dispatch}>; the action receives (prevState, formData).
```

## Caching layers (Next.js App Router ONLY)

These four cache layers are Next.js-specific. Remix v2/RSC and standalone React RSC do not have the Data cache or Full route cache.

| Layer                 | What it does                           | How to invalidate                                             |
| --------------------- | -------------------------------------- | ------------------------------------------------------------- |
| Request memoization   | Dedupes `fetch` within one render      | (automatic, per-render)                                       |
| Data cache            | Caches `fetch` results across requests | `{ next: { revalidate: 60, tags: ["x"] } }` + `revalidateTag` |
| Full route cache      | Pre-renders entire routes              | `revalidatePath` / dynamic APIs                               |
| Router cache (client) | Caches navigations in browser          | `router.refresh()`                                            |

Calling `cookies()`, `headers()`, or reading `searchParams` opts the route out of caching automatically.

## Hydration mismatches

Server HTML must equal first client render. Causes: `Date.now()` / `Math.random()` in render; `typeof window` branches outside effects; locale-dependent formatting (use `Intl` with explicit locale); browser extensions injecting markup (last-resort: `suppressHydrationWarning` on the affected node only).

## Anti-patterns

- `'use client'` at the top of `layout.tsx` — collapses everything to client
- Adding `'use client'` "to be safe" — pollutes the client bundle
- `useEffect + fetch` for data loading in an RSC framework — use a server component
- API routes for every mutation when a server action would do
- Treating server actions as private endpoints — they're public, always validate + authorize
- Passing functions or class instances as props from server to client — not serializable
- Leaking secrets via server-to-client props — props ship in the network payload
- Forgetting `revalidatePath` after mutating — stale UI
- Importing a server-only module (`pg`, `fs`) from a client component — use the `server-only` package as a build-time guard
- Large client trees because one descendant needs `useState` — push `'use client'` down
