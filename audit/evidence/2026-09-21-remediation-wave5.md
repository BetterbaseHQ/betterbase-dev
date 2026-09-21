# Remediation wave 5 — SDK Highs + wave-4 residuals

Date: 2026-09-21 · Scope chosen by operator: "SDK Highs + residuals (Recommended)" · Repos: json-joy-rs, betterbase, betterbase-accounts

## Items

| ID | What | Commits |
|---|---|---|
| AUD-020 | Native RMW serialization (B-04) | betterbase `2faaf0d` |
| AUD-021 | Decoder EOF bounds (B-05) | json-joy-rs `4cb1ade` |
| Residual AUD-008/009 | Consent carries root version | betterbase-accounts `44be272` |
| Residual AUD-012 | Credential/key snapshot binding | betterbase `0aa9298` |

## AUD-020 — native read/modify/write lacks an encompassing lock

The cross-review's correction was confirmed in code: `SqliteBackend::transaction` released the connection guard after its SAVEPOINT statement and only re-locked for RELEASE — the closure ran unlocked, so "explicit transaction" serialized nothing. The adapter additionally ran `put`/`patch`/`delete`/`mark_synced` as three separate backend calls (read → prepare → write) with no transaction at all.

Fix: the guard is held across the entire closure (reentrant for the closure's own SQL, blocking for other threads), and every single-record RMW runs inside one transaction via backend-parameterized cores; bulk operations drive the cores directly (one savepoint, no nesting). Session-id and unique-check helpers gained backend-parameterized variants so meta reads and constraint checks join the caller's transaction.

Regression: `tests/storage/concurrency.rs` uses a pass-through `PausingBackend` that pauses a read mid-RMW while a second thread completes a full operation. `concurrent_delete_cannot_be_resurrected_by_in_flight_patch` was **run against the pre-fix transaction implementation and failed exactly as reported** (`delete was lost or the record was resurrected: del=true, resurrected=true`); it passes after the fix. The mark_synced variant pins acknowledgements against concurrent patches.

## AUD-021 — structural decoder trusts declared counts past EOF

Confirmed the reproduction: `[0x80, 0x01, 0x01, 0x7F, 0xA0, 0x8D, 0x06]` (7 bytes) declared a 100000-element vector and decoded 100000 null slots; `decode_vec_logical` panicked outright past EOF via a direct index.

Fix: a `require_input` guard at every count-driven element iteration (twelve loops across server/logical obj/vec/str/bin/arr including nested arr spans — every element consumes ≥1 byte, so well-formed input is never rejected), rejection of binary chunk spans shorter than declared, and an off-by-one tightening in `read_cbor_value`. Divergence from upstream (which materializes zeros) documented in `tests/compat/PARITY_AUDIT.md` per the repo's non-negotiable rules. All json-joy-rs gates pass (fmt, clippy `-D warnings`, test-gates, test — 97 suites; parity fixtures unaffected).

## Residual: consent stranded under retired root (AUD-008/009)

Consent submissions now carry `root_key_version` (the version of the root key the client derived its material under) and the server CAS-checks it against the committed account version at install time — both the atomic bundle path (`install_consent_key_bundle` → `ConsentKeyInstall::StaleRoot` → 409 `invalid_grant_state`) and the legacy wrapper-only path (`update_grant_wrapped_scoped_key_root_checked` → `RootKeyVersionConflict` → same 409). The grant lock is taken before the version read; rotation locks the account row first — the ordering cannot deadlock, and a rotation committed before the install is visible to the check.

The web tracks the version in memory beside the root key: login already fetched it (AUD-009), signup/recover/change-password refresh it after their credential commits, and consent submits it. Route regression: `consent_bundle_rejects_material_derived_under_rotated_root` (409, nothing written, fresh-version retry succeeds).

## Residual: credential/key snapshot binding (AUD-012)

Keys were already written to IndexedDB before the localStorage credential commit; the missing half was recovery. `AuthSession.restore` now verifies the persisted manifest (`hasEncryptionKey`/`hasEpochKey`/`hasAppPrivateKey`) against IndexedDB and fails closed — removes the half-state, returns null, forces a fresh login — covering IndexedDB eviction with localStorage survival (Safari/ITP selective clears). Tests: `fails_closed_when_manifest_keys_missing` (no refresh attempted, state removed), `restores_when_every_referenced_is_present`.

## Verification

- json-joy-rs: `just fmt`, `just lint`, `just test-gates`, `just test` — all green (97 suites).
- betterbase: `just check` — 513 vitest + 200 browser, cargo tests incl. new concurrency suite; examples unaffected (browser path unchanged).
- betterbase-accounts: `cargo sqlx prepare`, `just check`, `just test-db` — green; web `pnpm check` 188 tests.
- Platform e2e after all four items: main phase **125 passed + 3 gated-skips**, fault-injection **3/3**.

Register: 31/60 fixed (was 29/60).

## Review results (appended after completion)

One code-reviewer agent covered all three repos' wave-5 deltas (empirical pre-fix runs in throwaway worktrees, PoC scratch crates for the decoder findings). Verdict: AUD-020's code correct with a clean deadlock analysis; AUD-012 residual well-implemented; **AUD-021 materially incomplete** — two CRITICAL gaps in the same trust boundary. All findings fixed:

- **CRITICAL — clock table (same file)**: `decode_logical`'s clock-table loop trusted declared `n`; a 10-byte input materialized a 2M-entry table, `Ok`. Fixed with a per-tuple 2-byte floor (json-joy-rs `7035e2a`); regression `truncated_clock_table_count_errors_instead_of_allocating`.
- **CRITICAL — patch decoder wholly unhardened**: op-count loop fabricated 1M ops from 6 bytes (`Ok`); `Vec::with_capacity(declared)` reservation bombs; betterbase feeds this decoder remote bytes (`patch_log.rs`). Fixed: per-op opcode-octet floor, InsObj/InsVec/InsArr/Del element guards, CBOR array/map reservations capped by remaining input, InsStr/InsBin declared lengths checked against remaining input (wasm32 cursor overflow), pre-reserves replaced by growth. Regression `truncated_op_count_errors_instead_of_fabricating`. Empty/short-but-complete inputs remain Ok (upstream parity pinned by `short_inputs_are_tolerated`).
- **IMPORTANT — sidecar/indexed codecs**: same unguarded loops + a library-path panic risk; hardened identically (13 guards, capped reservations, indexed gains `EndOfInput`).
- **IMPORTANT — vacuous/off-target regression tests**: the original gate paused *before* the read, so both tests passed on the true parent. Reworked: the gate now fires on `put_raw` (between read and write — the real window), waits for a pre-arranged concurrent op, and is thread-scoped so the concurrent op cannot consume it. **Verified on the true parent `84ca0df`: both tests fail** (delete resurrected; stale ack reverts the patch); on the fixed tree the concurrent op is provably blocked on the transaction lock — deterministic in both directions (betterbase `b36f94c`).
- **IMPORTANT — half-done bulk conversion**: `bulk_patch`/`delete_many`/`patch_many` still called public RMWs inside transactions (memory_mapped nesting breakage). Converted to the `_impl` cores.
- MINORs: bin chunk span compared in u64 (wasm32 truncation); session-id cache rollback divergence + lock-ordering invariant documented; IndexedDB read rejection in restore fails closed instead of throwing; surviving keys deliberately not swept on partial miss (peer-tab race documented); partial-miss and keyless-session tests added; PARITY_AUDIT scope note updated.
- Accepted/not changed: `epoch-derive-key` not in the restore manifest (written atomically with `epoch-key`; an unconditional check would false-positive the CryptoKey-only path); CBOR recursion depth remains input-bounded rather than depth-capped (same as upstream; noted).

## Final e2e (after all review fixes)

Main phase **125 passed + 3 gated-skips**, fault-injection **3/3** — against the hardened decoders on the real sync path.

Wave-5 commits (final): json-joy-rs `4cb1ade`, `7035e2a`; betterbase `2faaf0d`, `0aa9298`, `b36f94c`; betterbase-accounts `44be272`.

Register: **31/60 fixed**. Wave 5 complete.
