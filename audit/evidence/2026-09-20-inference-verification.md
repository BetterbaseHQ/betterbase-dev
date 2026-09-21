# Evidence: inference findings re-verification (D-01..D-04) + native test suite baseline

- Date / reviewer: 2026-09-20; inference verification agent (wave 2). Analysis/verification only; no product code changed, no dev/e2e services touched, no commits, no external network calls, no Tinfoil requests.
- Finding and invariant IDs: D-01, D-02, D-03, D-04 from [04-inference](../reviews/04-inference.md); INV-04, INV-07.
- Repository revisions / local patch: betterbase-inference `bf36ba4bb9cd9fcd632ba91b4825b0d872edfea6` (pinned baseline), verified via `git rev-parse HEAD` + `git status --short` (empty) before and after. Clean; no local patch.
- Lockfile hashes / generated artifact provenance: `Cargo.lock` sha256 `81d43fef3cbb3c21e71ad9d61f84400345fef31613219e4cc730afd05afe87a8` (last touched by commit `a5e69b39a3dc93f29b38a473c664cd6a82c11d22`, 2026-09-18). Test binary built by cargo from pinned source; pre-existing `target/` artifacts were fingerprint-verified (no stale-code risk).
- Tool versions / operating system / browser: rustc 1.98.1 (48a229cea 2026-09-01); cargo 1.98.1 (797e8a9bc 2026-08-05); active toolchain `1.98.1-aarch64-apple-darwin` (pinned via `RUSTUP_TOOLCHAIN` environment variable in this shell). macOS (darwin, arm64). No browser used.
- Non-secret configuration / isolated services: none required. `cargo test` only; the sole socket-binding test (`auth::devmode::tests::test_devmode_roundtrip`) binds `127.0.0.1:0` in-process. No external services contacted; dev/e2e docker stacks untouched.
- Working directory and exact command or source-inspection method:
  - Tests: `cargo test` in `/Users/nchapman/Code/betterbase-dev/betterbase-inference`.
  - Source: independent re-read of all 16 files under `src/` plus `README.md`, `Cargo.toml` at the pinned revision; cross-repo greps for encrypting-client absence (`rg -i 'tinfoil|hpke|Ehbp|EHBP'` over `betterbase-examples/**`, `betterbase/js/**`, `e2e/**` → zero matches in `*.{ts,tsx,js,rs}`).

## Check 1 — Native test suite (executed)

- Expected behavior: the repo's own suite compiles and passes at the pinned baseline, giving the coordinator a centrally recorded run (a prior 25/25 run was never recorded).
- Observed behavior: compile finished ("Finished `test` profile [unoptimized + debuginfo] target(s) in 0.15s" — incremental against existing artifacts of this exact commit; cargo fingerprint check passed), then:

```
running 25 tests
test auth::jwks::tests::test_parse_unsupported_key_type ... ok
test config::tests::test_parse_audience_list_all_empty ... ok
test auth::jwks::tests::test_parse_invalid_curve_point ... ok
test config::tests::test_parse_audience_list_filters_empties ... ok
test config::tests::test_parse_audience_list_trims_whitespace ... ok
test server::middleware::tests::test_has_scope ... ok
test server::proxy::tests::test_invalid_base_url ... ok
test server::proxy::tests::test_empty_raw_query ... ok
test server::proxy::tests::test_preserves_query ... ok
test server::proxy::tests::test_trims_base_path ... ok
test server::ratelimit::tests::test_allow_consumes_and_exhausts ... ok
test server::ratelimit::tests::test_cleanup_removes_stale_buckets ... ok
test server::ratelimit::tests::test_rate_limit_key_no_hash_key ... ok
test server::ratelimit::tests::test_rate_limit_key_different_keys ... ok
test server::ratelimit::tests::test_rate_limit_key_different_inputs ... ok
test server::ratelimit::tests::test_rate_limit_key_null_separator ... ok
test server::ratelimit::tests::test_rate_limit_key_with_hash_key ... ok
test auth::jwks::tests::test_parse_valid_jwk ... ok
test auth::jwt::tests::test_wrong_algorithm_hs256 ... ok
test auth::jwks::tests::test_cache_hit ... ok
test auth::jwt::tests::test_invalid_audience ... ok
test auth::jwt::tests::test_expired_token ... ok
test auth::jwt::tests::test_invalid_issuer ... ok
test auth::jwt::tests::test_valid_token ... ok
test auth::devmode::tests::test_devmode_roundtrip ... ok

test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

- Exit code / assertions: exit 0. Counts exactly: **25 passed / 0 failed / 0 ignored / 0 measured / 0 filtered out** (3 config, 4 jwks, 5 jwt, 1 middleware, 4 proxy, 7 ratelimit, 1 devmode).
- Prior-run listener failure: NOT reproduced. The only test binding a listener is `test_devmode_roundtrip` (`TcpListener::bind("127.0.0.1:0")`, devmode.rs:95); it passed here. This supports the prior classification of that failure as environmental (sandbox deny on socket bind), not a product defect.
- Result: **pass** (25/25).

## Check 2 — D-01 source chain: documented plaintext-through-E2EE-proxy mismatch (source-only)

- Expected behavior (invariant INV-04): a service advertised as "never sees plaintext inference content" with attestation must not have its documented quick-start send plaintext through it with no proxy-side or client-side encryption/attestation step.
- Observed behavior (chain confirmed; no defeating check found):
  1. `README.md:5` — "Requests are encrypted end-to-end … the proxy authenticates and rate-limits but never sees plaintext inference content"; `README.md:28` — "The proxy adds Tinfoil's EHBP … headers for cryptographic attestation, proving the request was handled inside a genuine TEE." (Review cited 5–32; precise anchor lines are 5 and 28.)
  2. `README.md:49–53` — quick-start curl sends ordinary JSON (`-d '{"model": "gpt-4o-mini", …}'`, payload at :52) with only Authorization + Content-Type headers; no encryption or attestation step. Correction: review cited `:53–58`; actual quick-start request block is `:49–53` (production example at `:57–61` likewise sends nothing extra).
  3. `src/server/handlers.rs:110–224` `proxy_to_backend` — forwards any body verbatim as a stream (`:154–157`, comment at `:130` "no buffering/size cap") and copies only Content-Type (`:138–140`), Accept (`:143–145`), and the backend's optional forward headers (`:148–152`). (Review's ~113–196 ≈ URL-build/forward/execute span; precise function range 110–224.)
  4. `src/backend/tinfoil.rs:15` — `FORWARD_HEADERS = ["Ehbp-Encapsulated-Key", "Ehbp-Response-Nonce"]`: two pass-through headers, copied only if the client already sent them. `authorize_request` (`:37–44`; review said 42–44 — corrected to 37–44) merely injects the Tinfoil Bearer API key. `transform_path` (`:50–52`) is identity. Nothing in the backend or proxy encrypts, requires encryption, generates attestation, or verifies an enclave.
  5. No encrypting/attesting client exists in-repo or platform-wide: greps for `tinfoil|hpke|Ehbp|EHBP|inference.tinfoil` over `betterbase-examples/**`, `betterbase/js/**` (SDK), and `e2e/**` returned zero source matches; betterbase-inference itself has no `examples/` directory.
- Counterevidence honored: with Tinfoil's intended client-side EHBP/HPKE encryption (encryption + attestation verification live in the client per Tinfoil's SDK model), a generic byte-proxy without proxy-side decryption is architecturally sound — the defect is the unconditional README guarantee plus an insecure documented integration with no checked-in secured client path. No Tinfoil endpoint was contacted.
- Result: **source-only (confirmed)**; minor line-reference drift corrected (README quick-start 49–53; tinfoil.rs authorize_request 37–44).

## Check 3 — D-02 source chain: empty issuer/audience acceptance (source-only)

- Expected behavior (invariant INV-04): token validation should bind acceptance to the intended recipient(s) of this service.
- Observed behavior (chain confirmed):
  1. `src/config.rs:23–29` — `issuer: Option<String>` (`:24–25`), `audiences: Option<String>` (`:27–29`); no default, not required.
  2. `src/main.rs:37–38` — `unwrap_or_default()` yields empty strings when unset; `:105–109` maps empty audiences to `vec![]`; `:111–113` logs only a `warn!` ("tokens from any issuer/audience will be accepted") and continues; `:144–149` constructs the `Validator` with those values. No fail-closed path.
  3. `src/auth/jwt.rs` — issuer checked only `if !self.issuer.is_empty()` (`:127–130`); audience checked only `if !self.audiences.is_empty()` (`:132–139`). Correction: review cited `:138–151`; actual conditional iss/aud block is `:127–139`. `validation.validate_aud = false` at `:113` (library check disabled in favor of the manual one).
  4. `inference` scope remains required regardless: `handlers.rs:93–107` `require_inference_scope`, applied in `models` (`:43–45`) and `chat_completions` (`:58–60`) after the rate-limit check.
- Counterevidence confirmed: ES256-only pin (`jwt.rs:86–91`), `exp` required (`:114`), signature verified (`:117–123`), `sub` required (`:142–144`), `client_id` required (`:147–149`). So acceptance is not "any token": it must be signed by a key in the configured JWKS with scope+sub+client_id. The conditional framing holds — confusion arises only if that same signing authority issues inference-scoped tokens intended for a different audience. README production example (`:57–61`) configures only `JWKS_URL` + `TINFOIL_API_KEY`, matching the exposed-default scenario; the startup warning (`main.rs:111–113`) exists but does not fail closed.
- Result: **source-only (confirmed, conditional)**; line drift corrected (jwt.rs 127–139).

## Check 4 — D-03 source chain: unknown-kid JWKS refresh amplification (source-only)

- Expected behavior (invariant INV-07): unauthenticated/invalid input should not drive repeated outbound fetches ahead of rate limiting.
- Observed behavior (chain confirmed):
  1. `src/auth/jwks.rs:75–117` `get_key_bytes`: fast path (`:77–84`) and post-mutex double-check (`:90–97`) return early only when the kid **is present** and the cache is fresh; an absent kid always proceeds to `refresh()` (`:100`) even though the previous refresh just updated `last_fetch` (`:159`) — absence is never negatively cached or cooldown-gated. After refresh, an still-unknown kid returns `KeyNotFound` (`:111–116`) with no state recorded, so the next request with the same kid refreshes again. The refresh mutex (`:87`) serializes concurrent refreshes but does not deduplicate them (waiters re-check only for key presence, then refresh themselves). Correction: review cited `:83–134`; precise logic span is `:75–117` (refresh impl `:134–162`).
  2. Ordering: `middleware.rs:18–45` `auth_middleware` validates the token (`:35`) before handlers run; the per-user limiter is applied inside handlers (`handlers.rs:40–42` and `:55–57`, via `check_rate_limit` `:73–90`). Requests with unknown kids therefore fail at 401 without ever consuming a user bucket, and unauthenticated senders can trigger the refresh path.
  3. Size limit is not a streaming bound: `refresh()` buffers via `resp.bytes().await` (`:141`) and only then checks `body.len() > MAX_JWKS_SIZE` (`:142–144`; `MAX_JWKS_SIZE = 1 << 20` declared at `:13`). Correction: review cited `:165–168`; actual `:141–144`.
  4. Fetch timeout 10s (`jwks.rs:60–62`). Fresh cached known keys bypass refresh (`:79–84`, `:91–97`) — impact limited to unknown-kid traffic, as the review stated. No load test performed (out of scope).
- Result: **source-only (confirmed)**; line drift corrected (75–117; 141–144).

## Check 5 — D-04 source chain: streaming/public routes without aggregate bounds (source-only)

- Expected behavior (invariant INV-07): public and streaming proxy paths should have some aggregate resource/cost bound (size, duration, concurrency, or global rate).
- Observed behavior (chain confirmed):
  1. `handlers.rs:65–70` `hpke_keys` — registered as a **public** route (`server/mod.rs:37–39`, no auth middleware layer), performs no rate-limit check, and calls `proxy_to_backend`, which at `:168` calls `backend.authorize_request(...)` — i.e., the Tinfoil Bearer API key is attached to an unauthenticated, unlimited-request upstream fetch. Correction: review cited `:68–73`; actual handler is `:65–70` (auth injection at `:168`).
  2. Request bodies stream with no size cap: `handlers.rs:130` (comment), `:154–157` (`body.into_data_stream()` → `reqwest::Body::wrap_stream`); no length limit anywhere in the client construction (`main.rs:200–205`).
  3. The 60s timeout wraps only `state.http_client.execute(proxy_req)` (`handlers.rs:171–175`), which resolves once response **headers** arrive; the returned stream (`:205–214`, `Body::from_stream(resp.bytes_stream())`) is outside any timeout, with no idle or duration budget. The reqwest client sets only `connect_timeout(30s)` and pool options (`main.rs:200–205`); no read timeout (documented as intentional in the repo's AGENTS.md). Correction: review cited `:181–228`; precise spans `:170–195` (execute/timeout) and `:197–223` (response streaming).
  4. No global limiter exists for public routes (`mod.rs:34–39` layers only protocol-version + logging); the per-user token bucket (`ratelimit.rs:39–63`) counts request starts only, so accumulated slow streams are unbounded by construction. Aggregate-unbounded characterization confirmed.
- Counterevidence honored: streaming avoids full-body buffering, and downstream cancellation drops the body stream (reqwest stream tied to response lifetime) — real but insufficient mitigations; no sustained-abuse amount was measured (no load test, per scope).
- Result: **source-only (confirmed)**; line drift corrected (hpke handler 65–70; timeout/stream spans 170–195, 197–223).

## Check 6 — Additional observations spot-check (source-only)

- Query in upstream-error logs: confirmed. `handlers.rs:114` takes `req.uri().query()` (user-controlled), `:116` embeds it in `upstream_url` (via `proxy.rs:23–27` `set_query`), and it is logged in `error!(url = upstream_url, …)` on upstream failure (`:181`) and timeout (`:190`). Sensitive query parameters would reach logs.
- `Claims.aud` arrays-only: confirmed. `jwt.rs:14` — `aud: Option<Vec<String>>`; a standard string `aud` fails serde decode → `InvalidToken` (rejected, not mis-accepted). Absent `aud` is tolerated, which matters only when audiences are unconfigured (D-02). Betterbase-issued array audiences are compatible.
- JWK `use`/`alg` not enforced: confirmed. `jwks.rs:49–52` parses both fields but marks them `#[allow(dead_code)]`; `parse_jwk_entry` (`:167–190`) checks only `kty == "EC"`, `crv == "P-256"`, and point validity (`:193–203`). JWT verification itself pins ES256 (`jwt.rs:86–91`), bounding the practical impact.
- Result: **source-only (confirmed)** for all three.

## Aggregate

- Expected behavior: INV-04/INV-07 hold for the inference proxy's documented usage, token acceptance, and resource bounding.
- Observed behavior: D-01, D-02 (conditional), D-03, D-04 confirmed by complete independent source traces at the pinned revision; native suite 25/25 pass (exit 0) now centrally recorded. No defeating checks found for any chain; only line-reference drift corrected as noted.
- Exit code / assertions / skipped tests: `cargo test` exit 0; 25 passed / 0 failed / 0 ignored / 0 measured / 0 filtered out; prior-run environmental listener failure not reproduced (classification upheld).
- Result: **pass** for the test suite; **source-only (confirmed)** for D-01, D-02 (conditional), D-03, D-04 and the three spot-check observations.
- Seed / schedule / reproduction steps: deterministic — `git -C betterbase-inference rev-parse HEAD` (expect `bf36ba4…`), `cargo test` (expect 25/25), then source reads at the line ranges above.
- Sanitized output or artifact links: inline above; no credentials, tokens, API keys, or private data included (test keys are process-ephemeral P-256 keypairs generated by the suite itself).
- Limits: no HTTP-level execution against a running server, no Tinfoil/TEE interaction, no attestation-verification or downgrade testing, no load/slowloris measurement for D-03/D-04 (magnitudes unmeasured); wiremock is a declared dev-dependency but no test currently exercises HTTP mocking of the proxy path; D-02 exploitability remains contingent on the issuer's token-issuance policy (accounts-side, out of this repo); findings refer to the pinned baseline `bf36ba4` and may drift after future fixes.
