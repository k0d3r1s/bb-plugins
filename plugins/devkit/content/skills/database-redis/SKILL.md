---
name: database-redis
description: Use when using Redis — keyspace design, pipelines, pubsub vs streams, expiration, persistence, stampede patterns.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: database
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [postgres, go-essentials, infra-docker-compose, infra-docker-swarm, observability-essentials, security]
---

# Redis

**Iron Law: every key has an explicit TTL or a documented reason it doesn't. Never `KEYS` in prod. Pipeline batched ops. Cache stampede is your responsibility — Redis won't dedupe for you.**

**Versions:** Current `7.4` · No LTS series — _Redis 7.2.x was the last BSD-3 release (Sept 2023); 7.4+ shipped under the RSAL/SSPL dual-license (March 2024). Use Valkey 7.2 / 8.0 if you need a pure-OSS fork. Streams (5.0+), client-side caching (6.0+), functions (7.0+) all assume ≥ 6. Docker: `redis:7-trixie`._

## Data model picker

| Type                  | Use for                                                                                                 | Don't use for                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **string**            | Counters, JSON blobs ≤ 100KB, simple cache                                                              | Anything you need to query inside                     |
| **hash**              | Object-shaped data (`HSET user:42 name X email Y`); fields with independent TTLs (Redis 7.4+ `HEXPIRE`) | Deeply nested objects (flatten or use JSON)           |
| **list**              | FIFO/LIFO queues (LPUSH/RPOP), audit trails, capped recent-N (`LTRIM`)                                  | Pub/sub (use streams); random access                  |
| **set**               | Membership tests (`SISMEMBER`), tag indexes, unique counts (small)                                      | Counting cardinality > 1M (use HyperLogLog `PFCOUNT`) |
| **sorted set (zset)** | Leaderboards, time-bucketed indexes (score = epoch ms), priority queues                                 | Just-membership (use set)                             |
| **stream**            | Event log with consumer groups, replayable, persistent until trimmed                                    | Volatile fan-out (pub/sub is cheaper if loss is OK)   |
| **bitmap / bitfield** | Per-user feature flags, daily-active bitfields                                                          | Anything you'd express in SQL                         |
| **HyperLogLog**       | Unique count over millions with 12KB memory                                                             | Exact counts                                          |
| **geo (zset)**        | `GEOADD`/`GEORADIUS` for proximity                                                                      | Anything not lat/lon                                  |

**Don't use Redis for primary storage** unless you've explicitly chosen it (with persistence config to match). It's a cache + ephemeral coordination layer; Postgres is your source of truth.

## Keyspace naming convention

```
<service>:<entity>:<id>[:<sub>]

user:42:profile          # hash
user:42:sessions         # set
session:abc123           # string (JSON), TTL = session timeout
ratelimit:ip:1.2.3.4     # string counter, TTL = window
lock:order:42            # string, TTL = lock timeout
stream:orders.events     # stream
```

- `:` separator (Redis convention, tools like `redis-cli --scan --pattern` and most dashboards assume it)
- Lowercase, no spaces, ASCII only
- Document your team's keyspace conventions somewhere discoverable — Redis has no schema introspection; the convention IS the schema
- For cluster mode: see `{tag}` co-location below

## Pipelines — every multi-op batch

Each Redis call is a round-trip. 100 sequential `SET`s over a 1ms RTT = 100ms minimum. A pipeline sends all 100 in one TCP write, gets all responses in one read = ~2ms.

```go
// go-redis/v9 — pipeline
pipe := rdb.Pipeline()
for _, k := range keys {
    pipe.Set(ctx, k, v, 5*time.Minute)
}
cmds, err := pipe.Exec(ctx)   // single round-trip
```

Pipelines are NOT atomic — commands interleave with other clients' commands on the server side. For atomicity use **MULTI/EXEC** (`TxPipeline()` in go-redis) which queues commands and executes them in one server-side transaction. **No isolation between MULTI/EXEC and concurrent readers** — Redis is single-threaded on the command-execution loop, so the transaction runs as a contiguous block but observers see committed state, not snapshot.

For atomic compound logic (read-then-write), use **Lua scripts** (`EVAL` / `EVALSHA`). The script runs atomically on the server; no race window. Cache the SHA; ship the script on `NOSCRIPT` error.

## Pub/sub vs Streams

**Pub/sub** (`PUBLISH` / `SUBSCRIBE`):

- Fire-and-forget. **No persistence.** No replay. No consumer groups.
- A message sent while no one is subscribed is **lost forever**.
- Subscribers in a Redis cluster receive only messages published to the same node (use sharded pub/sub `SPUBLISH`/`SSUBSCRIBE` 7.0+ for cluster awareness).
- Use for: transient notifications where loss is OK (cache invalidation hints, "user typing" indicators).

**Streams** (`XADD` / `XREAD` / `XGROUP`):

- Append-only log, persisted to RDB/AOF.
- **Consumer groups** distribute messages across workers (Kafka-style); pending-entries-list (PEL) tracks unacked messages; `XACK` confirms.
- Replayable from any offset.
- Use for: anything where "we lost a message" is bad — order events, work queues, audit trails.

```go
// Producer
rdb.XAdd(ctx, &redis.XAddArgs{Stream: "orders.events", Values: map[string]any{"order_id": id, "kind": "paid"}})

// Consumer (group)
rdb.XGroupCreateMkStream(ctx, "orders.events", "processors", "$")  // start from now
for {
    res, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
        Group: "processors", Consumer: hostname,
        Streams: []string{"orders.events", ">"},   // ">" = new messages only
        Count: 10, Block: 5 * time.Second,
    }).Result()
    if err == redis.Nil || len(res) == 0 { continue }   // Block expired with no messages — normal
    if err != nil { return err }                        // real error — bail to caller for backoff
    for _, msg := range res[0].Messages {
        if err := process(msg); err == nil {
            rdb.XAck(ctx, "orders.events", "processors", msg.ID)
        }
    }
}
```

**Always trim streams** — `XADD ... MAXLEN ~ 1000000` or scheduled `XTRIM`. Untrimmed streams grow forever; OOM-kill follows.

Process the PEL on startup (`XPENDING` + `XCLAIM`) to take over messages from dead consumers — that's the durability story.

## Expiration — semantics worth knowing

| Command                              | Behavior                                                 |
| ------------------------------------ | -------------------------------------------------------- |
| `EXPIRE key 60`                      | TTL set, replaces any existing                           |
| `EXPIREAT key <unix-ts>`             | Absolute deadline                                        |
| `PERSIST key`                        | Remove TTL — key becomes permanent                       |
| `SET key val EX 60`                  | Atomic set-with-TTL — preferred over `SET` then `EXPIRE` |
| `SET key val KEEPTTL`                | Update value, preserve existing TTL                      |
| `HEXPIRE key seconds FIELDS 1 field` | Per-field TTL on hashes (7.4+)                           |

**Operations that drop TTL** (silent): any write that replaces the key without `KEEPTTL`. `SET` without `EX`/`KEEPTTL` resets to no-TTL. `RENAME` preserves; `RESTORE` lets you specify.

Expiration is **lazy + active sample-based**, not exact. A key with `EXPIRE 60` is _eligible_ for deletion at +60s but may persist longer until accessed or sampled. Don't depend on Redis as a precision scheduler — that's not its job.

## Cluster mode — `{hash tag}` for co-location

Cluster shards by `CRC16(key) mod 16384`. Multi-key ops (`MGET`, `MSET`, `SUNIONSTORE`, transactions, Lua scripts touching multiple keys) require all keys to land on the same slot — otherwise `CROSSSLOT` error.

```
# Same slot guaranteed — hash tag in braces is the only thing hashed
user:{42}:profile
user:{42}:sessions
user:{42}:cart
```

Use hash tags **sparingly** — over-tagging creates hot slots. Tag only when you actually do multi-key ops on the bundle (e.g., a Lua script that reads and writes both `cart` and `inventory` for a single user).

`MGET` across 1000 keys without co-location requires the client to scatter-gather — go-redis cluster client does this automatically but each call is N round-trips, not 1.

## Cache-stampede mitigations

The setup: cached value expires; 1000 clients miss simultaneously; all 1000 recompute and write. Database melts.

| Pattern                         | When                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Jittered TTL**                | Always. Add `rand(0, 0.2*TTL)` to every cache write. Spreads expiry across a window instead of a thundering edge.                                                                                             |
| **SETNX lock**                  | One worker recomputes; others wait or serve stale. `SET lock:foo 1 EX 30 NX` — if you got it, recompute; otherwise sleep and retry the GET. Always set TTL on the lock so a dead recomputer doesn't deadlock. |
| **Single-flight (in-process)**  | Coalesce concurrent requests in the same process to one upstream fetch. `golang.org/x/sync/singleflight`. Combine with SETNX for cross-process coalescing.                                                    |
| **Stale-while-revalidate**      | Serve stale value past expiry, async re-fetch in background. Two TTLs: "stale" (serve but trigger refetch) and "expired" (don't serve).                                                                       |
| **Probabilistic early refresh** | When `now > expiry - β * computeCost * ln(rand())`, refresh proactively before expiry. XFetch algorithm.                                                                                                      |

**Don't add per-request locking around `GET`** — you've serialized the cache lookup itself, defeating the cache.

## Persistence — RDB vs AOF

| Mode                       | What                                    | Durability                                                             | Recovery time        |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------- | -------------------- |
| **RDB** (default)          | Periodic snapshot to disk               | Up to `save` interval of data loss (default `3600 1 300 100 60 10000`) | Fast load (one file) |
| **AOF** (append-only file) | Every write logged; replayed on restart | `appendfsync everysec` → ≤1s loss; `always` → near-zero but slow       | Slower (replay)      |
| **Both**                   | RDB snapshot + AOF since snapshot       | Best of both                                                           | Slowest              |

For cache-only Redis: **RDB only** (or even disable persistence — accept cold restart on reboot). For Redis as primary storage (rare): **AOF + RDB**, `appendfsync everysec`.

**`MEMORY` is RAM-bound** — set `maxmemory` and `maxmemory-policy` (`allkeys-lru` for cache, `volatile-lru` if you mix permanent + TTL'd keys, `noeviction` to error on write-when-full which is rarely what you want for a cache).

## Authentication and network exposure (mandatory)

Redis ships with no auth by default. On any non-localhost reachable instance, set both:

- `requirepass <strong-password>` (pre-6 single-user) OR `ACL SETUSER <name> on >password ~prefix:* &channel:* +@read +@write -@dangerous` (6+, preferred — per-user roles, key/channel patterns, command allow-lists).
- `bind 127.0.0.1` (single-host) or `bind 10.0.0.5` (internal IP only). NEVER `bind 0.0.0.0` on a host with a public interface. `protected-mode yes` is a tripwire, not a control.

`requirepass` is the absolute bare minimum. ACLs are required if multiple services share an instance.

**Pub/sub has no per-channel ACL pre-7.0** — any authenticated client could SUBSCRIBE to any channel. 7.0+ ACL `&channel:*` patterns finally lock this down; use them. Without ACLs, treat the channel namespace as fully readable to every connected client.

For threat modeling and broader hardening: `Skill(security)`.

## Common anti-patterns

- **`KEYS pattern` in prod** — O(N) blocking scan over the entire keyspace. Single-threaded server stalls all clients. Use `SCAN` (cursor-based, non-blocking).
- **`MGET` of 10k keys without co-location in cluster** — scatter-gather; latency spikes
- **No TTL on cache writes** — silent slow leak; OOM-kill in 6 weeks
- **Pub/sub for "important" messages** — silently lost when subscribers reconnect; use streams
- **Lua script per request without `EVALSHA` caching** — script source shipped every call
- **`HGETALL` on a million-field hash** — single command, single thread, server stalls
- **Storing JSON blobs and updating fields in app code** — re-write the whole blob every time; use a hash
- **No `maxmemory` configured** — OOM-kill at the OS layer is much worse than `OOM command not allowed`
- **Cluster slot imbalance from one hot hash tag** — measure with `CLUSTER COUNTKEYSINSLOT`
- **Using Redis as a job queue without dead-letter / retry semantics** — use streams + PEL, or a real queue (sidekiq/asynq/bullmq)

## Hand-off

For the durable side of your data: `Skill(postgres)`. For Go client (go-redis/v9) idioms: `Skill(go-essentials)`. For wiring Redis into Docker Swarm with persistence volumes: `Skill(infra-docker-swarm)`. For metrics + slow-log + keyspace-notifications observability: `Skill(observability-essentials)`.
