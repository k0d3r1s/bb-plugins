# Postgres Per-Version Features — Reach-for-it Tables + Upgrade Gotchas

Linked from `Skill(postgres)`. Per-version feature deep-dive for 17 and 18. The "what's current / supported" summary lives in the main skill.

**Iron Law: capture baseline `EXPLAIN` plans before every major upgrade (`auto_explain.log_min_duration = 0` for a day pre-upgrade). On PG ≤17, run `vacuumdb --analyze-in-stages` IMMEDIATELY after `pg_upgrade` (statistics are NOT carried across major versions — queries run on default selectivity until you re-analyze). PG 18 fixes this — stats survive `pg_upgrade`.**

## Postgres 18 — what changed (GA, current)

| Feature                                                    | Reach for it when                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Async I/O** (`io_method`: `worker`, `io_uring` on Linux) | NVMe / cloud block storage — Seq/BRIN/bitmap scans become throughput-bound, not syscall-bound                                     |
| **Stats preserved through `pg_upgrade`**                   | Removes the "first-day chaos" footgun PG ≤17 had                                                                                  |
| **Native `uuidv7()`**                                      | Drop `pg_uuidv7` extension; v7 IDs become first-class for PKs                                                                     |
| **OAuth client auth**                                      | `oauth` directive in `pg_hba.conf` — validate bearer tokens against an OIDC provider, no sidecar                                  |
| **B-tree skip scans**                                      | Composite `(a, b)` indexes usable when filtering only on `b` with low-cardinality `a` — removes a class of "I need another index" |
| **Logical repl conflict policies**                         | Configurable resolution — replaces today's "subscription breaks on conflict"                                                      |
| **`MERGE … RETURNING OLD/NEW`**                            | Richer audit-trigger semantics; easier CDC from MERGE                                                                             |
| **Extended `EXPLAIN`**                                     | Per-node memory peak, async wait time — better diagnosis with async I/O in play                                                   |

Upgrade gotchas:

- Async I/O changes plan choices on scan-heavy workloads. **Capture baselines.**
- Extensions: check `pg_stat_statements`, `pgvector`, `postgis`, `pg_partman`, `pg_repack`, `timescaledb` compatibility before upgrading.
- If you're using `pg_uuidv7`, plan the cut-over to the built-in `uuidv7()` separately from the upgrade itself — they're API-compatible but the extension stops being a dependency.
- OAuth auth needs the OIDC provider piece configured too; rolling out auth + DB upgrade together is two changes, not one.

## Postgres 17 — what changed (previous supported)

| Feature                                    | Reach for it when                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Failover slots** (logical repl)          | You have logical subscribers and any HA story — pre-17, failover broke replication |
| **`MERGE … WHEN NOT MATCHED BY SOURCE`**   | Syncing from external source-of-truth, need to delete locals not in source         |
| **`MERGE … RETURNING`**                    | One round-trip for upsert + result; ORM round-trip elimination                     |
| **`JSON_TABLE`**                           | Shaped extraction from JSON — replaces `jsonb_array_elements` + cast soup          |
| **`EXPLAIN (MEMORY)`**                     | Debugging huge ORM-generated queries with thousands of joins                       |
| **`pg_stat_io`** (matured)                 | Per-object I/O attribution — which table is actually causing disk reads            |
| **`pg_basebackup --incremental`**          | Big clusters, frequent backups, can't keep doing full base backups                 |
| **Identity columns on partitioned tables** | If you partitioned and gave up on `IDENTITY` — 17 fixed it                         |
| **Vacuum overhaul**                        | Just upgrade. The radix-tree TID store is 20× smaller, vacuum much faster          |
| **Streaming I/O**                          | Cloud block storage — new `read_stream` prefetches aggressively. Automatic.        |
| **Large `IN (…)` constant lists**          | Code-generated batch queries with thousands of constants — planning now fast       |

### Vacuum overhaul (PG 17) — automatic, biggest win

The dead-tuple TID store is now a radix tree instead of a fixed array. Practical consequences:

- `maintenance_work_mem` effectively unbounded for vacuum (was 1GB cap). Big tables vacuum in one pass instead of multiple.
- ~20× memory reduction for the same dead-tuple count.
- Concurrent index vacuums on the same table no longer block each other in many cases.

If you've been fighting vacuum pain on 15/16, this alone justifies upgrade. **No app change needed.**

### Streaming I/O (PG 17) — automatic plan shifts

New `read_stream` interface inside Postgres prefetches large sequential reads aggressively (Seq Scan, BRIN, ANALYZE). On cloud block storage and SSDs you'll see notably faster scans.

**Side effect**: plan choice can shift. A query that was CPU-bound on a table scan may now finish faster — but a different query might pick a different plan because Seq Scan cost dropped. Capture baseline plans before upgrade.

### `MERGE` becomes usable (PG 17)

```sql
MERGE INTO target t USING source s ON t.id = s.id
WHEN MATCHED THEN UPDATE SET v = s.v
WHEN NOT MATCHED BY SOURCE THEN DELETE
WHEN NOT MATCHED BY TARGET THEN INSERT (id, v) VALUES (s.id, s.v)
RETURNING t.id, t.v;
```

`MERGE` arrived in PG 15 but was missing `RETURNING` and `WHEN NOT MATCHED BY SOURCE`. 17 adds both. Now it's the right tool for sync-from-source-of-truth pipelines. PG 18 extends `RETURNING` further (OLD/NEW per WHEN clause).

### `JSON_TABLE` (PG 17)

```sql
SELECT t.*
FROM events e,
     JSON_TABLE(e.data, '$.items[*]' COLUMNS (
       name text PATH '$.name',
       qty  int  PATH '$.qty'
     )) AS t;
```

Cleaner than chained `jsonb_array_elements` + casts. Use when the JSON structure is known and stable.

### Logical replication operations (PG 17)

- **Failover slots** (`failover = true` on slot + `sync_replication_slots = on` on standby) — slot LSNs replicate to physical standbys. Pre-17, failover orphaned logical subscribers. Pair with `pg_failover_slots` extension for fuller automation.
- **`pg_upgrade` no longer drops subscriptions.** Logical subscribers can be major-version upgraded without re-syncing.
- **Async standbys can't guarantee slot LSN** survives failover — sync replication required for the failover-slots guarantee.

### Operational quick wins (PG 17)

- **`pg_stat_io`** — `SELECT * FROM pg_stat_io WHERE reads > 0 ORDER BY reads DESC;` tells you which backend types are hitting disk on which object types. Per-backend-type — sum across backends to get totals.
- **`hash_mem_multiplier` default is 2.0** (since PG 14 — not new in 17). Listed here because anyone upgrading from PG ≤13 sees the change for the first time; plan shapes across that boundary differ for this reason.
- **`EXPLAIN (MEMORY)`** — planner memory cost. Useful for ORM-generated monsters with hundreds of joins.

### Upgrade gotchas from 15/16 to 17

- **Replan everything.** New I/O streaming + hash sizing shift plan choices. Capture baselines with `auto_explain` before upgrade; diff after.
- **Extensions.** Verify 17 compatibility before upgrading.
- **JIT cost model** shifted slightly. Queries that previously triggered JIT may not (and vice versa). If you turned JIT off for OLTP, that setting still applies.
- **Statistics are NOT carried across `pg_upgrade`** on PG 17. Run `vacuumdb --analyze-in-stages` immediately after. (18 fixes this.)
- **`work_mem` × parallel workers.** Better parallelism in 17 means a single query can suddenly use 8× `work_mem`. Tune accordingly.

### Removed / deprecated (PG 17)

| Item                             | Status                                       | Action                                               |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `adminpack` extension            | Removed                                      | Update pgAdmin or stop using server-side log writing |
| MD5 password hashing             | Deprecated (still works)                     | Migrate to SCRAM-SHA-256 now                         |
| `pg_dump --no-toast-compression` | Removed (no-op since per-column compression) | Drop the flag                                        |

## When to upgrade (today)

| You're on         | Action                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 17                | Plan 18 for next maintenance window. The stats-through-upgrade win alone is large; OAuth and async I/O if you'll use them. |
| 16                | Skip to 18 directly via `pg_upgrade --link`; both are supported but 18 is the active development line.                     |
| 15 (EOL Nov 2027) | Plan upgrade to 17 or 18 in next 12 months.                                                                                |
| 14 (EOL Nov 2026) | Upgrade NOW.                                                                                                               |
| 13 (EOL Nov 2025) | You're out of support. Drop everything and upgrade.                                                                        |
| < 13              | Out of support; upgrade.                                                                                                   |

## Anti-patterns (upgrades + version-specific)

- **Upgrading without capturing baseline plans.** "Why is this query slow now?" — because the plan changed and you have nothing to diff.
- **Skipping `vacuumdb --analyze-in-stages` after `pg_upgrade` on ≤17.** First-day chaos.
- **Assuming failover slots work with async standbys.** They don't — need sync replication.
- **Using `MERGE` for hot-path upserts** without testing — the planner choice can surprise. Benchmark vs `INSERT … ON CONFLICT DO UPDATE`.
- **Reading one row of `pg_stat_io`** and concluding. Per-backend-type — sum across.
- **Enabling async I/O (PG 18) without retesting plan-sensitive queries** — scan costs change.
- **Rolling out OAuth auth (PG 18) and the version upgrade together** — two changes, debug them separately.
