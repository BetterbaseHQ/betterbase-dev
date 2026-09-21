# Evidence: sync findings C-04/C-08/C-10/C-12/C-13/C-14/C-15/C-16/C-17 independent re-verification (wave 2)

- Date / reviewer: 2026-09-20 / sync verification agent (wave 2).
- Finding and invariant IDs: C-04, C-08, C-10, C-12, C-13, C-14, C-15, C-16, C-17 from `reviews/03-sync.md` (INV-02..INV-07 as cited there).
- Repository revisions / local patch: `betterbase-sync` `324da35e30922dfd3ab53c2fb862e7272b2e72f1`, `betterbase` (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`. `git rev-parse HEAD` re-checked and `git status --porcelain` empty for both at review time; no product code touched.
- Lockfile hashes / generated artifact provenance: none — no artifacts generated; source-only verification (appropriate per assignment: no finding needs execution).
- Tool versions / operating system / browser: ripgrep 14.x via targeted `rg`, file reads at pinned HEADs, macOS (darwin). No browser, no Node harness this wave.
- Non-secret configuration / isolated services: none. No docker, no database, no network, no test suites, no running services touched.
- Working directory and exact command or source-inspection method: workspace root `/Users/nchapman/Code/betterbase-dev`; targeted reads of the files listed per finding below at the pinned HEADs; repo-wide `rg` sweeps for C-16 (object-deletion call sites) and status-transition enumeration for C-13.

## Expected behavior

- Each finding's claimed chain should be re-located end-to-end at the pinned revisions, with no defeating guard overlooked, and line refs corrected where drifted.

## Observed behavior (verdicts)

| Finding | Verdict | Basis |
| --- | --- | --- |
| C-04 | **Confirmed** (source) | Retry with existing object returns 204 before `record_file` is attempted; SDK treats 204 as success. |
| C-08 | **Confirmed** (source) | `TokenInfo`/`AuthContext` carry no expiry; WS deadline is fresh jittered [54,66) min; refresh is client-driven RPC. |
| C-10 | **Confirmed** (source) | Server append requires Write; Read UCAN fails attenuation; SDK accept/decline append first with the read-only invitee UCAN. |
| C-12 | **Confirmed** (source) | Server accepts arbitrary nonempty ≤128 KiB payloads; `decryptJwe` sits outside the only per-item guard; loop aborts, item retained. |
| C-13 | **Confirmed** (source) | `uploading` persisted before work; scan selects only `pending`/`error`; no reset path exists; eviction protects upload-status items. |
| C-14 | **Confirmed** (source) | Socket read only inside `call_raw` under mutex awaiting one response; notifications (frame type 2) → `Other` → discarded; no reader task; `SubscribeResult.errors` dropped. |
| C-15 | **Confirmed** (source), precondition explicit | Federation notifications rebroadcast to any peer-named space with no UCAN/subscription/home-authority check and no quota; requires an authenticated configured trusted peer. |
| C-16 | **Confirmed** (source) | `deleted_file_ids` produced but consumed by no handler; object-store trait is store/get only; repo-wide sweep finds no object deletion call site. |
| C-17 | **Confirmed** (source mismatch) | Outgoing signs full `wss://` URI (default for non-local peers); incoming reconstruction hardcodes `ws://`; deployment behavior remains unverified as reported. |

### C-04 chain (retry acknowledges object whose metadata never committed)

1. `betterbase-sync/crates/api/src/files.rs:267` — `record_exists` gate (pre-object-I/O). `:275-286` object store first (`file_storage.store`). `:287-289` — `if !created { return 204 }` **before** `record_file` at `:291-298`. `Ok(None)` (metadata already present) also maps to 204.
2. Object store: `:173-177` `PutMode::Create`; `:184-187` `AlreadyExists` → `Ok(false)` (string-match fallback included).
3. SDK: `betterbase/js/src/sync/files.ts:109-114` — 201 → `{created:true}`, 204 → `{created:false}`; no error, no metadata probe (HEAD would 404).
4. Failure interleaving stands: object committed → process/SQL dies before `record_file` commits → retry hits AlreadyExists → 204 without ever reaching the idempotent insert. `record_file` itself (`betterbase-sync/crates/storage/src/postgres/files.rs:26-72`: transaction, cursor-advance rollback, `ON CONFLICT DO NOTHING`) is fine but unreachable on that path. Download/pull read metadata (`resolve_readable_file` → `get_file_metadata`, `files.rs:419-433`) → 404.
5. Adjacent observation verified: `record_exists` filters `deleted = FALSE` (`storage/src/postgres/records.rs:374-387`, regression test `:619-659` documents the gating intent), but `record_file`'s INSERT (`postgres/files.rs:43-58`) never rechecks; FK `files_record_fk → records(id)` (migration `005_files_record_id.sql`) is satisfied by tombstone rows (records keep rows with `deleted = TRUE`, `records.rs:310-317`). A tombstone landing between `:267` and `:291` leaves new file metadata attached to a deleted record.

Line-ref corrections: SDK 204 handling is `files.ts:112-114` (report said ~118-125); `record_file` is `postgres/files.rs:26-72` (report said ~26-69). Server refs accurate.

### C-08 chain (WS session authorization outlives JWT expiry)

1. Expiry is enforced only at validation: `betterbase-sync/crates/auth/src/jwt/validator.rs:141-146` (`now > exp` → `ExpiredToken`). `TokenInfo` (`:60-70`, built `:160-169`) and `AuthContext` (built `:179-187`) have **no** expiry field — nothing downstream can check it.
2. WS session: `crates/api/src/ws/mod.rs:22` `WS_MAX_LIFETIME = 3600s`; `:333-335` `deadline = jittered_lifetime(...)` pinned per connection; main loop `:337-437` terminates only on socket close/protocol error or that deadline; `:345-355` close code is `CLOSE_TOKEN_EXPIRED`/"connection timeout" — a connection-lifetime bound, not a token bound.
3. Jitter: `:482-488` — `0.9 + rand*0.2` → lifetime ∈ [54, 66) min. A token expiring immediately after handshake authorizes ordinary personal-space RPCs until teardown: bounded ~66 min, matching the report.
4. Dispatch reuses the context: `:373-392` passes `&mut auth_context` into `rpc::handle_request` per frame. The validator is reachable only via the client-initiated `"token.refresh"` RPC (`ws/rpc/mod.rs:103-105` → `token_refresh::handle_request`). No server-driven re-validation or proactive refresh exists.

Line-ref corrections: expiry check is `validator.rs:141-146` (report said ~137-144); TokenInfo/AuthContext at `:160-187` as reported.

### C-10 chain (read-only invitees cannot accept or decline)

1. Server gate: `betterbase-sync/crates/api/src/ws/rpc/membership_append.rs:127` — `authz::authorize_write_space(...)`; nothing action-specific (acceptance vs. privileged change) before it.
2. Attenuation: `crates/auth/src/ucan.rs:206` — `if !permission.attenuates(required_permission)` errors; `permission.rs:24-26` — `attenuates(self, child) = self >= child`, so Read(1) cannot satisfy Write(2); chain-internal attenuation enforced at `ucan.rs:249`.
3. SDK ordering: `betterbase/js/src/sync/space-manager.ts` — `accept` (`:368-425`): signs and appends the acceptance entry at `:383-394` using `spaceRecord.ucanChain` **before** status→active (`:397-400`) and sync-stack creation (`:403-409`). `decline` (`:434-466`): appends at `:440-452` before record delete (`:455`) and invitation delete (`:458-465`).
4. The invitee UCAN is read-only by construction for read invites: `invite` (`:279-322`) maps `role: "read"` via `roleToPermission` (`:1814-1823` → `/space/read`) into `delegateUCAN` (`:302-310`); receipt stores it as `ucanChain` (`:1343-1357`).
5. `appendMembershipEntryWithRetry` (`:1665-1703`) passes that UCAN into both `getEntries` (Read-gated, succeeds) and `appendMembershipEntry` → server `membership.append` → Forbidden → the `throw` at `:1700` aborts accept/decline before any local state change. Neither lifecycle path can complete. Counterevidence holds: direct subscribe/pull with the read UCAN is not blocked by this finding.

Line-ref corrections: `accept` spans `:368-425` (append at 383-394), `decline` `:434-466` (append at 440-452); report's ~368-405/~434-457 slightly short.

### C-12 chain (one undecryptable invitation blocks the mailbox loop)

1. Server accepts opaque payloads: `betterbase-sync/crates/api/src/ws/rpc/invitation.rs:441-458` — only non-empty (`:451-453`) and ≤ `MAX_INVITATION_PAYLOAD = 128*1024` (`:21`, checked `:454-456`) for a syntactically valid mailbox (`:445-450`). Content is never validated against recipient key material.
2. SDK loop: `betterbase/js/src/sync/space-manager.ts:1289-1366` — `decryptJwe(invitation.payload, privateKeyJwk)` at `:1291` executes **outside** the only per-item try/catch, which guards `JSON.parse` alone (`:1293-1306`, and that branch does delete the item). A decrypt throw rejects the entire `checkInvitationsInner` promise; the failing item is neither deleted nor quarantined; later invitations and revocation notices are unprocessed.
3. Report's secondary claim verified — further unguarded throw sites inside the loop: `parseInvitationWirePayload` (`:1330` → `atob(wire.space_key)` at `:1780` throws on non-base64 from valid JSON), `permissionToRole` (`:1354` → `:1838-1852`: empty-chain throw, JWT-format throw, `JSON.parse`, unknown-cmd throw), and the explicit `throw new Error("Invitation has empty UCAN chain")` at `:1344`.
4. Persistence of the blockage: server lists `ORDER BY created_at ASC, id ASC` (`crates/storage/src/postgres/invitations.rs:54,75`), so the poison item stays at the page head on every poll until manual `invitation.delete` or the 7-day expiry. Counterevidence re-verified: sender must be authenticated and know the 64-hex mailbox id (legitimate correspondents learn it via lookup); a single item suffices.

Line-ref corrections: decrypt is at `:1291` with the guard at `:1293-1306` (report's ~1283-1295 conflated the two); the report's "malformed JSON can also throw outside the boundary" is precisely `:1330→1780`/`:1354→1838-1852`.

### C-13 chain (interrupted uploads permanently stuck in `uploading`)

1. `betterbase/js/src/sync/file-store.ts:827-869` `processOneUpload` — first durable action is `markUploading` at `:834` (`:764-771` sets `uploadStatus="uploading"` and persists via `metaPut`). Work (blob read `:836`, record sync `:839`, encrypt `:847`, upload `:856-861`) follows; caught errors → `markUploadError` (`:773-783`, retryable), success → `clearUploadState` (`:785-796`). Crash/termination between `:834` and either cleanup leaves the durable status `uploading`.
2. Scan selects only `pending`/`error`: `:611-613` and re-check `:622-624` — `uploading` is never re-enqueued.
3. `connect` (`:328-409`) wires config, migrates space keys, and calls `processQueue()` — no reset of abandoned `uploading` entries. Repo-file status-transition enumeration (all writes of `uploadStatus`): `:460` (put→pending), `:768` (→uploading), `:779` (→error), `:789` (delete). No path writes `uploading` back to a retryable state, on any instance.
4. Eviction protection: `runEviction` `:1006-1036` — `if (meta.uploadStatus !== undefined) continue;` at `:1022`; the stuck item's bytes count toward `totalBytes` (`:1011-1013`) but are unevictable, pinning cache allocation indefinitely.
5. Cross-restart: all queue state lives in the shared IndexedDB store (`getSharedDB`, `:319`); a fresh FileStore/page load reads the same `uploading` metadata and skips it.

Counterevidence re-verified: ordinary caught network failures do reach `error` and retry; the defect is specifically termination between the persisted in-flight mark and cleanup.

### C-14 chain (outgoing federation connections discard realtime notifications)

1. `betterbase-sync/crates/api/src/federation_client/peer.rs:42-84` `call_raw` — takes `self.socket.lock().await` (`:60`), connects if needed, sends one frame, then `read_response_for_request` (`:79`) — the socket is read **only** here, while awaiting the matching response, under the mutex. `PeerConnection` (`:27-40`) has no reader task, channel, or callback; `call_raw`/`read_response_for_request` are the only readers.
2. Decoder: `crates/api/src/federation_client/wire.rs:67-83` — only `RPC_RESPONSE (1)` and `RPC_CHUNK (3)` are classified; `RPC_NOTIFICATION = 2` (`crates/core/src/protocol/rpc.rs:5-8`) falls to `_ => Ok(InboundFrame::Other)`; `peer.rs:241-243` `Other => { continue; }` discards. Notifications arriving between RPCs sit unread in the socket; those arriving during one are read and dropped. Either way they never reach the local broker.
3. Subscribe errors dropped: `crates/api/src/federation_client/mod.rs:103-137` — decodes `SubscribeResult` and uses only `.spaces` (`:122-127`); `SubscribeResult.errors: Vec<WsSpaceError>` (`crates/core/src/protocol/ws.rs:56-61`) is ignored; even an undecodable response returns `Ok(())` with fallback empty tokens (`:120-136`).

Counterevidence re-verified: explicit federated pull/push RPCs remain functional; impact is the realtime path only.

### C-15 chain (trusted peers rebroadcast into unrelated spaces)

Precondition (explicit): the notification must arrive on a `ConnectionMode::Federation` connection, which requires HTTP-signature authentication against explicitly configured key-ID pins plus a trusted-domain check (`crates/api/src/federation.rs:115-135, 152-180`). Not an unauthenticated entry point.

1. Dispatch: `crates/api/src/ws/rpc/mod.rs:398-413` — federation-mode notifications `sync|membership|file|revoked` call `handle_federation_rebroadcast(realtime, method, payload)` directly. The `quota_tracker` in scope (`:396`) is touched only by the `unsubscribe` arm (`:399-408`).
2. Rebroadcast: `:443-487` — decodes the peer-supplied payload and broadcasts to `params.space` with **no** UCAN validation, no check that the peer holds a subscription to that space, and no home-authority check; `realtime.broadcast_notification` (`crates/api/src/ws/realtime.rs:210-226`) → `broker.broadcast_space(space_id, exclude_id, ...)` delivers to every current subscriber of the named space (sender-excluded). Tombstone/control metadata (`cursor`, `key_generation`, `rewrap_epoch`, `WsFileData`, `WsRevokedData`) rides outside record AEAD.
3. Quota bypass: per-peer push accounting (`check_and_record_push`) exists only in the `push` RPC path (`crates/api/src/ws/rpc/federation_sync.rs:116-130`); notification frames never pass through it.

Minimum impact stands: unsolicited notification/control injection into any known local space by a compromised trusted peer; fabricated record blobs fail client AEAD, control fields do not carry that protection (C-02 compounds).

Line-ref corrections: dispatch arm is `:398-413` (report said ~401-413); handler `:443-487` accurate.

### C-16 chain (record deletion never removes file objects)

1. Tombstone push deletes SQL file rows and returns the ids: `crates/storage/src/postgres/records.rs:307-313` (collect tombstoned), `:350-361` (`DELETE FROM files ... RETURNING id`), `:367-371` (`PushResult.deleted_file_ids`; type at `crates/storage/src/lib.rs:241`).
2. Both consumers ignore them: client push `crates/api/src/ws/rpc/handlers.rs:380-423` and federation push `federation_sync.rs:134-177` each read only `result.ok`/`result.cursor`. Repo-wide sweep: `deleted_file_ids` has no non-test reader in the api crate.
3. No object deletion anywhere: HTTP blob trait exposes only `store`/`get` (`crates/api/src/files.rs:127-135`); storage trait `delete_files_for_records` (`crates/storage/src/postgres/files.rs:200-217`) deletes SQL metadata rows only; `rg` for `\.delete\(|delete_object|rm_object` across `crates/` and `bins/` matches only HashMap `remove`s and invitation SQL. Objects at `spaces/{space_id}/files/{file_id}` are retained indefinitely by this service.

Line-ref corrections: SQL deletion is `records.rs:350-361` (report said ~350-370); blob trait is `files.rs:127-135` (report said ~132-146).

### C-17 chain (wss signing vs ws reconstruction)

1. Outgoing: `crates/api/src/federation_client/peer.rs:149-182` `build_signature_request` validates scheme `ws|wss` (`:154-159`) and builds the request with the **full URL** as URI (`:163`); `:119-120` signs it. Signature base component `@target-uri` → `request_target_uri` (`crates/auth/src/http_signature.rs:199, 223-227`) returns the URI verbatim when scheme+authority are present — so the signed target is e.g. `wss://peer.example/api/v1/federation/ws`.
2. Incoming: `crates/api/src/ws/mod.rs:161-168` `build_federation_auth_request` — for the origin-form URI + Host header that reverse proxies normally deliver, it reconstructs `ws://{host}{uri}` with a hardcoded `ws://`. Verification then builds `@target-uri` from that string. A `wss://`-signed handshake behind a TLS-terminating proxy therefore produces different signature bases on the two sides → verification failure; local `ws://` dev/e2e works, hiding the mismatch.
3. Exposure amplifier: `federation_client/mod.rs:387-393` `peer_ws_url` defaults **non-local** peers to `wss://` (local loopback peers to `ws://`), so the standard production cross-server path is exactly the mismatched combination.
4. Additional detail beyond the report: `http_signature.rs:229-233` has a third fallback base `https://{host}{uri}` for origin-form URIs without a Host header — unreachable on the federation WS path (reconstruction at step 2 always injects `ws://` when Host is present) but a latent inconsistency for other verifiers.

Counterevidence re-verified: a proxy that preserves the absolute-form URI (scheme+authority) bypasses reconstruction and both sides then sign the same string. Actual production proxy behavior not exercised — deployment impact remains unquantified, exactly as the report qualified it.

## Exit code / assertions / skipped tests

- Source re-verification only: every claimed chain link located and read at the pinned HEADs; repo-wide sweeps executed for C-16 (object deletion call sites — none found) and C-13 (status-transition enumeration — no reset path). No tests, harnesses, or services run (per assignment: none of these findings needs execution; no cheap isolated pure-function harness justified itself).

## Result

- C-04, C-08, C-10, C-12, C-13, C-14, C-15 (precondition: configured trusted peer), C-16, C-17: **source-only confirmed**. C-17 remains "confirmed source mismatch, deployment behavior unverified" — no TLS/proxy run was made.

## Seed / schedule / reproduction steps

- Deterministic source inspection; no seeds or schedules. Re-run by checking out the pinned revisions and following the file:line references above.

## Sanitized output or artifact links

- None beyond this file; no credentials, tokens, or key material involved.

## Limits: mocks, unsupported environments, untested paths, or unreproduced claims

- All nine remain source-argument confirmations; the concrete interleavings (crash between object store and `record_file`; a token expiring mid-connection; a read-role invite lifecycle; a poison mailbox item at the head of the page; a crash between `markUploading` and cleanup; a two-server notification fan-out; a trusted-peer injection; object retention growth; a live wss-behind-proxy handshake) were not executed. Coordinator should prioritize: C-04 fault-injection (object-store success + SQL failure + retry), C-13 crash-injection, and C-17 against the real production proxy path — these three are the cheapest to turn into runtime evidence.
- C-15's severity depends on the declared peer trust model (documented assumption needed: whether federation peers are intended to be authoritative over local spaces they have not been delegated); the code's selective UCAN checks elsewhere suggest they are not.
- Wave-1 baselines unchanged and untouched; this wave wrote only this evidence file.
