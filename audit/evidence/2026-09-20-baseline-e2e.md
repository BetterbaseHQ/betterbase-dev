# Evidence: Platform E2E baseline execution (full `just e2e` cycle)

- Date / reviewer: 2026-09-20 18:55–19:00 local / baseline-execution agent (defensive security audit)
- Finding and invariant IDs: Baseline evidence for F-04 (06-deployment-assurance.md — release/provenance assurance gap). This run rebuilds the E2E server images from the current component checkouts via `up -d --build`, which strengthens image provenance relative to the pre-existing 29–45h-old images. No new finding; no product changes.
- Repository revisions / local patch:
  - Root (betterbase-dev): `7a36c07c7fc8a44dc86f09b4c34d518771cece8e` (verified; clean except allowed pre-existing `.playwright-mcp/console-2026-09-19T19-25-51-282Z.log` and untracked `audit/`, `docs/platform-review-plan.md`)
  - betterbase (SDK): `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` (clean)
  - betterbase-accounts: `b7cda8872ee09cfad44f4186ff40096ee3c95483` (clean) — source of both accounts images
  - betterbase-sync: `324da35e30922dfd3ab53c2fb862e7272b2e72f1` (clean) — source of both sync images
  - betterbase-examples: `f8fc63bbce97b52d80ab603686212278af8318b9` (clean)
  - json-joy-rs: `2dea0bd9669f53ce0007225fe80d55a9a1525924` (clean)
- Lockfile hashes / generated artifact provenance (image IDs before → after; Docker `docker images` ID and build-output manifest-list digest):
  - `betterbase-e2e-accounts:latest` — before `0d158ead1838` (29h old) → after `65678e2d2cdd`, manifest list `sha256:65678e2d2cddbdc26a82cb0355795d1d63a298f4fd2e3d5bed1d174dce3df98d`
  - `betterbase-e2e-accounts-b:latest` — before `bd7507517dff` (29h old) → after `1fb3d8d60e7d`, manifest list `sha256:1fb3d8d60e7d54bb468b513aeb3c2e581b77d3ca7cead417e090c4822961e549`
  - `betterbase-e2e-sync:latest` — before `808427e52f86` (45h old) → after `28b5586adcdf`, manifest list `sha256:28b5586adcdfa41ccfc5e88c667f60a2ac11a2f7b1532a5a7c4525d1dbd489c1`
  - `betterbase-e2e-sync-b:latest` — before `9efa1fa4de5c` (45h old) → after `52fac91ec134`, manifest list `sha256:52fac91ec134a9c5cf40ea6da05d3eeef0580c62dfab983d0918da1e2480fa62`
  - All four images built 2026-09-20 ~18:55 from the component revisions above. Base images resolved by digest in build log (`rust:1.98.1-bookworm@sha256:93ce27a8...`, `debian:bookworm-slim@sha256:3783cc01...`, `node:24.21-bookworm-slim@sha256:0e0ff40c...`, `dockerfile:1.7@sha256:a57df69d...`). Build was cache-warm (cargo-chef cook layers CACHED) but final source layers recompiled and all four images re-exported with fresh digests — this is a rebuild from current source, not a `--no-cache` cold build (see Limits).
- Tool versions / operating system / browser: macOS (darwin); Docker 29.4.0 (build 9d7ad7f); just 1.58.0; node v24.21.0; pnpm 12.4.2; Playwright chromium project (`Desktop Chrome`), 4 workers (PW_WORKERS default), retries 0, fullyParallel false, per-test timeout 60s, expect timeout 10s, baseURL http://localhost:25390 (vite webServer, reuseExistingServer). Playwright test total runtime 4.2m.
- Non-secret configuration / isolated services: standalone compose project `betterbase-e2e` (ports 25377 accounts / 25379 sync / 25387 accounts-b / 25389 sync-b / 25390 vite harness). Caddy and CAP intentionally excluded (e2e/compose.yaml header) — rate limiting and CAPTCHA are not under test. Server B OPAQUE key freshly generated (host-side keygen release build, cargo cache warm, 0.29s) into gitignored `e2e/.env.docker`; value not recorded (secret). Federation key exchange succeeded — kids only: Server A `https://sync:5379/.well-known/jwks.json#fed-1789955760-265949569`, Server B `https://sync-b:5379/.well-known/jwks.json#fed-1789955760-281984046`. OAuth clients created (synthetic, non-secret IDs): Server A `c5c407ed-e8ef-437f-bab1-fe8602a8b82c`, Server B `e9a0b8e6-8d24-4f9c-8611-6e46ab3bf017`; `e2e/.env` written with VITE client IDs + `VITE_DOMAIN_B=localhost:25387`.
- Working directory and exact command or source-inspection method: `/Users/nchapman/Code/betterbase-dev`; `cp .env /tmp/env.before` (sha256 `b1ec457b35c97e553377b27db35bdeb2dc9da08286eb029dc469116f522d3434`) → `just e2e` (= e2e-clean: `down -v` + `rm e2e/.env.docker`; e2e-setup: keygen + `compose up -d --build` + health waits + federation exchange + `--force-recreate sync sync-b` + OAuth clients; e2e-test: `cd e2e && pnpm test`).
- Expected behavior: full cycle tears down the prior e2e stack (8 containers, up 28h), rebuilds accounts/sync images from current component checkouts, all four services healthy, federation keys exchanged, all Playwright specs green; dev stack (`betterbase-dev` project) untouched.
- Observed behavior: exactly that. Run 18:55:13 → 19:00:26 (5m12.74s wall; 677s user / 150s system / 264% cpu). All four services reported healthy on the first `_e2e-wait` iteration (no retry loops observed; timings approximate from compose log ordering: DBs healthy ~10s, accounts/sync healthy within ~1–1.5 min of `up`, including a 60s start_period allowance that was not needed). Sync services force-recreated for peer trust pins and re-healthy immediately. Post-run: all 8 e2e containers `Up (healthy)`; dev containers still `Up 43–47 hours (healthy)` — untouched. Root `git status` unchanged.
- Exit code / assertions / skipped tests: `just e2e` exit 0. Playwright: **121 passed, 0 failed, 0 flaky, 0 skipped** of 121 discovered (16 spec files; per-file static count sums to 121, matching the runner — nothing filtered). Duration 4.2m, 4 workers, 0 retries configured so no flaky-retry pathway exists; no failures to trim. Per-spec results (all pass):

  | Spec | Tests | Result |
  |---|---|---|
  | auth.spec.ts | 3 | pass |
  | calamity.spec.ts | 32 | pass |
  | conflict-reconcile.spec.ts | 2 | pass |
  | discovery.spec.ts | 5 | pass |
  | edit-history.spec.ts | 3 | pass |
  | ephemeral-events.spec.ts | 2 | pass |
  | error-paths.spec.ts | 7 | pass |
  | federation.spec.ts | 21 | pass |
  | files.spec.ts | 3 | pass |
  | multiplayer.spec.ts | 16 | pass |
  | personal-sync.spec.ts | 5 | pass |
  | presence.spec.ts | 3 | pass |
  | realtime-events.spec.ts | 3 | pass |
  | realtime.spec.ts | 2 | pass |
  | revocation.spec.ts | 10 | pass |
  | rotation.spec.ts | 4 | pass |

  Audit-plan specs of interest — both ran and passed:
  - `calamity.spec.ts` (32 tests, all pass): offline accumulation (100 changes) then sync; two devices offline simultaneously; offline conflict resolution; repeated offline/online cycles; five-device concurrent edit of one record; concurrent-tombstone idempotency; rapid create-update-delete; 50 successive syncs; 500-record batch; 200-record bulk update; member removal makes data invisible to admin (single and dual shared spaces); rapid invite accept-decline-accept cycles; boundary conditions (empty space, non-existent deletes, unsynced queries, 10k-char strings, nested arrays); reload persistence and second-device pull; tombstone convergence across reloads, mixed creates/deletes, delete-before-sync non-resurrection; update-vs-delete race converging both devices to the same state; cross-member concurrent shared-space writes; no-op sync stability; stale-device catch-up; falsy-value round-trips; cross-collection isolation; sync-failure recovery; fresh-database pull.
  - `conflict-reconcile.spec.ts` (2 tests, both pass): (1) text, per-field, and created records all converge identically on both devices after offline divergence; (2) delete-vs-edit converges to the same outcome on both devices.

- Result: pass
- Seed / schedule / reproduction steps: from the orchestration root at the revisions above, with dev stack running: `cp .env /tmp/env.before && just e2e`. Deterministic recipe; synthetic per-run users/spaces on wiped e2e volumes.
- Sanitized output or artifact links: full command output retained in the session transcript (build log incl. digests, health waits, kids, client IDs, complete Playwright per-test list, `121 passed (4.2m)`). `.env` diff: `diff /tmp/env.before .env` → identical (exit 0, sha256 unchanged `b1ec457b...`). The setup recipe's deliberate strip of stale `FEDERATION_TRUSTED_KEYS_*` / `OPAQUE_SERVER_SETUP_B` / `# Server B (federation e2e)` entries from the shared root `.env` was a **no-op this run** — no such stale entries existed.
- Limits: (1) Docker build cache was warm (cargo-chef dependency layers CACHED); images are rebuilt from current source but this is not a `--no-cache` cold build, and component commits, while recorded here, are still not pinned by a sealed/tagged release manifest — F-04's core gap stands. (2) Chromium-only, 4 workers, single run, retries 0: no cross-browser matrix, no repeat-run variance data, flaky-retry path never exercised. (3) Caddy and CAP are excluded from the e2e stack by design — rate limiting, TLS/proxy behavior, and CAPTCHA are untested here (cf. F-01/F-03). (4) Health-wait timings are approximate (inferred from compose output ordering, not instrumented). (5) Server B OPAQUE key and federation private keys are fresh but not recorded (secrets); only kids and public JWKS endpoints appear above. (6) In-container pnpm web build emitted a supply-chain policy check (223 entries, passed) and a >500 kB chunk warning — observations only, no failures. (7) No restore/rollback exercise in this pass (F-04 scope, separate).
