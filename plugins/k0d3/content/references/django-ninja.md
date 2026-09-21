# Django Ninja 1.3

Complements `Skill(k0d3:python-django)`. Reach here when you want a fast, type-hinted REST API on top of Django without DRF's serializer/viewset machinery — Ninja leans on Pydantic v2 and Python type hints the way FastAPI does, but mounts inside a normal Django project.

**Iron Law: the type hint IS the contract. Every path operation declares its response with `response=Schema`, validates input through a `Schema`, and never returns a raw ORM instance Ninja can't serialize. Auth is a callable passed to the router/api, not a decorator scattered across views.**

**Versions:** Current `1.3.x` · Requires Django `4.2`+, Python `3.7`+, Pydantic `2.x` — _Ninja 1.x is Pydantic v2 only; v1 schemas are gone. `django-ninja-extra` adds class-based controllers + DI if you want a DRF-shaped layout._

## NinjaAPI + Router

```python
# api.py
from ninja import NinjaAPI, Router

api = NinjaAPI(title="Orders", version="1.0.0")     # mounted once in urls.py

orders = Router(tags=["orders"])                     # one router per domain
api.add_router("/orders", orders)

# urls.py
urlpatterns = [path("api/", api.urls)]               # OpenAPI + Swagger at /api/docs
```

One `NinjaAPI` instance per project; split endpoints across `Router`s by domain and `add_router` them. Each `NinjaAPI` gets its own auto-generated OpenAPI schema and Swagger UI — don't instantiate a second `NinjaAPI` unless you genuinely need a separate doc surface (e.g. internal vs public).

## Schemas — Pydantic v2 models

```python
from ninja import Schema, ModelSchema
from pydantic import EmailStr, Field

class OrderIn(Schema):                               # request body
    sku: str = Field(min_length=3, max_length=32)
    qty: int = Field(gt=0)
    note: str | None = None

class OrderOut(Schema):                              # response shape
    id: int
    sku: str
    qty: int
    total_cents: int

class OrderModelOut(ModelSchema):                    # derived from the model
    class Meta:
        model = Order
        fields = ["id", "sku", "qty", "created_at"]
```

`Schema` is a thin subclass of `pydantic.BaseModel` with Django-aware config (`from_attributes=True`), so it reads ORM instance attributes directly — `return order` works when the return type is an ORM-backed `Schema`. Use plain `Schema` for hand-shaped payloads, `ModelSchema` to mirror a model. Keep **separate in/out schemas** once they diverge; don't bend one with optional fields.

## Path operations

```python
@orders.post("/", response={201: OrderOut, 422: ErrorOut})
def create_order(request, payload: OrderIn):         # body inferred from Schema arg
    order = Order.objects.create(sku=payload.sku, qty=payload.qty)  # explicit fields — never **dump (mass-assignment)
    return 201, order                                               # Schema(from_attributes=True) serializes the ORM instance

@orders.get("/{order_id}", response=OrderOut)
def get_order(request, order_id: int):               # path param, type-coerced
    return get_object_or_404(Order, id=order_id)

@orders.get("/")
def list_orders(request, status: str | None = None, limit: int = 20):
    return Order.objects.filter(status=status) if status else Order.objects.all()
```

Path params come from the URL, function args typed as a `Schema` become the body, and remaining scalar args become query params. `response={201: OrderOut, 422: ErrorOut}` maps status codes to schemas — return `(code, obj)` to pick one. Without a `response=` annotation Ninja serializes whatever you return as-is (no validation), which defeats the contract — always annotate.

## Async operations

```python
@orders.get("/{order_id}/async", response=OrderOut)
async def get_order_async(request, order_id: int):
    return await Order.objects.aget(id=order_id)     # Django async ORM (.aget/.acreate)

async for o in Order.objects.filter(active=True):    # async iteration
    ...
```

Mix sync and async operations freely on the same router. Async operations need Django's async ORM methods (`aget`, `acreate`, `aupdate`, `acount`) — or `async for` over a lazy `QuerySet` (above) — plus an ASGI server (uvicorn/daphne); calling a blocking ORM method inside an `async def` raises `SynchronousOnlyOperation`. (`filter()`/`all()` are lazy and sync — there is no `afilter`/`aall`.)

## Auth

```python
from ninja.security import HttpBearer, django_auth

class TokenAuth(HttpBearer):
    def authenticate(self, request, token):
        user = lookup_token(token)                   # return any truthy principal
        return user                                  # None → 401 automatically

api = NinjaAPI(auth=TokenAuth())                     # global default
@orders.get("/me", auth=django_auth)                 # per-op override (session)
def me(request): return {"user": request.auth.username}
```

| Auth                 | Use                                                          |
| -------------------- | ------------------------------------------------------------ |
| `django_auth`        | session cookie — browser clients sharing Django login        |
| `HttpBearer`         | `Authorization: Bearer <token>` — APIs, mobile, service auth |
| `APIKeyHeader/Query` | static API keys in a header or query string                  |
| custom callable      | any `def(request)` returning a principal or `None`           |

`authenticate` returning a falsy value → automatic `401`. The resolved principal lands on `request.auth`. Set a default on `NinjaAPI(auth=...)` and override per-operation; pass a list of auths for "any of these". Compare opaque bearer tokens with `hmac.compare_digest`, not `==` (timing side-channel). **Authentication is not authorization:** a path-param endpoint like `get_order` must still verify the principal may access _that_ object (ownership/tenant check) or you ship an IDOR (OWASP A01).

## Pagination

```python
from ninja.pagination import paginate, LimitOffsetPagination, PageNumberPagination

@orders.get("/", response=list[OrderOut])
@paginate(PageNumberPagination, page_size=50)        # ?page=2
def list_orders(request):
    return Order.objects.all()                       # return the full queryset; Ninja slices it
```

`@paginate` slices the queryset lazily — return the unsliced `QuerySet` and let it apply `LIMIT/OFFSET` at the DB. `PageNumberPagination` (`?page=`) or `LimitOffsetPagination` (`?limit=&offset=`). Always pair list endpoints traversing relations with `select_related`/`prefetch_related` or you N+1, same as DRF.

## Error handling

```python
from ninja.errors import HttpError, ValidationError

@orders.get("/{order_id}")
def get_order(request, order_id: int):
    if order_id < 0:
        raise HttpError(400, "order_id must be positive")   # → {"detail": "..."}

@api.exception_handler(KeyError)                     # map a domain exception globally
def on_key_error(request, exc):
    return api.create_response(request, {"detail": "missing key"}, status=422)
```

Pydantic `ValidationError` on a bad request body auto-returns `422` with the field errors — you don't write that handler. Raise `HttpError(status, msg)` for expected failures; register `@api.exception_handler` to translate domain exceptions into responses once, rather than try/except in every operation.

## Testing

```python
from ninja.testing import TestClient

def test_create_order():
    client = TestClient(orders)                      # mount the router directly
    resp = client.post("/", json={"sku": "ABC", "qty": 2})
    assert resp.status_code == 201
    assert resp.json()["sku"] == "ABC"
```

`TestClient` exercises the router in-process — no live server, no URL routing — so tests are fast and isolated. Mount the specific `Router` (or the `NinjaAPI`) under test. For auth, pass headers: `client.get("/me", headers={"Authorization": "Bearer t"})`. Pair with `pytest-django`'s `db` fixture for ORM access.

## When django-ninja vs DRF vs Strawberry

| Pick             | When                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **django-ninja** | fast type-hinted REST, FastAPI ergonomics, async-first, minimal boilerplate, Pydantic v2   |
| **DRF**          | batteries-heavy REST — admin-style browsable API, mature permissions/throttling, big teams |
| **Strawberry**   | the client needs **GraphQL** — one flexible query surface, federation, subscriptions       |

Ninja wins on speed-to-write and async; DRF wins when you need its ecosystem (`Skill(k0d3:python-django)` → `references/drf.md`). For GraphQL use `Skill(k0d3:python-strawberry-graphql)`. Ninja and DRF can coexist in one project mounted at different URL prefixes — useful when migrating off DRF incrementally.
