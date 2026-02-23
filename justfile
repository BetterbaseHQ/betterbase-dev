# Compose file combos — prod uses base only, dev layers overrides on top.
# Dev volumes are prefixed with dev_ so dev-down -v can never delete prod data.
prod_compose := "docker compose -f docker-compose.yml"
dev_compose  := "docker compose -f docker-compose.yml -f docker-compose.dev.yml"
e2e_compose  := "docker compose -f docker-compose.yml -f docker-compose.e2e.yml"

# List available recipes
default:
    @just --list

# Pull latest changes for all repos
pull:
    git pull
    cd ./betterbase-accounts && git pull
    cd ./betterbase-inference && git pull
    cd ./betterbase && git pull
    cd ./betterbase-sync && git pull
    cd ./betterbase-examples && git pull

# Set up everything for first run (clone repos, generate keys, create .env)
setup:
    ./scripts/setup.sh

# =============================================================================
# Production
# =============================================================================

# Start production
prod:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
        echo "No .env found, running setup..."
        ./scripts/setup.sh
    fi
    {{prod_compose}} up -d

# Build and start production
prod-build:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
        echo "No .env found, running setup..."
        ./scripts/setup.sh
    fi
    {{prod_compose}} up -d --build

# Stop production services
prod-down:
    {{prod_compose}} down

# Start services (alias for prod)
up:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
        echo "No .env found, running setup..."
        ./scripts/setup.sh
    fi
    {{prod_compose}} up -d

# Start with rebuild (auto-configures example app OAuth clients)
up-build:
    #!/usr/bin/env bash
    set -e

    NEED_SETUP=false

    # Check if launchpad needs OAuth setup
    if [ ! -f "./betterbase-examples/launchpad/.env" ] || ! grep -q "^VITE_OAUTH_CLIENT_ID=" "./betterbase-examples/launchpad/.env"; then
        NEED_SETUP=true
    fi

    # Check if tasks needs OAuth setup
    if [ ! -f "./betterbase-examples/tasks/.env" ] || ! grep -q "^VITE_OAUTH_CLIENT_ID=" "./betterbase-examples/tasks/.env"; then
        NEED_SETUP=true
    fi

    # Check if photos needs OAuth setup
    if [ ! -f "./betterbase-examples/photos/.env" ] || ! grep -q "^VITE_OAUTH_CLIENT_ID=" "./betterbase-examples/photos/.env"; then
        NEED_SETUP=true
    fi

    if [ "$NEED_SETUP" = true ]; then
        echo "Example apps need OAuth client setup..."
        {{dev_compose}} up -d --build accounts
        echo "Waiting for accounts to be healthy..."
        until curl -sf http://localhost:5377/health > /dev/null 2>&1; do sleep 1; done
        just setup-examples
    fi

    {{dev_compose}} up -d --build

# Stop all services (dev or prod, whichever is running)
down:
    {{dev_compose}} down 2>/dev/null; {{prod_compose}} down 2>/dev/null; true

# View logs
logs:
    {{dev_compose}} logs -f

# Run all checks on integration tests (format, lint, test)
check: fmt lint test

# Run checks on all repos (accounts, sync, and integration)
check-all:
    @echo "=== Checking betterbase-accounts ==="
    cd ./betterbase-accounts && just check
    @echo ""
    @echo "=== Checking betterbase-sync ==="
    cd ./betterbase-sync && just check
    @echo ""
    @echo "=== Checking shared package ==="
    cd ./betterbase-examples/shared && pnpm check
    @echo ""
    @echo "=== Checking launchpad app ==="
    cd ./betterbase-examples/launchpad && pnpm check
    @echo ""
    @echo "=== Checking tasks app ==="
    cd ./betterbase-examples/tasks && pnpm check
    @echo ""
    @echo "=== Checking notes app ==="
    cd ./betterbase-examples/notes && pnpm check
    @echo ""
    @echo "=== Checking photos app ==="
    cd ./betterbase-examples/photos && pnpm check
    @echo ""
    @echo "=== Checking board app ==="
    cd ./betterbase-examples/board && pnpm check
    @echo ""
    @echo "=== Checking passwords app ==="
    cd ./betterbase-examples/passwords && pnpm check
    @echo ""
    @echo "=== Checking chat app ==="
    cd ./betterbase-examples/chat && pnpm check
    @echo ""
    @echo "=== Checking integration tests ==="
    just check

# Format integration test code
fmt:
    cd integration && gofmt -w .
    @command -v goimports >/dev/null 2>&1 && (cd integration && goimports -w .) || true

# Lint integration test code
lint:
    cd integration && go vet ./...

# Run integration tests
test:
    cd integration && go test -v ./...

# Clean up dev environment including volumes
clean:
    {{dev_compose}} down -v

# =============================================================================
# Development (fully containerized with hot reload)
# =============================================================================

# Start dev environment with hot reload (auto-configures CAP + OAuth)
dev:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
        echo "No .env found, running setup..."
        ./scripts/setup.sh
    fi
    just _ensure-dev-config
    {{dev_compose}} up --build

# Start dev environment in background
dev-bg:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
        echo "No .env found, running setup..."
        ./scripts/setup.sh
    fi
    just _ensure-dev-config
    {{dev_compose}} up -d --build

# Ensure CAP site key and OAuth clients are configured for dev volumes
[private]
_ensure-dev-config:
    #!/usr/bin/env bash
    set -e

    just _ensure-cap-key

    echo "Verifying OAuth clients..."
    # Start accounts temporarily if not running
    ACCOUNTS_WAS_RUNNING=false
    if curl -sf http://localhost:5377/health > /dev/null 2>&1; then
        ACCOUNTS_WAS_RUNNING=true
    else
        {{dev_compose}} up -d --build accounts
        echo "Waiting for accounts to be healthy..."
        TRIES=0
        MAX_TRIES=60
        until curl -sf http://localhost:5377/health > /dev/null 2>&1; do
            TRIES=$((TRIES + 1))
            if [ "$TRIES" -ge "$MAX_TRIES" ]; then
                echo "Error: accounts service did not become healthy after ${MAX_TRIES}s"
                echo "Container logs:"
                {{dev_compose}} logs --tail 30 accounts 2>&1 | grep -v "variable is not set"
                exit 1
            fi
            # Check if container exited
            if ! {{dev_compose}} ps --status running accounts 2>/dev/null | grep -q accounts; then
                echo "Error: accounts container exited unexpectedly"
                echo "Container logs:"
                {{dev_compose}} logs --tail 30 accounts 2>&1 | grep -v "variable is not set"
                exit 1
            fi
            sleep 1
        done
    fi

    # Setup verifies IDs exist in DB, creates if missing
    just setup-examples

    # Stop accounts if we started it (will be restarted with everything)
    if [ "$ACCOUNTS_WAS_RUNNING" = false ]; then
        {{dev_compose}} stop accounts
    fi

# Ensure CAP site key in .env matches the dev_cap_data volume
[private]
_ensure-cap-key:
    #!/usr/bin/env bash
    set -e
    if [ -f .env ]; then set -a; source .env; set +a; fi

    CAP_KEY_ID="${CAP_KEY_ID:-}"
    CAP_ADMIN_KEY="${CAP_ADMIN_KEY:-}"

    if [ -z "$CAP_ADMIN_KEY" ]; then
        echo "Error: CAP_ADMIN_KEY not set in .env"
        exit 1
    fi

    # Start CAP if not running
    CAP_WAS_RUNNING=false
    if {{dev_compose}} ps --status running cap 2>/dev/null | grep -q cap; then
        CAP_WAS_RUNNING=true
    else
        {{dev_compose}} up -d cap
    fi

    # Wait for CAP to be healthy (uses Docker healthcheck)
    echo "Waiting for CAP to be healthy..."
    TRIES=0
    MAX_TRIES=60
    until {{dev_compose}} ps cap --format json 2>/dev/null | python3 -c "import sys,json; exit(0 if json.load(sys.stdin).get('Health')=='healthy' else 1)" 2>/dev/null; do
        TRIES=$((TRIES + 1))
        if [ "$TRIES" -ge "$MAX_TRIES" ]; then
            echo "Error: CAP service did not become healthy after ${MAX_TRIES}s"
            {{dev_compose}} logs --tail 10 cap 2>&1
            exit 1
        fi
        sleep 1
    done

    # Helper: curl against CAP via sidecar container on the Docker network
    NETWORK=$(docker network ls | grep betterbase | awk '{print $2}' | head -1)
    cap_curl() { docker run --rm --network "$NETWORK" curlimages/curl:latest -sf "$@"; }

    # Test if the existing site key works
    if [ -n "$CAP_KEY_ID" ]; then
        CHALLENGE=$(cap_curl -X POST "http://cap:3000/${CAP_KEY_ID}/challenge" 2>/dev/null || true)
        if echo "$CHALLENGE" | grep -q '"token"'; then
            echo "CAP site key $CAP_KEY_ID verified"
            if [ "$CAP_WAS_RUNNING" = false ]; then
                {{dev_compose}} stop cap
            fi
            exit 0
        fi
        echo "CAP site key $CAP_KEY_ID not found in dev volume, recreating..."
    fi

    # Login to CAP admin API
    echo "Authenticating with CAP..."
    LOGIN=$(cap_curl -X POST http://cap:3000/auth/login \
        -H "Content-Type: application/json" \
        -d "{\"admin_key\":\"$CAP_ADMIN_KEY\"}")

    SESSION=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['session_token'])")
    HASH=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['hashed_token'])")

    AUTH_PAYLOAD="{\"token\":\"$SESSION\",\"hash\":\"$HASH\"}"
    AUTH_TOKEN=$(echo -n "$AUTH_PAYLOAD" | base64 | tr -d '\n')

    # Create site key
    echo "Creating CAP site key..."
    KEY_RESPONSE=$(cap_curl -X POST http://cap:3000/server/keys \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"betterbase-accounts"}')

    NEW_KEY_ID=$(echo "$KEY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['siteKey'])")
    NEW_SECRET=$(echo "$KEY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['secretKey'])")

    if [ -z "$NEW_KEY_ID" ] || [ "$NEW_KEY_ID" = "None" ]; then
        echo "Error: Failed to create CAP site key"
        echo "$KEY_RESPONSE"
        exit 1
    fi

    # Update .env with new key
    if [ "$(uname)" = "Darwin" ]; then
        sed -i '' "s/^CAP_KEY_ID=.*/CAP_KEY_ID=$NEW_KEY_ID/" .env
        sed -i '' "s/^CAP_SECRET=.*/CAP_SECRET=$NEW_SECRET/" .env
    else
        sed -i "s/^CAP_KEY_ID=.*/CAP_KEY_ID=$NEW_KEY_ID/" .env
        sed -i "s/^CAP_SECRET=.*/CAP_SECRET=$NEW_SECRET/" .env
    fi

    echo "CAP site key created: $NEW_KEY_ID"
    echo "Updated .env with new CAP credentials"

    if [ "$CAP_WAS_RUNNING" = false ]; then
        {{dev_compose}} stop cap
    fi

# View dev logs (all services or specific service)
dev-logs *args:
    {{dev_compose}} logs -f {{args}}

# Rebuild dev containers (after Dockerfile.dev or dependency changes)
dev-rebuild:
    {{dev_compose}} build && {{dev_compose}} up

# Stop dev environment and remove volumes (DB data is ephemeral in dev)
dev-down:
    {{dev_compose}} down -v

# =============================================================================
# Git Operations
# =============================================================================

# Show git status for all repos (alias: git-status)
status:
    @echo "=== betterbase-dev ==="
    @git status -s || true
    @echo ""
    @echo "=== betterbase-accounts ==="
    @cd ./betterbase-accounts && git status -s || true
    @echo ""
    @echo "=== betterbase-inference ==="
    @cd ./betterbase-inference && git status -s || true
    @echo ""
    @echo "=== betterbase ==="
    @cd ./betterbase && git status -s || true
    @echo ""
    @echo "=== betterbase-sync ==="
    @cd ./betterbase-sync && git status -s || true
    @echo ""
    @echo "=== betterbase-examples ==="
    @cd ./betterbase-examples && git status -s || true

# Show git diff for all repos
git-diff:
    @echo "=== betterbase-dev ==="
    @git diff --stat
    @echo ""
    @echo "=== betterbase-accounts ==="
    @cd ./betterbase-accounts && git diff --stat
    @echo ""
    @echo "=== betterbase-inference ==="
    @cd ./betterbase-inference && git diff --stat
    @echo ""
    @echo "=== betterbase ==="
    @cd ./betterbase && git diff --stat
    @echo ""
    @echo "=== betterbase-sync ==="
    @cd ./betterbase-sync && git diff --stat
    @echo ""
    @echo "=== betterbase-examples ==="
    @cd ./betterbase-examples && git diff --stat

# Show current branch for all repos
git-branch:
    @echo "betterbase: $(git branch --show-current)"
    @echo "betterbase-accounts: $(cd ./betterbase-accounts && git branch --show-current)"
    @echo "betterbase-inference: $(cd ./betterbase-inference && git branch --show-current)"
    @echo "betterbase: $(cd ./betterbase && git branch --show-current)"
    @echo "betterbase-sync: $(cd ./betterbase-sync && git branch --show-current)"
    @echo "betterbase-examples: $(cd ./betterbase-examples && git branch --show-current)"

# Fetch latest from origin for all repos (without merging)
git-fetch:
    git fetch
    cd ./betterbase-accounts && git fetch
    cd ./betterbase-inference && git fetch
    cd ./betterbase && git fetch
    cd ./betterbase-sync && git fetch
    cd ./betterbase-examples && git fetch

# Push all repos to origin
git-push:
    @echo "=== betterbase-dev ==="
    git push
    @echo ""
    @echo "=== betterbase-accounts ==="
    cd ./betterbase-accounts && git push
    @echo ""
    @echo "=== betterbase-inference ==="
    cd ./betterbase-inference && git push
    @echo ""
    @echo "=== betterbase ==="
    cd ./betterbase && git push
    @echo ""
    @echo "=== betterbase-sync ==="
    cd ./betterbase-sync && git push
    @echo ""
    @echo "=== betterbase-examples ==="
    cd ./betterbase-examples && git push

# =============================================================================
# Docker Operations
# =============================================================================

# Build dev images without starting
build:
    {{dev_compose}} build

# Restart all dev services
restart:
    {{dev_compose}} restart

# Restart a specific dev service (accounts, sync, or todo)
restart-service service:
    {{dev_compose}} restart {{service}}

# Show docker-compose status
ps:
    {{dev_compose}} ps

# View logs for accounts service
logs-accounts:
    {{dev_compose}} logs -f accounts

# View logs for sync service
logs-sync:
    {{dev_compose}} logs -f sync

# Remove all dev containers and images (full reset)
nuke:
    {{dev_compose}} down -v --rmi local

# =============================================================================
# Health & Status
# =============================================================================

# Check health of all services
health:
    @echo "Checking accounts..."
    @curl -sf http://localhost:5377/health && echo " OK" || echo " FAIL"
    @echo "Checking sync..."
    @curl -sf http://localhost:5379/health && echo " OK" || echo " FAIL"
    @echo "Checking todo..."
    @curl -sf http://localhost:5380/ && echo " OK" || echo " FAIL"

# Wait for services to be healthy
wait:
    @echo "Waiting for accounts..."
    @until curl -sf http://localhost:5377/health > /dev/null 2>&1; do sleep 1; done
    @echo "accounts is healthy"
    @echo "Waiting for sync..."
    @until curl -sf http://localhost:5379/health > /dev/null 2>&1; do sleep 1; done
    @echo "sync is healthy"
    @echo "Waiting for todo..."
    @until curl -sf http://localhost:5380/ > /dev/null 2>&1; do sleep 1; done
    @echo "todo is healthy"

# =============================================================================
# Container Access
# =============================================================================

# Shell into accounts container
shell-accounts:
    {{dev_compose}} exec accounts sh

# Shell into sync container
shell-sync:
    {{dev_compose}} exec sync sh

# PostgreSQL shell for accounts database
db-accounts:
    {{dev_compose}} exec accounts-db psql -U ${ACCOUNTS_DB_USER:-accounts} -d ${ACCOUNTS_DB_NAME:-accounts}

# PostgreSQL shell for sync database
db-sync:
    {{dev_compose}} exec sync-db psql -U ${SYNC_DB_USER:-sync} -d ${SYNC_DB_NAME:-sync}

# =============================================================================
# OAuth Client Setup
# =============================================================================

# Helper: run oauth-client command (auto-detects prod vs dev container)
[private]
oauth-client-cmd *args:
    #!/usr/bin/env bash
    set -e
    # Load credentials from .env (same source as docker-compose)
    if [ -f .env ]; then set -a; source .env; set +a; fi
    DB_USER="${ACCOUNTS_DB_USER:-accounts}"
    DB_PASS="${ACCOUNTS_DB_PASSWORD:-accounts}"
    DB_NAME="${ACCOUNTS_DB_NAME:-accounts}"
    DB_URL="postgres://${DB_USER}:${DB_PASS}@accounts-db:5432/${DB_NAME}?sslmode=disable"
    # Try compiled binary first (prod), fall back to cargo run (dev)
    if {{dev_compose}} exec -T accounts test -f /app/oauth-client 2>/dev/null; then
        {{dev_compose}} exec -T -e "DATABASE_URL=$DB_URL" accounts /app/oauth-client {{args}}
    else
        {{dev_compose}} exec -T -e "DATABASE_URL=$DB_URL" accounts cargo run --release -p betterbase-accounts-oauth-client -- {{args}}
    fi

# Set up OAuth client for an example app
# Usage: just setup-example <app-name> <port> [scopes...]
setup-example app port *scopes:
    ./scripts/setup-oauth-client.sh {{app}} {{port}} ./betterbase-examples/{{app}}/.env {{scopes}}

# Set up launchpad OAuth client (portal only — no sync needed)
setup-launchpad:
    just setup-example launchpad 5380

# Set up tasks app OAuth client
setup-tasks:
    just setup-example tasks 5381 sync

# Set up notes app OAuth client
setup-notes:
    just setup-example notes 5382 sync

# Set up photos app OAuth client (sync + files for photo blobs)
setup-photos:
    just setup-example photos 5383 sync files

# Set up board app OAuth client
setup-board:
    just setup-example board 5384 sync

# Set up passwords app OAuth client
setup-passwords:
    just setup-example passwords 5387 sync

# Set up chat app OAuth client
setup-chat:
    just setup-example chat 5385 sync

# Set up all example apps
setup-examples:
    just setup-launchpad
    just setup-tasks
    just setup-notes
    just setup-photos
    just setup-board
    just setup-passwords
    just setup-chat

# =============================================================================
# E2E Tests (Playwright browser tests)
# =============================================================================

# Start e2e services (isolated from dev/prod)
e2e-up:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
        echo "No .env found, running setup..."
        ./scripts/setup.sh
    fi
    # Generate Server B OPAQUE keys if not already set
    if ! grep -q "^OPAQUE_SERVER_SETUP_B=.\+" .env 2>/dev/null; then
        echo "Generating OPAQUE keys for Server B..."
        SETUP_B=$(cd ./betterbase-accounts && SQLX_OFFLINE=true cargo run --release -p betterbase-accounts-keygen 2>/dev/null)
        echo "" >> .env
        echo "# Server B (federation e2e)" >> .env
        echo "OPAQUE_SERVER_SETUP_B=$SETUP_B" >> .env
        echo "Server B OPAQUE keys generated"
    fi
    {{e2e_compose}} up -d --build

# Stop e2e services
e2e-down:
    {{e2e_compose}} down

# Stop e2e services and remove volumes (clean slate)
e2e-clean:
    {{e2e_compose}} down -v

# View e2e service logs
e2e-logs *args:
    {{e2e_compose}} logs -f {{args}}

# One-time setup: start services, create OAuth clients, write e2e/.env
e2e-setup:
    #!/usr/bin/env bash
    set -e
    echo "Starting e2e services..."
    just e2e-up
    echo "Waiting for Server A..."
    until curl -sf http://localhost:25377/health > /dev/null 2>&1; do sleep 1; done
    until curl -sf http://localhost:25379/health > /dev/null 2>&1; do sleep 1; done
    echo "Waiting for Server B..."
    until curl -sf http://localhost:25387/health > /dev/null 2>&1; do sleep 1; done
    until curl -sf http://localhost:25389/health > /dev/null 2>&1; do sleep 1; done
    echo "All services healthy"

    # ---- Federation key exchange ----
    # Each sync server generated a signing key on startup (via FEDERATION_DOMAIN).
    # Now we fetch each server's public key and configure the peer to trust it.
    echo "Exchanging federation keys..."

    # Helper: extract trusted_keys_entry from a JWKS endpoint
    extract_trusted_key() {
        local URL="$1"
        local JWKS
        JWKS=$(curl -sf "$URL")
        if [ -z "$JWKS" ]; then
            echo "Error: Could not fetch JWKS from $URL" >&2
            return 1
        fi
        # Extract kid and x (public key) from the first key in the JWKS
        echo "$JWKS" | python3 -c "import sys,json; k=json.load(sys.stdin)['keys'][0]; print(k['kid']+'='+k['x'])"
    }

    KEY_A=$(extract_trusted_key "http://localhost:25379/.well-known/jwks.json")
    if [ -z "$KEY_A" ]; then
        echo "Error: Failed to extract federation key from sync-a" >&2
        exit 1
    fi
    KEY_B=$(extract_trusted_key "http://localhost:25389/.well-known/jwks.json")
    if [ -z "$KEY_B" ]; then
        echo "Error: Failed to extract federation key from sync-b" >&2
        exit 1
    fi
    echo "Server A kid: $(echo "$KEY_A" | cut -d= -f1)"
    echo "Server B kid: $(echo "$KEY_B" | cut -d= -f1)"

    # Persist trusted keys to .env so docker-compose picks them up on restart
    # Server A trusts Server B's key, and vice versa
    sed -i.bak '/^FEDERATION_TRUSTED_KEYS_/d' .env && rm -f .env.bak
    echo "FEDERATION_TRUSTED_KEYS_A=$KEY_B" >> .env
    echo "FEDERATION_TRUSTED_KEYS_B=$KEY_A" >> .env

    # Restart sync services to pick up peer trusted keys
    {{e2e_compose}} stop sync sync-b
    {{e2e_compose}} up -d sync sync-b

    echo "Waiting for sync services to restart..."
    until curl -sf http://localhost:25379/health > /dev/null 2>&1; do sleep 1; done
    until curl -sf http://localhost:25389/health > /dev/null 2>&1; do sleep 1; done
    echo "Federation key exchange complete"

    # Helper: ensure OAuth client exists on a given accounts service
    ensure_oauth_client() {
        local SERVER_LABEL="$1"
        local CONTAINER="$2"
        local ENV_VAR="$3"

        echo "Setting up OAuth client on ${SERVER_LABEL}..."
        local EXISTING_ID=""
        if [ -f e2e/.env ]; then
            EXISTING_ID=$(grep "^${ENV_VAR}=" e2e/.env 2>/dev/null | cut -d= -f2)
        fi
        local CLIENT_ID=""
        if [ -n "$EXISTING_ID" ]; then
            local LIST_OUTPUT
            LIST_OUTPUT=$({{e2e_compose}} exec -T "$CONTAINER" /app/oauth-client list 2>&1)
            if echo "$LIST_OUTPUT" | grep -q "$EXISTING_ID"; then
                echo "${SERVER_LABEL} OAuth client $EXISTING_ID already exists"
                CLIENT_ID="$EXISTING_ID"
            fi
        fi
        if [ -z "$CLIENT_ID" ]; then
            local OUTPUT
            OUTPUT=$({{e2e_compose}} exec -T "$CONTAINER" /app/oauth-client create --name e2e-tests --redirect-uri "http://localhost:25390/" --scope sync --scope files 2>&1)
            CLIENT_ID=$(echo "$OUTPUT" | grep "^Client ID:" | awk '{print $3}')
            if [ -z "$CLIENT_ID" ]; then
                local LIST_OUTPUT
                LIST_OUTPUT=$({{e2e_compose}} exec -T "$CONTAINER" /app/oauth-client list 2>&1)
                CLIENT_ID=$(echo "$LIST_OUTPUT" | grep -A1 "Name:.*e2e-tests" | grep "ID:" | head -1 | awk '{print $2}')
            fi
            if [ -z "$CLIENT_ID" ]; then
                echo "Error: Could not create OAuth client on ${SERVER_LABEL}"
                exit 1
            fi
        fi
        echo "${SERVER_LABEL} OAuth client: $CLIENT_ID"
        # Return via global variable (bash functions can't return strings)
        _OAUTH_CLIENT_ID="$CLIENT_ID"
    }

    ensure_oauth_client "Server A" "accounts" "VITE_OAUTH_CLIENT_ID"
    CLIENT_ID_A="$_OAUTH_CLIENT_ID"

    ensure_oauth_client "Server B" "accounts-b" "VITE_OAUTH_CLIENT_ID_B"
    CLIENT_ID_B="$_OAUTH_CLIENT_ID"

    # Write e2e env file
    cat > e2e/.env << EOF
    VITE_OAUTH_CLIENT_ID=$CLIENT_ID_A
    VITE_OAUTH_CLIENT_ID_B=$CLIENT_ID_B
    VITE_DOMAIN_B=localhost:25387
    EOF
    # Remove leading whitespace from heredoc
    sed -i.bak 's/^    //' e2e/.env && rm -f e2e/.env.bak
    echo "e2e/.env written"

# Run e2e tests (services must be running, harness started by Playwright)
# Pass -x to stop on first failure: just e2e-test -x
e2e-test *args:
    cd e2e && pnpm test {{args}}

# Full cycle: clean slate → setup → run tests
# Pass -x to stop on first failure: just e2e -x
e2e *args:
    #!/usr/bin/env bash
    set -e
    just e2e-clean 2>/dev/null || true
    just e2e-setup
    just e2e-test {{args}}
