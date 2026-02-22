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

# Run oauth-client command inside the accounts container
oauth_client_cmd() {
    cd "$PROJECT_ROOT"
    docker compose exec -T accounts /app/oauth-client "$@"
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
    LIST_OUTPUT=$(oauth_client_cmd list 2>&1)
    if echo "$LIST_OUTPUT" | grep -q "$EXISTING_ID"; then
        echo -e "${GREEN}OAuth client $EXISTING_ID exists in database${NC}"
        echo "Client ID: $EXISTING_ID"
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
    CLIENT_ID=$(echo "$LIST_OUTPUT" | grep -A1 "Name:.*$APP_NAME" | grep "ID:" | head -1 | awk '{print $2}')
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
