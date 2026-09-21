---
name: python-uv
description: Use when managing Python deps with uv — lockfile, sync, run, dependency groups, workspaces, replacing pip/poetry/pipenv.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: tooling
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [python-essentials, python-ruff-mypy, infra-docker-images, ci-gitlab-ci]
---

# uv

**Iron Law: commit `uv.lock`. Production installs are `uv sync --frozen` (verbatim lock, no resolution). Never `uv pip install <pkg>` in CI or Docker — it bypasses the lock and silently drifts versions.**

**Versions:** Current `0.5.x` (Astral, Rust) · No LTS series — _0.4 added workspaces; 0.5 stabilized `uv build` and `uv publish`. Replaces pip+pip-tools+virtualenv+pyenv+poetry+pipx for most projects._

## Bootstrap

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh    # standalone binary, no Python required
uv self update                                      # uv updates itself
```

uv ships its own Python builds; `uv python install 3.14` and you're done. No need for pyenv.

## Init a new project

```sh
uv init myproject --python 3.14                     # writes pyproject.toml, .python-version, README
cd myproject
uv add django "djangorestframework>=3.16" pydantic  # adds to [project.dependencies], updates lock
uv add --dev pytest ruff mypy django-stubs          # dependency group "dev"
uv add --group docs sphinx                          # arbitrary named group
```

`uv add` resolves, updates `pyproject.toml`, writes `uv.lock`, and installs into `.venv/` — one command, no separate `pip install -r requirements.txt && pip freeze`.

## Daily commands

| Need                                | Command                                             |
| ----------------------------------- | --------------------------------------------------- |
| Install everything from lock        | `uv sync`                                           |
| Verbatim install (CI, Docker, prod) | `uv sync --frozen`                                  |
| Reinstall only main deps            | `uv sync --no-dev`                                  |
| Install + extra groups              | `uv sync --group docs --group test`                 |
| Add a dependency                    | `uv add <pkg>`                                      |
| Add to a group                      | `uv add --group <name> <pkg>`                       |
| Remove                              | `uv remove <pkg>`                                   |
| Run something in the env            | `uv run pytest` / `uv run python manage.py migrate` |
| Run a one-off tool (isolated)       | `uvx ruff check .` (like `pipx run`)                |
| Upgrade a single dep                | `uv lock --upgrade-package django`                  |
| Upgrade everything                  | `uv lock --upgrade`                                 |
| Show the resolved tree              | `uv tree`                                           |

`uv run` is the entry point you use 100 times a day — it ensures the venv is synced, then exec's. No more "did I activate the venv?"

## Dependency groups

Replaces `[project.optional-dependencies]` extras with a clearer separation between **installable extras** (consumers opt-in) and **development groups** (not part of the published package).

```toml
[project]
dependencies = ["django>=5.2", "djangorestframework>=3.16", "pydantic>=2.10"]

[project.optional-dependencies]                      # extras — published, opt-in via pip install yourpkg[pdf]
pdf = ["pikepdf>=9", "pyvips>=2.2"]

[dependency-groups]                                  # PEP 735 — NOT published, dev-only
dev = ["pytest>=8", "ruff>=0.6", "mypy>=1.10", "django-stubs"]
test = ["pytest-django", "factory-boy", "freezegun"]
docs = ["sphinx>=7"]
```

`uv sync` installs main + `dev` by default. CI test job: `uv sync --group test --group dev`. Production image: `uv sync --frozen --no-dev`.

## Lockfile

`uv.lock` is **cross-platform**, **deterministic**, **committed**. One file resolves Linux+macOS+Windows × Python 3.11-3.14 if your `requires-python` allows them. Format is TOML, designed to be diff-readable in PRs.

- `uv sync --frozen` exits non-zero if the lock doesn't match pyproject — use in CI to catch unrecorded `pyproject.toml` edits
- `uv lock --check` does the same without installing
- Don't hand-edit `uv.lock`; regenerate with `uv lock`

## Workspaces

Multi-package repos (monorepos with shared libs). Root `pyproject.toml`:

```toml
[tool.uv.workspace]
members = ["packages/*"]

[tool.uv.sources]
shared-utils = { workspace = true }                  # resolve to the local workspace member
```

One `uv.lock` at the root governs all members. `uv run --package myapp pytest` runs in a specific member's context.

## Docker — Debian, multi-stage, copy the uv binary in

```dockerfile
FROM python:3.14-trixie AS builder
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.14-slim-trixie
COPY --from=builder /app /app
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
```

- `COPY --from=ghcr.io/astral-sh/uv:<pinned>` — never `:latest`
- `UV_COMPILE_BYTECODE=1` speeds first request after deploy (pre-compiles `.pyc`)
- `UV_LINK_MODE=copy` avoids hardlink warnings on Docker overlay FS
- Two-stage `uv sync`: lock-only first (cached by COPY of just `pyproject.toml` + `uv.lock`), then install the project after the source COPY — maximizes BuildKit cache hits

## CI cache (GitLab CI / GitHub Actions)

```yaml
# .gitlab-ci.yml fragment
cache:
  key: "uv-${{CI_COMMIT_REF_SLUG}}"
  paths:
    - .uv-cache/
variables:
  UV_CACHE_DIR: .uv-cache
test:
  image: python:3.14-trixie
  before_script:
    - curl -LsSf https://astral.sh/uv/install.sh | sh
    - source $HOME/.local/bin/env
  script:
    - uv sync --frozen --group test
    - uv run pytest
```

`UV_CACHE_DIR` lets you cache the download/wheel cache as a CI artifact — first install is slow, every subsequent CI run is sub-second on cache hit.

## pip compatibility

`uv pip install <pkg>` and `uv pip freeze` work as drop-in pip replacements (no lockfile semantics). Use them only for:

- One-off experiments in a throwaway venv
- Quick `pip-tools`-style workflows you haven't migrated yet
- Tooling that explicitly requires a `requirements.txt`

For everything else, `uv add` / `uv sync`.

## Replacing the old stack

| Old tool                          | uv equivalent                      | Notes                                                           |
| --------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `pip install -r requirements.txt` | `uv sync --frozen`                 | Lock is authoritative; no more `pip freeze > requirements.txt`  |
| `pip-compile` (pip-tools)         | `uv lock`                          | Same idea, 10-100x faster, cross-platform                       |
| `python -m venv .venv`            | `uv venv` (auto on first `uv add`) | uv manages it                                                   |
| `poetry add` / `poetry install`   | `uv add` / `uv sync`               | uv is faster; pyproject is standard-shaped (no `[tool.poetry]`) |
| `pipenv install`                  | `uv add`                           | Pipenv is effectively unmaintained                              |
| `pyenv install 3.14`              | `uv python install 3.14`           | uv ships builds; no compilation                                 |
| `pipx run black`                  | `uvx black`                        | Isolated, no install needed                                     |
| `tox`                             | uv + a Makefile or `tox-uv` plugin | uv handles env creation; tox handles matrix                     |

## Anti-patterns

- `uv pip install <pkg>` inside Docker or CI — bypasses lock, drifts versions per build
- Not committing `uv.lock` — every developer resolves differently; "works on my machine"
- `uv sync` without `--frozen` in production — allows resolution; can pick up a new version mid-deploy
- Pinning Python via `pyenv` AND `uv python` — pick one; uv's is enough
- Adding deps by hand-editing `pyproject.toml` then `uv sync` — works, but skips constraint resolution; use `uv add`
- `:latest` for the uv image in Dockerfile — silent version drift
- Forgetting `--no-dev` in production image — pulls in pytest/mypy/ruff to your prod container
- Running `uv` and `pip` side-by-side in the same venv — they share the venv but disagree on what's installed

## Hand-off

For Python language rules (typing, layout, async): `Skill(k0d3:python-essentials)`. For lint+typecheck wiring (ruff, mypy + django-stubs): `Skill(k0d3:python-ruff-mypy)`. For Docker base-image choice (Debian slim, multi-stage patterns): `Skill(k0d3:infra-docker-images)`. For CI integration (GitLab CI cache strategy): `Skill(k0d3:ci-gitlab-ci)`.
