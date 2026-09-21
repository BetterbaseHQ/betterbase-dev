# Evidence: Betterbase sync baseline execution (canonical check suites, real-PostgreSQL gate)

- Date / reviewer: 2026-09-20 / sync baseline-execution agent (defensive security audit wave)
- Finding and invariant IDs: none — baseline execution evidence for the "Sync checks, including real PostgreSQL" row of `audit/baseline.md` (was "Not run").
- Repository revisions / local patch: `betterbase-sync` at `324da35e30922dfd3ab53c2fb862e7272b2e72f1` (pinned baseline). `git status --short` empty before execution and after execution — tree clean at end, no commits made, no fixes applied.
- Lockfile hashes / generated artifact provenance: `Cargo.lock` sha256 `ff13ff65d56539c5012c3cbda1a2b51d5a43f4462a8997982c3932b4f3aecdb6`. Test binaries compiled locally by cargo 1.98.1 from the pinned revision (`target/debug/deps/betterbase_sync_*` hashes in raw logs, e.g. storage `betterbase_sync_storage-cc4fda7f60ce878a`, identical binary hashes across both suites).
- Tool versions / operating system / browser: rustc 1.98.1 (48a229cea 2026-09-01); cargo 1.98.1 (797e8a9bc 2026-08-05); just 1.58.0; Docker 29.4.0 (build 9d7ad9f); macOS (darwin, aarch64 host). Test database: `postgres:17-alpine` image → server reports **PostgreSQL 17.11** on aarch64-unknown-linux-musl. No browser used.
- Non-secret configuration / isolated services: `just test-db` recipe uses its own container `betterbase-sync-test-db` on loopback port **15432**, user/db `sync`/`sync_test` (credentials are the repo's hardcoded test-only values from its justfile), `DATABASE_URL=postgres://sync:sync@localhost:15432/sync_test?sslmode=disable`. Each DB-gated test creates and migrates its own schema (`test_{uuid}`, `app_fed_{uuid}`, `keygen_test_{uuid}`) for isolation. Dev/e2e stacks and the audit container on 25432 were not touched; no E2E recipes run. `DATABASE_URL` verified unset in the ambient shell for the no-DB suite; `docker ps -a` verified no test-db container existed beforehand.
- Working directory and exact command or source-inspection method: `/Users/nchapman/Code/betterbase-dev/betterbase-sync`.
  1. `git rev-parse HEAD && git status --short` (before)
  2. `just check > /tmp/betterbase-sync-check.log 2>&1` (fmt + clippy + `cargo test --workspace`, no DATABASE_URL)
  3. `git status --short` (fmt churn check)
  4. `just test-db > /tmp/betterbase-sync-testdb.log 2>&1` (db-start 15432 → `DATABASE_URL=... cargo test --workspace` → db-down on success)
  5. Container version probe: `just db-start` → `docker exec betterbase-sync-test-db psql -U sync -d sync_test -t -A -c 'SELECT version();'` → `just db-down`
  6. `git rev-parse HEAD && git status --short` (after)
  7. Source inspection: `rg 'test_storage\(\)' crates bins`, `rg 'isolated_storage\(\)' crates/app/src`, `rg 'isolated_database\(\)' bins/federation-keygen/src` to enumerate DB-gated tests; read `crates/storage/src/postgres/test_support.rs`.
- Expected behavior: `just check` passes fmt/clippy with zero modifications and zero warnings; both test suites pass; the DB suite additionally exercises real-PostgreSQL code paths that silently no-op without DATABASE_URL.
- Observed behavior: all green. Per-binary counts **identical** across both suites because the DB gate is an early-return skip (`test_storage()`/`isolated_storage()`/`isolated_database()` return `None` when `DATABASE_URL` is unset and the test body returns immediately — skipped tests still report `ok` and are counted as passed, never as ignored). The differential is execution time and source-verified gating:

  | Test binary (unittests) | no-DB: pass/fail/ignore | with-DB: pass/fail/ignore | no-DB time | with-DB time | DB-gated tests (source-verified) |
  | --- | --- | --- | --- | --- | --- |
  | betterbase_sync_api | 186/0/0 | 186/0/0 | 0.39s | 0.39s | 0 |
  | betterbase_sync_app | 29/0/0 | 29/0/0 | 0.00s | 0.28s | 3 |
  | betterbase_sync_auth | 78/0/0 | 78/0/0 | 0.06s | 0.06s | 0 |
  | betterbase_sync_core | 37/0/0 | 37/0/0 | 0.00s | 0.00s | 0 |
  | betterbase_sync_federation_keygen | 7/0/0 | 7/0/0 | 0.00s | 0.28s | 3 |
  | betterbase_sync_migrate | 0/0/0 | 0/0/0 | 0.00s | 0.00s | 0 |
  | betterbase_sync_realtime | 17/0/0 | 17/0/0 | 0.00s | 0.00s | 0 |
  | betterbase_sync_server | 0/0/0 | 0/0/0 | 0.00s | 0.00s | 0 |
  | betterbase_sync_storage | 63/0/0 | 63/0/0 | 0.00s (0.01s in first run) | **4.31s** | **59** |
  | **unit totals** | **354/0/0** | **354/0/0** | | | **65** |
  | doc-tests (7 crates, api/app/auth/core/realtime/storage) | 0/0/0 each | 0/0/0 each | — | — | 0 |

  DB-gated population (65 tests) verified by call-site count: storage `test_storage()` callers — records 24, files 12, spaces 5, membership 5, epochs 5, invitations 3, federation 3, revocation 1, rate_limit 1 (= 59; remaining 4 storage tests are pure `rate_limit_hash_*` in `crates/storage/src/lib.rs`); app `isolated_storage()` callers — 3 `apply_federation_runtime_config_*` tests in `crates/app/src/federation.rs` (lines 407, 430, 489); federation-keygen `isolated_database()` callers — 3 tests in `bins/federation-keygen/src/main.rs` (lines 225, 272, 316). Both runs used byte-identical test binaries (same dep hashes in logs), so the timing delta is attributable to real DB I/O, not recompilation. `just test-db` exited 0 and tore the container down itself; no manual `just db-down` needed.
- Exit code / assertions / skipped tests: `just check` exit 0 (clippy `-D warnings` clean, zero warnings in log; 354 unit + 0 doc passed, 0 failed, 0 ignored). `just test-db` exit 0 (354 unit + 0 doc passed, 0 failed, 0 ignored; container auto-removed). **0 tests report as "ignored" or "filtered out" in either mode** — the 65 DB-gated tests masquerade as passes without DATABASE_URL (honest-limit note below, not a failure).
- Result: pass (both suites; incl. real-PostgreSQL gate on PostgreSQL 17.11)
- Seed / schedule / reproduction steps: deterministic — `cd betterbase-sync && just check` then `just test-db`. No seeds; parallel default test threads; schemas UUID-scoped per run. Version probe note: first `psql` attempt hit the container's first-boot initdb transition (`FATAL: the database system is shutting down`); retried after 3s sleep and succeeded — `pg_isready` in `db-start` can return against the temporary init server on a cold container.
- Sanitized output or artifact links: raw logs kept at `/tmp/betterbase-sync-check.log` (512 lines) and `/tmp/betterbase-sync-testdb.log` (515 lines) — trimmed per-suite excerpts above; container lifecycle lines in testdb log: `Creating test database...` → `Test database ready on port 15432` → `Running tests with DATABASE_URL...` → `docker rm -f betterbase-sync-test-db`.
- Limits:
  - No-DB "pass" counts overstate coverage: 65 of 354 unit tests execute zero assertions without `DATABASE_URL` (silent early-return, not `#[ignore]`), so the no-DB suite alone cannot distinguish exercised from skipped storage paths. The with-DB run is the only run that exercises `PostgresStorage` against real SQL.
  - Coverage statements here are count- and timing-based plus static call-site verification; no per-test tracing (e.g. `--nocapture` DB markers or coverage instrumentation) was run.
  - Doc-tests are empty across the workspace; nothing to evidence there.
  - Benchmarks (`just bench`, `just bench-db`) were not in scope and not run.
  - PostgreSQL pinned at 17.11 (postgres:17-alpine image); dev/prod stacks may run other major versions — no cross-version matrix executed.
  - Container-version probe consumed one extra db-start/db-down cycle; both completed inside this repo's own recipes and the container is removed (verified via `docker ps -a`).
  - Timing cells are single-sample wall-clock from the harness and include scheduling noise; the 4.31s vs 0.00s storage delta is far outside noise, the 0.28s deltas are corroborated by source gating rather than timing alone.
