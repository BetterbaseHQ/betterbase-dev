# Handoff brief: independent verification of the critical findings

Written 2026-09-20 for a second model taking over verification of the most critical audit findings. Everything you need should be in this workspace; this brief tells you what to verify, how to verify it, and what has already been checked so you do not merely re-affirm it.

## Context and authorization

This is a **defensive security audit of the owner's own platform** (Betterbase — a local-first, end-to-end-encrypted application platform), performed before launch with the owner's full authorization. The platform is not in production. Your task is verification of already-registered defects so the owner can fix them. There is no third party being tested against.

Read [README.md](README.md) first for the working method. Core standard: **findings require evidence; agreement between reviewers is not proof**. Every claim below has been confirmed by at least two independent source-level passes (original review + verification wave); your value is to attempt **refutation** — hunt for the check that defeats each chain — and to add runtime evidence where feasible. A refutation with evidence is exactly as valuable as a confirmation.

## Independence protocol (supersedes any conflicting instruction below)

This brief was written by the model that produced the prior conclusions. That makes it an anchoring hazard, and these amendments exist to counteract it:

1. **Derive blind, then compare.** For each finding, your *first* pass uses only the one-line claim table above and the pinned sources — not the reports, cross-reviews, or evidence files. Write down your own derived chain, where you would expect a defeating check to live, and your own provisional severity from preconditions. Only then read the prior conclusions. Differences between your derivation and theirs are the most interesting output either way — a chain step you cannot re-derive is a finding about the finding.
2. **The refutation avenues below are non-exhaustive and mine.** They mark where prior passes found nothing. If a chain is mischaracterized, the missing check is likelier somewhere unlisted. Search beyond the avenues; ignore them entirely if your blind derivation suggests different suspects.
3. **Distrust harness premises.** Re-running an embedded harness reproduces its author's *premises*, not just its results — a mock with a wrong frame shape green-lights itself (the SDK's own unit test has exactly this flaw, flagged below). Re-run existing harnesses for convenience, but rebuild at least one from primary definitions (e.g., server frame shapes from `betterbase-sync` RPC source, not from an evidence file's copy) and reconcile any difference.
4. **Re-derive severity; do not adopt mine.** The Critical/High labels are provisional framings. Re-derive reachability and preconditions yourself (e.g., AUD-005's registered-client requirement materially bounds it — verify whether provisioning is truly CLI-only).
5. **Expect agreement pressure and discount it.** Every finding has up to six prior confirmations. Agreement is the default failure mode of verification; the brief's standard is evidence, and a documented refutation is exactly as valuable as a confirmation. Your verdict should be no easier to reach for the crowd of prior agrees.

The per-finding sections below (chains, line numbers, preconditions) are the prior model's derivation, provided as comparison material and navigation help for pass two — treat them as claims under test, not ground truth.

## Scope: six findings, three repos

| Register ID | Source ID | One-line claim | Severity (provisional) |
| --- | --- | --- | --- |
| [AUD-003](findings.md) | A-01 | Recovery init verifies a token for one email but recovers an independently supplied account → account takeover | Critical |
| [AUD-005](findings.md) | A-03 | Consent page trusts unsigned URL params over signed OAuth state → cross-application key disclosure | Critical |
| [AUD-006](findings.md) | A-04 | Registration with a fresh verified email can overwrite an existing username's credentials → account takeover | Critical |
| [AUD-024](findings.md) | C-01 | Revoked member retains an active subscription and can derive future epoch keys → decrypts post-revocation content | Critical/High |
| [AUD-032](findings.md) | C-09 | DEK listing response-shape mismatch → every rotation completes with zero rewraps | High (reproduced) |
| [AUD-026](findings.md) | C-03 | Rewrap UPDATE lacks observed-value compare → concurrent push pairs new ciphertext with a stale wrapped key | High (masked by AUD-032) |

Everything else in [the register](findings.md) is out of scope, as are remediation and the deferred Stage 3 campaigns ([decision D-003](decisions.md)).

## Environment

- Repos (siblings of this directory; verify clean at these exact HEADs before starting and again at the end — `git rev-parse HEAD` + `git status --short`):
  - `betterbase-accounts` `b7cda8872ee09cfad44f4186ff40096ee3c95483`
  - `betterbase-sync` `324da35e30922dfd3ab53c2fb862e7272b2e72f1`
  - `betterbase` (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`
- Tools: mise shims on PATH (rustc/cargo 1.98.1, node 24, pnpm 12), python3, docker. Locking/timeout note: cargo builds can take minutes — use long command timeouts; re-run on timeout (cargo resumes).
- Disposable resources you may use: the `betterbase-audit-postgres` container (postgres:18-alpine, `docker exec betterbase-audit-postgres psql -U audit -d audit`, loopback 25432; create throwaway databases/schemas there and drop them after), and `/tmp` for harnesses. Prior harnesses live in `/tmp/betterbase-audit-data/` and inside the evidence files (the identity and sync evidence files embed harness essence).
- **Do not touch**: the running `betterbase-dev-*` and `betterbase-e2e-*` stacks (they are not your targets), product code (no edits, no commits, no `git restore` needed because you never change files), and existing audit documents (append-only discipline: your outputs are NEW evidence files only).

## Reading per finding (two passes, per the independence protocol)

**Pass 1 — blind derivation.** From the one-line claim table and the pinned sources only: re-derive the failure chain, note where a defeating check would have to exist, and record your own provisional severity. Write it down before proceeding.

**Pass 2 — comparison.** Then read, in order:

1. The original report argument: [01-identity-keys.md](reviews/01-identity-keys.md) for A-01/A-03/A-04; [03-sync.md](reviews/03-sync.md) for C-01/C-03/C-09.
2. The prior cross-review: [08](reviews/08-cross-review-examples-to-identity.md) (A-01/A-03/A-04), [07](reviews/07-cross-review-identity-to-sync.md) (C-01/C-03/C-09) — these already hunted counterevidence once.
3. The verification-wave evidence: [identity](evidence/2026-09-20-identity-verification.md), [sync](evidence/2026-09-20-sync-verification.md) — including minor line-reference corrections (trust these over the reports' line numbers).

Reconcile against your pass-1 derivation and investigate every discrepancy in either direction.

## What to do, and where a refutation would have to come from

Work source-first: re-derive each chain from the code at the pinned SHAs. Then attempt the runtime evidence listed. The "refutation avenues" below are the places prior passes found no defeating check — if you find one, that is a significant result; verify it carefully and record it.

### AUD-003 (A-01) — recovery account binding

Chain: `recover/init` validates a signed verification token (purpose RECOVERY, JTI consumed) whose claims bind the **attacker-controlled** email obtained via the normal verification flow; it then resolves the **target** account solely from `req.email` (`betterbase-accounts/crates/api/src/handlers/recovery.rs` — token validation ~107, purpose check ~115, target lookup ~132–149). No comparison of the two identities anywhere. Finalization replaces the victim's OPAQUE record, optionally the root wrapper, and issues the victim's auth token (~201–256; `composite.rs:10–39`). The recovery phrase is checked only in the browser (`web/src/pages/recover.tsx`), never server-side.

Refutation avenues: any equality check between `v_claims.email` and the resolved account; any finalize-time ownership/proof gate; anything in the route middleware (`crates/api/src/lib.rs`) beyond protocol-header/body-limit/CORS. Already ruled out: CAP (cost gate, no identity), the 5/hour rate limit (bounds volume on the victim's email, not identity), OPAQUE re-registration semantics (requires no old password — correct primitive behavior that makes the missing check material).

Runtime to attempt (highest-value gap): a route-level reproduction — build an isolated harness in `/tmp` with path deps on the accounts crates (as the wave-1 harnesses did for the SDK), backing storage on a throwaway database in the audit container: request a verification code for attacker@x, confirm it, then call `recover/init` with `email: victim@x` plus the attacker token; assert the victim's credential row mutates and an auth token for the victim is returned. Also test the canonicalization corner (mixed-case/local-part forms) the report flags.

### AUD-005 (A-03) — consent unsigned-parameter mismatch

Chain: `/oauth/authorize` correctly signs client/redirect/scope/recipient into OAuth state, then duplicates client, display name, scope, and recipient as **plain URL params** on the consent redirect (`oauth.rs:217–228`). The SPA treats the URL fields as authoritative (`web/src/pages/consent.tsx` ~77/83): grant lookup by unsigned `client_id` (~183), scoped-key and app-keypair unwrap for that grant, JWE encrypted to the unsigned `keys_jwk` (~172/236). The backend takes its client from the **signed** state (~279) but accepts the SPA's opaque JWE/thumbprint unvalidated (~420) and returns that JWE at code exchange (~624). Signed-state checks and extended PKCE both pass because the attacker-chosen fields are internally consistent.

Preconditions already bounded (verify they still hold): attacker needs a **registered** client with a controlled redirect — cross-review 08 found provisioning is CLI-only (`bins/oauth-client`), no public registration route; victim must approve while their root is available; disclosure of an *existing* target app's keys requires an existing target grant (otherwise fresh keys are created — a continuity break overlapping A-06/AUD-008, not disclosure).

Refutation avenues: any server fetch of a validated authorization context by the SPA; any cross-check of consent-submitted client/thumbprint against the signed state; a unique-constraint or binding at grant read (`oauth.rs:872–902` intentionally allows the account browser to read any of its grants — confirm that reading). Runtime to attempt: a Playwright or mocked-page test that mutates each duplicated URL parameter independently and asserts which mutations survive to the delivered JWE; the report's regression proposal is exactly this.

### AUD-006 (A-04) — registration username conflict

Chain: registration token correctly binds the attacker's fresh email (`handlers/auth.rs:49–53`), but `get_or_create_account` resolves conflicts on `(issuer, username)` with `ON CONFLICT DO UPDATE … RETURNING` the **existing** row, comparing neither email nor registration status (`crates/storage/src/postgres/accounts.rs:43–59`). Finalization is an unconditional `UPDATE … WHERE id = $1` (~161–170) — no `opaque_record IS NULL`, no owner, no expected version. The `(issuer, email)` unique constraint never fires with a fresh email; the only trigger touches `updated_at`. A comment in `handlers/verification.rs` promises a finalize-time conflict guard that does not exist.

Refutation avenues: any guard between state consumption and the final UPDATE; reservation/compare-and-set semantics anywhere in `crates/storage/src/postgres/registration.rs`; concurrent-registration behavior (two racing finalizes) — the report asserts no protection, worth testing on the audit container.

Runtime to attempt: same isolated route-harness pattern as AUD-003 — verified fresh email + existing victim username → assert victim's OPAQUE record and root wrapper replaced and an auth token for the victim issued.

### AUD-024 (C-01) — revocation retains subscription + forward-derived keys

Chain (two independent halves that compose):
1. Server: `membership.revoke` stores the revoked CID, broadcasts a generic `revoked` notification, and returns — it never removes the affected subscriptions (`betterbase-sync/crates/api/src/ws/rpc/membership_revoke.rs:73–88`; `realtime.rs:193–225`). The broker sends each subsequent space notification to indexed subscribers checking only closed-state and sender-exclusion (`crates/realtime/src/broker/multi.rs:157–207`), and push broadcasts contain **ciphertext plus wrapped DEKs** (`push_helpers.rs:32–45`) — not mere invalidation signals.
2. Client-side crypto: the removal path derives the replacement epoch key from the current key via the public forward chain (`betterbase/js/src/sync/space-manager.ts:755–756, 814–830`; `reencrypt.ts:354–371` — derivation inputs are the old key plus public space/epoch data; no fresh secret reaches only remaining members). The SDK's own Rust test demonstrates an old key decrypting a future epoch (`betterbase/crates/betterbase-sync-core/src/transport.rs:196–223`).

Exposure window is bounded: connections have a jittered maximum lifetime of 1 h ±10% (`ws/mod.rs:22, 482–487`) — state the bound as ≤ ~66 minutes, not indefinite.

Refutation avenues: any per-broadcast authorization hook; server-side subscription teardown on revoke other than the client's own `unsubscribe`; any fresh-entropy input in the SDK's rekey path; whether a revoked member's still-open socket actually remains in the subscription index after the revoke broadcast (trace the broker's index lifecycle). Note the federation reconnect extension (FST) was explicitly **not** verified — treat it as unknown, not as extending or narrowing the finding.

Runtime to attempt, in ascending cost: (a) Node harness on the real SDK sources (import pattern is in the sync evidence file) demonstrating old-key → future-epoch KEK derivation and decryption of a wrapped DEK; (b) isolated sync server (`cargo run` in betterbase-sync) against a throwaway database in the audit container, two scripted WebSocket clients: revoke mid-session, then have the remaining member push, and assert the revoked connection receives the broadcast frame and the retained key decrypts it. This is the single most valuable runtime gap in the audit.

### AUD-032 (C-09) and AUD-026 (C-03) — verify as a pair

C-09: server `deks.get`/`deks.getFiles` return one ordinary result `{deks:[…]}` (`betterbase-sync/crates/api/src/ws/rpc/deks.rs:49–60, 190–201`); the JS client uses `callChunked`, which discards the ordinary result and resolves successfully with an **empty array** when no count field is present (`ws-client.ts:312–345`, `rpc-connection.ts:148–170, 329`). Rotation then completes with zero rewraps and persists the new epoch key (`space-manager.ts:1068–1088, 1536–1549`). **Already reproduced at runtime** (7/7 harness in [the sync evidence](evidence/2026-09-20-sync-verification.md) — re-run it, don't rebuild it). Your job: confirm the harness still matches the pinned sources and check the one gap flagged there — the existing unit test (`ws-client.test.ts:284–303`) mocks chunk frames and a `wrapped_dek` property that doesn't match the client's `dek` field; assess whether any test anywhere exercises the true wire shape.

C-03: `rewrap_deks` updates the wrapped DEK by record/space ID with no compare against the observed ciphertext/cursor (`crates/storage/src/postgres/epochs.rs:111–150`), unlike push's real CAS (`records.rs:282`). A legal sequential schedule (rewrapper reads D1/C1 → writer pushes C2/D2 → rewrapper commits D1-under-new-epoch) pairs C2 with the wrong key. Currently **masked** by C-09 in the stock SDK (empty arrays mean the rewrap RPC is never sent), which is why they must be fixed together — repairing the wire shape alone exposes the destructive UPDATE to every normal rotation.

Refutation avenues for C-03: any generation/compare in the rewrap RPC decoder (`deks.rs:370` constructs a `DekRecord` with cursor zero — confirm); whether the space lock could serialize the interleaving (it cannot — it begins after the client's read; verify the transaction boundaries). Runtime to attempt: a two-connection PostgreSQL schedule on the audit container mirroring the exact statement order, asserting the final stored wrapper belongs to the overwritten ciphertext.

## Output requirements

1. One evidence file per major scope, NEW files only, following [the evidence template](templates/evidence.md): `evidence/<date>-handoff-<scope>.md`. Sanitize everything credential-like; synthetic values only. Record tool versions, exact commands, expected vs observed, and honest limits (mocks, untested paths). If a check is environment-blocked, record it as such rather than skipping silently.
2. Do not edit any existing file under `audit/` — reports, evidence, and the register are an append-only record. The orchestrator will integrate your verdicts into the register.
3. Final report back: a verdict table (AUD-ID → confirmed / **refuted** / qualified, one-line basis, and whether runtime evidence was added), plus the evidence file paths. For any refutation, include the exact defeating check and its location; for any qualification, state the precise boundary change.
4. If you cannot complete something, say so explicitly — an honest gap in the record is acceptable; a silent one is not.
