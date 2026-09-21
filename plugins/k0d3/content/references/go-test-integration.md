# Go integration testing — testcontainers + bufconn

Long-form examples for [`go-testing`](../skills/go-testing/SKILL.md). The skill body keeps a one-line pointer here; full snippets live below to stay under the 200-line skill body cap.

## testcontainers-go (real DB / Redis / Kafka in tests)

For tests that need a real Postgres/Redis/Kafka, use [testcontainers-go](https://golang.testcontainers.org). One container per test package, set up in `TestMain`; reuse across tests in that package.

```go
package mything_test

import (
    "context"
    "fmt"
    "log"
    "os"
    "testing"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
)

var pgDSN string

func TestMain(m *testing.M) {
    code, err := run(m)
    if err != nil {
        log.Fatalf("TestMain: %v", err)
    }
    os.Exit(code)
}

// run keeps deferred Terminate() from being skipped by os.Exit.
func run(m *testing.M) (int, error) {
    ctx := context.Background()

    pg, err := postgres.Run(ctx, "postgres:17-alpine",
        postgres.WithDatabase("test"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    if err != nil {
        return 1, fmt.Errorf("start postgres: %w", err)
    }
    defer pg.Terminate(ctx)

    pgDSN, err = pg.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        return 1, fmt.Errorf("dsn: %w", err)
    }

    // Run migrations against the container before tests
    if err := runMigrations(ctx, pgDSN); err != nil {
        return 1, fmt.Errorf("migrate: %w", err)
    }

    return m.Run(), nil
}

func runMigrations(ctx context.Context, dsn string) error {
    // Use your project's migration tool — atlas, goose, dbmate, sqlx, etc.
    // Example with goose:
    //   db := stdlib.OpenDB(*pgConfig)
    //   goose.SetBaseFS(migrationsFS)
    //   return goose.UpContext(ctx, db, "migrations")
    return nil
}

func TestUserRepo(t *testing.T) {
    db, err := pgxpool.New(t.Context(), pgDSN)
    if err != nil { t.Fatal(err) }
    defer db.Close()
    // ... real DB test
}
```

Use `Skill(k0d3:go-pgx)` for connection patterns and `Skill(k0d3:go-sqlc)` for typed query helpers.

For per-test (not per-package) containers, use `testcontainers.CleanupContainer(t, ctr)` instead of `TestMain` — it wires up `t.Cleanup` for you and is the idiomatic v0.42+ pattern.

## gRPC in-process tests with bufconn

For in-process gRPC tests (no socket binding):

```go
import (
    "context"
    "net"
    "testing"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/test/bufconn"
)

func TestOrdersGRPC(t *testing.T) {
    lis := bufconn.Listen(1024 * 1024)
    srv := grpc.NewServer()
    ordersv1.RegisterOrdersServer(srv, &ordersServer{})
    go srv.Serve(lis)
    t.Cleanup(srv.Stop)

    // grpc.NewClient (NOT grpc.DialContext, which is deprecated since grpc v1.58).
    // Pass a contextDialer that calls lis.Dial; the target ("bufnet") is a placeholder.
    conn, err := grpc.NewClient("bufnet",
        grpc.WithContextDialer(func(_ context.Context, _ string) (net.Conn, error) { return lis.Dial() }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { _ = conn.Close() })

    client := ordersv1.NewOrdersClient(conn)
    // ... call RPCs and assert
}
```

No port allocation, no firewall surprises, fully deterministic.
