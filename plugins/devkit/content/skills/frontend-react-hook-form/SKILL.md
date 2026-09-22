---
name: frontend-react-hook-form
description: Use when building forms with react-hook-form — register vs Controller, zod resolvers, useFieldArray, performance, async validation, Ant Design/shadcn.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  languages: [react, typescript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related:
    [react, typescript, ts-zod, frontend-ant-design, frontend-shadcn-ui, frontend-radix-ui, frontend-tanstack-query]
---

# React Hook Form

**Iron Law: uncontrolled by default. `register()` for native inputs, `Controller` for anything that owns its own state (Ant `<DatePicker>`, Radix `<Select>`, MUI, custom). Always pair with a schema resolver (zod) — the form's typed shape comes from the schema, not a parallel `interface`.**

**Versions:** Current `7.x` · No LTS series — _v7 is stable since 2021; rolling minor releases. React 19 supported. v8 is on the horizon (compiler-friendly internals, no breaking API expected). `@hookform/resolvers` tracks RHF major; `zodResolver` works with zod v3 and v4._

## Why RHF (vs Formik, react-final-form, Conform)

| Library             | Verdict                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| **react-hook-form** | uncontrolled-first, ~9KB, minimal re-renders, huge ecosystem — **default**  |
| Formik              | controlled, re-renders the whole form on every keystroke. Legacy code only. |
| Conform             | progressive-enhancement / server-actions focused (Remix/Next App Router)    |
| TanStack Form       | newer, headless, framework-agnostic — promising; smaller ecosystem          |

## Minimal setup with zod resolver

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const Schema = z.object({
  email: z.string().email(),
  age: z.coerce.number().int().min(18),
});
type FormValues = z.infer<typeof Schema>;

function Form() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { email: "", age: 18 },
    mode: "onBlur", // validate on blur, re-validate on change after first error
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <input {...register("email")} />
      {errors.email && <p>{errors.email.message}</p>}
      <button disabled={isSubmitting}>Save</button>
    </form>
  );
}
```

`type FormValues = z.infer<typeof Schema>` — never write the interface twice. See `Skill(ts-zod)`.

## register vs Controller — the decision

| Component owns its state?                            | Use                                                       |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Native `<input>`, `<select>`, `<textarea>`           | `register("name")` — spreads `ref`, `onChange`, `onBlur`  |
| Ant Design `DatePicker`/`Select`/`Upload`/`Cascader` | `Controller`                                              |
| Radix `<Select>`, `<RadioGroup>`, `<Switch>`         | `Controller` (Radix uses `onValueChange`, not `onChange`) |
| shadcn/ui `<Form>` `<FormField>`                     | `Controller` (shadcn wraps it for you)                    |
| react-select / chakra / mantine                      | `Controller`                                              |
| Custom component without a ref-forwarded input       | `Controller`                                              |

Rule of thumb: if the component's API isn't `(event) => void`, you need `Controller`.

```tsx
<Controller
  control={control}
  name="dueDate"
  render={({ field, fieldState }) => (
    <DatePicker value={field.value} onChange={field.onChange} status={fieldState.invalid ? "error" : undefined} />
  )}
/>
```

## defaultValues + reset

`defaultValues` MUST be set up-front for `useForm` to know the field universe. For async-loaded values, use `reset()`:

```tsx
const { reset } = useForm<FormValues>({ defaultValues: emptyForm });
const { data } = useQuery(projectQuery(id));
useEffect(() => {
  if (data) reset(data);
}, [data, reset]);
```

Don't conditionally render the form until `data` loads "to avoid this" — `reset` is the pattern.

## useFieldArray for repeating sections

```tsx
const { control, register } = useForm<{ items: Item[] }>({ defaultValues: { items: [] } });
const { fields, append, remove, move } = useFieldArray({ control, name: "items" });

{
  fields.map((field, i) => (
    <div key={field.id}>
      {" "}
      {/* field.id, NOT i */}
      <input {...register(`items.${i}.name`)} />
      <button onClick={() => remove(i)}>×</button>
    </div>
  ));
}
<button onClick={() => append({ name: "" })}>Add</button>;
```

**`key={field.id}` is critical** — RHF generates a stable id. Using `i` causes input state to leak between rows on reorder/remove.

## watch vs useWatch — the perf pitfall

`watch()` called in the form component triggers a re-render of the entire form on every keystroke. `useWatch()` in a leaf only re-renders that leaf.

```tsx
// BAD — top-level form re-renders on every keystroke
function Form() {
  const { watch, register } = useForm();
  const role = watch("role");
  return <>{role === "admin" && <AdminFields />}</>;
}

// GOOD — only AdminGate re-renders
function AdminGate({ control }) {
  const role = useWatch({ control, name: "role" });
  return role === "admin" ? <AdminFields /> : null;
}
```

Same logic for `formState`: destructure only what you use; RHF subscribes per-field.

## Async / server-side validation

```tsx
const Schema = z.object({
  username: z
    .string()
    .min(3)
    .refine(async (u) => !(await api.userExists(u)), "taken"),
});
useForm({ resolver: zodResolver(Schema), mode: "onBlur" });
```

Or per-field with RHF's native `validate`:

```tsx
register("username", { validate: async (v) => !(await api.userExists(v)) || "taken" });
```

Debounce inside the validator if it fires per-keystroke (`mode: "onChange"`).

## Cross-field rules

```tsx
z.object({ start: z.date(), end: z.date() }).refine((d) => d.end > d.start, {
  path: ["end"],
  message: "end must be after start",
});
```

Attach to a specific field via `path` so the error lands on the right input.

## Integration patterns

| Library        | Pattern                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| Ant Design     | `Controller` + `<Form.Item validateStatus help>` (see `Skill(frontend-ant-design)`) |
| shadcn/ui      | `<Form>` + `<FormField>` wraps Controller; copy from shadcn CLI, edit to taste      |
| Radix bare     | `Controller` mapping `field.value`/`field.onChange` → `value`/`onValueChange`       |
| TanStack Query | submit via `useMutation`; pass `mutation.isPending` as `disabled`                   |

## Devtools

```tsx
import { DevTool } from "@hookform/devtools";
<DevTool control={control} />; // dev-only; wrap in import.meta.env.DEV
```

## Anti-patterns

- Mixing controlled `value`/`onChange` AND `register("name")` on the same input — RHF loses track of the value
- Re-creating the zod schema in render — hoist to module scope
- Async validation without debounce on `mode: "onChange"` — API hammered every keystroke
- Submitting outside `handleSubmit` wrapper — your `onSubmit` won't be typed and validation is skipped

## Red flags

| Thought                                      | Reality                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| "I'll just `useState` for this one field"    | Then it's outside the form. Re-validation, defaults, reset — all break. |
| "Why does my date picker not submit?"        | You used `register` on it. Switch to `Controller`.                      |
| "The form is laggy"                          | You called `watch` at the top. Move to `useWatch` in leaves.            |
| "I'll write a TS interface AND a zod schema" | One drifts from the other. `z.infer<typeof Schema>`.                    |

## Hand-off

For schema authoring patterns (refine, transforms, errors): `Skill(ts-zod)`. For Ant Design Form integration specifics: `Skill(frontend-ant-design)`. For shadcn `<FormField>` wrapper: `Skill(frontend-shadcn-ui)`. For submitting via mutation: `Skill(frontend-tanstack-query)`. For React rules: `Skill(react)`.
