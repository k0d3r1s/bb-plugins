---
name: postgres
description: Use when designing or operating Postgres — schema, indexes, JSONB, partitioning, replication, pooling, LISTEN/NOTIFY.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: database
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [sql, migrations-overview, orm-overview, python-job-queues]
  keywords: [production, prod, database, postgresql]
---

# Postgres

**Iron Law: `NOT NULL` by default. Every FK has explicit `ON DELETE`. `timestamptz`, never naïve. UUID v7 or `bigint GENERATED ALWAYS AS IDENTITY` for PKs. Constraints in the database; app validation is advisory. NOTIFY is best-effort fan-out, not a durable queue.**

**Versions:** Current `18` · Previous `17` (until 2029-11) · Supported `16` (until 2028-11) — _18 ships async I/O (`io_method` configurable), stats preserved through `pg_upgrade` (no more first-day plan chaos), native `uuidv7()`, OAuth client auth, B-tree skip scans. 17 was the vacuum + streaming-I/O overhaul. Per-version feature deep-dive + upgrade gotchas: `references/postgres-version-features.md`._

## Schema rules (non-negotiable)

| Subject      | Rule                                                                 | Why                                                                            |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Nullability  | `NOT NULL` unless absence is meaningful                              | NULLs poison comparisons, aggregates, joins                                    |
| Foreign keys | Every FK has explicit `ON DELETE {CASCADE,RESTRICT,SET NULL}`        | Default is `NO ACTION`; behaviour at deletion becomes invisible                |
| Timestamps   | `timestamptz` (TIMESTAMP WITH TIME ZONE)                             | Naïve `timestamp` ignores TZ; ambiguous across servers                         |
| Primary keys | `uuidv7()` (built-in on 18) or `bigint GENERATED ALWAYS AS IDENTITY` | v4 UUIDs fragment btree; v7 is time-ordered. Never `serial` (32-bit, runs out) |
| Money        | `numeric(precision, scale)`                                          | `float` rounds; production lossy                                               |
| Booleans     | `boolean NOT NULL DEFAULT false`                                     | Tri-state booleans are a bug                                                   |
| Enums        | check constraint + text, or `CREATE TYPE … AS ENUM`                  | Enum altering is awkward; check constraints are easier to evolve               |
| Naming       | `snake_case`, plural tables (`users`), singular columns (`user_id`)  | Consistent; quote-free                                                         |

`CHECK (price > 0)`, `UNIQUE (tenant_id, slug)`, `EXCLUDE USING gist (period WITH &&)` for non-overlapping ranges. The database is the last honest guard.

## Index types

| Type                   | Use for                                                       | Don't use for                      |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------- |
| **btree** (default)    | Equality, range, sort                                         | JSONB containment, full-text       |
| **hash**               | Equality only, large keys                                     | Anything else — btree usually wins |
| **GIN**                | JSONB containment, arrays, full-text (`tsvector`), trigram    | Range queries                      |
| **GiST**               | Geometric, range types, full-text, exclusion constraints      | Pure equality                      |
| **SP-GiST**            | Non-balanced data (quadtrees, IP prefixes)                    | General use                        |
| **BRIN**               | Huge tables naturally ordered (time-series, append-only logs) | Random-access patterns             |
| **Expression**         | `WHERE lower(email) = ?`                                      | When base column already works     |
| **Partial**            | Hot subset (`WHERE status = 'active'`)                        | Whole-table queries                |
| **Covering (INCLUDE)** | Index-only scans for payload columns                          | Wide payloads (bloats index)       |

Plan reading + N+1 patterns: `Skill(sql)`. **Postgres 18's B-tree skip scans** allow composite `(a, b)` indexes to serve `WHERE b = ?` queries with low-cardinality `a` — removes a class of "I need another index" problems.

## JSONB — when and how

Use JSONB for genuinely schemaless data, sparse extension fields, or third-party payloads. **Don't** use it as a lazy substitute for columns you know you'll query.

```sql
SELECT * FROM events WHERE data @> '{"type":"click"}';   -- containment, GIN
SELECT data->>'user_id' FROM events;                      -- text extract
SELECT (data->>'amount')::numeric FROM events;            -- typed extract
```

| Operator                 | Use                                                                        |
| ------------------------ | -------------------------------------------------------------------------- |
| `->`                     | Get JSON sub-object/array (returns JSONB)                                  |
| `->>`                    | Get value as text                                                          |
| `@>`                     | Left contains right (GIN-indexable)                                        |
| `?`, `?&`, and `?&#124;` | Key exists / all keys exist / any key exists                               |
| `#>` / `#>>`             | Path access (`data#>>'{a,b}'`)                                             |
| `jsonb_path_query`       | SQL/JSON path with filters                                                 |
| `JSON_TABLE(...)`        | (PG 17+) project JSON arrays to rows — cleaner than `jsonb_array_elements` |

**Index strategy.** `CREATE INDEX ON events USING gin (data jsonb_path_ops);` — `jsonb_path_ops` is smaller and faster than the default; use unless you need key-existence ops. Hot field: expression index `((data->>'user_id'))`. JSONB rows are TOASTed when large; reads are cheap if you don't extract many fields. Updates rewrite the whole document — JSONB is not row-of-row.

## Partitioning — declarative

Use when a table exceeds ~100M rows or has natural time/tenant boundaries. Partition before it hurts.

| Strategy  | When                                              |
| --------- | ------------------------------------------------- |
| **RANGE** | Time-series (monthly, weekly); numeric ranges     |
| **LIST**  | Few discrete values (region, tenant tier)         |
| **HASH**  | Even distribution, no natural key (write fan-out) |

```sql
CREATE TABLE events (ts timestamptz NOT NULL, ...) PARTITION BY RANGE (ts);
CREATE TABLE events_2026_05 PARTITION OF events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

Use `pg_partman` or `pg_cron` to auto-create future partitions and drop old ones. Manual partition routing in the app is **wrong** — declarative partitioning routes on the column; the planner prunes at query time. Gotchas: every unique constraint must include the partition key; indexes are local per partition; cross-partition `UPDATE` of the partition key moves the row (PG 11+). Test `EXPLAIN` after partitioning — pruning only works when the partition column is in the `WHERE`. (Identity columns on partitioned tables work cleanly from 17 onward.)

## Replication

| Mode                     | What it ships                                     | When                                                                  |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| **Streaming (physical)** | WAL bytes — byte-for-byte copy                    | HA failover, read replicas, identical version+platform                |
| **Logical**              | Logical changes (per-table, INSERT/UPDATE/DELETE) | Major-version upgrades, cross-version, partial replication, CDC sinks |

Streaming replicas are read-only and replay WAL. Use synchronous (`synchronous_commit = on` + `synchronous_standby_names`) for zero-data-loss; async otherwise. Replicas can serve reads but watch `hot_standby_feedback` vs vacuum-on-primary trade-off.

Logical replication: `CREATE PUBLICATION` on source, `CREATE SUBSCRIPTION` on target. Requires `wal_level = logical`, replica identity on the table (PK works; `REPLICA IDENTITY FULL` otherwise — slow). **Postgres 17+ failover slots** (`failover = true` + `sync_replication_slots = on`) replicate slot LSNs to physical standbys — logical subscribers survive primary failover. `pg_upgrade` no longer drops subscriptions on 17+. **PG 18 adds configurable logical-repl conflict policies.**

## Connection pooling

**Never connect your app directly to Postgres at scale.** Each backend = ~10MB RAM minimum, slow to fork.

| Tool          | Mode                | When                                                                                          |
| ------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| **PgBouncer** | transaction pooling | Default. Sub-ms, handles thousands of clients.                                                |
| **PgBouncer** | session pooling     | When you need `LISTEN/NOTIFY`, server-side prepared statements, plain `SET` (not `SET LOCAL`) |
| **pgpool-II** | load-balances reads | If you need read routing in the pool                                                          |

Transaction pooling rules out anything that survives a transaction: server-side prepared statements, `LISTEN/NOTIFY`, advisory locks across statements, temp tables, `SET` (use `SET LOCAL`).

## Security

- **Multi-tenant isolation: enable RLS** on tenant-keyed tables. Both `USING` (read/update/delete visibility) AND `WITH CHECK` (write enforcement) are required — `USING` alone lets a bug write cross-tenant rows: `CREATE POLICY tenant_iso ON orders USING (tenant_id = current_setting('app.tenant_id', true)::bigint) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::bigint);`. The 2-arg `current_setting(..., true)` returns NULL instead of erroring if unset (safer — excludes all rows). Set the GUC per-connection from the app.
- **RLS is bypassed by** superusers, roles with `BYPASSRLS`, AND the table owner. Apply `ALTER TABLE orders FORCE ROW LEVEL SECURITY;` so the owner is constrained; verify `pg_roles.rolbypassrls = false` for your `app_role`.
- **`SECURITY DEFINER` functions skip RLS** and run with the defining role's privileges. Every one MUST `SET search_path = pg_catalog, public` AND parameterize all dynamic SQL — `EXECUTE format(...)` with unsanitized args runs injection at the owner's privilege level.
- **Role hierarchy**: `app_role` (CRUD, no DDL, no BYPASSRLS), `migration_role` (DDL, no app data), `readonly_role` (SELECT on replica). Never connect as superuser.
- **Password hashing**: SCRAM-SHA-256 only. Set `password_encryption = scram-sha-256` AND update `pg_hba.conf` to `scram-sha-256` (not `md5`) — re-hashing while `pg_hba` still lists `md5` accepts the weaker auth.
- **PG 18 OAuth client auth**: `oauth` directive in `pg_hba.conf` validates bearer tokens against an OIDC provider — eliminates sidecar proxy for managed-identity setups.

## XID wraparound — the catastrophic failure

Postgres reuses 32-bit transaction IDs; the system goes read-only when `age(datfrozenxid)` crosses `autovacuum_freeze_max_age` (default 200M). Monitor BOTH: `SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;` and `SELECT relname, age(relfrozenxid) FROM pg_class WHERE relfrozenxid <> 0 ORDER BY 2 DESC LIMIT 20;`. Alert at ~150M (75% of default). Mitigation: lower `autovacuum_freeze_max_age` on high-churn tables; periodic `VACUUM (FREEZE)` on append-only tables. (PG 17's vacuum overhaul — radix-tree TID store, 20× memory reduction, single-pass on huge tables — makes this dramatically less painful but doesn't change the underlying math.)

## LISTEN/NOTIFY — wake-up signal, not a queue

`NOTIFY <channel>, '<payload>'` enqueues a per-database in-memory message; every session that did `LISTEN <channel>` receives it at sender's `COMMIT`. UTF-8 only, **8000-byte payload cap**, dupes of (channel, payload) within one tx are collapsed to one delivery. Cross-DB fan-out doesn't exist.

**Iron rule: a missed message is acceptable.** Listeners that disconnect lose everything they didn't see. Treat the payload as a hint; reconcile from the table on reconnect. PgBouncer in transaction mode silently breaks `LISTEN` — use session pooling or bypass the pooler for the listener connection.

Good fits: cache invalidation, real-time UI push, low-volume audit fan-out, job-queue wake-up (`Skill(python-job-queues)` for Procrastinate). Bad fits: high-volume streams (>1k/s — use Kafka/NATS), durable delivery, cross-DB events, payloads >8KB (pass the ID, fetch the row).

Full LISTEN/NOTIFY workflow (transactional semantics deep-dive, connection topology rules, Python psycopg3 + Go pgx recipes, trigger-based senders, observability, multi-tenant trust boundary): `references/postgres-listen-notify.md`.

## Anti-patterns

- **Nullable everything.** "Just in case." NULLs propagate; aggregates lie. NOT NULL is the default.
- **Missing `ON DELETE`.** Default is `NO ACTION` — you discover this when `DELETE` fails in production.
- **`timestamp without time zone`** for events. Always `timestamptz`. Store UTC, render in the user's TZ.
- **`serial` / `int` PKs.** 32-bit IDs run out. `bigint IDENTITY` or `uuidv7()`.
- **Random UUIDs as PKs** (v4). Random inserts fragment btrees. v7 is time-ordered.
- **Manual partition routing in app code.** Use declarative partitioning; let the planner prune.
- **`SELECT *`** plus JSONB column — you ship the whole document every time. Also kills index-only scans.
- **Connecting directly to Postgres** at scale. PgBouncer in transaction mode.
- **Async replica + sync app expectations.** "Read your writes" breaks. Route writes-then-reads to the primary or use causal reads.
- **Vacuum disabled** "for performance." It's not optional; bloat compounds. Tune autovacuum.
- **`SELECT FOR UPDATE` without `SKIP LOCKED`** for queue workers — concurrent workers block.
- **Treating NOTIFY as durable** — every disconnect = lost messages.
- **Putting work payload in NOTIFY** instead of passing an ID and fetching the row.
- **Upgrading major versions without capturing baseline plans** with `auto_explain`. Plan choices shift; you'll have nothing to diff.
- **Skipping `vacuumdb --analyze-in-stages` after `pg_upgrade` on PG ≤17.** First-day plan chaos. (18 preserves stats — finally.)

## Hand-off

For dialect-neutral SQL (joins, CTEs, windows, transactions, isolation, EXPLAIN reading): `Skill(sql)`. For schema-evolution tooling: `Skill(migrations-overview)`. For ORM/query-builder choice: `Skill(orm-overview)`. For LISTEN/NOTIFY full workflow + recipes: `references/postgres-listen-notify.md`. For per-version PG 17/18 feature reach-for-it table + upgrade gotchas: `references/postgres-version-features.md`. For Procrastinate / job queues built atop LISTEN/NOTIFY: `Skill(python-job-queues)`.
