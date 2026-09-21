# Cross-review: identity reviewer checks sync findings

- Reviewer: identity/key review agent, independent second pass on C-01, C-02, C-03 and C-09.
- Date: 2026-09-20.
- Baselines independently checked: sync `324da35e30922dfd3ab53c2fb862e7272b2e72f1`; SDK `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`.
- Method: read [sync review](03-sync.md), then trace actual server/client source looking for checks that defeat or narrow each claimed failure. No product edits, new test harnesses, network requests or runtime exploit testing.
- Status: source cross-review complete; all four mechanisms confirmed, with reachability/impact qualifications below. This is not runtime verification.

| Candidate | Independent conclusion | Severity assessment |
| --- | --- | --- |
| C-01 | Confirmed for retained local subscriptions; future record contents can be decrypted using a retained prior key. | High confidentiality, release blocking. Critical may be justified by product guarantees, but scope is an already-authorized removed member and a bounded retained connection. |
| C-02 | Confirmed: transport-owned space cursor precedes application commit; partial/decrypt-failed batches can be silently skipped. | High durability/divergence. Full resync may recover server-held data. |
| C-03 | Confirmed missing ciphertext/DEK compare-and-set; standard SDK trigger is currently masked by C-09. | High integrity/decryptability; remediate with C-09. |
| C-09 | Confirmed ordinary-result/chunked-client mismatch returns empty arrays successfully. Existing in-memory base keys can hide its effects until restart. | High availability/recovery; successful epoch completion is not proof of actual rewrap. |

## C-01: revoked subscription and forward-derived replacement key

The server revocation handler authorizes the caller, stores the revoked CID, broadcasts a generic notification, then returns success. It does not identify/remove affected subscribers ([membership_revoke.rs:73](../../betterbase-sync/crates/api/src/ws/rpc/membership_revoke.rs#L73)). `broadcast_revocation` delegates to normal space broadcast ([realtime.rs:193](../../betterbase-sync/crates/api/src/ws/realtime.rs#L193)); the broker checks only closed/failed subscribers and sender exclusion ([multi.rs:157](../../betterbase-sync/crates/realtime/src/broker/multi.rs#L157)). The outbound subscriber holds an outbound channel/closed flag rather than a revocable UCAN authorization object ([realtime.rs:291](../../betterbase-sync/crates/api/src/ws/realtime.rs#L291)).

Actual ordinary-push notifications include the ciphertext and wrapped DEK ([push_helpers.rs:30](../../betterbase-sync/crates/api/src/ws/rpc/push_helpers.rs#L30)). They are not merely invalidation signals requiring a later authorized pull. That distinction makes this a confidentiality issue even if every new pull correctly rejects the revoked UCAN.

The removal path derives `newKey` from `currentKey` through `deriveForward` ([space-manager.ts:814](../../betterbase/js/src/sync/space-manager.ts#L814)); the derivation uses public space ID/epoch information. Later transport encryption uses fresh record DEKs but wraps them under the forward-derived epoch key ([transport.ts:800](../../betterbase/js/src/sync/transport.ts#L800)). A recipient holding the previous epoch key therefore possesses everything needed to unwrap the future DEK and decrypt a newly broadcast record. No fresh secret supplied only to remaining members appears in this path.

**Counterevidence tested against the argument:**

- Normal request authorization and stock-client revocation cleanup do not close the server subscription of a recipient-controlled client.
- Existing ciphertext and wrapped DEKs may remain at the old epoch because of C-09. That does not prevent this finding: new writes still use an old known key or the publicly derivable new key. The established failure is future content, not solely historical ciphertext retention.
- The retained connection is bounded by `WS_MAX_LIFETIME = 1 hour` ([ws/mod.rs:22](../../betterbase-sync/crates/api/src/ws/mod.rs#L22)) with ±10% jitter ([ws/mod.rs:482](../../betterbase-sync/crates/api/src/ws/mod.rs#L482)). State the direct exposure as the connection's remaining lifetime, at most approximately 66 minutes; do not claim indefinite local-socket authorization.
- Backpressure can remove a slow subscriber, but a client consuming messages normally remains eligible. Sender exclusion does not exclude a different member's connection.
- Federation reconnect authorization may extend exposure, but this pass does not verify that extension and does not use it to justify severity.

**Recommendation to register:** retain C-01 as confirmed by source, high confidentiality. Both server subscription revocation and fresh member-excluding rekey semantics need correction; either alone leaves part of the promised revocation boundary unproved.

## C-09: DEK RPC results are silently ignored by the chunked client

The server's `deks.get` emits a single result `{ deks: [...] }` ([deks.rs:50](../../betterbase-sync/crates/api/src/ws/rpc/deks.rs#L50)); `deks.getFiles` likewise emits an ordinary result ([deks.rs:191](../../betterbase-sync/crates/api/src/ws/rpc/deks.rs#L191)). The dispatcher routes the expected method names to these handlers, including the file alias.

The SDK builds empty arrays and populates them only from `deks.record`/`deks.files.record` chunks ([ws-client.ts:312](../../betterbase/js/src/sync/ws-client.ts#L312)). `RpcConnection.callChunked` explicitly wraps resolution as `resolve: () => resolve()` and returns `Promise<void>` ([rpc-connection.ts:148](../../betterbase/js/src/sync/rpc-connection.ts#L148)). When the ordinary result arrives, `handleResponse` checks `_chunks` only if it is a number; absent `_chunks` is accepted, and the result resolves normally ([rpc-connection.ts:329](../../betterbase/js/src/sync/rpc-connection.ts#L329)). Thus the actual behavior is **successful empty DEK arrays**, not a timeout or protocol rejection.

`rewrapAllDEKs` skips updates when the returned arrays are empty and returns zero counts ([reencrypt.ts:159](../../betterbase/js/src/sync/reencrypt.ts#L159)). The removal path does not demand a verified count before `epochComplete` ([space-manager.ts:883](../../betterbase/js/src/sync/space-manager.ts#L883)); storage completion merely clears the matching rotation marker without checking wrapper generations ([epochs.rs:58](../../betterbase-sync/crates/storage/src/postgres/epochs.rs#L58)). This can report completed rotation while old wrappers remain unchanged.

**Impact qualifications:**

- Required scopes still matter: with default `includeFiles=true`, a token lacking `files` can instead fail the file-DEK RPC. The successful-empty path assumes the caller has the required scopes (or has disabled file inclusion where supported). It is not contingent on missing authorization checks.
- An existing WSTransport deliberately retains its defensive copy of the old base key and only updates its encryption epoch ([ws-transport.ts:526](../../betterbase/js/src/sync/ws-transport.ts#L526)). Such a session may keep decrypting old wrappers, masking the failure.
- SpaceManager nevertheless replaces the persisted shared-space key with the new key ([space-manager.ts:1530](../../betterbase/js/src/sync/space-manager.ts#L1530)). A new shared transport uses that current persisted key/epoch ([ws-transport.ts:549](../../betterbase/js/src/sync/ws-transport.ts#L549)); `getKEKForEpoch` rejects a wrapper epoch below its base ([transport.ts:856](../../betterbase/js/src/sync/transport.ts#L856)). Restart/new transport or a newly introduced device can therefore reveal undecryptable older records/files. Retained old device keys/local plaintext may offer recovery, so do not assert inevitable permanent data loss.
- The current SDK unit test mocks chunk responses, unlike the actual server, and asserts only record IDs ([ws-client.test.ts:284](../../betterbase/js/src/sync/ws-client.test.ts#L284)). It is not counterevidence for interoperability; the fixture even uses `wrapped_dek` rather than the client's `dek` property without detecting that difference.

**Recommendation to register:** confirmed high protocol/recovery defect. Add a real server/client response-contract test and fresh-transport read-after-rotation test; handle C-03 before relying on the repaired DEK retrieval path.

## C-03: the rewrap transaction cannot protect an earlier client-side read

The rewrapper obtains `(record ID, wrapped DEK)`, unwraps/re-wraps locally, and sends only `{id, dek}` ([reencrypt.ts:159](../../betterbase/js/src/sync/reencrypt.ts#L159)). The RPC decoder constructs a storage `DekRecord` with cursor zero; it carries no compare value ([deks.rs:370](../../betterbase-sync/crates/api/src/ws/rpc/deks.rs#L370)). Storage locks the space and checks the submitted epoch, but updates the wrapper using only record/space identity ([epochs.rs:111](../../betterbase-sync/crates/storage/src/postgres/epochs.rs#L111)).

A legal schedule is: rewrapper reads D1/C1; a valid writer replaces the record with C2 and fresh D2; rewrapper updates the stored wrapper to D1 under the new epoch. `push`'s record-cursor CAS and transactional blob+wrapper update are genuine protections ([records.rs:282](../../betterbase-sync/crates/storage/src/postgres/records.rs#L282)); they do not help because the later rewrap does not compare the ciphertext generation. Its space lock begins after the earlier client read. Epoch matching likewise cannot distinguish two versions of a record within one epoch.

The result is C2 paired with the wrong DEK. AEAD should reject decryption; it does not restore the correct wrapper. Another device's local plaintext/key may recover the record, so this is loss of server-side decryptability rather than a proven destruction of every replica.

**Reachability adjustment:** the current stock WSClient returns no DEKs because of C-09, so it does not reach this rewrap update in the ordinary SDK path. A client correctly reading the existing server result can exercise it, and fixing C-09 exposes it immediately. Keep the finding but explicitly label that masking condition. The issue is a legitimate concurrent-write correctness failure; it does not require a malicious writer or bypassed record CAS. This pass does not generalize the race to immutable file contents.

## C-02: cursor ownership precedes record application

After decrypting each space's changes, WSTransport calls `setCursor` before returning records ([ws-transport.ts:355](../../betterbase/js/src/sync/ws-transport.ts#L355)). That setter updates the in-memory value immediately and starts asynchronous persistence ([ws-transport.ts:594](../../betterbase/js/src/sync/ws-transport.ts#L594)). SyncEngine's normal cursor store writes `spaceCursor:<key>` through the database ([sync-engine.ts:504](../../betterbase/js/src/sync/sync-engine.ts#L504)). Only after `transport.pull` returns does SyncManager call the local adapter's `applyRemoteChanges` ([sync-manager.ts:320](../../betterbase/js/src/db/sync/sync-manager.ts#L320)). No transaction includes both operations, and no rollback resets the transport cursor if application fails.

The durable-failure schedule therefore exists: space cursor commits; app stops or local apply fails; resume loads that cursor and skips unchanged remote rows. Even where cursor persistence has not completed, the already-advanced in-memory cursor makes an immediate retry incomplete. The awaited epoch/metadata work between cursor update and pull return can further widen that interval; no reliance on a particular browser microtask ordering is necessary.

The two companion source paths also hold:

1. Per-space transport returns decryption failures and the full space sequence ([transport.ts:449](../../betterbase/js/src/sync/transport.ts#L449)); WSTransport returns only successful records and the advanced sequence ([ws-transport.ts:431](../../betterbase/js/src/sync/ws-transport.ts#L431)). Failed ciphertext is not durably queued by this layer.
2. `pull.begin` places the advertised final cursor into WSClient results ([ws-client.ts:183](../../betterbase/js/src/sync/ws-client.ts#L183)); `pull.commit` validates a count when present but no state records whether it arrived. Server-side stream failure skips that commit and still emits the final overall result with the number of chunks actually sent ([handlers.rs:519](../../betterbase-sync/crates/api/src/ws/rpc/handlers.rs#L519)). Chunk-count validation therefore does not reject this partial-space result.

**Counterevidence/limits:** SyncManager avoids its own collection cursor update if apply throws, and realtime paths check errors before some cursor updates. Neither undoes the separate ordinary-pull space cursor. Successfully applying most records with per-record errors also advances the collection cursor. A full server rescan may recover data, so characterize the impact as ordinary resume permanently skipping work until explicit repair, not guaranteed deletion of server data.

**Recommendation to register:** confirmed high. One owner must decide and durably commit the applied frontier, or durably retain every unapplied record before advancing it. Collection and space cursors need an explicit coordinated contract, including incomplete streams and decryption failures.

## Review limits and handoff

No assigned finding was rejected. C-01 severity is narrowed to a specific retained-member/retained-connection confidentiality breach; C-03 stock-SDK reachability is qualified by C-09; C-09 impact is qualified by the old base key retained in memory and required file scope. These qualifications improve the claims without removing the defects.

All conclusions are source-only in this pass. Required later evidence includes a real server/client DEK exchange, permitted isolated revocation/read tests, a PostgreSQL concurrent-update rewrap test, and crash/application-failure tests around cursor commits. No finding is marked fixed or verified.
