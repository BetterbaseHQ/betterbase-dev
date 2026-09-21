# Evidence: handoff verification — identity findings (AUD-003, AUD-005, AUD-006)

- Date / reviewer: 2026-09-20 / handoff verification agent (second model, per [handoff brief](../handoff-critical-verification.md)).
- Finding and invariant IDs: AUD-003 (A-01), AUD-005 (A-03), AUD-006 (A-04); INV-04/05 as in the register.
- Repository revisions / local patch: betterbase-accounts `b7cda8872ee09cfad44f4186ff40096ee3c95483` (clean before and after, `git rev-parse HEAD` + `git status --short`); SDK `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` (clean; only its Rust crypto crates were read/run — none used here). No product file edited or committed.
- Lockfile hashes / generated artifact provenance: harness at `/tmp/betterbase-audit-identity` builds path deps into the pinned checkouts with the repo's own `Cargo.lock` dependency set (fresh `/tmp` target dir); no product build outputs entered the repos.
- Tool versions / operating system / browser: rustc/cargo 1.98.1 (mise shim), Node n/a for this file, macOS (darwin, arm64); PostgreSQL 18.6 in the disposable `betterbase-audit-postgres` container (loopback 25432). No browser (see limits).
- Non-secret configuration / isolated services: throwaway database `identity_demo` in the audit container (created and dropped for this run); in-process Axum router on `127.0.0.1:<ephemeral>`; issuer `https://accounts.synthetic.test`; CAP disabled (product disabled-mode pass-through, `cap` crate `verify()` returns Ok when `!enabled`); SMTP replaced by an in-memory capture mailer implementing the product `Mailer` trait. All emails, usernames, passwords, tokens, and key bytes in the outputs below are synthetic. Dev/e2e stacks untouched.
- Working directory and exact command or source-inspection method:
  - Pass 1 (blind derivation): read only the pinned sources for each chain — `crates/api/src/handlers/{recovery,verification,auth,oauth}.rs`, `crates/api/src/{lib,verification,state}.rs`, `crates/auth/src/{jwt,opaque}.rs`, `crates/storage/src/postgres/{accounts,registration,composite,oauth_grants}.rs`, `migrations/0001_initial.sql`, `web/src/pages/{consent,recover}.tsx`, `bins/oauth-client` — before reading any prior report, cross-review, or evidence file.
  - Pass 2 (comparison): `reviews/01-identity-keys.md`, `reviews/08-cross-review-examples-to-identity.md`, `evidence/2026-09-20-identity-verification{,-2}.md`.
  - Runtime: `cd /tmp/betterbase-audit-identity && SQLX_OFFLINE=true DATABASE_URL=postgres://audit:audit@127.0.0.1:25432/identity_demo cargo run --quiet` (DB created/dropped via `docker exec betterbase-audit-postgres psql`). Harness essence: boots the real router exactly as `app::run` does (connect_and_migrate → ensure_jwt_key → ensure_oauth_signing_key → `OpaqueService::from_hex(generate_server_setup_hex())` → `JwtService::new` → `CapService{enabled:false}` → `AppState` → `build_router` → `axum::serve` on ephemeral port), then drives public HTTP flows with a real OPAQUE client (opaque-ke 4.1.0-pre.1, same Ristretto255/TripleDH/Identity suite and `SERVER_ID=b"betterbase-accounts"` identifiers as the product server and its own unit tests).

## Expected behavior

- AUD-003: `recover/init` must only open a re-registration state for the account whose email the verified RECOVERY token was issued for.
- AUD-006: `password/init` with a fresh verified email must not be able to finalize against an existing username's account.
- AUD-005: `/oauth/consent` must not persist/deliver a `keys_jwe` that is not bound to the signed OAuth context (client, recipient, scope policy).

## Observed behavior (runtime, real router + real OPAQUE client)

Scenario 1 — AUD-003 (attacker holds a RECOVERY token for `attacker1@synthetic.test` — an address with **no account** — and submits it with `email: victim1@synthetic.test`):

```
PASS  1.1 victim registered via public flow (id c7a2ce7e-…)
PASS  1.2 victim row before attack: opaque_record sha256=46466eec…
PASS  1.3 attacker holds RECOVERY token bound to attacker1@synthetic.test (no account exists for it)
PASS  1.4 recover/init returned 200 for victim email + attacker token
PASS  1.5 recover/init issued registration state for the VICTIM account (user_id c7a2ce7e-…)
PASS  1.6 recover/finalize returned 200 OK
PASS  1.7 finalize issued the VICTIM's auth token
PASS  1.8 /v1/auth/validate confirms token acts as victim (victim_one@synthetic.test)
PASS  1.9 victim OPAQUE record replaced (sha256 now f63d6718…)
PASS  1.10 victim wrapped_root_key replaced with attacker-chosen value
PASS  1.11 attacker password logs in as victim
PASS  1.12 victim original password rejected (victim locked out)
PASS  1.13 canonicalization corner: differently-written gmail local part resolves the same victim row
PASS  1.14 replayed verification token rejected (400) — JTI consumption works
```

Scenario 2 — AUD-006 (attacker verifies fresh email `attacker6@synthetic.test`, then submits `username: victim_six` — an existing account):

```
PASS  2.1 control: attacker token + victim EMAIL rejected (401) — email binding holds
PASS  2.2 password/init returned 200 for fresh email + EXISTING username
PASS  2.3 get_or_create_account returned the VICTIM's row (user_id cbe7bae8-…)
PASS  2.4 password/finalize returned 200 OK
PASS  2.5 finalize issued the VICTIM's auth token
PASS  2.6 same account row (no new row created)
PASS  2.7 victim OPAQUE record overwritten by registration finalize
PASS  2.8 victim wrapped_root_key overwritten with attacker-chosen value
PASS  2.9 victim email unchanged on the row (attacker email never inserted — constraint never fired)
PASS  2.10 attacker password logs in as victim
PASS  2.11 victim original password rejected (locked out)
```

Scenario 3 — AUD-005, server half (registered attacker client **without** the `sync` scope; signed state scope `openid profile email`; victim has an existing grant to a separate TARGET client):

```
PASS  3.1 grant-keypair returns victim's TARGET-app wrapped key to the account session
PASS  3.2 authorize redirect issued (303)
PASS  3.3 consent URL duplicates client_name/scope/keys_jwk as unsigned params
PASS  3.4 code delivered to the ATTACKER's registered redirect
PASS  3.5 authorization code issued although signed scope lacks sync and client lacks sync
PASS  3.6 token exchange succeeded (extended PKCE satisfied by attacker-consistent fields)
PASS  3.7 CORE: server returned the SPA-submitted JWE verbatim to the attacker client
PASS  3.8 issued scope is the signed one (sync absent) — yet keys_jwe was still delivered
```

## Exit code / assertions / skipped tests

- Harness exit 0; **33/33 checks passed, 0 failed** (14 + 11 + 8).
- Full output preserved in this file above; harness sources at `/tmp/betterbase-audit-identity/{Cargo.toml,src/main.rs}`.

## Result

- AUD-003: **fail** (defect reproduced end-to-end at route level) — confirmed.
- AUD-006: **fail** (defect reproduced end-to-end at route level) — confirmed.
- AUD-005: **fail** for the server half (JWE passthrough to exchange, incl. scope-policy bypass) — confirmed; SPA half source-only (below).

## Seed / schedule / reproduction steps

- Deterministic (fixed synthetic identifiers; OPAQUE uses fresh randomness per run but flows are single-shot). Recreate: `CREATE DATABASE identity_demo`, run harness with `DATABASE_URL` pointing at it, then `DROP DATABASE identity_demo`. CAP-off and capture-mailer replace the two external boundaries; everything else is product code.

## Sanitized output or artifact links

- Inline above; no credentials, real tokens, or key material (all values synthetic; OPAQUE ServerSetup generated per run and discarded).

## Pass-1 → pass-2 reconciliation (independence protocol)

- My blind derivations matched the prior chains on every step for all three findings; no defeating check found anywhere (I additionally swept: route middleware (lib.rs:141-148 — only CORS/body-limit/protocol header), OPAQUE `registration_start`/`finish` (stateless w.r.t. old credentials), `consume_registration_state` (replay-only, no ownership), migration constraints/triggers (only `updated_at`), and repo-wide `create_oauth_client` call sites (only `bins/oauth-client` CLI — no HTTP registration route)).
- Two boundary refinements added beyond the prior record:
  1. **AUD-005 scope-policy bypass (new, runtime-proven as 3.5/3.8):** `handle_oauth_consent` accepts `keys_jwe`/`keys_jwk_thumbprint` without requiring that the *signed* scope contains `sync` (oauth.rs:257-439 has no scope check on those fields), while the SPA's `needsKeyDerivation` keys off the *unsigned* `scope` URL param (consent.tsx:79-87). A registered client not allowed `sync` still receives a key-bearing JWE. The prior record's preconditions ("attacker-chosen fields internally consistent") are correct but did not note that client scope policy does not bound key delivery.
  2. **AUD-006/003 damage scoping (matches prior record):** both takeovers replace the wrapped root key, breaking the victim's own key path; attacker does **not** obtain the victim's old root/scoped keys from these paths alone (cross-review 08 and report 01 state this; my runtime shows wrapper replacement, not old-key recovery).
- Canonicalization corner (gmail local-part) confirmed live (1.13); JTI replay protection confirmed live (1.14) — the missing check is precisely the token-email↔target-account binding.

## Limits: mocks, unsupported environments, untested paths, or unreproduced claims

- **AUD-005 SPA half not executed**: rendering `consent.tsx` with tampered URL params requires a DOM test environment; the web project's vitest runs `environment: "node"` with no jsdom/testing-library (consistent with register entry AUD-031/A-13's assurance gap). That half remains source-verified (consent.tsx:76-87 reads all four duplicated params; 183 grant lookup by unsigned `client_id`; 172/236 JWE to unsigned `keys_jwk`); the server half that receives and redelivers that JWE is now runtime-proven, so the composition rests on the (simple, fully-read) page data flow only.
- Mocked boundaries: SMTP (capture mailer replaces `DevMailer`), CAP (disabled-mode is product behavior). JWT/OPAQUE/storage/router/handlers are the pinned product code. The harness did not exercise: password-change routes, the recovery-blob fetch path, or a live consent UI click-through.
- Preconditions not runtime-exercised for AUD-005: "victim approves while root key available" (requires the browser page); the attack's need for an existing target grant was established by creating one directly in storage rather than through consent UX.
- Severity re-derivation: AUD-003 and AUD-006 Critical stands (unauthenticated→victim auth token + credential replacement + lockout, over public routes, requiring only a mailbox the attacker controls; CAP is a cost gate, rate limits bound volume not identity). AUD-005 Critical stands under the malicious-provisioned-client threat model — provisioning is CLI/operator-side today (verified again: no public registration route), which bounds *who* can attack but not the impact; with only ever first-party clients provisioned the practical exposure today is the unsigned-consent-display spoofing plus the JWE passthrough requiring a compromised/registered client.
