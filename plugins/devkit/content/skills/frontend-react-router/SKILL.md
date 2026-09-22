---
name: frontend-react-router
description: Use when routing with react-router v6/v7 — data router, loaders, actions, error boundaries, lazy routes, navigation hooks.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  languages: [react, typescript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [react, typescript, frontend-tanstack-query, frontend-react-hook-form]
---

# React Router

**Iron Law: use the data router (`createBrowserRouter`), not `<BrowserRouter>` with route children. Loaders fetch data BEFORE the route renders — never `useEffect` to load page data inside the component. If you need stricter type-safety on params/search, switch to TanStack Router.**

**Versions:** Current `7.x` · LTS `6.30` — _v7 (late 2024) is mostly a rename + Remix-style features (framework mode with file-based routes, SPA mode, server-loaders). Library mode is a drop-in upgrade from v6.22+: `react-router-dom` → `react-router`. v6 LTS stays patched through 2026._

## Data router setup — the only setup worth using

```tsx
import { createBrowserRouter, RouterProvider } from "react-router";

const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <RootError />,
    children: [
      { index: true, element: <Home /> },
      {
        path: "projects",
        loader: projectsLoader,
        element: <ProjectsList />,
        children: [{ path: ":id", loader: projectLoader, element: <ProjectDetail /> }],
      },
      { path: "login", action: loginAction, element: <Login /> },
    ],
  },
]);

<RouterProvider router={router} />;
```

Avoid `<Routes>` + `<Route>` JSX-children form — it loses loaders/actions/error boundaries.

## Loaders — data fetching collocated with the route

```ts
export const projectLoader = ({ params }: LoaderFunctionArgs) => qc.ensureQueryData(projectQuery(params.id!)); // returns cached or fetches

// Then in the component:
const project = useLoaderData() as Project; // already resolved
const { data } = useQuery(projectQuery(params.id!)); // refetch/realtime updates
```

**Pair loaders with TanStack Query via `ensureQueryData`.** The loader gives you the SSR-style "data ready on first paint" guarantee; the hook gives you subscriptions to the live cache. See `Skill(frontend-tanstack-query)`.

| Loader pattern                                     | When                                                  |
| -------------------------------------------------- | ----------------------------------------------------- |
| `return fetch(...)` raw                            | Tiny apps, no caching                                 |
| `return defer({ slow: fetchSlow() })`              | Stream slow data behind `<Await>` while route renders |
| `qc.ensureQueryData(opts)`                         | **Default** — co-locate with hook calls in component  |
| `throw redirect("/login")`                         | Auth gate — caller never renders                      |
| `throw new Response("Not found", { status: 404 })` | Trigger nearest `errorElement`                        |

## Actions — for non-GET requests

```tsx
export const loginAction = async ({ request }: ActionFunctionArgs) => {
  const data = Object.fromEntries(await request.formData());
  const parsed = LoginSchema.safeParse(data);
  if (!parsed.success) return parsed.error.flatten();
  await api.login(parsed.data);
  return redirect("/");
};

<Form method="post">
  {" "}
  {/* from "react-router", NOT raw <form> */}
  <input name="email" />
  <button type="submit">Sign in</button>
</Form>;
```

`<Form>` triggers the route's `action`. `useNavigation().state === "submitting"` for pending UI. For data mutations from non-nav UI (e.g. like button), use `useFetcher()`.

## useFetcher — mutations without navigation

```tsx
const fetcher = useFetcher();
<fetcher.Form method="post" action="/items/123/like">
  <button disabled={fetcher.state !== "idle"}>♥</button>
</fetcher.Form>;
```

Triggers the target route's `action`, doesn't change the URL, returns `fetcher.data` when done.

## Error boundaries — `errorElement`

```ts
{ path: "projects/:id", element: <ProjectDetail/>, errorElement: <ProjectError/> }
```

In `<ProjectError/>` call `useRouteError()`. `isRouteErrorResponse(err)` narrows to thrown `Response`s. **Every top-level route needs `errorElement`** — without it, errors propagate to the root and blank the screen.

## Lazy-loaded routes

```ts
{
  path: "reports",
  lazy: async () => {
    const m = await import("./routes/reports");
    return { Component: m.Reports, loader: m.loader };
  },
}
```

`lazy` returns the route definition object (Component, loader, action). The loader is fetched **in parallel** with the chunk — better than `React.lazy` + `<Suspense>` which serializes them.

## Pending UI patterns

```tsx
const nav = useNavigation();
const isLoading = nav.state === "loading";
const isSubmitting = nav.state === "submitting";

// Top progress bar across the whole app:
<NProgress visible={nav.state !== "idle"} />;
```

For per-link pending state: `<NavLink>` exposes `({ isPending }) => ...` in its child function form.

## Search params

```tsx
const [params, setParams] = useSearchParams();
const filter = params.get("filter") ?? "all";
setParams({ filter: "active", page: "2" }); // replaces — pass `prev =>` to merge

// Parse + validate (always):
const Schema = z.object({
  filter: z.enum(["all", "active", "done"]).default("all"),
  page: z.coerce.number().default(1),
});
const q = Schema.parse(Object.fromEntries(params));
```

Always validate search params at the boundary — they're attacker-controllable strings.

## Navigation hooks cheatsheet

| Hook               | Use                                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| `useNavigate()`    | imperative `navigate("/x")`, `navigate(-1)`, `navigate("/x", { replace: true })` |
| `useNavigation()`  | global nav state (idle/loading/submitting) for UI                                |
| `useLocation()`    | read current URL, key for animations                                             |
| `useParams()`      | typed via codegen tools or cast at boundary                                      |
| `useMatches()`     | walk the active route tree (for breadcrumbs)                                     |
| `useRevalidator()` | force loaders to re-run without navigation                                       |
| `useBlocker()`     | warn on unsaved-form navigation (v6.7+)                                          |

## Type-safe params — RR's weakest point

React Router params are `Record<string, string \| undefined>`. Three options:

1. **Cast at boundary**: `const { id } = useParams<{ id: string }>();` — pragmatic, leaks type lies
2. **Validate with zod**: `const { id } = z.object({ id: z.string().uuid() }).parse(useParams())` — runtime safety
3. **Switch to TanStack Router**: full file-based + type-generated params/search — pick when type-safety is non-negotiable; expect more setup

For most apps, option 2 inside loaders is the right balance.

## v6 vs v7 — what actually changed

| Aspect           | v6                      | v7                                          |
| ---------------- | ----------------------- | ------------------------------------------- |
| Package          | `react-router-dom`      | `react-router` (single package)             |
| Library mode API | identical               | identical — drop-in                         |
| Framework mode   | n/a                     | new: file routes, server loaders, SPA build |
| Future flags     | many `future: { v7_* }` | flags become default                        |

Migration v6 → v7 library-mode: rename import, drop `react-router-dom`. That's it for most apps.

## Anti-patterns

- `<BrowserRouter>` + JSX `<Routes>` for new code — no loaders, no error boundaries, no nested data
- `useEffect(() => fetch(...))` inside a route component — that's what `loader` is for
- Raw `<form>` for in-app mutations — use `<Form>` to trigger the action
- Forgetting `errorElement` — one thrown error blanks the entire app
- `useParams()` cast without validation — `id` is typed `string` but URL had `undefined`
- `React.lazy` + `<Suspense>` per route — use the router's `lazy` (parallel data + chunk)
- `setSearchParams({ a: "1" })` losing the other params — pass `(prev) => { prev.set(...); return prev; }`
- Putting auth check in `useEffect` of every page — gate in the parent route's loader with `throw redirect("/login")`

## Red flags

| Thought                                        | Reality                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| "I'll fetch in useEffect on mount"             | Loader. Data ready before the component renders.                     |
| "I need a global loading spinner"              | `useNavigation().state` already gives it to you.                     |
| "params.id is typed string but it's undefined" | URL didn't match. Validate with zod or check at boundary.            |
| "I want type-safe routes"                      | If it's load-bearing, TanStack Router. Otherwise zod the boundaries. |

## Hand-off

For prefetching queries in loaders (`ensureQueryData`): `Skill(frontend-tanstack-query)`. For action-driven form submits with validation: `Skill(frontend-react-hook-form)` + `Skill(ts-zod)`. For testing routes: `Skill(react)`. For React composition rules: `Skill(react)`.
