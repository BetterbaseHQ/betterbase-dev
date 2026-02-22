# File Lifecycle — Record-Owned Files

## Summary

Every file must be owned by exactly one record. Files are uploaded with a
`recordId` binding. When a record is deleted (tombstoned), the server deletes
its associated files and clients evict them from the local cache.

No orphaned files. No GC sweeps. No manifest collection.

## Lifecycle

### Create

1. App calls `fileStore.put(fileId, recordId, data)` — encrypts + uploads with
   record binding
2. App stores file ID(s) in a synced record field (e.g. `photo.thumbnailId`,
   `note.attachmentIds`)
3. Record syncs normally via CRDT

### Read

1. App sees file ID on a synced record
2. Calls `fileStore.get(fileId)` or `useFile(fileId)` — loads from local cache
   or downloads + decrypts
3. For proactive download: app can prefetch files when records arrive via WebSocket

### Delete

1. App deletes the record → CRDT tombstone syncs to server and other clients
2. **Server**: sees tombstone, deletes all files bound to that record ID
3. **Client**: sees tombstone, evicts associated files from local cache

The app knows which file IDs to evict because it knows its own record shape
(e.g. `photo.thumbnailId` and `photo.fullResId`). No schema introspection needed.

## Design Constraints

- **One record owns many files** — a record can reference multiple file IDs
  (thumbnail + full-res, multiple attachments, etc.)
- **Every file has exactly one owner** — prevents orphans by construction
- **Upload requires record ID** — server rejects uploads without a record binding
- **File ID ≠ record ID** — they're independent; a record stores file IDs as
  fields

## Changes Required

### Server (`less-sync`)

- [ ] **File upload endpoint**: require `recordId` param (header or path),
      store the file→record association in the database
- [ ] **File table schema**: add `record_id` column, index on it
- [ ] **Tombstone handler**: when processing a tombstoned record, delete all
      files associated with that record ID (and their DEKs)
- [ ] **File download/head**: no changes needed (files are still addressed by
      file ID)

### TypeScript client (`@betterbase/sdk/sync`)

- [ ] **FilesClient.upload()**: add `recordId` parameter, send it with the
      upload request
- [ ] **FileStore.put()**: accept `recordId`, pass through to FilesClient
- [ ] **FileStore — tombstone eviction**: wire up a callback or listener so
      that when the app detects a tombstoned record, it can evict the
      associated files (could be a helper like
      `fileStore.evictForRecord(fileIds)`)

### React integration (`@betterbase/sdk/sync/react`)

- [ ] **useFile()**: no changes (still takes a file ID)
- [ ] **Eviction wiring**: consider a hook or pattern for apps to connect
      record deletion to file eviction (e.g. `useEffect` that watches for
      tombstoned records and calls `evict()`)

### Documentation / examples

- [ ] Document the record-owned file pattern in README or FEDERATION.md
- [ ] Update example app (if any) to show file upload with record binding
