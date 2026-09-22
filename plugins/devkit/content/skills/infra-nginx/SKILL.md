---
name: infra-nginx
description: Use when configuring nginx as a reverse proxy — upstream blocks, TLS termination, gzip/brotli, websockets, caching, healthchecks, common pitfalls.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related:
    [
      infra-docker-compose,
      infra-docker-swarm,
      security,
      websocket-essentials,
      observability-essentials,
      infra-frankenphp,
    ]
---

# Infra Nginx

**Iron Law: terminate TLS at nginx, proxy plain HTTP to upstream over a private network. `proxy_set_header Host $host` and the X-Forwarded chain on every `location`. `client_max_body_size` and `proxy_read_timeout` are NOT optional — the defaults will bite you.**

**Versions:** LTS `1.28.x` (stable, May 2025) · Current `1.29.x` (mainline) · Next `1.30.x` — _Stable branch gets bugfixes only; mainline is where new features (HTTP/3 maturity, JS module updates) land. For nginx-in-a-container, mainline is fine._

## Skeleton — reverse proxy in front of an app

```nginx
# /etc/nginx/conf.d/api.conf
upstream api {
    least_conn;
    server api1:8080 max_fails=3 fail_timeout=15s;
    server api2:8080 max_fails=3 fail_timeout=15s;
    keepalive 32; keepalive_timeout 60s;
}

server { listen 80; server_name api.example.com; return 308 https://$host$request_uri; }

server {
    listen 443 ssl; listen 443 quic reuseport; http2 on;     # HTTP/3 needs QUIC build
    server_name api.example.com;

    ssl_certificate     /etc/ssl/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/live/api.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:50m; ssl_session_timeout 1d;
    ssl_stapling on; ssl_stapling_verify on;                 # OCSP — faster handshake, fresher revocation
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff"           always;   # block MIME-sniff exec
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy   "frame-ancestors 'none'" always;  # clickjacking (prefer CSP over X-Frame-Options)
    add_header Alt-Svc 'h3=":443"; ma=86400';
    server_tokens off;                                       # hide nginx version

    client_max_body_size 25m;                                # default 1m → 413

    location /healthz { access_log off; return 200 "ok\n"; }

    location / {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;            # default is $proxy_host
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";               # required w/ upstream keepalive
        proxy_connect_timeout 5s; proxy_send_timeout 60s; proxy_read_timeout 60s;
        proxy_buffering on;                                  # OFF for SSE/downloads
    }
}
```

## Upstream — load balancing

| Directive                      | When                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `round_robin` (default)        | stateless, equal-capacity                             |
| `least_conn`                   | mixed-latency — usually right                         |
| `ip_hash`                      | sticky sessions for legacy apps; loses balance on NAT |
| `hash $request_uri consistent` | cache affinity, sharded backends                      |
| `random two least_conn`        | very large pools (>100 upstreams)                     |

`max_fails=3 fail_timeout=15s` ejects flapping backends; `keepalive N` pools — pair with `proxy_http_version 1.1` + `proxy_set_header Connection ""`.

## TLS — modern hygiene

TLS 1.2+1.3 only. Cipher list above is Mozilla "intermediate"; drop entirely for "modern" (TLS 1.3 only). HSTS commits you for `max-age` — test before two years. HTTP/2 via `http2 on;` (1.25.1+); HTTP/3 needs QUIC build (`nginx -V | grep quic`); `Alt-Svc` triggers browser upgrade. OCSP stapling lines (in the skeleton above) cut handshake latency.

## WebSocket upgrade

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

location /ws {
    proxy_pass http://api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;                  # default 60s kills idle sockets
    proxy_send_timeout 3600s;
}
```

Without the upgrade headers + extended `proxy_read_timeout`, WebSockets connect then drop at 60s. The `map` normalizes the `Connection` header to `close` when no upgrade is requested.

## Compression — gzip + brotli

```nginx
gzip on; gzip_vary on; gzip_comp_level 5; gzip_min_length 1024; gzip_proxied any;
gzip_types application/json application/javascript text/css text/plain application/xml image/svg+xml;
# Brotli needs ngx_brotli module (openresty / fholzer/nginx-brotli image); same _types list
brotli on; brotli_comp_level 5; brotli_static on;
```

Brotli isn't in stock nginx. Gzip-only is fine if you can't change the image.

## Caching

```nginx
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=app:50m max_size=2g inactive=10m use_temp_path=off;

location / {
    proxy_pass http://api;
    proxy_cache app;
    proxy_cache_key "$scheme$host$request_uri";
    proxy_cache_methods GET HEAD;
    proxy_cache_valid 200 302 5m;
    proxy_cache_valid 404 30s;
    proxy_cache_use_stale error timeout updating http_5xx;
    proxy_cache_lock on;                       # collapse concurrent misses
    add_header X-Cache-Status $upstream_cache_status;
}
```

`use_temp_path=off` avoids cross-filesystem rename. Log `X-Cache-Status` (HIT/MISS/EXPIRED/STALE/UPDATING).

## Rate limiting

```nginx
limit_req_zone $binary_remote_addr zone=api_ip:10m rate=10r/s;
limit_req_zone $http_authorization  zone=api_tok:10m rate=100r/s;
limit_req_status 429;

location /api/ {
    limit_req zone=api_ip  burst=20  nodelay;
    limit_req zone=api_tok burst=200 nodelay;
    proxy_pass http://api;
}
```

`burst` is queue depth; `nodelay` returns 429 past it. `$binary_remote_addr` is cheaper than `$remote_addr`. Behind an LB, set `real_ip_header X-Forwarded-For; set_real_ip_from <lb-cidr>;` so the key isn't the LB.

## Healthchecks

- **Self** (`/healthz` → 200) — orchestrator probes nginx itself.
- **Upstream passive** — `max_fails` + `fail_timeout` eject flapping backends. nginx OSS has no active health (Plus / `nginx_upstream_check_module` only).
- **Upstream readiness** — use `depends_on: service_healthy` in compose; nginx retries via `proxy_next_upstream error timeout http_502 http_503;`.

## Common pitfalls

| Surprise                                           | Fix                                         |
| -------------------------------------------------- | ------------------------------------------- |
| 413 on uploads (`client_max_body_size 1m` default) | raise per-location                          |
| WebSocket drops at 60s (`proxy_read_timeout`)      | raise to 3600s+ on `/ws`                    |
| SSE/streaming chunks late (`proxy_buffering on`)   | `proxy_buffering off` on streaming location |
| Backend gets `Host: api` not `api.example.com`     | `proxy_set_header Host $host`               |
| Backend sees `127.0.0.1` as client                 | add the four `X-Forwarded-*` headers        |
| HTTP/3 advertised, browser never upgrades          | add `Alt-Svc 'h3=":443"; ma=86400'`         |

## Reload, don't restart

```bash
nginx -t && nginx -s reload                    # validate, then graceful reload
```

`reload` is zero-downtime (spawn new workers, drain old). `restart` drops in-flight connections. In Docker: `docker exec nginx nginx -s reload`.

## Structured logging

```nginx
log_format json escape=json '{"ts":"$time_iso8601","remote":"$remote_addr",'
    '"method":"$request_method","uri":"$request_uri","status":$status,'
    '"bytes":$body_bytes_sent,"rt":$request_time,"urt":"$upstream_response_time",'
    '"ua":"$http_user_agent","xff":"$http_x_forwarded_for",'
    '"cache":"$upstream_cache_status","host":"$host"}';
access_log /var/log/nginx/access.log json;
error_log  /var/log/nginx/error.log warn;
```

JSON access log feeds Loki/Elasticsearch directly. `escape=json` (1.11.8+) is mandatory.

## Anti-patterns

- Monolithic `nginx.conf` with N `server` blocks — split into `conf.d/`.
- Omitting `proxy_set_header Host $host` — backend sees the upstream name.
- Global `client_max_body_size 100m` — tighten per location.
- `add_header` in both `server` and `location` — `location` overrides; use `always` and repeat.
- `if` blocks beyond `if ($request_method = POST)` — "if is evil"; use `map`/`try_files`.
- TLS cert+key baked into image — mount as volume/secret in prod.
- Access logging `/healthz` — fills disks. `access_log off;` in the location.
- Buffering streaming responses (downloads, SSE) — clients see nothing for minutes.

## Red flags

| Thought                            | Reality                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| "Why is the upload returning 413?" | `client_max_body_size 1m`. Raise per-location.              |
| "WebSocket drops after a minute"   | `proxy_read_timeout 60s`. Raise on the WS location.         |
| "Round-robin is fine"              | One GC pause sends 50% to the paused replica. `least_conn`. |

## Hand-off

Compose/Swarm wiring (healthchecks, networks, secrets): `Skill(infra-docker-compose)`, `Skill(infra-docker-swarm)`. TLS posture (HSTS, cipher choice, secret-mounting certs): `Skill(security)`. WebSocket protocol mechanics on the upstream side: `Skill(websocket-essentials)`. Shipping the JSON access log to Loki: `Skill(observability-essentials)`.
