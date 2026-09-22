---
name: security
description: Use when writing or reviewing any code for security — OWASP categories, SAST tooling, secrets, authn/authz, supply chain.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [code-review, tdd, secrets-vault, secrets-kms]
  keywords: [production, prod, harden, hardening, owasp, auth, authz, secrets, exploit, remediation]
---

# Security

**Iron Law: never trust input — even from your own services. Parameterize SQL, encode output, validate at boundaries. Fail closed.**

## OWASP Top 10 — one-line mitigations

| #   | Category                  | Mitigation                                                                                   |
| --- | ------------------------- | -------------------------------------------------------------------------------------------- |
| A01 | Broken Access Control     | deny-by-default, server-side check every request, scope objects to owners                    |
| A02 | Cryptographic Failures    | TLS everywhere, AES-GCM/ChaCha20-Poly1305, argon2/bcrypt, KMS for keys                       |
| A03 | Injection                 | parameterized queries, prepared statements, allow-listed shell args, encode on output        |
| A04 | Insecure Design           | threat-model first, misuse cases, defence in depth, rate limit auth/business actions         |
| A05 | Security Misconfiguration | hardened base images, IaC reviewed in CI, strip stack traces, least-privilege everywhere     |
| A06 | Vulnerable Components     | SBOM + lockfiles + Dependabot/Renovate + `*-audit` in CI                                     |
| A07 | Authn Failures            | rate limit auth, MFA for admins, opaque session tokens, secure cookie flags                  |
| A08 | Integrity Failures        | signed commits/releases, pinned deps, no unsafe deserialization, verify checksums            |
| A09 | Logging Failures          | structured logs for auth/authz/admin/exports, centralize, alert on patterns, test alert path |
| A10 | SSRF                      | allow-list destinations, block private IPs + cloud metadata, dedicated egress proxy          |

Per-category exploits + remediation code: see `references/owasp-categories.md`. Categories below track the 2021 numbering (still authoritative in most scanners as of 2026); cross-check against the 2025 edition when citing externally. For LLM-specific risks (prompt injection, training-data poisoning, insecure output handling), consult the separate OWASP LLM Top 10.

## SAST — pick one per stack, tune it

| Stack              | Tool                                                         | Notes                                            |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------ |
| Polyglot           | **semgrep**                                                  | YAML rules, fast, great PR diff mode             |
| Polyglot, deep     | **CodeQL**                                                   | taint analysis, slow, free for OSS               |
| Python             | **bandit**                                                   | pair with semgrep for Django/Flask               |
| Go                 | **gosec**                                                    | pair with `go vet` + `staticcheck`               |
| JS/TS              | **eslint-plugin-security**, **eslint-plugin-no-unsanitized** | lint-time, fast                                  |
| Rust               | **cargo-geiger** + **clippy**                                | SAST surface small; `unsafe` review matters more |
| Java               | **SpotBugs + FindSecBugs**, CodeQL                           |                                                  |
| Ruby               | **brakeman**                                                 | Rails-aware, strong signal                       |
| Infra (TF/CFN/K8s) | **checkov**, **tfsec**                                       |                                                  |

CI rollout: phase 1 visible non-blocking → phase 2 diff-blocking on `ERROR` only → phase 3 full enforcement. Skipping phases gets the tool disabled within a sprint. Naked `# nosec` / `# nosemgrep` with no reason is a review-blocker — the reason is the artefact.

## Secrets — prevent, detect, rotate

| Tool                              | Use                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------- |
| **gitleaks**                      | pre-commit hook + CI gate, fast                                              |
| **trufflehog**                    | detects + verifies (calls API), nightly full-history scan, incident response |
| **GitHub/GitLab push protection** | server-side block, free, partners auto-rotate some keys — enable it          |
| **detect-secrets** (Yelp)         | baseline workflow when adopting on a legacy repo                             |

**Storage**: local dev `.env` (gitignored) + `.env.example` (committed, no values). CI: platform secret store. Prod: dedicated manager (`Skill(secrets-vault)`, `Skill(secrets-kms)`, AWS Secrets Manager, 1Password CLI). **Never**: source files, hard-coded constants, Slack, screenshots, docs, logs.

**Leak response — order matters**: (1) **rotate at provider** within minutes — public repos are scraped in seconds; (2) **assess blast radius** via provider audit logs; (3) **clean history** only if compliance demands — rewriting is disruptive, rotate-and-document is usually right; (4) postmortem the hook/CI gap.

## Authn / Authz

**Password hash — use one**:

| Algorithm                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **argon2id**                    | current OWASP recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **bcrypt**                      | fine, cost ≥ 12. **72-byte truncation**: passphrases >72 bytes collide on the prefix. Pre-hash with `base64(sha256(pwd))` (44 ASCII chars, fits comfortably). Use base64, NOT raw SHA-256 — raw bytes may contain `\x00`. **Migration path**: pre-hashing changes the verify input. Roll forward: on login, try `bcrypt.verify(pwd, old_hash)`; on success, re-hash with the new scheme and store. Never deploy the new scheme without this or you lock out every user on day 1 |
| **scrypt**                      | fine, tune N/r/p                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **PBKDF2**                      | acceptable when FIPS-mandated, ≥ 600k iterations SHA-256                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **MD5 / SHA-1 / plain SHA-256** | not password hashes — replace immediately                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Session shape**:

| Option                                             | When                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-side session** (opaque cookie + DB/Redis) | default for most apps — easy invalidation, no info leak                                                                                       |
| **JWT**                                            | only when stateless verification is genuinely needed; ≤ 15 min expiry + refresh rotation; pin `alg` explicitly; never store secrets in claims |
| **OAuth 2.0 / OIDC**                               | for "login with Google/GitHub" — Authorization Code + PKCE, validate `state` + `nonce`, verify `id_token` against JWKS                        |

Cookies always: `HttpOnly; Secure; SameSite=Lax; Path=/`. MFA: WebAuthn/passkeys preferred, TOTP fine, SMS weak (SIM swap). Enforce MFA for admins.

**Authz**: RBAC when permissions cluster naturally (admin/editor/viewer) — watch horizontal IDOR. ABAC when decision is `f(user, resource, action, env)` — externalize to OPA / Cedar as policies grow. Enforce server-side every request. Test IDOR: log in as A, hit B's URL — if you get B's data, the bug exists. Never trust a client-supplied `role` field — strip it server-side on update.

## Supply chain

**Pin everything** — commit the lockfile, CI installs from it, prod = exact same tree.

| Stack     | Lockfile                                                       | Install                               | Audit                            |
| --------- | -------------------------------------------------------------- | ------------------------------------- | -------------------------------- |
| Node      | `package-lock.json` / `pnpm-lock.yaml`                         | `npm ci`                              | `npm audit`, `osv-scanner`       |
| Python    | `uv.lock` / `poetry.lock` / `requirements.txt` (`pip-compile`) | `pip install -r ... --require-hashes` | `pip-audit`, `osv-scanner`       |
| Go        | `go.sum`                                                       | `go mod download`                     | `govulncheck` (call-graph aware) |
| Rust      | `Cargo.lock`                                                   | `cargo build --locked`                | `cargo audit`, `osv-scanner`     |
| Ruby      | `Gemfile.lock`                                                 | `bundle install --deployment`         | `bundler-audit`                  |
| Container | —                                                              | —                                     | `trivy image`, `grype`           |

**SBOM**: CycloneDX or SPDX per build, attach to artefact, re-scan against fresh CVE feeds. **Signing**: cosign / sigstore on container images and releases — don't ship unsigned to prod. **Dependency confusion**: scope internal packages (`@yourorg/foo`), pin registry per scope, publish public stubs to claim the namespace.

## Anti-patterns

- Bare `except:` / `catch(e){}` swallowing security errors — fail loud, fail closed
- `allow_origins=["*"]` with credentials — CORS suicide. Any CORS response that varies by Origin MUST emit `Vary: Origin` or shared/CDN caches will serve one origin's response to another
- JWT in `localStorage` — XSS steals it; use `HttpOnly` cookie
- `.env` with real values committed (and the `.gitignore` added in the same PR)
- Hard-coded API keys "just for the demo"
- MD5 / SHA-1 / plain SHA-256 for passwords
- String concatenation or f-strings building SQL — parameterize or die
- React/Vue/Django raw-HTML escape hatches on user data without sanitization (DOMPurify / bleach / bluemonday)
- Custom crypto, custom JWT lib, custom OAuth client — never roll your own
- Comparing tokens with `==` (timing attack) — use `hmac.compare_digest` / `crypto.timingSafeEqual`
- Floating versions in prod (`^1.2`, `~2.3`, `latest`)
- "We have semgrep, we don't need code review"
- One scanner only — different feeds catch different things

## Red flags

| Thought                              | Reality                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| "It's internal-only"                 | It ends up internet-exposed within a year                  |
| "We'll add auth later"               | The DB leaks first                                         |
| "Sanitize the input"                 | XSS is an output problem — encode at the sink              |
| "Validate emails with regex"         | Parse, don't validate — once typed, it's verified          |
| "Test key, it's fine"                | Test keys leak prod accounts more often than you'd think   |
| "Add it to `.gitignore`" (post-leak) | The secret is in history; rotate first, scrub maybe        |
| "Our scanner is clean"               | One scanner ≠ secure; layer SAST + secrets + deps + review |

## Hand-off

For per-category OWASP depth (manifestations + exploits + remediation code): see `references/owasp-categories.md` (linked from this skill, not auto-loaded). For finding what's MISSING in review: `Skill(code-review)`. When the missing piece is a test: `Skill(tdd)`. For secret managers: `Skill(secrets-vault)`, `Skill(secrets-kms)`.
