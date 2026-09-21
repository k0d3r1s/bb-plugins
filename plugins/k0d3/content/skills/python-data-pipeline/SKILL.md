---
name: python-data-pipeline
description: Use when picking pandas vs polars vs pyarrow for tabular data — decision matrix, common gotchas, when to use lazy frames, interop.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  languages: [python]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [python-essentials, python-django, python-fastapi, postgres, observability-essentials]
---

# Python Data Pipeline

**Iron Law: pick the engine that matches the data size and the access shape. If the dataset fits in Postgres and the transformation is set-shaped, do it in SQL — pulling 50M rows into Python to `.groupby()` them is the bug.**

**Versions:** pandas `2.2` · polars `1.x` · pyarrow `18.x` — _pandas 2 uses PyArrow-backed strings by default (huge memory win over `object` dtype); polars 1.0 GA'd 2024-07 (stable API); pyarrow ≥ 16 required for polars 1.x. dask still alive for cluster-scale; vaex unmaintained as of 2024 — avoid._

## Decision table

| Engine      | Sweet spot                                                                | Avoid when                                                           |
| ----------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **polars**  | new code, any size up to ~RAM, lazy queries, multithreaded out of the box | you need scikit/statsmodels/seaborn integration (still pandas-first) |
| **pandas**  | existing code, scikit-learn pipelines, plotting, Jupyter exploration      | hot paths over 10M rows where polars is 5–20× faster                 |
| **pyarrow** | zero-copy interop (parquet, Arrow Flight, DuckDB), columnar storage layer | row-by-row mutation or scipy-style numeric work                      |
| **duckdb**  | "SQL on parquet/CSV/pandas/polars" — analytical queries without a server  | OLTP, multi-writer, persistent service backend                       |
| **dask**    | larger-than-RAM that genuinely won't fit on one box, multi-node clusters  | single-box workloads — polars + chunked I/O wins on overhead         |
| **vaex**    | —                                                                         | unmaintained; do not adopt                                           |

**Rule of thumb**: ≤ 10M rows on one box → **polars**. Need SQL semantics over files → **duckdb**. Sharing data across processes / writing to disk → **parquet via pyarrow**. Touching legacy notebooks → **pandas**.

## When to push to SQL instead

Move the work to Postgres when **all** are true:

- The data already lives in Postgres (no extract/load round-trip).
- The transform is expressible as joins/group-by/window functions (it usually is).
- The result is small (≤ 1M rows back into Python).

Postgres 17's `MERGE`, window functions, and `LATERAL` cover 90% of "do this in pandas" reflexes. Round-tripping millions of rows over the wire to `groupby` them is always slower than the database doing it. See `Skill(k0d3:postgres)`.

## Polars: eager vs lazy

```python
import polars as pl

# Eager — runs immediately, materializes each step in RAM
df = pl.read_parquet("orders.parquet")            # full file in memory
df = df.filter(pl.col("status") == "shipped")     # new DataFrame
top = df.group_by("user_id").agg(pl.col("total").sum()).sort("total", descending=True).head(10)

# Lazy — builds a query plan, optimizes (predicate pushdown, projection pushdown, CSE)
# then executes once at .collect(). Use this for anything multi-step.
top = (
    pl.scan_parquet("orders.parquet")             # no I/O yet
      .filter(pl.col("status") == "shipped")
      .group_by("user_id").agg(pl.col("total").sum())
      .sort("total", descending=True)
      .head(10)
      .collect(streaming=True)                    # streaming=True for > RAM
)
```

**Always start lazy.** `.collect()` only when you need a materialized result. Use `streaming=True` for inputs larger than RAM — polars processes in batches. Inspect with `.explain()` before `.collect()` if a plan looks slow.

## pandas → polars cheat sheet

| Operation      | pandas                                                              | polars                                                              |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Read           | `pd.read_parquet("f.parquet")`                                      | `pl.read_parquet("f.parquet")` or `pl.scan_parquet(...)`            |
| Filter         | `df[df["x"] > 0]`                                                   | `df.filter(pl.col("x") > 0)`                                        |
| Select cols    | `df[["a", "b"]]`                                                    | `df.select(["a", "b"])`                                             |
| New column     | `df["c"] = df["a"] + df["b"]`                                       | `df.with_columns((pl.col("a") + pl.col("b")).alias("c"))`           |
| Group-by + agg | `df.groupby("k")["v"].sum()`                                        | `df.group_by("k").agg(pl.col("v").sum())`                           |
| Join           | `df.merge(other, on="k", how="left")`                               | `df.join(other, on="k", how="left")`                                |
| Pivot          | `df.pivot_table(index="r", columns="c", values="v", aggfunc="sum")` | `df.pivot(index="r", on="c", values="v", aggregate_function="sum")` |
| Sort           | `df.sort_values(["a", "b"], ascending=[True, False])`               | `df.sort(["a", "b"], descending=[False, True])`                     |
| Rename         | `df.rename(columns={"a": "x"})`                                     | `df.rename({"a": "x"})`                                             |
| Null fill      | `df["a"].fillna(0)`                                                 | `df.with_columns(pl.col("a").fill_null(0))`                         |
| Cast           | `df["a"].astype("int32")`                                           | `df.with_columns(pl.col("a").cast(pl.Int32))`                       |
| Apply (row)    | `df.apply(fn, axis=1)`                                              | **don't** — use expressions; `map_elements` only as last resort     |

**Method chaining is idiomatic in polars.** Each operation returns a new (lazy) frame; long chains read top-to-bottom like SQL.

## Common gotchas

**pandas chained indexing** — `df[df.a > 0]["b"] = 1` may write to a copy and silently no-op. pandas 2 emits `ChainedAssignmentError`; do `df.loc[df.a > 0, "b"] = 1` instead. Set `pd.set_option("mode.copy_on_write", True)` (default in pandas 3.0) to make this less of a footgun.

**arrow strings vs object** — pandas 2's default string dtype is now `string[pyarrow]` (huge memory win, faster ops). Mixing with `object`-dtype strings causes silent up-casts. Be explicit: `pd.read_csv(..., dtype_backend="pyarrow")` for new code.

**polars `.to_pandas()` zero-copy ≠ free** — without `use_pyarrow_extension_array=True` the conversion materializes a copy. Pass the flag, or stay in polars until you must hand off.

**polars expressions are NOT pandas Series** — `df["col"] + 1` works; `pl.col("col") + 1` is the idiom and composes inside lazy plans. Don't index a polars frame like a dict for chained transforms.

**parquet schema drift** — writing partitions with different dtypes (e.g., one `null`, one `int`) produces files that fail to scan together. Pin schema with `pyarrow.schema` or write `pl.write_parquet(..., compression="zstd", use_pyarrow=True)`.

**timezones** — pandas `datetime64[ns]` is naive by default; polars datetimes carry tz when constructed with one. Mixing tz-aware and tz-naive blows up on join keys. Normalize at read.

## Interop: parquet / CSV / Arrow

| From → To         | How                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- |
| polars → pandas   | `df.to_pandas(use_pyarrow_extension_array=True)` (cheap)                              |
| pandas → polars   | `pl.from_pandas(df)`                                                                  |
| polars ↔ arrow    | `df.to_arrow()` / `pl.from_arrow(tbl)` (zero-copy)                                    |
| pandas ↔ arrow    | `df.to_pandas()` on `pa.Table` / `pa.Table.from_pandas(df)`                           |
| Anything ↔ duckdb | `duckdb.sql("select * from df")` — duckdb sees pandas/polars/arrow as tables in scope |

**Parquet is the default exchange format.** Compressed (zstd), columnar, schema-typed, splittable. CSV is for humans and legacy imports only — no schema, slow, lossy on types.

## Memory tuning

| Knob                      | Effect                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `dtype` selection         | `int32` instead of `int64`, `float32` instead of `float64` — halve memory on numeric cols when range allows |
| Categorical/Enum          | Repeated strings: pandas `category`, polars `Enum`/`Categorical` — 10-100× smaller                          |
| `scan_*` + lazy collect   | Avoid loading the whole file                                                                                |
| `streaming=True` (polars) | Out-of-core execution for joins/aggs                                                                        |
| Chunked iteration         | pandas `read_csv(..., chunksize=100_000)`; polars `iter_slices(n)`                                          |
| Drop early                | Project columns at read (`columns=[...]`) — don't load what you discard                                     |

## Anti-patterns

- `df.apply(fn, axis=1)` in pandas — Python loop in disguise; vectorize or use polars `map_batches`
- Looping with `iterrows()` / `itertuples()` over 100k+ rows — same problem; vectorize
- `pd.concat` in a loop — quadratic; build a list and concat once
- Pulling a full table from Postgres into pandas to filter — push the filter into the SQL
- Mutating `df["col"]` on a slice without `.loc` — silent no-op or `SettingWithCopyWarning`
- Comparing floats with `==` — use `np.isclose` / `pl.Float64.eq` with tolerance
- Storing JSON blobs as pandas `object` — parse once at load, type the columns
- Using `eval` / `query` strings with user input — code injection
- Persisting frames as binary pickles between processes — version-fragile and unsafe to load from untrusted sources; use parquet

## Red flags

| Thought                                       | Reality                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| "I'll just bring the whole table into pandas" | At 50M rows you'll OOM. Filter at the source.                               |
| "polars is too new"                           | 1.0 shipped 2024-07. Used in production across multiple Python data stacks. |
| "I'll use `apply` for now"                    | "Now" becomes prod. Vectorize or use polars expressions today.              |
| "Parquet vs CSV doesn't matter"               | 10× smaller, 10× faster to read, schema-preserved. It matters.              |
| "I need dask"                                 | Probably not. Try polars streaming first.                                   |
| "We'll worry about dtypes later"              | 4× memory blowup later. Cast at the read boundary.                          |

## Hand-off

For broader Python rules: `Skill(k0d3:python-essentials)`. For Django ORM patterns (when the data lives in Postgres): `Skill(k0d3:python-django)`. For raw SQL optimization: `Skill(k0d3:postgres)`. For generating PDFs/XLSX from these frames: `Skill(k0d3:python-document-pipeline)`. For shipping data to BigQuery: `Skill(k0d3:python-gcp-clients)`. For tracing slow pipelines: `Skill(k0d3:observability-essentials)`.
