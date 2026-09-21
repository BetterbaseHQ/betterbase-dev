# Remediation review-coverage closure, 2026-09-21

Closes the "all fixes reviewed + regression-tested" gap: every remediation
delta now has an independent code review, and every fixed finding has named
regression tests. Follows D-004 (fixed vs verified separate; per-finding
records) and the wave-2b precedent of reviewing fix deltas, not just
original fixes.

## Review-gap analysis

Four deltas had never been independently reviewed:

| Delta | Commits | Review status before |
|---|---|---|
| Wave 0 (test gates) | accounts `8f44b39`, dev `982b3ff` | never reviewed |
| Wave 1 response fixes | inside accounts `6cd6f62` | reviewer saw pre-response state |
| Wave 2a response fixes | inside sync `c32f747`, betterbase `1a69f84` | reviewer saw pre-response state |
| Wave 2b fix-ups | sync `b017bd5`, betterbase `c61cc1f` | never reviewed |

Three independent reviewers covered all four gaps in parallel.

## Review outcomes and this round's fixes

### Accounts (wave 0 + wave 1 responses)

Verdict: no blockers; core security logic defended in depth. Findings fixed
this round:

- `password/init` username pre-check failed open on transient DB errors →
  now fails closed (only `AccountNotFound` proceeds; other errors propagate).
- Cleanup test did not pin the `opaque_record IS NULL` predicate (a fresh
  registered account survived via `created_at` alone) → the registered
  account is now backdated past the cutoff, making the predicate the only
  protection.
- No test for the `validate_email` panic fix in `recover/init` → added
  (malformed email → 400, never a panic) on the unauthenticated endpoint.
- Canonical email comparison weakly pinned → added domain-casing match +
  mismatch-rejects test (canonicalization normalizes domain case and Gmail
  local parts; local-part case is intentionally significant for non-Gmail).
- Authorize redirect not directly pinned → added: consent URL carries
  exactly one param (`oauth=<signed JWT>`), nothing passthrough.
- Dead availability lookups removed from `verify/send` (two queries per
  request, results unused).

Accepted and recorded (test-infra nits, not gating): per-test schemas
accumulate against a long-lived DB (drop guard deferred); no partial index
on `accounts(created_at) WHERE opaque_record IS NULL` (seq scan every 60 s
is acceptable pre-production); `BB_TEST_REQUIRE_DB` accepts only literal
"1"; duplicated harness logic between api/storage test-support modules.

### Wave 2a response areas (sync + SDK)

Verdict: no blockers; CAS race-free by construction, lock ordering correct,
admin gate has real teeth. Reviewer correction accepted: the AUD-034 epoch
fallback lives in betterbase `1a69f84`, not sync `c32f747`. Findings fixed
this round:

- `rewrapAllDEKsCryptoKey` (exported from `betterbase/sync`) bypassed the
  CAS entirely — no `observed_dek`, no retry → now carries the observed
  wrapper with the same bounded retry loop as the raw-key path, pinned by
  CryptoKey-path tests (retry-with-fresh-observation, exhaustion).
- The DekConflict→`"conflict"` wire mapping was untested at the exact seam
  the client retry loop depends on → ws tests added for both
  `deks.rewrap` and `file.deks.rewrap` (stale observed wrapper → conflict
  + retry message).
- File-DEK CAS had no storage test → added against real PostgreSQL
  (stale observation rejected, concurrent wrapper intact, fresh observation
  succeeds).
- AUD-034 fallback was copy-pasted at three sites (two unreachable) →
  consolidated into `spaceEpochOf`; sender-side invitation `generation`
  labeling now pinned (recipient-side pin already existed).
- `epoch.complete` admin-ok test gap noted (write-forbidden covered);
  recorded, not gating.

Deferred nits recorded: duplicated spaces SELECT in `push`;
`rows_affected != 1` conflates missing-record with conflict on retry
semantics; `observed_dek` length not validated (44-byte check on `dek`
only); DekRecord doubling as rewrap input; `parse_dek_epoch` returning
None silently skips min-generation (cryptographically self-defeating).

### Wave 2b fix-up delta (sync `b017bd5` + betterbase `c61cc1f`)

Verdict: `doRemoveMember` fix correct in all d/r interleavings and verified
to fail on the parent in both directions; registry lock discipline sound.
One critical found and fixed:

- **TransientKeyResolutionError classification was dead code**: the error
  was rewrapped in a plain `Error` one frame up the stack, so
  `pull()`'s `instanceof` never matched and transient share failures still
  counted toward the 3-strike quarantine. Fixed (instance preserved) +
  transport tests: resolver rejection → `retryable: true` +
  `TransientKeyResolutionError` instance; definitive miss → permanent.
- **Both new ws revocation tests were vacuous** (no broker → registration/
  kick/broadcast never ran; assertions passed with `kick_member` deleted).
  Rebuilt on a real broker with positive discrimination: friend receives
  `revoked` + `sync` (positive controls), revoked member receives neither,
  connection stays usable for personal spaces. The casing test now also
  pins the canonical broadcast join (uppercase revoke → canonical
  subscribers notified).
- Follow-up rotation suppression could silently strand a derivable epoch →
  suppressed completions now defer to exactly one pass after the in-flight
  rotation; a suppression during that pass gives up loudly (error logged,
  no spin). Pinned by a test (3 advance attempts, 1 warn, 1 give-up error,
  loop stops against a persistently conflicting server).
- `broadcast_revocation` keyed on raw `params.space` (uppercase revoke
  silently dropped the notification) → canonical `space_id.to_string()`,
  pinned by the casing test.
- Broker-less connections hot-spun on the closed detach channel → the arm
  is parked (pending future) when no realtime session exists.
- Hygiene: rebuilt-log ghost exclusion now asserted (membership.append
  capture); stacked doc comments separated; stray `*/` fixed; redundant
  block removed from `register`.

Classification edges documented (not defects): a definitive `not_found` for
a fresh epoch derives-and-caches a key (safe default; share arrival cannot
override the cache — watch item); a permanent JWE decrypt failure (rotated
device key) classifies as transient forever (never quarantines).

## Regression-test matrix (fixed findings → named tests)

| Finding | Regression tests |
|---|---|
| AUD-001 | CI gate itself (workflow provisions PG + `BB_TEST_REQUIRE_DB=1`); no unit test possible |
| AUD-002 | `check-all`/`check-platform` recipes; dry-run verified in wave 0 |
| AUD-003 | `recover_init_rejects_token_issued_for_a_different_email`, `rejected_binding_does_not_consume_the_verification_token`, `recover_init_rejects_non_recovery_purpose_tokens`, `recover_init_rejects_malformed_email_with_bad_request` |
| AUD-005 | `consent_requires_key_delivery_for_the_sync_flow`, `consent_rejects_partial_key_delivery_pair`, `consent_rejects_thumbprint_that_does_not_match_signed_recipient`, `consent_accepts_thumbprint_matching_signed_recipient`, `consent_context_returns_fields_from_the_signed_state`, `consent_context_rejects_invalid_state`, `consent_context_requires_authentication`, `jwk_thumbprint_matches_the_shared_known_answer`, `authorize_redirect_carries_only_the_signed_state_token` |
| AUD-006 | `password_init_rejects_verified_email_claiming_an_existing_username` (incl. retry-succeeds), `password_init_allows_resuming_an_unfinished_signup`, `password_init_rejects_token_issued_for_a_different_email`, `password_init_matches_the_verification_email_across_casing`; storage: signup-finalize CAS + get_or_create conflict pair + `cleanup_unregistered_accounts_reclaims_only_stale_reservations` (backdated registered account) |
| AUD-015 | the storage suite (28) + route-level suites (18) over the real-router harness |
| AUD-024 | SDK: removeMember re-invite/ghost (shares + rebuilt log), removeMember share distribution + fresh rewrap, follow-up distributes epoch-3 shares, deferred follow-up bound, resolveEpochKey fallback pair, transport pull classification pair. Sync ws: `websocket_revocation_detaches_the_removed_members_subscription` (broker, positive control, still-alive), `websocket_revocation_detach_joins_across_uuid_casing`, registry unit trio. E2E: revocation.spec.ts (12 incl. re-invitation, multi-space isolation) |
| AUD-026 | storage: `rewrap_with_stale_observed_dek_is_rejected`, `rewrap_file_deks_with_stale_observed_wrapper_is_rejected`; ws: `websocket_deks_rewrap_returns_conflict_on_stale_observed_wrapper`, `websocket_file_deks_rewrap_returns_conflict_on_stale_observed_wrapper`; SDK: reencrypt retry trio + CryptoKey-path pair |
| AUD-028 | ws: `{membership_revoke,epoch_begin,epoch_complete}_with_write_ucan_is_forbidden`, `{epoch_begin,membership_revoke}_with_admin_ucan_succeeds` |
| AUD-029 | ws/storage: `push_below_min_key_generation_is_rejected_for_shared_spaces`, `push_below_min_generation_allows_tombstones`, `record_file_below_min_key_generation_is_rejected_for_shared_spaces` |
| AUD-030 | SDK: conflict-string matrix (`recognizes the server's 'conflict' error code` + legacy spelling + success) |
| AUD-031 | ws: `websocket_connection_closes_at_token_expiry` |
| AUD-032 | SDK: `getDEKs parses the ordinary deks.get result (real server shape)` + file variant |
| AUD-034 | SDK: recipient-side `stores the invitation's key generation as the space epoch` + sender-side `labels the invitation payload with the current key generation` |
| AUD-060 | per-test-schema harness + `BB_TEST_REQUIRE_DB=1` enforcement; 23 storage tests (wave 0), since grown |

## Verification

- accounts: `just check` (fmt/clippy/tests) + `just test-db` — 72 tests
  against real PostgreSQL, all green.
- sync: `just check` + `just test-db` — 437 tests green, clippy
  `-D warnings` clean.
- betterbase: `just check` — 484 vitest + 199 browser tests green, tsc clean.
- platform: `just e2e` — 121/121 on the completing run; one transient
  `conflict-reconcile.spec.ts:56` failure on the first run matches the
  documented pre-existing concurrent-sync-race flake (watch item since
  wave 2a; unrelated to this round's revocation/rotation paths — the
  failing spec touches offline CRDT convergence only).

Commits this round: betterbase-accounts (fail-closed + tests),
betterbase-sync (canonical broadcast, parked arm, broker-backed tests,
file CAS test), betterbase (transient classification fix, CryptoKey CAS,
deferred follow-up, consolidation + tests), betterbase-dev (this record).
