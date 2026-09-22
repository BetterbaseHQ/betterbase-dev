# AGENTS.md

Guidance for AI coding agents working in this repository.

## Overview

Betterbase is the orchestration repo for the Betterbase ecosystem — an open platform for building local-first applications with end-to-end encryption. Data lives on device, syncs via CRDTs, and the server never sees plaintext.

Each component is a separate git repo checked out as a subdirectory here, with its own `AGENTS.md`, CI, and `justfile`:

| Directory | What it is |
|---|---|
| `betterbase/` | Rust/WASM SDK (Cargo workspace + TypeScript layer in `js/`, published as `betterbase`) |
| `betterbase-accounts/` | Auth service — Axum, OPAQUE + OAuth 2.0, React web UI (port 5377) |
| `betterbase-sync/` | Blob sync service — Axum, WebSocket RPC + CBOR, encrypted blobs (port 5379) |
| `betterbase-inference/` | E2EE inference proxy — Axum, forwards to Tinfoil TEE |
| `betterbase-examples/` | Example apps: launchpad, tasks, notes, passwords, photos, board, chat, shared |
| `json-joy-rs/` | Rust port of json-joy CRDTs (path dependency of `betterbase/crates/betterbase-db`) |
| `e2e/` | Playwright end-to-end tests against an isolated docker-compose stack |

betterbase-accounts and betterbase-sync use PostgreSQL. betterbase-sync validates JWTs issued by accounts via JWKS.

## Toolchain

Run `mise install` after cloning — `.mise.toml` pins node, pnpm, just, and jq.

Deliberately not managed by mise:
- **rust / wasm-pack**: rustup is canonical (`rustup target add wasm32-unknown-unknown`, `cargo install wasm-pack`)
- **docker**: OrbStack/Docker Desktop
- **llvm** (macOS only): `brew install llvm` — required for the SDK's wasm build (see `betterbase/js/scripts/build-wasm.sh`)

## Commands (platform level)

```bash
just setup        # Clone repos, generate OPAQUE keys, provision CAP, create .env
just dev          # Start dev environment with hot reload (Docker Compose)
just dev-bg       # Same but detached
just dev-rebuild  # Rebuild containers after Dockerfile changes
just dev-down     # Stop dev services and remove volumes
just dev-logs     # View all logs (or pass service name: just dev-logs accounts)

just prod         # Start production
just prod-build   # Build and start production
just down         # Stop services

just check-all      # Run checks: SDK, accounts, sync, inference, json-joy-rs, all examples
just check-platform # check-all + the full platform E2E cycle (requires Docker)

just health       # Check service health
just wait         # Wait for services to become healthy
just db-accounts  # PostgreSQL shell for accounts
just db-sync      # PostgreSQL shell for sync
just ps           # Docker compose status
just restart      # Restart all dev services
just nuke         # Full reset (removes containers, volumes, images)

just status       # Multi-repo git status
just pull         # Multi-repo git pull
just git-push     # Push all repos to origin
```

Per-repo development checks live in each repo (`cd betterbase-accounts && just check`, etc.) and are documented in each repo's `AGENTS.md`.

## E2E Testing

```bash
just e2e-setup    # Start e2e services + exchange federation keys + create OAuth clients
just e2e-test     # Run Playwright tests (services must be running via e2e-setup)
just e2e-faults   # Fault-injection phase: real server restarts (single worker, gated spec)
just e2e          # Full cycle: clean → setup → test → faults
just e2e-down     # Stop e2e services
just e2e-clean    # Stop e2e services + remove volumes (never touches dev/prod)
```

The e2e stack is a **standalone compose project** (`e2e/compose.yaml`, project name `betterbase-e2e`) — separate containers, network, and volumes from dev/prod. It uses ports 25377 (accounts), 25379 (sync), 25387 (accounts-b), 25389 (sync-b), and the vite test harness on 25390. It is safe to run `just e2e` while dev is up; neither stack can affect the other's containers or data.

All e2e runtime config lives in `e2e/.env.docker` (gitignored): `e2e-up` writes the Server B OPAQUE key, `e2e-setup` writes the federation peer trust pins (Server A ↔ Server B). E2e recipes never mutate the shared root `.env`.

The fault-injection spec (`e2e/tests/fault-injection.spec.ts`) restarts real containers (sync/accounts) to pin crash-safety (D-005 share persistence, offline-key adoption, stateless auth across restarts). It is gated behind `E2E_FAULT_INJECTION=1` and runs single-worker via `just e2e-faults` because restarts would disturb parallel tests; `just e2e` runs it automatically after the main phase.

Sync signing keys are provisioned on first boot and stable across restarts — the entrypoint never rotates the primary key, so pinned trust survives container restarts.

## Architecture

### Services layout

```
betterbase-accounts/                    # Auth service (OPAQUE + OAuth 2.0)
├── bins/{server,keygen,oauth-client}/  # Binary entry points
├── crates/                             # api, app, auth, cap, core, email, storage
└── web/                                # React frontend (Vite + Tailwind)

betterbase-sync/                        # Blob sync service (WebSocket RPC + CBOR)
├── bins/{server,migrate,federation-keygen}/
└── crates/                             # api, app, auth, core, realtime, storage

betterbase-inference/                   # E2EE inference proxy (single crate)
└── src/
```

### Key design: encrypt-at-boundary

Data is stored **plaintext** in the client db (fully queryable). Encryption happens only when pushing to/pulling from the server; the server only sees encrypted blobs.

1. User writes to db normally -> db tracks changes via CRDTs
2. Push: collect dirty records -> wrap CRDT binary in BlobEnvelope -> encrypt -> send to server
3. Pull: receive from server -> decrypt -> unwrap BlobEnvelope -> CRDT merge with local state
4. WebSocket for real-time push notifications

### Auth flow

- OPAQUE protocol for password auth (server never sees password)
- OAuth 2.0 + PKCE for public clients
- When `sync` scope requested: extended PKCE binds an ephemeral key; the server delivers the 256-bit encryption key via JWE
- `betterbase/auth` OAuthClient handles the full flow: `startAuth()` -> redirect -> `handleCallback()` -> tokens + encryption key

### Sync integration

- `betterbase/db` provides `SyncManager`, `SyncScheduler`, and React hooks
- `betterbase/sync` provides the `SyncTransport` class
- Collections defined with typed schemas and auto-fields (id, createdAt, updatedAt)
- json-joy CRDTs for conflict-free merge (character-level string merge, per-key object merge)

## Infrastructure

- **Caddy** reverse proxy with tiered rate limiting (60/min login, 120/min auth/WS-upgrades, 300/min general, 600/min sync default, 1000/min accounts web default). Disabled in dev (direct port access). Health check on `:2019/health`. Client sync is exclusively WebSocket RPC (`/api/v1/ws`) — HTTP tiers rate-limit connection upgrades; per-connection abuse is bounded server-side (mailbox connection caps, federation peer quotas).
- **CAP** proof-of-work CAPTCHA service (port 3000 internal). Dev mode auto-provisions CAP keys. Caddy serves CAP assets at `/cap/*`.
- `docker-compose.yml` = base production config; `docker-compose.dev.yml` = dev overrides (passed explicitly with `-f`, not auto-loaded)
- Dev volumes prefixed with `dev_` so `just dev-down -v` can never delete prod data
- Dev sets `SMTP_DEV_MODE=true` (logs emails instead of sending) and exposes the Web UI on a separate port (5378)
- OAuth client setup automated: `just setup-examples` (runs automatically on first `just dev`)

## Production deployment

- **TLS**: set `ACCOUNTS_SITE`/`SYNC_SITE` (hostnames) + `ACME_EMAIL` in `.env` → Caddy switches to automatic HTTPS on 443 with HTTP→HTTPS redirect on 80. Unset = plain HTTP on 5377/5379 (local mode). Ports 80/443/5377/5379 are published; each mode leaves the other's ports dark. Certificates persist in the `caddy_data` volume. `OAUTH_ISSUER` must match the accounts hostname in TLS mode.
- **Email**: production defaults to real SMTP and accounts **fails startup** without `SMTP_HOST` (set it, or `SMTP_DEV_MODE=true` for local prod smoke runs).
- **Advertised endpoints**: `SYNC_ENDPOINT` (federation discovery) defaults to `http://localhost:5379/api/v1` — set it to the public `https://sync.<domain>/api/v1` for named deployments.
- **Blob files**: production enables filesystem storage on the `sync_files` volume by default (`FILE_STORAGE=fs`); set `FILE_STORAGE=none` to disable.
- **Backup/restore**: `just backup` → `backups/<timestamp>/` (both DBs pg_dump'd, files + certs archived). `just restore <dir>` (stops app services, restores, restarts).
- **Releases**: `release.toml` pins every component at an exact commit. `just release-pin` stamps current HEADs; `just check-release` is the release gate. The betterbase-dev commit containing `release.toml` is the release commit. Examples CI pins its sibling checkouts (betterbase, json-joy-rs) to the same revisions — bump together via `just release-pin` and note that CI needs the pinned commits pushed.

## Environment Variables

**betterbase-accounts:** `OPAQUE_SERVER_SETUP` (required, hex blob), `OAUTH_ISSUER` (required), `DATABASE_URL` (required), `CAP_KEY_ID`/`CAP_SECRET`

**betterbase-sync:** `TRUSTED_ISSUERS` (required, space-separated issuer URLs or `issuer=jwks_url` pairs), `AUDIENCES` (JWT audience validation), `DATABASE_URL` (required), `IDENTITY_HASH_KEY` (HMAC-SHA256 key for privacy-preserving lookups)

**betterbase-inference:** `TINFOIL_API_KEY` (required), `JWKS_URL`, `ISSUER`/`AUDIENCES`

**Examples:** `VITE_OAUTH_CLIENT_ID` — auto-configured by `just setup-examples`

See each repo's `AGENTS.md` for the full env var reference.

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
