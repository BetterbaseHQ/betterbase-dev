# Remediation wave 7 — sync remainder (AUD-033/035/037/038/039/040)

Date: 2026-09-21. Scope: the remaining betterbase-sync findings plus their SDK touchpoints. Register: 37 → **43/60**.

## Changes

| Finding | Repo · commit | Fix summary |
|---|---|---|
| AUD-038 (High) | betterbase-sync `0bb94a7` | Federation rebroadcast gated on the sending peer's own validated subscription; drops logged. |
| AUD-037 | betterbase-sync `0bb94a7` | Per-socket reader task; notifications delivered to local broker gated to subscribed spaces; 60s response deadline; subscribe errors logged; pre-registration for race coverage. |
| AUD-040 | betterbase-sync `0bb94a7` | `X-Forwarded-Proto` reconstruction behind `FEDERATION_TRUST_FORWARDED_PROTO` (default off); https→wss mapping; garbage falls back to ws. |
| AUD-033 | sync `0bb94a7` + betterbase `ca6f6d5` | Optional additive `kind` on membership.append; self statements (accept/decline) authorize with Read, everything else still Write. |
| AUD-035 | betterbase `ca6f6d5` | Mailbox loop per-item isolation + session quarantine pruned of expired ids; decrypt failures never delete. |
| AUD-039 | betterbase-sync `0bb94a7` | Migration 014 `pending_file_deletions`; in-tx queueing on tombstone; 15-min sweep with 24h default grace (`FILE_DELETION_GRACE_SECS`); re-upload guard; `FileBlobStorage::delete`. |

## Regression tests (all verified failing on parent where feasible)

- **AUD-038**: `websocket_federation_rebroadcast_requires_subscription` — end-to-end WS: unsubscribed-space rebroadcast dropped (parent leaked it), subscribed-space delivered. Stash-verified failing on parent.
- **AUD-037**: `federation_peer_manager_delivers_notifications_during_call` (notification pushed before subscribe response still delivered + call completes), `federation_peer_manager_drops_notifications_for_unsubscribed_spaces`; 8 pre-existing federation_client tests pass against the restructured reader.
- **AUD-040**: wss-signed upgrade accepted behind trust flag / rejected without it (end-to-end), scheme mapping unit test.
- **AUD-033**: handler-level read+kind=accept ok / read unlabelled forbidden / write unlabelled ok; SDK appendEntry forwards kind and omits it for unlabelled calls.
- **AUD-035**: `continues past an undecryptable invitation` — poison item skipped, later invitation processed, no re-attempt on next poll. Stash-verified failing on parent.
- **AUD-039**: storage-level in-tx queueing + window semantics + idempotence (real PostgreSQL); api-level sweep deletes due objects / spares re-uploads; app config grace parsing.

## Full gates

- betterbase-sync: `cargo fmt` + `clippy -D warnings` + `cargo test --workspace` against PostgreSQL → **454 passed, 0 failed**.
- betterbase: `just check-js` → **519 node + 200 browser tests** green.
- Platform: `just check-all` green.
- E2E: main phase **125 passed + 3 gated-skips (4.4m)**; fault-injection **3/3 (1.1m)** — the two-server federation stack exercised the peer-reader/rebroadcast/signature changes live.

## Design notes

- AUD-033 boundary: membership payloads are opaque to the server; privileged effect is enforced by client-side signed hash-chain verification. The server gate (Write, or Read+kind) is anti-spam defense; the kind field is advisory metadata with no privileged server-side effect. Field addition is additive/backward-compatible (absent → Write; unknown values → invalid params) and documented as an additive v1 extension.
- AUD-039 GC safety: metadata rows are unique per (space, file_id), so no cross-record object sharing exists; the re-upload guard + 24h grace cover the PUT-retry (bytes-before-metadata) race; queue completion only after object erasure makes backend failures retryable.
- AUD-040 security: header spoofing without the flag cannot occur (flag off → header ignored); with the flag, a spoofed scheme can only cause signature-base mismatch (auth failure), never forgery.

## Review results (appended after completion)

Independent review of both deltas: verdicts **PASS** for AUD-038/040, **PASS-with-notes** for AUD-033/035/037/039. Two IMPORTANT and six MINOR findings; all fixed or honestly documented (betterbase-sync `200914d`, betterbase `9c9735d`):

- **IMPORTANT — lost-wakeup race (peer.rs):** the `Notify` waiter was armed only after the send, so a peer answering inside that window left the caller sleeping to the 60s deadline and then tearing down a healthy connection. Fixed: waiter `enable()`d before the send; send deadline-bounded (also closes the "peer stops reading → mutex wedged" MINOR); timed-out calls prefer a stored outcome before resetting.
- **IMPORTANT — AUD-033 boundary claim overstated:** client-side `verifyMembershipEntry` checks signature↔role consistency, not authority chains — any read-level member (or invitee) can forge member-list *display* entries (write members could pre-fix; wave 7 widened the appender set, did not create the hole). Server capabilities are unaffected (rooted-chain validation), and no client capability is derived from the log. Record corrected; client-side `prf`→root chain validation recorded as the v1.x hardening.
- **MINORs fixed:** rejected-subscribe spaces pruned from the outgoing notification gate (symmetry with the incoming gate); retries use fresh request ids (old reader's late frames can't complete the new slot); revocation-quarantine-until-restart tradeoff documented in code (server-side 403 enforcement makes it safe); sweep TOCTOU documented as accepted residual; `FEDERATION_TRUST_FORWARDED_PROTO` + `FILE_DELETION_GRACE_SECS` added to AGENTS.md.
- Empirical spot-checks by the reviewer: unknown `kind` values decode-fail as `invalid_params`; old-server decode ignores the `kind` field (graceful mixed-fleet degradation); DB-cutoff micros comparison unit-correct.

## Final gates (after review fixes)

betterbase-sync fmt/clippy/tests (PostgreSQL) **454 passed**; betterbase `check-js` **519 node + 200 browser**; `just e2e` **125+3 main (4.4m), faults 3/3 (50.1s)**.

Wave-7 commits (final): betterbase-sync `0bb94a7`, `200914d`; betterbase `ca6f6d5`, `9c9735d`. Register: **43/60**. Wave 7 complete.
