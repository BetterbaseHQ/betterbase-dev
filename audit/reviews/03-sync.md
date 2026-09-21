# Review: sync, authorization, epochs, and files

- Reviewer: assignment C (sync review agent).
- Date: 2026-09-20.
- Revisions: `betterbase-sync` `324da35e30922dfd3ab53c2fb862e7272b2e72f1`; SDK `betterbase` `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`. Both HEADs checked during analysis.
- Status: assigned surface source-analysis pass completed; **not runtime verified**. This is a breadth review with deeper traces of critical handoffs, not certification of every line or dependency.
- Invariants: INV-02, INV-03, INV-04, INV-05, INV-06, INV-07.
- No product edits, exploit harnesses, or new reproduction tests were made. This reviewer ran read-only source inspection; the coordinator owns baseline suite execution.

## Scope and observed guarantees

Reviewed the main client/server write lifecycle: WebSocket authentication and dispatch, UCAN authorization, subscription/broadcast lifetime, PostgreSQL push/pull, JS transport decryption and cursor persistence, membership revocation, epoch begin/rewrap/complete, file upload/storage, and federation subscription/authentication/quota boundaries. Also inspected SDK Rust sync-core transport and membership formats, and JS SyncManager integration with the database.

The server has useful foundations: record pushes take a space-row lock, compare expected record cursors, and commit record changes plus the new cursor together. Streaming pulls use a repeatable-read snapshot encompassing the space cursor and record/membership/file rows. UCAN validation checks signatures, root key, audience, resource, permission attenuation, expiry, proof count/depth, and revocation of every proof in ordinary authorization. Record AEAD binds the space and record identifiers. These protections do not resolve the cross-operation failures below.

All candidate severities below are provisional. “Confirmed by source” means a complete reachable control-flow/interleaving argument, not an executed reproduction. Source paths/line numbers refer to the revisions above and are relative to the orchestration root.

## C-01 — Revoked subscribers retain future ciphertext access and can derive future keys

**Provisional severity: critical/high confidentiality; confirmed by source.** INV-04, INV-05.

Revoking a UCAN inserts its CID and broadcasts a `revoked` notification, but does not remove affected subscriptions or close their connections: `betterbase-sync/crates/api/src/ws/rpc/membership_revoke.rs:73–88`. `RealtimeSession::broadcast_revocation` is only a generic broadcast (`crates/api/src/ws/realtime.rs:193–225`). The broker sends each subsequent space notification to indexed subscribers, checking only closed state and sender exclusion, not authorization (`crates/realtime/src/broker/multi.rs:157–207`). Push broadcasts contain both ciphertext and wrapped DEKs (`crates/api/src/ws/rpc/push_helpers.rs:32–45`).

The SDK removal path derives the replacement epoch key from the existing key, rather than introducing a fresh secret unknown to the removed member: `betterbase/js/src/sync/space-manager.ts:755–756,814–830`; derivation is the public forward chain in `betterbase/js/src/sync/reencrypt.ts:381–394`. SDK Rust's existing `forward_epoch_decryption` test explicitly demonstrates that an older key can decrypt a future epoch (`betterbase/crates/betterbase-sync-core/src/transport.rs:205–236`).

Failure argument: a previously authorized member has an active subscription and old epoch key; removal completes; the member's client keeps the connection open rather than voluntarily acting on `revoked`; subsequent ordinary edits broadcast ciphertext and wrapped DEKs to that connection; the retained key derives the new epoch KEK, enabling decryption of **new content created after removal**. This is not merely retention of historical plaintext.

Counterevidence/limits: ordinary new pull/push/subscribe authorization checks the revoked CID and should deny it. The stock SDK attempts to remove local access on notification. Neither constrains a recipient-controlled client. Connections have a jittered one-hour lifetime (`crates/api/src/ws/mod.rs:333–335,482–487`), so the directly established local-socket exposure lasts until connection teardown (up to roughly 66 minutes), rather than indefinitely. No live WebSocket scenario was run.

Federation extension: the FST reconnect path validates peer/domain and space but does not consult original UCAN revocations (`crates/api/src/ws/rpc/federation_subscribe.rs:122–159`). FST carries a space/domain/expiry association rather than the delegation revocation identity. Its precise extended exposure window and peer-forwarder behavior require a separate runtime check. This extension is not needed for the local-socket finding.

## C-02 — Pull cursors advance before local data application and discard failed records

**Provisional severity: high data loss/divergence; confirmed by source.** INV-02, INV-03.

`WSTransport.pull` decrypts a space batch and calls `setCursor` before returning the records to its caller (`betterbase/js/src/sync/ws-transport.ts:350–367,431–434`). `setCursor` immediately changes the in-memory cursor and starts asynchronous persistence (`:594–604`). The normal SyncEngine supplies a real database-backed cursor store (`betterbase/js/src/sync/sync-engine.ts:504–508`). The subsequent SyncManager application therefore cannot determine whether the cursor is safe to acknowledge.

Failure interleaving: pull obtains records through cursor N; the per-space cursor write succeeds; the browser stops or `applyRemoteChanges` fails before those records commit; after restart the next pull requests `since=N` and receives no unchanged skipped records. Even without a restart, an apply failure leaves the in-memory cursor ahead. Resetting only the collection-level cursor does not reset the independent `spaceCursor:` value.

Two companion failure paths share the same invariant violation:

- Per-space `SyncTransport.pull` reports decrypt failures (`betterbase/js/src/sync/transport.ts:449–461,471–475`), but WSTransport omits them from its result (`ws-transport.ts:431–434`) while advancing the cursor. Ciphertext is not durably retained for repair/retry.
- `SyncManager.pullImpl` records `applyResult.errors` (`betterbase/js/src/db/sync/sync-manager.ts:354–375`) and still persists `latestSequence` (`:397–407`); its failure counts/quarantine are memory-only (`:33–35,412–423`). `applyRemoteRecords` has the corresponding error-then-advance pattern (`:163–190`). The local-data reviewer independently identified the matching Rust partial-apply behavior; this report owns the cross-layer cursor finding.
- `WSClient.pull` adds a space to its result on `pull.begin`, then returns it without requiring a matching `pull.commit` (`betterbase/js/src/sync/ws-client.ts:181–235`). Server streaming errors intentionally omit that space's commit but still send an overall success response (`betterbase-sync/crates/api/src/ws/rpc/handlers.rs:519–553`). A partial stream is therefore accepted with the begin frame's final cursor. Global chunk counts do not detect this because the response accurately counts the chunks actually sent.

Counterevidence/limits: the realtime fast path advances per-space cursors only when its returned error array is empty (`ws-transport.ts:507–513`), and SyncManager avoids its own final cursor update on a thrown apply exception. Those checks do not roll back the earlier ordinary-pull transport cursor. A full resync may recover server-held records; the ordinary resume protocol does not.

## C-03 — DEK rewrap can overwrite the key for a concurrently replaced ciphertext

**Provisional severity: high loss of decryptability; confirmed by source.** INV-03, INV-05.

The rewrap client fetches DEKs, performs cryptography, then submits only `{id, dek}` (`betterbase/js/src/sync/reencrypt.ts:159–186`). Server `rewrap_deks` updates `wrapped_dek` by record ID and space ID without comparing the previously observed DEK or record cursor (`betterbase-sync/crates/storage/src/postgres/epochs.rs:133–150`). Ordinary SDK pushes generate a new random DEK for every encryption (`betterbase/js/src/sync/transport.ts:800–826`) and server push replaces blob plus wrapped DEK (`betterbase-sync/crates/storage/src/postgres/records.rs:310–332`).

Failure interleaving: rewrapper reads ciphertext C1's wrapped key D1; another member pushes C2 encrypted with fresh D2; the rewrapper submits D1 wrapped under the new epoch; UPDATE overwrites D2's wrapper while C2 remains. C2 can no longer be decrypted using its stored wrapper. The operations can execute entirely sequentially at the database boundary; locking each transaction cannot protect the earlier client read.

Counterevidence/limits: rewrap does lock the space and validates that the submitted wrapper epoch equals the current generation, but neither establishes that the wrapper still belongs to the stored ciphertext. Immutable file objects reduce the analogous normal-update race for files, so this finding specifically establishes the record path. Data may remain recoverable from another device's local plaintext; server state alone loses the correct DEK wrapper. No concurrent PostgreSQL reproduction was executed.

Reachability qualification from the expanded review: C-09 currently prevents the stock WSClient from obtaining these DEKs, masking the usual SDK-triggered race. The faulty storage/RPC update remains reachable by a conforming client that reads the server's result-array response. C-03 must be addressed alongside C-09 so repairing the wire mismatch does not expose the destructive race to normal SDK rotation.

## C-04 — File retry can acknowledge an object whose metadata never committed

**Provisional severity: high file loss/unavailability; confirmed by source.** INV-03, INV-06.

Upload first creates the object, then commits file metadata. If the object already exists, it returns 204 immediately, before attempting metadata storage: `betterbase-sync/crates/api/src/files.rs:275–297`. Object creation uses `PutMode::Create` and maps AlreadyExists to `created=false` (`:155–181`). SDK `FilesClient.upload` treats 204 as successful idempotency (`betterbase/js/src/sync/files.ts:118–125`).

Failure interleaving: object storage succeeds; the process terminates or SQL fails before `record_file` commits; the client retries the same file ID; object storage reports AlreadyExists; server returns 204 without creating metadata. Subsequent metadata-dependent download/pull cannot discover/use that file. This is a false success on a natural recoverable failure boundary.

Counterevidence/limits: SQL `record_file` is itself idempotent and transactional (`betterbase-sync/crates/storage/src/postgres/files.rs:26–69`), and the local cache may still hold plaintext. The retry returns before reaching that protection. No fault-injection run was performed.

Related source-level lifecycle risk, not a separately verified finding: record existence is checked before object I/O (`files.rs:267`), while later metadata insertion does not recheck `deleted`; the FK targets a record row that remains as a tombstone. A deletion between those operations can therefore leave newly registered files attached to an already deleted record. Object garbage-collection and retention behavior need explicit review.

## C-05 — Write capability authorizes administrator lifecycle actions

**Provisional severity: high authorization/integrity; confirmed by source.** INV-04, INV-05.

`membership.revoke` uses `authorize_write_space` (`betterbase-sync/crates/api/src/ws/rpc/membership_revoke.rs:61`) and accepts any nonempty target CID (`:36–46`). Epoch begin and complete likewise require Write (`crates/api/src/ws/rpc/epoch.rs:52,142`). The authorization function passes `Permission::Write` to chain validation (`crates/api/src/ws/authz.rs:27–35,69–79`), and Write is a distinct lower permission than Admin (`crates/auth/src/permission.rs:6–12`).

SDK policy explicitly restricts removal to admins (`betterbase/js/src/sync/space-manager.ts:734–735`) and says only admins can advance epochs (`:1019–1022`). Server behavior therefore does not enforce the presented role boundary. A write member can invoke the server lifecycle RPCs directly, revoke other members/ancestors, or change rotation state. A delegation contains its proof chain, so an ancestor capability CID can be known without guessing.

Counterevidence/limits: the member must already possess a valid write delegation; read-only capabilities do not satisfy this particular gate. Write capability already permits editing shared records, but it should not imply account administration according to current SDK policy. Membership append may intentionally permit member acceptance and needs action-specific authorization rather than indiscriminately changing every operation to Admin. No unauthorized-action harness was created.

## C-06 — Minimum key generation enforcement is disconnected from network pushes

**Provisional severity: high rotation correctness; confirmed by source.** INV-05.

The PostgreSQL generation check only runs when `PushOptions` exists and its generation is positive (`betterbase-sync/crates/storage/src/postgres/records.rs:258–270`). The blanket API storage adapter unconditionally calls `RecordStorage::push(..., None)` (`betterbase-sync/crates/api/src/ws/storage.rs:138–140`). Both client and federation handlers use this adapter. Thus epoch begin's `set_min_key_generation` does not reject old-generation network writes.

Failure argument: after the minimum generation advances, an otherwise authorized stale device can still commit a record encrypted at the old epoch; a recipient whose persisted base key has advanced cannot derive backward to decrypt it. This also allows a late old-epoch write after the rewrapper's initial scan. `complete_rewrap` only clears the flag (`crates/storage/src/postgres/epochs.rs:58–83`) and does not verify all stored wrappers meet the target.

Counterevidence/limits: ordinary UCAN revocation still rejects a revoked writer on a newly authorized request; this is not proof that a revoked writer can bypass that check. It is a stale-but-authorized-client correctness failure and a false minimum-generation guarantee. Storage-only tests that pass explicit PushOptions do not exercise the API adapter defect.

## C-07 — Epoch conflict error strings disagree across server and SDK

**Provisional severity: medium/high rotation recovery; confirmed by source.** INV-05.

On CAS conflict the server sends an ordinary result containing `error: ERR_CODE_CONFLICT` (`betterbase-sync/crates/api/src/ws/rpc/epoch.rs:80–90`), whose value is `"conflict"` (`crates/core/src/protocol/rpc.rs:16`). SDK `advanceEpoch` only recognizes `"epoch_conflict"` (`betterbase/js/src/sync/reencrypt.ts:74–86`), otherwise returning successfully.

Consequently concurrent/interrupted rotation does not enter the `EpochMismatchError` recovery branches in SpaceManager; callers proceed as though their requested advance won. Later epoch mismatch/rewrap failures can leave an operation partly completed, including a member already revoked. The precise eventual state depends on competing operation order; this finding establishes the missing conflict recognition rather than claiming every conflict loses data. No mock or integration test was executed for this mismatch.

## C-08 — WebSocket session authorization outlives JWT expiry

**Provisional severity: medium security boundary; confirmed by source.** INV-04, INV-07.

JWT expiry is checked during validation, but expiry is omitted from returned TokenInfo/AuthContext (`betterbase-sync/crates/auth/src/jwt/validator.rs:137–144,160–187`). WebSocket request dispatch subsequently reuses that context, with a deadline based on a fresh jittered one-hour connection lifetime rather than token expiry (`crates/api/src/ws/mod.rs:333–390,482–487`). Token refresh is optional client-driven RPC.

An accepted token that expires shortly after handshake therefore still authorizes ordinary personal-space operations until connection teardown, potentially almost 66 minutes later. This is bounded, not infinite. Whether the product intentionally permits this session lifetime must be recorded; the code currently cannot enforce JWT expiry on the open connection. UCAN expiry is checked for explicit shared-space operations but, as C-01 explains, not per broadcast. No timed live-token experiment was run.

## C-09 — DEK listing response mismatch makes ordinary rotation skip every rewrap

**Provisional severity: high loss of decryptability; confirmed by source.** INV-03, INV-05.

Server `deks.get` and `deks.getFiles` return one ordinary RPC result containing `{deks: [...]}` (`betterbase-sync/crates/api/src/ws/rpc/deks.rs:49–60,190–201`). JS `WSClient.getDEKs`/`getFileDEKs` instead use `callChunked` and collect only `deks.record`/`deks.files.record` chunks (`betterbase/js/src/sync/ws-client.ts:312–345`). `RpcConnection.callChunked` discards the ordinary response value; its optional count check only activates when a `chunks` number is present (`betterbase/js/src/sync/rpc-connection.ts:150–170,317–343`). Thus these calls resolve with empty DEK arrays against this server, even when stored records/files exist.

The rotation procedure then completes with zero rewraps and persists the newer epoch key (`betterbase/js/src/sync/space-manager.ts:1068–1088,1536–1549`). A fresh SDK instance or newly invited member with only the newer key cannot derive backward to unwrap the unchanged old-epoch DEKs. An existing transport retains its original base key in memory, and local plaintext remains, potentially concealing the problem until reload/new-device access.

Counterevidence/limits: this is a direct client/server framing mismatch, not a claim that AES-KW fails. Existing raw-server DEK tests and mocked WSClient rotation tests can each pass while disagreeing on wire shape. No end-to-end rotation was run by this reviewer; coordinator should prioritize its existing rotation scenarios and verify that they actually use both implementations.

## C-10 — Read-only invitees cannot accept or decline through SpaceManager

**Provisional severity: medium functional authorization mismatch; confirmed by source.** INV-04.

`SpaceManager.accept` first appends a signed membership acceptance, before setting the space active; decline also appends before deleting the invitation (`betterbase/js/src/sync/space-manager.ts:368–405,434–457`). That append uses the read-only invitee UCAN. Server membership append requires Write (`betterbase-sync/crates/api/src/ws/rpc/membership_append.rs:127`), while UCAN attenuation correctly rejects Read for Write. An invitation created with the exposed `role: "read"` option therefore cannot complete either path.

Counterevidence/limits: the underlying read UCAN may permit direct subscribe/pull; this finding concerns the provided lifecycle API. Correcting this requires distinguishing a member's signed acceptance/decline from privileged delegation changes; granting all read members arbitrary administrative membership mutation would not preserve the intended boundary.

## C-11 — Invitations after rotation label the current key as epoch one

**Provisional severity: high shared-data availability; confirmed by source.** INV-05.

Invite reads the currently persisted space key but omits its generation from the payload (`betterbase/js/src/sync/space-manager.ts:313–323`). Receipt unconditionally persists `epoch: 1` (`:1332–1361`), even though invitation metadata has an optional generation field. Accept creates its sync stack with that stored epoch (`:402–409`).

After any successful key advancement to e>1, an invitee receives K_e labelled K_1. To unwrap a record labelled e, the transport derives additional steps from the wrong base, obtaining a different key. Adopting server epoch e likewise derives from the mislabeled key and persists the wrong value. This is independent of C-09: even correctly rewrapped records fail for the new invitee.

Counterevidence/limits: invitations to a newly created epoch-one space work. Existing members with a correct key/epoch pair are not affected by this specific bug. No browser invitation-after-rotation scenario was run.

## C-12 — One undecryptable invitation blocks the mailbox processing loop

**Provisional severity: medium availability; confirmed by source.** INV-07.

Server invitation creation accepts arbitrary nonempty payloads up to 128 KiB for a syntactically valid mailbox (`betterbase-sync/crates/api/src/ws/rpc/invitation.rs:441–457`). SDK `checkInvitationsInner` decrypts each payload outside its JSON-error handler (`betterbase/js/src/sync/space-manager.ts:1283–1295`). A decryption failure rejects the entire loop before later invitations/revocation notices are processed, and the failing item is not deleted or quarantined. Malformed invitation structure later in that same loop can also throw outside a per-item boundary.

Counterevidence/limits: creating such an item requires an authenticated sender and knowledge of the target mailbox, which legitimate invitation lookup exposes to intended correspondents; this is not anonymous arbitrary mailbox discovery. Sender rate limits bound frequency but a single item suffices. Server expiry is seven days, and an explicit delete could recover the mailbox. No malicious-payload harness was created.

## C-13 — Interrupted file uploads remain permanently in `uploading`

**Provisional severity: high offline file sync reliability; confirmed by source.** INV-03.

`FileStore.processOneUpload` durably marks an item `uploading` before reading/encrypting/sending it (`betterbase/js/src/sync/file-store.ts:764–770,827–856`). The next queue scan processes only `pending` or `error` (`:606–625`); connect does not reset abandoned `uploading` items (`:328–408`). A page/process crash before error/success cleanup leaves the item permanently excluded from upload retries, including on fresh FileStore instances. Eviction deliberately protects all items with upload status, so this also pins their cache allocation.

Counterevidence/limits: ordinary caught network errors move items to `error` and are retried. This defect specifically concerns termination between the persisted in-flight state and its cleanup. Plaintext may remain locally, so this is stuck sync and backup exposure rather than proven immediate local-byte loss. No crash injection was executed.

## C-14 — Outgoing federation connections discard realtime notifications

**Provisional severity: medium synchronization/availability; confirmed by source.** INV-03.

`PeerConnection` reads its socket only while waiting for one RPC response under the socket mutex (`betterbase-sync/crates/api/src/federation_client/peer.rs:42–84,192–245`). The decoder classifies every notification as `Other` (`crates/api/src/federation_client/wire.rs:67–83`), and the read loop discards it. There is no reader task or callback to deliver those frames to the local broker. The separate server-side rebroadcast handler only handles messages arriving on an incoming federation socket; it is not wired to these outgoing sockets.

A local subscriber proxied to its home server can perform explicit pull, but home-server realtime changes sent back on the subscribed outgoing socket are left unread or discarded during a subsequent RPC. Peer subscribe also returns success without propagating `SubscribeResult.errors` (`federation_client/mod.rs:116–136`).

Counterevidence/limits: explicit federated push/pull remains present; this does not claim all federation is absent. Some applications may recover via later flush/pull. No two-server notification test was run here.

## C-15 — Trusted federation peers can rebroadcast into unrelated spaces

**Provisional severity: high trust-boundary integrity; confirmed by source.** INV-04, INV-07.

An authenticated federation peer can send `sync`, `membership`, `file`, or `revoked` notifications. Dispatch directly calls `handle_federation_rebroadcast` (`betterbase-sync/crates/api/src/ws/rpc/mod.rs:401–413`), whose branches broadcast the supplied space and payload (`:443–487`) without checking a UCAN, current subscription, or whether that peer is the authoritative home for that space. The per-peer push quota/authorization path is bypassed for these notifications.

This gives a compromised/trusted peer influence over notifications in a local space it has not been delegated. Encrypted record blobs will fail AEAD validation if fabricated, but tombstone/control metadata is not protected by that ciphertext authentication, and C-02 compounds cursor effects. The minimum established impact is unsolicited notification/control injection for a known space; full data-impact severity depends on the declared peer trust model and client path.

Counterevidence/limits: this requires a configured trusted peer signing identity; it is not an unauthenticated Internet entry point. Ordinary federation pull/push separately validates UCANs and local-home policy. If peers are intentionally fully authoritative over every local space, that much broader trust assumption must be documented; the selective UCAN checks elsewhere suggest the opposite. No cross-peer injection was executed.

## C-16 — Record deletion never schedules physical file-object removal

**Provisional severity: medium storage retention/capacity; confirmed by source.** INV-06.

Record tombstoning deletes associated file metadata and returns `deleted_file_ids` (`betterbase-sync/crates/storage/src/postgres/records.rs:350–370`). Both push handlers use the cursor/result but ignore those IDs. The object-storage trait exposes only store/get (`crates/api/src/files.rs:132–146`), and no object deletion/garbage-collection call site exists in the reviewed service. Therefore deleting records makes the encrypted file inaccessible through metadata but leaves its physical object allocated indefinitely.

Counterevidence/limits: ciphertext retention is not immediate plaintext disclosure, and external storage lifecycle policies could remove objects; none was established as part of this service. The user-visible meaning of deletion and operator capacity planning need an explicit policy. This differs from C-04, which falsely acknowledges an incomplete upload.

## C-17 — Secure federation URL signing and proxy request reconstruction disagree

**Provisional severity: medium production federation availability; confirmed source mismatch, deployment behavior unverified.** INV-03, INV-04.

Outgoing peers sign their full `ws://` or `wss://` URL (`betterbase-sync/crates/api/src/federation_client/peer.rs:115–120,149–177`), and signature-base construction uses the explicit URI scheme (`crates/auth/src/http_signature.rs:223–227`). Incoming upgrades with normal origin-form URI plus Host are reconstructed as `ws://` unconditionally (`crates/api/src/ws/mod.rs:161–166`). A production `wss://` connection terminated at a reverse proxy therefore produces different signed target strings on the two sides, while local ws tests work.

Counterevidence/limits: an absolute URI preserved by a particular proxy bypasses reconstruction. The configured production proxy path must be exercised to quantify actual deployment impact. No TLS/proxy integration run was made.

## Architecture and verification recommendations

The dangerous state boundaries are distributed across objects and layers: collection cursors and per-space cursors have different owners; record ciphertext and wrapped-DEK identity are not preserved across rewrap; revocation database state is disconnected from broker subscriptions; file objects and SQL metadata have no recoverable commit protocol. These are state-machine contracts requiring explicit commit/retry rules and regression scenarios, rather than only additional input validation.

Prioritize later defensive verification of C-01, C-02, C-03, and C-04, then authorization/generation/conflict integration checks. Any remediation must preserve frozen v1 protocol contracts or define a migration; analysis here does not prescribe silently changing the wire representation.

## Extended coverage and assurance gaps

The follow-up source pass covered all requested categories. Coverage below means implementation paths inspected, not that all behavior passed a test.

| Surface | Inspected entry points | Assessment and remaining assurance work |
| --- | --- | --- |
| Peer trust/key lifecycle | `betterbase-sync/crates/app/src/federation.rs`, `api/src/federation.rs`, `storage/src/postgres/federation.rs`, migrations 011/012 | Incoming signatures use explicitly configured key-ID pins, then a trusted-domain check. Key setup validates pin/domain consistency; primary-key change is transactional. Test real key rotation, restart, and backup restore; DB holds federation private keys, so DB backup confidentiality is part of the operator trust boundary. |
| HTTP signatures | `auth/src/http_signature.rs`, `api/src/ws/mod.rs`, `api/src/federation_client/peer.rs` | Method, full target URI, Host, key ID, algorithm, and creation time are signed; timestamps are bounded in both directions by five minutes. No one-use nonce/replay cache is present, so a captured valid handshake remains reusable in that interval. TLS is therefore essential to credential privacy; C-17 covers target reconstruction. No claim of unauthenticated signature forgery. |
| Federation session/FST | `auth/src/federation_token.rs`, `auth/src/session.rs`, `api/src/ws/rpc/federation_subscribe.rs` | Tokens bind space and canonical peer-domain hash with HMAC; FST issuance caps expiry at 24 hours and original UCAN/token expiry. Renewing an FST preserves its previous expiry cap. Revocation is absent from FST claims and reconnect validation; up to the remaining 24-hour issuance window plus the accepted connection lifetime needs explicit policy/testing. Ordinary session token binds permission/space and expiry, but it is not the WebSocket JWT expiry mechanism. |
| Federation forwarding | `api/src/federation_client/{mod,peer,wire}.rs`, `api/src/ws/rpc/{federation,federation_auth,federation_sync}.rs`, ordinary handler forwarding | Explicit pull/push validates capabilities; home server cannot forward a push again. C-14/C-15 are defects. Outgoing peer calls hold a per-peer mutex without an explicit response/connect deadline and accumulate chunks in a Vec; stalled or very large trusted peers can block all calls for that peer. Reconnect/ambiguous-commit replay requires integration tests. Membership/epoch/file operations are not forwarded by the federation RPC dispatch, and the production path that provisions remote `home_server` rows was not established by call-site search (storage setter appears only in tests). Complete cross-server lifecycle support remains unproven. |
| Discovery/SSRF | `betterbase/js/src/discovery/{metadata,webfinger}.ts`, `betterbase/crates/betterbase-discovery/src/{metadata,webfinger}.rs`, sync invitation forwarding | Browser discovery has 10-second fetch timeouts but validates field shape rather than endpoint scheme/origin or WebFinger subject equality. JS also validates link objects less strictly than Rust. These are browser fetches without bearer auth; no server-side arbitrary-URL SSRF was established. Sync invitation forwarding requires a configured trusted canonical domain before constructing a peer URL; record home URLs are stored configuration/state. Pin endpoint/scheme policy and test redirects/DNS/private endpoints before claiming SSRF resistance. |
| Membership chain/client verification | `storage/src/postgres/membership.rs`, `api/src/ws/rpc/membership_{append,list,revoke}.rs`, SDK `sync/membership.ts`, `sync/space-manager.ts`, Rust sync-core `membership.rs` | Server append locks space, checks expected version/previous hash, and binds payload hash. SDK uses AEAD context `(space, chain_seq)` and verifies entry signatures. The client roster parser does not verify returned hash-chain continuity or a pinned terminal hash and does not validate each displayed UCAN's authority chain/root/resource. A member who can append can supply a correctly self-signed but unauthorized delegation and influence displayed roles. JS verifies the UCAN JWT itself only for self-issued UCANs (`membership.ts:389–395`), while Rust verifies all issuers (`membership.rs:231–246`): explicit parity/security gap. This is roster integrity, not a demonstrated server privilege escalation. |
| Invitation identity/mailbox | `sync/invitations.ts`, SpaceManager invite/accept/check, `api/src/ws/rpc/invitation.rs`, `storage/src/postgres/invitations.rs` | Mailbox list/get/delete use authenticated mailbox identity; encrypted payloads stay opaque to sync. Recipient lookup checks returned handle domain but not the entire returned handle/client/DID/public-key tuple; accounts remains a trusted directory. SDK lookup uses the configured local accounts endpoint with the username, rather than remote discovery; cross-domain lookup/delivery needs an explicit supported workflow. C-10/C-11/C-12 cover confirmed lifecycle failures. Invitation processing reads one default 50-item page and leaves deduplicated existing invitations undeleted; large mailboxes can starve later items. |
| Files/cache/deletion | `api/src/files.rs`, `storage/src/postgres/files.rs`, record file cascades, SDK `sync/{files,file-store}.ts`, SyncEngine file wiring | HTTP checks JWT scope, space UCAN, parent-record existence, DEK length, and advertised size; object paths are UUID-derived. Local blob+metadata writes use a shared IndexedDB database with space-prefixed keys, and eviction protects queued uploads. C-04/C-13/C-16 cover commit/retry/deletion defects. FileStore.connect migrates **all** prior-space entries into the new space when reusing an instance (`file-store.ts:394–396,716–749`); actual account-switch remount behavior needs coordination with identity/examples review. Epoch resolver assumes file DEKs arrive monotonically by epoch (`:333–391`), which is not guaranteed during incomplete rotation or stale-authorized upload. |
| Event/presence confidentiality | `sync/{channel-crypto,event-manager,presence}.ts`, `sync-engine.ts`, crypto channel helpers; server `ws/{presence,realtime}.rs`, notification handlers | AES-GCM channel key derivation and AAD separate space and message class; server peer pseudonyms are per-space HMAC values. Payload bounds are 1 KiB presence/4 KiB event, presence count 100/space, stale cleanup 45 seconds. Sender peer attribution is server metadata, not authenticated by payload AEAD; all space-key holders share channel keys. Timestamp windows reduce old replay but have no nonce deduplication and do not reject future timestamps. Do not use these ephemeral events as authenticated exactly-once financial/destructive commands. Revocation retains the subscription weakness in C-01. |
| Input/resource limits | WS framing, UCAN parser/authz, broker, federation quota, JWKS client, rate-limit storage, HTTP router | Inbound WS frame/message limit is 4 MiB, broker defaults to three connections/mailbox, and a subscribe request is capped at 1,000 spaces. Server storage limits push records and ciphertext sizes; federation counters serialize through a mutex. However repeated ordinary subscribe calls are not subject to a total per-connection space bound, per-message WebSocket actions are not generally rate-limited, and peer-response accumulation has no total-byte budget. User membership/invitation count-then-record limits are not transactional across connections and are disabled if identity hash key is absent. JWKS refresh uses a 10-second timeout and 1 MiB post-download size check; unknown KIDs can force repeated serialized refreshes despite a fresh cache, and the size bound is enforced only after buffering. These are resource-control assurance gaps, not measured load-test results. |
| Rust sync-core and JS parity | All Rust `envelope`, `padding`, `epoch_cache`, `transport`, `reencrypt`, `membership`, `types`, `error`, `lib` entry points plus corresponding JS | AEAD context, wrapped-DEK epoch prefix, padding-length validation, and a 1,000-step bound in epoch cache are present. General `derive_forward`/raw rewrap helper loops lack the cache's bound; untrusted server epoch adoption can reach these helpers. Some Rust error exits bypass explicit zeroize and intermediate key Vec replacements are dropped normally; automatic zeroizing wrappers would provide stronger key-lifetime guarantees. No heap/side-channel claim or fuzz campaign. JS/Rust membership verification differs as above. |
| Move/share/delete lifecycle | `sync/{move-to-space,share-tree,delete-tree,spaces-middleware}.ts` and relevant call sites | Moves create new IDs before tombstoning originals, preserving cross-space AEAD identity. ShareTree exposes partial completion via ShareTreeError. DeleteTree checks in-band bulk errors and stops above failed children. BulkMoveToSpace ignores returned in-band `bulkDelete.errors` at its final deletion (`move-to-space.ts:198`), so it can report success with originals remaining; this is duplicate/partial-completion risk. No atomic multi-space/parent-child transaction is promised; attachment copying/rebinding is caller work. |
| Persistence schema/migrations | All sync migrations 001–012 and storage domain implementations | Space cursor locking/snapshot reads are strong. Migration 007 deliberately drops old invitations; 010 initializes existing file/member unified cursors to zero without backfill, while pull uses `cursor > since`. Upgrade from a populated pre-010 database can omit those entries from unified pull even at since zero. Current greenfield deployment is less exposed; an upgrade/restore contract and fixture test are required before supporting such upgrades. |

Additional lower-priority source observations: file HTTP success broadcasts use `space_id.as_simple()` (`api/src/files.rs:301`) while ordinary subscriptions are indexed by the submitted hyphenated UUID string, so file notifications may miss normal subscribers. FileCache metadata helpers resolve request success before the IndexedDB transaction `complete` event (`file-store.ts:202–210`); durability claims should be evaluated at commit, not request completion. Rate-limit and invitation cleanup methods exist, but no periodic invocation was established in the running app (its periodic loop is presence cleanup); bounded retention of those tables needs operational verification.

## Checks executed and exclusions

Executed: applicable AGENTS/audit instructions read; source inventory and targeted reads; exact git revision checks. Existing source tests were inspected as counterevidence, not claimed as executed. Baseline native/JS/browser/database test results belong to the coordinator's evidence records.

Not executed by this reviewer: new security reproduction harnesses; live malicious-client tests; crash injection; timed JWT expiry; actual PostgreSQL race schedules; object-store outage recovery; fuzzing; load/DoS testing; federation reconnect/revocation integration; restore or migration campaigns. No external security-standard claims are used as the evidence for these findings.

Coverage limits needing subsequent verification:

- The extended table completes the assigned category-level source pass; it does not establish exhaustive path coverage or runtime correctness. Every noted environmental/crypto/concurrency claim still requires its specified defensive integration or failure-injection evidence.
- Account-switch remount and FileStore reuse must be reconciled with the identity/examples reports; cross-tab upload ownership has not been dynamically exercised.
- Federation trust/pinning and the exact supported remote-space provisioning, invitation, membership, file, and rotation lifecycle need a real two-server scenario, including production TLS proxying.
- Duplicate JS/Rust behavior requires wire and cryptographic parity tests. External crypto libraries, WebSocket/CBOR parsers, object-store backends, and browser persistence implementations were not independently audited here.
- UCAN token-representation canonicalization and signature malleability were considered but **not established**; do not promote this hypothesis without permitted defensive evidence.
- Local-data acknowledgement/version races are owned by review B; identity/auth key lifecycle by review A. Those independent reports must be reconciled with these handoffs.

The requested whole-platform audit should not be marked fully verified based on this report; these explicit exclusions remain assurance gaps even after all current source findings are triaged.
