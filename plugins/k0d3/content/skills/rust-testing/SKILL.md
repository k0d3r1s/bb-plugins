---
name: rust-testing
description: Use when testing Rust — unit, integration, doc tests, proptest, criterion, fuzzing, loom for concurrent code.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [rust]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related:
    [
      rust-essentials,
      rust-async-tokio,
      rust-axum-actix,
      tdd,
      testing-strategy,
      testing-property-based,
      testing-fuzzing-mutation,
    ]
---

# Rust Testing

**Iron Law: `#[test]` + integration tests in `tests/`. Doc tests are tests too. Property-based with `proptest` for invariants.**

## Test type vs use case

| Want                                | Use                       | Lives in                        |
| ----------------------------------- | ------------------------- | ------------------------------- |
| Private function / module internals | `#[cfg(test)] mod tests`  | Same file or `src/foo/tests.rs` |
| Public API as a user sees it        | Integration test          | `tests/<name>.rs`               |
| Docs compile and examples work      | Doc test                  | `///` block in source           |
| Property holds for all inputs       | `proptest` / `quickcheck` | unit or integration             |
| Performance regressions             | `criterion`               | `benches/<name>.rs`             |
| Inputs that crash                   | `cargo-fuzz`              | `fuzz/fuzz_targets/`            |
| All interleavings of atomic ops     | `loom`                    | unit test, gated `#[cfg(loom)]` |

## Unit tests

```rust
pub fn parse(s: &str) -> Result<u32, Error> { /* ... */ }

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn parses_decimal() { assert_eq!(parse("42"), Ok(42)); }
    #[test] fn rejects_empty()  { assert!(matches!(parse(""), Err(Error::Empty))); }
}
```

`assert_eq!` for equality. `assert!(matches!(...))` for enum shapes. `assert!(cond, "msg {:?}", ctx)` when failure needs context.

## Integration tests

Each file in `tests/` compiles as a separate crate — exercises the public API exactly as a downstream consumer would.

```
yourcrate/
├── src/lib.rs
└── tests/
    ├── http_api.rs         # one binary
    ├── workflows.rs        # another binary
    └── common/mod.rs       # shared helpers — `common/` (not `common.rs`) so it isn't its own test binary
```

```rust
// tests/http_api.rs
mod common;
#[tokio::test]
async fn round_trips_a_user() {
    let app = common::spawn_app().await;
    let resp = app.client.post("/users").json(&body).send().await.unwrap();
    assert_eq!(resp.status(), 200);
}
```

## Doc tests

Every `///` example with a fenced code block is compiled and run by `cargo test`. They double as compile-checked documentation.

````rust
/// Parse a decimal port.
///
/// ```
/// assert_eq!(yourcrate::parse_port("8080").unwrap(), 8080);
/// ```
pub fn parse_port(s: &str) -> Result<u16, Error> { /* ... */ }
````

Use ` ```no_run ` to compile-only (network/file work). Avoid ` ```ignore ` — silent rot. Prefer real, runnable examples.

## Property-based testing (proptest)

When the relationship between input and output is a _property_, not a fixed example.

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn parse_print_roundtrip(n in 0u32..1_000_000) {
        prop_assert_eq!(parse(&print(n)).unwrap(), n);
    }
}
```

| Pattern   | Example                                        |
| --------- | ---------------------------------------------- |
| Roundtrip | `parse(print(x)) == x`                         |
| Invariant | sort idempotent; length conserved              |
| Oracle    | new fast impl equals known slow impl           |
| Model     | apply N random ops, compare to in-memory model |

`proptest` shrinks failing inputs to the minimal case. Use when example-based tests are not enough.

## Benchmarks (criterion)

```rust
// benches/parse.rs
use criterion::{criterion_group, criterion_main, Criterion, black_box};
fn bench(c: &mut Criterion) {
    c.bench_function("parse 8-digit", |b| b.iter(|| yourcrate::parse(black_box("12345678"))));
}
criterion_group!(benches, bench); criterion_main!(benches);
```

`cargo bench`. `criterion` tracks regressions across runs. Built-in `#[bench]` is unstable — use `criterion`.

## Fuzzing (cargo-fuzz)

For parsers, decoders, anything taking untrusted input.

```rust
// fuzz/fuzz_targets/parse.rs
#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| {
    if let Ok(s) = std::str::from_utf8(data) { let _ = yourcrate::parse(s); }
});
```

`cargo fuzz run parse` until something crashes. Save the corpus.

## Async tests

```rust
#[tokio::test]
async fn fetches() { /* ... */ }

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn under_concurrency() { /* ... */ }
```

For handler-level tests, use `tower::ServiceExt::oneshot` against your `Router` (see `Skill(rust-axum-actix)`).

## Concurrent code: loom

Standard tests run one interleaving. `loom` explores _all_ legal interleavings of atomic operations — finds data races, missed wakeups, ABA bugs. Use only when implementing a lock-free data structure or custom synchronization primitive; for ordinary `Mutex`/channel code, integration tests are enough.

Inside `loom::model(|| { … })`, use `loom::sync::{Arc, atomic::*}` and `loom::thread::spawn` in place of `std`. Run with `RUSTFLAGS="--cfg loom" cargo test --test loom_tests`. **Isolation requirement**: every atomic operation reachable from the test binary must be loom-aware — if a transitive dependency calls `std::sync::atomic`, the test panics at runtime ("atomic used outside loom model"). Keep loom tests in their own integration test (`tests/loom_*.rs`) with minimal deps; do not link the full app.

## Anti-patterns

- Integration tests in `src/` — they run as unit tests with access to internals, defeating the point.
- Ignoring doc tests because "they're slow" — they catch broken examples that mislead users.
- `#[ignore]` without a `// reason: TICKET-123, flaky on Windows CI`. Silent ignored tests rot.
- `cargo test -- --test-threads=1` to "fix" race conditions — fix the race instead.
- `thread::sleep` to wait for async work — use `tokio::time::timeout` + `Notify` or polling with a deadline.
- One giant `#[test]` doing 30 assertions — split so failures localize.
- `unwrap()` in shared test helpers — `.expect("descriptive")` so failures point at the helper.
- Snapshot tests no one reviews on diff — they become rubber stamps.
- Benchmarks under `#[test]` — `cargo test` runs them every time. Use `benches/` + `criterion`.

## Red flags

| Thought                 | Reality                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "I'll add tests later"  | Write one failing test now, watch it fail, then implement.                                                        |
| "It's too hard to test" | The design is the problem — split, inject, or invert dependencies.                                                |
| "Mocks make tests pass" | Tests that lie are worse than no tests. Prefer real implementations against in-memory or container-backed stores. |
| "`#[ignore]` for now"   | Filed a ticket? No? It's gone.                                                                                    |

## Hand-off

Language fundamentals: `Skill(rust-essentials)`. Async test patterns: `Skill(rust-async-tokio)`. axum route tests via `oneshot`: `Skill(rust-axum-actix)`.
