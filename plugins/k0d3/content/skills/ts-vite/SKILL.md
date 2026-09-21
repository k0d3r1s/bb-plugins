---
name: ts-vite
description: Use when configuring Vite 6+ — dev server, plugins, env vars, manual chunks, build modes, SSR, proxy.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [typescript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [typescript, react, pnpm-essentials]
---

# TS Vite

**Iron Law: `process.env` in client code is forbidden — use `import.meta.env` with the `VITE_` prefix. Manual-chunk vendor code. Use the dev proxy instead of going CORS-heavy.**

**Versions:** Supported `5.4`+ · Current `7.x` · Next `8.x` — _Rolldown is the default prod bundler from 7; Environment API for SSR/edge/workers; `vite preview` honors history fallback; Node 20 LTS minimum._

## Why Vite (vs webpack / Rollup / esbuild raw)

| Tool                 | Verdict                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Vite**             | esbuild for dev (instant HMR), rollup/rolldown for prod, plugin model from rollup — **default for new SPAs/SSR** |
| **webpack**          | mature, every plugin exists, slow dev — keep for legacy; don't start here                                        |
| **Rollup**           | best for libraries (small output, ES module focus); Vite wraps it for apps                                       |
| **esbuild**          | use raw only for small CLIs; Vite gives you the dev story on top                                                 |
| **Parcel**           | zero-config, smaller ecosystem; fine for prototypes                                                              |
| **Turbopack (Next)** | locked to Next; not a Vite alternative                                                                           |

## Minimal config

```ts
// vite.config.ts — ESM-only ("type": "module" in package.json)
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  // loadEnv with prefix "VITE_" loads ONLY browser-safe vars.
  // Empty prefix ("") loads ALL .env vars including secrets — server-side reads only.
  // NEVER spread an empty-prefix env object into `define`; it leaks SECRET_KEY etc. to the bundle.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react()],
    // import.meta.dirname requires Node 20.11+; alternative: fileURLToPath(new URL(".", import.meta.url))
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: env.VITE_API_URL ?? "http://localhost:8080", changeOrigin: true },
      },
    },
    build: {
      sourcemap: true, // for production SaaS, switch to 'hidden' so .map files exist but aren't referenced from JS
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            vendor: ["zustand", "@tanstack/react-query", "zod"],
          },
        },
      },
    },
  };
});
```

`loadEnv(mode, cwd, "")` reads all env vars (third arg is the prefix filter — `""` = all, for server-side reads).

## Env vars — the only sane way

```ts
// .env, .env.local, .env.development, .env.production
VITE_API_URL=https://api.example.com
VITE_SENTRY_DSN=https://...
SECRET_KEY=never-expose-this              // no VITE_ prefix → server/build-time only

// In code:
import.meta.env.VITE_API_URL              // ✅
import.meta.env.MODE                       // "development" | "production"
import.meta.env.DEV                        // boolean
process.env.VITE_API_URL                   // ❌ undefined in browser
```

**Anything reachable from `import.meta.env.VITE_*` ends up in the JS bundle**, viewable by anyone. Never put API secrets there — Sentry DSN and public API URLs are fine; service keys are not.

Type the env:

```ts
// src/vite-env.d.ts
interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_SENTRY_DSN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

## Plugins — the ones you actually need

| Plugin                 | Use                                                          |
| ---------------------- | ------------------------------------------------------------ |
| `@vitejs/plugin-react` | React + Fast Refresh; SWC variant for faster builds          |
| `@vitejs/plugin-vue`   | Vue SFCs                                                     |
| `vite-plugin-svgr`     | import SVG as React component                                |
| `vite-tsconfig-paths`  | respect TS `paths` instead of duplicating in `resolve.alias` |
| `vite-plugin-pwa`      | service worker / manifest                                    |
| `vite-plugin-checker`  | TS + ESLint in dev as overlay                                |

Avoid plugin sprawl — every plugin slows dev startup. Audit quarterly.

## Manual chunks — vendor splitting

Default Rollup output dumps everything into one chunk. For SPAs > 200KB gz:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: (id) => {
        if (id.includes("node_modules")) {
          if (id.includes("react")) return "react";
          if (id.includes("@tanstack")) return "tanstack";
          return "vendor";
        }
      },
    },
  },
}
```

Trade-off: too granular = more HTTP requests; too coarse = single huge chunk evicts cache on every minor dep bump. **Target: react + vendor + app**.

## Dev proxy — avoid CORS in dev

```ts
server: {
  proxy: {
    "/api": { target: "http://localhost:8080", changeOrigin: true },
    "/ws": { target: "ws://localhost:8080", ws: true },
  },
}
```

Backend at 8080, frontend at 5173 — proxy `/api/*` → backend. No CORS config needed, dev cookies work. Configure your prod ingress identically so the code path is the same.

## Build modes

```bash
vite build                       # mode=production, loads .env.production
vite build --mode staging        # loads .env.staging
```

Modes ≠ environments. Mode controls which `.env.<mode>` is loaded and the value of `import.meta.env.MODE`. NODE_ENV is always `production` for builds.

## SSR

`vite build --ssr src/entry-server.ts` produces a Node-runnable bundle. For full SSR pick a meta-framework (Remix, SvelteKit, Nuxt, Astro) — they wrap Vite. Rolling your own SSR is a months-long project.

## Anti-patterns

- `process.env.X` in client code — undefined at runtime, sometimes silently
- Putting API secrets behind `VITE_` prefix — they ship to every browser
- No `manualChunks` for > 200KB apps — every dep bump invalidates the whole bundle
- Dev hitting `localhost:8080` directly instead of via proxy — CORS hell, cookie domain mismatch
- `sourcemap: true` in prod without thinking — source visible; fine for SPA-as-app, leak for SPA-as-product
- Importing tree-shaken libraries with `import *` (`import * as _ from "lodash"`) — defeats tree-shake
- `vite preview` left running in prod — it's a dev-only static server, not a prod server
- Mixing `tsconfig.json` paths and `resolve.alias` — pick one (`vite-tsconfig-paths` is the right choice)

## Red flags

| Thought                                         | Reality                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| "Why is my env var undefined in the browser?"   | Missing `VITE_` prefix                                                     |
| "I'll inline the API key, it's just a frontend" | The frontend is shipped — assume it's public                               |
| "Bundle is 800KB and I'm not sure why"          | Run `vite build --report` or `rollup-plugin-visualizer`                    |
| "Just enable CORS on the backend"               | In dev, the proxy is simpler; in prod, you need it anyway — keep dev clean |

## Hand-off

For React patterns + Hooks: `Skill(react)`. For TS config + types: `Skill(typescript)`. For package manager flow: `Skill(pnpm-essentials)`.
