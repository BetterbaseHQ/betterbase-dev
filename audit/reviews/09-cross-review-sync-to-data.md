# Independent cross-review: sync reviewer → local data

2026-09-20. SDK baseline `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`; json-joy-rs baseline `2dea0bd9669f53ce0007225fe80d55a9a1525924`. Reviewed `02-local-data.md` B-01–B-05 independently against source, and followed browser initialization/VFS/failover entry points. Analysis only: no product changes, harness executions, malformed-input executions, browser termination experiments, or tests run by this cross-reviewer. Existing test source was inspected; execution results belong to the central baseline runner.

## Decisions

| Item | Independent conclusion | Required qualification |
|---|---|---|
| B-01 | Confirm configuration contradicts claimed crash bound | Browser corruption not runtime-reproduced here; VFS flush is not a recoverable rollback journal |
| B-02 | Confirm actor identity loses high bits in binary representation | Do not label general downstream CRDT data corruption demonstrated |
| B-03 | Confirm metadata-only edit can be cleaned by older ACK, including actual space routing metadata | Normal `moveToSpace` creates a new record, so do not claim every supported move loses data |
| B-04 | Confirm native interleaving, with **stronger scope than original report** | Original counterevidence that explicit transaction retains the native mutex is false |
| B-05 | Confirm count-driven decoder expansion and absent EOF failure | Byte size limit is not decoded resource limit; do not label unauthenticated network reachability demonstrated |

## B-01: persistent database and journal semantics

`betterbase/crates/betterbase-db-wasm/src/adapter.rs:57–85` creates the persistent OPFS SAH pool with `clear_on_init: false`. `wasm_sqlite_backend.rs:130–151` explicitly sets `journal_mode=MEMORY`, and lines 135–138 claim at most the in-flight write is lost on browser crash. The source offers no mechanism supporting that bound. The VFS writes directly to the access handle (`betterbase/crates/sqlite-wasm-vfs/src/sahpool.rs:570–584`) and flushes it (`:594–597`); its device characteristics advertise only `SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN` (`:676–679`), not an atomic whole-database commit. Nothing in these entry points persists the MEMORY rollback journal. Graceful worker close closes SQLite and releases access handles (`js/src/db/opfs/OpfsWorkerHost.ts:225–240`); that is useful handoff hygiene but is not crash recovery.

Agree with B-01's configuration-level finding and rejection of the code comment's bound. The SQLite documentation cited in B-01 supplies the documented MEMORY-journal risk; this cross-review did not independently execute the reported native experiment or a browser crash test. Native WAL settings (`storage/sqlite.rs:97–99`) remain a different configuration. No claim of full VFS callback/unsafe-code verification is made.

## B-02: representational mismatch is proved; history corruption is not

The SDK actor generator reads a little-endian `u64` from eight UUID bytes and ORs in the minimum bit (`crdt/mod.rs:25–30`); validation imposes only a lower bound (`:33–35`). There is no maximum compatible with the encoder. The model clock table writes each SID using `vu57` (`json-joy-rs/crates/json-joy/src/json_crdt/codec/structural/binary.rs:89–97`). Its final byte is `(num >> 49) as u8` (`json_crdt_patch/util/binary/crdt_writer.rs:158–170`); the reader reconstructs at most 57 bits (`crdt_reader.rs:129–137`). Higher bits are discarded, not rejected. This is a direct representation defect independent of the previously reported experiment.

The SDK reload then forks the decoded clock back to the supplied full-width actor (`crdt/mod.rs:132–139`). That does not repair historical timestamp identities already encoded with fewer bits. Nevertheless, identical truncation on some paths can preserve the visible document and ordinary tests can pass. Neither a lost-edit history, a collision between two generated actors, nor a cross-language corruption sequence was established by this review. Retain Medium for the confirmed defect and treat stronger consequences as work to characterize. JavaScript numeric-range compatibility requires an explicit upstream contract review rather than assuming all 57-bit values are safe JS integers.

## B-03: actual routing reachability and sequential ACK schedule

The primitive is confirmed: metadata-only updates set `dirty=true` without appending a patch (`storage/record_manager.rs:276–298`), while the ACK guard checks only whether patch byte length grew or deletion state changed (`:579–600`). A snapshot, metadata-only update, then ACK can set `dirty=false` and the older sequence while retaining newer metadata. No concurrent native threads are needed.

The browser sync path actually takes exactly that two-field snapshot (`js/src/db/sync/sync-manager.ts:238–255`), awaits the network (`:265`), then acknowledges by record ID (`:279–292`). User writes can execute between those asynchronous stages. The spaces middleware maps write options to `meta.spaceId` (`js/src/sync/spaces-middleware.ts:128–135`); `TypedAdapter.patch` passes its resolved metadata into the underlying database (`js/src/db/middleware/typed-adapter.ts:150–157,345–362`). `WSTransport.push` groups outgoing records by that metadata (`js/src/sync/ws-transport.ts:238–246`). Thus routing metadata is a concrete affected consumer, not an invented generic metadata use.

Qualification: the ordinary `moveToSpace` helper copies to a new ID and tombstones the old record (`js/src/sync/move-to-space.ts:90–106`); B-03 must not be described as proving that helper always loses a move. The JS spaces middleware also defines `shouldResetSyncState` (`:152–155`), but the inspected TypeScript `TypedAdapter` does not forward that callback. Do not rely on its Rust reset branch being called by this particular browser wrapper. B-03 still holds when metadata changes without that reset.

## B-04: native transaction counterevidence rejected

Confirm `Adapter::patch` separately reads and replaces a record (`storage/adapter.rs:651–684`); `mark_synced` does the same (`:959–967`). Native backend `get_raw` and `put_raw` acquire independent mutex guards (`storage/sqlite.rs:474–503`). Both methods can act on stale snapshots when called concurrently. `StorageBackend` expressly requires `Send + Sync` (`storage/traits.rs:26–27`), so native shared use is a relevant public boundary.

**Correction to B-04:** although the native backend comment says a reentrant mutex permits a transaction to hold its guard, `SqliteBackend::transaction` does not retain it across the closure. The SAVEPOINT guard's block ends at `storage/sqlite.rs:705`, before `f(self)` at `:707`; RELEASE and ROLLBACK reacquire separately (`:709–734`). Therefore the explicit transaction in `Adapter::apply_remote_changes` (`storage/adapter.rs:983`) is not evidence that other native threads are excluded from its connection. Besides stale read/modify/write, another thread's successful write can execute within the first thread's savepoint and be rolled back when that transaction fails. Savepoint names are generated by a thread-local counter (`sqlite.rs:690–697`), also insufficient as a connection-wide uniqueness scheme under concurrent threads. These are source-derived schedules, not executed threaded reproductions.

Browser qualification remains essential: `OpfsWorkerHost` dispatches ordinary CRUD and ACK synchronously into WASM (`js/src/db/opfs/OpfsWorkerHost.ts:25–38,73–90,123–136`). Followers route to the leader's single worker, and Web Locks elect one owner (`leader-election.ts:35–80`). The native multi-thread interleaving above is not thereby proved in the normal browser path. This serialization does not eliminate B-03, whose interleaving lies between completed worker calls while network I/O is outstanding.

## B-05: exact allocation boundary

SDK `model_from_binary` checks only input byte length before calling the codec (`crdt/mod.rs:117–125`). The structural decoder accepts the server-clock variant by its leading flag (`json_crdt/codec/structural/binary.rs:459–477`), converts the decoded length to `usize` (`:581–585`), and iterates that count for a vector (`:651–671`). The vector loop itself treats absent input as zero and pushes `None` (`:660–664`), independently of the generic reader's analogous EOF behavior (`crdt_reader.rs:24–27`). No remaining-input check or decoded-element budget bounds this loop. Allocation grows incrementally through `Vec::push`; it need not be one eager `with_capacity` allocation to exceed a resource budget.

Reject any stronger characterization as a demonstrated unauthenticated remote crash. The relevant encrypted-sync sender must first meet cryptographic/access conditions; local imports or storage corruption are separate possible sources. No live denial of service, large allocation, or exact WASM trap threshold was tested. Byte-limit, empty-input and short-input tests in `crdt/mod.rs:358–385` do not assert expanded-size bounds. Recursion depth, other node families, integer narrowing on wasm32, and recovery after worker termination remain unverified.

## Additional browser lifecycle findings

### XR-01 — Pending auto-ID writes are replayed without deduplication after failover

**High for duplicate creation during ambiguous completion; source-confirmed schedule, not runtime-reproduced.** `RpcClient.replaceTransport` resends every pending request (`js/src/db/opfs/worker-rpc.ts:160–179`), and promotion/reconnection use it (`tab-coordinator.ts:181–186,221–226`). The existing mock test expressly expects a `put` to be replayed (`worker-rpc.test.ts:75–108`). `OpfsDb.put` sends the original data/options without preallocating an ID (`OpfsDb.ts:135–145`); the worker dispatches each request anew (`OpfsWorkerHost.ts:36–58,73–74`), and Rust autofill generates a new UUID for a missing key (`collection/autofill.rs:139–149`, generator `:16–18`; `record_manager.rs:136–149`). No durable request deduplication appears on these paths.

A leader can commit an auto-ID insert before its reply reaches the surviving follower. If leadership changes before that follower's pending call expires, replay executes a second insert with another ID; the caller learns only the second ID. Collections with a relevant uniqueness constraint can instead reject the retry after the first commit. The failure is uncertainty about an already committed write, not simultaneous worker mutation. Supplying a stable ID mitigates duplicate identity but does not establish general replay safety for other mutations. Existing handoff tests exercise graceful transitions and mock replay; none inspected deliberately separates commit from lost reply. This is an additional finding, not B-04 browser confirmation.

### XR-02 — Failed initialization can retain leadership without a usable database

**Medium availability defect by source; runtime handoff behavior unverified.** `TabCoordinator.create` acquires leadership, stores the release function, and awaits initialization without cleanup on rejection (`tab-coordinator.ts:71–84`). An initialization rejection prevents returning the caller's `close` function. The lock promise is deliberately held until its release function is called (`leader-election.ts:73–80`), leaving the same live page able to block later opens. The promoted-leader failure branch only logs (`tab-coordinator.ts:195–229`), retaining both leadership and `promoting=true`; automatic retry/release is absent there as well.

Failure sources are real interfaces, including OPFS install retries exhausting (`betterbase-db-wasm/src/adapter.rs:83–109`) or collection initialization throwing (`js/src/db/opfs/init.ts:57–108`). Page termination releases browser-owned locks, and successful ordinary close invokes the release function (`tab-coordinator.ts:276–280`), limiting duration. No lock-leak or quota simulation was executed. Source coverage does not assert availability behavior of every browser when OPFS is unavailable.

## Coverage and limits

Inspected actor generation/model codec boundary, record metadata and ACK preparation, native backend CRUD/transaction locks, OPFS initialization/pragmas, SAH write/flush/device-characteristic entry points, typed routing middleware and move helper, worker RPC replay/dispatch, leader election and promotion/close, existing worker RPC replay tests, and browser multi-tab test structure. Confirmed graceful close releases handles before lock release; database names are constrained before constructing OPFS paths (`betterbase-db-wasm/src/adapter.rs:60–68`). These are useful protections, not evidence for abrupt-crash atomicity or exactly-once writes.

Not performed: VFS unsafe callback audit in full, browser/power-loss corruption experiments, native threaded schedules, malformed model execution, generated-ID history/property tests, live JS/Rust numeric parity, and multi-browser failover/quota/mixed-version initialization campaigns. This cross-review strengthens and narrows source conclusions; it does not convert source-confirmed schedules into runtime-verified findings.
