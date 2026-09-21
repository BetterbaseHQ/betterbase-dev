# Baseline

Source snapshot captured 2026-09-20. This records inspected source, not a validated release combination. Record lockfile hashes, generated WASM provenance, tool versions, effective non-secret configuration, and exact commands with the first execution evidence.

| Repository | Commit | Initial worktree |
| --- | --- | --- |
| betterbase-dev | `7a36c07c7fc8a44dc86f09b4c34d518771cece8e` | Modified browser-console log and new review-plan documentation |
| betterbase | `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` | Clean |
| betterbase-accounts | `b7cda8872ee09cfad44f4186ff40096ee3c95483` | Clean |
| betterbase-sync | `324da35e30922dfd3ab53c2fb862e7272b2e72f1` | Clean |
| betterbase-inference | `bf36ba4bb9cd9fcd632ba91b4825b0d872edfea6` | Clean |
| betterbase-examples | `f8fc63bbce97b52d80ab603686212278af8318b9` | Clean |
| json-joy-rs | `2dea0bd9669f53ce0007225fe80d55a9a1525924` | Clean |

The pre-existing `.playwright-mcp/console-2026-09-19T19-25-51-282Z.log` modification was left untouched. Audit documentation is subsequent uncommitted work in the orchestration repository.

| Execution scope | Central evidence status | Notes |
| --- | --- | --- |
| SDK native, TypeScript and browser checks | Executed; evidence recorded | All pass at baseline: 1379 native (wasm crates excluded by design), 467 node vitest, 199 Chromium browser tests; clippy `-D warnings` clean; zero churn ([evidence](evidence/2026-09-20-baseline-betterbase.md)). |
| Accounts checks, including real PostgreSQL | Executed; DB gate found broken | fmt/clippy/26 native tests/check-web (175 pass, 2 hardcoded OPAQUE-integration skips) all pass — but the designed `just test-db` gate cannot even compile against a fresh container (no migrations applied → 80 sqlx live-DB errors), and **zero storage tests exist** in any mode; see AUD-015 and AUD-060 ([evidence](evidence/2026-09-20-baseline-accounts.md)). |
| Sync checks, including real PostgreSQL | Executed; evidence recorded | 354/354 both modes; 65 tests are DB-gated silent no-ops without `DATABASE_URL` (not `#[ignore]`) and all 65 exercised real PostgreSQL 17.11 in the gated run ([evidence](evidence/2026-09-20-baseline-sync.md)). |
| json-joy-rs quality/parity gates and live interop | Executed incl. live interop | 4405 workspace tests (1 intentional doc-test ignore), 1398 parity fixtures replayed, manifest gates pass; live interop executed and passed (ts→wasm 300/300, wasm→ts 300/300); fixture regeneration requires network and was not run ([evidence](evidence/2026-09-20-baseline-json-joy-rs.md)). |
| Inference checks | Executed; evidence recorded | Re-run 2026-09-20 by the successor wave: 25/25 native tests pass (rustc 1.98.1); prior listener-permission failure not reproduced — environmental classification upheld ([evidence](evidence/2026-09-20-inference-verification.md)). |
| All example packages | Executed; evidence recorded | 8/8 packages green (prettier/tsc/vite build + 41 browser tests, 0 failures); zero prettier churn; SDK resolves via `link:../../betterbase/js` with prebuilt gitignored WASM `pkg/` ([evidence](evidence/2026-09-20-baseline-examples.md)). |
| Platform E2E | Executed; evidence recorded | Full `just e2e` cycle (clean → setup → test) 5m13s: all four services rebuilt from the recorded clean component checkouts (image digests recorded), federation keys exchanged, **121/121 Playwright tests passed** including calamity (32) and conflict-reconcile (2); `.env` unchanged; dev stack untouched ([evidence](evidence/2026-09-20-baseline-e2e.md)). |
| Dependency advisory scans (RustSec + npm) | Executed; evidence recorded | Regenerated 2026-09-20 by the successor wave, counts identical to the interrupted run, advisory-db commit unchanged: [dependencies.md](evidence/dependencies.md). |
| Failure injection, fuzzing, restore and upgrade campaigns | Not run | The remaining execution gap (Stage 3 cross-component scenarios, crash/fault injection, restore drills). |

Additional isolated executions recorded during the analysis pass: PostgreSQL abort-in-transaction mechanism on the disposable audit container ([evidence](evidence/identity-targeted-checks.md)); Caddy config smoke load (HTTP-only listeners confirmed, review 06 F-01). Disposables: `betterbase-audit-postgres` (postgres:18-alpine, loopback 25432, user/db `audit`); reviewer harnesses under `/tmp/betterbase-audit-data/` (memory-journal crash script and actor-codec/decoder crate).

Successor verification waves 2026-09-20 re-executed and recorded the previously reviewer-reported harnesses, plus new isolated reproductions (A-02 both SQL orderings, A-08 logout race, A-12 code-verification race, C-09 DEK wire mismatch, E-02 debounce loss) and the full inference native suite: [identity 1](evidence/2026-09-20-identity-verification.md), [identity 2](evidence/2026-09-20-identity-verification-2.md), [sync 1](evidence/2026-09-20-sync-verification.md), [sync 2](evidence/2026-09-20-sync-verification-2.md), [local data](evidence/2026-09-20-local-data-verification.md), [examples](evidence/2026-09-20-examples-verification.md), [inference](evidence/2026-09-20-inference-verification.md), [deployment](evidence/2026-09-20-deployment-verification.md). All repos were re-verified clean at the pinned revisions during both waves.

Review recipes before baseline execution: some checks format code or install dependencies. Log skipped tests and environment failures separately from passing assertions.
