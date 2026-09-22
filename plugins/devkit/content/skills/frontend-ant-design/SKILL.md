---
name: frontend-ant-design
description: Use when building UI with Ant Design (antd) — v5 vs v6, ConfigProvider, theming, Form integration with react-hook-form, Table virtualization, locale.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  languages: [react, typescript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related:
    [react, typescript, frontend-design-essentials, frontend-tailwind, frontend-react-hook-form, ts-zod, ux-wcag-a11y]
---

# Ant Design (antd)

**Iron Law: one `<ConfigProvider>` at the app root owns theme, locale, and component tokens. Never import from `antd/lib/*` or `antd/es/*` — only `antd` top-level. Sub-path imports break tree-shaking in v5 and are removed in v6.**

**Versions:** Current `6.4` · LTS `5.27` — _v5 is in maintenance through 2026; v6 (Q1 2026) drops the CSS-in-JS hydration tax via static CSS extraction, ships a new `motion` token group, and removes deprecated `Form.Item.hasFeedback` plus the `antd/lib` import path. Pin per-app, don't mix._

## When it fits

| Fits                                                           | Doesn't                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Data-dense internal tools (tables, forms, dashboards)          | Marketing pages — too opinionated, too heavy            |
| Teams that want batteries included (Table, DatePicker, Upload) | Highly custom brand UI — Radix/shadcn give more control |
| ConfigProvider-driven theming is acceptable                    | You need Tailwind to own all visual styling             |

## v5 → v6 breakage table

| Area            | v5                                                                              | v6                                                                  |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Imports         | `import { Button } from 'antd'` AND `import Button from 'antd/lib/button'` work | only `import { Button } from 'antd'`                                |
| CSS engine      | runtime CSS-in-JS (hydration cost on SSR)                                       | static extraction via `@ant-design/cssinjs/extractStyle` build step |
| Form            | `Form.Item hasFeedback`                                                         | removed — use `validateStatus="validating"`                         |
| Theme tokens    | `theme.token.colorPrimary`                                                      | same, plus `motion` token group                                     |
| Icons           | `@ant-design/icons` v5.x                                                        | v6 — peer-dep bump, tree-shaken by default                          |
| Locale          | `locale={enUS}`                                                                 | unchanged                                                           |
| TypeScript peer | `>=4.9`                                                                         | `>=5.4`                                                             |

When two apps in the same org sit on different majors (one on v5 LTS, one on v6), don't share component code 1:1 across them — wrap differences in a local primitive.

## ConfigProvider — set once, at the root

```tsx
import { ConfigProvider, theme } from "antd";
import enUS from "antd/locale/en_US";

<ConfigProvider
  locale={enUS}
  theme={{
    algorithm: prefersDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: "#1677ff", borderRadius: 6, fontFamily: "Inter, sans-serif" },
    components: {
      Button: { controlHeight: 36, fontWeight: 500 },
      Table: { headerBg: "transparent", rowHoverBg: "rgba(0,0,0,.02)" },
    },
  }}
>
  <App />
</ConfigProvider>;
```

**Component-level overrides go in `theme.components.<X>`**, not by writing CSS overrides. CSS overrides break on the next minor (token names change less often than internal class names).

## Theming — global tokens vs component tokens

| Need                                                   | Where                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Brand color, radius, font, spacing scale               | `theme.token`                                                                                                                                    |
| Override Button height across the app                  | `theme.components.Button.controlHeight`                                                                                                          |
| Dark mode                                              | swap `theme.algorithm` to `theme.darkAlgorithm`                                                                                                  |
| Per-section override (e.g. compact tables in a drawer) | nested `<ConfigProvider componentSize="small" theme={{...}}>`                                                                                    |
| Tailwind side-by-side                                  | use Tailwind for layout/spacing on non-antd elements; let antd own its own internals. Don't `@apply` into antd class names — they're not stable. |

## Forms — antd `<Form>` vs react-hook-form

Two valid patterns. Pick **per form**, not per app.

**antd `<Form>`** — simplest, antd-owned validation, less re-render control.

```tsx
<Form layout="vertical" onFinish={onSubmit} initialValues={initial}>
  <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
    <Input />
  </Form.Item>
</Form>
```

**react-hook-form + Controller** — needed when sharing schema with zod, when you want RHF's perf/devtools, or for cross-field logic.

```tsx
import { Controller } from "react-hook-form";

<Controller
  control={control}
  name="email"
  render={({ field, fieldState }) => (
    <Form.Item label="Email" validateStatus={fieldState.invalid ? "error" : ""} help={fieldState.error?.message}>
      <Input {...field} />
    </Form.Item>
  )}
/>;
```

Rule: any antd component with internal state (`DatePicker`, `Select`, `Upload`, `Cascader`, `TreeSelect`) **must** use `Controller`. `register()` won't work — they don't forward refs to a native input. See `Skill(frontend-react-hook-form)`.

## Table patterns

```tsx
<Table
  rowKey="id" // ALWAYS — without it React keys by index, state leaks
  dataSource={rows}
  columns={cols}
  pagination={{ pageSize: 50, showSizeChanger: true }}
  scroll={{ x: "max-content", y: 480 }} // virtualized rows when y is set + many rows
  sticky // sticky header inside scroll container
/>
```

| Need                    | How                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| Virtualize rows         | `scroll={{ y: N }}` + small `pageSize`; or use `@ant-design/v5-patch-for-react-19` virtual if needed |
| Stable row identity     | `rowKey="id"` — never index                                                                          |
| Expandable rows         | `expandable={{ expandedRowRender, rowExpandable }}`                                                  |
| Server-side sort/filter | controlled `onChange(pagination, filters, sorter)`                                                   |
| Selection               | `rowSelection={{ type: 'checkbox', selectedRowKeys, onChange }}`                                     |
| Resize columns          | use `react-resizable` wrapper around the `<th>` — antd doesn't ship it                               |

Antd Table is fine to ~2k rows with virtualization. Past that, switch to TanStack Table headlessly + your own row renderer.

## Upload with custom request

The default `action`-URL Upload posts directly. For axios/keycloak token, use `customRequest`:

```tsx
<Upload
  customRequest={async ({ file, onSuccess, onError, onProgress }) => {
    try {
      const res = await api.post("/uploads", file as File, {
        onUploadProgress: (e) => onProgress?.({ percent: (e.loaded / (e.total ?? 1)) * 100 }),
      });
      onSuccess?.(res.data);
    } catch (e) {
      onError?.(e as Error);
    }
  }}
  multiple
  maxCount={10}
/>
```

## Locale

```ts
import enUS from "antd/locale/en_US";
import lvLV from "antd/locale/lv_LV";
import dayjs from "dayjs";
import "dayjs/locale/lv";
dayjs.locale(navigator.language.startsWith("lv") ? "lv" : "en");
```

Antd date components are dayjs-based since v5. Don't ship moment.js with antd — it was dropped in v5.0.

## Anti-patterns

- Importing from `antd/lib/<x>` — breaks tree-shaking in v5, fatal in v6
- CSS overrides on internal antd class names (`.ant-btn-primary`) — they rename across minors
- Multiple `ConfigProvider`s with overlapping theme just to "scope" — nest only when you genuinely want different sizing/locale
- `<Table>` without `rowKey` — React falls back to index, selection and expand state leak
- Putting `<DatePicker>`/`<Select>` under react-hook-form `register()` — silently won't sync
- Shipping antd + `react-aria` + Radix in one app for the same component family — pick one
- Forgetting to wrap antd v6 SSR with `extractStyle` — FOUC on first paint

## Red flags

| Thought                              | Reality                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| "I'll just bump antd v5 → v6"        | It's a real migration — imports, SSR setup, Form props. Read the changelog.     |
| "I'll override `.ant-btn` in my CSS" | Internal class names. Next minor breaks it. Use `theme.components.Button`.      |
| "Antd Form is fine for everything"   | Once you need zod + multi-step + cross-field, RHF + Controller pays for itself. |
| "Just inline 50 columns"             | Read column defs out of a config; type them with `ColumnsType<Row>`.            |

## Hand-off

For form patterns and zod resolver: `Skill(frontend-react-hook-form)` + `Skill(ts-zod)`. For React rules and composition: `Skill(react)`. For tokens-as-design-system: `Skill(frontend-design-essentials)`. For Tailwind side-by-side with antd: `Skill(frontend-tailwind)`. For a11y: `Skill(ux-wcag-a11y)`.
