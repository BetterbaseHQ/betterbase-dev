# Evidence: identity findings re-verification, wave 2 (A-06, A-07, A-09, A-10, A-11, A-12, A-13)

- Date / reviewer: 2026-09-20; identity/accounts verification agent (wave 2). Analysis/verification only; no product code, dev/e2e services, or git state changed.
- Finding and invariant IDs: A-06, A-07, A-09, A-10, A-11, A-12, A-13 from [01-identity-keys](../reviews/01-identity-keys.md); INV-04, INV-05, INV-07, INV-08.
- Repository revisions / local patch: betterbase-accounts `b7cda8872ee09cfad44f4186ff40096ee3c95483` (clean), betterbase (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` (clean). Verified via `git rev-parse HEAD` + `git status --short` (empty) at start and re-checked at end. No local patch.
- Lockfile hashes / generated artifact provenance: no builds; source read directly from pinned checkouts.
- Tool versions / operating system / browser: macOS (darwin, arm64); Docker `postgres:18-alpine` (PostgreSQL 18.6). No browser used.
- Non-secret configuration / isolated services: disposable coordinator container `betterbase-audit-postgres` (127.0.0.1:25432, user `audit`, db `audit`) — same isolated instance as wave 1; dev/e2e stacks untouched and unaffected. All identifiers synthetic. **Deviation from wave-1 TEMP-only convention:** A-12's two-session race requires both sessions to observe the *same* row, which session-local TEMP tables cannot express; a dedicated schema `a12` with an UNLOGGED table mirroring `email_verification_codes` was created in the audit-only database and dropped afterward (drop verified, see Check 1). Nothing persists.
- Working directory and exact command or source-inspection method:
  - Source: independent re-read of `betterbase-accounts/crates/api/src/{verification.rs, handlers/{oauth,rootkey,auth,password_change,recovery,verification}.rs}`, `crates/auth/src/jwt.rs`, `crates/storage/src/postgres/{composite,oauth_grants,verification}.rs`, `crates/storage/migrations/0001_initial.sql`, `web/src/pages/consent.tsx`, `web/src/lib/api.ts`, and SDK `betterbase/js/src/auth/{key-store,session,client,react}.ts`.
  - Inventory (A-13): `rg '#[cfg(test)]' betterbase-accounts/crates betterbase-accounts/bins`; `rg -c '#[test]' betterbase-accounts/crates`; `rg --files -g '*test*' -g '*spec*'`.
  - SQL: `/tmp/bb-a12-audit/a12_demo.sh` (autocommit variant + attempt-bound overrun + cleanup) and `/tmp/bb-a12-audit/a12_demo_tx.sh` (explicit BEGIN/COMMIT variant), both driving `docker exec -i betterbase-audit-postgres psql -U audit -d audit`.

## Check 1 — A-12 mechanism: non-atomic code consume (executed, PostgreSQL)

- Expected behavior: code verification must consume the code and bound attempts atomically — one success per issued code, at most 5 hash comparisons per code (`MAX_VERIFICATION_ATTEMPTS = 5`, api/verification.rs:16).
- Product statement order (source, pinned revision): `verify_code` (api/src/verification.rs:79-111) reads the record (85-88, snapshot), checks `attempts >= 5` **on that snapshot** (90), increments in a separate statement (96-99), compares the hash **against the stale snapshot** (101-102), then best-effort deletes ignoring results (`let _ =` at 91, 104, 109). Storage: `get_latest_verification_code_by_email` is a plain SELECT, no `FOR UPDATE` (postgres/verification.rs:75-98); `increment_verification_attempts` has no rowcount check and no `attempts < MAX` guard (101-110); `delete_verification_code` returns `Ok` regardless of rows affected (112-118). Handler discards the code UUID (`let _code_id`, handlers/verification.rs:106) and mints a verification token with a **fresh random JTI per call** (`jti: Uuid::new_v4()`, jwt.rs:291-302); downstream one-time-use enforcement dedupes identical JTIs only (`used_verification_tokens ... ON CONFLICT DO NOTHING`, postgres/verification.rs:168-192).
- Observed behavior (both variants run; deterministic schedule, no timing races relied upon):
  - **Demo 1 — duplicate success (autocommit variant, mirroring the product's per-statement pool behavior — the storage methods each execute on `&self.pool` with no explicit transaction):**

    ```
    [A1] SELECT get_latest            -> row 1111…1111, attempts=0, code_hash \xdeadbeef…
    [B1] SELECT get_latest (before any A write)
                                      -> same row, attempts=0        # read survives; no lock, nothing consumed
    [A2] UPDATE attempts+1            -> UPDATE 1
    [A3] DELETE (consume)             -> DELETE 1
    [A4] COMMIT
    [B2] UPDATE attempts+1            -> UPDATE 0   (no error)        # product: Ok, rowcount unchecked
    [B3] DELETE (consume)             -> DELETE 0   (no error)        # product: `let _ =` -> success path continues
    [B4] COMMIT                       session_A_exit=0 session_B_exit=0
    ```

    Both sessions held identical snapshots (`attempts=0`, same `code_hash`), so both app-side comparisons succeed; B's increment/delete affect 0 rows without error, which the product maps to `Ok`. `verify_code` therefore returns `Ok` for both requests → two verification tokens with distinct fresh JTIs → downstream JTI consumption cannot deduplicate the two successes.
  - **Demo 1 (explicit-transaction variant)** — same interleave with `BEGIN`/`COMMIT` per request session, proving a naive read-committed-transaction "fix" does not close it:

    ```
    A: BEGIN; [A1] SELECT -> row attempts=0 | B: BEGIN; [B1] SELECT -> row attempts=0
    A: [A2] UPDATE 1; [A3] DELETE 1; [A4] COMMIT
    B: [B2] UPDATE -> UPDATE 0; [B3] DELETE -> DELETE 0; [B4] COMMIT   (exit 0 both sessions)
    ```

    B's statement snapshot predates A's committed DELETE; after A commits, B's UPDATE/DELETE re-evaluate against the gone row and return 0 rows, error-free.
  - **Demo 2 — attempt-bound overrun** (row seeded `attempts=4`; one comparison should remain):

    ```
    reader_X saw attempts=4 / reader_Y saw attempts=4 / reader_Z saw attempts=4   # all pass "attempts >= 5" check
    UPDATE 1 (exit 0) x3                                                            # no guard in product statement
    final attempts=7                                                                # bound of 5 exceeded
    ```

- Cleanup: `DROP SCHEMA a12 CASCADE` → `DROP SCHEMA`, `cleanup_exit=0`; catalog query returns 0 schemas named `a12` after both runs.
- Exit code / assertions: all psql sessions/commands exit 0; rowcount tags (`UPDATE 0`/`DELETE 0`) captured in output above.
- Result: **fail** (secure expectation violated; SQL mechanism confirmed). This verifies the SQL mechanism and statement order, **not** the HTTP handler — the app-side hash comparison and token minting are source-verified only (see Limits).

## Check 2 — A-06 source chain: fail-open consent key reads + unconditional signing overwrite (source-only)

- Expected behavior: transient failures reading existing key material must fail closed; a consistent scoped-key/signing-key bundle must be installed atomically.
- Observed behavior (confirmed chain):
  1. **First lookup fail-open**: consent.tsx:182-189 — `api.getGrantKeypairBlob(clientId)` inside try/catch; the bare `catch { // No existing grant, will generate new scoped key }` treats *every* failure (network, 5xx, malformed) as absence. The API layer throws on any non-OK response (web/src/lib/api.ts:63-77, 104), so transient errors reach this catch. New scoped key generated at 197-202. (Review cited ~181; actual catch 187-189.)
  2. **Second lookup fail-open**: `getOrCreateAppKeypair` (consent.tsx:33-66, invoked at 208-211) reads the same endpoint again (42); any error — including decryption failure or P-256 validation failure (45-53) — falls back to `generateAppKeypair()` (59-65). Cascade: if the first read failed and a *new* scoped key was generated, the second read typically *succeeds* and returns the OLD `app_keypair_blob` (wrapped under the OLD scoped key); decryption under the NEW `appWrappingKey` (derived at 207 from the new scoped key) fails → new keypair generated → new signing identity.
  3. **Server preserves scoped wrapper, overwrites signing identity**: oauth.rs:331-353 — the wrapped scoped key is written only if `grant.wrapped_scoped_key.is_none() || == Some(&[])` (339) → old wrapper preserved (first-write-wins). But `update_grant_keypair` at oauth.rs:393-396 is **unconditional** — no check whether `app_keypair_blob` already exists. Storage: `update_grant_keypair` = plain `UPDATE oauth_grants SET app_public_key=$2, app_keypair_blob=$3 WHERE id=$1` (postgres/oauth_grants.rs:252-272). Result: fresh scoped key delivered to the app while the server retains the previous scoped wrapper; the new signing blob (wrapped under the fresh key) overwrites the old identity.
  4. **Later recovery**: a fresh-device login recovers the OLD scoped wrapper (preserved at 339), derives the old wrapping key, cannot decrypt the replacement signing blob → step 2's fallback silently generates yet another identity. Even a failure confined to the second read rotates the signing identity.
  5. **Read-then-write race**: the first-write-wins decision for the scoped key lives in handler code (read grant at 331-338, check at 339, update at 340-343); `update_grant_wrapped_scoped_key` (postgres/oauth_grants.rs:274-288) is an unconditional UPDATE with no `AND wrapped_scoped_key IS NULL` guard — two concurrent first consents can both observe "no key" and both write (last SQL write wins), while the keypair write is unconditional even sequentially.
- Result: **source-only** (confirmed; fail-open cascade and read-then-write race verified end-to-end in source).

## Check 3 — A-07 source chain: rotation without generation/completeness (source-only)

- Expected behavior: root rotation must commit a complete, consistent set of dependent wrappers against a known generation; stale snapshots must be rejected.
- Observed behavior (confirmed chain):
  1. `handle_rotate_root_key` (rootkey.rs:126-182) validates only base64/41-byte sizes and per-grant **ownership** (146-149). It accepts any grant list, including empty or partial — no completeness check against the account's grant set, no expected-version/generation. (Review cited ~140; the accepting loop is 140-162.)
  2. Storage `rotate_root_key` (postgres/composite.rs:41-90): one transaction overwrites the root (51-58) and **only the listed grants** (61-70) — no previous-generation check, no lock on the grant set. Recovery blob is written only when non-empty (73-86): a request omitting it leaves the previous blob (wrapped under the old root) in place. (Review cited ~41/74 — exact.)
  3. **Stale-snapshot interleaving is legal**: GET /v1/accounts/grants/wrapped-keys (rootkey.rs:60-83) is backed by `list_grants_for_account`, a plain unlocked SELECT (postgres/oauth_grants.rs:319-340). Schedule: A reads grants under R0 → B consents (new grant wrapped under R0 via consent path, Check 2) → A commits rotation (root R1 + earlier list). B's grant remains wrapped under R0 while the root is R1 — not rejected anywhere.
  4. **Partial transitions via separate endpoints**: PUT /v1/accounts/root-key (rootkey.rs:36-57) and PUT /v1/accounts/grants/wrapped-keys (rootkey.rs:85-123) commit independently of each other and of rotation.
  5. **Password-change interleaving**: `update_registration_and_root_key` (postgres/composite.rs:10-39) is an unconditional UPDATE (no expected-version). A password-change wrapper prepared under the old export key can commit after rotation (pairing R0-wrapper with R1-grants), or a rotation can overwrite a just-committed password-change wrapper — both orders are unguarded.
- Result: **source-only** (confirmed; the review's "no full race reproduction executed" stands — transactional atomicity of supplied rows is real, snapshot completeness is not enforced).

## Check 4 — A-09 source chain: password change/recovery does not revoke sessions (source-only)

- Expected behavior: credential replacement should revoke or fence previously issued sessions (auth JWTs and refresh families).
- Observed behavior (confirmed chain):
  1. Auth JWTs: `create_auth_token` = HS256, `exp = now + 14 days`, claims `{sub, typ, iat, exp}` only (jwt.rs:182-194) — no session generation, no JTI, nothing revocable. `validate_auth_token` checks signature/exp/typ only (196-208). (Review cited ~184 — exact.)
  2. `extract_auth` (handlers/auth.rs:364-380) parses the Bearer token and returns `AuthContext { account_id }` — no per-account session/generation lookup. (Review cited ~365 — exact.)
  3. `handle_password_change_complete` (password_change.rs:150-214): consumes state, verifies ownership, then `update_registration_and_root_key` (196-203). The file makes **no OAuth storage calls** — no refresh-token revocation, no grant invalidation; a new auth token is issued (205-208) while all previously issued tokens remain valid (same global HMAC key). (Review cited ~194 — exact.)
  4. `handle_recover_finalize` (recovery.rs:192-258): same pattern — `update_registration_and_root_key`/`update_registration` (230-239), best-effort optional new blob (242-247), new auth token (249-252). No revocation anywhere in the file. (Review cited ~223 — exact, 223-233.)
  5. Refresh expiry slides: `REFRESH_TOKEN_EXPIRY_SECS = 30 days` (oauth.rs:45); `new_refresh_token` (oauth.rs:1110-1119) re-bases `expires_at = now + 30d` on every rotation (used at both code exchange 610 and refresh 713), so a retained refresh token kept in use never expires. Combined with 3/4: an old refresh token continues minting 15-minute access tokens after password change/recovery.
  6. No per-account token-generation/revocation construct exists anywhere in the reviewed model (consistent with the review's phrasing).
- Result: **source-only** (confirmed).

## Check 5 — A-10 source chain: browser key/session storage not identity-scoped (source-only; downstream impact deliberately not upgraded)

- Expected behavior: durable key material and session state must be keyed by issuer/account/client; identity replacement must notify consumers; OAuth ephemeral keys must be isolated per transaction.
- Observed behavior (confirmed mismatches):
  1. **KeyStore**: fixed `DB_NAME = "betterbase-key-store"` + `STORE_NAME = "keys"` (key-store.ts:22-24) and a closed set of five fixed key IDs (26-31); process-wide singleton (49, 58-63). Not scoped by identity. (Review cited ~22 — exact.)
  2. **AuthSession prefix namespaces only the state blob, not keys**: `storageKey = (config.storagePrefix ?? DEFAULT) + "state"` (session.ts:81-82), but the same constructor takes `KeyStore.getInstance()` (session.ts:95). Two sessions with different prefixes (different accounts) therefore read the *same* `encryption-key` record — whichever import landed last wins — and `destroy()` of either calls `keyStore.clearAll()` (session.ts:390-393 → 406-417), wiping keys for all sessions. (Review cited 82/95 — exact.)
  3. **Storage handler in-place replacement**: on a non-null `storage` event for its key (another tab replaced the session — possibly with a different account), the handler copies `accessToken`, `refreshToken`, `personalSpaceId`, `handle`, epoch fields etc. into the live object (session.ts:570-604, copy at 583-595) with **no identity comparison and no consumer notification**; only `newValue === null` (logout) triggers `onExpired` (574-578). (Review cited ~571 — exact.)
  4. **React consumers keyed on object identity**: `useSessionToken`'s key-loading effect depends only on `[session]` (auth/react.ts:201-232). In-place mutation from 3 does not change the object reference, so the effect never re-runs; consumers retain previously loaded `encryptionKey`/`epochKey`/`keypair` while `getToken()` (ref to the same mutated object) serves the new account's tokens. (Review cited ~201 — exact.)
  5. **OAuth ephemeral key: one cross-tab slot vs tab-local state**: `startAuth` does `deleteEphemeralOAuthKey()` then `storeEphemeralOAuthKey(privateKey)` in the single shared slot (client.ts:80-83) while `state`/`codeVerifier` go to tab-local sessionStorage (96-97). The callback reads the slot (179: `getEphemeralOAuthKey`) and clears it (240). Parallel logins in two tabs: tab B's startAuth deletes tab A's pending key → tab A's callback retrieves the wrong/absent private key and cannot decrypt its JWE. (Review cited ~81 — exact.)
- Result: **source-only** (confirmed mismatches). Per instruction, downstream data-loss/corruption consequences remain **pending integration evidence** — not upgraded by this wave.

## Check 6 — A-11 source chain: refresh uses stored grant scope, not current authorization scope (source-only)

- Expected behavior: tokens minted on refresh must reflect the current authorization's (and client's currently permitted) scope.
- Observed behavior (confirmed chain):
  1. Grant UPSERT paths leave `scope` unchanged for an existing `(client_id, account_id)` grant: `get_or_create_oauth_grant` — `ON CONFLICT ... DO UPDATE SET last_used_at = NOW()` (postgres/oauth_grants.rs:45-71); the thumbprint variant updates only `keys_jwk_thumbprint`/`last_used_at` (73-103). (Review cited 45/73 — exact.)
  2. Code exchange mints the access token with the **code's** scope: `issue_access_token(state, &grant, &code.scope)` (oauth.rs:604) and returns `scope: code.scope` (623). Refresh mints with the **stored grant's** scope: `issue_access_token(state, &grant, &grant.scope)` (oauth.rs:704) and returns `scope: grant.scope` (739). (Review cited 604/704 — exact.)
  3. No re-check of the client's currently-allowed scopes at refresh: `validate_scopes_against_client` exists only in the authorize endpoint (oauth.rs:152-160); `handle_refresh_token_grant` (639-753) validates client identity (695-701) but never consults client policy. `TokenForm` has no `scope` parameter, so the server cannot narrow either.
  4. Net effect: a later *narrow* authorization (code exchange narrow) is followed by refresh minting the *historically broader* stored grant scope; symmetrically a legitimately added capability granted later is invisible to refresh until a new code exchange; a client whose allowed scopes were withdrawn keeps the old scope on refresh.
- Result: **source-only** (confirmed; severity context unchanged — requires a prior broad consent for the same account+client, so this is not cross-client escalation).

## Check 7 — A-13 inventory: assurance gap (re-verified with rg)

- Expected behavior (review claim): no accounts storage tests; no Rust route-level registration/recovery/consent tests; native tests cover primitives/helpers only.
- Observed behavior (exact commands + counts):
  - `rg '#[cfg(test)]' betterbase-accounts/crates betterbase-accounts/bins` → exactly six test modules, all primitives/helpers: `auth/src/{es256.rs:153, jwt.rs:390, opaque.rs:189}`, `core/src/{email.rs:74, identity.rs:121, username.rs:35}`.
  - `rg -c '#[test]'` → 4+5+3+4+7+3 = **26** test functions total — matching the coordinator baseline ("26 tests with zero storage tests") cited in the review.
  - **Zero** `#[cfg(test)]` under `crates/storage/` (no storage tests of any kind, PostgreSQL or mocked) and **zero** under `crates/api/` (no route-level tests — registration, recovery, consent, verification, token endpoint all untested at the route level).
  - No `tests/` integration directories anywhere under `crates/` or `bins/`.
  - Web tests exist only at `web/test/lib/*.ts` (api, cap, crypto, opaque+opaque.integration, recovery, redirect, utils, validation) — library-level; no page-level tests for the consent/recover/recovery-setup pages.
- Result: **inventory confirmed** (assurance gap as described; not an exploit finding).

## Aggregate

- Expected behavior: key-lifecycle atomicity/fail-closed behavior (A-06/A-07), credential-replacement revocation (A-09), identity-scoped client storage (A-10), authorization-scope fidelity (A-11), atomic code consumption (A-12), and state-machine test coverage (A-13).
- Observed behavior: all seven findings confirmed. A-12 additionally has executed SQL-mechanism evidence (duplicate success in autocommit and explicit-transaction forms; attempt bound 5 → 7); A-06/A-07/A-09/A-10/A-11 confirmed by complete independent source traces with no defeating checks found; A-13 inventory re-verified with exact counts.
- Exit code / assertions / skipped tests: SQL scripts exit 0 (rowcount tags captured as assertions); no product test suites run (out of scope).
- Result: **fail** for the A-12 execution; **source-only** (confirmed) for A-06, A-07, A-09, A-10, A-11; **inventory confirmed** for A-13.
- Seed / schedule / reproduction steps: scripts preserved at `/tmp/bb-a12-audit/a12_demo.sh` and `/tmp/bb-a12-audit/a12_demo_tx.sh`; schedules are deterministic step-by-step interleavings (essential orderings: both reads before first delete; all reads before first increment) — legal under READ COMMITTED without timing races.
- Sanitized output or artifact links: inline above; all identifiers synthetic; no credentials, tokens, key material, or private data included.
- Limits:
  - A-12 execution verifies the SQL mechanism and statement order on PostgreSQL 18.6, **not** the Axum handler: the snapshot-based attempts check, app-side constant-time compare, and fresh-JTI token minting are source-verified (api/verification.rs:79-111, jwt.rs:291-302), not executed end-to-end; sqlx's `execute` returning `Ok` on 0 rows affected is established by API semantics and the absence of any `rows_affected` consult in the source, not by a Rust harness.
  - Demo scheduling is deterministic; real-world exploitation additionally needs request interleaving within the code's 10-minute validity, which proxy/CAP rate limits (60–300/min tiers, per-email send caps) constrain but, per the review, do not make the per-code bound true.
  - A-06/A-07 races are argued from source only (no browser or concurrent-request reproduction); A-07's stale-snapshot legality rests on READ COMMITTED + unlocked reads, consistent with (but not executed against) the sqlx pool defaults.
  - A-10: source mismatches confirmed; actual application data corruption/disclosure depends on provider/consumer lifecycle and remains **pending integration evidence** (sync/examples review) — not upgraded here.
  - Shared-schema deviation from wave-1's TEMP-only convention is documented above; the `audit` database is disposable and audit-only, and removal was verified by catalog query after both runs.
  - Findings continue to refer to the pinned baselines after any future fixes.
