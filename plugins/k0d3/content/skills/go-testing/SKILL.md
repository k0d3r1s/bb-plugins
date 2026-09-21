---
name: go-testing
description: "Use when writing Go tests \u2014 `testing` package, table-driven tests,\
  \ subtests, t.Run, fuzzing, benchmarks, test helpers."
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
    - go-concurrency
    - tdd
---

# Go Testing

**Iron Law: stdlib `testing` only. Table-driven subtests with `t.Run` are the unit of test. `t.Parallel()` on every leaf test that doesn't share global state. `-race` on every CI run. No testify/assert/require — `if !want.Equal(got) { t.Fatalf(...) }` is the form.**

`testing` is in the stdlib. Use it. No third-party test framework needed.

## Basics

```go
// in file_test.go alongside file.go
package foo

import "testing"

func TestAdd(t *testing.T) {
    got := Add(2, 3)
    if got != 5 {
        t.Errorf("Add(2,3) = %d, want 5", got)
    }
}
```

- File: `xxx_test.go`
- Function: `func TestXxx(t *testing.T)`
- Failure: `t.Error` (continues) or `t.Fatal` (stops)
- Skip: `t.Skip("reason")`

## Table-driven tests

```go
func TestValidateEmail(t *testing.T) {
    tests := []struct {
        name  string
        input string
        want  bool
    }{
        {"valid", "a@b.c", true},
        {"empty", "", false},
        {"no at sign", "no-at-sign", false},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if got := ValidateEmail(tt.input); got != tt.want {
                t.Errorf("ValidateEmail(%q) = %v, want %v", tt.input, got, tt.want)
            }
        })
    }
}
```

The Go community standard. Each row is a sub-test (`go test -run TestValidateEmail/valid`).

## Subtests

```go
func TestUser(t *testing.T) {
    t.Run("Create", func(t *testing.T) { ... })
    t.Run("Update", func(t *testing.T) { ... })
    t.Run("Delete", func(t *testing.T) { ... })
}
```

Subtests run independently. Run a specific one: `go test -run TestUser/Create`.

## Parallel tests

```go
func TestSomething(t *testing.T) {
    t.Parallel()
    // ...
}
```

`-parallel N` controls concurrency. Combine with table-driven:

```go
for _, tt := range tests {
    tt := tt   // 1.22+: not needed; older: required to avoid loop-var capture
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        // ...
    })
}
```

## Test helpers

```go
func setupDB(t *testing.T) *sql.DB {
    t.Helper()   // Error reports point to the caller, not here
    db, err := sql.Open(...)
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { db.Close() })
    return db
}

func TestQuery(t *testing.T) {
    db := setupDB(t)
    // ...
}
```

`t.Helper()` makes error messages point at the test, not the helper. `t.Cleanup()` runs after the test (use instead of `defer` for test-level cleanup).

## Examples, benchmarks, fuzz

```go
import ( "fmt"; "reflect"; "testing" )                     // imports the fuzz/example block depends on

func ExampleAdd() {                                         // godoc + asserts via the Output comment
    fmt.Println(Add(2, 3))
    // Output: 5                                            // MUST be its own line at end of func body
}

func BenchmarkValidateEmail(b *testing.B) {                 // `go test -bench=. -benchmem`
    for i := 0; i < b.N; i++ { _ = ValidateEmail("a@b.c") }
}                                                           // sub-benchmarks: b.Run("small", ...)

func FuzzParse(f *testing.F) {                              // `go test -fuzz=FuzzParse`; crashes land in testdata/fuzz/
    f.Add("valid input")
    f.Fuzz(func(t *testing.T, input string) {
        result, err := Parse(input)
        if err != nil { return }
        round, err := Parse(result.String())
        if err != nil { t.Fatalf("re-parse error: %v", err) }
        // != on structs containing pointers/slices/maps compares pointers, never values —
        // use reflect.DeepEqual (or google/go-cmp's cmp.Equal for richer diffs)
        if !reflect.DeepEqual(round, result) {
            t.Errorf("round-trip mismatch: %+v vs %+v", round, result)
        }
    })
}
```

## Mocking + httptest

No stdlib mock framework. Define small interfaces, substitute fakes:

```go
type EmailSender interface { Send(to, body string) error }

type fakeEmail struct { sent []string }
func (f *fakeEmail) Send(to, body string) error { f.sent = append(f.sent, to); return nil }
```

For complex cases, `mockgen` from `go.uber.org/mock` (the original `github.com/golang/mock` was archived in 2023 — don't install that path on new projects). Or use real implementations (in-memory db) where fast.

For HTTP: `httptest.NewRequest` + `httptest.NewRecorder`, or `httptest.NewServer` for a real test server.

## Coverage + race

`go test -cover ./...`; `go test -race ./...`. Both in CI. Aim for behavioral coverage of error paths, not 100% line coverage.

## Integration tests with real services

For tests needing a real Postgres/Redis/Kafka, use [`testcontainers-go`](https://golang.testcontainers.org) — one container per test package, set up in `TestMain`, reused across tests. For in-process gRPC tests, use `google.golang.org/grpc/test/bufconn`. Full snippets: see `references/go-test-integration.md`.

## Anti-patterns

- `assert.Equal(t, ...)` packages — stdlib `t.Errorf` / `t.Fatalf` is fine. House rule across all k0d3 Go skills.
- `setUp` / `tearDown` mocking JUnit — use `t.Cleanup` and helpers
- Sleeping in tests to "wait for goroutine" — use channels or `sync.WaitGroup`
- Tests that depend on order — each `Test*` runs independently
- Mocking the function under test
- `t.Logf` everywhere — `-v` shows them all; noise
- Spinning a real DB without `testcontainers` (e.g., assuming Postgres on localhost:5432) — flaky and CI-hostile

## Red flags

| Smell                                                                  | Likely problem                               |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| Test uses `time.Sleep` to "wait for X"                                 | Race condition masked by timing              |
| Subtests share state via package vars                                  | Order dependence; `-shuffle on` will surface |
| Helper does heavy setup without `t.Cleanup`                            | Resource leak across runs                    |
| `t.Parallel()` missing on a leaf test                                  | Wall time slower than necessary              |
| `if err != nil { t.Log(err); return }`                                 | Test silently passes; should be `t.Fatal`    |
| Mock returns hardcoded values that match exactly what the test asserts | Tautological — not testing the unit          |

## Hand-off

TDD discipline: `Skill(tdd)`. Property-based testing: `Skill(testing-property-based)`. Go idioms, error wrapping, modules, generics: `Skill(go-essentials)`.
