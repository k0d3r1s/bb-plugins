# Django REST Framework — full patterns

Linked from `Skill(python-django)`. The Django skill carries the summary (when DRF, the Iron Law, the serializer/viewset/permission decision tables). Use this reference when actually building a DRF API — serializers, viewsets, permissions, pagination, throttling, schema generation, nested-serializer N+1, and file uploads.

**Iron Law: never return ORM querysets without `select_related`/`prefetch_related` on every serializer that traverses a relation. Permissions live on the view, not in `get_queryset`. Schema is `drf-spectacular`, generated, not hand-written.**

**Versions:** Current `3.15.x` · Tracks Django `4.2`/`5.x` — _DRF 3.15 adds Django 5 + Python 3.12 support; DRF 3.16 adds Django 5.2 + Python 3.13. drf-spectacular replaces the deprecated coreapi schema generator (removed since DRF 3.13)._

## Serializers — Model vs vanilla

| Shape                                  | Pick                                         |
| -------------------------------------- | -------------------------------------------- |
| Mirrors a model 1:1, CRUD over ORM     | **`ModelSerializer`**                        |
| Aggregates across models, custom shape | **`Serializer`** (vanilla)                   |
| Write-only nested input                | vanilla input + `ModelSerializer` for output |
| GeoJSON / file uploads / actions       | vanilla                                      |

```python
class OrderSerializer(serializers.ModelSerializer):
    user_email = serializers.EmailField(source="user.email", read_only=True)
    password   = serializers.CharField(write_only=True)         # never echoed back

    class Meta:
        model = Order
        fields = ["id", "sku", "qty", "user_email", "password", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_sku(self, value: str) -> str:
        if not value.isupper(): raise serializers.ValidationError("sku must be upper")
        return value
```

**Two serializers per resource** (input + output) once they diverge — don't bend one with `read_only`/`write_only` tags past 3 fields. `source="user.email"` traverses FK; pair with `select_related("user")` in the view or you N+1.

## Views — APIView vs ViewSet

| Endpoint shape                     | Pick                                        |
| ---------------------------------- | ------------------------------------------- |
| Single non-CRUD action             | `APIView` (or `@api_view`)                  |
| Standard CRUD against a model      | **`ModelViewSet`** + router                 |
| Read-only listing                  | `ReadOnlyModelViewSet`                      |
| Mostly CRUD + 1-2 custom actions   | `ModelViewSet` + `@action`                  |
| Multi-step process, not a resource | `APIView`; don't force the verb in a router |

```python
class OrderViewSet(viewsets.ModelViewSet):
    queryset = Order.objects.select_related("user").prefetch_related("items")
    serializer_class = OrderSerializer
    permission_classes = [IsAuthenticated, IsOrderOwnerOrStaff]
    pagination_class = CursorPagination
    filter_backends = [DjangoFilterBackend, OrderingFilter]
    filterset_fields = ["status"]; ordering_fields = ["created_at"]

    def get_queryset(self):                                         # tenant scoping
        return super().get_queryset().filter(user=self.request.user)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        order = self.get_object(); order.cancel(); return Response(status=204)
```

Router URLs are generated: `router.register("orders", OrderViewSet)` → list/create/retrieve/update/destroy + `/orders/{id}/cancel/`.

## Permissions

Compose with `&`/`|`:

```python
permission_classes = [IsAuthenticated & (IsAdmin | IsOrderOwner)]
```

| Class                   | Use                                                  |
| ----------------------- | ---------------------------------------------------- |
| `IsAuthenticated`       | Default for every non-public endpoint                |
| `IsAdminUser`           | Staff-only admin endpoints                           |
| `AllowAny`              | Login, signup, public docs — be explicit             |
| Custom `BasePermission` | Per-object rules — implement `has_object_permission` |

**Tenant scoping goes in `get_queryset`** (filter rows), **authz goes in permissions** (block action). Mixing them silently leaks data: a user who can't `has_object_permission` still sees the row exists via 403 vs 404 difference. Filter in the queryset and return 404 for inaccessible rows.

## Pagination

Three built-ins. Pick **once per project**, set `DEFAULT_PAGINATION_CLASS`:

| Class                   | Trade-off                                                              |
| ----------------------- | ---------------------------------------------------------------------- |
| `CursorPagination`      | Stable under writes; opaque cursor; **default for any list >10k rows** |
| `LimitOffsetPagination` | Familiar; breaks under writes; OK for stable read-mostly data          |
| `PageNumberPagination`  | Browser-friendly; same offset problems                                 |

```python
class StandardCursor(pagination.CursorPagination):
    page_size = 50; max_page_size = 200; ordering = "-created_at"
```

Override per-view via `pagination_class`. Always set `max_page_size` — clients will ask for `?limit=100000`.

## Throttling

```python
REST_FRAMEWORK = {
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"user": "1000/hour", "anon": "60/hour", "login": "5/min"},
}

class LoginView(APIView):
    throttle_classes = [ScopedRateThrottle]; throttle_scope = "login"
```

In-memory throttle cache is per-process and useless behind multiple Gunicorn workers — back with **Redis** via `CACHES["default"]`. Set tighter scopes on auth/signup; abuse lands there first.

## drf-spectacular — schema is generated

```python
SPECTACULAR_SETTINGS = {"TITLE": "MyApp API", "VERSION": "1.0.0", "SERVE_INCLUDE_SCHEMA": False}

@extend_schema(
    request=OrderCreateIn, responses={201: OrderOut, 400: ErrorOut},
    parameters=[OpenApiParameter("expand", str, enum=["items"], required=False)],
    tags=["orders"], examples=[OpenApiExample("typical", value={"sku": "ABC", "qty": 1})],
)
def create(self, request): ...
```

Use `@extend_schema_view` to annotate ViewSet actions in one decorator. CI step: `manage.py spectacular --file schema.yml --validate` — fails build on drift. Lock the spec with Spectral.

For mypy + `djangorestframework-stubs[compatible-mypy]` setup (add `mypy_drf_plugin.main` to `plugins`): `Skill(python-ruff-mypy)`.

## N+1 traps with nested serializers

Every `source="x.y"`, `SerializerMethodField` that calls a related manager, or nested serializer adds queries. Defaults:

- FK / O2O on the serializer → `select_related("fk_name")` in the view queryset
- Reverse-FK / M2M nested list → `prefetch_related("items")` (or `Prefetch("items", queryset=...)` to scope)
- `SerializerMethodField` doing `obj.foo_set.filter(...)` → `Prefetch(..., to_attr="cached_foos")`, then read `obj.cached_foos`
- Assert with `django_assert_num_queries(N)` in tests — budget every list endpoint

## File uploads

```python
class UploadView(APIView):
    parser_classes = [MultiPartParser]
    def post(self, request):
        f = request.FILES["file"]                                    # an InMemoryUploadedFile
        if f.size > 50 * 1024 * 1024: raise ValidationError("file too large")
        if f.content_type not in {"image/png", "image/jpeg"}: raise ValidationError("bad type")
        return Response(...)
```

Stream to GCS/S3 directly when files >50MB — don't buffer in Django process memory. `content_type` from the client is untrusted; sniff with `python-magic` for anything user-facing.

## Anti-patterns

- Returning the ORM queryset without eager loading → guaranteed N+1
- Authz in `get_queryset` (e.g., raising 403) instead of `permission_classes` — wrong layer, harder to test
- `Serializer.save()` doing business logic — push to a service, keep serializer as I/O shape
- `fields = "__all__"` — leaks new columns on schema change; enumerate
- `ModelViewSet` with 80% of methods overridden — drop to `GenericViewSet` + explicit mixins
- Schema written by hand instead of generated — drifts in one sprint
- `request.data["foo"]` without serializer validation — back to PHP days
- Throttle scopes shared across login + general API — auth gets throttled by traffic spikes
- Custom auth class that doesn't return `(user, auth)` tuple — silently breaks `request.user`

## Red flags

| Thought                                     | Reality                                             |
| ------------------------------------------- | --------------------------------------------------- |
| "I'll add the eager load later"             | Latency is already in production logs.              |
| "ModelSerializer is fine for everything"    | Aggregates and multi-source shapes need vanilla.    |
| "Hand-writing OpenAPI is more accurate"     | It drifts the first time someone forgets. Generate. |
| "Throttling later, we don't have abuse yet" | Login endpoint says hi.                             |

## Hand-off

For Django ORM/migrations/admin: `Skill(python-django)`. For REST contract design (status codes, error shape, pagination): `Skill(rest-essentials)`. For Pydantic v2 (validation in service layer, not DRF): `Skill(python-pydantic-v2)`. For authn/authz patterns: `Skill(security)`. For test patterns (`assertNumQueries`, factory_boy): `Skill(python-testing)`.
