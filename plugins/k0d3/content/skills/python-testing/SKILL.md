---
name: python-testing
description: Use when writing Python tests — pytest patterns, fixtures, parametrization, mocking, async tests, property-based testing.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [python-essentials, tdd, testing-strategy, testing-property-based]
---

# Python Testing

**Iron Law: one behavior per test, test name describes that behavior. `pytest` as the runner (not `unittest`); ecosystem plugins (`pytest-asyncio`, `hypothesis`, `factory_boy`) are welcome — third-party ASSERTION libs (`assert`/`require`/`expects`) are not, stdlib `assert` is the form. `@pytest.fixture` with `yield` is the canonical setup/teardown — never bare setup followed by teardown after the assertion (leaks on failure). Real in-memory DB (sqlite, testcontainers) over mocking the DB.**

Tests are first-class code. They get the same attention to naming, structure, and DRY as production code.

## Test runner

Use **pytest**. The stdlib `unittest` is fine for legacy maintenance; new projects use pytest. No exceptions.

## Anatomy of a good test

```python
def test_user_with_empty_email_is_rejected():
    user = User(email="")
    with pytest.raises(ValidationError, match="email required"):
        user.save()
```

- **One behavior** per test (no "and" in the name)
- **Test name = behavior under test** (`test_<thing>_<condition>_<expected>`)
- **Arrange-Act-Assert** structure, often implicit
- **Specific assertions** (assert what matters, not "is truthy")
- **No conditional logic inside tests** (no `if`, no `for` over data — use parametrize)

## Fixtures

```python
@pytest.fixture
def db():
    conn = create_test_db()
    yield conn
    conn.close()

def test_save(db):
    user = User(email="a@b.c")
    user.save(db)
    assert db.exec("SELECT count(*) FROM users").scalar() == 1
```

Scope: `function` (default), `class`, `module`, `session`. Use the narrowest scope that still gives correctness.

## Parametrize

```python
@pytest.mark.parametrize("email,valid", [
    ("a@b.c", True),
    ("", False),
    ("no-at-sign", False),
    ("a@", False),
])
def test_email_validation(email: str, valid: bool):
    assert User(email=email).is_valid() == valid
```

One test, N cases, clear failure.

## Mocking (sparingly)

```python
from unittest.mock import patch

def test_sends_email_on_signup():
    with patch("myapp.email.send") as mock_send:
        signup(email="a@b.c")
        mock_send.assert_called_once_with("a@b.c", subject="welcome")
```

**Mock at the boundary**, not the function under test. If you mock everything, you're testing your mocks.

Prefer **real components** where the test stays fast:

- Real in-memory db (sqlite, pgmock) over mocked db
- Real HTTP server (responses, httpx_mock) over mocked client
- Real filesystem (tmp_path fixture) over mocked file ops

## Async tests

```python
import pytest

@pytest.mark.asyncio
async def test_async_thing():
    result = await fetch("x")
    assert "x" in result
```

Requires `pytest-asyncio` (or `anyio` for cross-flavor).

## Property-based testing

When you have invariants that should hold over many inputs:

```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_sorted_is_idempotent(xs: list[int]):
    assert sorted(sorted(xs)) == sorted(xs)
```

Hypothesis generates many inputs, shrinks counterexamples.

## Fixtures: composition

```python
@pytest.fixture
def admin_user(db) -> User:
    user = User(email="admin@b.c", role="admin")
    db.add(user)
    return user

def test_admin_can_do_x(admin_user, db):
    ...
```

Smaller, focused fixtures compose better than one mega-fixture.

## Markers

```python
@pytest.mark.slow
def test_long_thing():
    ...
```

Skip with `pytest -m "not slow"`.

## Test discovery

Default: `test_*.py` or `*_test.py`. Test functions start with `test_`. Test classes start with `Test`. **Don't fight the defaults.**

## Conftest

Shared fixtures live in `conftest.py` at the appropriate level. Pytest auto-discovers them.

## Common rationalizations

| Excuse               | Reality                                                         |
| -------------------- | --------------------------------------------------------------- |
| "Hard to mock this"  | Code is too coupled. Use dependency injection.                  |
| "Test setup is huge" | Extract helpers. Still huge? Simplify design.                   |
| "Tests too slow"     | Profile. Often one fixture is the bottleneck; narrow its scope. |
| "Flaky test"         | Find and fix the race. Don't `pytest --reruns`.                 |

## Anti-patterns

- `assert x` without context — `assert x == 5` is searchable
- Multiple assertions per test on unrelated invariants — split
- Stateful tests that depend on order — each test stands alone
- Mocking the function under test
- Magic numbers in assertions — explain with a comment or compute from inputs
- `time.sleep()` in tests — use polling or fix the race

## Hand-off

For TDD discipline: `Skill(k0d3:tdd)`. For language-agnostic test types (unit, integration, e2e, mutation, property-based): `Skill(k0d3:testing-strategy)`, `Skill(k0d3:testing-property-based)`, `Skill(k0d3:testing-fuzzing-mutation)`.
