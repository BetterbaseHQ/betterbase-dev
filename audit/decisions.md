# Decisions and open guarantees

## D-001: Complete the whole audit before remediation

2026-09-20 — Explicit user decision superseding the earlier batch-remediation proposal: “let's do the whole audit and then we'll fix issues.” The platform is not in production. Complete source review, baseline checks, reproductions, and cross-component reconciliation before any product fixes, including critical issues.

Reason: retain a stable implementation and identify shared architectural causes across the full platform before choosing corrections. Reproduction harnesses and audit documentation are permitted; product changes are deferred.

## D-002: Parallel component reviews with central reconciliation

2026-09-20 — Active execution model: three reviewers and a coordinator, with exclusive report ownership, pinned baselines, shared invariant IDs, and scheduled cross-component review. Findings require evidence regardless of how many agents agree.

## D-003: Defer Stage 3 runtime campaigns and closure checks

2026-09-20 — Explicit user decision to stop after the verification and baseline phases: "we decided not to do that last phase for now."

Deferred scope: Stage 3 cross-component failure campaigns (fault injection, crash/failover schedules, PostgreSQL concurrency schedules, TLS-proxy federation, restore/upgrade drills), real-browser journey coverage for identity flows and examples, and the coordinator's cross-component closure reconciliation.

What stands as the audit's evidence base: all component source-analysis reports and cross-reviews; the fully verified register AUD-001..AUD-060 (two verification waves, zero refutations); ten isolated runtime reproductions; and the complete central baseline record including the 121/121 platform E2E cycle with rebuilt-image provenance.

Interplay with D-001: D-001 required the whole audit before remediation. With the campaigns deferred, that bar is amended accordingly — remediation can proceed on the strength of verified findings; per [plan](plan.md) Stage 4, the deferred campaigns remain required evidence before any production-launch guarantee claim, and should be scheduled as regression gates when fixes land. Remediation timing itself remains a future user decision; nothing has been fixed.

Revisit condition: schedule the campaigns alongside/after remediation, and in any case before launch. No findings were retriaged or downgraded by this decision.

## D-004: Begin remediation in prioritized waves

2026-09-20 — User decision to start fixing findings, accepting the register (with its deferred Stage 3 campaigns, per D-003) as the evidence base. Wave order: (0) test gates and assurance infrastructure, (1) account-takeover criticals, (2) revocation/key-rotation cluster including coupled pairs (needs the revocation-guarantee decision recorded first), (3) silent data loss, (4) remainder by repo. Rules: one work package per finding or coupled cluster with a `findings/AUD-NNN.md` record; regression test first, then fix; "fixed" and "verified" recorded separately with evidence; cross-repository fixes coordinated explicitly; frozen v1 wire contracts get versioned migrations where a fix must touch them; deferred Stage 3 campaigns are scheduled as regression gates alongside the fixes they exercise.

Wave 0 (AUD-060, AUD-001, AUD-002, AUD-015 storage portion) completed 2026-09-20: [wave-0 evidence](evidence/2026-09-20-remediation-wave0.md). Wave 1 (AUD-003, AUD-005, AUD-006; AUD-015 route-level closure) completed 2026-09-20: [wave-1 evidence](evidence/2026-09-20-remediation-wave1.md). Independent code review ran per wave; its should-fix findings were fixed in-wave. Platform e2e runs are scheduled as the regression gate for the SPA/server co-deployed changes (per D-003's revisit condition).

## Product guarantees to resolve during Stage 1

These have no presumed answer and are not accepted limitations:

- Supported attacker model, including compromised sync service versus compromised browser/app delivery.
- Exact durability promise for “saved,” including device loss and browser storage eviction.
- Revocation timing, historical-data access, and treatment of previously downloaded keys/data.
- Maximum offline duration and behavior after history/tombstone compaction.
- Conflict outcomes and recovery policy for quarantined or permanently rejected records.
- Supported browsers and mixed client/server/schema versions.
- Inference trust/attestation responsibilities and allowed plaintext paths.
- Backup recovery objectives and required handling of key loss or server rollback.
