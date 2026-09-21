---
name: go-grpc
description: "Use when building gRPC services in Go \u2014 protobuf, code generation,\
  \ interceptors, streaming, deadlines, error model."
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
---

# gRPC in Go

**Iron Law: every RPC needs a deadline on the client and a typed `codes.*` on the server. Never propagate raw infrastructure errors to the client. Use `ChainUnaryInterceptor` for multiple interceptors — `UnaryInterceptor` is single-slot.**

Schema-first RPC with HTTP/2, binary protocol, codegen for client + server. Great for internal microservices; less ideal for browser clients (use grpc-web or REST + OpenAPI).

## Toolchain

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
brew install bufbuild/buf/buf    # recommended for managing protos
```

## .proto schema

```proto
syntax = "proto3";
package orders.v1;
option go_package = "github.com/you/yourapp/gen/orders/v1;ordersv1";

service Orders {
  rpc CreateOrder(CreateOrderReq) returns (Order);
  rpc StreamUpdates(StreamReq) returns (stream OrderUpdate);
  rpc BulkCancel(stream BulkCancelReq) returns (BulkCancelResp);
}
message CreateOrderReq { string sku = 1; int32 qty = 2; }
message Order { string id = 1; string sku = 2; int32 qty = 3; OrderStatus status = 4; google.protobuf.Timestamp created_at = 5; }
enum OrderStatus { ORDER_STATUS_UNSPECIFIED = 0; ORDER_STATUS_PENDING = 1; ORDER_STATUS_SHIPPED = 2; }
```

- Package versioned in path (`orders.v1`); `option go_package` matches the import path; first enum value = `UNSPECIFIED` (0 is the default).

## Server

```go
import (
    "google.golang.org/grpc"
    ordersv1 "github.com/you/yourapp/gen/orders/v1"
)

type ordersServer struct {
    ordersv1.UnimplementedOrdersServer
    // dependencies
}

func (s *ordersServer) CreateOrder(ctx context.Context, req *ordersv1.CreateOrderReq) (*ordersv1.Order, error) {
    if req.GetSku() == "" {
        return nil, status.Error(codes.InvalidArgument, "sku required")
    }
    order, err := s.db.Insert(ctx, req)
    if err != nil {
        // Log the raw error server-side; return a generic message to the client.
        // `%v` on a pgx error leaks SQLSTATE codes, table/column names, etc.
        s.log.ErrorContext(ctx, "order insert failed", "err", err)
        return nil, status.Error(codes.Internal, "could not create order")
    }
    return order, nil
}

func main() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("listen: %v", err)
    }
    srv := grpc.NewServer(
        // ChainUnaryInterceptor: pass each interceptor as an arg, NOT multiple UnaryInterceptor calls.
        // grpc.UnaryInterceptor(a) followed by grpc.UnaryInterceptor(b) panics ("already set").
        grpc.ChainUnaryInterceptor(loggingInterceptor, authInterceptor, metricsInterceptor),
        grpc.ChainStreamInterceptor(streamLoggingInterceptor),
        grpc.MaxRecvMsgSize(4 << 20),  // 4 MB; tune per service. Default is 4 MB; cap it explicitly.
    )
    ordersv1.RegisterOrdersServer(srv, &ordersServer{})
    if err := srv.Serve(lis); err != nil {
        log.Fatalf("serve: %v", err)
    }
}
```

**Embed `UnimplementedOrdersServer`** — gives forward compatibility when new RPCs are added to the schema.

## Errors

Use `google.golang.org/grpc/status` + `codes`:

```go
return nil, status.Error(codes.NotFound, "order not found")
return nil, status.Errorf(codes.InvalidArgument, "qty=%d invalid", req.Qty)
```

Standard codes: `OK`, `Canceled`, `Unknown`, `InvalidArgument`, `DeadlineExceeded`, `NotFound`, `AlreadyExists`, `PermissionDenied`, `ResourceExhausted`, `FailedPrecondition`, `Aborted`, `OutOfRange`, `Unimplemented`, `Internal`, `Unavailable`, `DataLoss`, `Unauthenticated`.

Map domain errors at the boundary. Don't pass internal errors through. **Never** use `status.Errorf(codes.Internal, "...: %v", err)` on a database or filesystem error — it leaks SQLSTATE codes, table names, and file paths to clients. Log the raw error server-side; return a generic message.

## Interceptors (middleware)

Use `grpc.ChainUnaryInterceptor(a, b, c)` to register multiple — `grpc.UnaryInterceptor` accepts only one and silently or noisily overwrites on a second call.

```go
import "log/slog"

func loggingInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
    start := time.Now()
    resp, err := handler(ctx, req)
    // Structured logging via slog — never log.Printf (unstructured, unredactable).
    // err.Error() may contain raw infrastructure detail; keep this log internal-only.
    slog.InfoContext(ctx, "rpc",
        "method", info.FullMethod,
        "duration_ms", time.Since(start).Milliseconds(),
        "err", err,
    )
    return resp, err
}
```

For trace IDs, auth tokens, and request correlation, use `metadata.FromIncomingContext(ctx)` to read and `metadata.NewOutgoingContext(ctx, md)` to forward when calling downstream services.

Common interceptors: auth, logging, metrics (`grpc-ecosystem/go-grpc-middleware`), tracing (OpenTelemetry).

## Streaming

```go
// Server streaming: for-range over a context-bound channel, Send each
// Client streaming: Recv loop until io.EOF, then SendAndClose
// Bidirectional: Recv() and Send() both work, often concurrently in separate goroutines
```

Server-streaming handler signature: `(req *X, stream Server_FooServer) error`. Client-streaming: `(stream Server_BarServer) error`, finish with `stream.SendAndClose(&resp)`.

## Client

```go
conn, err := grpc.NewClient("localhost:50051",
    grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{})), // insecure.NewCredentials() in dev only
    grpc.WithUnaryInterceptor(clientInterceptor),
)
if err != nil { log.Fatalf("dial: %v", err) }
defer conn.Close()
client := ordersv1.NewOrdersClient(conn)
ctx, cancel := context.WithTimeout(parentCtx, 5*time.Second); defer cancel()
order, err := client.CreateOrder(ctx, req)
```

The deadline propagates over the wire; server's `ctx.Done()` fires when it expires.

## Reflection, health, buf

- **Reflection**: `reflection.Register(srv)` enables `grpcurl ... list`. Don't ship in prod.
- **Health checks**: `health.NewServer()` + `healthpb.RegisterHealthServer`.
- **buf**: `buf lint`, `buf breaking --against '.git#branch=main'`, `buf generate`. Cleaner than raw `protoc`.

## Anti-patterns

- Mutating proto-generated structs in handlers (treat as immutable)
- Catching all errors and returning `codes.Internal` with `%v`-formatted detail — map to specific codes AND scrub messages
- Streaming when unary would do (overkill for one-shot calls)
- No deadlines (server processes hang forever)
- Mixing gRPC and HTTP/REST in the same service without a clear plan (gRPC-gateway is a thing if you need both)
- Not enabling TLS in production: `credentials.NewTLS(&tls.Config{...})` on `grpc.NewServer` and `grpc.WithTransportCredentials(credentials.NewTLS(...))` on `grpc.Dial`
- Schema evolution without back-compat discipline: **changing a field number is a break** (consumers decode garbage); **removing a field requires deprecation** (mark `reserved` to prevent reuse); `oneof` field changes break wire compatibility. Proto3 has no `required` keyword — all fields are optional by default; clients can omit any field
- `grpc.UnaryInterceptor(a)` followed by `grpc.UnaryInterceptor(b)` — second call panics or overwrites. Use `grpc.ChainUnaryInterceptor(a, b)`
- Forwarding upstream metadata blindly into downstream calls without filtering — auth tokens, trace IDs, and PII flow unchecked

## Red flags

| Smell                                                                    | Likely problem                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `status.Errorf(codes.Internal, "...: %v", err)` on a DB or network error | Leaks SQLSTATE / table names / hostnames to clients                       |
| `lis, _ := net.Listen(...)`                                              | Server starts on whatever port is available; reuses old listener silently |
| Two `grpc.UnaryInterceptor` calls                                        | Second silently wins; first interceptor is lost                           |
| No `grpc.MaxRecvMsgSize` cap                                             | Default 4 MB; client-stream RPCs can OOM the server with crafted input    |
| `grpc.WithTransportCredentials(insecure.NewCredentials())` outside test  | Plaintext on the wire in prod                                             |
| Interceptor uses `log.Printf`                                            | Unstructured logs — can't redact, can't filter                            |
| Long-lived stream with no deadline                                       | Goroutine leak when client goes away                                      |

## Hand-off

For Go idioms and error wrapping (`errors.Is/As`, `fmt.Errorf %w`), `Skill(k0d3:go-essentials)`. For concurrency patterns in interceptors and stream handlers, `Skill(k0d3:go-concurrency)`. For testing gRPC services with `bufconn`, `Skill(k0d3:go-testing)`.
