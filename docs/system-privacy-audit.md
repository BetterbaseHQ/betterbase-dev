# System-Wide Privacy Audit

**Status:** Initial audit complete, expert-reviewed
**Date:** 2026-02-13

---

## Purpose

This document audits the entire Betterbase for data minimization, metadata leakage, and privacy-preserving design. It covers every service, every database table, every log line, and every network boundary — identifying what the ideal state looks like and what changes are needed to get there.

The [Multiplayer Privacy Plan](./multiplayer-privacy-plan.md) focused on shared spaces and invitations. This audit covers the full system: accounts, sync, inference, client packages, infrastructure, and local storage.

> **Pre-production system.** Betterbase is greenfield — there are no deployed users, no migration compatibility constraints, and no backwards-compatibility requirements. Every change in this document can be made cleanly: drop columns, change API signatures, alter token lifetimes. We should take full advantage of this to ship a pristine baseline. There is no reason to carry forward any debt or half-measures — get it right before the first user touches it.

---

## Design Principles (Recap)

1. **Don't collect what you don't need** — the best protection is absence of data
2. **Honest-but-curious server** — minimize what the operator learns through normal operation
3. **Architectural separation** — accounts and sync in separate databases forces explicit correlation (but see [cross-DB correlation](#cross-database-correlation) — this is policy-enforced, not cryptographic)
4. **Encrypt at boundary** — plaintext locally for queryability, encrypted on the wire
5. **Ephemeral over persistent** — prefer in-memory state with TTLs over permanent records

---

## Service-by-Service Assessment

### 1. betterbase-accounts (Auth Service)

**Role:** Identity, authentication, key management, OAuth token issuance.

#### What's Already Good

| Property | Status | Details |
|----------|--------|---------|
| Zero-knowledge passwords | Done | OPAQUE protocol — server never sees plaintext |
| Verification codes hashed | Done | SHA-256 in DB, plaintext never stored |
| Refresh tokens hashed | Done | SHA-256 only, with reuse detection |
| Anti-enumeration | Done | Fake OPRF seeds for non-existent accounts (timing-safe) |
| Recovery blobs encrypted | Done | Client-side encryption, server stores ciphertext |
| Mailbox ID derivation | Done | HKDF from client-held encryption key |
| Envelope encryption | Done | Per-grant scoped keys wrapped by root key |
| PKCE + JWE key delivery | Done | Encryption key delivered via JWE, bound to ephemeral ECDH |

#### What the Server Stores (PII Inventory)

| Table | Column | Data Type | Necessary? | Notes |
|-------|--------|-----------|------------|-------|
| `accounts` | `email` | Plaintext | Yes | Verification, recovery. Only PII the server must hold. |
| `accounts` | `username` | Plaintext | Yes | User-chosen public identifier |
| `accounts` | `created_at` | Timestamp | **No** | Convention — never queried by application |
| `accounts` | `updated_at` | Timestamp | Marginal | Used for debugging, not business logic |
| `email_verification_rate_limits` | `email` | Plaintext | Yes | Rate limiting key (short-lived rows) |
| `login_attempts` | `username` | Plaintext | Yes | Lockout tracking |
| `recovery_requests` | `email` | Plaintext | Yes | Rate limiting key |
| `oauth_grants` | `last_used_at` | Timestamp | Marginal | Token refresh tracking |

#### Issues and Recommendations

**ACC-1: `account_id` logged on every authenticated request** (Medium)

`logging.go` logs `account_id` (UUID) on every authenticated request. While not directly human-identifiable, it correlates with the accounts table. Additionally, `recovery.go:341` logs `account_id` in an error path.

**Current:**
```go
// logging.go — every authenticated request
if accountID := AccountIDFromContext(r.Context()); accountID != "" {
    attrs = append(attrs, slog.String("account_id", accountID))
}

// recovery.go:341 — error path
s.logger.Warn("failed to store new recovery blob",
    slog.String("account_id", state.AccountID), ...)
```

**Ideal:** Replace with a per-request pseudonym or remove entirely. The sync server already removed `user_id` from logs in Phase 1.

**Recommendation:** Remove `account_id` from request logs in `logging.go`. For `recovery.go`, this is a security-relevant error path — keep but mark with a `// SECURITY:` comment. Add a `request_id` for log correlation instead.

**Priority:** Medium. Accounts server logging is the remaining identity link in structured logs.

---

**ACC-2: Email address in recovery GET query parameter** (Low)

`GET /v1/accounts/recovery-blob?email=...` puts the email address in the URL. Reverse proxies, CDNs, and browser history log URLs by default.

**Ideal:** Move email to request body (`POST`) or a header.

**Recommendation:** Change to `POST /v1/accounts/recovery-blob` with email in the JSON body. Pre-production — no compatibility concerns.

**Priority:** Low severity, near-zero cost. Include in Phase A.

---

**ACC-3: Email addresses stored plaintext in rate limit tables** (Low)

`email_verification_rate_limits` and `recovery_requests` store plaintext email addresses for rate limiting.

**Ideal:** Use `HMAC(key, canonical_email)` as the rate limit key instead of plaintext email. The sync server already does this for invitation rate limits (Phase 5).

**Recommendation:** Replace plaintext email with HMAC hash in rate limit tables. Keep the HMAC key as a server secret.

**Priority:** Low. These rows have short TTLs, but a database breach would expose the email → rate-limit-count mapping.

---

**ACC-4: `accounts.created_at` timestamp** (Low)

The `created_at` column on the accounts table is never queried by application logic. It reveals account creation time.

**Ideal:** Drop the column.

**Recommendation:** Drop in a future migration. Not urgent — account creation time is low-sensitivity metadata.

**Priority:** Low.

---

**ACC-5: `oauth_grants.last_used_at` timestamp** (Low)

Reveals token refresh patterns (when users were active).

**Ideal:** Remove or replace with a coarser-grained "last week" bucket.

**Recommendation:** Keep for now — useful for security (detecting stale grants). Consider replacing with a boolean `recently_active` in the future.

**Priority:** Low.

---

**ACC-6: `oauth_refresh_tokens` reveals session activity patterns** (Low)

Each token refresh creates or updates a row in `oauth_refresh_tokens`. The chain of refresh token hashes over time reveals session continuity — refresh frequency maps to user activity patterns. This is similar to ACC-5 but potentially more granular.

**Ideal:** Treat identically to ACC-5 — document as known tradeoff. Refresh token rotation is a security requirement (RFC 6749), so the storage is necessary.

**Recommendation:** Document as known limitation. Consider coarser-grained refresh tracking (e.g., last-day granularity) in the future.

**Priority:** Low. Standard OAuth behavior.

---

**ACC-7: Access token TTL is 1 hour — should be shorter for SPA** (Medium)

`OAuthAccessTokenExpiry = 1 * time.Hour` in `services/jwt.go:25`. For an SPA where tokens are stored in `localStorage` (CLIENT-1), a stolen access token remains valid for up to 1 hour. Industry standard for security-sensitive SPAs is 5-15 minutes.

**Decision:** Reduce to **15 minutes**. This matches the sync server's session TTL and can be tightened further later. Offline users are unaffected — refresh tokens last 30 days (`OAuthRefreshTokenExpiry = 30 * 24 * time.Hour`), so returning after days offline triggers a silent refresh, not re-authentication.

**Recommendation:** Change `OAuthAccessTokenExpiry` to `15 * time.Minute` in `services/jwt.go`. Update `OAuthAccessTokenExpiry.Seconds()` usage in token responses accordingly (already dynamic).

**Priority:** Medium. Directly reduces the window of exposure for token theft via XSS.

---

**ACC-8: SMTP dev mode guard** (Informational)


When `SMTP_DEV_MODE=true`, verification codes and email addresses are printed to stdout. A startup warning exists but there's no hard production guard.

**Recommendation:** Add a build-time or environment check that prevents dev mode in production builds.

**Priority:** Informational. Already gated and warned.

---

### 2. betterbase-sync (Sync Service)

**Role:** Encrypted blob storage, real-time sync, invitations, membership.

#### What's Already Good

| Property | Status | Details |
|----------|--------|---------|
| No PII in logs | Done | UCAN errors sanitized via `classifyUCANError()` |
| No writer column | Done | Records have `(id, space_id, blob, sequence)` only |
| No record timestamps | Done | Removed in Phase 1 |
| Encrypted blobs | Done | Server stores opaque ciphertext |
| Per-record DEKs | Done | Envelope encryption with AES-KW wrapped DEKs |
| Mailbox-based invitations | Done | Phase 2 — no plaintext sender/recipient |
| Encrypted membership log | Done | Phase 2.5 — UCAN payloads encrypted under space key |
| Signed membership entries | Done | Phase 5 — ECDSA P-256 signatures |
| Opaque session tokens | Done | HMAC-based, no user identity stored |
| Ephemeral rate limiting | Done | HMAC actor hashes, 1-hour TTL |
| Timing mitigation | Done | 1-5s random delay on invitation broadcasts |
| `PRIVACY` comment on session handler | Done | Explicit policy not to log identity |

#### What the Server Stores (Metadata Inventory)

| Table | Column | Necessary? | Privacy Impact |
|-------|--------|------------|----------------|
| `spaces.created_at` | Timestamp | **No** | Reveals space creation time |
| `spaces.updated_at` | Timestamp | Marginal | Last push time |
| `spaces.client_id` | OAuth client | Yes | Needed for personal space creation |
| `spaces.root_public_key` | 33-byte P-256 | Yes | Needed for UCAN root validation |
| `invitations.created_at` | Timestamp | Marginal | Used for TTL ordering and purge |
| `invitations.expires_at` | Timestamp | Yes | Invitation expiry |
| `records.sequence` | Integer | Yes | Sync protocol cursor |
| `files.size` | Integer | Yes | Server must know for storage limits |

#### Issues and Recommendations

**SYNC-1: `spaces.created_at` and `spaces.updated_at` timestamps** (Low)

These timestamps reveal when spaces were created and when the last push occurred. The records table already dropped timestamps in Phase 1, but the spaces table still has them.

**Ideal:** Drop `created_at`. Keep `updated_at` only if needed for garbage collection of abandoned spaces.

**Decision:** Drop `created_at`. **Keep `updated_at` for now** — it serves as a GC signal for abandoned spaces and will be revisited alongside future optional tracking work.

**Priority:** Low. Space-level timing is less sensitive than record-level timing.

---

**SYNC-2: `files.created_at` still exists** (Low)

The multiplayer privacy plan documents this as "dropped in Phase 1" but migration 006 only dropped `files.created_at`'s index, not the column itself, or it may have been omitted entirely.

**Ideal:** Drop the column for consistency with records table.

**Recommendation:** Verify current state and drop if still present.

**Priority:** Low. Consistency improvement.

---

**SYNC-3: `invitations.created_at` used for TTL ordering** (Informational)

This timestamp is functionally necessary for invitation expiry (`expires_at = created_at + 7 days`) and purge ordering. Unlike other timestamps, removing it would break the invitation lifecycle.

**Recommendation:** Keep. Document as intentionally retained for TTL management.

---

**SYNC-4: File sizes not padded** (Medium — Future Work)

Record blobs use size-bucket padding (256, 1K, 4K, 16K, 64K, 256K, 1M). File uploads do not have padding — the server sees exact file sizes. File size is a well-studied fingerprinting vector — an adversary can identify file types from ciphertext sizes (JPEG headers, PDF structure produce characteristic sizes).

**Ideal:** Pad files to the nearest 4KB boundary.

**Recommendation:** Use 4KB-boundary padding instead of power-of-2 buckets. Average overhead is ~2KB per file (vs. doubling storage with power-of-2). This aligns with filesystem block sizes and defeats most size-based fingerprinting. Defer implementation but document the chosen approach.

**Priority:** Medium for the audit document, low for implementation. Files are already E2EE with per-file DEKs.

---

**SYNC-5: Epoch number in wrapped DEKs reveals temporal information** (Low)

The 4-byte epoch prefix in wrapped DEKs (`[epoch(4) || AES-KW(KEK, DEK)(40)]`) tells the server when a record was encrypted relative to key rotation events.

**Ideal:** Encrypt the epoch number or remove it from server-visible data.

**Recommendation:** Accept as tradeoff. The epoch is needed for the server to enforce `min_key_generation` (stale key rejection after revocation). Removing it would require blind key rotation, which is significantly more complex.

**Priority:** Low. The tradeoff (temporal correlation vs. revocation enforcement) favors keeping it.

---

### 3. betterbase-inference (E2EE Inference Proxy)

**Role:** Authenticated proxy to Tinfoil TEE for AI inference. True E2EE — proxy never sees plaintext prompts or completions.

#### What's Already Good

| Property | Status | Details |
|----------|--------|---------|
| No persistent storage | Done | Zero database, all state in-memory |
| True E2EE proxy | Done | Request/response bodies forwarded encrypted, never inspected |
| Client JWT not forwarded | Done | Tinfoil receives server API key, not user identity |
| In-memory rate limiting | Done | Token bucket with 30-min expiry |
| Generic error messages | Done | No prompt content in errors |
| Health checks skip auth | Done | No identity leaked on health endpoints |
| ES256-only JWT validation | Done | No algorithm confusion attacks |

#### Issues and Recommendations

**INF-1: `user_id` and `issuer` logged on every request** (Medium)

Like the accounts server (ACC-1), the inference proxy logs identity fields on every request — both `issuer` (JWT `iss` claim) and `user_id` (JWT `sub` claim). This occurs in **two independent locations**: the logging middleware and the proxy handler itself.

**Current — `logging.go` (middleware, all requests):**
```go
if issuer := IssuerFromContext(r.Context()); issuer != "" {
    attrs = append(attrs, slog.String("issuer", issuer))
}
if userID := UserIDFromContext(r.Context()); userID != "" {
    attrs = append(attrs, slog.String("user_id", userID))
}
```

**Current — `proxy.go` (handler, error/warning paths at lines 45, 77, 113):**
```go
slog.String("user_id", userID),  // repeated in 3 error/warning log calls
```

**Ideal:** Remove both `issuer` and `user_id` from request logs in both files, matching the sync server's approach (Phase 1 removed user identity there). The sync server logs zero identity fields — it's the gold standard.

**Recommendation:** Remove both identity fields from `logging.go` AND all three `user_id` log statements in `proxy.go`. The inference proxy should be blind to user identity — it only needs to verify "this is a valid token with `inference` scope." Use a `request_id` for log correlation.

**Important:** Fixing only `logging.go` would leave 3 identity leakage points in `proxy.go`. Both files must be addressed together.

**Priority:** Medium. For an E2EE proxy, logging user identity undermines the privacy story. The rate limiter can use an in-memory pseudonym.

---

**INF-2: Rate limit key uses `issuer:userID` concatenation** (Medium)

The rate limiter keys by `issuer + ":" + userID` — the exact pattern the sync server eliminated in Phase 2.

**Ideal:** Use `HMAC(key, issuer + "\0" + userID)` for a one-way pseudonymous rate limit key, consistent with the sync server.

**Recommendation:** Hash the rate limit key. Since state is in-memory only, the privacy benefit is modest, but it establishes consistent practice across all services.

**Priority:** Medium. Consistency with sync server's approach.

---

**INF-3: `client_id` extracted but unused** (Low)

The JWT middleware extracts `client_id` into request context but it's never used by any handler.

**Recommendation:** Remove `client_id` extraction to minimize data in context. Add it back if per-client rate limiting is needed later.

**Priority:** Low. No functional impact.

---

### 4. Client Packages (@betterbase/sdk/*)

**Role:** Client-side encryption, sync transport, auth, inference.

#### What's Already Good

| Property | Status | Details |
|----------|--------|---------|
| Non-extractable CryptoKeys | Done | Encryption keys stored in IndexedDB as non-extractable objects |
| HKDF mailbox derivation | Done | Deterministic, one-way, server never sees encryption key |
| AES-256-GCM with AAD | Done | Ciphertext bound to space + record (anti-relocation) |
| Per-record DEKs | Done | Envelope encryption with AES-KW |
| Size-bucket padding | Done | 7 buckets from 256B to 1MB |
| Epoch-based forward secrecy | Done | HKDF ratcheting with 30-day default |
| JWE invitation encryption | Done | ECDH-ES+A256KW — server never sees invitation content |
| Signed membership entries | Done | ECDSA P-256 on all membership log mutations |
| UCAN nonce | Done | Random 16-byte nonce prevents replay |

#### What's Stored Locally

**localStorage (`less_session_state`):**
| Field | Sensitive? | Notes |
|-------|-----------|-------|
| `accessToken` | Yes | JWT — contains `sub`, `iss`, `exp`, `personal_space_id` |
| `refreshToken` | Yes | Opaque token for token refresh |
| `expiresAt` | No | Token expiry (Unix ms) |
| `personalSpaceId` | No | Deterministic, public |
| `appPublicKeyJwk` | No | Public key (safe) |
| `epoch`, `epochAdvancedAt` | No | Forward secrecy bookkeeping |

**IndexedDB `less-key-store`:**
| Key | Extractable? | Notes |
|-----|-------------|-------|
| `encryption-key` | No | 256-bit AES-GCM — XSS cannot exfiltrate raw bytes |
| `epoch-key` | No | 256-bit AES-KW — same protection |
| `app-private-key` | Yes (for ECDH) | P-256 — needed for ECDH `deriveBits`, cannot be non-extractable |

**IndexedDB (app data via @betterbase/sdk/db):**
All document data stored **plaintext** for queryability. This is by design (encrypt-at-boundary).

#### Issues and Recommendations

**CLIENT-1: Tokens in localStorage are XSS-vulnerable** (Medium — Inherent)

Access tokens and refresh tokens in `localStorage` can be read by any JavaScript running on the same origin. This is inherent to SPAs without a backend-for-frontend (BFF) pattern.

**Ideal (long-term):** HttpOnly cookies via a thin BFF, or use `sessionStorage` (clears on tab close) for access tokens.

**Recommendation:** Document as known tradeoff. The encryption keys in IndexedDB as non-extractable CryptoKeys are the critical defense — even if tokens leak, the attacker can't exfiltrate key material. However, a stolen access token still allows API calls (pull encrypted blobs, push garbage, create invitations) for its remaining lifetime.

**Mitigations:** Short access token lifetime (see ACC-7: reduce from 1 hour to 5-15 minutes), CSP headers (INFRA-5), CORS scoping (INFRA-4). Long-term: consider DPoP (RFC 9449) to bind tokens to client key pairs.

**Priority:** Medium. Standard SPA tradeoff, not specific to Betterbase.

---

**CLIENT-2: Padding reveals coarse-grained record size** (Low)

7 size buckets (256B to 1MB) reveal which bucket a record falls into. A 100-byte note and a 200-byte note both land in the 256B bucket, but a 300-byte note jumps to 1KB.

**Ideal:** Add random padding within each bucket (e.g., pad to bucket size + random(0, next_bucket/4)).

**Recommendation:** Add intra-bucket random padding in a future release. Low priority since the server already can't read content.

**Priority:** Low.

---

**CLIENT-3: Local data stored unencrypted in IndexedDB** (Informational — By Design)

All document data (todos, notes, etc.) is stored plaintext in IndexedDB for queryability. An attacker with filesystem access can read everything.

**Ideal (optional):** Offer an opt-in at-rest encryption mode for high-security use cases.

**Recommendation:** Document as intentional (encrypt-at-boundary design). Users who need local encryption can use OS-level disk encryption (FileVault, BitLocker). Application-level IndexedDB encryption would break queryability and add significant complexity.

**Priority:** Informational. By design.

---

**CLIENT-4: Contact discovery reveals social intent** (Medium — Documented)

`GET /users/{username}/keys/{client_id}` tells the accounts server that user A looked up user B's public key, building a social intent graph before any invitation is sent.

**Ideal:** Private information retrieval (PIR) or OPRF-based lookup.

**Recommendation:** Accept as inherent to username-based sharing. PIR is disproportionately complex for the threat model. Document as known limitation (already in multiplayer privacy plan).

**Priority:** Low for implementation, medium for documentation. Already documented.

---

### 5. Infrastructure (Docker, Caddy, CAP)

#### What's Already Good

| Property | Status | Details |
|----------|--------|---------|
| Database isolation | Done | Accounts and sync use separate PostgreSQL instances |
| No cross-DB references | Done | Sync server never queries accounts DB |
| Internal service communication | Done | JWKS and CAP verification are container-to-container |
| Tiered rate limiting | Done | Caddy: strict/moderate/standard/relaxed per endpoint |
| Dev volume isolation | Done | `dev_*` prefixes prevent prod data deletion |
| CAP is anonymous | Done | Proof-of-work — no cookies, no user tracking |
| SMTP dev mode | Done | Dev environment logs emails instead of sending |
| No analytics in examples | Done | Zero tracking libraries in todo/notes apps |

#### What Caddy Sees

| Data | Visible? | Notes |
|------|----------|-------|
| Client IP | Yes | Standard for reverse proxies, needed for rate limiting |
| HTTP method, path | Yes | Paths contain UUIDs (space IDs, record IDs), not usernames |
| Request/response sizes | Yes | Reveals activity volume |
| Timing | Yes | Request latency, connection duration |
| Authorization header | Transit only | Not logged, not parsed by Caddy |
| Request bodies | Transit only | Not logged |
| User identity | **No** | No user_id extraction in Caddy config |
| CORS policy | `*` (all origins) | **Must scope in production** (INFRA-4) |

#### Issues and Recommendations

**INFRA-1: IP addresses logged by Caddy** (Informational — Standard)

Standard for any web server. Required for rate limiting and abuse prevention.

**Ideal (production):** Configure log retention policy (e.g., 7-day rotation). In privacy-sensitive jurisdictions (EU), document the legal basis for IP logging (legitimate interest for security).

**Recommendation:** Add log rotation configuration to production Caddyfile.

**Priority:** Low. Standard practice.

---

**INFRA-2: `IDENTITY_HASH_KEY` and `SPACE_SESSION_SECRET` not prominently documented** (Low)

These privacy-critical sync server secrets are documented in code comments (`cmd/server/main.go`) but not in the platform's environment setup documentation. They're generated by `just setup` but operators deploying manually might miss them.

**Recommendation:** Document these in the platform root `.env.example` or in docker-compose comments with generation instructions:
```bash
# Sync server: privacy-preserving rate limiting (generate: openssl rand -hex 32)
IDENTITY_HASH_KEY=
# Sync server: opaque session tokens (generate: openssl rand -hex 32)
SPACE_SESSION_SECRET=
```

**Priority:** Low. Documentation improvement.

---

**INFRA-3: No TLS in development Caddyfile** (Informational)

Expected for local development. Production should use Caddy's automatic HTTPS.

**Recommendation:** Document production TLS setup. Consider adding a `Caddyfile.production` template.

**Priority:** Informational.

---

**INFRA-4: CORS `Access-Control-Allow-Origin: *` in Caddyfile** (Medium)

Both accounts and sync Caddy routes return `Access-Control-Allow-Origin: *` (Caddyfile lines 95, 252). This means any origin can make API requests. Combined with tokens in `localStorage` (CLIENT-1), a malicious third-party page could issue API requests using exfiltrated tokens.

**Current:**
```
header Access-Control-Allow-Origin "*"
```

**Ideal:** Scope to actual application origins in production. The wildcard is acceptable for development only.

**Recommendation:** Add a production Caddyfile (or environment-based override) that restricts `Access-Control-Allow-Origin` to the deployed application origins.

**Priority:** Medium. Essential production hardening. Without this, XSS on any origin can leverage stolen tokens.

---

**INFRA-5: No Content Security Policy (CSP) headers** (Medium)

No CSP headers are set in the Caddyfile. For apps that store encryption keys in the browser, a strict CSP is essential defense-in-depth against XSS — the primary local attack vector (CLIENT-1).

**Ideal:** `script-src 'self'; object-src 'none'` at minimum.

**Recommendation:** Add CSP headers to the production Caddyfile. Start with a report-only policy to identify violations, then enforce. This is the primary defense layer for the XSS threat that CLIENT-1 identifies.

**Priority:** Medium. Standard web security measure that directly complements the E2EE story.

---

**INFRA-6: Database connections use `sslmode=disable`** (Low — Production)

Both accounts and sync services connect to PostgreSQL with `sslmode=disable` (docker-compose.yml lines 68, 105). Within a Docker network this is standard, but production deployments with managed databases (RDS, Cloud SQL) or cross-host networking require `sslmode=verify-full` to prevent MITM on the DB wire.

**Recommendation:** Document as production hardening requirement. Add `sslmode=verify-full` guidance for non-Docker deployments.

**Priority:** Low. Standard for Docker, critical for production.

---

**INFRA-7: JWKS fetch is unencrypted HTTP between containers** (Low — Production)

The sync server fetches JWKS from `http://accounts:5377/.well-known/jwks.json`. In Docker this is internal, but in multi-host deployments (Kubernetes cross-node, multi-VM) this becomes a vector for JWKS substitution — an attacker who controls the network can inject their own signing keys.

**Recommendation:** Document that production deployments with cross-host service communication should use mTLS or HTTPS for JWKS fetches.

**Priority:** Low. Standard for Docker, important for production.

---

## Cross-Cutting Concerns

### Logging Consistency

| Service | Logs user identity? | Status |
|---------|-------------------|--------|
| betterbase-accounts | `account_id` in middleware + `recovery.go` error path | **Remove** from middleware, mark recovery as `// SECURITY:` (ACC-1) |
| betterbase-sync | No identity fields at all (gold standard) | Done |
| betterbase-inference | `issuer` + `user_id` in middleware AND 3x `user_id` in proxy handler | **Remove all** (INF-1) |
| Caddy | No | Done |

**Target state:** Zero user identity in normal request logs across all services. Use `request_id` for log correlation. **Exception:** Security-critical events (authentication failures, token reuse detection, suspicious activity) may log identity for incident response — these should be clearly documented with `// SECURITY:` comments in code.

### Rate Limiting Consistency

| Service | Rate limit key | One-way? | Ephemeral? |
|---------|---------------|----------|------------|
| betterbase-accounts | Plaintext `email` | **No** | Yes (TTL rows) |
| betterbase-sync | `HMAC(key, issuer + "\0" + userId)` | Yes | Yes (1-hour cleanup) |
| betterbase-inference | `issuer + ":" + userID` | **No** | Yes (in-memory) |

**Target state:** All services use HMAC-based pseudonymous rate limit keys. No plaintext identity in rate limit storage.

### Timestamp Audit

| Table | `created_at` | `updated_at` | Queried? | Action |
|-------|-------------|-------------|----------|--------|
| `accounts` | Yes | Yes | No / Debugging | Drop `created_at`, evaluate `updated_at` |
| `oauth_grants` | Yes | No | No | Drop `created_at` |
| `oauth_codes` | Yes | No | TTL expiry | Keep (needed for code expiry) |
| `oauth_refresh_tokens` | Yes | No | Token rotation | Keep (needed for rotation detection) |
| `spaces` | Yes | Yes | No / Debugging | Drop `created_at`, evaluate `updated_at` |
| `records` | No | No | — | Already clean |
| `members` | No | No | — | Already clean (Phase 1) |
| `revocations` | No | No | — | Already clean (Phase 1) |
| `files` | Yes | No | No | Drop |
| `invitations` | Yes | Yes | TTL ordering / Purge | Keep (needed for expiry) |
| `rate_limit_actions` | Yes | No | Cleanup window | Keep (needed for ephemeral cleanup) |

---

### Cross-Database Correlation

The architectural separation between accounts and sync databases is **policy-enforced, not cryptographic**. A malicious or compromised operator can trivially deanonymize the system:

| Join Path | What It Reveals |
|-----------|----------------|
| `accounts.mailbox_id` ↔ `invitations.mailbox_id` | Full social graph: who was invited to which spaces |
| `oauth_grants.account_id` + JWT `sub` claim ↔ `sessions.user_hash` | If the HMAC key is known, links accounts to sync activity |
| Timing correlation: token issuance ↔ space session creation | Statistical deanonymization even without direct joins |

**What this means:** The database separation provides **auditability** (you can detect when someone runs cross-DB queries via query logs, access controls, or network segmentation) but **not prevention**. This is standard for honest-but-curious threat models — true prevention would require anonymous credentials (BBS+) which are not yet mature.

**Recommendation:** Document this explicitly. For production deployments, recommend separate database credentials per service with cross-DB query alerting.

---

### Threat Model Analysis

#### Honest-but-Curious Server (Primary Threat Model)

This is the threat model the audit primarily addresses. The operator follows the protocol but tries to learn as much as possible from stored data and logs.

**Residual exposure after all phases:** Space membership graph (from session creation), activity timing (from push/pull), contact discovery intent (from key lookups), record counts per space.

#### Compromised Database

A database breach exposes:
- **Accounts DB:** Email addresses, usernames, OPAQUE registration records, mailbox IDs, OAuth grants. No passwords (OPAQUE), no encryption keys.
- **Sync DB:** Encrypted blobs (unreadable without KEKs), space IDs, member hashes, mailbox IDs, invitation ciphertexts. No plaintext content.
- **Cross-DB:** If both databases are breached, the mailbox ID join path fully deanonymizes the social graph.

#### Compromised Server Binary

A compromised server binary can observe everything in transit memory:

| Service | What It Can Learn |
|---------|-------------------|
| betterbase-accounts | Plaintext emails (already has them), session tokens, OPAQUE protocol messages (but not passwords — OPAQUE is resistant) |
| betterbase-sync | Encrypted blobs (cannot decrypt), JWT claims (user identity), push/pull patterns in real-time |
| betterbase-inference | **Encrypted request/response bodies** (cannot decrypt — Tinfoil TEE), but **can exfiltrate `TINFOIL_API_KEY`** and forward encrypted traffic to a third party |

**Important:** The E2EE guarantee for inference depends entirely on the integrity of the proxy binary. A compromised proxy can forward the `TINFOIL_API_KEY` and encrypted payloads, allowing a third party to proxy to the same TEE. The TEE protects content confidentiality, but a compromised proxy breaks the authentication boundary. This is inherent to the proxy architecture.

#### Network Observer

A network observer between client and Caddy (distinct from the server operator — strictly less information) sees:

| Observable | What It Reveals |
|-----------|----------------|
| TLS connection establishment | Server identity (SNI), not content |
| Request/response sizes + timing | Activity patterns, even with TLS |
| Connection duration | WebSocket usage distinguishes real-time users from batch sync |
| Concurrent connections from an IP | Device count |
| DNS queries | Which services the client contacts |

**Mitigation:** TLS is the primary defense. For users with elevated threat models, Tor or VPN are the standard recommendation. The platform cannot meaningfully defend against traffic analysis without cover traffic (impractical for mobile).

---

## What the Server Operator Learns (Full Picture)

### Accounts Server Knows

| Data | Why | Reducible? |
|------|-----|-----------|
| User identity (email, username) | Account management | No — fundamental to identity service |
| `(user → mailbox_id)` mapping | JWT claim generation | No — needed for invitation routing |
| Who looks up whom (`GET /users/{user}/keys`) | Contact discovery | Only via PIR (disproportionate complexity) |
| Token refresh timing | OAuth protocol | Consider longer token lifetimes |
| Which clients a user has authorized | OAuth grants | No — needed for consent management |

### Sync Server Knows

| Data | Why | Reducible? |
|------|-----|-----------|
| Space IDs and their members | Session creation (15-min intervals) | Only via anonymous credentials (BBS+, not mature) |
| Record counts and sequences per space | Sync protocol | No — fundamental to sync |
| Encrypted blob sizes (padded buckets) | Storage | Add intra-bucket random padding |
| File sizes (unpadded) | Storage limits | Add file padding (expensive) |
| Push/pull timing | Real-time sync | Cover traffic (expensive, impractical for mobile) |
| Mailbox IDs receiving invitations | Invitation routing | No — already pseudonymous |
| WebSocket connection duration | Real-time events | No — inherent to long-lived connections |

### Inference Proxy Knows

| Data | Why | Reducible? |
|------|-----|-----------|
| Which users make inference requests | Rate limiting | Use pseudonymous rate limit key (INF-2) |
| Request timing and frequency | Real-time proxy | No — inherent to proxying |
| Approximate request/response sizes | Streaming | No — inherent to proxying |
| Encrypted request/response bodies | E2EE transit | **Cannot read** — Tinfoil TEE only |

### Neither Server Alone Knows

| Data | Why |
|------|-----|
| Who sent an invitation | Sender identity only in JWE payload (encrypted to recipient) |
| Who authored a specific record | No writer column, session tokens are opaque |
| What's in any record | AES-256-GCM with per-record DEKs |
| The UCAN delegation graph | Encrypted in membership log (Phase 2.5) |
| Plaintext inference prompts/completions | E2EE via Tinfoil TEE (assumes non-compromised proxy — see [threat model](#compromised-server-binary)) |

---

## Implementation Priorities

### Phase A: Logging, Rate Limits & Quick Wins (Days)

1. **ACC-1:** Remove `account_id` from accounts server request logs (`logging.go` + audit `recovery.go`)
2. **INF-1:** Remove `user_id` + `issuer` from inference proxy (`logging.go` AND `proxy.go` — all 4 locations)
3. **INF-2:** Hash inference rate limit key with HMAC
4. **ACC-3:** Hash email in rate limit tables with HMAC
5. **ACC-2:** Change recovery blob endpoint from GET to POST (trivial, do alongside other changes)
6. **ACC-7:** Reduce `OAuthAccessTokenExpiry` from 1 hour to 5-15 minutes

### Phase B: Timestamp Cleanup (Days)

7. **ACC-4:** Drop `accounts.created_at`
8. **SYNC-1:** Drop `spaces.created_at` (evaluate `updated_at` for GC use)
9. **SYNC-2:** Drop `files.created_at` (verify current state)

### Phase C: Documentation & Production Hardening (Hours)

10. **INFRA-2:** Add `IDENTITY_HASH_KEY` and `SPACE_SESSION_SECRET` to `.env.example`
11. **INFRA-4:** Scaffold CORS with env variable (e.g., `CORS_ALLOWED_ORIGINS`) — Caddyfile reads from env, defaults to `*` for dev, operators set actual origins for production
12. **INFRA-5:** Scaffold CSP headers in Caddyfile (`script-src 'self'; object-src 'none'`) — env-driven so operators can adjust
13. **INFRA-6/7:** Document `sslmode=verify-full` and HTTPS JWKS for production deployments
14. Document all "known limitations" in a single privacy-properties page
15. Add log rotation configuration for production Caddy

### Future Considerations (Not Scheduled)

- **CLIENT-2:** Intra-bucket random padding for record sizes
- **SYNC-4:** File size padding (4KB-boundary recommended)
- **CLIENT-1:** BFF pattern for token storage (major architectural change)
- **CLIENT-4:** Private information retrieval for contact discovery
- **DPoP (RFC 9449):** Bind access tokens to client key pairs, preventing token replay from different origins
- **SRI (Subresource Integrity):** Pin asset hashes for CDN-served client code
- Anonymous credentials (BBS+) for session creation — see multiplayer privacy plan

---

## Privacy Properties: Current vs. Ideal

| Property | Current | Ideal | Gap |
|----------|---------|-------|-----|
| **Password storage** | Zero-knowledge (OPAQUE) | Zero-knowledge | None |
| **Record encryption** | AES-256-GCM + per-record DEKs | Same | None |
| **Forward secrecy** | HKDF epoch ratcheting (30 days) | Same | None |
| **Invitation privacy** | Sealed-sender via mailbox IDs | Same | None |
| **Membership log** | Encrypted + signed | Same | None |
| **Session unlinkability** | Opaque HMAC tokens (15-min TTL) | Same | None |
| **Inference privacy** | True E2EE via Tinfoil TEE | Same | None |
| **User identity in logs** | Logged by accounts + inference | Zero across all services | **ACC-1, INF-1** |
| **Rate limit identifiers** | Mixed (plaintext + HMAC) | HMAC everywhere | **ACC-3, INF-2** |
| **Unnecessary timestamps** | Some remain | Only where functionally required | **Phase B** |
| **Record size leakage** | 7-bucket padding | Intra-bucket randomization | Future |
| **File size leakage** | Unpadded | Bucket padding | Future |
| **Contact discovery** | Username lookup reveals intent | PIR | Future (disproportionate) |
| **Access token lifetime** | 1 hour | 5-15 minutes | **ACC-7** |
| **CORS policy** | Wildcard (`*`) | Scoped to app origins | **INFRA-4** |
| **CSP headers** | None | `script-src 'self'` | **INFRA-5** |
| **Session re-exposure** | Every 15 min (JWT re-presentation) | 1-4 hour TTL | Consider |
| **Token binding** | None | DPoP (RFC 9449) | Future |
| **Local data encryption** | Plaintext IndexedDB | Optional at-rest encryption | By design |

---

## Comparison to Industry

| Platform | E2EE Data | E2EE Inference | Metadata Privacy | No Timestamps | No Writer Column | Sealed Invitations |
|----------|-----------|---------------|------------------|---------------|-----------------|-------------------|
| **Betterbase** | Yes | Yes | High | Yes | Yes | Yes |
| iCloud | Partial | No | Low | No | No | No |
| Notion | No | No | None | No | No | No |
| Google Drive | No | No | None | No | No | No |
| Obsidian Sync | Yes | No | Moderate | No | N/A | No |
| Standard Notes | Yes | No | Moderate | No | N/A | No |
| Signal | Yes | No | High | Partial | N/A | Yes |

---

## Conclusion

The Betterbase has **best-in-class privacy** for a consumer sync platform. The multiplayer privacy work (Phases 1-5) addressed the largest metadata leaks. What remains is:

1. **Consistency work** — bringing accounts and inference logging/rate-limiting up to the standard the sync server already meets
2. **Token hardening** — shorter access token lifetimes to reduce XSS exposure window
3. **Timestamp cleanup** — dropping unnecessary columns that exist by convention
4. **Production hardening** — CORS scoping, CSP headers, TLS for inter-service communication
5. **Documentation** — making the privacy properties, threat model, and known limitations explicit

No critical privacy vulnerabilities were found. The remaining items are hardening measures that reduce the attack surface of an already strong system.

**Important caveats to communicate honestly:**
- "Metadata Privacy: High" (not Signal-level) — Signal uses SGX/TEE for contact discovery, sealed sender for all messages, and anonymous credentials for groups. Betterbase achieves sealed-sender for invitations and pseudonymous sync, which is strong but distinct.
- Database separation is policy-enforced, not cryptographic — a `mailbox_id` JOIN across both DBs fully deanonymizes the social graph.
- Inference E2EE depends on proxy binary integrity — a compromised proxy can exfiltrate the Tinfoil API key.
