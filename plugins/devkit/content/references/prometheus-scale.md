# Prometheus at scale — histograms, remote_write, federation, cardinality control

Linked from `Skill(infra-prometheus-grafana)`. The base stack (scrape config, recording rules, alerting discipline, dashboards-as-code, the bounded/unbounded cardinality table) lives in the main skill. Use this reference when you outgrow a single Prometheus — long-term storage, native histograms, hierarchical scrapes, scrape-time cardinality dropping, and the PromQL traps that bite at volume.

**Iron Law: cardinality is the bill. Drop high-cardinality labels at scrape time, not at query time. `histogram_quantile` over classic buckets needs `_bucket` AND `le` AND `+Inf` — get any one wrong and the answer is silently wrong.**

**Versions:** LTS `2.55.x` · Current `3.2.x` · Next `3.3.x` — _Prom 3 is the supported line; 2.x is in maintenance. Native histograms moved to stable in 3.x; UTF-8 metric names became default. Pin the line; bump intentionally._

## Recording-rule interval discipline

The recording-rule naming convention (`<level>:<metric>:<operations>`) and the canonical examples live in the main skill. The detail that bites at scale: **`interval:` must match or exceed `scrape_interval`** — undersampling sees no new data 2 of 3 cycles. For native histograms (Prom 3.x, OTel default) the recorded p99 drops `le` and the `_bucket` suffix:

```promql
# classic
histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
# native — no le, no _bucket
histogram_quantile(0.99, sum by (route) (rate(http_request_duration_seconds[5m])))
```

## Alertmanager routing

The alert-rule shape (with `for:`, `runbook_url`, `dashboard_url`) is in the main skill. Routing/dedup is the part that scales:

```yaml
route:
  group_by: [alertname, cluster, service]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - { matchers: [severity="page"], receiver: pagerduty, continue: true }
    - { matchers: [severity="page"], receiver: slack-pages }
    - { matchers: [severity="warn"], receiver: slack-warns }
inhibit_rules:
  - { source_matchers: [alertname="APIClusterDown"], target_matchers: [team="gateway"], equal: [cluster] }
```

`group_by` collapses related alerts into one notification. `inhibit_rules` suppress noisy children when a parent fires. Run **2+ Alertmanagers** with the gossip mesh — a single one is a SPOF.

## Classic vs native histograms

|                   | Classic histogram                                                     | Native histogram (Prom 2.40+, stable 3.x)                                                |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Storage           | one series per bucket per label combo (`{le="0.1"}`, `{le="0.5"}`, …) | one series per label combo; buckets internal                                             |
| Cardinality       | 10–20× the base cardinality                                           | base cardinality                                                                         |
| Bucket boundaries | fixed at instrumentation time                                         | exponential, auto-resolved                                                               |
| Query             | `histogram_quantile(0.99, sum by (le, X) (rate(metric_bucket[5m])))`  | `histogram_quantile(0.99, sum by (X) (rate(metric[5m])))` — no `le`                      |
| OTel SDK default  | classic                                                               | native (`OTEL_EXPORTER_PROMETHEUS_DELTA_TEMPORALITY=true` for delta, default cumulative) |
| Grafana support   | full                                                                  | 11.x+                                                                                    |

For new instrumentation: **native histograms**. For migrating: dual-emit during the transition (both `_bucket` series and the native series), cut over dashboards, drop the classic series. Don't quantile across both — the math is different.

### `histogram_quantile` traps (classic)

- Must use the **`_bucket`** suffix metric (`http_request_duration_seconds_bucket`), not `_count` / `_sum`.
- Must aggregate by **`le`** plus your grouping labels: `sum by (le, route) (rate(...))` — drop `le` and the result is meaningless.
- Must have a **`+Inf`** bucket — without it, quantiles approaching 1.0 return `NaN`. Most SDKs ship it by default; check yours.
- Quantiles **cannot be averaged**. `avg(api:http_duration_p99:rate5m)` is statistical nonsense. Compute the quantile from the bucket sums.
- The result is interpolated within the chosen bucket. Sparse buckets → wide error bars at the extremes. Tune buckets to your SLO.

## remote_write — ship to long-term storage

Prom is a 15-day TSDB by default. For longer retention + cross-cluster, ship to Mimir / Cortex / Thanos / VictoriaMetrics:

```yaml
remote_write:
  - url: https://mimir.example.com/api/v1/push
    headers: { X-Scope-OrgID: ci }                    # Mimir tenant
    basic_auth: { username: prom-prod, password_file: /etc/prometheus/mimir-token }
    queue_config:
      capacity: 10000; max_shards: 50; min_shards: 1
      max_samples_per_send: 2000; batch_send_deadline: 5s
      retry_on_http_429: true
    write_relabel_configs:
      - { source_labels: [__name__], regex: "go_gc_.*|process_max_fds", action: drop }
```

Tune `queue_config` at scale — too few shards = backpressure + drops, too many = Mimir OOM. Defaults first, monitor `prometheus_remote_storage_*`, scale on evidence.

## Federation — hierarchical scrapes

```yaml
scrape_configs:
  - job_name: federate-prod-eu
    scrape_interval: 60s
    honor_labels: true
    metrics_path: /federate
    params: { "match[]": ['{__name__=~"job:.*"}', '{__name__=~"node_.*"}'] }
    static_configs: [{ targets: [prom-prod-eu:9090] }]
```

Federation is for **aggregates only** (recording rules like `job:...`, `cluster:...`), not raw series — the federator OOMs otherwise. For a true global view, `remote_write` to Mimir/Thanos. **Federation is not HA** — for HA, run two Proms scraping the same targets and dedup at the query layer.

## Cardinality control — at scrape time

```yaml
scrape_configs:
  - job_name: api
    static_configs: [{ targets: [api:8080] }]
    metric_relabel_configs:
      - { source_labels: [__name__], regex: "go_gc_.*|process_(virtual|resident)_memory_max_bytes", action: drop }
      - {
          source_labels: [__name__, user_id],
          regex: "http_requests_total;(.+)",
          target_label: user_id,
          replacement: "",
        }
      - { source_labels: [instance], regex: "(api-(0|1|2):8080)", action: keep }
```

`metric_relabel_configs` runs **after** scrape, before storage — use it to DROP. `relabel_configs` runs **before** scrape (target filtering). Audit top-10 series weekly:

```promql
topk(10, count by (__name__) ({__name__=~".+"}))
topk(10, count by (__name__, job) ({__name__=~".+"}))
```

One mis-templated route (`/orders/12345` instead of `/orders/:id`) and you're at 1M series tomorrow.

## PromQL query gotchas

| Function                           | Trap                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `rate(counter[5m])`                | counter only; gauge → nonsense                                   |
| `irate(counter[5m])`               | instantaneous; spiky, not for alerts; needs ≥2 samples in window |
| `increase(counter[5m])`            | **interpolates** — "44.7 requests" is fine                       |
| `delta(gauge[5m])` / `idelta(...)` | gauge only; counter resets not handled                           |
| `predict_linear(metric[1h], 3600)` | linear only; nonlinear systems mislead                           |

**Selector first, operator last**. `sum by (route) (rate(http_requests_total{service="api",status="500"}[5m]))` filters inside the selector before aggregating — dramatically faster.

## Exporters worth knowing

| Exporter            | Exposes                                                |
| ------------------- | ------------------------------------------------------ |
| `node_exporter`     | host CPU/mem/disk/net (the USE half)                   |
| `cadvisor`          | per-container resource use (Docker/Swarm/k8s)          |
| `postgres_exporter` | pg*stat*\*, conn counts, replication lag, slow queries |
| `redis_exporter`    | hit rate, evictions, replica lag                       |
| `blackbox_exporter` | synthetic HTTP/TCP/ICMP/DNS/gRPC/TLS-expiry probes     |

Blackbox is the cheapest external monitoring — `probe_success == 0` for liveness, `probe_ssl_earliest_cert_expiry - time() < 86400 * 14` for "cert expires in 2 weeks".

## Hand-off

For the base Prometheus/Grafana setup (scrape configs, RED/USE, recording-rule naming, alert runbook discipline, dashboards-as-code, the cardinality label table): `Skill(infra-prometheus-grafana)`. For the OTel pipeline that emits these metrics: `Skill(observability-opentelemetry)`. For the log side of the same Grafana stack: `Skill(observability-loki-alloy)`. For the three-pillars primer: `Skill(observability-essentials)`.
