# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Betterbase is the orchestration repo for the Betterbase ecosystem — an open platform for building local-first applications with end-to-end encryption. Data lives on device, syncs via CRDTs, and the server never sees plaintext.

- **Rust microservices** (checked out as sub-repos):
  - `betterbase-accounts` (auth, port 5377) — Axum, OPAQUE + OAuth 2.0, React web UI
  - `betterbase-sync` (blob sync, port 5379) — Axum, WebSocket RPC + CBOR, encrypted blobs
  - `betterbase-inference` (E2EE inference proxy) — Axum, forwards to Tinfoil TEE
- **Rust/WASM SDK** (checked out as sub-repo): `betterbase/` — Cargo workspace (7 crates) + TypeScript layer (`js/`) published as `betterbase` with subpath exports `/crypto`, `/auth`, `/discovery`, `/sync`, `/db`
- **Example apps** (checked out as sub-repo): `betterbase-examples/` — launchpad (portal), tasks (offline-first todos), notes (rich text CRDT), passwords (encrypted vault), photos (encrypted files), board (collaborative), chat (encrypted messaging), shared (@betterbase/examples-shared)
- **E2E tests**: Playwright browser tests in `e2e/`

betterbase-accounts and betterbase-sync use PostgreSQL. betterbase-sync validates JWTs issued by accounts via JWKS.

## Commands

### Platform-level (root)

```bash
just setup        # Clone repos, generate OPAQUE keys, provision CAP, create .env
just pull         # Pull latest changes for all repos

# Development (recommended)
just dev          # Start dev environment with hot reload (Docker Compose)
just dev-bg       # Same but detached
just dev-rebuild  # Rebuild containers after Dockerfile changes
just dev-down     # Stop dev services and remove volumes
just dev-logs     # View all logs (or pass service name: just dev-logs accounts)

# Production
just prod         # Start production
just prod-build   # Build and start production
just up           # Alias for prod
just up-build     # Build and start production
just down         # Stop services

# Testing
just check-all    # Run checks on all repos (SDK, accounts, sync, examples)
just e2e          # Full E2E cycle: clean -> setup -> run Playwright tests
just e2e-setup    # Start e2e services + create OAuth client + write e2e/.env
just e2e-test     # Run e2e tests (services must be running via e2e-setup)

# Health
just health       # Check service health
just wait         # Wait for services to become healthy

# Utilities
just db-accounts  # PostgreSQL shell for accounts
just db-sync      # PostgreSQL shell for sync
just shell-accounts  # Container shell for accounts
just shell-sync      # Container shell for sync
just ps           # Docker compose status
just restart      # Restart all dev services
just nuke         # Full reset (removes containers, volumes, images)

# Multi-repo git operations
just status       # Git status for all repos
just pull         # Pull latest for all repos
just git-diff     # Diff summary for all repos
just git-push     # Push all repos to origin
```

### betterbase (SDK)

```bash
cd betterbase
just check            # Format, lint, Rust tests, TS typecheck + vitest + browser tests
just test             # Rust tests (pure crates only)
just check-js         # TS typecheck + vitest + browser tests
just test-browser     # Browser integration tests (real WASM)
just bench            # Rust benchmarks
```

### betterbase-accounts

```bash
cd betterbase-accounts
just check        # fmt, lint, test, test-web
just test         # Rust tests
just test-web     # Vitest for React frontend
just dev          # Rust server + Vite dev server (hot reload)
```

### betterbase-sync

```bash
cd betterbase-sync
just check        # fmt, lint, test
just test         # Rust tests
just bench        # Run benchmarks
```

### betterbase-inference

```bash
cd betterbase-inference
just check        # fmt, lint, test
just test         # Rust tests
```

### Examples

```bash
cd betterbase-examples/tasks && pnpm check   # lint + build
cd betterbase-examples/tasks && pnpm dev     # Dev server
```

## Architecture

### Rust Services

```
betterbase-accounts/                    # Auth service (OPAQUE + OAuth 2.0)
├── bins/{server,keygen,oauth-client}/  # Binary entry points
├── crates/
│   ├── api/                            # HTTP handlers (Axum router)
│   ├── app/                            # Application logic
│   ├── auth/                           # OPAQUE protocol, ES256 signing
│   ├── cap/                            # CAP (PoW CAPTCHA) integration
│   ├── core/                           # Shared types
│   ├── email/                          # Email sending
│   └── storage/                        # PostgreSQL (interface + impl)
└── web/                                # React frontend (Vite + Tailwind)

betterbase-sync/                        # Blob sync service (WebSocket RPC + CBOR)
├── bins/{server,migrate,federation-keygen}/
├── crates/
│   ├── api/                            # HTTP + WebSocket handlers
│   ├── app/                            # Application logic
│   ├── auth/                           # JWT middleware
│   ├── core/                           # Wire format types, RPC frame definitions
│   ├── realtime/                       # WebSocket, presence, events
│   └── storage/                        # PostgreSQL + file storage

betterbase-inference/                   # E2EE inference proxy
├── src/                                # Single-crate binary
```

### SDK (betterbase/)

Cargo workspace with 7 Rust crates compiled to WASM, plus a TypeScript layer (`js/`) published as `betterbase`:

| Crate | Purpose |
|-------|---------|
| `betterbase-crypto` | AES-256-GCM, AES-KW, HKDF, ECDSA P-256, DEK management, UCANs, edit chains |
| `betterbase-auth` | PKCE, JWE ECDH-ES+A256KW decrypt, JWK thumbprint, scoped key extraction |
| `betterbase-discovery` | Server metadata and WebFinger validation |
| `betterbase-sync-core` | BlobEnvelope CBOR, padding, transport encrypt/decrypt, epoch key cache |
| `betterbase-db` | SQLite WASM VFS, CRDT operations, collection management |
| `betterbase-wasm` | wasm-bindgen exports for crypto/auth/discovery/sync crates |
| `betterbase-db-wasm` | wasm-bindgen exports for DB engine |

TypeScript subpath exports: `/crypto`, `/auth`, `/auth/react`, `/discovery`, `/sync`, `/sync/react`, `/db`, `/db/react`, `/db/worker`

### Key Design: Encrypt-at-Boundary

Data is stored **plaintext** in `betterbase/db` (fully queryable). Encryption happens only when pushing to/pulling from the server. The server only sees encrypted blobs.

1. User writes to db normally -> db tracks changes via CRDTs
2. Push: collect dirty records -> wrap CRDT binary in BlobEnvelope -> encrypt -> send to server
3. Pull: receive from server -> decrypt -> unwrap BlobEnvelope -> CRDT merge with local state
4. WebSocket for real-time push notifications

### Auth Flow

- OPAQUE protocol for password auth (server never sees password)
- OAuth 2.0 + PKCE for public clients
- When `sync` scope requested: extended PKCE binds ephemeral key, server delivers 256-bit encryption key via JWE
- `betterbase/auth` OAuthClient handles the full flow: `startAuth()` -> redirect -> `handleCallback()` -> tokens + encryption key

### Sync Integration

- `betterbase/db` provides `SyncManager`, `SyncScheduler`, and React hooks
- `betterbase/sync` provides `SyncTransport` class implementing the `SyncTransport` interface
- Collections defined with typed schemas and auto-fields (id, createdAt, updatedAt)
- json-joy CRDTs for conflict-free merge (character-level string merge, per-key object merge)

## Infrastructure

- **Caddy** reverse proxy with tiered rate limiting (strict 60/min for login, moderate 120/min for auth, standard 300/min general, relaxed 1000/min for sync). Disabled in dev (direct port access). Health check on `:2019/health`.
- **CAP** proof-of-work CAPTCHA service (port 3000 internal). Dev mode auto-provisions CAP keys via `_ensure-cap-key`. Caddy serves CAP assets at `/cap/*`.
- `docker-compose.yml` = base production config
- `docker-compose.dev.yml` = dev overrides (must be explicitly passed with `-f`, not auto-loaded)
- Dev uses `just dev` which runs `docker compose -f docker-compose.yml -f docker-compose.dev.yml`
- Dev volumes prefixed with `dev_` so `just dev-down -v` can never delete prod data
- Dev sets `SMTP_DEV_MODE=true` (logs emails instead of sending) and exposes Web UI on separate port (5378)
- OAuth client setup automated: `just setup-examples` (or individual `just setup-launchpad`, `just setup-tasks`) -- runs automatically on first `just dev`

## Environment Variables

**betterbase-accounts:**
- `OPAQUE_SERVER_SETUP` - Required, hex-encoded OPAQUE ServerSetup blob
- `OAUTH_ISSUER` - Required, stable issuer URL for JWT/federation identity
- `DATABASE_URL` - Required, PostgreSQL connection string
- `CAP_KEY_ID` / `CAP_SECRET` - CAP proof-of-work credentials

**betterbase-sync:**
- `TRUSTED_ISSUERS` - Required, space-separated trusted issuer URLs (`issuer=jwks_url` for explicit JWKS endpoint)
- `AUDIENCES` - JWT audience validation
- `DATABASE_URL` - Required, PostgreSQL connection string
- `IDENTITY_HASH_KEY` - HMAC-SHA256 key for privacy-preserving invitation lookups
- `SPACE_SESSION_SECRET` - Session token HMAC key (optional but recommended)

**betterbase-inference:**
- `TINFOIL_API_KEY` - API key for Tinfoil backend (required)
- `JWKS_URL` - JWKS endpoint for JWT validation
- `ISSUER` / `AUDIENCES` - JWT validation

**Examples:**
- `VITE_OAUTH_CLIENT_ID` - Auto-configured by `just setup-examples`

## Testing

E2E tests (Playwright browser tests against isolated docker-compose stack):
```bash
just e2e              # Full cycle: clean -> setup -> run all tests
just e2e-test         # Run tests only (services must already be running via e2e-setup)
cd e2e && pnpm test   # Same as e2e-test
```

SDK tests run standalone:
```bash
cd betterbase && just check    # Full check: Rust tests + TS tests + browser tests
```

## Key Patterns

- **Rust services**: Axum router, Cargo workspace with `crates/` + `bins/` layout, storage interfaces with PostgreSQL impl
- **SDK**: Rust core crates (RustCrypto + zeroize) -> WASM via wasm-bindgen -> TypeScript browser layer
- **Frontend**: React 19 + TypeScript + Vite, pnpm, Tailwind CSS 4, path alias `@/` -> `src/`
- **Conflict resolution**: Automatic via json-joy CRDTs; only delete conflicts need a strategy (`DeleteConflictStrategy`)

### Immutable v1 Contracts

The following are frozen as of v1 and must not change without a versioned migration path:

- **API route paths**: All `/v1/` routes across betterbase-accounts, betterbase-sync (`/api/v1/`), and betterbase-inference (`/v1/`)
- **WebSocket RPC protocol**: `betterbase-rpc-v1` subprotocol, frame types, CBOR-seq for auxiliary HTTP endpoints
- **Encryption envelope format v4**: `[0x04][IV:12][ciphertext+tag]` (AES-256-GCM)
- **Patch log format v1**: `[0x01][length-prefixed entries...]` (empty = zero bytes)
- **Wire protocol version strings**: `betterbase:encrypt:v1`, `betterbase:epoch-salt:v1`, `betterbase:epoch:v1:`, `betterbase:epoch-root:v1`, `betterbase:membership:v1\0`, `betterbase:mailbox:v1\0`, `betterbase-mailbox-salt-v1`
- **Session token binary format**: Already versioned with leading byte
- **`X-Protocol-Version: 1`** response header on all services
