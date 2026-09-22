#!/usr/bin/env bash
# setup-oauth-client.sh - Create OAuth client for an example app
# Usage: ./scripts/setup-oauth-client.sh <app-name> <port> <env-file> [scopes...]
# Example: ./scripts/setup-oauth-client.sh tasks 5381 examples/tasks/.env sync
# Example: ./scripts/setup-oauth-client.sh photos 5383 examples/photos/.env sync files

set -e

# Args
APP_NAME="${1:?Usage: $0 <app-name> <port> <env-file> [scopes...]}"
PORT="${2:?Usage: $0 <app-name> <port> <env-file> [scopes...]}"
ENV_FILE="${3:?Usage: $0 <app-name> <port> <env-file> [scopes...]}"
shift 3
SCOPES=("$@")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Mirror the client ID into the root .env as <APP>_CLIENT_ID so the
# docker-compose examples service can inject it into the hosted-apps
# container (dev vite apps read the per-app .env instead).
upsert_root_env() {
    local root_env="$PROJECT_ROOT/.env"
    local var
    var="$(echo "$APP_NAME" | tr '[:lower:]' '[:upper:]')_CLIENT_ID"
    [ -f "$root_env" ] || return 0
    if grep -q "^$var=" "$root_env" 2>/dev/null; then
        sed -i '' "s|^$var=.*|$var=$1|" "$root_env" 2>/dev/null || \
            sed -i "s|^$var=.*|$var=$1|" "$root_env"
    else
        printf '%s=%s\n' "$var" "$1" >> "$root_env"
    fi
}

# Run oauth-client command inside the accounts container
# Uses the compiled binary in prod; falls back to cargo run in dev containers
oauth_client_cmd() {
    cd "$PROJECT_ROOT"
    if docker compose exec -T accounts test -f /app/oauth-client 2>/dev/null; then
        docker compose exec -T accounts /app/oauth-client "$@"
    else
        if [ -f .env ]; then set -a; source .env; set +a; fi
        DB_USER="${ACCOUNTS_DB_USER:-accounts}"
        DB_PASS="${ACCOUNTS_DB_PASSWORD:-accounts}"
        DB_NAME="${ACCOUNTS_DB_NAME:-accounts}"
        DB_URL="postgres://${DB_USER}:${DB_PASS}@accounts-db:5432/${DB_NAME}?sslmode=disable"
        docker compose exec -T -e "DATABASE_URL=$DB_URL" -e "SQLX_OFFLINE=true" \
            accounts cargo run --release -p betterbase-accounts-oauth-client -- "$@"
    fi
}

echo -e "${GREEN}Setting up OAuth client for $APP_NAME...${NC}"

# Ensure accounts service is running
if ! curl -sf http://localhost:5377/health > /dev/null 2>&1; then
    echo -e "${RED}Error: accounts service is not running. Start it with 'just up' first.${NC}"
    exit 1
fi

# Check if we have an existing client ID in .env
EXISTING_ID=""
if [ -f "$ENV_FILE" ]; then
    EXISTING_ID=$(grep "^VITE_OAUTH_CLIENT_ID=" "$ENV_FILE" 2>/dev/null | cut -d= -f2)
fi

# If we have an ID, verify it exists in the database
if [ -n "$EXISTING_ID" ]; then
    # Rows print "ID:" before "Name:", so track the last seen ID
    LIST_OUTPUT=$(oauth_client_cmd list 2>&1)
    if echo "$LIST_OUTPUT" | grep -q "$EXISTING_ID"; then
        echo -e "${GREEN}OAuth client $EXISTING_ID exists in database${NC}"
        echo "Client ID: $EXISTING_ID"
        upsert_root_env "$EXISTING_ID"
        exit 0
    else
        echo -e "${YELLOW}OAuth client $EXISTING_ID not found in database, recreating...${NC}"
    fi
fi

# Create OAuth client
echo "Creating OAuth client for $APP_NAME (http://localhost:$PORT/)"
SCOPE_ARGS=()
for s in "${SCOPES[@]}"; do
    SCOPE_ARGS+=(--scope "$s")
done
OUTPUT=$(oauth_client_cmd create --name "$APP_NAME" --redirect-uri "http://localhost:$PORT/" "${SCOPE_ARGS[@]}" 2>&1)

# Extract client ID from output
CLIENT_ID=$(echo "$OUTPUT" | grep "^Client ID:" | awk '{print $3}')

# If create failed (client name exists), get ID from list
if [ -z "$CLIENT_ID" ]; then
    LIST_OUTPUT=$(oauth_client_cmd list 2>&1)
    CLIENT_ID=$(echo "$LIST_OUTPUT" | awk -v n="$APP_NAME" \
        '$1 == "ID:" { id = $2 } $1 == "Name:" && $2 == n { print id }' | head -1)
fi

if [ -z "$CLIENT_ID" ]; then
    echo -e "${RED}Error: Could not create or find OAuth client${NC}"
    echo "$OUTPUT"
    exit 1
fi

# Ensure directory exists
mkdir -p "$(dirname "$ENV_FILE")"

# Write to .env file
echo "VITE_OAUTH_CLIENT_ID=$CLIENT_ID" > "$ENV_FILE"
echo -e "${GREEN}OAuth client ID saved to $ENV_FILE${NC}"
echo "Client ID: $CLIENT_ID"

# Also expose as <APP>_CLIENT_ID in the root .env so the examples service
# (docker-compose.yml) can inject it into the hosted-apps container.
upsert_root_env "$CLIENT_ID"
