# OWASP Top 10 — Per-Category Depth

Linked from `Skill(security)`. Use this when you need exploit shapes and remediation code per category, not just one-line mitigations. Numbering tracks the 2021 edition (still authoritative across most scanners as of 2026).

## Category × typical exploit (lookup)

| #   | Category                  | Typical exploit / CVE flavour                                                        |
| --- | ------------------------- | ------------------------------------------------------------------------------------ |
| A01 | Broken Access Control     | IDOR, forced browsing, JWT-role-tamper, missing server-side checks                   |
| A02 | Cryptographic Failures    | plaintext PII at rest, MD5 passwords, hard-coded keys, missing TLS                   |
| A03 | Injection                 | SQLi, NoSQLi, OS-command, LDAP, template, log injection                              |
| A04 | Insecure Design           | no rate limit on auth, business-logic abuse (negative transfers, race-window orders) |
| A05 | Security Misconfiguration | public S3, default creds, debug endpoint in prod, verbose 500 errors                 |
| A06 | Vulnerable Components     | Log4Shell-class (CVE-2021-44228), abandoned transitive deps                          |
| A07 | Authn Failures            | credential stuffing, predictable session IDs, MFA bypass, reset-link enumeration     |
| A08 | Integrity Failures        | unsigned update pipeline, unsafe deserialization, dep confusion                      |
| A09 | Logging Failures          | auth failures unlogged, alerts no one reads, no centralization                       |
| A10 | SSRF                      | hit `169.254.169.254` (AWS IMDS), pivot to internal services, `file://`              |

## A01 — Broken Access Control

**What it is**: authorization decisions missing, wrong, or client-side only. The most common category in 2025 by a wide margin.

**Manifestations**: IDOR (`/posts/123` returns anyone's post), forced browsing (`/admin` works without role check), JWT role tampering when `alg=none` is accepted, function-level missing checks (POST `/users/{id}/role` from a non-admin).

**Mitigation**:

```python
# Wrong
@app.get("/posts/<int:post_id>")
def get(post_id):
    return Post.query.get(post_id).to_dict()

# Right — scope by owner at the query
@app.get("/posts/<int:post_id>")
def get(post_id):
    post = Post.query.filter_by(id=post_id, author_id=current_user.id).first_or_404()
    return post.to_dict()
```

Deny-by-default. Server-side check every request. Scope objects to owners _in the query_, not after fetching. Test: log in as A, hit B's URL — if you get B's data, bug exists.

## A02 — Cryptographic Failures

**What it is**: sensitive data exposed by weak crypto, missing crypto, or hard-coded keys.

**Manifestations**: MD5/SHA1 for passwords; ECB or DES mode; hard-coded AES keys; TLS not enforced; sensitive fields un-encrypted at rest; secrets in JWT claims.

**Mitigation**: TLS 1.2+ everywhere with HSTS. AES-GCM or ChaCha20-Poly1305 for symmetric. argon2id / bcrypt(12+) / scrypt for passwords. KMS or Vault for key custody. Never roll your own crypto — use the language's stdlib or a vetted library (libsodium, cryptography, ring).

## A03 — Injection

**What it is**: user input interpreted as code in some sink (SQL, NoSQL, shell, template, LDAP, XPath, log).

**SQLi — only correct shape** (query template + bound values):

```python
cursor.execute("SELECT * FROM users WHERE email = %s", (email,))    # py
```

```go
db.Query("SELECT * FROM users WHERE email = $1", email)              // go
```

```ts
await db.query("SELECT * FROM users WHERE email = $1", [email]); // ts
```

**Hard cases — placeholders bind values, not identifiers**:

- Dynamic table/column: allow-list, never sanitize: `if table not in ALLOWED: raise`.
- Dynamic ORDER BY: allow-list + safe fallback.
- `IN (...)` with N values: build the placeholders dynamically, bind the values: `",".join(["%s"] * len(ids))`.
- LIKE patterns: escape `%` and `_` with `ESCAPE '\\'`.

**ORM escape hatches are where injections live** — `.raw()`, `.extra()`, `text()`, `$queryRawUnsafe`, `db.Raw()`. Grep for them in review.

**NoSQL**: `db.users.findOne({email, password: req.body.password})` matches any user if password is `{$ne: null}`. Type-check inputs.

**Shell**: never build the command line via string concat with user input. Always pass an argv list with `shell=False`: `subprocess.run(["foo", user_input], shell=False)`.

## A04 — Insecure Design

**What it is**: the design lacks the control, regardless of implementation quality. No careful coding rescues a flawed design.

**Manifestations**: no rate limit on `/login` so credential stuffing works; transfer endpoint accepts negative amounts; password reset that doesn't invalidate the token after use.

**Mitigation**: threat-model first. Write misuse cases alongside use cases ("attacker submits negative amount", "attacker replays the reset link"). Defence in depth — never single-point checks.

## A05 — Security Misconfiguration

**What it is**: defaults left on, IaC sloppy, verbose errors leak internals.

**Manifestations**: default admin/admin; S3 bucket public; debug endpoints (`/actuator`, `/debug/pprof`) reachable from internet; CORS `allow_origins=["*"]` with credentials; stack traces in 500 responses; missing security headers.

**Mitigation**: hardened base images (distroless, Chainguard, Wolfi). IaC reviewed by `checkov`/`tfsec` in CI. Error pages stripped in prod. Security headers set globally:

```
Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

## A06 — Vulnerable and Outdated Components

**Manifestations**: Log4Shell (CVE-2021-44228) in transitive jars; spring4shell on actuator-exposed apps; jackson-databind RCE on unsafe deserialization; lib that's been abandoned for 3 years; server N versions behind.

**Mitigation**: SBOM (CycloneDX/SPDX) per build. Lockfiles committed; CI installs from them. Dependabot/Renovate auto-PRs — group patch, individually review majors. `osv-scanner` or stack-native audit (`npm audit`, `pip-audit`, `govulncheck`, `cargo audit`) every PR + nightly.

## A07 — Identification and Authentication Failures

**Manifestations**: predictable session IDs; no rate limit so credential stuffing works; MFA absent or bypassable; reset leaks "user not found" vs "wrong password" (account enumeration); reset token never expires.

**Mitigation**: rate limit `/login`, `/reset`, `/signup` (5/min/IP + 20/hr/account). Constant-time generic error ("invalid credentials"). MFA for admins. Opaque 128-bit session IDs. Cookies `HttpOnly; Secure; SameSite=Lax`. Reset tokens single-use, ≤ 30 min. Regenerate session ID on every privilege change.

## A08 — Software and Data Integrity Failures

**Manifestations**: unsafe deserialization of untrusted bytes (binary-object formats, Java `ObjectInputStream`, `yaml.load`); CI pipeline pulls unsigned packages; auto-update without signature check; dependency confusion (private name shadowed by public).

**Mitigation**: never deserialize untrusted binary blobs — JSON, or signed/verified formats. `yaml.safe_load` not `yaml.load`. Sign commits + releases (gitsign, sigstore). Verify checksums in CI. Pin internal package namespaces (`@yourorg/foo`); publish public stubs to claim them.

## A09 — Security Logging and Monitoring Failures

**Manifestations**: auth failures unlogged so brute force invisible; admin actions unaudited; logs scattered across hosts; alerts in a Slack channel no one reads.

**Mitigation**: structured logs for auth attempts (success + fail), authz denials, admin actions, data exports, MFA changes. Centralize (Loki/ELK/Datadog). Alert on patterns (5x failed logins same IP, sudden export volume, login from new country). **Test the alert path quarterly**. **Scrub secrets from logs** — passwords, tokens, full Authorization headers, PAN/SSN.

## A10 — Server-Side Request Forgery (SSRF)

**Manifestations**: webhook fetcher, image-proxy, URL preview, PDF generator (headless Chrome). Attacker submits `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS IMDS), `http://localhost:6379/` (internal Redis), `file:///etc/passwd`.

**Mitigation**: allow-list destination hosts/schemes. Block private IP ranges (RFC 1918, 169.254/16, ::1, fc00::/7). **Resolve the hostname yourself, validate the IP, then connect to that IP directly — pass the IP to the HTTP client AND set `Host: <original-hostname>` so TLS/vhost still works.** If you pass the original hostname back to `requests.get()`/`http.Get()`, the stdlib re-resolves it and the DNS-rebinding race window is still open. Concrete shapes: Python `urllib3.PoolManager(retries=Retry(redirect=0))` against the resolved IP with `headers={"Host": orig_host}`; Go custom `http.Transport.DialContext` that hands the validated IP to `net.Dial`. **Disable HTTP redirects entirely**: Go `http.Client.CheckRedirect = func(_, _) error { return http.ErrUseLastResponse }`; Python `requests.get(..., allow_redirects=False)`; Node `axios.get(..., { maxRedirects: 0 })`. One redirect bounces a whitelisted domain to an internal IP. Dedicated egress proxy with no internal creds. AWS: enforce IMDSv2 (token-based) — SSRF can't reach it without an extra header.

## Anti-patterns across categories

- "We'll add A04 (rate limits) after launch" — credential stuffing finds you within a week
- A01: trusting the JWT `role` claim from the client without server-side re-check
- A02: AES-ECB on anything (patterns leak), or AES-CBC without a MAC (padding oracle)
- A03: stored procedure that builds dynamic SQL inside — same problem, harder to audit
- A05: leaving `/debug/pprof`, `/actuator`, GraphQL playground, or admin endpoints reachable in prod
- A06: pinning a known-CVE dep "for now" with no follow-up ticket
- A07: "remember me" that lasts a year, can't be invalidated, grants full privileges
- A09: logging the full `Authorization` header or the failing query _with params spliced in_
- A10: allow-list of _domains_ without blocking redirects — attacker bounces via a controlled domain to internal IP
