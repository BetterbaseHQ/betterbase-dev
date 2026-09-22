#!/usr/bin/env bash
# Production backup/restore (AUD-058).
#
# Backup:  accounts + sync databases (pg_dump custom format) and the sync
#          blob-file volume (+ Caddy cert store). Restores are exact.
# Restore: stops app services (DBs stay up), restores DBs and volumes,
#          restarts. Requires the target stack to have been started at least
#          once (volumes must exist).
#
# Consistency: this is a HOT backup — each database dump is MVCC-consistent
# and each volume archive is a point-in-time snapshot, but accounts-DB /
# sync-DB / blob-files are not mutually consistent (in-flight requests can
# span stores). For strict cross-store consistency stop app services
# (`docker compose -f docker-compose.yml stop accounts sync`) first.
#
# Scope is the PRODUCTION compose project (docker-compose.yml). Dev/e2e data
# is ephemeral by design and not covered.
#
# Usage:
#   scripts/backup.sh                  # -> backups/<timestamp>/
#   scripts/backup.sh /path/to/dir     # restore from that backup
set -euo pipefail
cd "$(dirname "$0")/.."

PROD="docker compose -f docker-compose.yml"

# Compose project name (accounts for a `name:` override or COMPOSE_PROJECT_NAME)
PROJECT=$($PROD config --format json | python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')

ACCOUNTS_DB_USER="${ACCOUNTS_DB_USER:-accounts}"
ACCOUNTS_DB_NAME="${ACCOUNTS_DB_NAME:-accounts}"
SYNC_DB_USER="${SYNC_DB_USER:-sync}"
SYNC_DB_NAME="${SYNC_DB_NAME:-sync}"

if [ "${1:-}" = "--restore" ]; then
    RESTORE_DIR="${2:?usage: backup.sh --restore <backup-dir>}"
    [ -f "$RESTORE_DIR/accounts.dump" ] && [ -f "$RESTORE_DIR/sync.dump" ] || {
        echo "Error: $RESTORE_DIR is not a backup directory (accounts.dump / sync.dump missing)" >&2
        exit 1
    }

    # Restart only what was running before the restore (a cold restore into
    # a stopped stack leaves it stopped; bringing up the full stack here
    # would also require complete runtime env, which restore must not assume)
    # Fail closed: with `set -o pipefail`, a failing compose ps aborts the
    # restore rather than being read as "nothing was running"
    RUNNING_SERVICES=$($PROD ps --services --filter 'status=running' | sort -u | tr '\n' ' ')

    echo "Stopping app services for consistent restore..."
    $PROD stop accounts sync caddy 2>/dev/null || true
    $PROD up -d accounts-db sync-db
    echo "Waiting for databases..."
    until $PROD exec -T accounts-db pg_isready -U "$ACCOUNTS_DB_USER" >/dev/null 2>&1; do sleep 1; done
    until $PROD exec -T sync-db pg_isready -U "$SYNC_DB_USER" >/dev/null 2>&1; do sleep 1; done

    echo "Restoring accounts database..."
    $PROD exec -T accounts-db pg_restore -U "$ACCOUNTS_DB_USER" -d "$ACCOUNTS_DB_NAME" --clean --if-exists --exit-on-error < "$RESTORE_DIR/accounts.dump"
    echo "Restoring sync database..."
    $PROD exec -T sync-db pg_restore -U "$SYNC_DB_USER" -d "$SYNC_DB_NAME" --clean --if-exists --exit-on-error < "$RESTORE_DIR/sync.dump"

    echo "Restoring sync blob files..."
    docker run --rm \
        -v "${PROJECT}_sync_files:/var/lib/betterbase-sync/files" \
        -v "$(cd "$RESTORE_DIR" && pwd):/backup:ro" \
        alpine sh -c 'rm -rf /var/lib/betterbase-sync/files/* && tar xzf /backup/sync_files.tar.gz -C /var/lib/betterbase-sync/files'

    # An empty archive means Caddy had no data when the backup was taken;
    # restoring it would wipe live certificates for nothing
    if [ -f "$RESTORE_DIR/caddy_data.tar.gz" ] \
        && tar tzf "$RESTORE_DIR/caddy_data.tar.gz" | grep -q .; then
        echo "Restoring Caddy certificate store..."
        docker run --rm \
            -v "${PROJECT}_caddy_data:/data" \
            -v "$(cd "$RESTORE_DIR" && pwd):/backup:ro" \
            alpine sh -c 'rm -rf /data/* && tar xzf /backup/caddy_data.tar.gz -C /data'
    fi

    echo "Starting services..."
    if [ -n "${RUNNING_SERVICES// /}" ]; then
        # Shellcheck: intentional word splitting of the service list
        # shellcheck disable=SC2086
        $PROD up -d $RUNNING_SERVICES
    else
        echo "(stack was fully stopped before restore — start it with \`just prod\` when ready)"
    fi
    echo "Restore complete. Verify with: just health"
    exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-backups/$STAMP}"
mkdir -p "$DEST"

echo "Backing up to $DEST (project: $PROJECT)..."
echo "Ensuring databases are up..."
$PROD up -d accounts-db sync-db
until $PROD exec -T accounts-db pg_isready -U "$ACCOUNTS_DB_USER" >/dev/null 2>&1; do sleep 1; done
until $PROD exec -T sync-db pg_isready -U "$SYNC_DB_USER" >/dev/null 2>&1; do sleep 1; done

echo "Dumping accounts database..."
$PROD exec -T accounts-db pg_dump -U "$ACCOUNTS_DB_USER" -d "$ACCOUNTS_DB_NAME" -Fc > "$DEST/accounts.dump"
echo "Dumping sync database..."
$PROD exec -T sync-db pg_dump -U "$SYNC_DB_USER" -d "$SYNC_DB_NAME" -Fc > "$DEST/sync.dump"

echo "Archiving sync blob files..."
docker run --rm \
    -v "${PROJECT}_sync_files:/var/lib/betterbase-sync/files:ro" \
    -v "$(cd "$DEST" && pwd):/backup" \
    alpine tar czf /backup/sync_files.tar.gz -C /var/lib/betterbase-sync/files .

# docker would auto-create a missing named volume on -v; check first so a
# never-ran-Caddy stack simply skips the archive instead of recording empty
if docker volume inspect "${PROJECT}_caddy_data" >/dev/null 2>&1; then
    echo "Archiving Caddy certificate store..."
    docker run --rm \
        -v "${PROJECT}_caddy_data:/data:ro" \
        -v "$(cd "$DEST" && pwd):/backup" \
        alpine tar czf /backup/caddy_data.tar.gz -C /data .
else
    echo "  (no Caddy data volume yet — skipping)"
fi

echo "Verifying backup artifacts..."
for f in accounts.dump sync.dump sync_files.tar.gz; do
    [ -s "$DEST/$f" ] || { echo "Error: $DEST/$f is missing or empty" >&2; exit 1; }
done

echo "Backup complete:"
ls -lh "$DEST"
echo "Restore with: scripts/backup.sh --restore $(cd "$DEST" && pwd)"
