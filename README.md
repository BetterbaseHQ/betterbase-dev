# Betterbase

An open platform for building local-first apps with end-to-end encryption. Your data lives on your device, syncs across clients via CRDTs, and the server never sees plaintext — not your documents, not your passwords, not your prompts.

Less gives you a typed document database, encrypted sync, zero-knowledge auth, and private AI inference. This repo orchestrates all the pieces for development and deployment.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  TypeScript Client Libraries (betterbase, betterbase-db)   │
│  /sdk/auth, crypto, sync, inference, db             │
└──────┬────────────────────────────────┬───────────┬───────────┘
       │                                │           │
       │  OAuth + PKCE                  │ Sync      │ E2EE
       │  + key delivery                │ (CBOR-seq)│ inference
       ▼                                ▼           ▼
┌─────────────┐     ┌─────────────┐  ┌──────────────┐
│betterbase-accounts│────▶│  betterbase-sync  │  │betterbase-inference │
│   :5377     │     │   :5379     │  │   :5381      │
│ Auth/OAuth  │JWKS │  Sync API   │  │  E2EE Proxy  │
└──────┬──────┘     └──────┬──────┘  └──────┬───────┘
       │                   │                │
       ▼                   ▼                ▼
  accounts-db          sync-db         Tinfoil TEE
  (PostgreSQL)        (PostgreSQL)
```

Local data stored plaintext in `/sdk/db` (IndexedDB/SQLite), encrypted only at the boundary when syncing to betterbase-sync.

### Encrypt-at-Boundary Design

1. **Local storage** — `/sdk/db` stores data plaintext (fully queryable, indexable)
2. **Auth** — `/sdk/auth` obtains access token + 256-bit encryption key via OAuth 2.0 + PKCE with JWE key delivery
3. **Push** — `/sdk/sync` collects dirty records → wraps in BlobEnvelope → encrypts with AES-256-GCM → sends to betterbase-sync
4. **Pull** — betterbase-sync sends encrypted blobs → decrypt → unwrap → CRDT merge → persist locally
5. **Real-time** — WebSocket notifications trigger sync when remote changes arrive

The server (betterbase-sync) only sees encrypted blobs. The inference proxy (betterbase-inference) only sees encrypted prompts/completions when E2EE is enabled via EHBP.

## Quick Start

```bash
git clone git@github.com:BetterbaseHQ/betterbase-dev.git
cd betterbase-dev
just setup    # clones repos, generates keys
just dev      # starts all services with hot reload
```

## Repositories

This meta repo orchestrates multiple sub-repositories:

### Go Services (checked out as sub-repos)

- **[betterbase-accounts](betterbase-accounts/)** (port 5377) — OPAQUE password auth + OAuth 2.0 server with PKCE and JWE scoped key delivery
- **[betterbase-sync](betterbase-sync/)** (port 5379) — Encrypted blob synchronization service with JWT validation and WebSocket push notifications
- **[betterbase-inference](betterbase-inference/)** (port 5381) — Authenticated inference proxy with E2EE support, forwards requests to Tinfoil TEE

### TypeScript Packages (checked out as sub-repos)

- **[betterbase](betterbase/)** — Client libraries for auth, crypto, and sync
  - `/sdk/auth` — OAuth 2.0 + PKCE client with scoped encryption key delivery
  - `/sdk/crypto` — AES-256-GCM encryption via Web Crypto API
  - `/sdk/sync` — HTTP sync client with CBOR-seq protocol and real-time streaming
  - `/sdk/inference` — Authenticated E2EE inference client (wraps Tinfoil SDK)
- **[betterbase-db](betterbase-db/)** — Type-safe document store with migrations and sync
  - `/sdk/db` — Schema-guided document database with json-joy CRDT sync, automatic conflict-free merge, and IndexedDB/SQLite adapters

### Examples

- **[examples/todo](examples/todo/)** — React todo app using `/sdk/db` + `/sdk/sync` + `/sdk/auth`
- **[examples/notes](examples/notes/)** — React notes app with rich text editing and encrypted sync
- **[examples/oauth-demo](examples/oauth-demo/)** — OAuth 2.0 + PKCE flow demo

### Integration

- **[integration](integration/)** — Go integration tests (requires running services)

## Services

| Service | Dev URL | Description |
|---------|---------|-------------|
| betterbase-accounts API | http://localhost:5377 | Authentication and OAuth |
| betterbase-accounts Web | http://localhost:5378 | Web UI (Vite dev server) |
| betterbase-sync | http://localhost:5379 | Blob synchronization |
| todo app | http://localhost:5380 | Example todo application |
| oauth-demo | http://localhost:5381 | OAuth demo app |
| notes app | http://localhost:5382 | Example notes application |

*Note: betterbase-inference is not yet integrated into docker-compose. Run it independently with `cd betterbase-inference && just run-dev` (requires `TINFOIL_API_KEY`). When running standalone, it uses port 5381 (same as oauth-demo in dev), so stop dev services first or adjust the port.*

## Development (Recommended)

Full-stack development with hot reload, fully containerized:

```bash
# Start services (auto-runs setup on first run, configures OAuth clients)
just dev

# Or run in background
just dev-bg

# View logs
just dev-logs              # all services
just dev-logs accounts     # specific service

# Rebuild after Dockerfile or dependency changes
just dev-rebuild

# Stop
just dev-down
```

Edit any Go or React file and changes reload automatically.

### OAuth Setup

The example apps (todo, notes, oauth-demo) need OAuth clients registered in accounts. `just dev` handles this automatically, but you can also run manually:

```bash
just setup-examples    # Creates OAuth clients for all example apps
just setup-todo        # Creates OAuth client for todo app only
just setup-notes       # Creates OAuth client for notes app only
just setup-demo        # Creates OAuth client for oauth-demo only
```

Client IDs are saved to `.env` files in each app directory and loaded via Vite.

## Production

```bash
# Start production containers
just prod

# Rebuild and start
just prod-build

# These also work (backward compatible)
just up
just up-build
```

## Standalone Development

### Go Services

Each Go service can run independently (fully containerized):

```bash
cd betterbase-accounts && just dev    # API :5377, Web :5378
cd betterbase-sync && just dev        # API :5379
cd betterbase-inference && just run-dev   # API :5381 (requires TINFOIL_API_KEY)
```

### TypeScript Packages

```bash
# betterbase (all packages)
cd betterbase && pnpm check    # Format + build + typecheck + test
cd betterbase && pnpm build    # Build all packages
cd betterbase && pnpm test     # Test all packages

# betterbase-db
cd betterbase-db && pnpm check          # Format + build + typecheck + test
cd betterbase-db && pnpm test:watch     # Watch mode

# Single package
cd betterbase/packages/sync && pnpm test
```

### Examples

```bash
cd examples/todo && just check       # Lint + build
cd examples/todo && pnpm dev         # Dev server on :5380
```

## Integration Tests

```bash
# Start services first
just up
just wait

# Run tests
just test
```

## Database Access

```bash
# PostgreSQL shell for accounts
just db-accounts

# PostgreSQL shell for sync
just db-sync

# Container shell
just shell-accounts
just shell-sync
```

## Cross-Repo Dependencies

Examples reference TypeScript packages via `link:` protocol (not `file:` or `workspace:`):

```json
{
  "dependencies": {
    "/sdk/auth": "link:../../betterbase/packages/auth",
    "/sdk/sync": "link:../../betterbase/packages/sync",
    "/sdk/db": "link:../../betterbase-db"
  }
}
```

This creates symlinks without resolving the package's own dependencies — essential for cross-repo refs.

## Configuration

Core environment variables are automatically generated by `just setup`. To regenerate:

```bash
rm .env
just setup
```

| Variable | Description | Auto-generated? |
|----------|-------------|-----------------|
| `OPAQUE_SERVER_KEY` | Server private key for OPAQUE | Yes |
| `OPAQUE_PUBLIC_KEY` | Server public key for OPAQUE | Yes |
| `OAUTH_ISSUER` | Stable OAuth/JWT issuer URL for accounts and federation identity | Yes |
| `JWKS_URL` | JWKS endpoint for JWT validation (used by betterbase-sync, betterbase-inference) | Yes |
| `TINFOIL_API_KEY` | API key for Tinfoil backend (used by betterbase-inference) | No — add manually |

## Troubleshooting

### Services not starting
```bash
# Check status
just status

# View logs
just logs

# Rebuild from scratch
just clean
just up-build
```

### Health check failing
```bash
# Check individual endpoints
curl http://localhost:5377/health
curl http://localhost:5379/health
curl http://localhost:5381/health  # betterbase-inference (if running standalone)
```

### JWKS not available
The sync service depends on accounts being healthy first. Ensure accounts is running:
```bash
curl http://localhost:5377/.well-known/jwks.json
```

## Updating

```bash
just pull    # pulls all repos
```
