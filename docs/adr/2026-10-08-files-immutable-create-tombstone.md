# ADR: File objects are immutable — create + tombstone, never in-place update

**Status:** Accepted (2026-10-08)
**Context:** betterbase-sync files API (`/api/v1/spaces/{space_id}/files/{id}`), betterbase JS SDK `FileStore`/`FilesClient`. Surfaced by GH betterbase#8/#9 (waddle's whole-machine backups over the files API).

## Decision

File objects are **write-once**: a file id's ciphertext, once committed, never
changes under that id. The complete mutation vocabulary is:

- **Create** — `PUT` under a fresh (or tombstoned-and-swept) id. Byte-identical
  replays are idempotent (204). Different bytes under a live id → **409
  Conflict** — never a silent keep-old-bytes success.
- **Tombstone** — `DELETE` soft-deletes metadata (streams `deleted: true`
  through cursor-based pull) and queues the object for grace-period removal via
  the existing AUD-039 sweep. A re-upload of the same id resurrects the row.
- **Replace** — *not an operation*. Replacing content is a new file id plus a
  record-pointer update (the record CRDT arbitrates concurrent pointers), then
  optionally `DELETE` of the superseded generation.

Clients must treat `FileStore.put` ids as content-version addresses: changed
content under the same id is an error (server 409, surfaced as
`FileConflictError`), not an update.

## Why

1. **Records are the sync unit; blobs aren't.** All conflict resolution in
   betterbase is CRDT-on-records. File bytes have no merge semantics, so
   mutability at the blob layer would require inventing a second conflict model
   (LWW) that the record layer already provides — with strictly better
   properties — via pointers.
2. **Immutability is load-bearing for the crash-safety proofs.** AUD-027's
   retry healing ("the object exists ⇒ these are the bytes") and AUD-039's
   grace period / re-upload guard both assume a live `(space, file_id)` has
   stable bytes. In-place mutation breaks both: a post-crash retry can't tell
   *which* attempt's bytes landed, and in-flight downloads during the grace
   window could observe torn or mismatched content.
3. **The wrapped-DEK binding is per-write.** Each upload wraps a fresh DEK
   under the space's current epoch key; the metadata row carries that wrapper
   (with `min_epoch` enforced at commit, AUD-029). Immutable objects never need
   to rotate that pairing; mutable ones would couple every content change to
   key-rotation races (old DEK + new bytes = unrecoverable file).
4. **Caching assumes it.** FileStore caches locally and never re-fetches while
   cached; metadata (size, wrapped DEK, ETag) is committed once. Stable bytes
   make "have I fetched this id?" a once-ever question.

## What "correct client behavior" means (and what was fixed)

The contract was previously implicit — and the SDK violated it: `FileStore`
generated a **fresh DEK + IV per upload attempt**, so retries of the same
content produced different ciphertext. Combined with the server's create-only
store this caused (a) silent keep-old-bytes successes on re-put (data loss with
a green status) and (b, in the crash window) a committed wrapped DEK that could
never decrypt the retained object.

Fixes shipped with this ADR:

- **Server:** conflicting ciphertext under a live id → 409 (ciphertext-only
  comparison, with a size fast-path — the server learns nothing beyond
  equality of blobs it already holds); `DELETE` route through the AUD-039
  queue; per-space file quota (count + bytes, `SYNC_FILE_QUOTA_MAX_FILES` /
  `SYNC_FILE_QUOTA_MAX_BYTES` — counts live files **plus tombstoned files
  still awaiting grace-period removal**, so create→delete churn cannot cycle
  past the physical bound through the grace window; `0` disables an axis);
  upload concurrency bound (`SYNC_UPLOAD_CONCURRENCY`); route body limit
  raised to the handler's own 100 MiB cap. Pull tombstone entries carry no
  wrapped DEK.
- **SDK:** one `(DEK, IV, content hash)` per content version, minted at
  `put()` and persisted with the queue entry — every retry of that version
  produces byte-identical ciphertext (`encryptV4WithIv`), so interrupted
  uploads heal as true idempotent replays. The pairing is re-verified against
  the blob's hash at upload time, so a `put()` of changed content racing an
  in-flight attempt re-mints instead of ever pairing a transmitted IV with
  different plaintext. `FileConflictError` on 409 with an actionable message.
  Queue-state clears drop the key material; the content hash survives so an
  identical re-put after an acknowledged upload stays a cache-only write
  (no spurious conflict).

## If update-style semantics are ever wanted

LWW-at-the-blob-layer is implementable without abandoning immutability:
server-managed generations (PUT to a live id writes a new content-versioned
object + atomic metadata swap + old generation GC through the existing queue),
with `If-Match` for optimistic concurrency so writers who care lose loudly
(409) instead of silently. See the review thread preceding this ADR. That is
additive and preserves every invariant above; in-place byte mutation is
rejected permanently.

## Consequences

- Replacing content is two writes (new id + pointer) instead of one — the
  record layer already makes this cheap and merge-safe.
- Producers that rotate generations (backup apps) must `DELETE` superseded ids
  (or tombstone their owning records) or storage grows monotonically until the
  per-space quota rejects new uploads.
- Re-creating a deleted id with *different* content inside the deletion grace
  window (default 24h) 409s until the sweep removes the old object; use a new
  id instead.
- Large opaque payloads should use the files API, not `t.text()` CRDT fields
  (see GH betterbase#7): CRDT text merge cost is superlinear in field size.
- Soft-deleted metadata rows persist (they are the pull-delivery mechanism for
  tombstones, like record tombstones). A retention horizon for ancient
  tombstone rows is a possible follow-up, deliberately not taken here.
- Deployment: ship the code and DB migration 017 together — a pre-change
  replica serving a tombstoned row (NULL wrapped DEK) would fail its decode.

## Follow-ups deliberately deferred

- Terminal handling for permanently-conflicted queue entries (409 entries
  currently surface as retryable errors; each retry is cheap and
  byte-identical, but a terminal state with a clear remedy is better UX).
- Local eviction of cached bytes when a `deleted: true` file entry arrives via
  pull/WS (today the SDK invalidates UI caches; the local blob stays until
  LRU eviction).
- A streaming (non-buffered) upload path (`put_multipart`) to shrink the
  per-upload memory floor below 2× body size.
