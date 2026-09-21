# Platform audit

This workspace tracks the security, correctness, durability, and architecture review across Betterbase. Final status (2026-09-20, audit paused): all component source-analysis reports and three cross-reviews are complete; two verification waves re-verified **every register entry (AUD-001..AUD-060) with zero refutations**, including ten isolated runtime reproductions; and the full baseline record is complete — every component check suite plus the platform E2E cycle (121/121) executed with recorded evidence ([coverage](coverage.md), [findings](findings.md), [baseline](baseline.md)). The Stage 3 runtime campaigns and cross-component closure checks were **deferred by user decision [D-003](decisions.md)**. **Remediation has begun per [D-004](decisions.md)**: waves 0–2b are fixed and verified — test gates (AUD-060/001/002, AUD-015), account-takeover criticals (AUD-003/005/006), the rotation/authorization cluster (AUD-026/028/029/030/032/034), and revocation forward secrecy per D-005 (AUD-024, AUD-031). All other findings remain open.

| Document | Purpose |
| --- | --- |
| [Plan](plan.md) | Review stages, component scope, failure scenarios, and completion criteria |
| [Baseline](baseline.md) | Inspected revisions and test execution status |
| [Coverage](coverage.md) | Review assignments, progress, and cross-component reconciliation |
| [Invariants](invariants.md) | Candidate guarantees to map to code and executable evidence |
| [Findings](findings.md) | Central register of defects, risks, and evidence gaps |
| [Decisions](decisions.md) | Workflow choices and unresolved product guarantees |
| [Handoff brief](handoff-critical-verification.md) | Directions for a second model independently verifying the six critical findings |
| [Templates](templates/review.md) | Consistent review, finding, and evidence records |

## Working method

Complete the entire analysis and reconcile findings before remediation, as explicitly requested by the user on 2026-09-20. The platform is not in production. Capture source evidence and isolated reproductions; do not fix product code during this audit, including critical findings. The later remediation phase will use focused changes, regression checks, and separate verification.

Analysis assignments may read code and run appropriate isolated checks; they do not change product code. Reproduction code and sanitized evidence belong in the audit workspace or a designated isolated checkout. Fixes are a distinct work package linked to a finding. Protocol or guarantee changes also link to a decision and migration plan where needed.

Findings distinguish evidence from severity. A missing test is an assurance gap, not proof of a vulnerability. Suspected issues remain hypotheses until supported by a reproducible failure or a complete source argument. “Fixed” and “verified” are separate states.

## Parallel review

Use up to three review agents plus a coordinator. For the first analysis batch:

| Assignment | Scope | Initial output |
| --- | --- | --- |
| A: identity and keys | Accounts, accounts browser crypto, SDK auth/crypto, recovery and key delivery | `reviews/01-identity-keys.md` |
| B: local data and CRDT | json-joy-rs paths used by Betterbase, SDK database, OPFS/WASM, local durability | `reviews/02-local-data.md` |
| C: sync and authorization | Sync service, SDK sync orchestration, cursors, membership, epochs, files and federation | `reviews/03-sync.md` |
| Coordinator | Baseline, invariant definitions, shared workflow trace, deduplication and cross-boundary review | Central tracking documents and reconciled findings |

The original run completed both batches plus cross-reviews at the source level, but was interrupted before verification evidence, the central baseline record, and dependency evidence were finished (review B's agent was halted mid-run; its report was coordinator-recovered). A successor coordinator resumed on 2026-09-20: the register was triaged ([findings](findings.md)) and four verification agents re-verified the critical/high identity, sync, local-data, and deployment/dependency findings against the same pinned baselines, with evidence recorded under `evidence/`. Each new assignment must include exact revisions, invariant IDs, bounded entry points, report ownership, allowed test resources, and excluded work. Reading overlapping code is expected; editing another reviewer's output is not.

Review agents use provisional IDs such as `A-01` inside their reports. The coordinator validates and deduplicates candidates, assigns stable `AUD-NNN` IDs, and updates the central register. Agent agreement is not independent proof: review evidence and counterexamples. Schedule cross-review of key handoffs, cursor/transaction ownership, and revocation/rotation before closing a batch.

Coordinate database containers, ports, generated artifacts, dependency installation, and expensive test runs. Use isolated worktrees/test resources when a reproduction requires edits or incompatible configurations. Record exclusions explicitly so the union of agent reports cannot hide an unreviewed boundary.

## Recording work

- Use [the review template](templates/review.md) for `reviews/<batch>-<scope>.md`.
- Use [the finding template](templates/finding.md) for `findings/AUD-NNN.md` once a candidate is triaged.
- Use [the evidence template](templates/evidence.md) for `evidence/<date>-<scope>-<case>.md`.
- Capture the tested commit and any local patch; findings continue to refer to their original baseline after fixes land.
- Keep credentials, bearer tokens, key material, private user data, and unsanitized logs out of these records.

The original run used three review agents and a coordinator; their reports are in `reviews/`. The successor verification wave uses four agents against the same pinned baselines. Baseline tests use a disposable audit PostgreSQL container and the separate existing E2E stack; dev services are not test targets.
