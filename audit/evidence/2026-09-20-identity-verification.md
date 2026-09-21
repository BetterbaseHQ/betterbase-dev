# Evidence: identity findings re-verification (A-01..A-05, A-08, A-14)

- Date / reviewer: 2026-09-20; identity/accounts verification agent (successor wave). Analysis/verification only; no product code, dev/e2e services, or git state changed.
- Finding and invariant IDs: A-01, A-02, A-03, A-04, A-05, A-08, A-14 from [01-identity-keys](../reviews/01-identity-keys.md); INV-04, INV-05, INV-08.
- Repository revisions / local patch: betterbase-accounts `b7cda8872ee09cfad44f4186ff40096ee3c95483` (clean), betterbase (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` (clean). Verified via `git rev-parse HEAD` + `git status --short` (empty) at run time. No local patch.
- Lockfile hashes / generated artifact provenance: no builds; source read directly from pinned checkouts. Node harness used the repo-installed TypeScript (`betterbase/js/node_modules/typescript` 5.9.3, lockfile-governed) only to transpile `js/src/auth/session.ts` in memory.
- Tool versions / operating system / operating browser: macOS (darwin, arm64); Docker `postgres:18-alpine` (PostgreSQL 18.6); Node v24.21.0; TypeScript 5.9.3. No browser used.
- Non-secret configuration / isolated services: disposable coordinator container `betterbase-audit-postgres` (127.0.0.1:25432, user `audit`, db `audit`), session-local TEMP tables only, dropped on disconnect. All tokens/keys in checks are synthetic strings. Dev/e2e stacks untouched.
- Working directory and exact command or source-inspection method:
  - Source: independent re-read of `betterbase-accounts/crates/api/src/handlers/{recovery,verification,auth,oauth}.rs`, `crates/api/src/verification.rs`, `crates/auth/src/jwt.rs`, `crates/storage/src/postgres/{accounts,recovery,registration,verification,oauth_refresh,composite}.rs`, `crates/storage/migrations/0001_initial.sql`, `web/src/pages/{consent,recover,recovery-setup}.tsx`, `web/src/lib/api.ts`, and SDK `betterbase/crates/betterbase-auth/src/key_extraction.rs`, `betterbase/js/src/auth/session.ts`.
  - SQL: `docker exec -i betterbase-audit-postgres psql -U audit -d audit < /tmp/bb-identity-audit/a02_tx_mechanism.sql` (VERBOSITY verbose).
  - Harness: `node /tmp/bb-identity-audit/a08_logout_race.js` (harness kept in /tmp per constraints).

## Check 1 — A-02 mechanism: PostgreSQL abort-in-transaction (executed)

- Expected behavior: a unique-violation INSERT (SQLSTATE 23505) aborts the surrounding transaction; any subsequent statement fails with 25P02; COMMIT becomes ROLLBACK, so earlier statements (including a DELETE of the "active token") do not survive. The product's revoke-on-reuse DELETE therefore cannot execute and the surviving token family is never revoked.
- Observed behavior: reproduced twice — (a) prior-evidence ordering (dup INSERT then DELETE) and (b) exact `rotate_refresh_token` ordering (DELETE old → dup INSERT → revoke DELETE → COMMIT).
- Sanitized output (abridged, both parts identical in mechanism):

```
PART 1: BEGIN; INSERT dup -> ERROR: 23505 duplicate key ... audit_used_tokens_pkey
        DELETE -> ERROR: 25P02 current transaction is aborted
        COMMIT -> reported ROLLBACK; SELECT count(*) surviving_active_tokens = 1
PART 2 (product order): BEGIN; DELETE 1; INSERT dup -> 23505;
        DELETE -> 25P02; COMMIT -> ROLLBACK;
        surviving_active_tokens_product_order = 1; used_tokens_after = 1
```

- Product-code correspondence (source inspection, same revision): `postgres/oauth_refresh.rs:107-142` begins a transaction, DELETEs the old token (110-116), plain-INSERTs the old hash into `used_refresh_tokens` (120-129; PK `token_hash` per migration line 220), and on 23505 (132) runs the revoke DELETE inside the same, now-aborted transaction (135-141) with no SAVEPOINT or rollback-and-retry. The 25P02 from that DELETE returns early as a generic `StorageError`, so `RefreshTokenReused` (143) is unreachable in the concurrent path; the dropped transaction rolls back both DELETEs. Handler comment `oauth.rs:709-712` ("revokes the grant's tokens inside the transaction") is contradicted. Sequential reuse: handler looks up active tokens only (`oauth.rs:654`) → `invalid_grant`, no family revocation.
- Exit code / assertions: psql exit 0 (statement errors expected and captured); counts asserted by query results.
- Result: **fail** (secure expectation violated; vulnerability mechanism confirmed).

## Check 2 — A-08: AuthSession logout race (executed)

- Expected behavior: after `destroy()`, a refresh already awaiting the token endpoint must not re-persist credentials; `AuthSession.restore()` must not find a session afterward.
- Observed behavior: harness transpiles the checked-in `session.ts` (vm sandbox; storage/keys/wasm/client mocked; no network, no secrets) and drives the real control flow. All assertions passed:

```
PASS: session persisted after create
PASS: after logout, session persisted: false
PASS: destroyed object refuses getToken (disposed)
PASS: after in-flight refresh resolves, session persisted: true
PASS: persisted refresh token is the late-rotated one
PASS: persisted access token is the late one
PASS: session restored after logout: true
PASS: restored token is late refreshed token: true
refreshToken calls: 1   (exit code 0)
```

- Source correspondence: `destroy()` at `session.ts:390-393` + `cleanupSync` sets `disposed` (420); `doRefresh` (442) awaits the client, then writes tokens and calls `persist()` (451-463) with no `disposed` check; `scheduleRefresh`'s disposal check (552) runs after persistence. Matches the prior run's observed sequence false → true → true → true.
- Result: **fail** (secure expectation violated; reproduction successful).

## Check 3 — A-01 source chain (source-only)

- Expected behavior (invariant): the account mutated by recovery must be the account the verified token was issued for.
- Observed behavior (confirmed chain, all steps present, no defeating validation found):
  1. `handlers/verification.rs:64-80` issues a RECOVERY code to any requester-supplied email (anti-enumeration: silently succeeds even if no account); confirm (87-123) issues a signed verification token bound to that email (117-120).
  2. `jwt.rs:312-324` validates only signature/type/exp — `claims.email` is carried, not re-bound.
  3. `handlers/recovery.rs:107-130` validates the token + RECOVERY purpose and consumes the JTI; line 132 canonicalizes the **independently supplied** `req.email`; `get_account_by_email` (146-149) resolves the target. No equality check between `v_claims.email` and `req.email` exists anywhere in the handler.
  4. Init returns an OPAQUE registration start for the target's account id (156-188); finalize (192-257) consumes the reg state, replaces the target's OPAQUE record, optionally the root wrapper (`composite.rs:10-39`, unconditional UPDATE), and issues the target's auth token (249-252). No recovery-blob decryption or mnemonic proof is required anywhere in init/finalize.
  5. Rate limit (135-143) is keyed to the supplied victim email (5/hour) — bounds volume, does not bind identity.
- Result: **source-only** (confirmed; no HTTP execution, per scope).

## Check 4 — A-03 source chain (source-only)

- Expected behavior: key delivery at consent must be bound to the server-validated (signed) OAuth context.
- Observed behavior (confirmed chain):
  1. `/oauth/authorize` (`oauth.rs:67-233`) validates client/redirect/scopes/keys_jwk and signs all into the state JWT (203-211), then duplicates `client_id`, `client_name`, `scope`, `keys_jwk` as plaintext consent-URL params (222-230).
  2. `consent.tsx:75-83` reads `client_id`/`client_name`/`scope`/`keys_jwk` from those unsigned URL params; the signed token is only forwarded, never parsed for these fields.
  3. `consent.tsx:183` looks up the grant by unsigned `client_id`; 191-202 unwraps that grant's scoped key; 207-233 derives/loads the same client's app keypair (private key included in payload); 172/236 encrypt to the unsigned `keys_jwk` recipient.
  4. Backend consent (`oauth.rs:279-293`) takes the client from the **signed** state only; accepts the SPA-supplied `keys_jwe`/`keys_jwk_thumbprint` without comparing the thumbprint to the signed state's `keys_jwk` (408-424); code exchange returns that JWE verbatim (624). Extended PKCE (543-566) compares request thumbprint to the consent-time thumbprint — both attacker-consistent, so it passes.
  5. `handle_grant_keypair` (871-902) legitimately returns the caller's own grant for any client, enabling the SPA lookup; SDK `key_extraction.rs:22-46` takes the first `oct` key without checking the configured client id.
  - Precondition per report (registered malicious client + victim with target grant + user approval) holds; with no existing target grant the attacker instead receives newly created target-bound keys (continuity break — overlaps A-06).
- Result: **source-only** (confirmed; no live consent flow executed).

## Check 5 — A-04 source chain (source-only)

- Expected behavior: registering with a fresh verified email must not be able to finalize against an existing username's account.
- Observed behavior (confirmed chain):
  1. `handlers/auth.rs:49-53` binds the verification token to `req.email` (REGISTRATION purpose) — the attacker uses their own fresh email, so this passes.
  2. `auth.rs:75-81` calls `get_or_create_account(issuer, canonical_username, canonical_email)`.
  3. `postgres/accounts.rs:43-59`: `INSERT ... ON CONFLICT (issuer, username) DO UPDATE SET issuer = EXCLUDED.issuer RETURNING *` — on a username conflict it returns the existing row; email is not compared, registration status (`opaque_record` null-ness) is not checked, and the email uniqueness constraint (migration line 26) never fires because the fresh email is never inserted.
  4. `auth.rs:163-170` → `finalize_registration_with_root_key` (`accounts.rs:155-179`): unconditional `UPDATE accounts SET opaque_record, wrapped_root_key WHERE id = $1` — no compare-and-set, no "already registered" guard. `auth.rs:172-180` returns the auth token for that (victim) account id.
  5. `handlers/verification.rs:48-52` comment "Conflict will be caught at finalize time" — the referenced guard does not exist.
- Result: **source-only** (confirmed).

## Check 6 — A-05 source chain (source-only)

- Expected behavior: the recovery UI's one-use verification token must survive until the state-changing init call, or be exchanged for a continuation credential.
- Observed behavior (confirmed chain): `recover.tsx:110` fetches the blob with the verification token (Bearer via `api.getRecoveryBlob`, api.ts:203-210) → server consumes the JTI (`recovery.rs:74-80`); `recover.tsx:127` retains the same token in `recoveryState`; `recover.tsx:146-151` submits it to `recover/init`, which consumes again (`recovery.rs:119-130`); duplicate consumption is rejected by storage (`postgres/verification.rs:168-192`, `ON CONFLICT DO NOTHING` + no-row → `VerificationTokenUsed`). The legitimate UI flow therefore cannot pass init; a wrong phrase also burns the token (fetch at 110 precedes `decryptRootKey` at 121), forcing a restart with a new email code.
- Result: **source-only** (confirmed; no browser execution).

## Check 7 — A-14 source chain (source-only)

- Expected behavior: replacing the recovery secret must require user confirmation of the new phrase.
- Observed behavior (confirmed chain): `recovery-setup.tsx:28` generates the mnemonic on mount (`useMemo`); the effect at 31-46 immediately derives the recovery key, encrypts the root, and POSTs the blob as soon as `rootKey` exists — before any confirmation; the server upsert-replaces the account's single blob (`postgres/recovery.rs:10-24`, `ON CONFLICT (account_id) DO UPDATE`). Closing/refreshing the page at that point invalidates the previously recorded phrase while the new one may be unrecorded. `handleContinue` (100-116) has no `blobStored` check — qualified: after a *failed* store the error early-return (92-98) blocks continue, so the unchecked-continue gap matters in the in-flight window (navigating away while the POST is pending).
- Result: **source-only** (confirmed with the qualification above).

## Aggregate

- Expected behavior: identity/targeting invariants (INV-04/05/08) hold for recovery, consent, registration, and session lifecycle.
- Observed behavior: A-01/A-03/A-04/A-05/A-14 confirmed by complete independent source traces; A-02 (mechanism + product ordering) and A-08 re-executed and reproduced on PostgreSQL 18.6 / Node 24 with all assertions passing.
- Exit code / assertions / skipped tests: SQL exit 0 (errors expected/captured); harness exit 0 with 8/8 assertions; no product test suites run (out of scope).
- Result: **fail** for A-02/A-08 executions; **source-only** (confirmed) for A-01/A-03/A-04/A-05/A-14.
- Seed / schedule / reproduction steps: SQL script `/tmp/bb-identity-audit/a02_tx_mechanism.sql`; harness `/tmp/bb-identity-audit/a08_logout_race.js` (schedule: single delayed token-endpoint resolution released after `destroy()`). Both deterministic; copy of essential steps preserved in this file.
- Sanitized output or artifact links: inline above; no credentials, tokens, key material, or private data included (all identifiers synthetic).
- Limits: TEMP tables are structurally simplified stand-ins (integer PK vs BYTEA hash) — constraint/abort semantics, not the full schema, are what this check establishes; sqlx error propagation (25P02 → `StorageError::Database` → handler 500) is established by source reading, not executed against the Rust service; the A-08 harness mocks storage/keys/wasm and does not exercise IndexedDB, cross-tab StorageEvents, or the account-switch variant; no HTTP-level or browser-level reproductions were run (no live account takeover, consent link, or recovery flow); A-03's "registered malicious client" precondition assumes client registration is available to an attacker (registration tooling is operator-side today — deployment/dependencies agent owns whether clients can be self-registered); findings continue to refer to the pinned baseline after any future fixes.
