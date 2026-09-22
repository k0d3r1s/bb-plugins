---
name: python-django
description: Use when working in Django — models, views, ORM, migrations, REST APIs with DRF, pytest-django.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [python-essentials, python-testing, python-uv, python-ruff-mypy, rest-essentials, security, postgres, sql]
---

# Django

**Iron Law: `on_delete` is mandatory. Eager-load with `select_related`/`prefetch_related` or you'll N+1. `USE_TZ = True`, always.**

**Versions:** LTS `4.2` (EOL 2026-04), `5.2` (EOL 2028-04) · Current `5.2` · Next `6.0` LTS (2026-12 target, EOL ~2029-12) — _5.2 drops Python 3.10 support; async ORM widening (`aget`, `acreate`, async iteration); composite primary keys (5.2). 6.0 will drop Python 3.11._

## When to pick Django

- You need the admin out-of-the-box
- You want batteries (auth, sessions, forms, signals, migrations, ORM) integrated
- Mostly server-rendered or hybrid SSR + light JS
- The team already knows it

**Don't pick Django for** microservices, lightweight async APIs (use FastAPI), or anything where the admin and ORM aren't earning their keep.

## Project layout

```
project/
├── manage.py
├── project/settings/{base,dev,prod}.py        # split by env; secrets from os.environ
├── project/{urls,asgi,wsgi}.py
├── apps/orders/{models,views,urls,admin}.py   # + migrations/ + services.py (logic OUT of views/models)
└── pyproject.toml
```

Split settings by environment. Never commit secrets — read from env in `base.py` (`os.environ["DJANGO_SECRET_KEY"]` to crash on missing).

## Models — `on_delete` and indexes

```python
from django.db import models
from django.db.models import Q
class Order(models.Model):
    user = models.ForeignKey(
        "users.User",
        on_delete=models.PROTECT,        # default: refuse to delete user with orders
        related_name="orders",
    )
    sku = models.CharField(max_length=50, db_index=True)
    qty = models.PositiveIntegerField()
    status = models.CharField(
        max_length=20,
        choices=[("pending", "Pending"), ("shipped", "Shipped"), ("cancelled", "Cancelled")],
        default="pending",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["user", "-created_at"])]
        constraints = [models.CheckConstraint(check=Q(qty__gt=0), name="qty_positive")]

    def __str__(self) -> str:
        return f"Order({self.sku}x{self.qty})"
```

**Defaults**: `on_delete=PROTECT` (use `CASCADE` only when child has no meaning without parent — line items); `null=False` (only when DB nullability is the truth, rare on FKs); `blank` mirrors `null` for form-only nullability; add indexes for actual filter/order patterns; `__str__` is required (admin and shell are unusable without it).

## Views — FBV vs CBV

| Shape                          | Pick                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| One-off endpoint, custom logic | **Function-based**                                               |
| Standard CRUD against a model  | **Class-based generic** (`ListView`, `DetailView`, `CreateView`) |
| REST API                       | **DRF** (see REST APIs below) or FastAPI for async-first         |
| Lots of branching/auth/state   | **Function-based** — readable beats clever                       |

```python
def order_detail(request, pk: int):
    order = get_object_or_404(
        Order.objects.select_related("user"),    # eager-load FK to avoid N+1
        pk=pk,
    )
    if order.user != request.user and not request.user.is_staff:
        raise PermissionDenied
    return render(request, "orders/detail.html", {"order": order})
```

## ORM — N+1 is the enemy

| Pattern                     | Use                                                        |
| --------------------------- | ---------------------------------------------------------- |
| Forward FK / O2O in a loop  | `select_related("user", "address")` (SQL JOIN)             |
| Reverse FK or M2M in a loop | `prefetch_related("items")` (separate query + Python join) |
| Need aggregate per row      | `.annotate(order_count=Count("orders"))`                   |
| Need just one column        | `.values_list("email", flat=True)`                         |
| Bulk insert                 | `Model.objects.bulk_create([...])`                         |
| Bulk update                 | `Model.objects.bulk_update(objs, ["field"])`               |
| `EXISTS` check              | `.filter(...).exists()` — never `len(qs) > 0`              |
| Iterate huge result         | `.iterator(chunk_size=2000)`                               |

**Always** run `django-debug-toolbar` or `django-silk` in dev. Set a query-count budget per view and assert it in tests with `assertNumQueries`.

## REST APIs — Django REST Framework

Building a JSON API over these models? DRF is the layer. **Iron Law: eager-load every serializer that traverses a relation (`select_related`/`prefetch_related` in the view queryset); permissions live on the view, not in `get_queryset`; schema is generated with `drf-spectacular`, never hand-written.**

| Need                  | Reach for                                                         |
| --------------------- | ----------------------------------------------------------------- |
| Serialize a model 1:1 | `ModelSerializer` (vanilla `Serializer` for cross-model shapes)   |
| CRUD over a model     | `ModelViewSet` + router (`@action` for extra verbs)               |
| Authorize an action   | `permission_classes` (`IsAuthenticated`, custom `BasePermission`) |
| Page a large list     | `CursorPagination` for >10k rows; always set `max_page_size`      |
| Rate-limit            | throttle scopes, Redis-backed behind multiple workers             |

Set the view queryset to `Order.objects.select_related("user").prefetch_related("items")` — a serializer's `source="user.email"` or a nested list N+1s without it. Tenant-scope in `get_queryset` and return 404 for inaccessible rows; authorize the action in `permission_classes` (mixing the two leaks row existence via 403-vs-404). Full patterns (serializer Model-vs-vanilla, APIView vs ViewSet, pagination trade-offs, throttling, drf-spectacular, nested-serializer N+1, file uploads, anti-patterns): `references/drf.md`.

## Migrations — forward-only in practice

`python manage.py makemigrations orders && python manage.py migrate`.

- Reversible migrations are a fiction outside test envs. Assume forward-only.
- `RunPython` for data migrations. **Always idempotent** (re-runnable). Pair with `reverse_code=migrations.RunPython.noop`.
- Squash old migrations once shipped everywhere (`squashmigrations`).
- Feature branches' migration numbers collide on merge — regenerate after merge, don't hand-edit `dependencies`.
- Schema + data in one migration is OK for small changes; split when one phase is slow.

## Settings split

```python
# settings/base.py
SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]    # crash early on missing
DEBUG = False
ALLOWED_HOSTS: list[str] = []
USE_TZ = True                                   # NON-NEGOTIABLE
TIME_ZONE = "UTC"
DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": os.environ["DB_NAME"], ...}}
```

Activate via `DJANGO_SETTINGS_MODULE=project.settings.prod`. Use `django-environ` or `pydantic-settings` if env parsing gets gnarly.

## Testing — pytest-django + factory_boy

```python
@pytest.mark.django_db
def test_create_order(user_factory):
    order = Order.objects.create(user=user_factory(), sku="X", qty=1)
    assert order.status == "pending"

@pytest.mark.django_db
def test_list_view_query_count(django_assert_num_queries, client, user):
    client.force_login(user)
    with django_assert_num_queries(3):     # budget: assert it, don't hope for it
        client.get("/orders/")
```

Use `factory_boy` or `model_bakery` for fixtures — `Model.objects.create` everywhere yields brittle tests.

## Admin

```python
@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "sku", "qty", "status", "created_at")
    list_filter = ("status",); search_fields = ("user__email", "sku")
    autocomplete_fields = ("user",)         # never raw FK widget on big tables
    list_select_related = ("user",)         # admin N+1 mitigation
```

## Async + version upgrades

Django 4.1+ has async views; 4.2+ adds async ORM (`aget`, `acreate`, `aall`); 5.x extends further. Mix sync via `sync_to_async`/`async_to_sync`. Django remains primarily sync — if async-everything matters, pick FastAPI. For a fast type-hinted REST layer over Django (an alternative to DRF), see `references/django-ninja.md`.

Don't jump 4.2 → 5.2 in one PR — walk the minors (`4.2 → 5.0 → 5.1 → 5.2`), suite green at each hop, deprecation warnings as errors on the current version _before_ bumping (`python -W error::DeprecationWarning -m pytest`). Real breakage is third-party pins (DRF, django-stubs, channels), not Django itself. DB floor: 5.2 needs Postgres 14+. **Full workflow** (hop breakdowns, third-party matrix, rollback): `references/django-upgrade-path.md`.

## Anti-patterns

- Business logic in templates or views — push to `services.py`; fat models go to mixins
- N+1 queries: missing `select_related` / `prefetch_related`; querysets evaluated in templates
- Naïve datetimes (`datetime.now()`) with `USE_TZ=True` — use `timezone.now()`
- `len(qs)` for count/existence — use `.count()` / `.exists()`
- Hand-editing migration `dependencies` after a merge — regenerate
- `SECRET_KEY` defaulted in code; `DEBUG=True` read from env without a guard
- `mark_safe(user_input)` or `|safe` filter on user content — direct XSS; let autoescape do its job
- String-interpolated raw SQL (`cursor.execute(f"... {var}")`, `Model.objects.raw(f"...")`) — SQL injection; use params: `cursor.execute("... %s", [val])`
- `@csrf_exempt` on a state-changing view without an equivalent token check — CSRF vector
- Race-prone concurrent writes: acquire a row lock with `select_for_update()` inside `transaction.atomic()` — skipping causes lost updates
- Side effects in views (email send, queue publish) — use `transaction.on_commit(lambda: ...)` so they don't fire on rollback
- Bumping two minor Django versions in one PR — failures become unattributable
- Ignoring `DeprecationWarning` in CI ("warnings, not errors") — every one becomes a 5.x error

## Red flags

| Thought                                      | Reality                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| "I'll add the index later"                   | Production query is already slow. Add it now.                          |
| "`CASCADE` is the default"                   | It deletes data silently. `PROTECT` is the default until you decide.   |
| "The admin is slow"                          | Missing `list_select_related` or `autocomplete_fields`. Fix the query. |
| "I'll fix the N+1 later"                     | Customers will fix it for you, loudly.                                 |
| "Naïve datetime is fine, it's just a script" | DST will make a fool of you. `USE_TZ = True`.                          |
| "I'll skip the test for the migration"       | Data migrations break on real data. Test them.                         |
| "LTS-to-LTS is one hop"                      | It's a chain of minors. Walk it.                                       |

## Hand-off

For Postgres-specific concerns: `Skill(postgres)`. For testing: `Skill(python-testing)`. For broader Python rules: `Skill(python-essentials)`. For the full DRF REST API patterns: `references/drf.md`. For REST contract design: `Skill(rest-essentials)`. For dependency resolution and lockfiles during an upgrade: `Skill(python-uv)`. For ruff/mypy + django-stubs pinning: `Skill(python-ruff-mypy)`. For the full LTS upgrade workflow: `references/django-upgrade-path.md`.
