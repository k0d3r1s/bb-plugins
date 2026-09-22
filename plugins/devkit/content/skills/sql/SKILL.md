---
name: sql
description: Use when writing or reviewing SQL — parameterization, joins, CTEs, windows, transactions, isolation, NULL gotchas, plan reading basics.
metadata:
  keywords: [optimization, indexing, explain]
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: database
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [postgres, migrations-overview, orm-overview]
---

# SQL

**Iron Law: parameterize, never concatenate. Joins, CTEs, window functions are your daily tools. `EXPLAIN (ANALYZE, BUFFERS)` before adding (or removing) an index. N+1 is a query pattern, not a query bug.**

## Parameterize, always

```python
cur.execute("SELECT * FROM users WHERE email = %s", (email,))   # safe
cur.execute(f"SELECT * FROM users WHERE email = '{email}'")     # SQL injection
```

Every driver supports placeholders (`?`, `$1`, `%s`, `:name`). String formatting into SQL is **always** a bug — even for "trusted" inputs, even for integers (type-confusion still bites). Identifiers (table/column names) can't be parameterized. Safe pattern: **(1) Unicode-normalize** input to NFC and reject anything outside `[A-Za-z0-9_]` — Cyrillic `а` (U+0430) looks identical to Latin `a` and defeats naïve compares; **(2) check against a whitelist**; **(3) quote with the driver's identifier-quoter** (`pgx.Identifier{...}.Sanitize()` in Go, `psycopg.sql.Identifier()` in Python). SQLAlchemy's `quoted_name` is a _rendering hint_, not a sanitizer.

## Logical evaluation order

You write `SELECT … FROM … WHERE … GROUP BY … HAVING … ORDER BY …` — the engine evaluates:

1. `FROM` / `JOIN` → 2. `WHERE` → 3. `GROUP BY` → 4. `HAVING` → 5. `SELECT` → 6. `DISTINCT` → 7. `ORDER BY` → 8. `LIMIT`

So `WHERE gross > 100` fails when `gross` is a SELECT alias (WHERE runs first). `ORDER BY gross` works. `WHERE COUNT(*) > 5` fails — aggregates don't exist yet; use `HAVING`.

## NULL is unknown, not empty

| Pattern              | Behavior                          | Fix                              |
| -------------------- | --------------------------------- | -------------------------------- |
| `WHERE x = NULL`     | Discards everything (NULL ≠ NULL) | `WHERE x IS NULL`                |
| `WHERE x != 'foo'`   | Drops NULL rows silently          | `WHERE x IS DISTINCT FROM 'foo'` |
| `NOT IN (subquery)`  | Single NULL → empty result set    | `NOT EXISTS (…)`                 |
| `SUM(x)` on all-NULL | Returns NULL, not 0               | `COALESCE(SUM(x), 0)`            |
| `COUNT(col)`         | Skips NULL                        | `COUNT(*)` counts rows           |

## JOIN shapes

| Join      | Returns                                                       |
| --------- | ------------------------------------------------------------- |
| `INNER`   | rows matching both sides                                      |
| `LEFT`    | every left row + match or NULLs                               |
| `FULL`    | union with NULLs where no match                               |
| `CROSS`   | Cartesian product (grids, calendar × region)                  |
| `LATERAL` | right side may reference left's columns (correlated, per-row) |

**Classic trap.** `LEFT JOIN orders o ON … WHERE o.status = 'paid'` silently becomes INNER — WHERE filters out the NULL rows LEFT produced. Move the predicate into `ON`:

```sql
LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'
```

## CTEs and window functions

```sql
WITH ranked AS (
  SELECT order_id, customer_id, amount,
         SUM(amount)  OVER (PARTITION BY customer_id) AS cust_total,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
  FROM orders
)
SELECT * FROM ranked WHERE rn = 1;   -- latest order per customer
```

| Window function                                   | Use for                            |
| ------------------------------------------------- | ---------------------------------- |
| `ROW_NUMBER()`                                    | Top-N per group, dedup-keep-newest |
| `RANK()` / `DENSE_RANK()`                         | Leaderboards with ties             |
| `LAG()` / `LEAD()`                                | Day-over-day deltas, gap detection |
| `SUM()/AVG() OVER (ORDER BY …)`                   | Running totals, moving averages    |
| `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY x)` | p95 latency, quartiles             |

Window functions evaluate after `WHERE`/`GROUP BY`, before `ORDER BY`. Filter window results in an outer CTE/subquery.

Postgres ≥12 inlines CTEs. Force materialization with `WITH foo AS MATERIALIZED (…)` when you want compute-once-reuse-many.

## Transactions and isolation

Multi-statement writes that must be atomic go inside a transaction. Period.

| Level            | Dirty read | Non-repeatable | Phantom    | Serialization anomaly    | When                          |
| ---------------- | ---------- | -------------- | ---------- | ------------------------ | ----------------------------- |
| Read Uncommitted | possible\* | possible       | possible   | possible                 | Don't                         |
| Read Committed   | no         | possible       | possible   | possible                 | Default (Postgres). OLTP.     |
| Repeatable Read  | no         | no             | no (in PG) | possible                 | Reports, multi-row snapshots  |
| Serializable     | no         | no             | no         | no (retries on conflict) | Money, invariants across rows |

\*Postgres treats Read Uncommitted as Read Committed — no true dirty-read mode.

Serializable in Postgres uses SSI (Serializable Snapshot Isolation) — **your code must retry** on `40001`. `40P01` (deadlock_detected) ALSO requires retry at any isolation level. Same shape for both:

```python
for attempt in range(5):
    try:
        with conn.transaction():           # opens BEGIN; auto-ROLLBACK on exception
            do_work(conn)
        break
    except psycopg.errors.SerializationFailure: pass
    except psycopg.errors.DeadlockDetected: pass
    time.sleep(random.uniform(0, 0.1 * (2 ** attempt)))   # exponential back-off + jitter
else:
    raise RuntimeError("max retries exceeded")
```

ROLLBACK before retry on the same connection (the context manager above does it). **Critical**: the transaction body MUST be idempotent — retrying a `chargeCard()` / `sendEmail()` / `pg_notify` call fires it twice. Either dedupe externally (idempotency key) or move side effects out of the retry-able transaction.

## Set operations

`UNION` (dedupes) vs `UNION ALL` (faster, keeps duplicates — prefer when you know there are none). `INTERSECT`, `EXCEPT` for rows-in-both / rows-in-first-not-second.

## Performance — the daily reading

Always: `EXPLAIN (ANALYZE, BUFFERS) SELECT … ;`. `ANALYZE` actually runs the query and reports real timings. `BUFFERS` shows pages read from cache vs disk — where the real cost hides. Read `actual time` × `loops`, not `cost`.

For DML safely: wrap in `BEGIN; EXPLAIN (ANALYZE, BUFFERS) UPDATE … ; ROLLBACK;`. (ROLLBACK does NOT undo sequence advances, trigger side effects outside the txn, or autonomous-session work.)

| Smell                                             | Fix                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `Seq Scan` on a big table with a selective filter | Add a btree on the filtered column                                     |
| `Sort` + `Limit` at the top                       | Index that pre-orders matches the `ORDER BY`                           |
| `Nested Loop` over a large outer                  | Hash Join expected — check rows estimates; `ANALYZE table_name`        |
| `Rows estimate=1, actual=1,000,000`               | Statistics stale → `ANALYZE`; correlated columns → `CREATE STATISTICS` |
| `OR` across columns                               | Often defeats indexes → `UNION ALL` of two indexable queries           |
| `WHERE lower(email) = ?`                          | Expression index on `lower(email)`                                     |
| `OFFSET` deep pagination                          | Keyset: `WHERE id > $last_id ORDER BY id LIMIT N`                      |
| `LIKE '%foo'`                                     | Trigram index (`pg_trgm`) or reverse-stored column                     |

For the full plan-node cheatsheet, indexing strategy by access pattern, composite-order rules, `INCLUDE` covering indexes, write-amplification math, and the N+1 fix patterns table: see `references/sql-optimization.md`.

## When SQL is the wrong tool

| Need                              | Better fit                                               |
| --------------------------------- | -------------------------------------------------------- |
| Graph traversal beyond a few hops | Neo4j / materialised paths                               |
| Full-text search at scale         | OpenSearch / Tantivy (or `pg_trgm`/`tsvector` for small) |
| High-cardinality time-series      | TimescaleDB / ClickHouse / DuckDB                        |
| Vector similarity                 | `pgvector` (small), Qdrant/Milvus (big)                  |

Default to SQL. Reach for alternatives only after measuring.

## Anti-patterns

- **String-concat SQL.** Even once. Even for "internal" inputs. Parameterize.
- **`SELECT *`** in application code. Schema changes break callers silently; transfers columns you don't use; kills index-only scans. Name your columns.
- **`x = NULL`** instead of `IS NULL`. Three-valued logic — `NULL` comparisons return `NULL`, not false.
- **Multi-statement writes without a transaction.** Crash mid-flow → split-brain data.
- **`LIMIT` without `ORDER BY`.** Returns whatever the engine grabbed first. Non-deterministic; pagination breaks.
- **`COUNT(DISTINCT col)`** in hot paths — expensive. HyperLogLog (`approx_count_distinct`) for analytics.
- **Implicit casts** (`WHERE id = '42'` when `id` is `int`) — sometimes blocks index use. Match types.
- **Adding indexes without measuring** — write amplification + planner confusion + wasted RAM.
- **`EXPLAIN` without `ANALYZE`** — that's the planner's guess, not reality.
- **Lazy loading in tight loops.** Every `for parent in parents: parent.children` is N+1.
- **`NOT IN (subquery)`** with NULLs returns empty. `NOT EXISTS` is faster _and_ correct.
- **`DISTINCT` to fix duplicate rows from a bad JOIN** — fix the JOIN.

## Hand-off

For Postgres-specific schema/indexes/JSONB/partitioning and version-specific features: `Skill(postgres)`. For deep query optimization (full plan cheatsheet, indexing matrix, N+1 patterns): `references/sql-optimization.md`. For ORM/query-builder choice: `Skill(orm-overview)`. For schema migrations: `Skill(migrations-overview)`.
