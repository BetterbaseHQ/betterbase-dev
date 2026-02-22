-- Unified cursor schema for less-sync.
--
-- This replaces all migrations (001-009) with a single greenfield schema.
-- Key change: all space data shares a single monotonic counter (`cursor`)
-- for unified catch-up, federation replication, and ordering guarantees.
--
-- This covers the core sync data model only. Federation-specific tables
-- (peer trust, replication state, PoW challenges) will be added in a
-- separate migration aligned with federation Phase 1.
--
-- Naming conventions:
--   cursor    = space-wide monotonic counter (used for sync catch-up)
--   chain_seq = membership hash chain position (1, 2, 3...)

-- +goose Up

-- A space is a sync namespace. Personal spaces have root_public_key = NULL
-- and are authenticated via JWT only. Shared spaces have a root_public_key
-- and require JWT + UCAN for authorization.
--
-- `cursor` is the space-wide monotonic counter. Every mutation (record push,
-- membership append, file upload) increments cursor. Clients resume sync
-- by passing their last-seen cursor value. Epoch state (key_generation,
-- rewrap_epoch) is tracked on the spaces row, not as cursor events.
CREATE TABLE spaces (
    id                  UUID PRIMARY KEY,
    client_id           TEXT NOT NULL,
    root_public_key     BYTEA,                          -- NULL = personal, SET = shared
    key_generation      INTEGER NOT NULL DEFAULT 1,     -- current epoch (fast access)
    min_key_generation  INTEGER NOT NULL DEFAULT 1,
    metadata_version    INTEGER NOT NULL DEFAULT 0,     -- CAS counter for membership appends
    cursor              BIGINT NOT NULL DEFAULT 0,
    rewrap_epoch        INTEGER,                        -- non-NULL = epoch advance in progress
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Encrypted sync records. All records in a push share the same cursor value
-- (the space cursor after the push transaction). Conflict detection is per-record
-- via the client-provided expected cursor matching the record's current cursor.
--
-- Deleted records are tombstones: `deleted = true`, blob and wrapped_dek zeroed.
-- Data is explicitly zeroed (not just NULLed) to ensure ciphertext is purged from
-- the database, not just dereferenced. Tombstones must be retained so the unified
-- cursor timeline has no gaps — clients catching up see the deletion and can
-- clean up local state.
CREATE TABLE records (
    id          UUID PRIMARY KEY,
    space_id    UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    blob        BYTEA,
    deleted     BOOLEAN NOT NULL DEFAULT FALSE,
    cursor      BIGINT NOT NULL,
    wrapped_dek BYTEA                                   -- 44 bytes AES-KW, NULL for personal spaces
);

CREATE INDEX idx_records_sync ON records(space_id, cursor, id);

-- File metadata for large files stored externally (filesystem or S3).
-- Files are identified by client-generated UUIDs (no content-addressing
-- to prevent content fingerprinting). Each file has a per-file wrapped DEK.
--
-- File uploads happen after the push transaction, so the file's cursor
-- value will be after the record that references it. Clients handle file
-- availability as eventually consistent.
--
-- Deleted files are tombstones: `deleted = true`, wrapped_dek zeroed.
-- The file blob is cleaned up from storage and the wrapped_dek is zeroed
-- to purge key material. The metadata row remains so the cursor timeline
-- has no gaps.
CREATE TABLE files (
    space_id    UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    id          UUID NOT NULL,
    record_id   UUID NOT NULL REFERENCES records(id),
    size        BIGINT,                                  -- zeroed when deleted
    deleted     BOOLEAN NOT NULL DEFAULT FALSE,
    wrapped_dek BYTEA,                                  -- zeroed when deleted
    cursor      BIGINT NOT NULL,
    PRIMARY KEY (space_id, id),
    CONSTRAINT files_not_deleted_check CHECK (deleted OR (size >= 0 AND wrapped_dek IS NOT NULL AND length(wrapped_dek) = 44))
);

CREATE INDEX idx_files_space_cursor ON files(space_id, cursor);
CREATE INDEX idx_files_record_id ON files(record_id);

-- Membership log: opaque encrypted entries forming a hash chain.
-- The server validates structure (hash chain integrity, CAS on
-- metadata_version) but never interprets entry contents.
--
-- `chain_seq` is the hash chain position (1, 2, 3...) for integrity
-- validation. `cursor` is the space-wide position for unified catch-up.
CREATE TABLE members (
    space_id    UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    chain_seq   INTEGER NOT NULL,
    cursor      BIGINT NOT NULL,
    prev_hash   BYTEA,
    entry_hash  BYTEA NOT NULL,
    payload     BYTEA NOT NULL,
    PRIMARY KEY (space_id, chain_seq)
);

CREATE INDEX idx_members_cursor ON members(space_id, cursor);

-- Epoch state lives on the `spaces` row: `key_generation`, `min_key_generation`,
-- `rewrap_epoch`. No separate epoch table needed — epoch advances update the
-- space row and the client reads current state from space-level frames.
-- The client determines which epoch a record belongs to by reading the
-- 4-byte epoch prefix on the wrapped DEK.

-- UCAN revocation list. Only existence is checked (IsRevoked).
-- No metadata stored — no who, no when.
CREATE TABLE revocations (
    space_id    UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    ucan_cid    TEXT NOT NULL,
    PRIMARY KEY (space_id, ucan_cid)
);

-- Invitations: encrypted payloads addressed to a mailbox.
-- Mailbox ID is a client-derived hash (server never sees recipient identity).
CREATE TABLE invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id  CHAR(64) NOT NULL,
    payload     BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_invitations_mailbox ON invitations(mailbox_id, created_at DESC);
CREATE INDEX idx_invitations_expires ON invitations(expires_at);

-- Ephemeral rate limiting. Rows are cleaned up periodically.
CREATE TABLE rate_limit_actions (
    action      VARCHAR(32) NOT NULL,
    actor_hash  CHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rate_limit_actions_lookup ON rate_limit_actions(action, actor_hash, created_at);

-- Triggers
-- +goose StatementBegin
CREATE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER spaces_updated_at BEFORE UPDATE ON spaces
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- +goose Down
DROP TRIGGER IF EXISTS spaces_updated_at ON spaces;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS rate_limit_actions;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS revocations;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS records;
DROP TABLE IF EXISTS spaces;
