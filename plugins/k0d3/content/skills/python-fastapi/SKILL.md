---
name: python-fastapi
description: Use when building HTTP APIs with FastAPI — routers, Depends, Pydantic v2 schemas, validation, testing.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [python-essentials, python-testing, postgres, rest-essentials]
  keywords: [fastapi, pydantic, starlette, async-api]
---

# FastAPI

**Iron Law: separate request/response schemas; never return the ORM model. `Depends` for everything that has a lifetime. `async def` only when the route awaits something — for sync-only routes (Django ORM, psycopg2) use plain `def`; FastAPI threadpools it automatically. Mixing sync blocking calls inside `async def` blocks the event loop for ALL requests.**

**Versions:** Current `0.115.x` · No LTS series — _Pydantic v2 mandatory since 0.100; `lifespan` context manager replaces deprecated `on_event`; first-class Annotated-style `Depends`._

## Project layout

```
app/
├── main.py              # FastAPI(), middleware, include_router
├── api/
│   ├── deps.py          # auth, db session, current_user — shared Depends
│   ├── orders.py        # /orders router
│   └── users.py
├── core/
│   ├── config.py        # pydantic-settings
│   └── security.py      # JWT, hashing
├── db/                  # session + ORM models (never returned to clients)
├── schemas/             # Pydantic request/response (the wire contract)
└── services/            # business logic — NOT in route handlers
```

## Routers, not one giant main.py

```python
from fastapi import APIRouter
router = APIRouter(prefix="/orders", tags=["orders"])

@router.post("", response_model=OrderOut, status_code=201)
async def create(payload: OrderIn, svc: OrderService = Depends(get_service)) -> Order:
    return await svc.create(payload)

# main.py:
app.include_router(orders.router)
```

## Pydantic v2 — the data layer

Two schemas per resource: one in, one out. ORM models stay behind the service.

```python
from pydantic import BaseModel, Field, EmailStr, field_validator

class OrderIn(BaseModel):
    sku: str = Field(min_length=1, pattern=r"^[A-Z0-9-]+$")
    qty: int = Field(gt=0, le=10_000)

    @field_validator("sku")
    @classmethod
    def upcase(cls, v: str) -> str:
        return v.upper()

class OrderOut(BaseModel):
    id: int
    sku: str
    qty: int
    status: Literal["pending", "shipped", "cancelled"]

    model_config = {"from_attributes": True}   # build from ORM model
```

`response_model=OrderOut` makes FastAPI serialize through the schema even if you return the ORM object — strips fields you didn't expose.

### Pydantic v1 → v2

| v1                    | v2                                   |
| --------------------- | ------------------------------------ |
| inner `class Config:` | `model_config = {...}`               |
| `parse_obj`           | `model_validate`                     |
| `parse_raw`           | `model_validate_json`                |
| `dict()` / `json()`   | `model_dump()` / `model_dump_json()` |
| `@validator`          | `@field_validator`                   |
| `@root_validator`     | `@model_validator`                   |
| `Field(env=...)`      | `pydantic-settings`                  |

### Model config you actually need

```python
model_config = {
    "from_attributes": True,        # ORM → schema
    "extra": "forbid",              # reject unknown keys on input
    "str_strip_whitespace": True,
    "frozen": True,                 # for value objects
}
```

For union dispatch, use a **discriminated union**: `pet: Cat | Dog = Field(discriminator="type")` — faster and gives clearer errors.

## Depends — for everything with a lifetime

```python
from fastapi import Depends

async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session

async def get_current_user(
    token: str = Depends(oauth2),
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await decode_and_load(token, db)
    if user is None:
        raise HTTPException(401, "invalid token")
    return user
```

| Need                            | Use Depends?                            |
| ------------------------------- | --------------------------------------- |
| DB session / connection         | Yes — yield-based, closes after request |
| Current user / auth             | Yes — single source of 401              |
| Settings                        | Yes — `@lru_cache` the factory          |
| Pagination params               | Yes — reuse across endpoints            |
| Pure function with no resources | No — just call it                       |

Cacheable per-request by default. Override in tests via `app.dependency_overrides[dep] = fake`.

## Errors

`raise HTTPException(404, "order not found")` in handlers; register `@app.exception_handler(DomainError)` once for cross-cutting domain errors. Don't sprinkle `try/except HTTPException` — let it propagate.

## Background tasks vs queue

`BackgroundTasks` runs in-process after the response. Use for: send-and-forget email, cache invalidation, telemetry.

**Use a real queue** (Celery, Arq, Dramatiq) for anything >1s, anything that needs retries, anything that must survive a worker crash, anything scheduled.

## Testing

Use a fixture to manage `dependency_overrides` — placing `.clear()` after the assertion leaks the override into subsequent tests when the assertion fails.

```python
from httpx import AsyncClient, ASGITransport

@pytest.fixture
def override_user():
    # save-and-restore so layered fixtures (e.g., session-scoped admin user) survive teardown
    prev = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_current_user] = lambda: User(id=1, email="t@example.com")
    yield
    if prev is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev

@pytest.mark.asyncio
async def test_create_order(override_user):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        r = await client.post("/orders", json={"sku": "X", "qty": 1})
    assert r.status_code == 201
```

`AsyncClient` + `ASGITransport` is the supported way (`TestClient` is sync — fine for sync code, loses async cleanup). For async tests to collect, set `asyncio_mode = "auto"` under `[tool.pytest.ini_options]` (0.21+ default is "strict").

## Middleware and CORS

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(CORSMiddleware,
    allow_origins=["https://app.example.com"], allow_credentials=True,  # NEVER ["*"] with credentials
    allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
```

## Production checklist

- `uvicorn` with `--workers` matching CPU; `--proxy-headers` behind a load balancer + `TrustedHostMiddleware` so spoofed `Host` headers don't bypass routing
- TLS at reverse proxy; CORS allowlist (not `*`); include `allow_headers=["Authorization", "Content-Type"]` or preflight drops auth
- gzip middleware; rate limiting (`slowapi` or upstream)
- Structured logging (`structlog`); `/health` and `/ready`
- `pydantic-settings` reading from env — crash on missing required vars
- **Disable docs in prod**: `FastAPI(docs_url=None, redoc_url=None, openapi_url=None)` — otherwise `/docs`, `/redoc`, `/openapi.json` expose the full schema unauthenticated
- **JWT validation** (when implementing `decode_and_load`): pass a SINGLE-algorithm list — `algorithms=["HS256"]` for shared-secret tokens (FastAPI's typical default) or `algorithms=["RS256"]` for asymmetric. NEVER omit the list (`alg: none` attack) and NEVER accept multiple algorithm families (RS256+HS256 confusion — verifier treats public key as HMAC secret). Validate `exp`/`iss`/`aud`; rotate signing keys.

## Anti-patterns

- Business logic in route handlers — extract to a service
- Returning ORM models directly (without `response_model`)
- Sync calls in async routes (`time.sleep`, `requests`) — use `to_thread` or async libs
- Heavy work in `BackgroundTasks` — use a queue
- One giant `main.py` — split into routers + services + deps
- `allow_origins=["*"]` with credentials — the browser will refuse anyway, and it's wrong
- Pydantic in hot loops where you can avoid the validation cost
- Mixing Pydantic v1 and v2 in one project
- Reading settings via `os.environ` directly — use `pydantic-settings`

## Red flags

| Thought                                       | Reality                                                              |
| --------------------------------------------- | -------------------------------------------------------------------- |
| "I'll just return the SQLAlchemy model"       | You leak fields, break versioning, and tie the API to the DB schema. |
| "BackgroundTasks is fine for this PDF render" | The worker dies, the user lost their job. Use a queue.               |
| "I'll catch the exception in every handler"   | Use one `exception_handler`.                                         |
| "Depends adds complexity"                     | It IS the framework. Working around it is the complexity.            |

## Hand-off

For async details, type design, and packaging: `Skill(k0d3:python-essentials)`. For test patterns (pytest fixtures, parametrize, async-test setup, hypothesis): `Skill(k0d3:python-testing)`. For Postgres: `Skill(k0d3:postgres)`.
