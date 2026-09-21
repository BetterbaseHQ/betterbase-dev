# Local data and CRDT review

2026-09-20. Baselines: SDK `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`; json-joy-rs `2dea0bd9669f53ce0007225fe80d55a9a1525924`. Analysis only; no product changes. Review B's run was interrupted by an automated security check before it wrote its report. The coordinator recovered its observations, inspected the cited source and temporary harness, and records the distinction between source validation and reviewer-reported execution below.

## Coverage

Reviewed the SDK's CRDT bridge and actor generation, record preparation/acknowledgement, native storage locking/transactions, browser SQLite pragmas, structural binary decoder/reader, and browser multi-tab test architecture. Inspected the parity inventory, native database tests, OPFS persistence/dirty-state/multi-tab tests and existing schema/migration paths. Executed native SDK/json-joy workspace tests and existing Chromium/WASM tests through the central baseline runner.

The entire json-joy port is much larger than the paths Betterbase uses. Passing its workspace/parity fixtures is recorded; this review does not claim line-by-line verification of every auxiliary codec/tree/query implementation. Vendored VFS unsafe callbacks, mixed-version migration schedules, full Unicode differential campaigns, model checking, and fuzzing remain explicit assurance gaps.

## B-01 — Persistent browser database uses a volatile rollback journal

**High; confirmed configuration defect against crash-durability expectations. INV-01/06.**

`betterbase/crates/betterbase-db-wasm/src/wasm_sqlite_backend.rs:131–151` selects `journal_mode=MEMORY` for the OPFS database. The explanatory comment says a browser crash loses at most an in-flight write. That bound is unsupported: modified database pages can reach the persistent file while their rollback journal exists only in RAM. An interrupted transaction can therefore corrupt the database, including previously committed offline data. [SQLite's journal-mode documentation](https://www.sqlite.org/pragma.html#pragma_journal_mode) explicitly identifies this corruption risk for MEMORY journaling.

Counterevidence: normal close/reopen persistence tests and worker serialization are useful, but do not make a volatile journal recoverable after abrupt termination. Server sync cannot recover edits that have never reached the server. Native `SqliteBackend` instead uses WAL (`storage/sqlite.rs:97`), so the configurations must not be conflated.

The reviewer reported a malformed-database result from an isolated native SQLite crash experiment in `/tmp/betterbase-audit-data/memory-journal-crash.py`. The coordinator did not repeat that experiment, and it is not a Chromium/OPFS crash reproduction. Finding confidence rests on the actual pragma plus SQLite's documented semantics; exact browser crash behavior remains untested.

## B-02 — Generated actor IDs exceed the binary codec's representable range

**Medium confirmed representation defect; high-impact downstream corruption remains to be characterized. INV-03.**

`betterbase/crates/betterbase-db/src/crdt/mod.rs:25–35` generates a `u64` actor from eight UUID bytes and checks only a lower bound. `json-joy-rs/crates/json-joy/src/json_crdt_patch/util/binary/crdt_writer.rs:104–175` implements a maximum 57-bit integer; the eight-byte branch discards higher bits. The corresponding reader (`crdt_reader.rs:85–137`) reconstructs only those 57 bits. The structural codec serializes session IDs through this representation.

Consequently a valid SDK actor is not necessarily preserved by a model binary round trip. The reviewer reported `9223372036854841344 → 65536` using actual `create_model`, `model_to_binary`, and `model_from_binary`; the coordinator inspected that temporary harness but did not rerun it. `model_load` subsequently forks back to the caller's original actor (`crdt/mod.rs:135–143`), making normalization across histories important.

Limits: this proves identity truncation, not that every ordinary edit is lost. Some paths consistently encode/decode the truncated identity and all current baseline tests pass. Further deterministic history/replay and JS interoperability tests must establish the exact affected schedules before making broader claims. The generated range also needs review against the JS counterpart's safe-integer requirements.

## B-03 — Acknowledgement guard misses metadata-only changes

**High for affected routing/sync metadata; confirmed by source. INV-01.**

`storage/record_manager.rs:276–296` treats metadata-only changes as dirty without appending a CRDT patch. `prepare_mark_synced` (`:579–605`) keeps the record dirty only if pending-patch length grew or the deleted flag changed. An old in-flight acknowledgement can therefore clear a newer metadata-only change, including metadata used for routing. It also writes the old acknowledgement's sequence.

The reviewer reported that a prepared metadata change A→B was left with `dirty=false` and zero pending bytes after applying the old snapshot acknowledgement. The coordinator inspected the harness and both source branches. This is a sequential snapshot-order defect and does not require simultaneous native threads. Actual cross-space workflows may add further operations; their complete behavior is reviewed separately rather than inferred from this primitive alone.

## B-04 — Native read/modify/write operations lack an encompassing lock/transaction

**High for concurrent native callers; source-confirmed interleaving. INV-01/03.**

Single-record `put`, `patch`, `delete`, and `mark_synced` in `storage/adapter.rs` perform separate backend reads and writes; see patch around `:650–690` and acknowledgement `:950–969`. `storage/sqlite.rs` protects individual calls with a reentrant mutex, but only its explicit `transaction` holds that lock across multiple operations. Two native callers can both read a record, independently prepare updates, and overwrite each other. Acknowledgement can similarly overwrite a newer raw record after reading an older one.

Counterevidence: bulk operations and `apply_remote_changes` (`adapter.rs:982`) use explicit transactions. Browser worker/Web Lock serialization constrains this race in the usual browser path. This finding applies to concurrent native access through the public adapter; a production browser occurrence was not established. No threaded reproduction was completed.

## B-05 — Structural decoder trusts declared counts beyond available input

**High resource/integrity risk for malformed imported or decrypted models; source-confirmed. INV-07.**

`json_crdt/codec/structural/binary.rs:651–671` allocates/iterates vector elements based on a decoded count. `json_crdt_patch/util/binary/crdt_reader.rs` returns zero from `u8` beyond input instead of propagating an EOF error. Missing vector payload can therefore become null elements, while an input-size cap in the SDK (`crdt/mod.rs:120–128`) does not bound decoded allocations or work. Similar count/depth consumers need systematic bounds review.

The reviewer reported that a tiny malformed model was accepted as a much larger vector in its isolated harness; no large allocation or live-client denial-of-service test was run. A remote unauthenticated sender does not automatically reach this decoder: encrypted transport must authenticate first. A member able to submit encrypted models, imported data, and corrupted local storage are relevant entry points.

## Architecture and remaining evidence

The separation of pure CRDT/record preparation from browser and native backends makes targeted verification feasible. However, the guarantees differ across those backends, and duplicated sync orchestration plus weak snapshot tokens leave correctness dependent on caller scheduling. Coordinate B-03/B-04 with sync findings about early cursors, partial apply and retry state.

No behavior changes or remediations were made. Existing tests passing is evidence for their asserted examples, not for abrupt browser crashes, arbitrary schedules, malformed input bounds, or all parity-sensitive public surfaces. These gaps remain in the final assurance register.
