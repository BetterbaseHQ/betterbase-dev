# Betterbase platform review plan

Proposed 2026-09-20. This is a reconnaissance-based plan, not a completed security audit. Source, repository guidance, CI, test configuration, and selected tests and implementations were inspected. No test suites were executed for this planning pass. See [the audit workspace](README.md) for execution workflow and current tracking.

Execution status (2026-09-20): Stages 1–2 completed with recorded evidence — all component reviews and cross-reviews, two verification waves over every register entry (AUD-001..AUD-060, zero refutations, ten isolated reproductions), and the full baseline record including platform E2E (121/121). Stage 3 campaigns and Stage 4 closure work were deferred by user decision [D-003](decisions.md); the plan's completion gates remain unmet until they are run. See [coverage](coverage.md) and [findings](findings.md).

The objective is evidence for specific confidentiality, integrity, durability, convergence, and recovery guarantees. Review each repository, but organize the highest-risk work around workflows that cross repository boundaries.

## Starting observations

- The SDK already has native Rust tests, TypeScript tests, and real Chromium/WASM tests, including OPFS persistence, dirty-state persistence, multi-tab behavior, and crypto interoperability. Build on these rather than starting a separate redundant suite.
- Accounts CI explicitly runs without `DATABASE_URL`, allowing database-dependent tests to skip. Sync CI provisions PostgreSQL and runs those tests. Accounts needs an enforced database test gate before a green build can support claims about transactional auth/key operations.
- The root `just check-all` currently checks the SDK, accounts, sync, and **all** example packages. It omits inference, json-joy-rs, and platform E2E. The root AGENTS.md description of example coverage is stale. There is no checked-in root GitHub Actions workflow in this snapshot.
- Both browser test configurations inspected select Chromium only. Define the supported browser/storage matrix and test those environments explicitly.
- E2E includes rotation, revocation, files, federation, and calamity scenarios. Some calamity tests represent “offline” by withholding explicit sync calls; `conflict-reconcile.spec.ts` actually disconnects the browser context. Review test mechanisms and assertions, not just names. Likewise, distinguish two servers operating independently from a real cross-server shared-space workflow.
- json-joy-rs has an upstream oracle, parity fixtures, and an explicit divergence/stub inventory. Those are valuable starting points; compatibility with another implementation is separate from independently demonstrating convergence and input safety.
- `betterbase/docs/delete-semantics.md` is a proposal with recorded fixes and unfinished phases. Revalidate its observations against current code and turn still-applicable items into tracked findings. Do not treat its proposed semantics or historical bug descriptions as current facts.
- Security-sensitive behavior spans Rust crypto, accounts browser-side Web Crypto/JWE logic, WASM bindings, browser key storage, SDK orchestration, and server authorization. There are also Rust and TypeScript sync-manager implementations to compare for semantic drift.

Evidence entry points:

- [SDK CI](../betterbase/.github/workflows/check.yml), [accounts CI](../betterbase-accounts/.github/workflows/check.yml), [sync CI](../betterbase-sync/.github/workflows/check.yml), [platform recipes](../justfile).
- [SDK browser configuration](../betterbase/js/vitest.browser.config.ts), [E2E configuration](../e2e/playwright.config.ts), [calamity scenarios](../e2e/tests/calamity.spec.ts), [network-disconnected reconciliation](../e2e/tests/conflict-reconcile.spec.ts).
- [CRDT parity audit](../json-joy-rs/tests/compat/PARITY_AUDIT.md), [delete-semantics proposal](../betterbase/docs/delete-semantics.md).

## Stage 1: Establish the guarantees and a reproducible baseline

Record each repository SHA, lockfiles, generated WASM provenance, effective configuration, and test outcomes. Use an isolated test stack and capture skips and unexecuted checks as explicitly as failures. Pin sibling repository revisions for integration testing; default-branch checkouts do not establish which release combination was verified.

Run the repository checks, accounts and sync database suites, CRDT parity gates/live interop, all example checks, and platform E2E. Check recipes before running: several formatting commands modify files. Keep baseline changes separate from fixes.

Produce a data-flow/trust-boundary diagram, key hierarchy, endpoint/RPC authorization matrix, and invariant-to-code-to-test table. Cover unauthenticated attackers, malicious members, revoked members, compromised sync servers, malicious federation peers, compromised accounts/app delivery, browser compromise, and ordinary crashes or storage failures.

Make the product promises precise:

1. Which data and metadata can each service observe? Where does inference plaintext exist, and which client verifies the intended execution environment?
2. What does “saved” mean: visible in memory, locally committed, or remotely acknowledged? What browser eviction and device-loss scenarios can each level survive?
3. What does revocation prevent, and when? Separate future writes, future reads, future key access, and data/keys already downloaded. Define historical-data access for newly invited or re-invited members.
4. What is the longest supported offline period, and what happens after tombstone/history compaction?
5. Which deletion/conflict outcomes are intentional? How do apps discover rejected, quarantined, or permanently unsyncable records?
6. Which server rollback, replay, omission, or equivocation attacks are detected, prevented, or outside the stated guarantees?

Core candidate invariants to validate:

- A local edit and the metadata needed to sync it commit together; an acknowledgement for an older snapshot cannot clear a newer edit.
- A pull cursor cannot advance past unapplied data unless the skipped work is durably recorded and recoverable.
- Retries after ambiguous network outcomes neither lose edits nor duplicate logical operations.
- Replicas converge under supported delivery schedules, with conflict outcomes matching the declared policy; equal final views alone do not prove that all intended edits survived.
- Authentication, authorization, ciphertext context binding, and key ownership agree on issuer, user, client, space, record, and epoch wherever applicable.
- Interrupted password changes, recovery, and key rotation cannot silently destroy the only usable key path.
- Malformed or unauthorized input cannot mutate protected state or cause unbounded resource consumption.

Exit: versioned guarantees and exclusions, an exact baseline, and a prioritized list of evidence gaps. Unsettled semantics become explicit design decisions before implementation changes.

## Stage 2: Review every component in dependency order

| Order / scope | Main review questions | Required evidence |
| --- | --- | --- |
| 1. `betterbase-accounts` plus SDK auth/crypto | OPAQUE registration/login, recovery, password changes, root/grant wrapping, extended PKCE and JWE recipient binding, refresh-token races/reuse, token-type separation, JWT/JWKS rotation, redirect/state validation, browser key lifecycle, concurrent key updates | Key lifecycle/state diagrams; independent vectors and interoperability checks; negative authorization tests; PostgreSQL race/rollback tests; fresh-device recovery of existing encrypted data |
| 2. `json-joy-rs` plus `betterbase-db` | The CRDT/codecs actually reachable from the SDK; actor/clock identity, causal prerequisites, duplicate and reordered patches, UTF-16/Unicode and numeric semantics, delete/update rules, malformed models, transaction boundaries, migrations | Pinned upstream differential tests plus independent model properties; minimized failing seeds; codec fuzzing; concurrent-edit and crash-recovery cases |
| 3. Remaining `betterbase` SDK | OPFS/VFS correctness, worker termination, locking/multiple tabs, dirty snapshots, pull cursors, quarantine/retry state, Rust/TS sync parity, scheduler reentrancy, serialization boundaries, files, sharing/moving/deleting trees, teardown/account switching | End-to-end trace of one edit; failure injection at each state transition; real-browser durability and isolation tests; explicit error and recovery behavior |
| 4. `betterbase-sync` plus SDK shared-space workflows | Per-operation authorization and tenant isolation, UCAN delegation/revocation, membership-chain verification, epoch rotation/rewrapping, cursor ordering and transactions, file metadata/object consistency, resource limits, federation trust/signatures/replay/quotas, discovery/SSRF | Route/RPC-by-role matrix; hostile-member/peer tests; real PostgreSQL concurrency tests; retained-old-key tests; cross-server sharing through actual federation paths |
| 5. `betterbase-inference` | JWT issuer/audience/scope behavior, key rotation, EHBP/HPKE trust and client attestation responsibilities, any plaintext fallback, forwarded headers, upstream credentials, streaming cancellation, rate/concurrency/body limits, sensitive logging | Trace from intended client to verified inference endpoint; invalid-key/attestation and downgrade rejection where supported; slow/aborted stream and resource-bound tests |
| 6. `betterbase-examples` | Every app and shared package: safe defaults, auth/logout isolation, accurate save/sync/error UI, rendering of untrusted collaborative content, import/export, file handling, partial share/move/delete recovery | Real user journeys; hostile shared content; interrupted workflow recovery; checks that apps cannot silently hide SDK errors. Prioritize passwords for local-data exposure, chat for rendering, photos for file lifecycles, board for relational operations |
| 7. `betterbase-dev`, deployment and `e2e` | Production config, actual proxy routes versus WebSocket RPC enforcement, TLS/origin/CSP/proxy trust, secret provisioning/rotation, backup/restore, database/object/key consistency, upgrades, dependency/build provenance, service health and privacy-preserving observability | Production-like deployment tests; reproducible release manifest; dependency/security checks; full restore drill including keys and files; upgrade/rollback compatibility matrix |

For OAuth, use [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html) as a requirements cross-check. Separately review Betterbase's custom key-delivery extension; standards compliance for the base OAuth flow does not validate that extension.

For each scope, evaluate architecture as well as defects: who owns each invariant, whether state is duplicated, whether invalid states are representable, whether errors survive every boundary, and whether the design can be tested without extensive mocks. Refactor when it removes an identified failure mechanism or clarifies ownership. Preserve frozen v1 routes, envelopes, wire strings, and protocol behavior; incompatible corrections need a versioned migration and mixed-version tests.

Exit per scope: reviewed surfaces and exclusions, severity-ranked findings with evidence, an architectural assessment, regression tests for confirmed defects, and verified fixes or explicitly unresolved decisions.

## Stage 3: Exercise failures that cross component boundaries

Start these tests as soon as the relevant component review identifies a risk. Finish with a platform campaign using deterministic schedules and reproducible seeds.

| Scenario | What must be demonstrated |
| --- | --- |
| Server commits a push, response is lost, client edits again and retries | No lost new edit; acknowledgement applies only to its snapshot; correct eventual convergence |
| Browser/worker dies around local commit, dirty marking, remote apply, or cursor persistence | Recovery returns a valid committed state and can resume every outstanding operation |
| Two tabs/devices write the same record while automatic and explicit sync overlap | Stable actor identity, serialization where required, bounded retries, no silent dirty-state loss |
| Malformed record appears partway through a pull | Other data can progress under the declared policy; failed data remains durably discoverable and retryable |
| Member is removed while an offline device edits and rotation is interrupted | Authorized devices retain access; revoked credentials/keys cannot gain prohibited future access; failures are visible |
| Server replays old ciphertext/membership state or swaps records between contexts | Context binding and freshness behavior match the threat model, including any documented limits |
| Password change/recovery/root-key rotation races, fails halfway, or is retried | Account and key state remain coherent; recovery decrypts pre-existing data on a fresh device |
| Client returns after compaction, schema upgrade, or server backup restore | No unexplained resurrection or missing records; incompatible history triggers a defined reconciliation path |
| File upload/replacement/delete races with record deletion or epoch rotation | Authorization, metadata, encrypted bytes, and caches remain consistent or recoverably reconciled |
| A/B federation is partitioned, a peer rotates keys, or signed messages replay | Actual cross-server workflows recover; unauthorized/replayed operations are rejected; quotas remain bounded |
| Large/adversarial inputs, stalled sockets, disk full, quota exhaustion | Bounded resource use; honest user-visible failure; no silent corruption or endless unobservable retry |
| Application upgrade or logout/account switch occurs with unsynced data | Declared retention policy is honored and another account never inherits the previous account's state |

Use three complementary levels: small state-machine/property tests for broad schedule exploration; differential tests and input fuzzing for CRDT/codecs/crypto boundaries; real PostgreSQL, browser, WebSocket, and object-storage integration tests for actual durability and protocol behavior. Respect CRDT causal prerequisites when generating schedules. Save and minimize every failure seed. Apply mutation checks selectively to prove that critical tests actually detect the fault they claim to detect.

## Stage 4: Turn findings into permanent release gates

Maintain one platform finding register. Each entry records the affected SHAs/components, violated invariant, attacker or failure preconditions, impact, reproduction, source evidence, confidence, proposed fix, compatibility implications, owner, regression test, and verification result. Separate confirmed bugs, suspected risks, test gaps, and intentional limitations.

Prioritize confidentiality failures, unauthorized access, unrecoverable key loss, silent data loss, and corruption first; availability and resource exhaustion follow according to impact. Keep fixes scoped to a finding, with coordinated cross-repository changes identified explicitly.

Required completion evidence:

- Every catastrophic-risk invariant maps to reviewed implementation and an executable test or an explicit limitation.
- Database and platform integration tests run as enforced gates, with unexpected skips failing the gate.
- Critical regressions run on changes; longer fuzz, randomized concurrency, and restore campaigns run on a defined schedule and before releases.
- No unresolved critical/high finding affecting a claimed launch guarantee; narrower guarantees or disabled affected features are documented decisions, not implicit acceptance.
- A fresh-device recovery and a complete isolated service restore both recover known encrypted records and files, including the required key material.
- Release compatibility is tested against the supported client/server/schema combinations and pinned repository revisions.
- Observability can identify stuck sync, rejected writes, key failures, and storage degradation without collecting plaintext, keys, or bearer tokens.

Commission an independent cryptographic/protocol review once the threat model and implementation are coherent, and reserve time to fix and re-review findings. Supply the key/state diagrams, custom protocol specifications, test vectors, and internal findings. Internal review provides the preparation and continuing regression defense; it should not be presented as independent certification.

## Recommended first work package

Start with Stage 1 and a vertical trace of **create/edit → local commit → encrypted push → server commit → acknowledgement → pull → decrypt/merge → durable cursor**, while documenting the key hierarchy that enables it. This gives the rest of the review a concrete model of both data safety and confidentiality.

The first package should deliver the baseline/coverage matrix, trust and key diagrams, a transaction/failure map for that workflow, verified initial findings, and a small set of high-value regression tests. Then proceed through the component sequence, carrying each finding through to verified resolution instead of accumulating an unbounded list of observations.

## Inspected revision snapshot

| Repository | HEAD |
| --- | --- |
| betterbase-dev | `7a36c07c7fc8` |
| betterbase | `e3a9ad167d8d` |
| betterbase-accounts | `b7cda8872ee0` |
| betterbase-sync | `324da35e3092` |
| betterbase-inference | `bf36ba4bb9cd` |
| betterbase-examples | `f8fc63bbce97` |
| json-joy-rs | `2dea0bd9669f` |

All component repositories were clean during reconnaissance. A pre-existing modified browser-console log in the orchestration repository was left untouched.
