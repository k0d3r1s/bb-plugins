# SQL Optimization — Deep Workups

Linked from `Skill(sql)`. The daily "EXPLAIN + smells table" lives in the main skill. This reference covers the full plan-node cheatsheet, indexing strategy by access pattern, composite-index rules, write amplification, and the N+1 fix patterns.

## EXPLAIN — the only one you should run

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS) SELECT … ;
```

- `ANALYZE` — **actually runs the query** and reports real timings. (Without it: estimated cost only, often wrong.)
- `BUFFERS` — shows pages read from cache vs disk. **This is where you find the real cost.** A "fast" plan that reads 200k pages from disk is not fast in production.
- `VERBOSE` — full column lists and schema-qualified names.
- `SETTINGS` — any non-default GUCs in play. Surprises hide here.

Read `actual time` (not `cost`) for absolute performance — `cost` is in arbitrary planner units. **Cost IS useful for plan COMPARISON**: when forcing a plan with `SET enable_seqscan = off` makes the cost jump from 1000 to 1e9, that's the planner telling you why it picked the other one. Read `loops × actual time` for total time at a node. A node showing `0.01ms × 100,000 loops` = 1 second.

For complex plans (50+ nodes), `EXPLAIN (FORMAT JSON)` + an external visualizer (pev2, explain.dalibo.com) beats reading text.

**Wrap writes in a transaction you roll back** to safely `EXPLAIN ANALYZE` `INSERT`/`UPDATE`/`DELETE`:

```sql
BEGIN; EXPLAIN (ANALYZE, BUFFERS) UPDATE … ; ROLLBACK;
```

Caveats: ROLLBACK does NOT undo sequence advances (`SERIAL`/`IDENTITY` still ticks), `BEFORE`/`AFTER` triggers that perform side effects outside the txn (`pg_notify`, `dblink`, file writes via untrusted PLs), or work already committed by autonomous sessions.

## Plan node cheatsheet

| Node               | What it means                            | Smell                                                        |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| `Seq Scan`         | Full table read                          | Fine on small tables; bad on big ones with selective filters |
| `Index Scan`       | Walks index, fetches heap row            | Good when selective; bad if returning >5–10% of table        |
| `Index Only Scan`  | Index has all needed columns             | Best — covers query without heap fetch                       |
| `Bitmap Heap Scan` | Builds bitmap of pages, then reads       | Use when index returns many rows                             |
| `Nested Loop`      | For each outer row, scan inner           | Catastrophic when outer is large; fine when both small       |
| `Hash Join`        | Build hash of one side, probe with other | Default for medium/large joins                               |
| `Merge Join`       | Both sides sorted, walk in step          | Best when both inputs pre-sorted (indexed)                   |
| `Sort` + `Limit`   | Sort all, return N                       | Replace with an index that pre-orders                        |
| `Hash Aggregate`   | Build hash of group keys                 | Watch memory; spills to disk when > `work_mem`               |
| `Materialize`      | Cache inner side of nested loop          | Often appears when nested loop runs the inner many times     |

**Rows estimate vs actual.** If `rows=1` but `actual rows=1,000,000`, statistics are wrong. Run `ANALYZE table_name`. Persistent skew → `CREATE STATISTICS` on correlated columns.

## Indexing strategy

| Pattern                                      | Index                                   |
| -------------------------------------------- | --------------------------------------- |
| Equality / range on one column               | btree                                   |
| Multi-column equality (left-to-right prefix) | btree composite `(a, b, c)`             |
| Sorted output (`ORDER BY a DESC, b`)         | btree with matching direction           |
| Partial: only `WHERE status = 'active'` rows | partial: `... WHERE status = 'active'`  |
| Computed expressions (`lower(email)`)        | expression index                        |
| JSONB containment / path                     | GIN                                     |
| Full-text search                             | GIN on `tsvector`                       |
| Geometric / range overlaps                   | GiST                                    |
| Huge tables, naturally ordered (timestamp)   | BRIN — tiny, fast for time-series       |
| Equality only, no range                      | hash (rarely beats btree; usually skip) |

**Composite index order matters.** `(tenant_id, created_at)` serves both `WHERE tenant_id=?` and `WHERE tenant_id=? AND created_at>?`. It does **not** serve `WHERE created_at>?` alone. Left-to-right prefix or nothing (until Postgres 18's skip scans).

**Index-only scans need a covering index.** Add `INCLUDE (col)` to a btree to carry payload without making it part of the key:

```sql
CREATE INDEX ON orders (customer_id) INCLUDE (total, status);
```

**Cost of indexes is write amplification.** Every `INSERT`/`UPDATE` updates every index. Audit unused indexes:

```sql
SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;   -- candidates to drop
```

## N+1 — query pattern, not query bug

Symptom: one query to fetch N parents, then one query per parent for its children. With 1000 parents you've done 1001 queries.

Detection: `auto_explain.log_min_duration = 0` in dev, or count queries in tests (`assertNumQueries(2)` in Django, query loggers elsewhere). Look for any per-iteration DB call.

| Fix                                                                                               | When                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Eager load with JOIN** (`SELECT … FROM parent JOIN child …`)                                    | Small fan-out, simple shape                            |
| **Eager load with two queries + in-memory zip** (`SELECT * FROM children WHERE parent_id IN (…)`) | Large fan-out per parent — JOIN duplicates parent rows |
| **DataLoader / batch loader** (GraphQL, async)                                                    | Many independent call sites, can't restructure caller  |
| **Window function** (`ROW_NUMBER() OVER (PARTITION BY …)`)                                        | Top-N children per parent                              |
| **`LATERAL` subquery**                                                                            | Per-row computation that's a query, not a join         |
| **Materialised view / cache**                                                                     | Read-heavy, tolerates staleness                        |

Example — top-3 orders per customer in one query:

```sql
SELECT * FROM (
  SELECT o.*, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
  FROM orders o
) AS ranked WHERE rn <= 3;
```

## Common cost issues

- **OR across columns** defeats indexes. Rewrite as `UNION ALL` of indexable queries.
- **Implicit casts** (`WHERE id = '42'` on int column) block index use. Match types.
- **`LIKE '%foo'`** non-sargable → full scan. Trigram index (`pg_trgm`) or reverse-stored.
- **Function on indexed column** (`WHERE lower(email) = ?`) — index unused unless expression index exists.
- **`OFFSET` deep pagination** scales linearly with offset. Use keyset pagination (`WHERE id > $last_id ORDER BY id LIMIT 50`).
- **`NOT IN (subquery)`** with NULLs returns empty. `NOT EXISTS` is faster _and_ correct.
- **`DISTINCT` to fix duplicate rows from a bad JOIN** — fix the JOIN.

## Anti-patterns specific to tuning

- **Adding indexes without measuring.** Write amplification, planner confusion, wasted RAM. Measure before _and_ after.
- **`EXPLAIN` without `ANALYZE`.** You're looking at the planner's guess, not reality.
- **`OR` instead of `UNION ALL`** for indexable disjunctions.
- **Indexing every foreign key** by reflex. Index FKs that are actually queried; FKs on a join-only table need no index for the FK itself.
- **`SELECT *`** — kills index-only scans.
- **Tuning `work_mem` globally to fix one query.** Set per-session: `SET LOCAL work_mem = '256MB'`.
- **Believing the cache.** First run after restart is the honest one. `pg_prewarm` if you must.
