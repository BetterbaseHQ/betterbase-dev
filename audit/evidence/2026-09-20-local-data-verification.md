# Evidence: local data / CRDT verification (review B findings + XR-01/XR-02 re-check)

- Date / reviewer: 2026-09-20 / local-data verification agent (successor wave)
- Finding and invariant IDs: B-01 (INV-01/06), B-02 (INV-03), B-03 (INV-01), B-04 (INV-01/03), B-05 (INV-07), XR-01, XR-02
- Repository revisions / local patch: betterbase (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`, json-joy-rs `2dea0bd9669f53ce0007225fe80d55a9a1525924`; both `git status --porcelain` clean — no local patch. Harness path dependencies in `/tmp/betterbase-audit-data/Cargo.toml` resolve to these checkouts.
- Lockfile hashes / generated artifact provenance: `/tmp/betterbase-audit-data/Cargo.lock` (pre-existing from interrupted run; path deps, no registry substitution for `betterbase-db`/`json-joy`). Harnesses are the interrupted review B agent's, inspected before execution; no harness changes were needed.
- Tool versions / operating system / browser: Python 3.12.12 (sqlite3 stdlib, SQLite 3.50.4); rustc/cargo 1.98.1 (48a229cea 2026-09-01 / 797e8a9bc 2026-08-05); macOS (darwin). No browsers used.
- Non-secret configuration / isolated services: none; all runs are single-process local harnesses in `/tmp` with synthetic data. No docker, no dev/e2e services touched.
- Working directory and exact command or source-inspection method: `python3 /tmp/betterbase-audit-data/memory-journal-crash.py`; `cargo run --release` in `/tmp/betterbase-audit-data`; source inspection via direct file reads at the pinned revisions.

## Executed check 1 — B-01: interrupted transaction under `journal_mode=MEMORY` corrupts DB

- Expected behavior (per code comment `wasm_sqlite_backend.rs:135-138`): a browser crash mid-transaction loses "at most one in-flight write".
- Observed behavior: child process opens the DB, sets `PRAGMA journal_mode=MEMORY` (+ `synchronous=NORMAL`), issues `BEGIN; UPDATE ...` (no COMMIT), then hard-exits via `os._exit(17)`. On reopen, `PRAGMA integrity_check` reports structural corruption (invalid page numbers, out-of-order rowids across the previously committed table) and the subsequent row query fails outright. Committed rows are not merely "one write behind" — the database is malformed.
- Exit code / assertions: script exit 0; child exit 17 (deliberate).
- Result: **fail** (defect demonstrated).
- Sanitized output:

```
sqlite_version 3.50.4 child_exit 17
integrity [('*** in database main ***\nTree 2 page 524 cell 0: invalid page number 3428\nTree 2 page 490 cell 1: Rowid 975 out of order\nTree 2 page 524 cell 506: invalid page number 3423\n… [hundreds of similar entries] …',)]
reopen error database disk image is malformed
```

- Reproduction: 2000 committed rows; child reopens read-write, MEMORY journal, cache limited to 4 MB, one large uncommitted UPDATE spanning many pages, `os._exit` mid-transaction. Script self-cleans (`os.unlink`).
- Limits: **native SQLite via Python stdlib, not a Chromium/OPFS/SAH-pool crash.** It demonstrates SQLite's documented MEMORY-journal semantics (partial pages reach the db file; no on-disk rollback journal exists to restore them), which is the same engine configuration `wasm_sqlite_backend.rs:148` selects. Browser-crash behavior itself remains untested (no browser termination experiment, per constraints). `PRAGMA synchronous=NORMAL` matches the WASM backend's setting (`wasm_sqlite_backend.rs:149`).

## Executed check 2 — B-02: actor identity truncation through the structural codec

- Expected behavior: a valid SDK session ID survives `model_to_binary`/`model_from_binary`.
- Observed behavior: `create_model` with sid `(1u64<<63)+65536` = 9223372036854841344 (passes the SDK's lower-bound-only validation), encoded and decoded back as **65536**. The 57 bits above bit 56 are discarded by the codec.
- Exit code / assertions: exit 0; value assertion done by eye against printed output.
- Result: **fail** (defect demonstrated). Matches the reviewer-reported value from `02-local-data.md` B-02 exactly.
- Sanitized output: `SID roundtrip: 9223372036854841344 -> 65536`

## Executed check 3 — B-03: old ACK clears a newer metadata-only change

- Expected behavior: an acknowledgement for an older snapshot must not mark a record with newer unsynced changes clean.
- Observed behavior: record created with meta `{"space":"A"}` → snapshot taken → metadata-only patch to meta `{"space":"B"}` (no CRDT patch appended) → `prepare_mark_synced` applied with the older snapshot. Result: `dirty=false`, `pending_patches` emptied, meta remains `{"space":"B"}`, and the ack's older `sequence` is written. The newer routing metadata will never be pushed.
- Result: **fail** (defect demonstrated at the record_manager primitive; sequential, no threads needed). This subsumes the optional task-3 harness — the executed sequence is exactly put → snapshot → metadata-only update → ack of older snapshot → assert dirty.
- Sanitized output: `metadata ack: meta={"space":"B"} dirty=false pending=0`

## Executed check 4 — B-05: count-driven decoder expands tiny malformed input

- Expected behavior: decoding should reject input whose declared structure exceeds available bytes.
- Observed behavior: a 7-byte server-format model (root vector declaring 100000 elements, no element payload) decodes successfully to a vector with 100000 slots (missing payload becomes `None`/null elements via the EOF→0 peek path).
- Result: **fail** (defect demonstrated). No decoded-size/element bound exists anywhere on the path (see source verification below).
- Sanitized output: `malformed vector: 7 input bytes -> 100000 output slots`
- Limits: small-count demonstration only; no large-allocation/DoS measurement, no live client, no wasm32 trap threshold. Remote reachability requires passing the encrypted-transport auth boundary first (member/imported-data/corrupt-storage entry points).

Combined run (checks 2–4, one binary, `cargo run --release`, 15.77s build, 2 unused-import warnings only):

```
SID roundtrip: 9223372036854841344 -> 65536
metadata ack: meta={"space":"B"} dirty=false pending=0
malformed vector: 7 input bytes -> 100000 output slots
```

## Source re-verification (all at pinned revisions)

### B-01 — MEMORY journal on the persistent OPFS database

- `betterbase/crates/betterbase-db-wasm/src/wasm_sqlite_backend.rs:130-151`: `PRAGMA journal_mode=MEMORY` for the persistent OPFS database; comment claims "at most one in-flight write is lost" on browser crash. No mechanism in the tree supports that bound.
- Contrast: native `betterbase/crates/betterbase-db/src/storage/sqlite.rs:96-99` uses `PRAGMA journal_mode=WAL` — a different configuration that must not be conflated with the WASM one.
- 09's VFS confirmation re-verified: `betterbase/crates/sqlite-wasm-vfs/src/sahpool.rs:570-584` writes directly to the sync access handle; `:594-598` flushes it; `:676-680` `xDeviceCharacteristics` advertises only `SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN` — no atomic-commit capability. Nothing persists a rollback journal. **Confirmed.**

### B-02 — representation chain

- `crdt/mod.rs:25-31`: 8 UUID bytes little-endian OR `MIN_SESSION_ID` (65536) — full 64-bit range possible; `:34-36` validates only `sid >= 65536` (no encoder-compatible upper bound).
- `crdt_writer.rs:158-170` (json-joy-rs): 8-byte `vu57` branch's final byte is `(num >> 49) as u8` — bits 57-63 silently dropped. `crdt_reader.rs:129-137`: reconstruction max is 57 bits.
- `crdt/mod.rs:132-139`: `model_load` forks the decoded clock back to the caller's full-width sid — future writes are fine, already-encoded history identities are not repaired. **Confirmed (representation defect; downstream history corruption still uncharacterized, per 09's qualification).**

### B-03 — guard + browser schedule + qualifications

- `storage/record_manager.rs:276-299`: metadata-only change → `dirty=true`, no patch appended. Escape hatch exists (`should_reset_sync_state`, `:284-292`) but only when the caller supplies the callback.
- `storage/record_manager.rs:579-602`: TOCTOU guard = `pending_patches.len() > snap.pending_patches_length || deleted != snap.deleted` only; ack `sequence` written unconditionally (`:593`). Metadata changes defeat the guard.
- Browser schedule: `js/src/db/sync/sync-manager.ts:238-255` snapshots exactly the two guard fields, `:265` awaits network, `:279-292` acks by record ID — user writes interleave across those awaits.
- Routing is a real consumer: `js/src/sync/spaces-middleware.ts:128-136` maps write options to `meta.spaceId`; `js/src/sync/ws-transport.ts:239-249` groups outbound records by `meta.spaceId`; `js/src/db/middleware/typed-adapter.ts:150-157,334-358` forwards middleware-resolved `meta` into the engine but does **not** forward `shouldResetSyncState` (verified: `resolveWriteOptions` spreads engine fields and meta only) — so the Rust reset branch is unreachable from this wrapper. **Confirmed.**
- Qualification (verified): `js/src/sync/move-to-space.ts:90-106` — normal `moveToSpace` copies to a new record (new ID) and tombstones the old; B-03 must not be described as breaking that helper per se. B-03 holds for metadata-only changes routed through the middleware/TypedAdapter path.

### B-04 — native read/modify/write without an encompassing lock

- `storage/adapter.rs:651-684`: `patch` = `get_raw` (651) … `put_raw` (684), no encompassing transaction. `:959-967`: `mark_synced` = same shape. `:983`: `apply_remote_changes` wraps in `backend.transaction`.
- `storage/sqlite.rs:474-504`: `get_raw`/`put_raw` each take independent `ReentrantMutex` guards per call.
- **09's correction verified against the code**: `storage/sqlite.rs:683-737` — the SAVEPOINT guard's block ends at `:705`; `f(self)` runs at `:707` **without** holding the mutex; RELEASE/ROLLBACK reacquire separately (`:709-714`, `:730-733`). The comment at `:689` ("ReentrantMutex lets the closure re-acquire the lock for its SQL calls") describes per-call re-acquisition, not cross-closure exclusion. Therefore even explicit transactions do not exclude other native threads from the connection; another thread's successful write inside a failing savepoint's window is rolled back with it. Savepoint names come from a thread-local counter (`:690-697`) — not connection-wide unique under concurrency.
- `storage/traits.rs:26-27`: `StorageBackend: Send + Sync` — shared native use is a supported public boundary. **Confirmed, with 09's widened scope (transaction counterevidence rejected).** Browser path remains serialized by the single worker (not a native-thread proof); no threaded reproduction executed.

### B-05 — decoder bounds

- `json_crdt/codec/structural/binary.rs:459-462`: only check is empty input; `:581-585`: `length` = minor nibble or `vu57 as usize`; `:660-664`: past-input peek yields 0 → `None` element pushed, loop continues to the declared count. `crdt_reader.rs:24-28`: `u8()` returns 0 past input instead of erroring.
- `crdt/mod.rs:117-125`: SDK precheck is input byte length only (≤10 MB); nothing bounds decoded elements/work. **Confirmed.**

### XR-01 — pending auto-ID writes replayed without dedup after failover

- `js/src/db/opfs/worker-rpc.ts:166-180`: `replaceTransport` re-sends every pending request (`this.transport.send(entry.request)`) — no dedup key/idempotency token anywhere on the path.
- `js/src/db/opfs/worker-rpc.test.ts:75-109`: existing test "replays all pending requests on new transport" explicitly asserts a `put` is among the replayed calls — replay is intended behavior, not accidental.
- `js/src/db/opfs/tab-coordinator.ts:176-192` (reconnect) and `:205-226` (promotion, after worker reopen) both swap transports via `replaceTransport`.
- `js/src/db/opfs/OpfsDb.ts:135-145`: `put` sends `(name, data, options)` with no preallocated ID; `OpfsWorkerHost.ts:36-74` dispatches each request fresh into WASM.
- `collection/autofill.rs:16-19` + `:138-149`, `storage/record_manager.rs:136-149`: missing key → `generate_uuid()` → fresh UUID v4 per dispatch. **Confirmed:** replay after ambiguous commit inserts a second record with a new ID; caller learns only the second ID. Source-confirmed schedule; not runtime-reproduced (would need worker failover simulation).

### XR-02 — failed init can retain leadership without a usable database

- `js/src/db/opfs/tab-coordinator.ts:63-86`: `create` stores `electionRelease` then awaits init; on rejection the caller never receives the `close` function that releases it. `js/src/db/opfs/leader-election.ts:73-81`: lock held via never-resolving promise until release. `tab-coordinator.ts:195-229`: promoted-leader failure branch only logs (retains leadership + `promoting=true`).
- Mitigants verified: successful `close()` releases the lock (`tab-coordinator.ts:276-280`); page termination drops browser-owned locks. Failure sources are real (e.g. `betterbase-db-wasm/src/adapter.rs:83-113` OPFS install retries exhausting after 5 attempts → error). **Confirmed at source level; no lock-leak simulation executed.**

## Verdict summary

| ID | Verdict | Basis |
|---|---|---|
| B-01 | Confirmed (native-harness + source) | Executed check 1 + pragma/comment/VFS chain re-verified; browser crash not runtime-tested |
| B-02 | Confirmed (executed) | Check 2 reproduces reviewer-reported truncation value exactly |
| B-03 | Confirmed (executed primitive + source schedule) | Check 3 + guard/browser chain; moveToSpace qualification stands |
| B-04 | Confirmed, scope widened per 09 (source) | 09's transaction correction verified at `sqlite.rs:699-707`; no threaded repro |
| B-05 | Confirmed (executed + source) | Check 4; no decoded-size bound anywhere on the path |
| XR-01 | Confirmed (source; existing test expects replay) | Full chain re-verified incl. `worker-rpc.test.ts` |
| XR-02 | Confirmed (source-only) | Core lifecycle chain re-verified; no runtime simulation |

- Seed / schedule / reproduction steps: deterministic; harnesses preserved as-is in `/tmp/betterbase-audit-data/` (`memory-journal-crash.py`, `Cargo.toml`, `src/main.rs`).
- Limits: native SQLite stands in for the browser engine (B-01); no browser/OPFS crash test, no native threaded interleaving (B-04), no large-allocation/DoS measurement (B-05), no worker-failover runtime (XR-01), no lock-leak simulation (XR-02). Recursion depth, wasm32 `usize` narrowing, and other count-driven node families (`str`/`bin`/`arr`/`obj` lengths) noted but not individually exercised. No product code was modified; no workspace test suites, browsers, or docker services were used.
