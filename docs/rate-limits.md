# Rate Limits

Source of truth for all rate limiting across the Less platform.

Rate limits are applied at two layers: **Caddy** (IP-based, proxy-level) and **application** (per-user/per-email). IP-based limits are generous backstops for shared IPs (offices, CGNAT). Application-level limits provide the real protection.

High-value endpoints also require a **CAP proof-of-work token** before the request is processed.

## Caddy — IP-Based Limits

All limits use a 1-minute sliding window keyed by client IP.

### betterbase-accounts (port 5377)

| Zone | Rate | Endpoints |
|------|------|-----------|
| `accounts_global` | 600/min | All (backstop) |
| `accounts_strict` | 60/min | `/v1/auth/login/init`, `/v1/auth/login/finalize`, `/v1/accounts/password/init`, `/v1/accounts/password/finalize`, `/v1/accounts/recover/init`, `/v1/accounts/recover/finalize` |
| `accounts_delete` | 60/min | `DELETE /v1/accounts` |
| `accounts_moderate` | 120/min | `/v1/accounts/verify/*`, `GET /v1/accounts/recovery-blob`, `/oauth/authorize`, `/oauth/token` |
| `accounts_standard` | 300/min | `/v1/auth/validate`, `/v1/keys`, `/v1/keys/*`, `/v1/accounts/recovery-blob`, `/oauth/consent`, `/oauth/userinfo` |
| `accounts_cap` | 300/min | `/cap/*` (proof-of-work assets, proxied to CAP service) |
| `accounts_cors` | 300/min | `OPTIONS` (CORS preflight) |
| `accounts_relaxed` | 1000/min | `/health`, `/.well-known/jwks.json` |
| `accounts_default` | 1000/min | Web UI and unmatched routes |

### betterbase-sync (port 5379)

| Zone | Rate | Endpoints |
|------|------|-----------|
| `sync_global` | 600/min | All (backstop) |
| `sync_events` | 120/min | `GET /api/v1/events` (WebSocket) |
| `sync_push` | 300/min | `PATCH /api/v1/sync` |
| `sync_pull` | 1000/min | `GET /api/v1/sync` |
| `blob_upload` | 600/min | `PUT /blobs/*` |
| `blob_read` | 2000/min | `GET/HEAD /blobs/*` |
| `sync_cors` | 300/min | `OPTIONS` (CORS preflight) |
| `sync_health` | 300/min | `/health` |
| `sync_default` | 600/min | Unmatched routes |

Config: `caddy/Caddyfile`

## Application — Per-Email Limits (betterbase-accounts)

### Login attempts

| Setting | Value | Source |
|---------|-------|--------|
| Max failed attempts | 8 per email | `LoginMaxAttempts` in `server/auth.go` |
| Window | 15 minutes | `LoginWindowDuration` in `server/auth.go` |
| Lockout escalation | 15 min → 1 hour → 24 hours | `storage/postgres.go` (`lockout_count`) |

After 8 failed attempts in 15 minutes, the account is locked. Successive lockouts escalate: 1st lockout is 15 minutes, 2nd is 1 hour, 3rd+ is 24 hours.

### Account recovery

| Setting | Value | Source |
|---------|-------|--------|
| Max requests | 5 per email | `RecoveryMaxRequests` in `server/recovery.go` |
| Window | 1 hour | `RecoveryWindowDuration` in `server/recovery.go` |

### Email verification

| Setting | Value | Source |
|---------|-------|--------|
| Max code sends | 5 per email | `MaxSendsPerHour` in `services/verification.go` |
| Window | 1 hour | `RateLimitWindow` in `services/verification.go` |
| Max attempts per code | 5 | `MaxVerificationAttempts` in `services/verification.go` |
| Code expiry | 10 minutes | `VerificationCodeExpiry` in `services/verification.go` |

## Application — Per-User Limits (betterbase-sync)

### WebSocket connections

| Setting | Value | Source |
|---------|-------|--------|
| Max connections per user | 15 | `MaxConnectionsPerUser` in `server/events.go` |
| Max connections per user+client | 5 | `MaxConnectionsPerUserClient` in `server/events.go` |

Returns 429 when exceeded. Designed for 5 devices x 2 contexts (browser + PWA) with reconnection buffer.

## CAP — Proof-of-Work CAPTCHA

The CAP service (port 3000, internal) provides proof-of-work challenges for high-value endpoints. Clients must solve a PoW challenge and present the token before the request is processed.

**Protected endpoints** (verified in `server/cap.go`):
- `/v1/auth/login/init`
- `/v1/accounts/password/init`
- `/v1/accounts/recover/init`

CAP assets are served through Caddy at `/cap/*` and proxied to the CAP service.

## Design Philosophy

IP-based limits are intentionally generous. They exist as a backstop against volumetric abuse, not as primary access control. Application-level per-email and per-user limits provide surgical protection that works regardless of IP rotation.

A legitimate user should never hit a rate limit during normal use. A 50-person office behind NAT sharing one IP can all log in and sync within ~2 minutes.
