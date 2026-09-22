# Django LTS Upgrade Path

Linked from `Skill(python-django)`. The daily Django patterns live in the main skill. This reference covers the LTS-to-LTS chain, the hop-by-hop breakage, third-party compatibility, DB backend floors, rollback planning, and recurring pitfalls. Use when planning or executing a Django version migration.

**Iron Law: migrate one minor version at a time with `python -W error::DeprecationWarning manage.py test` green at every stop. Skipping versions hides the deprecations that caused the break.**

## LTS support matrix

| Django  | Released       | Extended support (LTS) ends | Python supported |
| ------- | -------------- | --------------------------- | ---------------- |
| 4.2 LTS | 2023-04        | **2026-04**                 | 3.8 – 3.12       |
| 5.0     | 2023-12        | 2025-04 (EOL)               | 3.10 – 3.12      |
| 5.1     | 2024-08        | 2025-12 (EOL)               | 3.10 – 3.13      |
| 5.2 LTS | 2025-04        | **2028-04**                 | 3.10 – 3.13      |
| 6.0 LTS | 2026-12 target | **2029-12** target          | 3.12+ expected   |

LTS cadence: every 2 years, supported 3 years. Non-LTS releases get 16 months.

## The migration path

**4.2 → 5.2 is the live path now.** Don't jump. Go `4.2 → 5.0 → 5.1 → 5.2`, full test suite green between each.

| Hop           | What breaks                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **4.2 → 5.0** | `USE_DEPRECATED_PYTZ` removed (must be on `zoneinfo`); `models.UserAdmin.get_form` signature; default `SECURE_PROXY_SSL_HEADER` handling. Python 3.8/3.9 dropped — pin Python 3.10+ first. |
| **5.0 → 5.1** | `django.utils.timezone.utc` removed (use `datetime.timezone.utc`); old-style middleware signatures fully gone; `LoginRequiredMiddleware` introduced (opt-in).                              |
| **5.1 → 5.2** | Python 3.10+ required; composite PKs land; async ORM widened; `forms.URLField` `assume_scheme` default flips to `https`.                                                                   |
| **5.2 → 6.0** | Python 3.11 expected to drop; further async ORM consolidation; database backend floor likely Postgres 14+.                                                                                 |

## Deprecation-driven workflow (the only reliable one)

```bash
# Fail the test suite on any deprecation warning
python -W error::DeprecationWarning -W error::PendingDeprecationWarning -m pytest

# pytest equivalent: in pyproject.toml
[tool.pytest.ini_options]
filterwarnings = [
    "error::DeprecationWarning",
    "error::PendingDeprecationWarning",
    "ignore::DeprecationWarning:botocore",  # third-party noise you can't fix
]
```

Run this on the **current** version, fix every warning, **then** bump. Bumping first means you're debugging both your deprecations and the new version's behaviour changes at once — you lose the ability to attribute failures.

## Third-party compatibility — the actual bottleneck

Django itself is the easy part. The breakage comes from third-party libs whose Django-version pin is narrower than yours.

| Library                                | Coupling                                                                              | Watch for                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **DRF (djangorestframework)**          | Major versions track Django LTS — DRF 3.15 supports Django 4.2–5.1; DRF 3.16+ for 5.2 | Serializer field signature changes, `Meta.fields = '__all__'` warnings     |
| **django-stubs**                       | Pinned per Django minor — wrong pin = thousands of false mypy errors                  | Bump in lockstep; sometimes lags Django release by weeks                   |
| **django-stubs-ext**                   | Same coupling as django-stubs                                                         | Must match the mypy plugin version                                         |
| **mypy**                               | mypy + django-stubs version pair                                                      | Check the compatibility table in django-stubs README before bumping either |
| **django-environ / django-environ-2**  | Loose Django coupling, but env parsing changed                                        | Re-validate `.env` parsing after upgrade                                   |
| **channels**                           | Lags Django releases by 1-3 months for major                                          | Block the upgrade until channels supports your target                      |
| **celery / django-celery-beat**        | django-celery-beat lags more than celery itself                                       | Check before bumping                                                       |
| **dj-rest-auth, django-allauth**       | Frequent breaking changes independent of Django                                       | Read CHANGELOG; auth flows often shift                                     |
| **Wagtail / django-CMS**               | Major version pins to a Django range — may force joint bump                           | Plan the joint upgrade                                                     |
| **django-debug-toolbar / django-silk** | Usually fast to support new Django                                                    | Dev-only — fix after prod-critical paths                                   |

**Workflow**: `uv pip compile` (see `Skill(python-uv)`) with the target Django pinned. The resolver will surface every incompatible peer. Fix the floor pins before touching code.

## Database backend floors

| Django        | PostgreSQL min | MySQL min | SQLite min |
| ------------- | -------------- | --------- | ---------- |
| 4.2           | 12             | 8.0       | 3.27       |
| 5.0           | 13             | 8.0       | 3.31       |
| 5.1           | 13             | 8.0       | 3.31       |
| 5.2           | 14             | 8.0.11    | 3.31       |
| 6.0 (planned) | 14+            | 8.0.11+   | 3.31+      |

**If you're on RDS Postgres 13 and bumping to 5.2: upgrade Postgres first.** Backend floor checks happen at startup — your app refuses to boot with a clear error.

## Migration test strategy

1. **Branch per hop.** `upgrade/django-5.0`, then `upgrade/django-5.1`, then `upgrade/django-5.2`. Merge each after CI passes against prod-like data.
2. **Full test suite with warnings-as-errors** at each hop.
3. **Run migrations against a prod-data snapshot.** Schema migrations are usually fine; data migrations may rely on assumptions that break (model fields renamed, signals fired in different order). `pg_restore` a recent prod dump, run `manage.py migrate`, run integration tests.
4. **Re-record `uv lock` (or `pip freeze`) at each hop.** The dependency tree shifts; lock it.
5. **Re-run mypy.** django-stubs version changed; type errors WILL increase even when the code is correct — triage and fix.
6. **Smoke the admin.** Admin breakage doesn't always show in tests but bites users immediately.

## Rollback plan (the one everyone skips)

- **Schema migrations** support `--reverse`, but `RunPython` data migrations frequently have `reverse_code=migrations.RunPython.noop` — i.e., **no real rollback**. Audit your data migrations; if rollback matters, write a real `reverse_code`.
- **Practice the rollback in staging.** "Reversible in theory" has lost data more than once. Run forward → run reverse → verify state — _before_ you commit to production.
- **Old code against new schema** is the hidden risk during deploys. Run a few hours on the new schema with old code paths exercised (canary), so a fast rollback doesn't crash on missing columns.
- **Keep the old Django version in a side branch** for 30 days post-cutover. Removing the upgrade branch immediately removes your fast revert.

## Recurring upgrade pitfalls

- **`USE_DEPRECATED_PYTZ`** — removed in 5.0. If you still have `pytz.timezone(...)` anywhere, switch to `zoneinfo.ZoneInfo(...)` first.
- **Naïve datetimes** — `USE_TZ = True` is the only safe value. 5.x is increasingly strict; 4.2 emitted warnings, 5.x emits errors in more code paths.
- **Middleware reordering** — Django periodically adds new middleware (e.g., `LoginRequiredMiddleware` in 5.1). Read the release notes' "MIDDLEWARE" diff and insert at the documented position, not the bottom.
- **Template engine deprecations** — `{% load %}` tag libraries that were autodiscovered may need explicit registration; `format_html` vs `mark_safe` rules tighten each release.
- **Custom user models** — `AbstractUser` / `AbstractBaseUser` API additions occasionally collide with overridden methods. Read release notes for the auth app at every hop.
- **`makemigrations` shows phantom changes after upgrade** — usually a default-value formatting change in the field's `deconstruct()`. Generate and commit the no-op migration; don't fight it.
- **Async ORM partial-API surface** — 5.x adds `aget`/`acreate`/`aall` but not every queryset method has an async sibling. Code that worked under 4.2 sync-only may have been accidentally awaiting sync calls; 5.x tightens.

## `python_requires` discipline

Pin `requires-python` in `pyproject.toml` to match Django's Python support floor for your target version. Django will refuse to import on unsupported Python — clear error. Subtler: `pip install` will resolve to an older Django that _does_ support your Python, silently undoing the upgrade. UV's resolver surfaces this loudly; pip's older resolver does not.

```toml
[project]
# For Django 5.2:
requires-python = ">=3.10,<3.14"
dependencies = [
  "django>=5.2,<5.3",
  "djangorestframework>=3.16,<3.17",
]
```

## Anti-patterns specific to upgrades

- Bumping two minor versions in one PR — failures become unattributable
- Bumping Django without bumping django-stubs in lockstep — type checker explodes
- Ignoring `DeprecationWarning` in CI — every one becomes a 5.x error
- Upgrading on Friday afternoon with no rollback rehearsed
- Letting `USE_DEPRECATED_PYTZ = True` linger because "it still works" — it doesn't, in 5.0+
- Skipping the data-migration replay against prod-snapshot data — schema migrations look clean until they don't
- Pinning Django but not django-stubs / django-stubs-ext — mypy lies about types
- Upgrading the framework before the DB backend — boot-time crash
- Treating LTS-to-LTS as one hop — it's a chain of minors; walk it
