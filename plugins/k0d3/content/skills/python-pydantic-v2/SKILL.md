---
name: python-pydantic-v2
description: Use when writing Pydantic v2 — BaseModel, field/model validators, model_config, discriminated unions, pydantic-settings, common v1→v2 migrations.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [python-essentials, python-fastapi, python-django, python-ruff-mypy]
---

# Pydantic v2

**Iron Law: validation is a boundary concern. Pydantic at the edges (HTTP in/out, env, queue payloads); plain dataclasses/types in the core. `model_config = ConfigDict(extra="forbid")` on every input model — silently accepting unknown fields is how schemas drift and secrets leak.**

**Versions:** Current `2.10.x` · Next `2.11` — _v2.0 (2023-06) rewrote core in Rust (~10x faster); v2.10 added partial validation + Discriminator union API refinements. v1 is EOL. Pydantic v2 + Python 3.12+ for new code; v1 lingers only in legacy projects you haven't migrated._

## BaseModel — the 80% case

```python
from pydantic import BaseModel, ConfigDict, EmailStr, Field

class OrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, frozen=True)

    sku: str = Field(min_length=1, max_length=64, pattern=r"^[A-Z0-9-]+$")
    qty: int = Field(gt=0, le=10_000)
    email: EmailStr
    notes: str | None = None
```

`Field()` is for **constraints and metadata**, not defaults you'd write inline. Use plain `= None`, `= []` (immutable — Pydantic copies), `= 0`. For mutable factories: `Field(default_factory=list)`.

## model_config — the knobs you'll actually touch

```python
model_config = ConfigDict(
    extra="forbid",            # reject unknown keys on input. ALWAYS for HTTP input.
    from_attributes=True,      # populate from ORM models / objects with attributes (was orm_mode)
    str_strip_whitespace=True, # `"  abc  "` → `"abc"` automatically
    frozen=True,               # immutable instances — hashable, safe to use as dict keys
    populate_by_name=True,     # accept both alias AND field name on input (was allow_population_by_field_name)
    use_enum_values=True,      # serialize enum members as their .value, not the Enum object
    validate_assignment=True,  # re-validate on attribute set (cost: every write goes through validation)
)
```

## Validators — field, model, before/after

```python
from pydantic import field_validator, model_validator

class OrderIn(BaseModel):
    sku: str
    qty: int
    discount: int | None = None

    @field_validator("sku", mode="before")             # runs BEFORE type coercion
    @classmethod
    def upcase(cls, v: object) -> object:
        return v.upper() if isinstance(v, str) else v

    @field_validator("qty")                            # default mode="after" — value is already int
    @classmethod
    def qty_sane(cls, v: int) -> int:
        if v > 1000 and v % 10 != 0: raise ValueError("bulk orders must be in lots of 10")
        return v

    @model_validator(mode="after")                     # whole model; runs after every field validator
    def discount_requires_bulk(self) -> "OrderIn":
        if self.discount and self.qty < 100: raise ValueError("discount needs qty >= 100")
        return self
```

`mode="before"` sees raw input (str/dict/whatever); `mode="after"` sees the validated, typed value. `@field_validator` MUST be `@classmethod`. Raise `ValueError` (or `AssertionError`) — Pydantic wraps to `ValidationError`.

## Discriminated unions

When a union resolves by a literal tag, **discriminate** — 10x faster than trying each variant and gives a single clean error.

```python
from typing import Literal
from pydantic import Field

class Cat(BaseModel):
    type: Literal["cat"]
    purrs: bool

class Dog(BaseModel):
    type: Literal["dog"]
    barks: bool

class Pet(BaseModel):
    animal: Cat | Dog = Field(discriminator="type")    # picks the right model by `type` value
```

For non-string discriminators or computed discrimination, use `Discriminator(callable_or_str, ...)` (2.5+).

## TypeAdapter — validate things that aren't BaseModel

```python
from pydantic import TypeAdapter

UserList = TypeAdapter(list[User])
users = UserList.validate_python(raw)              # list of User
ids = TypeAdapter(list[int]).validate_json('[1, 2, 3]')
```

Build once at module scope (it's expensive to construct, cheap to call). Use for top-level JSON arrays, `dict[K, V]`, `tuple[...]`, anything that doesn't deserve a wrapper model.

## pydantic-settings — env + .env files

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore",
        env_nested_delimiter="__",          # NESTED__KEY=value → nested={"key": "value"}
    )

    database_url: str                                  # required — crash on missing
    debug: bool = False
    openai_api_key: SecretStr                          # `repr` masks the value in logs

settings = Settings()                                  # construct once at app start
```

Separate package since v2 (`pip install pydantic-settings`). Env vars are case-insensitive by default. Use `SecretStr`/`SecretBytes` for credentials so they don't leak to logs/tracebacks. `.env` is for local dev only — production reads real env.

## v1 → v2 migration table

| v1                                      | v2                                                                |
| --------------------------------------- | ----------------------------------------------------------------- |
| inner `class Config: ...`               | `model_config = ConfigDict(...)`                                  |
| `@validator("x")`                       | `@field_validator("x")` (must be `@classmethod`)                  |
| `@root_validator`                       | `@model_validator(mode="before"\|"after")`                        |
| `@validator(always=True)`               | `mode="before"` (runs even on default)                            |
| `parse_obj(d)` / `parse_raw(s)`         | `model_validate(d)` / `model_validate_json(s)`                    |
| `.dict()` / `.json()`                   | `.model_dump()` / `.model_dump_json()`                            |
| `.copy(update={...})`                   | `.model_copy(update={...})`                                       |
| `orm_mode = True`                       | `from_attributes=True`                                            |
| `allow_population_by_field_name = True` | `populate_by_name=True`                                           |
| `__fields__`                            | `model_fields`                                                    |
| `Field(env="X")`                        | `pydantic-settings`                                               |
| `parse_obj_as(T, x)`                    | `TypeAdapter(T).validate_python(x)`                               |
| `ValidationError.errors()` shape        | new shape (`type`, `loc`, `msg`, `input`); update error consumers |

`bump-pydantic` (Astral) handles ~80%. Run it, review the diff, fix the rest manually.

## Performance — when validation cost matters

- Rust core makes v2 fast, but **validation still costs** in hot loops (queue consumers, batch processors)
- Reuse `TypeAdapter` instances (module-scoped, not per-call)
- Use `model_construct(**data)` to **skip validation** when you trust the source (e.g., loading from your own DB) — bypasses everything, no field coercion, no validators
- `model_dump(mode="json")` is slower than `model_dump_json()` for direct serialization
- `validate_assignment=True` makes every attribute write a validation pass — only enable when you need it

## Common v2 traps

- Forgetting `@classmethod` on `@field_validator` — runtime error, easy to miss
- Mutable defaults: `tags: list[str] = []` works (Pydantic copies) but `Field(default=[])` shares the list — use `default_factory=list`
- `extra="allow"` accepts arbitrary keys and stores them on the model — silent data leak path; default to `"forbid"` on input
- `from_attributes=True` doesn't traverse `@property` that raises — wrap properties that can fail
- `model_validate` on huge dicts allocates everything; for streams use `TypeAdapter` per item
- Strict mode (`Strict=True`) refuses string→int coercion — easy footgun when migrating from v1 lax behavior
- `SecretStr` does NOT auto-mask in JSON dumps unless you also override `__repr__`/serializer — verify what you log

## Anti-patterns

- Pydantic models as your DB layer — they're for boundaries; use Django models / SQLAlchemy in the core
- Catching `ValidationError` and re-raising as `ValueError` — you lose the structured error data
- One mega-model with 50 optional fields — split by use case (CreateIn, UpdateIn, Out)
- `model_dump()` then `json.dumps()` — use `model_dump_json()`, one pass, faster
- v1 and v2 in one project — pin to v2, run `bump-pydantic`, finish the migration
- `Any` in field types — defeats the point; use `Json`, `dict[str, Any]` if truly opaque
- Validators with side effects (DB write, HTTP call) — validators are pure functions
- Computed fields via `@property` returned in `model_dump` — use `@computed_field` (2.0+) so it's typed and serialized

## Hand-off

For FastAPI integration (request/response schemas): `Skill(k0d3:python-fastapi)`. For Django/DRF (where Pydantic stays in the service layer, not the serializer): `Skill(k0d3:python-django)`. For broader Python rules: `Skill(k0d3:python-essentials)`. For static type checking on Pydantic models: `Skill(k0d3:python-ruff-mypy)`.
