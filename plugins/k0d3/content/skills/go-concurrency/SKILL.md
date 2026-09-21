---
name: go-concurrency
description: "Use when writing concurrent Go \u2014 goroutines, channels, context,\
  \ sync primitives, error groups."
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages:
    - go
  status: active
  invokes_shell: false
  shell_reviewed: valksor 2026-05-17
  related:
    - go-essentials
    - go-testing
---

# Go Concurrency

**Iron Law: every goroutine MUST have a stop signal. Before `go func()`, answer three questions — who stops it, where do its errors go, how does the caller know it's done. No answer = no goroutine. `sync.Mutex` is the default; `sync.RWMutex` only after profiling confirms contention with read-dominant workload.**

> Don't communicate by sharing memory; share memory by communicating. — Rob Pike

Channels for ownership and communication; mutexes for protecting state that doesn't move.

## Goroutines

Cheap to start (~2KB stack). Don't start one without knowing:

- Who will stop it
- Where its errors go
- How the caller knows it's done

If you can't answer those, you have a leak.

## Channels

```go
ch := make(chan int, 10)   // buffered (cap 10) or unbuffered (cap 0)

go func() {
    defer close(ch)
    for i := 0; i < 5; i++ { ch <- i }
}()

for v := range ch {
    fmt.Println(v)
}
```

- **Unbuffered**: synchronous; sender blocks until receiver is ready
- **Buffered**: sender blocks only when buffer is full
- **Closing**: only the sender closes. Closing a closed channel panics. Receiving from a closed channel returns the zero value + `ok=false`.

## `context.Context`

Every public function that does I/O or might block takes a `context.Context` as the **first parameter**:

```go
func FetchUser(ctx context.Context, id string) (*User, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", "/users/"+id, nil)
    // ...
}
```

Cancel propagates through the call tree. Always check `ctx.Done()` in loops:

```go
for {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case work := <-workCh:
        process(work)
    }
}
```

## `select`

Multiplex on channels (and other operations like `time.After`):

```go
select {
case msg := <-ch:
    handle(msg)
case <-time.After(5 * time.Second):
    return errors.New("timeout")
case <-ctx.Done():
    return ctx.Err()
}
```

`select` without cases is `select {}` — blocks forever. Use to keep `main` alive.

## `sync.WaitGroup`

Wait for a known set of goroutines:

```go
var wg sync.WaitGroup
for _, item := range items {
    wg.Add(1)
    go func(item Item) {
        defer wg.Done()
        process(item)
    }(item)
}
wg.Wait()
```

Add BEFORE starting; Done in a `defer`. Capture loop variables by parameter (the `func(item Item)` form).

In Go 1.22+, the loop variable is per-iteration already; the explicit capture is no longer required but it's still clear style.

## `errgroup` (golang.org/x/sync/errgroup)

For "fan out, first error wins": cancels `ctx` on first error so other goroutines see `ctx.Done()` and bail. Concurrency limit: `g.SetLimit(N)`.

```go
g, ctx := errgroup.WithContext(ctx)
for _, item := range items {  // Go 1.22+: loop var is per-iteration; no `item := item` needed
    g.Go(func() error { return process(ctx, item) })
}
if err := g.Wait(); err != nil { return err }
```

## Mutex

For protecting state that doesn't have a natural channel owner:

```go
type SafeMap struct {
    mu sync.RWMutex
    m  map[string]int
}

func (s *SafeMap) Get(k string) (int, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.m[k]
    return v, ok
}

func (s *SafeMap) Set(k string, v int) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.m[k] = v
}
```

- **`sync.Mutex` is the default.** Always reach for this first.
- `sync.RWMutex` ONLY after profiling confirms contention AND reads vastly dominate writes (e.g., 100:1+). RWMutex has higher per-call overhead than Mutex and the reader-writer coordination can perform _worse_ than Mutex under moderate write contention.
- Always `defer` Unlock immediately after Lock.

## Common patterns

**Fan-out / fan-in:** N workers reading from `in chan Job`, writing to `out chan Result`. Producer closes `in`. Reader reads `len(jobs)` results from `out`.

**Backpressure:** buffered channel as semaphore — `sem := make(chan struct{}, 10)`, acquire on entry, release on exit.

## Race detection

Always: `go test -race ./...`. Run in CI.

## Common pitfalls

- **Goroutine leaks** (no stop mechanism), **closing channel from multiple senders** (panics), **sending on closed channel** (panics), **forgotten `ctx.Done()`** (uncancellable), **copying `sync.Mutex`** (two mutexes), **loop-var capture pre-1.22** (use param), **`time.Sleep` for sync** (use channels)

## Anti-patterns

- "Fire and forget" I/O goroutines (no error path)
- `sync.Mutex` where a channel expresses intent better (move ownership; don't protect access)
- Oversized buffered channels (masks design problem; right-size or use semaphore)
- Long-lived goroutines without a stop signal (defer to ctx-cancellation)
- Manual `runtime.GOMAXPROCS()` tuning (the runtime usually picks right; profile first)
- `time.After` inside a `for { select { ... } }` loop — allocates a fresh `*time.Timer` per iteration that leaks until it fires. Use `t := time.NewTimer(d); defer t.Stop()` outside the loop, reset with `t.Reset(d)` if needed.

## Red flags

| Smell                                                                                  | Likely problem                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Goroutine started in a function body with no `WaitGroup` / `errgroup` / channel close  | Caller can't wait or detect failure           |
| `chan T` with no buffer in a fan-out — and the producer blocks until ALL workers ready | Producer blocked = pipeline stalled           |
| `RWMutex` chosen for a 70/30 read-write workload                                       | Likely worse than `Mutex` under load          |
| `select { case <-ctx.Done(): default: }` without a sleep                               | Busy loop                                     |
| Mutex held across a network call                                                       | All readers blocked on a remote slow-down     |
| Worker reads `len(jobs)` results from `out` channel                                    | Off-by-one when a worker fails before writing |

## Hand-off

For error wrapping, `Skill(k0d3:go-essentials)` (covers `errors.Is/As/Join`, `fmt.Errorf %w`). For testing concurrent code, `Skill(k0d3:go-testing)`.
