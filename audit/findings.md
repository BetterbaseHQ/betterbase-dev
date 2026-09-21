# Finding register

Triage reconciled 2026-09-20. All component and cross-review reports exist ([coverage](coverage.md)); their candidates are indexed here with stable `AUD-NNN` IDs. Source IDs (`A-xx`, `B-xx`, `C-xx`, `D-xx`, `E-xx`, `F-xx`, `XR-xx`) remain the key into the reports, which own the full arguments, counterevidence, and line references.

Severity values are the reports' provisional assessments. Unless the state says "reproduced", the finding is confirmed by complete source argument (some independently cross-verified) but has **no runtime reproduction** — do not treat it as exploited or runtime-verified. No product vulnerability has been fixed; remediation is deferred by [decision D-001](decisions.md).

Verification wave 2026-09-20 (successor agents, pinned baselines, repos clean): **all register entries AUD-001..AUD-060 now have independent verification evidence — zero refutations.** Wave 1 covered identity (A-01..A-05, A-08, A-14), sync (C-01/02/03/05/06/07/09/11), local data (B-01..B-05, XR-01/02), and deployment (F-01..F-03, AUD-001/002, dependencies). Wave 2 covered the remainder: identity A-06..A-13, sync C-04/08/10/12..17, examples E-01..E-10, inference D-01..D-04. The baseline wave then executed every component check suite plus the full platform E2E cycle (121/121), yielding AUD-060. Runtime reproductions exist for AUD-004, AUD-010, AUD-014, AUD-017–AUD-019, AUD-021, AUD-032, AUD-046, AUD-060 (plus a mechanism test for AUD-049); everything else is confirmed by complete source argument with independent re-verification. Evidence: [identity 1](evidence/2026-09-20-identity-verification.md), [identity 2](evidence/2026-09-20-identity-verification-2.md), [sync 1](evidence/2026-09-20-sync-verification.md), [sync 2](evidence/2026-09-20-sync-verification-2.md), [local data](evidence/2026-09-20-local-data-verification.md), [examples](evidence/2026-09-20-examples-verification.md), [inference](evidence/2026-09-20-inference-verification.md), [deployment](evidence/2026-09-20-deployment-verification.md), [dependencies](evidence/dependencies.md), and the baseline files `evidence/2026-09-20-baseline-*.md`. Minor line-reference corrections are recorded inside the evidence files; report text is left as the original reviewers wrote it. The remaining evidence gap — the Stage 3 runtime campaigns — is deliberately deferred by decision [D-003](decisions.md); the audit is paused with this register as its evidence base. Remediation began 2026-09-20 per decision [D-004](decisions.md): wave 0 (test gates) fixed, everything else open.

## Identity, accounts, and keys (report 01, cross-checked in 08)

| ID | Source | Type | Observation | Severity (provisional) | State |
| --- | --- | --- | --- | --- | --- |
| AUD-003 | A-01 | Defect | Recovery init verifies a token for one email but recovers an independently supplied account; no equality check. Account takeover path. | Critical | Open; source-confirmed, cross-verified; re-verified 2026-09-20 |
| AUD-004 | A-02 | Defect | Refresh-token reuse does not revoke the surviving family; concurrent-reuse revocation DELETE runs inside an aborted transaction. | High | Open; **reproduced** (SQL mechanism, both orderings incl. exact product path, isolated PG); re-verified 2026-09-20 |
| AUD-005 | A-03 | Defect (composition) | Consent page trusts unsigned URL params over signed OAuth state; can wrap a different app's keys to an attacker's recipient. | Critical | Open; source-confirmed, cross-verified; re-verified 2026-09-20 |
| AUD-006 | A-04 | Defect | Registration binds the verified email but resolves the account by submitted username; finalization overwrites an existing account's credentials. | Critical | Open; source-confirmed, cross-verified; re-verified 2026-09-20 |
| AUD-007 | A-05 | Defect | Recovery page consumes its one-use verification token at blob fetch and again at init; legitimate UI recovery cannot complete. | High | Open; source-confirmed, cross-verified; re-verified 2026-09-20 |
| AUD-008 | A-06 | Defect | Transient grant-read failures during consent silently generate replacement key material; can destroy recoverability of the signing identity. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-009 | A-07 | Defect (race) | Root rotation accepts incomplete grant lists and has no generation/CAS check; concurrent consent/password-change can strand grants under the old root. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-010 | A-08 | Defect | In-flight refresh completes after `destroy()` and re-persists a logged-out session. | High | Open; **reproduced** (Node harness, 8/8 assertions); re-verified 2026-09-20 |
| AUD-011 | A-09 | Design limitation / defect | Password recovery/change revokes no prior sessions; 14-day auth JWTs and slid refresh tokens remain usable. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-012 | A-10 | Defect (candidate) | KeyStore/AuthSession storage not identity-scoped; cross-tab account replacement leaves stale keys/db with new credentials. Downstream impact pending integration evidence. | High candidate | Open; source mismatch confirmed; re-verified 2026-09-20 (wave 2) (downstream impact still pending integration evidence) |
| AUD-013 | A-11 | Defect | Refresh grants the first grant's scope, not the current authorization's (narrow→broad regain possible). | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-014 | A-12 | Defect (race) | Email-code attempt counting and consumption are not atomic; the 5-attempt bound can be exceeded, multiple correct codes can succeed. | Medium | Open; **reproduced** (SQL mechanism: duplicate success + attempt-bound overrun, isolated PG); re-verified 2026-09-20 (wave 2) |
| AUD-015 | A-13 | Assurance gap | No accounts storage or route-level tests; CI DB-skip comment overstates what enabling PostgreSQL adds. | High gap | Open — **storage portion fixed & locally verified 2026-09-20** (23 storage tests, enforced live-PostgreSQL gate; [evidence](evidence/2026-09-20-remediation-wave0.md), [record](findings/AUD-015.md)); route-level tests remain open (planned with wave 1) |
| AUD-016 | A-14 | Defect | Recovery setup replaces the stored recovery blob before the user confirms saving the new phrase. | High | Open; source-confirmed, qualified (in-flight window); re-verified 2026-09-20 |

## Local data and CRDT (report 02, cross-checked in 09)

| ID | Source | Type | Observation | Severity (provisional) | State |
| --- | --- | --- | --- | --- | --- |
| AUD-017 | B-01 | Defect (configuration) | Persistent OPFS database uses `journal_mode=MEMORY`; abrupt browser termination can corrupt previously committed data. | High | Open; **reproduced** (native crash harness re-run: malformed DB, committed data lost; browser crash still untested); re-verified 2026-09-20 |
| AUD-018 | B-02 | Defect | Generated 64-bit actor IDs exceed the codec's 57-bit range; identity silently truncates in model binaries. | Medium | Open; **reproduced** (round-trip re-executed, exact truncation value); re-verified 2026-09-20 |
| AUD-019 | B-03 | Defect | Acknowledgement guard ignores metadata-only changes; an old ACK can clear a newer routing-metadata edit. | High | Open; **reproduced** (record-manager primitive re-executed at SDK layer); re-verified 2026-09-20 |
| AUD-020 | B-04 | Defect (concurrency) | Native read/modify/write lacks an encompassing lock; cross-review corrected the original counterevidence — explicit transactions do **not** hold the mutex across the closure. | High | Open; source-confirmed, cross-verified & widened (correction confirmed in code); re-verified 2026-09-20 |
| AUD-021 | B-05 | Defect | Structural decoder trusts declared counts past EOF; malformed imported/decrypted models can force unbounded allocation. | High | Open; **reproduced** (7 input bytes to 100000 decoded slots); re-verified 2026-09-20 |
| AUD-022 | XR-01 | Defect | Pending auto-ID writes replayed without dedup after leader failover; ambiguous commit can duplicate inserts. | High | Open; source-confirmed; re-verified 2026-09-20 |
| AUD-023 | XR-02 | Defect | Failed OPFS initialization can retain leadership without a usable database, blocking later opens until page termination. | Medium | Open; source-confirmed; re-verified 2026-09-20 |

## Sync server and SDK synchronization (report 03, cross-checked in 07)

| ID | Source | Type | Observation | Severity (provisional) | State |
| --- | --- | --- | --- | --- | --- |
| AUD-024 | C-01 | Defect | Revocation does not remove subscriptions; broadcasts still deliver ciphertext+DEKs, and the replacement epoch key is forward-derived from the old key, so a removed member can decrypt future content (bounded by ~66 min connection lifetime). | Critical/High | Open; source-confirmed, cross-verified; re-verified 2026-09-20 |
| AUD-025 | C-02 | Defect | Per-space pull cursor advances before local application; decrypt failures and partial streams are silently skipped. | High | Open; source-confirmed, cross-verified; re-verified 2026-09-20 |
| AUD-026 | C-03 | Defect (race) | DEK rewrap updates by record ID without comparing observed ciphertext; can pair a new ciphertext with a stale wrapped key. Masked in stock SDK by AUD-032 until fixed. | High | Open; source-confirmed, cross-verified (must be fixed together with AUD-032); re-verified 2026-09-20 |
| AUD-027 | C-04 | Defect | File upload retry returns 204 on AlreadyExists before metadata commit; interrupted first attempt is falsely acknowledged. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) (TOCTOU adjacency verified) |
| AUD-028 | C-05 | Defect (authorization) | `membership.revoke` and epoch lifecycle RPCs require only Write, not Admin; SDK's stated role boundary is not server-enforced. | High | Open; source-confirmed; re-verified 2026-09-20 |
| AUD-029 | C-06 | Defect | Minimum key-generation enforcement disconnected from network pushes (`PushOptions::None` from the API adapter); stale-epoch writes accepted. | High | Open; source-confirmed (client and federation push paths both affected); re-verified 2026-09-20 |
| AUD-030 | C-07 | Defect | Server sends `error: "conflict"`; SDK recovery path only recognizes `"epoch_conflict"` — rotation conflicts are treated as success. | Medium/High | Open; source-confirmed (incidentally re-verified); re-verified 2026-09-20 |
| AUD-031 | C-08 | Design limitation | WebSocket session authorization outlives JWT expiry (up to ~66 min connection lifetime); expiry not enforceable on open connections. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-032 | C-09 | Defect | Server returns ordinary `deks.get` result; chunked SDK client discards it and resolves with empty arrays — rotation completes with zero rewraps. | High | Open; **reproduced** (runtime harness against real SDK client code, 7/7); re-verified 2026-09-20 |
| AUD-033 | C-10 | Defect | Read-only invitees cannot accept/decline: membership append requires Write but the SDK signs acceptance with the read UCAN. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-034 | C-11 | Defect | Invitations after rotation deliver the current key labelled epoch 1; invitees derive wrong keys for all epochs. | High | Open; source-confirmed; re-verified 2026-09-20 |
| AUD-035 | C-12 | Defect | One undecryptable invitation rejects the whole mailbox-processing loop; later invitations/revocations unprocessed. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) (poison item retained at queue head) |
| AUD-036 | C-13 | Defect | Interrupted uploads stay permanently `uploading`; never rescanned, and eviction pins their cache allocation. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) (no reset path exists) |
| AUD-037 | C-14 | Defect | Outgoing federation connections discard realtime notifications; no reader task delivers frames to the local broker. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-038 | C-15 | Defect (trust boundary) | Authenticated federation peers can rebroadcast notifications into spaces they are not delegated for; per-peer quota/UCAN path bypassed. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-039 | C-16 | Defect / policy gap | Record deletion never schedules file-object removal; encrypted objects retained indefinitely. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) (no deletion call site repo-wide) |
| AUD-040 | C-17 | Defect | Federation URL signing (full ws/wss scheme) vs proxy-reconstructed `ws://` mismatch breaks signatures behind TLS-terminating proxies. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) (wss default confirmed as production path) |

## Inference (report 04)

| ID | Source | Type | Observation | Severity (provisional) | State |
| --- | --- | --- | --- | --- | --- |
| AUD-041 | D-01 | Defect (claim/integration) | Documented quick-start sends plaintext through the "E2EE" proxy; no checked-in client implements encryption/attestation. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-042 | D-02 | Defect (defaults) | Empty issuer/audience restrictions permitted; production example configures neither. | Medium | Open; source-confirmed (conditional); re-verified 2026-09-20 (wave 2) |
| AUD-043 | D-03 | Defect | Unknown JWKS key IDs trigger repeated serialized refreshes pre-auth, outside the user rate limiter. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-044 | D-04 | Assurance gap | Public/streaming proxy routes lack aggregate body/stream/concurrency bounds. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |

## Examples and shared UI (report 05)

| ID | Source | Type | Observation | Severity (provisional) | State |
| --- | --- | --- | --- | --- | --- |
| AUD-045 | E-01 | Defect | Prior account's decrypted records remain visible to another account and in unauthenticated views (all six persistent apps; fixed DB names, no account scoping). | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) (all six persistent apps) |
| AUD-046 | E-02 | Defect | Peer update during the notes debounce window replaces the pending save; unsynced keystrokes never reach the database. | High | Open; **reproduced** (installed Mantine hook harness, 5/5 assertions); re-verified 2026-09-20 (wave 2) |
| AUD-047 | E-03 | Defect | Interrupted board sharing leaves children referencing a tombstoned parent; permanently disconnected, no recovery mapping. | High | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-048 | E-04 | Defect | Failed photo byte persistence leaves an undeletable unavailable tile. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-049 | E-05 | Defect | Task read/modify/write without CRDT base can overwrite an intervening sync update (removes peer-added todos). | High | Open; source-confirmed + mechanism test executed (SDK stale-full-value-write test); re-verified 2026-09-20 (wave 2) |
| AUD-050 | E-06 | Defect (trust) | Chat attribution trusts a writable `senderHandle`; green shield validates chain integrity, not displayed identity. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-051 | E-07 | Defect | Chat send completion clears newer drafts; preview-failure retry duplicates the committed message. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-052 | E-08 | Assurance gap | Photo upload queue failures invisible in sync-status UI; "Synced" shown while bytes are pending/failed. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-053 | E-09 | Defect | Default notebook/board creation failures bypass the error UI and the one-shot guard blocks retry. | Low | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |
| AUD-054 | E-10 | Defect | Partial column-deletion failure hides surviving cards. | Medium | Open; source-confirmed; re-verified 2026-09-20 (wave 2) |

## Deployment, release, and assurance (report 06)

| ID | Source | Type | Observation | Severity (provisional) | State |
| --- | --- | --- | --- | --- | --- |
| AUD-055 | F-01 | Defect (deployment) | Production recipe serves plain HTTP; TLS site env not wired into Caddy, ports 80/443 unconfigured. | High | Open; source + config smoke evidence; re-verified 2026-09-20 |
| AUD-056 | F-02 | Defect (deployment) | Production compose omits SMTP env, advertises docker-internal sync endpoint, no file backend/volume. | Medium | Open; source-confirmed; re-verified 2026-09-20 |
| AUD-057 | F-03 | Assurance gap | Caddy rate-limit tiers target obsolete HTTP sync routes; WebSocket RPC messages not limited by them. | Medium | Open; source-confirmed, strengthened (tiered routes no longer exist in the router at all); re-verified 2026-09-20 |
| AUD-058 | F-04 | Assurance gap | No backup/restore recipe or release-pinning gate; green CI does not identify a reproducible platform release. | High gap | Open; source-confirmed; re-verified at HEAD 2026-09-20 (coordinator: no backup/restore recipes in justfile/scripts; examples CI checks out siblings without `ref` pins) |
| AUD-059 | F-05 | Dependency finding | RustSec: `rsa` advisory in accounts/sync/inference (no reachable RSA operation established); npm advisories across web workspaces (counts recorded; `evidence/dependencies.md` missing — regeneration assigned). | Medium | Open; scans re-executed, counts identical, advisory-db unchanged; [evidence recorded](evidence/dependencies.md) |

| AUD-060 | Baseline run | Defect (test infrastructure) | Accounts `just test-db` gate cannot execute: `db-start` applies no migrations, so sqlx `query!` macros check an empty live DB and compilation fails with ~80 errors; forced `SQLX_OFFLINE=true` still runs zero storage tests. The advertised real-PostgreSQL gate provides no assurance. | High gap | **Fixed 2026-09-20** (per-test-schema harness + `SQLX_OFFLINE` compile + `BB_TEST_REQUIRE_DB` enforcement + 23 storage tests); locally verified ([evidence](evidence/2026-09-20-remediation-wave0.md), [record](findings/AUD-060.md)); CI run pending push |

## Prior entries

| ID | Type | Observation | Evidence | Priority | State |
| --- | --- | --- | --- | --- | --- |
| AUD-001 | Test coverage gap | Accounts CI allows database-dependent tests to skip by omitting `DATABASE_URL`. | [Workflow](../betterbase-accounts/.github/workflows/check.yml), comment and test command at lines 43–44 at the baseline revision | First batch | **Fixed 2026-09-20** — CI provisions PostgreSQL, sets `DATABASE_URL` + `BB_TEST_REQUIRE_DB=1` ([record](findings/AUD-001.md)); locally verified, CI run pending push |
| AUD-002 | Platform gate gap | Root `check-all` omits inference, json-joy-rs, and platform E2E, despite checking all example packages. | [Recipe](../justfile), `check-all` at line 81 at the baseline revision | First batch | **Fixed 2026-09-20** — `check-all` += inference + json-joy-rs; new `check-platform` = `check-all` + `just e2e` ([record](findings/AUD-002.md)); dry-run verified, full execution pending |

Detailed finding records use [the finding template](templates/finding.md) when triage establishes impact, scope, and next actions. Do not infer exploit severity from a missing gate.

For future candidates, record type (defect, hypothesis, assurance gap, or design limitation), confidence, and severity separately. Lifecycle: candidate → confirmed or rejected → remediation → fixed → verified. If a risk is accepted or deferred, record the rationale, owner, scope, and revisit condition in a linked decision. Preserve rejected candidates and their disconfirming evidence.
