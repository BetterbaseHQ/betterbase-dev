# Review coverage

Status reconciled 2026-09-20 after the original coordinator run was interrupted; updated after verification waves 1 and 2 and the baseline wave. All six component scopes and three cross-reviews have completed **source-level analysis** reports, and **every register entry (AUD-001..AUD-060) has independent verification evidence — zero refutations**. Runtime reproductions exist for AUD-004, AUD-010, AUD-014, AUD-017–AUD-019, AUD-021, AUD-032, AUD-046, AUD-060, plus a mechanism test for AUD-049. **The audit is paused here by decision [D-003](decisions.md): the campaigns and closure checks below were deliberately deferred, not overlooked.**

| Batch | Scope | Candidate invariants | Status | Report |
| --- | --- | --- | --- | --- |
| 1 | Accounts + SDK auth/crypto | INV-04, INV-05, INV-07, INV-08 | Source analysis + all findings verified ([wave 1](evidence/2026-09-20-identity-verification.md), [wave 2](evidence/2026-09-20-identity-verification-2.md)); remaining: browser/regression coverage | [01-identity-keys.md](reviews/01-identity-keys.md) |
| 1 | json-joy-rs + SDK database/OPFS/WASM | INV-01, INV-03, INV-06, INV-07 | Source analysis + B-01..B-05/XR verification complete with reproductions ([evidence](evidence/2026-09-20-local-data-verification.md)); remaining: browser-crash, threaded-schedule, and fuzz campaigns | [02-local-data.md](reviews/02-local-data.md) |
| 1 | Sync server + SDK synchronization | INV-01–INV-07 | Source analysis + all findings verified, C-09 reproduced ([wave 1](evidence/2026-09-20-sync-verification.md), [wave 2](evidence/2026-09-20-sync-verification-2.md)); remaining: PostgreSQL race schedules, fault injection (C-04/C-13), two-server federation + TLS-proxy runtime (C-14/C-15/C-17) | [03-sync.md](reviews/03-sync.md) |
| 2 | Inference and intended client path | INV-04, INV-07 | Source analysis + all findings verified; native suite centrally recorded 25/25 ([evidence](evidence/2026-09-20-inference-verification.md)); remaining: attestation/downgrade and stream-cancellation runtime | [04-inference.md](reviews/04-inference.md) |
| 2 | Every example app + shared package | INV-01, INV-04, INV-06, INV-08 | Source analysis + all findings verified, E-02 reproduced ([evidence](evidence/2026-09-20-examples-verification.md)); remaining: real-browser journey/regression coverage | [05-examples.md](reviews/05-examples.md) |
| 2 | Orchestration, deployment, release and E2E | INV-01–INV-08 | Source analysis + F-01..F-03 and gate findings verified; dependency evidence regenerated ([deployment](evidence/2026-09-20-deployment-verification.md), [dependencies](evidence/dependencies.md)); remaining: restore/release-pipeline work (F-04) | [06-deployment-assurance.md](reviews/06-deployment-assurance.md) |

Cross-review assignments completed by the original run:

| Cross-review | Findings re-checked | Report |
| --- | --- | --- |
| Identity reviewer → sync | C-01, C-02, C-03, C-09 (all confirmed with qualifications) | [07-cross-review-identity-to-sync.md](reviews/07-cross-review-identity-to-sync.md) |
| Examples reviewer → identity | A-01, A-03, A-04, A-05 (all confirmed with qualifications) | [08-cross-review-examples-to-identity.md](reviews/08-cross-review-examples-to-identity.md) |
| Sync reviewer → local data | B-01–B-05 (all confirmed; B-04 counterevidence corrected, scope widened) plus new XR-01/XR-02 | [09-cross-review-sync-to-data.md](reviews/09-cross-review-sync-to-data.md) |

Interruption record: review B's original agent run was halted by the prior tooling before it wrote its report; its observations were recovered by the coordinator and are marked reviewer-reported where the coordinator did not repeat them (see report header). The dependency-scan evidence referenced by review 06 (`evidence/dependencies.md`) was never written by the original run; it has since been regenerated with identical counts ([evidence](evidence/dependencies.md)).

Deferred work (decision [D-003](decisions.md), 2026-09-20) — none of this was executed; schedule alongside remediation and before any launch claim:

- Runtime campaign evidence beyond the isolated reproductions and green baselines: fault injection (C-04 upload retry, C-13 crash), PostgreSQL concurrency schedules (C-03), real TLS-proxy federation (C-17, C-14, C-15), browser crash/failover (B-01, XR-01/XR-02), attestation/downgrade and stream cancellation (D-01/D-04), real-browser journeys for identity flows and examples apps, and restore/upgrade drills (F-04).
- Stage 3 cross-component failure scenarios from [the plan](plan.md) (server-commit-lost retries, revocation during offline edits, rotation races, account-switch with unsynced data, …).
- Coordinator reconciliation of the cross-component closure checks below (register triage complete; boundary-level reconciliation open).

Central baseline record: COMPLETE as of 2026-09-20 — every component check suite plus the full platform E2E cycle executed with recorded evidence ([baseline](baseline.md)). All green except the accounts DB gate, which was discovered broken (AUD-060).

Cross-component closure checks (deferred with D-003):

- Identity/key ownership agrees across accounts, SDK, and resource servers.
- Local durability, dirty snapshots, acknowledgements, pull application, and cursor persistence form a coherent state machine.
- Rotation and revocation enforce the agreed access guarantees across records, files, cached keys, and federation.
- Conflict, quarantine, and permanent failure states remain observable and recoverable through the application UI.
- Restore, schema changes, and mixed-version operation preserve the declared guarantees.

An assigned agent's final message alone does not close a row. Link the report, review its evidence, and record remaining gaps.
