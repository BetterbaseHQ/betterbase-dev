# Remediation wave 4 — accounts/identity Highs (AUD-004, 007, 008, 009, 010, 011, 012, 016)

Date: 2026-09-21. Scope per D-004 wave order ("remainder by repo"); user selected the accounts/identity High cluster for wave 4 over the upload/files and severity-first-sweep alternatives.

## What was fixed

| Finding | Repos | Commits |
|---|---|---|
| AUD-004 refresh-family revocation (sequential + concurrent-aborted-tx) + SDK cross-tab refresh fence | betterbase-accounts, betterbase | `5407abd`, `de859ed` |
| AUD-010 in-flight refresh after destroy re-persists session | betterbase | `de859ed` |
| AUD-011 credential rotation revokes sessions (credentials_version + refresh families) | betterbase-accounts | `2af68a8` (migration 0002) |
| AUD-007 recovery blob fetch no longer consumes the one-use token | betterbase-accounts | `d7a9671` |
| AUD-016 recovery secret staged until user confirms | betterbase-accounts (web) | `d7a9671` |
| AUD-008 consent fails closed + atomic key-bundle install | betterbase-accounts (web + server) | `5c395e9` |
| AUD-009 root rotation completeness + CAS (migration 0003) | betterbase-accounts | `a6be3f2` |
| AUD-012 identity-scoped key storage + per-tx ephemeral keys | betterbase | `06883f4` |

Housekeeping commits: `c88f7d0` (unused import).

## Key design decisions

- **AUD-011 accepted bound (explicit):** resource-server (sync/inference) OAuth access tokens are not fenced by credentials_version — JWKS-only validation, 15-minute lifetime bounds exposure; refresh families are revoked at rotation so no new access tokens can be minted. Documented at the extract_auth check site.
- **AUD-004 benign-race handling:** family revocation is strict OAuth BCP semantics (both tabs of a genuine cross-tab double-present lose the session); the SDK prevents the benign case via Web-Lock-serialized rotation with peer-token adoption, so revocation only fires for actual reuse.
- **AUD-009 recovery semantics:** rotation without a new recovery blob deletes the old one (it decrypts to the retired root) rather than leaving a false recovery path.
- **AUD-012 isolation granularity:** scope = storagePrefix (two sessions with the same prefix already share one localStorage slot, so prefix granularity is the natural boundary); legacy keys are adopted by exactly one scope (global claim) to keep upgrades logged in.
- **Auth-crate test-support feature:** in-process OPAQUE client helpers behind `test-support`, used by api dev-deps for route-level finalize tests.
- **happy-dom + fake-indexeddb** added as web/js dev-deps respectively for component and IndexedDB-level tests.

## Residuals recorded for later waves

- Consent created after a root rotation by a client holding the pre-rotation root can strand that grant (AUD-008/AUD-009 shared residual): the consent write needs to carry the root version the client derived under.
- AUD-012: atomic credential+key snapshot commit across localStorage/IndexedDB remains future hardening.

## Verification

- betterbase-accounts: `just check` green; `just test-db` green (storage 31, api 25+3+4 = 32 across mods, auth 12, core 14 — enforced real-PostgreSQL gate). Web `pnpm check` green (178 tests incl. new recovery-setup component and consent-keys suites).
- betterbase: `just check` green — cargo + clippy (native + wasm), tsc, 511 vitest, 200 browser tests. All example apps `pnpm check` green against the SDK changes.
- sqlx offline cache regenerated per finding (committed `.sqlx`).

## Platform e2e

(recorded below after review fixes)

## Review results (appended after completion)

Two independent code-reviewer agents covered the wave-4 deltas (accounts `5407abd`, `2af68a8`, `d7a9671`, `5c395e9`, `a6be3f2`; betterbase `de859ed`, `06883f4`). No CRITICAL. All three IMPORTANTs and the actionable MINORs fixed and re-verified:

- **IMPORTANT — rotation did not cover concurrent grant INSERTs** (FOR UPDATE cannot lock nonexistent rows): rotation now locks the account row first, and grant creation takes the same lock — a new grant can no longer commit mid-rotation. Commit `1755e2a`.
- **IMPORTANT — password-change/recovery root writes bypassed the CAS**: `update_registration_and_root_key` advances `root_key_version`, so a rotation prepared before a credential rotation no longer passes CAS and clobbers the newer root. `1755e2a`.
- **IMPORTANT — legacy key adoption was a check-then-act TOCTOU**: marker read + copies + marker write now run in a single IndexedDB readwrite transaction. betterbase `84ca0df`.
- MINORs fixed (same commits): `PUT grants/wrapped-keys` gained an `expected_root_version` CAS fence; credentials update + session revocation are one transaction (`update_credentials_and_revoke_sessions`); reuse responses are 400 per RFC 6749 (no once-valid token oracle); empty stored wrappers count as absent (no 409 loop); recovery finalize propagates new-blob failures; the unfenced dead `auth_middleware` was deleted; ephemeral OAuth keys swept on cleanup and deleted on every callback exit path; `adoptPersistedTokenIfNewer` fails closed on corrupt state; web shows `error_description` (human guidance) over machine codes; one shared grant snapshot feeds both consent resolvers; storing affordance + `role="alert"`; `rootKey!` assertion replaced with a guard; a real concurrent-rotation test replaces the sequential duplicate; the retry-loop regression now pins zero network calls after destroy; a consent page component test pins the keypair↔wrapper pairing contract (review gap).
- Acknowledged/recorded, not changed: sequential-reuse revocation vs an in-flight successor rotation is left to PostgreSQL row-lock ordering (no attacker benefit); browsers without Web Locks keep single-tab coalescing only (documented); the extract_auth DB read is a deliberate per-request cost of fencing; OAuthClient↔AuthSession prefix matching remains a documented convention.

## Platform e2e

Full `just e2e` cycle after review fixes: **125 passed + 3 gated-skips** (main phase), **3/3 fault-injection** — real signup/consent/refresh flows against the changed accounts service and SDK.

Wave-4 commits (final): betterbase-accounts `5407abd`, `2af68a8`, `d7a9671`, `5c395e9`, `a6be3f2`, `1755e2a`, `df4edb6`, `c88f7d0`; betterbase `de859ed`, `06883f4`, `84ca0df`.

Register: 29/60 fixed (was 21/60). Wave 4 complete — all eight accounts/identity Highs closed with regression tests.
