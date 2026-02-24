[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

# Betterbase

An open platform for building local-first applications with end-to-end encryption. Your users' data stays on their devices, syncs conflict-free via CRDTs, and the server never sees plaintext.

We believe your users' data should be private by default.

**Build things like:** [encrypted todos](betterbase-examples/tasks), [collaborative notes](betterbase-examples/notes), [password vaults](betterbase-examples/passwords), [photo sharing](betterbase-examples/photos), [real-time chat](betterbase-examples/chat) -- all offline-first, all end-to-end encrypted.

> Betterbase is in active development. APIs may change before 1.0.

## What It Looks Like

```tsx
import { collection, t, createDatabase } from "betterbase/db";
import { useQuery } from "betterbase/db/react";

const tasks = collection("tasks", { title: t.string(), done: t.boolean() });
const db = await createDatabase("my-app", [tasks], { worker });

function Tasks() {
  const result = useQuery(tasks, { where: { done: false } });
  return result?.data.map((t) => <div key={t.id}>{t.title}</div>);
}
```

Data is stored plaintext in the local database -- fully queryable and indexable. Encryption happens only when pushing to or pulling from the server.

## Quick Start

### Prerequisites

- [Git](https://git-scm.com/), [Rust](https://rustup.rs/), [Docker](https://www.docker.com/) (with Compose v2), [just](https://github.com/casey/just), [jq](https://jqlang.github.io/jq/), [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/)

> Tested on macOS and Linux. Windows users should use WSL2.

### Setup

```bash
git clone https://github.com/BetterbaseHQ/betterbase-dev.git
cd betterbase-dev

just setup    # Clone sub-repos, generate keys, create .env
just dev      # Start all services with hot reload
```

<details>
<summary>What <code>just setup</code> does</summary>

- Clones `betterbase-accounts`, `betterbase-sync`, `betterbase-inference`, `betterbase`, and `betterbase-examples`
- Generates OPAQUE server keys for password authentication
- Provisions CAP proof-of-work CAPTCHA credentials
- Creates database passwords and HMAC keys
- Writes a complete `.env` file

The dev environment auto-configures OAuth clients for all example apps on first run.
</details>

### Open Your Browser

Once `just dev` reports all services healthy:

- **Auth UI**: [http://localhost:5378](http://localhost:5378) -- register an account and explore the login flow
- **Launchpad**: [http://localhost:5380](http://localhost:5380) -- portal app (auth only)
- **Tasks**: [http://localhost:5381](http://localhost:5381) -- offline-first todos with sync
- **Notes**: [http://localhost:5382](http://localhost:5382) -- rich text notes with CRDT merging

All example apps start automatically with `just dev`. See the port table below for the full list.

### Verify

```bash
just health   # Check service health endpoints
```

| Service | Port | Description |
|---------|------|-------------|
| Accounts | 5377 | Auth server (OPAQUE + OAuth 2.0) |
| Accounts Web UI | 5378 | Login/registration UI (dev only) |
| Sync | 5379 | Encrypted blob sync (WebSocket + REST) |
| Launchpad | 5380 | Portal app (dev only) |
| Tasks | 5381 | Offline-first todos (dev only) |
| Notes | 5382 | Rich text notes (dev only) |
| Photos | 5383 | Photo sharing (dev only) |
| Board | 5384 | Collaborative board (dev only) |
| Chat | 5385 | Encrypted messaging (dev only) |
| Passwords | 5387 | Password vault (dev only) |

> `betterbase-inference` is not included in the default dev stack. It requires a [Tinfoil TEE](https://tinfoil.sh/) backend and is run standalone.

## Architecture

```
+-----------------------------------------------------------------+
|                        Your App (React)                         |
|  useQuery, useRecord, useSpaces, usePresence, useAuth           |
+-----------------------------------------------------------------+
|                       betterbase                                |
|  /db          Local-first document store (SQLite WASM + OPFS)  |
|  /sync        WebSocket sync, spaces, presence, file storage   |
|  /auth        OAuth 2.0 + PKCE + scoped encryption keys        |
|  /crypto      AES-256-GCM, epoch keys, UCANs (Rust/WASM)      |
|  /discovery   Server metadata + WebFinger resolution            |
+------------------------+----------------------------------------+
|  betterbase-accounts   |  betterbase-sync                      |
|  OPAQUE auth server    |  Encrypted blob sync (WebSocket+CBOR) |
|  OAuth 2.0 + JWE keys  |  File storage, spaces, invitations    |
|  Rust (Axum) + React   |  Rust (Axum) + PostgreSQL             |
+------------------------+----------------------------------------+
|  Caddy (reverse proxy + rate limiting)  |  CAP (PoW CAPTCHA)   |
|  PostgreSQL (accounts)  |  PostgreSQL (sync)                   |
+-----------------------------------------------------------------+
```

### Auth

User enters password (never leaves device) → [OPAQUE](https://www.ietf.org/archive/id/draft-irtf-cfrg-opaque-17.html) authenticates without the server seeing it → OAuth 2.0 + PKCE issues tokens → when `sync` scope is requested, extended PKCE delivers a 256-bit encryption key via JWE → key stored as a non-extractable `CryptoKey` in IndexedDB.

### Sync

App writes plaintext to the local store (fully queryable). On push: dirty records are wrapped in BlobEnvelopes, encrypted with AES-256-GCM, and sent to the server. On pull: encrypted blobs are decrypted, unwrapped, and CRDT-merged with local state. WebSocket provides real-time push notifications. Multi-device sync is automatic and conflict-free via json-joy CRDTs.

### Spaces

**Personal space** for single-user encrypted storage. **Shared spaces** for multi-user collaboration with UCAN-based authorization. Invitations are end-to-end encrypted via mailbox IDs. Membership is tracked in an append-only, signed, tamper-evident log. Epoch keys provide forward secrecy via periodic rotation.

## Repository Map

This is an orchestration repo. Each component lives in its own Git repository, cloned as a subdirectory:

```
betterbase-dev/                        # You are here
├── betterbase/                        # SDK: Rust/WASM crypto + TypeScript client
│   ├── crates/                        #   Rust crates (crypto, auth, discovery, sync-core, db)
│   └── js/                            #   betterbase (auth, crypto, discovery, sync, db)
├── betterbase-accounts/               # Rust (Axum): OPAQUE auth + OAuth 2.0 server
├── betterbase-sync/                   # Rust (Axum): encrypted blob sync + WebSocket
├── betterbase-inference/              # Rust (Axum): E2EE inference proxy (Tinfoil TEE)
├── betterbase-examples/               # Example apps
│   ├── launchpad/                     #   Portal (auth-only, no sync)
│   ├── tasks/                         #   Offline-first todos with sync
│   ├── notes/                         #   Rich text notes with CRDT merging
│   ├── passwords/                     #   Encrypted password vault
│   ├── photos/                        #   Photo sharing with encrypted file storage
│   ├── board/                         #   Collaborative board
│   ├── chat/                          #   Encrypted messaging
│   └── shared/                        #   @betterbase/examples-shared
├── e2e/                               # Playwright browser tests (isolated stack)
├── docker-compose.yml                 # Production services
├── docker-compose.dev.yml             # Dev overrides (hot reload, debug ports)
├── docker-compose.e2e.yml             # E2E test stack (isolated ports)
└── caddy/                             # Reverse proxy config + rate limiting
```

## Development

### Dev vs Production

| | Dev (`just dev`) | Production (`just up`) |
|---|---|---|
| Hot reload | Yes (Rust + Vite) | No |
| Caddy proxy | Disabled (direct port access) | Enabled (rate limiting) |
| Example apps | All started automatically | Not started |
| SMTP | Logged to console | Real email delivery |
| Volumes | Prefixed with `dev_` | Production volumes |

### Commands

```bash
# Dev
just dev              # Start dev environment (hot reload, foreground)
just dev-bg           # Same, but detached
just dev-down         # Stop dev services and remove volumes
just dev-logs         # Tail all logs (or: just dev-logs accounts)
just dev-rebuild      # Rebuild containers after Dockerfile changes
just health           # Check service health

# Testing
just e2e              # E2E browser tests: clean, setup, run (isolated stack)
just e2e-test         # Run tests only (after e2e-setup)
just check-all        # Run checks across all repos

# Multi-repo git
just status           # Git status for all repos
just pull             # Pull latest for all repos
just git-diff         # Diff summary across repos
just git-push         # Push all repos

# Production
just up               # Start production services
just up-build         # Build and start production
just down             # Stop services

# Database access
just db-accounts      # PostgreSQL shell for accounts database
just db-sync          # PostgreSQL shell for sync database
just shell-accounts   # Shell into accounts container
just shell-sync       # Shell into sync container
```

## Sub-Repo Commands

Each sub-repo has its own `justfile` or `package.json`. See their individual READMEs for full details.

| Repo | Check | Dev / Run | Other |
|------|-------|-----------|-------|
| `betterbase/` | `just check` | `just check-js` | `just test` (Rust only) |
| `betterbase-accounts/` | `just check` | `just dev` | |
| `betterbase-sync/` | `just check` | `just dev` | `just bench` |
| `betterbase-inference/` | `just check` | | |
| `betterbase-examples/tasks/` | `pnpm check` | `pnpm dev` | |

## Environment Variables

All configuration is in `.env` (generated by `just setup`). Key variables:

| Variable | Service | Description |
|----------|---------|-------------|
| `OPAQUE_SERVER_SETUP` | accounts | OPAQUE server key material (hex). Changing invalidates all passwords. |
| `OAUTH_ISSUER` | accounts | Stable issuer URL for JWT identity namespace |
| `CAP_KEY_ID` / `CAP_SECRET` | accounts | Proof-of-work CAPTCHA credentials |
| `IDENTITY_HASH_KEY` | sync | HMAC key for privacy-preserving invitation lookups |
| `SPACE_SESSION_SECRET` | sync | HMAC key for space session tokens |

Database credentials (`ACCOUNTS_DB_*`, `SYNC_DB_*`) are also in `.env`.

## Infrastructure

**Caddy** reverse proxy with tiered rate limiting (60/min login, 120/min auth, 300/min general, 1000/min sync); disabled in dev mode. **CAP** proof-of-work CAPTCHA. **PostgreSQL** for accounts and sync (separate databases). Dev volumes prefixed with `dev_` so `just dev-down -v` never deletes production data.

## Troubleshooting

**Docker not running** -- `just dev` requires Docker Desktop (or Docker Engine) to be running. Start it and try again.

**Port already in use** -- Another process is using a required port. Check with `lsof -i :5377` (or whichever port) and stop the conflicting process.

**OPAQUE keygen fails** -- The setup compiles a Rust binary. Ensure you have a working Rust toolchain (`rustup update`). If compilation fails, check the error output for missing system dependencies.

**Sub-repo clone fails** -- If `just setup` fails cloning repositories, ensure you have internet access and can reach github.com. The setup uses HTTPS URLs which work without SSH key configuration.

**CAP provisioning fails** -- CAP runs in Docker during setup. If it fails, check Docker logs with `docker compose logs cap` and ensure port 3000 is not in use.

**Stale state after switching branches** -- Run `just dev-down` to clear dev volumes, then `just dev` to start fresh.

**Full reset** -- `just nuke` removes all containers, volumes, and locally-built images. Then re-run `just setup && just dev`.

## Contributing

We welcome contributions. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Found a bug or have a feature request? [Open an issue](https://github.com/BetterbaseHQ/betterbase-dev/issues).

## License

[Apache-2.0](LICENSE)
