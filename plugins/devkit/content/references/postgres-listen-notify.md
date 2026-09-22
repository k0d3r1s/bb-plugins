# Postgres LISTEN/NOTIFY — Full Workflow

Linked from `Skill(postgres)`. The summary lives in the main skill. Use this reference when actually building with LISTEN/NOTIFY — transactional semantics, connection topology, Python and Go recipes, observability, multi-tenant trust boundary.

**Iron Law: NOTIFY is best-effort fan-out, not a durable queue. Listeners that disconnect lose every message they missed. Treat the payload as a hint; reconcile state from a table.**

The 8000-byte payload cap is hard-coded (`NOTIFY_PAYLOAD_MAX_LENGTH` in source — requires recompile to raise). Mechanism is unchanged across 16/17/18.

## Mechanism in one paragraph

`NOTIFY <channel>, '<payload>'` enqueues a message on a per-database, in-memory queue. Every session that previously issued `LISTEN <channel>` on the **same database** receives it. Cross-database fan-out is impossible. Payload is **UTF-8 text only, max 8000 bytes**. Channel names follow identifier rules — case-folded unless quoted.

## Transactional semantics — this is the whole game

| Action                               | When listeners see it                                       |
| ------------------------------------ | ----------------------------------------------------------- |
| `NOTIFY x, 'p'` inside a tx          | At `COMMIT`. Rolled-back tx sends nothing.                  |
| Duplicate `NOTIFY x, 'p'` in same tx | **Collapsed to one delivery** (same channel + same payload) |
| `NOTIFY` from a function             | Same — defers to the outer tx's commit                      |
| Listener fires a NOTIFY back         | Standard tx rules; can fan-out further                      |

The collapse rule bites you when you expect "I emitted N events" — Postgres dedupes identical (channel, payload) tuples per transaction. To force distinct delivery, include a serial id or timestamp in the payload.

## Connection ergonomics — session state, not pooled state

`LISTEN` is **session-local**. Two consequences:

1. **One physical connection per listener process.** You cannot share a pooled connection.
2. **PgBouncer in transaction mode breaks `LISTEN`.** Either use **session pooling** for listener connections, or bypass the pooler entirely. App writes via NOTIFY work fine through transaction pooling.

In practice: split the connection topology — pooled connections for the app's reads/writes (including the `NOTIFY` sender), a dedicated direct-or-session-pooled connection per listener process.

## Reconnection — gap detection is your job

When a listener reconnects, it MUST re-issue `LISTEN <channel>`. **Any NOTIFY that fired while disconnected is gone.** Recovery: on reconnect, run a reconciliation query against the source-of-truth table for anything newer than the last processed marker.

```sql
-- worker tracks last_seen_id in its local state
SELECT id, payload FROM jobs
WHERE id > :last_seen_id AND status = 'pending'
ORDER BY id
FOR UPDATE SKIP LOCKED;
```

## Use cases (good fits)

- Procrastinate's wake-up signal — inserts to `procrastinate_jobs` fire a `NOTIFY`; workers wake immediately rather than polling. Reconciliation = the `procrastinate_jobs` table.
- Cross-process cache invalidation — "user 42 changed; flush in-memory caches." Losing one is acceptable (TTL catches it).
- Real-time UI push to long-poll / SSE endpoints — a few hundred events/sec.
- Low-volume audit fan-out — feed a single secondary process (search index reindex) when small numbers of rows change.

## Anti-cases (use something else)

| Need                                                    | Use instead                                   |
| ------------------------------------------------------- | --------------------------------------------- |
| High-volume event stream (>1000/sec sustained)          | Kafka, Redis Streams, NATS JetStream          |
| Cross-database / cross-cluster fan-out                  | Kafka, logical replication, CDC (Debezium)    |
| Durable delivery (disconnected listeners must catch up) | Kafka, RabbitMQ, or a polled outbox table     |
| Payload larger than 8000 bytes                          | Pass an ID; let the listener `SELECT` the row |
| Ordered, partitioned delivery                           | Kafka with partition keys                     |
| At-least-once with ACKs                                 | A real queue (Procrastinate, Celery, SQS)     |

## Python recipe — psycopg3 async

```python
import asyncio
import psycopg
from psycopg import AsyncConnection

DSN = "postgresql://app@db/reports"  # listener connection — NOT pooled, NOT via PgBouncer-tx

async def listen_loop() -> None:
    attempt = 0
    while True:
        try:
            async with await AsyncConnection.connect(DSN, autocommit=True) as conn:
                await conn.execute("LISTEN job_inserted")
                attempt = 0                                # reset on successful connect
                async for notify in conn.notifies():
                    # notify.channel, notify.payload, notify.pid
                    await handle(notify.payload)
        except psycopg.OperationalError:
            # PG restart, network blip — exponential backoff, reconnect, re-LISTEN, reconcile
            await asyncio.sleep(min(2 ** attempt, 30))
            attempt = min(attempt + 1, 10)                 # cap so the formula doesn't overflow
            await reconcile_since_last_processed()

async def handle(payload: str) -> None:
    job_id = int(payload)  # payload is a hint; load the row
    ...
```

`autocommit=True` is required — `LISTEN` must not sit inside an open transaction or notifications buffer until commit, defeating the point.

## Go recipe — pgx

```go
ctx := context.Background()
conn, err := pgx.Connect(ctx, "postgres://app@db/reports")  // direct, not pooled
if err != nil { return err }
defer conn.Close(ctx)

if _, err := conn.Exec(ctx, "LISTEN job_inserted"); err != nil { return err }

for {
    n, err := conn.WaitForNotification(ctx)
    if err != nil {
        // reconnect + re-LISTEN + reconcile
        return err
    }
    handle(n.Payload)  // n.Channel, n.PID also available
}
```

Use `pgx.Conn` (single connection), **not** `pgxpool.Pool`, for the listener. The pool checks out for the duration of a query; `WaitForNotification` would block one pool slot indefinitely.

## Sender side — fire from a trigger or app

```sql
CREATE OR REPLACE FUNCTION notify_job_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('job_inserted', NEW.id::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_job_inserted
AFTER INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION notify_job_inserted();
```

Use `pg_notify(channel, payload)` (function form) rather than `NOTIFY` (statement) when the channel name is dynamic — `NOTIFY` requires a literal identifier, and constructing one from user input via dynamic SQL in PL/pgSQL is an injection primitive.

## Observability

- **`pg_notification_queue_usage()`** — fraction of the shared queue in use. Alert at >50%. A slow listener can block the queue; sustained backpressure aborts `NOTIFY` calls with `out of shared memory`.
- **Notification rate** — count `NOTIFY` calls per channel; correlate with listener processing rate.
- **Listener liveness** — heartbeat (worker pings a row every N seconds); alert if stale. A silently-dead listener loses every NOTIFY without an error surface.
- **Reconnect counter** — per-listener metric. Spikes indicate network/PG instability and likely missed messages.

## Trust boundary — every listener sees every NOTIFY on the channel

`NOTIFY` fans out to ALL sessions listening on the channel within the same database. No per-listener filter, no row-level security on the payload, no ACL on channels.

- **Multi-tenant database** — putting tenant-scoped data in a NOTIFY payload exposes it to every listener including other tenants' workers. Either use tenant-prefixed channel names (`tenant_42_jobs`) and audit each worker only LISTENs to its own, or keep payloads tenant-opaque (IDs only) and let the listener authorize on the row fetch.
- **Channel name in `NOTIFY <name>`** must be a literal identifier — constructing from user input via dynamic SQL is SQL injection. Use `pg_notify(channel_text, payload)` (function form) when variable; that form quotes the channel name safely.

## Anti-patterns

- Treating NOTIFY as durable — every disconnect = lost messages
- Putting the work payload in the NOTIFY — instead pass the ID, fetch from the table
- Putting tenant-scoped data in a shared-channel payload — every listener on the channel reads it
- Listener connection through PgBouncer transaction pooling — silently broken
- `LISTEN` inside a transaction without `autocommit` — notifications buffer until commit
- Multiple `NOTIFY x, 'same'` in one tx expecting N deliveries — deduped to one
- No reconciliation on reconnect — gap = lost work
- Using NOTIFY for cross-database events — it doesn't cross DBs
- Payload >8000 bytes — `ERROR: payload string too long`
- Holding the listener connection in `pgxpool` / SQLAlchemy pool — pool slot stuck forever
- Building channel names with string concatenation in PL/pgSQL — injection vector; use `pg_notify()` function form
