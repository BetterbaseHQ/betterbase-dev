# Inference review

2026-09-20. Baseline `bf36ba4bb9cd9fcd632ba91b4825b0d872edfea6`. Coordinator reviewed all 16 Rust source files, configuration, README, Docker/build/CI configuration and existing tests. No product changes. All 25 native tests pass with local socket access; the first sandboxed run had one listener-permission failure and is not classified as a product failure.

## D-01 — Documented usage sends plaintext through the advertised E2EE proxy

**High confidentiality integration/claim defect; confirmed by source. INV-04.**

`README.md:5–32` promises the proxy never sees plaintext and says it adds attestation headers. The quick-start request at `:53–58` sends ordinary JSON. `src/server/handlers.rs:113–196` forwards any body and only copies optional backend headers. `src/backend/tinfoil.rs:15,42–44` lists two forwarded headers; it does not encrypt, generate attestation, require encryption, or verify an enclave. The intended secured client is not implemented in the checked-in example apps.

Thus following the documented request exposes plaintext to this proxy. A correctly encrypting and attesting external client could use this transport securely; absence of proxy-side decryption is not a defect in that architecture. The defect is an unconditional product guarantee and insecure documented integration with no verified client path. Tinfoil's [official JavaScript SDK documentation](https://docs.tinfoil.sh/sdk/javascript-sdk) places encryption and attestation verification in the client. No real Tinfoil inference request or paid service call was made. Attestation failure and downgrade behavior remain untested.

## D-02 — Production defaults omit issuer and audience restrictions

**Medium; conditional token-confusion risk confirmed by source. INV-04.**

`src/config.rs:23–29`, `src/main.rs:37–38,101–113`, and `src/auth/jwt.rs:138–151` permit empty expected issuer/audiences. The production README example configures only JWKS and API key. Any correctly signed token from that JWKS with the necessary subject/client/scope can therefore pass regardless of its intended recipient; `inference` scope is checked, but audience is not unless configured.

Counterevidence: ES256, signature, expiration and required subject/client checks exist. This is not acceptance of arbitrary unsigned tokens or any unrelated issuer's key. Exploitability depends on the same signing authority issuing inference-scoped tokens for another audience. Startup warning is present; no fail-closed production requirement exists.

## D-03 — Unknown key IDs repeatedly refresh JWKS before rate limiting

**Medium availability risk; confirmed source path. INV-07.**

`src/auth/jwks.rs:83–134` refreshes whenever a `kid` is absent, including after acquiring the refresh mutex, with no negative cache/cooldown. Requests with unknown keys trigger repeated outbound requests. `src/server/middleware.rs:35–56` performs validation before handlers' per-user rate limiter, so these requests do not consume a validated user's bucket. The mutex serializes requests but does not deduplicate absent-key refreshes.

JWKS response limits are checked after `resp.bytes()` (`jwks.rs:165–168`), so the stated 1 MiB limit is not a streaming allocation bound. Fetch timeout is 10 seconds. Cached known keys bypass refresh while fresh; this limits the impact claim. No load test was performed.

## D-04 — Streaming/public proxy routes have no aggregate resource bounds

**Medium availability/cost risk; confirmed missing controls. INV-07.**

`server/handlers.rs:68–73` sends public HPKE requests directly upstream, including backend authentication, outside the per-user limiter. Request bodies stream without a size cap (`:138–168`). The 60-second timeout bounds execution up to response headers, while the returned response stream has no idle/duration or concurrency budget (`:181–228`). A rate limit on new authenticated requests cannot bound accumulated slow streams, and there is no global limiter for the public proxy route.

Streaming avoids buffering the full inference body and downstream cancellation drops the body stream; those are useful properties. A sustained abuse/cost amount is not measured. The production reverse proxy is outside this standalone service and has no provided inference deployment in the root stack.

## Additional observations and coverage limits

- Logs normally include path/status rather than body/token, but upstream-error logging includes the user-controlled raw query as part of `upstream_url`; sensitive query parameters would be logged.
- JWKS stale-key fallback has no maximum stale horizon. Define removal/compromise policy separately from transient outage tolerance.
- JWK parsing validates curve points but does not enforce JWK `use`/`alg`; JWT verification itself is restricted to ES256.
- `Claims.aud` accepts arrays only although audience strings are also a standard representation; current Betterbase-issued arrays are compatible.
- No production TEE, attestation verifier, live upstream cancellation/load test, proxy header conformance test, or multi-instance limiter test was exercised. Current tests mainly cover auth, key parsing, URL composition and token-bucket helpers.

The architecture is small and readable. Its largest missing contract is who establishes and verifies the encrypted client-to-enclave session; the generic byte proxy cannot establish that guarantee on its own.
