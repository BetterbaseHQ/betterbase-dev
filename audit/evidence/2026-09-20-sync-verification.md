# Evidence: sync findings C-01/C-02/C-03/C-05/C-06/C-09/C-11 independent re-verification (+ C-09 runtime)

- Date / reviewer: 2026-09-20 / sync verification agent (successor wave).
- Finding and invariant IDs: C-01, C-02, C-03, C-05, C-06, C-09, C-11 from `reviews/03-sync.md` (INV-02..INV-07 as cited there); cross-checked against `reviews/07-cross-review-identity-to-sync.md`. C-07 verified incidentally.
- Repository revisions / local patch: `betterbase-sync` `324da35e30922dfd3ab53c2fb862e7272b2e72f1`, `betterbase` (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`. Both `git status --porcelain` clean at review time; no product code touched.
- Lockfile hashes / generated artifact provenance: no artifacts generated from product builds; harness transpiles the pinned SDK sources at run time using the repo's own toolchain (below).
- Tool versions / operating system / browser: Node v24.21.0, typescript 5.9.3 (`betterbase/js/node_modules/typescript`), cborg 4.5.8 (`betterbase/js/node_modules/cborg`), macOS (darwin). No browser used.
- Non-secret configuration / isolated services: none. No docker, no database, no network. Mock WebSocket in-process; synthetic token/UUID/DEK bytes only.
- Working directory and exact command or source-inspection method:
  - Source: targeted reads of the files listed per finding below at the pinned HEADs.
  - Runtime: `/var/folders/v0/t85z9j5x4dn0b__6vpm6__4c0000gn/T/opencode/sync-c09/harness.mjs`, executed `node harness.mjs` (essence embedded below).

## Expected behavior

- C-09 counter-hypothesis: `WSClient.getDEKs`/`getFileDEKs` should surface the DEKs the server returns for `deks.get`/`deks.getFiles`.
- Each re-verified finding should fail to be defeated by any overlooked guard in its chain.

## Observed behavior (verdicts)

| Finding | Verdict | Basis |
| --- | --- | --- |
| C-01 | **Confirmed** (source) | Full chain re-verified; no defeating check exists. Line-ref corrections below. |
| C-02 | **Confirmed** (source) | Full chain re-verified incl. both companion paths and the counterevidence (realtime fast path does gate on errors; ordinary pull does not). |
| C-03 | **Confirmed** (source), qualified | No observed-value compare in `rewrap_deks`; stock-SDK trigger masked by C-09 exactly as reported. |
| C-05 | **Confirmed** (source) | `membership.revoke`/`epoch.begin`/`epoch.complete` all gate on `Permission::Write`. |
| C-06 | **Confirmed** (source) | API storage adapter passes `PushOptions::None`; min-generation check unreachable from both client and federation push handlers. |
| C-09 | **Confirmed** (source **and runtime**) | Harness: real `WSClient.getDEKs` resolves `[]` against the exact server response shape; chunked variant populates. |
| C-11 | **Confirmed** (source) | Invite payload omits generation; receipt hardcodes `epoch: 1`; accept uses stored epoch. |
| C-07 (incidental) | **Confirmed** (source) | Server conflict string `"conflict"` vs SDK recognition of `"epoch_conflict"` only. |

### C-01 chain (revoked subscriber retains future-ciphertext access; forward-derived replacement key)

1. `betterbase-sync/crates/api/src/ws/rpc/membership_revoke.rs:61` `authorize_write_space`; `:73-80` `revoke_ucan` stores the CID; `:82-86` `broadcast_revocation` then success. Nothing removes subscriptions; repo-wide, only the client-initiated `unsubscribe` notification (`ws/rpc/handlers.rs:19-37`) and broker stale-subscriber cleanup remove space subscriptions.
2. `crates/api/src/ws/realtime.rs:193-204` `broadcast_revocation` → `broadcast_notification` (`:210-226`) → `broker.broadcast_space(space_id, exclude_id, payload)`. Subscriber is an outbound channel + closed flag (`:290-295`).
3. `crates/realtime/src/broker/multi.rs:157-207` `broadcast_space` filters only `is_closed()` (`:186`) and sender exclusion `exclude_id` (`:190`). No authorization/revocation state consulted.
4. Push broadcasts carry ciphertext **and** wrapped DEKs: `crates/api/src/ws/rpc/push_helpers.rs:30-44` (WsSyncRecord{blob, wrapped_dek}) → `realtime.rs:95-118` `broadcast_sync` "sync" notification.
5. SDK removal derives the replacement epoch key from the current key: `betterbase/js/src/sync/space-manager.ts:818` (`newKey = deriveForward(currentKey, spaceId, currentEpoch, newEpoch)`); routine rotation same at `:1049`. `reencrypt.ts:354-371` `deriveForward` chains `deriveNextEpochKey`; `js/src/crypto/epoch.ts:4` documents `epoch_key_N+1 = HKDF-SHA256(epoch_key_N, info="betterbase:epoch:v1:{spaceId}:{N+1}")` — only public inputs beyond the old key.
6. Rust test `betterbase/crates/betterbase-sync-core/src/transport.rs:196-223` `forward_epoch_decryption`: cache created at epoch 0 decrypts content encrypted at epoch 3.
7. Bound: `crates/api/src/ws/mod.rs:22` `WS_MAX_LIFETIME = 3600s`; `:482-487` `jitter = 0.9 + rand*0.2` → lifetime ∈ [54, 66] minutes. Matches the "~66 min max" framing.

Line-ref corrections vs `03-sync.md`: `deriveForward` is at `reencrypt.ts:354-371` (report said 381-394); the Rust test is at `transport.rs:196-223` (report said 205-236). `space-manager.ts:755-756,814-830` is accurate.

### C-09 chain + runtime (DEK listing mismatch → zero-rewrap "successful" rotation)

Source chain, all re-verified:

1. Server `deks.get` returns **one ordinary result** `{deks:[{id, dek, seq}]}`: `crates/api/src/ws/rpc/deks.rs:50-60`; `deks.getFiles` the same shape at `:191-201`. Frame encoding `frames.rs:20-34` → `{type:1, id, result:{deks:[...]}}` (`RpcResultFrame`, `rpc/mod.rs:504-515`).
2. Client `WSClient.getDEKs`/`getFileDEKs` use `callChunked` and collect only `deks.record`/`deks.files.record` chunk frames: `js/src/sync/ws-client.ts:312-326, 332-346`.
3. `RpcConnection.callChunked` returns `Promise<void>` with `resolve: () => resolve()` (discards the ordinary result): `js/src/sync/rpc-connection.ts:148-170`. `handleResponse` rejects only when a numeric `_chunks` mismatches; absent `_chunks` → `call.resolve(frame.result)` ignored: `:317-343`.
4. `rewrapAllDEKs` loops over the (empty) result and skips the rewrap RPC when `rewrapped.length === 0`, returning `{dekCount:0, fileDekCount:0}`: `js/src/sync/reencrypt.ts:158-221`.
5. Callers proceed to `epochComplete` and persist the new key/epoch without inspecting counts: removal path `space-manager.ts:886-907`; rotation path `:1070-1088`; persistence `updateLocalEpochState` `:1530-1550` (`spaceKey: bytesToBase64(newKey)`).

Runtime harness (executed, all synthetic values):

```js
// Loads REAL SDK sources at pinned rev: ws-client.ts, rpc-connection.ts, ws-frames.ts
// (per-file ts.transpileModule CommonJS via betterbase/js/node_modules/typescript@5.9.3,
//  vm.runInThisContext so host-realm `instanceof ArrayBuffer` holds in handleMessage;
//  cborg@4.5.8 imported from the repo's node_modules — the SDK's own codec).
// Mock WebSocket delivers CBOR frames shaped exactly like the real server's
// deks.get response (deks.rs:50-60 -> frames.rs:20-34 RpcResultFrame).

const SERVER_DEKS = [
  { id: '11111111-…', dek: Uint8Array(44 synthetic bytes), seq: 3 },
  { id: '22222222-…', dek: Uint8Array(44 synthetic bytes), seq: 4 },
];
MockWebSocket.serverScript = (frame, ws) => {
  if (frame.method === 'deks.get')
    ws.deliver({ type: RPC_RESPONSE, id: frame.id, result: { deks: SERVER_DEKS } });
};
const client = new WSClient({ url: 'ws://synthetic.test/api/v1/ws', getToken: async () => 'synthetic-token' });
await client.connect();
const deks = await client.getDEKs({ space: SPACE, since: 0 });   // CASE A
// Variants: B = same response via plain client.rpc.call('deks.get', …);
//           C = deliver {type:3, name:'deks.record', data} chunk frames ×2 then {_chunks:2};
//           D = deks.getFiles with ordinary result; E = result {_chunks:5} with zero chunks sent.
```

Output (verbatim):

```
PASS  A1: getDEKs against real server shape resolves WITHOUT error  — resolved with array
PASS  A2: getDEKs returns EMPTY array (2 DEKs were in the response)  — length=0, server sent 2
PASS  B1: plain rpc.call receives the ordinary result with all DEKs  — deks.length=2
PASS  C1: getDEKs with chunk frames populates all DEKs  — length=2
PASS  C2: chunked payload ids round-trip
PASS  D1: getFileDEKs against real server shape resolves with EMPTY array  — length=0, server sent 2
PASS  E1: count mismatch IS detected when _chunks present (guard exists but inert for deks.get)
---
7/7 checks passed
```

Interpretation: the mismatch is exactly the response shape. The same ordinary-result frame read via `rpc.call` yields the DEKs (B1); chunk frames populate `getDEKs` (C1/C2); the `_chunks` guard works when a count is present (E1) but the real `deks.get` result carries none, so the stock SDK silently gets `[]` (A1/A2, D1). Cross-review's note that the existing unit test mocks chunks and uses `wrapped_dek` (not the client's `dek` property) while asserting only IDs is verified verbatim at `js/src/sync/ws-client.test.ts:284-303`.

### C-02 chain (cursor advances before local application; partial/failed records skipped)

1. `ws-transport.ts:343-367`: per-space `transport.pull()` then `setCursor(collection, spaceId, latestSequence)` at `:365` — before the function returns records at `:431-434` (which omit `failures`).
2. `setCursor` `:594-606`: in-memory set immediate, persistence fire-and-forget (`cursorStore.set(...).catch(log)`).
3. `sync-engine.ts:504-508`: cursor store is the database-backed `spaceCursor:<collection>:<spaceId>` via `db.getLastSequence/setLastSequence` — a separate durable cursor from the collection cursor.
4. `sync-manager.ts:322` transport.pull → `:356` `applyRemoteChanges` only afterwards; per-record apply errors (`:370-376`) still lead to `setLastSequence` at `:397-407`; a thrown apply (`:382-387`) skips the collection cursor but cannot roll back the transport space cursor already advanced inside `transport.pull`. Quarantine/failure maps are memory-only.
5. Decrypt-failure omission: `transport.ts:449-475` produces `failures` (permanent) + full `spaceSequence`; `ws-transport.ts:431-434` drops them while `:365` advances to the full sequence.
6. Partial streams: `ws-client.ts:181-195` `pull.begin` inserts the space with the advertised final cursor; `pull.commit` (`:214-230`) only validates a count when it arrives — no state records its arrival. Server `handlers.rs:509-529`: stream error skips that space's commit, then `:546-553` sends the overall result with `chunks` = chunks actually sent, so the client's `_chunks` check passes on a partial stream.
7. Counterevidence re-verified: realtime fast path advances per-space cursors only when `result.errors.length === 0` (`ws-transport.ts:507-512`); it does not protect the ordinary-pull path above.

### C-03 chain (rewrap overwrites DEK of concurrently replaced ciphertext)

1. Client submits only `{id, dek}`: `reencrypt.ts:165-183`; server decodes `DekRecord { id, wrapped_dek, cursor: 0 }` — no compare value: `deks.rs:369-373`.
2. `epochs.rs:112-158` `rewrap_deks`: locks the space (`FOR UPDATE`, `:124`), checks submitted wrapper epoch == current generation (`:133-138`), then `UPDATE records SET wrapped_dek = $1 WHERE id = $2 AND space_id = $3` (`:142`) — by identity only. Contrast: push has a real cursor CAS (`records.rs:290-304`) and atomically replaces blob+wrapper (`:315-340`); neither helps a rewrap whose read happened earlier.
3. Masking verified: under C-09 the stock SDK's `getDEKs` returns `[]`, so `rewrapped.length === 0` and the `rewrapDEKs` RPC is never sent (`reencrypt.ts:166-185`). A conforming client reading the server's result-array response reaches the destructive UPDATE today; fixing C-09 exposes it to normal SDK rotation. `complete_rewrap` (`epochs.rs:61-83`) only clears the flag.

### C-05 (Write authorizes admin lifecycle RPCs)

`membership_revoke.rs:61`, `epoch.rs:52` (begin) and `:142` (complete) all call `authz::authorize_write_space` → `authorize_space(..., Permission::Write)` (`authz.rs:27-34`); `Permission::Write = 2 < Admin = 3` (`crates/auth/src/permission.rs:5-11`). Revocation target is only checked non-empty (`membership_revoke.rs:37-46`). SDK policy claims admin-only for removal (`space-manager.ts:734-735`) and epoch advance (`:1019-1022`). Chain-validation and revocation checks in `authz.rs:59-76` apply to the *caller's* chain and do not constrain the target.

### C-06 (min key generation never enforced on network pushes)

`records.rs:258-271`: the `min_key_generation` rejection runs only when `opts` is `Some` and `key_generation > 0`. The blanket API adapter `ws/storage.rs:138-140` calls `RecordStorage::push(self, space_id, changes, None)`; both network paths use it (`ws/rpc/handlers.rs:380` client push, `ws/rpc/federation_sync.rs:134` federation push). `epoch.begin` does accept `set_min_key_generation` (`epoch.rs:64-68`), but the enforcement point is unreachable from network pushes; `complete_rewrap` (`epochs.rs:61-83`) clears the flag without verifying wrapper generations.

### C-11 (post-rotation invitations label the current key epoch 1)

`space-manager.ts:312-322`: invite payload carries `space_key` from the persisted (possibly epoch-e) record but no generation — the wire type's optional `metadata.generation` (`invitations.ts:22,34,1777`) is never populated by the inviter. Receipt hardcodes `epoch: 1` (`:1359`); `accept` builds the sync stack from the stored record (`:402-409`, `epoch: spaceRecord.epoch`). Consequence as reported: invitee holds K_e labelled epoch 1; wrappers at epoch j≠label derive from the wrong base, and later `adoptServerEpoch` also derives from the mislabeled base.

### C-07 (incidental; conflict-string mismatch)

`epoch.rs:81-91` returns the conflict as an ordinary result with `error: ERR_CODE_CONFLICT`; `core/src/protocol/rpc.rs:16` defines it as `"conflict"`. SDK `advanceEpoch` only recognizes `"epoch_conflict"` (`reencrypt.ts:74-84`) and otherwise returns success. Verified both halves while reading `epoch.rs`; matches the C-07 report.

## Exit code / assertions / skipped tests

- Harness: exit code 0; 7/7 checks passed (assertions inlined above).
- Source re-verification: every claimed link located and read at the pinned HEADs; no full test suites run (coordinator owns baselines).

## Result

- C-09: **fail** (defect reproduced against real client code) — evidence above.
- C-01, C-02, C-03 (qualified), C-05, C-06, C-11 (+C-07): **source-only confirmed**; no runtime reproduction attempted beyond C-09 per assignment scope.

## Seed / schedule / reproduction steps

- Harness is deterministic (no randomness beyond synthetic DEK bytes). Copy `harness.mjs` essence, point `ROOT` at the workspace, run with Node ≥ 22 (uses queueMicrotask/ESM; developed on v24.21.0). Requires the repo's `betterbase/js/node_modules` (typescript + cborg) — no install performed.

## Sanitized output or artifact links

- Harness location: `/var/folders/.../T/opencode/sync-c09/harness.mjs` (session temp; essence embedded above). No credentials, real tokens, or key material appear in this record; the mock token/UUIDs/DEKs are synthetic.

## Limits: mocks, unsupported environments, untested paths, or unreproduced claims

- The harness replaces the network with an in-process mock WebSocket and scripts only `deks.get`/`deks.getFiles` responses; it does not run the real server, real auth, or a full rotation. The downstream zero-rewrap completion (`rewrapAllDEKs` → `epochComplete` → persist) is verified by source (the loop over an empty array is deterministic), not executed — executing it needs the WASM crypto layer (key-cache derivation calls `ensureWasm`), which is out of cheap scope.
- C-01/C-02/C-03/C-05/C-06/C-11 remain source-argument confirmations; the concrete interleavings (retained subscription + old key reading a new broadcast; cursor commit vs apply crash; concurrent push/rewrap in PostgreSQL; non-admin RPC invocation; stale-generation push; invite-after-rotation) were not executed.
- `vm.runInThisContext` (rather than a fresh-realm sandbox) was chosen so the SDK's `data instanceof ArrayBuffer` check passes; the transpiled module still consists of the unmodified pinned sources.
- Review 07's claims were all re-verified and stand; its C-01 line refs (`realtime.rs:291`, `ws/mod.rs:22`, `482`) and C-09 line refs checked out. Minor line corrections to review 03 are recorded under C-01 above; its `space-manager.ts:1068-1088, 1536-1549` refs are accurate.
