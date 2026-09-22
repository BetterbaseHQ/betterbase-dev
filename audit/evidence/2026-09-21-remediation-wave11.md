# Remediation wave 11 — the final four (AUD-013/014/018/023)

Date: 2026-09-21. Scope: remaining open findings — accounts ×2, SDK ×1, json-joy-rs ×1. Register: 56 → **60/60 — remediation complete**.

Baselines: betterbase `eecda45`, accounts `fb3c5f1`, json-joy-rs `11e07a3`, examples `6ad8514`. Fix commits: accounts `df7af27`, betterbase `607b3a6`, json-joy-rs `410e199`, examples `1d766e2` (CI pins). Release re-pinned after fixes.

## Work packages

- **AUD-013 (refresh scope):** grant UPSERTs track the current authorization's scope; refresh re-validates grant scope against client policy (`invalid_grant` on withdrawal). Route tests pin both directions, red on parent.
- **AUD-014 (code race):** `consume_verification_code` — one row-locked transaction replacing the per-statement snapshot flow; the audit's two SQL reproductions (duplicate success, attempt-bound overrun) are mirrored as live-PG concurrency tests (exactly one `Consumed`; exactly five counted wrong attempts).
- **AUD-018 (sid truncation):** producer-side mask + hard rejection at all three sid entry points (`create_model`, `create_model_with_schema`, `model_load` — covers JS-supplied `PutOptions.sessionId`); codec-side `debug_assert` guards in `vu57`/`b1vu56` (wire format unchanged). The audit's exact repro value now errors instead of encoding as 65536.
- **AUD-023 (leadership leak):** `TabCoordinator.create` releases the election lock when init fails; failed promotion releases the lock, resets `promoting`, and re-arms follower listening. Two node-pool tests (browser seams mocked), red on parent.

## Verification

- accounts: enforced DB gate (`just test-db` conditions; full workspace 96 tests incl. 4 new consume + 2 new refresh tests), fmt, clippy, web check — exit 0. New sqlx queries prepared into `.sqlx` (cache regenerated against migrations).
- betterbase: `just check` exit 0 — Rust suites (betterbase-db 153), TS typecheck, 521 node tests (+2), 200 browser tests on rebuilt WASM.
- json-joy-rs: `just check` exit 0.
- Platform: `just check-all` exit 0; `just e2e` **125 passed + 3 skipped (4.4m), faults 3/3 (50.2s)**.
- `just check-release` passes against the re-pinned release.toml; examples CI sibling refs byte-match the pins.

## Review results

Independent adversarial review: **PASS** AUD-013/014, **PASS-with-notes** AUD-018/023 (no FAILs). The reviewer re-ran the accounts enforced DB gate live (96/96) and verified red-on-parent, lock semantics, codec math, and release/CI pin equality. Its findings and dispositions:

- **IMPORTANT — AUD-018 upgrade regression (fixed)**: the persisted `META_SESSION_ID` was loaded unmasked, and ~99% of pre-fix databases hold an out-of-range sid → every put/patch would hard-error after upgrade. Fixed in `betterbase f08a442`: mask at load reproduces exactly the identity the old codec already encoded; integration test seeds the audit's legacy value (red on pre-mask parent). Record residual rewritten (the old "repair would require re-signing" claim was wrong — masking is exact).
- **MINOR — AUD-023 (fixed)**: failed `create` leaked the Worker (now terminated, close-parity, test extended); `onPromoted` catch could re-arm a listener on a closed coordinator (now guarded). Residual added: a failed-promotion tab is leader-ineligible for its lifetime — sole-tab case needs reload (still strictly better than blocking all tabs).
- **MINOR — register corruption (fixed)**: wave 6 had pasted fix text into the *finding* column of AUD-027/036/045/047/048/052 and left State "Open" — the "60/60" count was bookkeeping fiction. All six rows repaired from pre-wave-6 git history (finding text restored, State → Fixed); 0 Open states remain, making 60/60 real.
- **MINOR — AUD-013 (noted)**: authorize→exchange policy-withdrawal window documented as pre-existing residual.

Post-fix verification: betterbase `just check` exit 0 (Rust incl. new integration tests, 521 node + 200 browser), platform `just check-all` exit 0, `just e2e` 125+3 passed + faults 3/3, `just check-release` passing, examples CI pin byte-matches the re-pinned release.toml.

Final component revisions (release.toml): betterbase `f08a442`, accounts `df7af27`, sync `a657e6b`, inference `8190318`, examples `85c606e`, json-joy-rs `410e199`.
