---
name: python-ruff-mypy
description: Use when configuring Python lint + type-check — ruff (lint+format), mypy strict mode, django-stubs, pre-commit wiring.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: tooling
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [python-essentials, python-django, python-uv, ci-gitlab-ci]
---

# Ruff + mypy

**Iron Law: ruff replaces black + flake8 + isort + pyupgrade — pick ruff, delete the others. mypy in `strict` mode from day one (incrementally per-module on legacy). Every `# type: ignore` MUST have a code: `# type: ignore[arg-type]` — bare ignores silently mask future bugs.**

**Versions:** ruff `0.8.x`, mypy `1.13.x`, django-stubs `5.1.x` · — _ruff 0.8 enables `format` as the canonical formatter (no more parallel black); django-stubs 5.x supports Django 5.1+. Both move fast — pin in `pyproject.toml` to keep CI stable._

## ruff — lint AND format, one tool

```toml
# pyproject.toml
[tool.ruff]
line-length = 100
target-version = "py312"                  # match your floor; pyupgrade rules use this
src = ["src", "tests"]

[tool.ruff.lint]
select = [
    "E", "W",      # pycodestyle
    "F",           # pyflakes — real bugs
    "I",           # isort — import order
    "B",           # bugbear — common pitfalls
    "UP",          # pyupgrade — modernize syntax
    "S",           # bandit — security
    "SIM",         # simplify
    "RUF",         # ruff-specific
    "DJ",          # flake8-django
    "ASYNC",       # async pitfalls (blocking calls in async funcs)
    "TCH",         # typing imports under TYPE_CHECKING
]
ignore = [
    "E501",        # handled by formatter
    "S101",        # `assert` — fine in pytest
]

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101", "S105", "S106"]              # asserts + hardcoded test secrets
"**/migrations/*.py" = ["E501", "RUF"]             # generated
"**/settings/*.py" = ["F405", "F403"]              # wildcard re-exports across env files

[tool.ruff.lint.isort]
known-first-party = ["yourpkg"]
combine-as-imports = true
```

Commands: `ruff check .` (lint), `ruff check --fix .` (autofix safe rules), `ruff format .` (replaces black), `ruff format --check .` (CI gate). **Don't enable `ALL`** — ~800 rules, many conflicting. Start with the list above; add families as you hit their need.

## Rule families worth knowing

| Family           | What it catches                                                            |
| ---------------- | -------------------------------------------------------------------------- |
| `F` (pyflakes)   | Unused imports, undefined names, redefined-while-unused — real bugs        |
| `B` (bugbear)    | Mutable defaults, `for x in dict: del dict[x]`, function calls in defaults |
| `UP` (pyupgrade) | PEP 604 unions, built-in generics, and f-strings over `.format`            |
| `S` (bandit)     | `eval`, `shell=True`, hardcoded creds, weak hashes                         |
| `SIM`            | `if x: True else: False` → `bool(x)`, mergeable ifs                        |
| `TCH`            | Move runtime-unused imports under `if TYPE_CHECKING:`                      |
| `ASYNC`          | `time.sleep` in async fn, `open()` in async fn, blocking HTTP              |
| `DJ`             | Django-specific (nullable CharField, missing `__str__`)                    |

## mypy — strict from day one

```toml
[tool.mypy]
python_version = "3.12"
strict = true                              # enables 10+ flags below in one shot
plugins = ["mypy_django_plugin.main"]      # django-stubs
warn_unused_ignores = true                 # flag stale `# type: ignore`
warn_redundant_casts = true
warn_unreachable = true
no_implicit_reexport = true                # imports in __init__.py must be in __all__ or aliased
disallow_any_unimported = true             # untyped 3rd-party deps become explicit Any failures
show_error_codes = true                    # required for `# type: ignore[code]` discipline

[[tool.mypy.overrides]]
module = ["yourpkg.legacy.*"]              # carve out legacy code that can't be strict yet
disallow_untyped_defs = false
disallow_incomplete_defs = false

[[tool.mypy.overrides]]
module = ["some_unstubbed_lib.*"]          # explicitly mark deps as untyped
ignore_missing_imports = true

[tool.django-stubs]
django_settings_module = "project.settings.dev"
```

`strict = true` is shorthand for: `disallow_untyped_defs`, `disallow_any_generics`, `disallow_subclassing_any`, `disallow_untyped_calls`, `disallow_untyped_decorators`, `disallow_incomplete_defs`, `check_untyped_defs`, `no_implicit_optional`, `warn_return_any`, `strict_equality`, `extra_checks`.

## django-stubs

`pip install django-stubs[compatible-mypy]`. The plugin reads your settings, so it resolves `Manager[Order]`, `QuerySet[Order]`, etc. correctly. Gotchas:

- `objects: Manager[Self]` is added automatically by the plugin — don't redeclare
- Reverse relations need explicit annotation on the parent model in a `TYPE_CHECKING` block
- `request.user` types as `AbstractBaseUser | AnonymousUser` — narrow with `if request.user.is_authenticated:` before access
- Custom managers: subclass `Manager[YourModel]` so the return type carries
- For DRF: `pip install djangorestframework-stubs[compatible-mypy]`, add `mypy_drf_plugin.main` to `plugins`

## Narrowing — make the type checker happy without `Any`

```python
def process(obj: object) -> str:
    assert isinstance(obj, str), f"expected str, got {type(obj)}"
    return obj.upper()                     # mypy now knows obj: str

def first_int(items: list[int | None]) -> int:
    for x in items:
        if x is not None:                  # narrows int | None → int
            return x
    raise ValueError("no int")

# TypeGuard for custom predicates (3.10+)
from typing import TypeGuard
def is_str_list(v: list[object]) -> TypeGuard[list[str]]:
    return all(isinstance(x, str) for x in v)
```

Prefer `assert isinstance`, `is None`, `isinstance` over `cast(...)`. `cast` is a runtime no-op — if you're wrong, the bug surfaces 6 months later.

## `# type: ignore` discipline

```python
# WRONG — silent
x = legacy_function()  # type: ignore

# RIGHT — code + reason, will warn if the underlying error disappears
x = legacy_function()  # type: ignore[no-untyped-call]  # upstream missing stubs, tracked in #1234
```

With `warn_unused_ignores = true`, stale ignores fail CI. That's the point — you delete them when the upstream fix lands.

## pre-commit wiring

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.8.2
    hooks:
      - id: ruff
        args: [--fix, --exit-non-zero-on-fix]
      - id: ruff-format
  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.13.0
    hooks:
      - id: mypy
        additional_dependencies:
          - django-stubs[compatible-mypy]==5.1.1
          - djangorestframework-stubs[compatible-mypy]==3.15.2
          - pydantic>=2.10
        args: [--config-file=pyproject.toml]
        files: ^(src|tests)/.*\.py$
```

mypy in pre-commit runs in its own venv with `additional_dependencies` — keep these pinned to match `uv.lock` or you get drift between local hook and CI.

Bootstrap: `uv run pre-commit install`. First run is slow; subsequent runs hit cache.

## CI wiring (GitLab CI)

```yaml
lint:
  image: python:3.14-trixie
  script:
    - curl -LsSf https://astral.sh/uv/install.sh | sh && source $HOME/.local/bin/env
    - uv sync --frozen --group dev
    - uv run ruff check .
    - uv run ruff format --check .
    - uv run mypy src tests
```

Three commands, three failure modes, clear logs. Don't merge lint + format + typecheck into one — first failure masks the others.

## Anti-patterns

- Running black + ruff side-by-side — pick ruff, delete black
- `select = ["ALL"]` — turns on conflicting rules; noisy; nobody fixes anything
- Bare `# type: ignore` without a code — `warn_unused_ignores` can't help you
- `cast(X, value)` to silence mypy — runtime no-op; use `assert isinstance` instead
- `Any` in new code — defeats the purpose; narrow with `Protocol`/`TypeGuard`/`isinstance`
- Disabling mypy per-file via `# type: ignore` at top of file — quarantine in `[[tool.mypy.overrides]]` instead so it's visible
- Ignoring `ASYNC` family — sync `requests.get()` inside an async view will block the entire worker
- pre-commit with `language_version` pinned to a system Python — uses host Python, drifts from project version

## Hand-off

For Python language idioms (typing, naming, layout): `Skill(k0d3:python-essentials)`. For Django-specific lint targets and the django-stubs settings module: `Skill(k0d3:python-django)`. For dep management feeding `additional_dependencies` pins: `Skill(k0d3:python-uv)`. For wiring these checks into pipelines: `Skill(k0d3:ci-gitlab-ci)`.
