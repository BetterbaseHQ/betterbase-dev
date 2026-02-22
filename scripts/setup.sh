#!/usr/bin/env bash
#
# Betterbase Dev Setup Script
#
# Generates all security keys and configures .env for first-time setup.
# This script is idempotent - running it again won't overwrite existing keys.
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

cd "$PROJECT_ROOT"

# =============================================================================
# Dependency Checks
# =============================================================================

check_dependencies() {
    log_info "Checking dependencies..."

    local missing=()

    command -v git >/dev/null 2>&1 || missing+=("git")
    command -v cargo >/dev/null 2>&1 || missing+=("cargo (Rust)")
    command -v docker >/dev/null 2>&1 || missing+=("docker")
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq >/dev/null 2>&1 || missing+=("jq")

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required dependencies: ${missing[*]}"
        echo ""
        echo "Please install the missing tools and try again."
        exit 1
    fi

    # Check Docker is running
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi

    log_success "All dependencies found"
}

# =============================================================================
# Repository Setup
# =============================================================================

clone_repos() {
    log_info "Checking repositories..."

    if [ ! -d betterbase-accounts ]; then
        log_info "Cloning betterbase-accounts..."
        git clone git@github.com:BetterbaseHQ/betterbase-accounts.git
    else
        log_success "betterbase-accounts already exists"
    fi

    if [ ! -d betterbase-sync ]; then
        log_info "Cloning betterbase-sync..."
        git clone git@github.com:BetterbaseHQ/betterbase-sync.git
    else
        log_success "betterbase-sync already exists"
    fi

    if [ ! -d betterbase-db ]; then
        log_info "Cloning betterbase-db..."
        git clone git@github.com:BetterbaseHQ/betterbase-db.git
    else
        log_success "betterbase-db already exists"
    fi

    if [ ! -d betterbase-db ]; then
        log_info "Cloning betterbase-db..."
        git clone git@github.com:BetterbaseHQ/betterbase-db.git
    else
        log_success "betterbase-db already exists"
    fi

    if [ ! -d betterbase-inference ]; then
        log_info "Cloning betterbase-inference..."
        git clone git@github.com:BetterbaseHQ/betterbase-inference.git
    else
        log_success "betterbase-inference already exists"
    fi

    if [ ! -d betterbase ]; then
        log_info "Cloning betterbase..."
        git clone git@github.com:BetterbaseHQ/betterbase.git
    else
        log_success "betterbase already exists"
    fi
}

# =============================================================================
# Key Generation Utilities
# =============================================================================

# Generate a cryptographically secure hex-encoded random string
# Usage: generate_secret <bytes>
# Output: hex string (2 chars per byte, so 32 bytes = 64 char string)
generate_secret() {
    local bytes=${1:-32}
    head -c "$bytes" /dev/urandom | xxd -p | tr -d '\n'
}

# =============================================================================
# OPAQUE Key Generation
# =============================================================================

generate_opaque_keys() {
    if [ -f "$ENV_FILE" ] && grep -q "^OPAQUE_SERVER_SETUP=.\+" "$ENV_FILE"; then
        log_success "OPAQUE keys already configured"
        return 0
    fi

    log_info "Generating OPAQUE keys..."

    if [ ! -d betterbase-accounts ]; then
        log_error "betterbase-accounts directory not found. Run setup without --skip-repos first."
        exit 1
    fi

    OPAQUE_SERVER_SETUP=$(cd betterbase-accounts && SQLX_OFFLINE=true cargo run --release -p betterbase-accounts-keygen 2>/dev/null)

    if [ -z "$OPAQUE_SERVER_SETUP" ]; then
        log_error "OPAQUE key generation failed"
        exit 1
    fi

    log_success "OPAQUE keys generated"
}

# =============================================================================
# CAP Provisioning
# =============================================================================

provision_cap() {
    # Check if CAP is already configured
    if [ -f "$ENV_FILE" ] && grep -q "^CAP_KEY_ID=.\+" "$ENV_FILE" && grep -q "^CAP_SECRET=.\+" "$ENV_FILE"; then
        log_success "CAP credentials already configured"
        return 0
    fi

    log_info "Provisioning CAP (proof-of-work CAPTCHA)..."

    # Generate CAP admin key if not set
    if [ -z "${CAP_ADMIN_KEY:-}" ]; then
        CAP_ADMIN_KEY=$(generate_secret 32)
        log_success "Generated CAP admin key"
    fi

    # Write minimal .env so docker compose can start CAP
    write_env_file

    # Start only the CAP service
    log_info "Starting CAP service..."
    docker compose up -d cap

    # Get the docker network name for this project
    local network_name
    network_name=$(docker network ls --filter "name=betterbase" --format '{{.Name}}' | grep -E '_default$' | head -1)

    # If network doesn't exist yet, get it from the container's network settings
    if [ -z "$network_name" ]; then
        sleep 2
        # shellcheck disable=SC2016 # Go template syntax, not shell variables
        network_name=$(docker compose ps -q cap 2>/dev/null | xargs docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null | head -1)
    fi

    # Validate we got a network
    if [ -z "$network_name" ]; then
        log_error "Could not determine Docker network for CAP service"
        docker compose stop cap
        exit 1
    fi

    # Wait for CAP to be healthy using curl container
    log_info "Waiting for CAP to be ready..."
    local retries=30
    while [ $retries -gt 0 ]; do
        if docker run --rm --network "$network_name" curlimages/curl:latest -sf http://cap:3000/ >/dev/null 2>&1; then
            break
        fi
        retries=$((retries - 1))
        sleep 1
    done

    if [ $retries -eq 0 ]; then
        log_error "CAP service failed to start"
        docker compose logs cap
        exit 1
    fi

    log_success "CAP service is ready"

    # Helper function to run curl against CAP via docker
    cap_curl() {
        docker run --rm --network "$network_name" curlimages/curl:latest -sf "$@"
    }

    # Login to CAP admin API
    log_info "Authenticating with CAP..."
    local login_response
    login_response=$(cap_curl -X POST http://cap:3000/auth/login \
        -H "Content-Type: application/json" \
        -d "{\"admin_key\":\"$CAP_ADMIN_KEY\"}" 2>&1) || {
        log_error "Failed to login to CAP (check logs with 'docker compose logs cap')"
        docker compose stop cap
        exit 1
    }

    local session_token hashed_token
    session_token=$(echo "$login_response" | jq -r '.session_token')
    hashed_token=$(echo "$login_response" | jq -r '.hashed_token')

    if [ "$session_token" = "null" ] || [ -z "$session_token" ]; then
        log_error "Failed to get CAP session token"
        docker compose stop cap
        exit 1
    fi

    # Create bearer auth token (base64 encoded JSON)
    local auth_payload auth_token
    auth_payload="{\"token\":\"$session_token\",\"hash\":\"$hashed_token\"}"
    auth_token=$(echo -n "$auth_payload" | base64 | tr -d '\n')

    # Create site key
    log_info "Creating CAP site key..."
    local key_response
    key_response=$(cap_curl -X POST http://cap:3000/server/keys \
        -H "Authorization: Bearer $auth_token" \
        -H "Content-Type: application/json" \
        -d '{"name":"betterbase-accounts"}' 2>&1) || {
        log_error "Failed to create CAP site key"
        docker compose stop cap
        exit 1
    }

    CAP_KEY_ID=$(echo "$key_response" | jq -r '.siteKey')
    CAP_SECRET=$(echo "$key_response" | jq -r '.secretKey')

    if [ "$CAP_KEY_ID" = "null" ] || [ -z "$CAP_KEY_ID" ]; then
        log_error "Failed to get CAP site key"
        docker compose stop cap
        exit 1
    fi

    log_success "CAP site key created"

    # Stop CAP (will be started with full stack)
    log_info "Stopping CAP service..."
    docker compose stop cap
}

# =============================================================================
# Environment File
# =============================================================================

write_env_file() {
    log_info "Writing .env file..."

    # Generate DB passwords if not set
    ACCOUNTS_DB_PASSWORD=${ACCOUNTS_DB_PASSWORD:-$(generate_secret 24)}
    SYNC_DB_PASSWORD=${SYNC_DB_PASSWORD:-$(generate_secret 24)}

    cat > "$ENV_FILE" << EOF
# =============================================================================
# Betterbase Dev Configuration
# Generated by scripts/setup.sh - DO NOT COMMIT THIS FILE
# =============================================================================

# OPAQUE Authentication Keys
# Hex-encoded OPAQUE ServerSetup blob for password protocol.
# Changing this will invalidate all existing user passwords!
OPAQUE_SERVER_SETUP=${OPAQUE_SERVER_SETUP:-}

# Federation / OAuth Issuer (required)
# Must be a stable URL origin for this accounts server identity namespace.
OAUTH_ISSUER=${OAUTH_ISSUER:-https://accounts.betterbase.dev}

# CAP (Proof-of-Work CAPTCHA)
# Admin key for CAP dashboard access (http://localhost:5377/cap/)
CAP_ADMIN_KEY=${CAP_ADMIN_KEY:-}
# Site key credentials for API verification
CAP_KEY_ID=${CAP_KEY_ID:-}
CAP_SECRET=${CAP_SECRET:-}

# Database Credentials
ACCOUNTS_DB_USER=accounts
ACCOUNTS_DB_PASSWORD=${ACCOUNTS_DB_PASSWORD}
ACCOUNTS_DB_NAME=accounts

SYNC_DB_USER=sync
SYNC_DB_PASSWORD=${SYNC_DB_PASSWORD}
SYNC_DB_NAME=sync

# Sync Service Keys
# HMAC key for privacy-preserving identity hashing in invitations.
# Changing this invalidates all existing invitation lookups!
IDENTITY_HASH_KEY=${IDENTITY_HASH_KEY}
# HMAC key for space session tokens (optional, ephemeral if unset).
SPACE_SESSION_SECRET=${SPACE_SESSION_SECRET}
EOF

    # Set restrictive permissions (secrets file)
    chmod 600 "$ENV_FILE"

    log_success ".env file written"
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════╗"
    echo "║              Betterbase Dev Setup                                  ║"
    echo "╚═══════════════════════════════════════════════════════════════════╝"
    echo ""

    # Check if .env already exists and is fully configured
    if [ -f "$ENV_FILE" ]; then
        if grep -q "^OPAQUE_SERVER_SETUP=.\+" "$ENV_FILE" && \
           grep -q "^OAUTH_ISSUER=.\+" "$ENV_FILE" && \
           grep -q "^CAP_KEY_ID=.\+" "$ENV_FILE" && \
           grep -q "^CAP_SECRET=.\+" "$ENV_FILE" && \
           grep -q "^IDENTITY_HASH_KEY=.\+" "$ENV_FILE"; then
            log_success ".env is already fully configured"
            echo ""
            echo "To regenerate all keys, delete .env and run setup again."
            echo "Run 'just up' to start services."
            exit 0
        fi
    fi

    check_dependencies
    clone_repos

    # Initialize variables
    OPAQUE_SERVER_SETUP=""
    OAUTH_ISSUER=""
    CAP_ADMIN_KEY=""
    CAP_KEY_ID=""
    CAP_SECRET=""
    ACCOUNTS_DB_PASSWORD=""
    SYNC_DB_PASSWORD=""
    IDENTITY_HASH_KEY=""
    SPACE_SESSION_SECRET=""

    # Load existing values if any (parse defensively, don't source)
    if [ -f "$ENV_FILE" ]; then
        while IFS='=' read -r key value; do
            # Only load known safe variables
            case "$key" in
                OPAQUE_SERVER_SETUP|OAUTH_ISSUER|CAP_ADMIN_KEY|CAP_KEY_ID|CAP_SECRET|ACCOUNTS_DB_PASSWORD|SYNC_DB_PASSWORD|IDENTITY_HASH_KEY|SPACE_SESSION_SECRET)
                    # Remove surrounding quotes if present
                    value="${value%\"}"
                    value="${value#\"}"
                    declare "$key=$value"
                    ;;
            esac
        done < <(grep -E '^[A-Z_]+=.+' "$ENV_FILE" 2>/dev/null || true)
    fi

    generate_opaque_keys

    # Default issuer for local and first-time setup.
    if [ -z "$OAUTH_ISSUER" ]; then
        OAUTH_ISSUER="https://accounts.betterbase.dev"
    fi

    # Generate CAP admin key before provisioning
    if [ -z "$CAP_ADMIN_KEY" ]; then
        CAP_ADMIN_KEY=$(generate_secret 32)
    fi

    provision_cap

    # Generate sync service keys
    if [ -z "$IDENTITY_HASH_KEY" ]; then
        IDENTITY_HASH_KEY=$(generate_secret 32)
        log_success "Generated identity hash key"
    fi
    if [ -z "$SPACE_SESSION_SECRET" ]; then
        SPACE_SESSION_SECRET=$(generate_secret 32)
        log_success "Generated space session secret"
    fi

    # Final write with all values
    write_env_file

    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════╗"
    echo "║              Setup Complete!                                      ║"
    echo "╚═══════════════════════════════════════════════════════════════════╝"
    echo ""
    log_success "All security keys have been generated"
    echo ""
    echo "Next steps:"
    echo "  1. Run 'just up' to start all services"
    echo "  2. Access the app at http://localhost:5380"
    echo ""
    echo "CAP Dashboard: http://localhost:5377/cap/"
    echo "  Login with the CAP_ADMIN_KEY in your .env file"
    echo ""
}

main "$@"
