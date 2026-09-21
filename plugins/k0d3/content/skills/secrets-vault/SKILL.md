---
name: secrets-vault
description: Use when integrating HashiCorp Vault — auth methods (AppRole, JWT, K8s), dynamic credentials, KV v2, Transit, lease renewal, AppRole rotation.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [secrets-kms, security, postgres, observability-essentials, infra-docker-swarm]
---

# HashiCorp Vault

**Iron Law: every token has a finite TTL with a max TTL ceiling. Apps renew before expiry or re-auth. Root tokens never leave the bootstrap shell. No human pastes a token into a config file.**

**Versions:** Current `1.24.x` (quarterly cadence) · No LTS series — _HashiCorp BSL since 1.14 (Aug 2023); fork is OpenBao if you need an OSS-licensed equivalent. Pin minor.patch (patches carry security fixes), bump on each release._

## When Vault, when cloud secret manager

| You need…                                                        | Reach for                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Multi-cloud or self-hosted (Docker Swarm, bare metal, on-prem)   | **Vault** — only choice that abstracts the substrate           |
| Dynamic DB credentials, PKI, SSH CA, Transit crypto-as-a-service | **Vault** — cloud managers don't issue lease-bound creds       |
| Single-cloud, mostly static secrets, IAM-native auth             | **AWS Secrets Manager / GCP Secret Manager** — less to operate |
| Encryption with KMS-backed keys, no per-secret retrieval         | **AWS KMS / GCP KMS** — see `Skill(secrets-kms)`               |

Vault wins the substrate fight; cloud managers win the operational simplicity fight. Don't pick Vault for "we might go multi-cloud" — pick it when you actually have two clouds, or when you're running Docker Swarm and the alternative is a self-built secret store.

## Auth methods — pick by caller identity

| Method                             | When                                                                       | Identity source                                                           |
| ---------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **AppRole**                        | CI runners, scripts, services with no platform identity                    | `role_id` (config) + `secret_id` (short-lived, rotated by trusted broker) |
| **JWT/OIDC**                       | Apps that already have an OIDC token (GitHub Actions, GitLab CI, Keycloak) | Bound claims on the JWT (`sub`, `aud`, custom)                            |
| **Kubernetes**                     | Pods in a cluster                                                          | ServiceAccount token validated via TokenReview API                        |
| **AWS IAM**                        | EC2/ECS/Lambda                                                             | STS `GetCallerIdentity` signed with instance/role creds                   |
| **GCP IAM**                        | GCE/GKE/Cloud Run                                                          | Signed JWT from the workload's service account                            |
| **Userpass / LDAP / OIDC (human)** | Operators, dashboards                                                      | Username + password / SSO                                                 |
| **Token** (raw)                    | Bootstrap only, never for apps                                             | Pre-issued token                                                          |

**AppRole** is the workhorse for Docker Swarm where no platform identity exists. `role_id` is non-secret (deploy-time config). `secret_id` is the credential — short TTL (24h), wrapped on issue, single-use bind possible via `secret_id_num_uses=1`. A trusted broker (CI pipeline, ops bastion) mints wrapped `secret_id`s and ships them to the consumer; the consumer unwraps once and exchanges for a token.

## KV v2 — paths, versioning, soft-delete

```
secret/data/app/postgres          # WRITE/READ goes through /data/
secret/metadata/app/postgres      # version list, undelete, destroy
secret/delete/app/postgres        # soft-delete a version
secret/undelete/app/postgres
secret/destroy/app/postgres       # permanent
```

**Path gotcha**: KV v2 inserts `/data/` between the mount and the secret path. ACL policies must reference `secret/data/foo`, not `secret/foo` — a policy on the wrong path silently denies. Reading without `/data/` returns 404, not a meaningful error.

**Versioning** is on by default (10 versions retained). Reads default to the latest; pin with `?version=N`. Soft-delete marks a version unreadable but recoverable; `destroy` is permanent. Configure `max_versions` and `delete_version_after` per mount to bound storage growth and meet retention policy.

## Dynamic Postgres credentials

```hcl
# 1. Mount the database secrets engine
vault secrets enable -path=database database

# 2. Configure the connection
vault write database/config/myapp-pg \
  plugin_name=postgresql-database-plugin \
  allowed_roles="myapp-rw,myapp-ro" \
  connection_url="postgresql://{{username}}:{{password}}@pg:5432/myapp?sslmode=require" \
  username="vault_admin" \
  password="..."

# 3. Define a role — creation/revocation SQL + TTL
vault write database/roles/myapp-rw \
  db_name=myapp-pg \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT app_role TO \"{{name}}\";" \
  default_ttl="1h" max_ttl="24h"

# 4. App reads creds — Vault creates a fresh user
vault read database/creds/myapp-rw
# username: v-token-myapp-rw-xyz...   password: ...   lease_id: database/creds/myapp-rw/abc
```

The app uses lease-bound creds and renews the **lease** (not the token) before TTL expiry. On `max_ttl` the user is dropped; the app re-reads `database/creds/myapp-rw` to get a fresh one. **The DB connection pool must re-auth at lease rollover** — keep `MaxConnLifetime` < `default_ttl` so pgxpool cycles connections through the new creds.

## Transit — crypto-as-a-service

Encrypt without ever holding the key:

```
vault write transit/keys/payments type=aes256-gcm96
vault write transit/encrypt/payments plaintext=$(base64 <<< "card-4242")
# → ciphertext: vault:v1:abc...   (key version embedded)
vault write transit/decrypt/payments ciphertext="vault:v1:abc..."
```

Use Transit for: per-request crypto where the app must never see the key (PII, payment data); deterministic encryption (`type=aes256-siv`) for searchable ciphertext; convergent encryption for dedupe. **Not** for: bulk data (round-trip every payload through Vault — see envelope encryption with `Skill(secrets-kms)` instead).

Key rotation: `vault write -f transit/keys/payments/rotate` increments version. Old versions decrypt; new version encrypts. Re-wrap with `vault write transit/rewrap/payments ciphertext=...` to migrate ciphertext to the new version without exposing plaintext.

## Leasing + renewal

Tokens have `ttl` (renewal window) and `max_ttl` (hard ceiling — no further renewal after this). Dynamic secrets have a **lease** with the same shape. Apps MUST:

1. Read `lease_duration` from the response.
2. Schedule renewal at ~2/3 of TTL (jittered).
3. On `max_ttl`, re-auth and refetch.
4. Treat 403 on renewal as "lease revoked" — fall back to re-auth, do not panic-loop.

Official SDKs (`hashicorp/vault/api` for Go, `hvac` for Python) ship a `LifetimeWatcher` / `RenewLeases` helper. Use it. Hand-rolled renewal forgets the `max_ttl` boundary.

## AppRole rotation

`secret_id` rotation is your responsibility, not Vault's. Pattern:

1. **Trusted broker** (CI bastion, ops host with admin token) mints a fresh `secret_id` per deploy: `vault write -wrap-ttl=300s auth/approle/role/myapp/secret-id`.
2. Broker injects wrapping token into the consumer (env var, file).
3. Consumer unwraps once on boot: `vault unwrap <wrapping_token>` → real `secret_id`.
4. Consumer exchanges for a Vault token: `vault write auth/approle/login role_id=... secret_id=...`.
5. Original `secret_id` is consumed (set `secret_id_num_uses=1`) or expires (`secret_id_ttl=24h`).

`role_id` rotation is rare — treat it as a config change, requires redeploy. The `secret_id` is the rotating credential.

## HA + sealing

Vault HA uses Raft (integrated storage, the default since 1.4) or external storage (Consul, deprecated for new installs). On boot, every node starts **sealed** — the master key is split via Shamir into N shares, M required to unseal. Auto-unseal (KMS, GCP KMS, transit-from-another-vault) removes the manual step at the cost of trust transfer.

For Docker Swarm: 3-node Raft cluster, auto-unseal via cloud KMS, persistent volume per node mounted to `/vault/data`. Don't run Vault in `dev` mode in any environment that holds a real secret — `dev` mode keeps everything in memory and unseals automatically with a single key.

## Multi-tenant isolation — namespaces or path prefixes

Sharing one Vault across teams/tenants/environments needs explicit isolation. Two mechanisms:

- **Namespaces** (Enterprise only): full-tenant separation — distinct mounts, policies, auth methods, tokens. Each namespace is effectively its own Vault. The cleanest model when you can afford it.
- **Path-prefix policies** (OSS): one mount, but every policy is scoped to `path "secret/data/<tenant>/..."`. Mistakes here are silent — a policy granting `secret/data/*` instead of `secret/data/tenant-a/*` cross-leaks. Lint your policies in CI.

Either way: separate auth methods per tenant (one AppRole per tenant, not a shared one) so blast radius from a compromised secret_id stays inside one tenant.

## Common pitfalls

- **Forgetting `vault token renew`** in long-running services — token expires mid-request, every call 403s
- **Hardcoding the root token** in compose files / scripts — root token has no TTL, revoke it immediately after bootstrap and use a properly-scoped admin token thereafter
- **Policy on `secret/foo` instead of `secret/data/foo`** for KV v2 — silent denial
- **Same `secret_id` reused across deploys** — defeats the rotation model; mint per-deploy
- **App holds connection past lease expiry** — Postgres drops the user; pool returns auth errors. `MaxConnLifetime < default_ttl`.
- **Logging the unwrapped `secret_id`** — same severity as logging a password
- **Running Vault with `disable_mlock=true`** in prod — secrets swap to disk. In Docker/Compose/Swarm, mlock needs the container capability: `cap_add: [IPC_LOCK]` + `ulimit -l unlimited` on the host; without these the container silently can't lock memory even with `disable_mlock=false`
- **Single Vault node, no auto-unseal** — every reboot becomes a manual ceremony at 3am

## Hand-off

For KMS envelope encryption + signing (the layer below Vault's Transit): `Skill(secrets-kms)`. For the broader threat model and authn/authz patterns: `Skill(security)`. For wiring Vault into a Swarm stack: `Skill(infra-docker-swarm)`. For dynamic Postgres lifecycle from the DB side: `Skill(postgres)`.
