# Evidence: handoff verification — sync findings (AUD-024, AUD-032, AUD-026)

- Date / reviewer: 2026-09-20 / handoff verification agent (second model, per [handoff brief](../handoff-critical-verification.md)).
- Finding and invariant IDs: AUD-024 (C-01), AUD-032 (C-09), AUD-026 (C-03); INV-03..05 as in the register.
- Repository revisions / local patch: betterbase-sync `324da35e30922dfd3ab53c2fb862e7272b2e72f1` (clean before and after), betterbase (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` (clean). No product file edited or committed.
- Lockfile hashes / generated artifact provenance: `/tmp` harnesses build path deps into the pinned checkouts with each repo's own locked dependency set (fresh `/tmp` target dirs); the C-09 harness transpiles the pinned SDK `.ts` sources with the SDK repo's own typescript 5.9.3 + cborg 4.5.8.
- Tool versions / operating system / browser: Node v24.21.0; rustc/cargo 1.98.1; PostgreSQL 18.6 (`betterbase-audit-postgres`, loopback 25432); macOS (darwin, arm64). No browser.
- Non-secret configuration / isolated services: throwaway databases `c03_demo` (real sync migrations 001-012) created and dropped in the audit container; in-process mock WebSocket (C-09) and in-process broker/subscriber stand-ins (C-01 delivery). All keys, DEKs, blobs, UUIDs synthetic. Dev/e2e stacks untouched.
- Working directory and exact command or source-inspection method:
  - Pass 1 (blind): read the pinned sources for each chain — sync server `crates/api/src/ws/{mod,realtime}.rs`, `ws/rpc/{membership_revoke,deks,handlers,push_helpers}.rs`, `ws/storage.rs`, `crates/realtime/src/broker/*`, `crates/storage/src/postgres/{epochs,records}.rs`, `crates/core/src/protocol/ws.rs`; SDK `js/src/sync/{space-manager,reencrypt,ws-client,rpc-connection,ws-frames,ws-client.test}.ts`, `js/src/crypto/epoch.ts`; SDK Rust `crates/betterbase-{crypto,sync-core}/src/{epoch,dek,transport,reencrypt,epoch_cache}.rs` — before reading any prior conclusion.
  - Pass 2 (comparison): `reviews/03-sync.md`, `reviews/07-cross-review-identity-to-sync.md`, `evidence/2026-09-20-sync-verification.md`.
  - Runtime (four executions):
    1. C-09 harness re-run: `node /var/folders/…/T/opencode/sync-c09/harness.mjs` (existing wave-1 harness; per the brief re-run, not rebuilt — and its mock frames were re-checked against primary definitions, see below).
    2. C-01 crypto half: `/tmp/betterbase-audit-c01` — `cargo run --quiet` (path deps on betterbase-sync-core + betterbase-crypto).
    3. C-01 delivery half: `/tmp/betterbase-audit-c01-broker` — `cargo run --quiet` (path dep on betterbase-sync-realtime; stand-in `Subscriber` impls feed the real `MultiBroker`).
    4. C-03 schedule: `docker exec -i betterbase-audit-postgres psql -U audit -d c03_demo -v ON_ERROR_STOP=1 < /tmp/betterbase-audit-c03/schedule.sql` after applying the real migrations.

## Expected behavior

- AUD-024: removing a member must (a) stop delivering subsequent push broadcasts (ciphertext + wrapped DEKs) to the revoked member's open connection, and (b) rekey with entropy the removed member cannot derive.
- AUD-032: `WSClient.getDEKs`/`getFileDEKs` must surface the DEKs the server returns.
- AUD-026: `rewrap_deks` must not overwrite a wrapped DEK whose underlying record changed after the rewrapper's read.

## Observed behavior (runtime)

### AUD-032 (C-09) — existing harness re-run, 7/7

```
PASS  A1: getDEKs against real server shape resolves WITHOUT error  — resolved with array
PASS  A2: getDEKs returns EMPTY array (2 DEKs were in the response)  — length=0, server sent 2
PASS  B1: plain rpc.call receives the ordinary result with all DEKs  — deks.length=2
PASS  C1: getDEKs with chunk frames populates all DEKs  — length=2
PASS  C2: chunked payload ids round-trip
PASS  D1: getFileDEKs against real server shape resolves with EMPTY array  — length=0, server sent 2
PASS  E1: count mismatch IS detected when _chunks present (guard exists but inert for deks.get)
7/7 checks passed (exit 0)
```

Independence-protocol check of the harness premises (brief §3): the mock frames were re-derived from primary definitions, not from the evidence file — `RpcResultFrame`/`RpcChunkFrame` serde field names at `betterbase-sync/crates/api/src/ws/rpc/mod.rs:504-530` (`{type,id,result}` / `{type,id,name,data}`), `DekRecord {id, dek(bytes), seq}` / `DeksGetResult {deks}` / `FileDekRecord {id, dek, cursor}` at `crates/core/src/protocol/ws.rs:540-605`, handler emission points at `deks.rs:50-60,191-201`. The harness's mock shape matches all of them; no discrepancy found between the harness and the pinned sources.

Test-gap survey (brief's flagged gap), completed repo-wide: the only JS test touching `deks.get` is `ws-client.test.ts:284-303`, which (a) scripts chunk frames the server never sends, and (b) uses a `wrapped_dek` property that exists in neither the server struct nor the client type (`dek`) — a mock that cannot fail against the real wire. `space-manager.test.ts:121` mocks `rewrapAllDEKs` entirely (rotation tests never touch the wire); the Rust `ws/tests.rs` handler tests stub storage (shape never crosses to the JS client); the e2e federation rotation test drives the real SDK path (`api.rotateSpaceKey`, `e2e/tests/federation.spec.ts:314-355`) and still passes **because** of the masking cross-review 07 identified — participants' existing transports retain the old base key and there is no fresh-device/new-transport read after rotation. **No test anywhere exercises the true wire shape.** The e2e "forward secrecy" test (`federation.spec.ts:370-427`) likewise only proves *cooperative-client* behavior (stock SDK discards local access on the revoked notification); it is not counterevidence for AUD-024.

### AUD-024 (C-01) — crypto half, 5/5 on real SDK crates

`/tmp/betterbase-audit-c01` (path deps on `betterbase-sync-core` + `betterbase-crypto` at the pinned SDK rev; mirrors the removal path's `deriveForward` exactly):

```
PASS  1: removal rekey K2 is derivable from retained K1 + public spaceId/epoch
PASS  2: post-removal record encrypted at epoch 2 (wrapped_dek prefix = 2)
PASS  3: revoked member with retained K1 decrypts post-removal content
PASS  4: member-derived K2 unwraps the epoch-2 wrapped DEK from the broadcast
PASS  5: negative control — unrelated key cannot decrypt (crypto is sound)
5/5 checks passed (exit 0)
```

Supporting product test at the pinned rev: `cargo test -p betterbase-sync-core forward_epoch_decryption` → `test result: ok. 1 passed` (SDK's own suite demonstrates old-key → future-epoch decryption). Derivation formula confirmed at `betterbase/crates/betterbase-crypto/src/epoch.rs:16-44`: `epoch_key_N+1 = HKDF-SHA256(epoch_key_N, salt="betterbase:epoch-salt:v1", info="betterbase:epoch:v1:{spaceId}:{N+1}")` — no input exists that only remaining members obtain.

### AUD-024 (C-01) — delivery half, 5/5 on the real MultiBroker

`/tmp/betterbase-audit-c01-broker` (stand-in connections implement the real `Subscriber` trait; `MultiBroker` unmodified):

```
PASS  1: admin, member and (soon-revoked) member subscribed to space
PASS  2: broadcast delivered to member + revoked member (sender excluded only); 2 recipients
PASS  3: generic revocation notice broadcast to all subscribers (incl. the revoked one)
PASS  4: POST-REVOCATION push broadcast still delivered to the revoked member's open connection
PASS  5: only the member's OWN socket closure removes it (lazy stale cleanup) — no server-side eviction on revocation
5/5 checks passed (exit 0)
```

The broker API itself accepts no authorization/revocation input on the broadcast path (`broadcast_space(space_id, exclude_id, payload)` — `crates/realtime/src/broker/multi.rs:157-207`): there is nothing a revocation could hook into; removal paths are only client `unsubscribe`, connection close, and lazy stale cleanup. Combined with `push_helpers.rs:31-45` (broadcasts carry `blob` + `wrapped_dek`), `ws/mod.rs:22,482-488` (1 h ±10 % jittered max lifetime → ≤ ~66 min), and the repo-wide subscription-lifecycle sweep (subscribe-time-only authz at `handlers.rs:262`; `membership_revoke.rs:82-86` only broadcasts), both halves of the finding now have independent runtime evidence.

### AUD-026 (C-03) — full sequential schedule on the real schema

`/tmp/betterbase-audit-c03/schedule.sql` against `c03_demo` (real migrations 001-012). Statement order mirrors the product exactly (R1 `get_deks` epochs.rs:86-108; A1 `advance_epoch` epochs.rs:28-34; W1 `push_records` records.rs:251-350 incl. space-row FOR UPDATE + existing-cursor CAS; R2 `rewrap_deks` epochs.rs:111-158 incl. FOR UPDATE key_generation + epoch-prefix check + `UPDATE records SET wrapped_dek WHERE id AND space_id`). **No concurrency is used — the schedule is fully sequential** (that is the finding: the rotator's observed state is never compared at commit time):

```
R1 observed: D1@epoch1, cursor 1
A1 UPDATE 1 (key_generation 1→2, rewrap_epoch=2; min_key_generation NOT raised — normal rotation)
W1: BEGIN; space cursor locked=1; existing cursor=1 (CAS passes); UPDATE (blob=C2, cursor=2, wrapped_dek=D2@epoch1); COMMIT
R2: BEGIN; key_generation=2 (FOR UPDATE); submitted_wrapper_epoch=2 == 2 (server check passes); UPDATE 1; COMMIT

FINAL: stored_blob=C2 (deadbeef02) | stored_wrapped_dek=D1@epoch2 | prefix=2 | cursor=2
ASSERTIONS: blob_is_c2_writer_version=t | wrapper_is_STALE_D1_rewrapped=t | writer_wrapper_D2_destroyed=t | passes_server_epoch_check=t
CONTROL (cursor CAS variant): guarded_update_rows_affected=0; wrapper unchanged
exit=0
```

The writer's stale-epoch push in W1 is accepted on **both** rotation paths because the WS storage adapter passes `PushOptions::None` (verified again at `ws/storage.rs:138-140`), so the `min_key_generation` gate never runs for network pushes (C-06) — including rotations that set it. Synthetic C1/C2 stand for distinct ciphertexts and D1/D2 for the DEKs that decrypt them (wrap/unwrap semantics runtime-proven in the C-01 harness above); the SQL layer demonstrates the identity-only UPDATE pairing the stored blob with the wrong wrapper.

## Exit code / assertions / skipped tests

- C-09 harness: exit 0, 7/7. C-01 crypto: exit 0, 5/5. C-01 broker: exit 0, 5/5. C-03: exit 0 (ON_ERROR_STOP), 4/4 defect assertions + control. SDK product test: 1 passed.

## Result

- AUD-024: **fail** (both halves reproduced at runtime on product code) — confirmed; Critical/High framing with the ≤~66-minute connection bound stands.
- AUD-032: **fail** (re-reproduced; harness premises validated against primary wire definitions; test-gap survey complete — no test exercises the true shape) — confirmed.
- AUD-026: **fail** (destructive interleaving reproduced sequentially on the real schema; masking-by-AUD-032 re-verified in source) — confirmed; must be fixed together with AUD-032.

## Seed / schedule / reproduction steps

- All deterministic. C-09: run the harness with `ROOT` at the workspace (needs `betterbase/js/node_modules`). C-01 harnesses: `cargo run` in their `/tmp` dirs. C-03: create `c03_demo`, apply `betterbase-sync/crates/storage/migrations/*.sql` in order, run `schedule.sql`, drop the DB (as done here).

## Sanitized output or artifact links

- Inline above. Harnesses: `/tmp/betterbase-audit-c01`, `/tmp/betterbase-audit-c01-broker`, `/tmp/betterbase-audit-c03/schedule.sql`, and the wave-1 C-09 harness (session temp). No credentials, real tokens, or key material.

## Pass-1 → pass-2 reconciliation (independence protocol)

- Blind derivations matched all prior chains (reports 03/07 and the sync evidence file, including its line corrections — `deriveForward` at `reencrypt.ts:354-371`, Rust test at `transport.rs:196-223`); no defeating check found in any refutation avenue. Sweep beyond the listed avenues: subscription lifecycle (subscribe/unsubscribe/close/stale are the only index mutations, repo-wide), `advance_epoch`/`complete_rewrap` CAS semantics, `decode_rewrap_deks` cursor handling, push `PushOptions` plumbing, and `_chunks` count-guard semantics.
- Refinements added: (1) C-03's stale-epoch writer push is reachable on **both** normal and `setMinKeyGeneration` rotations because the min-generation gate is disconnected from network pushes (C-06 adapter fact — prior record did not state this for C-03); (2) AUD-024's forward-derivation is additionally anchored by the product's own passing test (`forward_epoch_decryption`) and by the derivation formula being public-input-only (epoch.rs:16-44), which the prior record asserted via the JS path only.

## Limits: mocks, unsupported environments, untested paths, or unreproduced claims

- The full end-to-end two-WebSocket-client scenario (live sync server, JWT issuer + JWKS, delegated UCAN chain, revoke mid-session, scripted clients) was **not executed**. Rationale, recorded honestly rather than silently: both halves are independently established — crypto half on the real SDK crates (above; plus the product's own test) and delivery half on the real broker (above) — with the composition (push handler → `broadcast_push_sync` → broker → JS transport decrypt) verified by complete source traces; the remaining scenario would add integration evidence at significant harness cost (JWT/JWKS/UCAN/WS plumbing), and was judged lower marginal value than the identity route harnesses executed instead.
- C-01 broker harness uses in-process stand-in connections (real `Subscriber` trait, real broker); it does not exercise WebSocket framing, the JS-side notification handler, or the FST federation reconnect path — the last remains **unknown** exactly as the brief specifies (not verified as extending or narrowing the finding).
- C-03 uses synthetic blob/DEK bytes (identity-only UPDATE is the layer under test); AEAD failure for the mismatched pair is argued from the wrap/unwrap semantics proven in the C-01 harness, not executed against C2/D1 specifically. The psql schedule substitutes for the Rust `parse_dek_epoch` helper (same 4-byte BE prefix semantics, verified side-by-side).
- C-09 harness replaces the network with a scripted mock WebSocket (premises re-derived from primary definitions per the brief's independence protocol); no real sync server was run for it.
- Severity re-derivation: AUD-024 Critical/High is fair — a removed member passively decrypts post-removal pushes for the connection's remaining lifetime (≤~66 min; reconnect is denied), and the rekey-on-removal provides no cryptographic exclusion at all; given AUD-032, even correctly-executed rotations leave all pre-rotation DEKs at old epochs (indefinitely decryptable by a removed member with the old key), which pushes real-world impact toward Critical. AUD-032 High stands (platform-wide silent loss of rotation's purpose; masked at rest by retained in-memory keys until restart/new device). AUD-026 High stands (silent per-record decryptability loss, sequential legality, currently masked by AUD-032).
