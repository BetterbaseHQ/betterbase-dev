# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Betterbase is the orchestration repo for the Betterbase ecosystem:

- **Go microservices** (checked out as sub-repos):
  - `betterbase-accounts` (auth, port 5377) — OPAQUE + OAuth 2.0 server
  - `betterbase-sync` (blob sync, port 5379) — encrypted sync with JWT validation
  - `betterbase-inference` (E2EE inference proxy, port 5381) — forwards to Tinfoil TEE
- **TypeScript client packages** (checked out as sub-repo): `betterbase/` containing `/sdk/auth`, `/sdk/crypto`, `/sdk/sync`, `/sdk/inference`
- **Document store** (checked out as sub-repo): `betterbase-db/` containing `/sdk/db`
- **Example apps**: `examples/launchpad` (portal), `examples/tasks` (offline-first todos with sync), `examples/notes` (rich text notes with CRDT merging), `examples/passwords` (encrypted password vault), built on `examples/shared` (@less-examples/shared)
- **Integration tests**: Go tests in `integration/`

betterbase-accounts and betterbase-sync use PostgreSQL. betterbase-sync validates JWTs issued by accounts via JWKS. betterbase-inference is not yet integrated into docker-compose (run standalone).

## Commands

### Platform-level (root)

```bash
just setup        # Clone repos, generate OPAQUE keys, create .env
just pull         # Pull latest changes for all repos

# Development (recommended)
just dev          # Start dev environment with hot reload (Docker Compose)
just dev-bg       # Same but detached
just dev-rebuild  # Rebuild containers after Dockerfile changes
just dev-down     # Stop dev services
just dev-logs     # View all logs (or pass service name: just dev-logs accounts)

# Production
just prod         # Start production
just prod-build   # Build and start production
just up           # Alias for prod
just up-build     # Build and start (auto-configures OAuth clients for examples)
just down         # Stop services

# Testing and health
just test         # Run integration tests (services must be running)
just check        # Format, lint, and test integration code
just check-all    # Run checks on all repos (accounts, sync, examples, integration)
just health       # Check service health
just wait         # Wait for services to become healthy

# E2E tests (Playwright browser tests — isolated docker-compose stack)
just e2e          # Full cycle: clean → setup → run tests
just e2e-setup    # Start e2e services + create OAuth client + write e2e/.env
just e2e-test     # Run e2e tests (services must be running via e2e-setup)
just e2e-up       # Start e2e services only
just e2e-down     # Stop e2e services
just e2e-clean    # Stop e2e services and remove volumes
just e2e-logs     # View e2e service logs

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
just git-diff     # Diff summary for all repos
just git-push     # Push all repos to origin
```

### TypeScript packages

**betterbase** (auth, crypto, sync, inference):
```bash
cd betterbase && pnpm check    # Format + build + typecheck + test all packages
cd betterbase && pnpm build    # Build all packages
cd betterbase && pnpm test     # Test all packages (vitest)

# Single package
cd betterbase/packages/sync && pnpm test          # Run tests for one package
cd betterbase/packages/sync && pnpm test:watch    # Watch mode
cd betterbase/packages/sync && pnpm check         # Typecheck + test one package
```

**betterbase-db** (document store):
```bash
cd betterbase-db && pnpm check          # Format + build + typecheck + test
cd betterbase-db && pnpm build          # Build
cd betterbase-db && pnpm test           # Test all (vitest)
cd betterbase-db && pnpm test:watch     # Watch mode
```

**Build tooling**: `betterbase` packages use `tsup`; `betterbase-db` uses `tsc` directly (preserves 1:1 file mapping for declaration maps). All use `vitest` (test), `tsc --noEmit` (typecheck), `prettier` (format). In `betterbase`, `pnpm check` runs `prettier --write . && pnpm build && pnpm -r check` — build must run first because `/sdk/sync` imports from compiled `dist/` of sibling packages.

### betterbase-accounts

```bash
just check        # fmt, lint, test, test-web
just test         # Go tests (accepts args: just test -race)
just test-web     # Vitest for React frontend
just dev          # Go server + Vite dev server (hot reload)
```

### betterbase-sync

```bash
just check        # fmt, lint, test
just test         # Go tests (accepts args: just test -race)
just dev          # Docker Compose dev environment with hot reload
just bench        # Run benchmarks
```

### betterbase-inference

```bash
just check        # fmt, lint, test
just test         # Go tests (accepts args: just test -race)
just run-dev      # Run with example config (requires TINFOIL_API_KEY)
```

### Examples

```bash
cd examples/tasks && pnpm check   # lint + build
cd examples/tasks && pnpm dev     # Dev server on :5381
```

## Architecture

### Go Services

```
betterbase-accounts/                    # Auth service (OPAQUE + OAuth 2.0)
├── cmd/{server,keygen,oauth-client}/
├── server/                       # HTTP handlers (Chi router)
├── storage/                      # PostgreSQL (interface + impl)
├── services/                     # Business logic (opaque.go, es256.go)
└── web/                          # React frontend (Vite + Tailwind)

betterbase-sync/                        # Blob sync service (WebSocket RPC + CBOR)
├── cmd/server/
├── server/                       # HTTP + WebSocket handlers, JWT middleware, file endpoints
├── storage/                      # PostgreSQL + file storage (filesystem/S3)
└── protocol/                     # Wire format types and RPC frame definitions

betterbase-inference/                   # E2EE inference proxy
├── cmd/server/                   # Entry point, flag parsing
├── auth/                         # JWT validation via JWKS
├── server/                       # HTTP handlers, auth middleware, rate limiting
├── backend/                      # Backend interface + Tinfoil implementation
└── protocol/                     # Shared type definitions
```

### TypeScript Packages (betterbase)

```
betterbase/                 # Separate repo, checked out in platform root
├── packages/
│   ├── auth/       /sdk/auth       - OAuth 2.0 + PKCE + JWE scoped key delivery
│   ├── crypto/     /sdk/crypto     - AES-256-GCM encryption via Web Crypto API
│   ├── sync/       /sdk/sync       - WebSocket sync client + transport (CBOR RPC protocol)
│   └── inference/  /sdk/inference  - Authenticated client for Tinfoil E2EE inference

betterbase-db/                       # Separate repo, checked out in platform root
└── /sdk/db             - Type-safe document store with sync support
```

**Dependency chain**: `/sdk/sync` → `/sdk/db` (peer); apps use `/sdk/db` + `/sdk/sync` + `/sdk/auth`; `/sdk/inference` wraps `tinfoil`

Examples reference packages via `link:` protocol deps (e.g., `"/sdk/sync": "link:../../betterbase/packages/sync"`).

### Key Design: Encrypt-at-Boundary

Data is stored **plaintext** in `/sdk/db` (fully queryable). Encryption happens only when pushing to/pulling from the server. The server only sees encrypted blobs.

1. User writes to db normally → db diffs the CRDT Model and appends a Patch
2. Push: collect dirty records → wrap CRDT binary in BlobEnvelope → encrypt → send to server
3. Pull: receive from server → decrypt → unwrap BlobEnvelope → filter by collection → CRDT merge (replay local patches onto remote Model)
4. WebSocket for real-time push notifications

### /sdk/db Integration

- `/sdk/db` provides `SyncManager`, `SyncScheduler`, `ReactiveAdapter`, and React hooks
- `/sdk/sync` provides `LessSyncTransport` implementing `SyncTransport` interface
- Collections defined with typed schemas and auto-fields (id, createdAt, updatedAt)
- json-joy JSON CRDTs for conflict-free merge (character-level string merge, per-key object merge)
- `IndexedDBAdapter` for browser, `SQLiteAdapter` for Node.js

### Auth Flow

- OPAQUE protocol for password auth (server never sees password)
- OAuth 2.0 + PKCE for public clients
- When `sync` scope requested: extended PKCE binds ephemeral key, server delivers 256-bit encryption key via JWE
- `/sdk/auth` OAuthClient handles the full flow: `startAuth()` → redirect → `handleCallback()` → tokens + encryption key

## Infrastructure

- **Caddy** reverse proxy with tiered rate limiting (strict 60/min for login, moderate 120/min for auth, standard 300/min general, relaxed 1000/min for sync). Disabled in dev (direct port access). Health check on `:2019/health`.
- **CAP** proof-of-work CAPTCHA service (port 3000 internal). Dev mode auto-provisions CAP keys via `_ensure-cap-key`. Caddy serves CAP assets at `/cap/*`.
- `docker-compose.yml` = base production config
- `docker-compose.dev.yml` = dev overrides (must be explicitly passed with `-f`, not auto-loaded)
- Dev uses `just dev` which runs `docker compose -f docker-compose.yml -f docker-compose.dev.yml`
- Dev volumes prefixed with `dev_` so `just dev-down -v` can never delete prod data
- Dev sets `SMTP_DEV_MODE=true` (logs emails instead of sending) and exposes Web UI on separate port (5378)
- OAuth client setup automated: `just setup-examples` (or individual `just setup-launchpad`, `just setup-tasks`) — runs automatically on first `just dev`

## Environment Variables

**betterbase-accounts:**
- `OPAQUE_SERVER_KEY` / `OPAQUE_PUBLIC_KEY` - Required, hex-encoded
- `OAUTH_ISSUER` - Required, stable issuer URL for JWT/federation identity
- `DATABASE_URL` - Required, PostgreSQL connection string
- `WEB_BASE_URL` - Web UI base URL

**betterbase-sync:**
- `TRUSTED_ISSUERS` - Required, space-separated trusted issuer URLs (JWKS derived by convention, or `issuer=jwks_url` for explicit JWKS endpoint)
- `AUDIENCES` - JWT audience validation
- `DATABASE_URL` - Required, PostgreSQL connection string
- `IDENTITY_HASH_KEY` - HMAC-SHA256 key for invitation rate limiting
- `SPACE_SESSION_SECRET` - Session token HMAC key (optional but recommended)

**betterbase-inference:**
- `TINFOIL_API_KEY` - API key for Tinfoil backend (required)
- `JWKS_URL` - JWKS endpoint for JWT validation
- `ISSUER` / `AUDIENCES` - JWT validation
- `TINFOIL_BASE_URL` - Tinfoil API base URL (defaults to `https://inference.tinfoil.sh`)

**Examples:**
- `VITE_OAUTH_CLIENT_ID` - Auto-configured by `just setup-examples`

## Testing

Integration tests require running services:
```bash
just up && just wait && just test
cd integration && go test -v -run TestSpecificName
```

E2E tests (Playwright browser tests against isolated docker-compose stack):
```bash
just e2e              # Full cycle: clean → setup → run all tests
just e2e-test         # Run tests only (services must already be running via e2e-setup)
cd e2e && pnpm test   # Same as e2e-test
```

TS package tests run standalone:
```bash
cd betterbase/packages/sync && pnpm test
```

## Key Patterns

- **Go**: Chi router, storage interfaces in `storage/storage.go`, defined error variables (e.g., `ErrAccountNotFound`)
- **TS packages**: ESM-only, tsup builds, vitest tests, `link:` protocol for cross-repo deps
- **Frontend**: React 19 + TypeScript + Vite, pnpm, Tailwind CSS 4, path alias `@/` → `src/`
- **Conflict resolution**: Automatic via json-joy CRDTs; only delete conflicts need a strategy (`DeleteConflictStrategy`)

### Immutable v1 Contracts

The following are frozen as of v1 and must not change without a versioned migration path:

- **API route paths**: All `/v1/` routes across betterbase-accounts, betterbase-sync (`/api/v1/`), and betterbase-inference (`/v1/`)
- **WebSocket RPC protocol**: `less-rpc-v1` subprotocol, frame types, CBOR-seq for auxiliary HTTP endpoints
- **Encryption envelope format v4**: `[0x04][IV:12][ciphertext+tag]` (AES-256-GCM)
- **Patch log format v1**: `[0x01][length-prefixed entries...]` (empty = zero bytes)
- **Wire protocol version strings**: `less:encrypt:v1`, `less:epoch-salt:v1`, `less:epoch:v1:`, `less:epoch-root:v1`, `less:membership:v1\0`, `less:mailbox:v1\0`, `betterbase-dev-mailbox-salt-v1`
- **Session token binary format**: Already versioned with leading byte
- **`X-Protocol-Version: 1`** response header on all services
