---
name: rust-async-tokio
description: Use when writing async Rust with Tokio — futures, select!, spawn, cancellation safety, structured concurrency.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [rust]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [rust-essentials, rust-axum-actix, rust-testing]
---

# Rust Async (Tokio)

**Iron Law: every async function is cancellation-safe. `select!` is sharp; structured concurrency with `JoinSet` beats spawned-and-forgotten.**

## The mental model

An `async fn` returns a `Future` — inert until polled. A runtime (Tokio) polls it. At every `.await`, the task may be suspended _or dropped_. "Dropped mid-await" is the common case, and your code must be correct under it.

```rust
async fn fetch(url: &str) -> Result<Bytes> {
    let resp = client.get(url).send().await?;   // may be cancelled here
    let body = resp.bytes().await?;             // or here
    Ok(body)                                    // partial state must be safe to drop
}
```

## When sync beats async

| Workload                           | Pick                                          |
| ---------------------------------- | --------------------------------------------- |
| CPU-bound, no I/O                  | sync threads (`rayon`, `std::thread`)         |
| Few connections, simple flow       | sync `std::net` is fine                       |
| Many concurrent I/O, network-heavy | async + Tokio                                 |
| Mixed CPU + I/O                    | async runtime + `spawn_blocking` for CPU work |

Async is not a free perf upgrade. It is a concurrency model with real costs (binary size, complexity, debug difficulty).

## Spawning: pick the right tool

| Need                                                    | Use                                              |
| ------------------------------------------------------- | ------------------------------------------------ |
| Fire-and-forget background task (logger flush, metrics) | `tokio::spawn`                                   |
| N tasks, wait for all, propagate panics                 | `JoinSet`                                        |
| 2-3 concurrent futures, await all                       | `tokio::join!`                                   |
| 2-3 concurrent futures, take whichever finishes first   | `tokio::select!`                                 |
| Bounded parallelism over an iterator                    | `futures::stream::iter(...).buffer_unordered(N)` |
| CPU-bound work                                          | `tokio::task::spawn_blocking`                    |

```rust
// structured: cancel-on-drop, panics propagate
let mut set = JoinSet::new();
for url in urls { set.spawn(fetch(url)); }
while let Some(res) = set.join_next().await {
    let bytes = res??;   // task panic vs fetch error
    handle(bytes);
}
```

`tokio::spawn` returns a `JoinHandle` — drop it and the task keeps running. If you don't await it, it's a fire-and-forget orphan. **Default to `JoinSet` so panics surface and tasks are joined.**

Spawned futures must be `Send + 'static`. `Rc<T>`, `RefCell<T>`, non-`Send` mutexes, and borrowed references all fail at the spawn boundary with a cryptic "future cannot be sent between threads" error. Use `Arc<T>` + `tokio::sync::Mutex`/`RwLock`. Single-thread runtime (`#[tokio::main(flavor = "current_thread")]`) drops the `Send` requirement — useful for CLIs and tests.

## Cancellation patterns

| Pattern                               | Use                                                         |
| ------------------------------------- | ----------------------------------------------------------- |
| Drop the future                       | Simplest; works when types are cancel-safe                  |
| `tokio::select!` with a cancel branch | Race work against a `CancellationToken` or shutdown channel |
| `tokio_util::sync::CancellationToken` | Cooperative cancellation across many tasks                  |
| Timeouts                              | `tokio::time::timeout(dur, fut).await`                      |

```rust
tokio::select! {
    biased;                                            // deterministic poll order
    _ = cancel.cancelled() => Err(Cancelled),
    result = work() => result,
}
```

**`select!` requires cancellation-safe futures** in losing branches. `tokio::time::sleep`, `Notify::notified`, channel `recv` are safe. `AsyncReadExt::read_exact` is NOT — partial reads are lost. Wrap unsafe futures in a `tokio::spawn` + oneshot to make them droppable.

## The `Mutex`-across-`.await` trap

```rust
// WRONG — holds std::sync::Mutex across .await; deadlocks under load
let guard = state.lock().unwrap();
do_async(&guard).await;   // ❌
```

Two fixes:

```rust
// 1. Drop the guard before await
let value = { let g = state.lock().unwrap(); g.clone() };
do_async(&value).await;

// 2. Use tokio::sync::Mutex when the critical section MUST span an await
let g = state.lock().await;
do_async(&g).await;   // ok — async-aware mutex
```

`tokio::sync::Mutex` is slower than `std::sync::Mutex`. Default to `std::sync::Mutex`; only use the async one when you genuinely need to hold across `.await`.

## Pin: just enough to be dangerous

Most users never write `Pin` manually. Encounter it when:

- Implementing `Future` by hand → use `pin_project_lite` to get safe field access.
- Storing a future in a struct → `Box::pin(fut)` and you're done.
- Self-referential structs → use a library (`ouroboros`, `async-stream`) or restructure.

If you're reaching for raw `Pin::new_unchecked`, stop and find another way.

## Channels

| Channel                  | When                                            |
| ------------------------ | ----------------------------------------------- |
| `tokio::sync::mpsc`      | Multi-producer, single-consumer streams         |
| `tokio::sync::oneshot`   | Single response — RPC return values             |
| `tokio::sync::broadcast` | Fan-out events to many subscribers              |
| `tokio::sync::watch`     | "Latest value" — config reload, state snapshots |
| `flume` / `crossbeam`    | Sync code, or sync↔async bridging               |

**Always pass a capacity** to `tokio::sync::mpsc::channel(N)`. `tokio::sync::mpsc::unbounded_channel()` exists but is a memory-DoS waiting to happen — a slow consumer plus a fast producer = OOM. Use bounded unless you've proven the producer is rate-limited upstream.

## Anti-patterns

- Calling blocking I/O (`std::fs`, `reqwest::blocking`, heavy CPU loops) inside async → starves the runtime. Use `tokio::fs`, async clients, or `spawn_blocking`.
- Holding `std::sync::Mutex` / `RefCell` across `.await`.
- `tokio::spawn` without a `JoinHandle` you'll await — orphan tasks, lost panics.
- `select!` on a non-cancel-safe future in a losing branch — silent data loss.
- `async fn` that never awaits — just make it sync.
- `block_on` inside async code — deadlocks the runtime.
- `Arc<Mutex<T>>` shared across many tasks for everything — often a message-passing actor is cleaner.

## Red flags

| Thought                                      | Reality                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "I'll just `block_on` here"                  | You're in an async context — this deadlocks. Refactor to async, or `spawn_blocking`.      |
| "Cancellation is rare, I'll handle it later" | Drop happens every `select!` loss, every timeout, every client disconnect.                |
| "More tasks = more speed"                    | Tasks are cheap but not free; bound parallelism with `buffer_unordered` or a `Semaphore`. |
| "I need `async-trait` everywhere"            | Rust 1.75+ supports `async fn` in traits natively for most cases.                         |

## Hand-off

For ownership, errors, traits: `Skill(rust-essentials)`. For axum handlers (built on Tokio): `Skill(rust-axum-actix)`. For testing async code with `tokio::test` and `loom`: `Skill(rust-testing)`.
