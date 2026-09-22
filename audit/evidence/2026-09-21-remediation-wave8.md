# Remediation wave 8 — inference cluster (AUD-041..044)

Date: 2026-09-21. Scope: the complete betterbase-inference finding cluster. Register: 43 → **47/60**.

Baseline: betterbase-inference `bf36ba4` (clean). Fix commit: `0316732` (single commit, all four findings).

## Work packages

- **AUD-042 (fail-closed binding):** `config::validate_auth_binding` requires non-empty `ISSUER` and ≥1 audience outside dev mode; `main.rs` exits at startup naming the missing variable. Dev mode exempt (it already defaults both). 4 unit tests.
- **AUD-043 (JWKS refresh floor + streaming cap):** every refresh attempt stamps `last_refresh_attempt` before fetching; attempts inside a 30s `REFRESH_FLOOR` are refused — stale-but-known keys serve from cache (matching the pre-existing failure fallback), unknown kids return `KeyNotFound` without fetching. Mutex waiters observing a fresh stamp skip their own fetch. Size cap: `Content-Length` precheck + chunk-accumulation enforcement (never buffer-before-check). 3 wiremock tests, including a 5-request unknown-kid burst proving exactly one upstream fetch.
- **AUD-044 (aggregate bounds):** request cap 10MiB default (`413` on declared oversize via `check_request_size`; `DefaultBodyLimit` streaming backstop on the protected router); response streams under 120s-idle/15min-total deadlines (`bounded_upstream_stream`, terminates with `TimedOut` and ends); global upstream semaphore default 64 (`429` fail-fast) covering the public hpke-keys proxy that attaches the Tinfoil API key. 4 tests + router wiring.
- **AUD-041 (High, honest E2EE claim):** README's unconditional "never sees plaintext" guarantee replaced with a prominent confidentiality note (encryption is the client's job; quick-start is plaintext; no reference EHBP client exists). New `REQUIRE_EHBP` flag rejects `/v1/chat/completions` without `Ehbp-Encapsulated-Key` (400); hpke-keys (bootstrap) and models (no user content) exempt. Production example updated to the now-required ISSUER+AUDIENCES. 1 test. Reference EHBP client documented as v1.x residual — no in-repo protocol spec exists to implement against; guessing a crypto protocol would be worse than an honest posture.

## Verification

- `just check` (fmt + clippy -D warnings + cargo test): **38 passed / 0 failed** (baseline 25 → +13 new tests).
- Contract check: `/v1/` route paths, `X-Protocol-Version: 1` unchanged. New 400/413/429 responses are either behind opt-in flags (REQUIRE_EHBP) or resource bounds on previously-unbounded paths (body/stream/concurrency caps; 10MiB default is ~1000x a typical chat payload).
- Platform `just check-all` (includes inference) and `just e2e`: run at wave close (results appended below).

## Residuals

- AUD-041: no checked-in reference EHBP client (v1.x work item; enforcement flag exists today).
- AUD-044: stream deadlines are fixed generous constants; >15min legitimate streams will be cut (documented in-code).

## Review results (appended after completion)

Independent review of `0316732`: **PASS** for AUD-042; **PASS-with-notes** for AUD-041/043; **FAIL for AUD-044** — the reviewer proved (against axum-core 0.5.6 source, with an empirical reproduction) that the claimed `DefaultBodyLimit` streaming backstop was inert for a streaming proxy, found the placeholder test vacuous, and that the semaphore permit dropped at response headers while streams lived on. All issues fixed in `f1ac02c`:

- **Wire-enforced body cap** (IMPORTANT): `DefaultBodyLimit` layer removed; the body is wrapped in `http_body_util::Limited` from our own config — chunked/lying bodies error the stream at the cap. Real tests replace the vacuous one (`test_chunked_body_over_cap_errors_stream`, `test_body_under_cap_streams_intact`).
- **Stream-lifetime permits** (IMPORTANT): the permit moves into the response stream and drops at stream end — the semaphore now bounds concurrent upstream *connections* including SSE streams; default 64→256, documented.
- **Records corrected** (IMPORTANT): AUD-044.md rewritten to describe actual behavior; this file amended.
- **Minors**: zero-valued knobs fail at startup; REQUIRE_EHBP no longer claims presence implies encryption; JWKS cooldown-recovery test added (floor delays, never blocks rotation); monotonic-clock subtraction removed from the stale-cache test; AGENTS.md env table deduplicated; clippy `--all-targets` clean (CI's justfile clippy omits it — flagged to wave 9 as a justfile follow-up).

## Final gates

betterbase-inference `just check` + `cargo clippy --all-targets -- -D warnings`: **42 passed / 0 failed**. Platform `just check-all` and `just e2e`: results below at close.

Wave-8 commits: betterbase-inference `0316732`, `f1ac02c`. Register: **47/60**.

**Platform gates (final):** `just check-all` green (includes inference 42/42; fixed an unrelated ~40%-flake in photos PhotoCard delete test — examples `86c6dc6`, sync `getByRole` raced the Mantine confirm-modal mount, now `findByRole`, 8/8 green). `just e2e` green: **125 passed + 3 skipped (4.4m), faults 3/3 (1.1m)**. Wave 8 complete. Register: **47/60**.
