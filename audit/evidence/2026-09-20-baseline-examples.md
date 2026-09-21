# Evidence: Betterbase Examples — baseline execution of all package check suites

- Date / reviewer: 2026-09-20 / examples baseline-execution agent (defensive security audit)
- Finding and invariant IDs: baseline execution only — no findings; closes the "All example packages: Not run" row in [baseline.md](../baseline.md)
- Repository revisions / local patch: `betterbase-examples` @ `f8fc63bbce97b52d80ab603686212278af8318b9`, worktree clean before and after. Dependency repo `betterbase` @ `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`, clean before and after.
- Lockfile hashes / generated artifact provenance: all 8 per-package `pnpm-lock.yaml` unchanged (verified by sha256 diff before/after; e.g. `shared` `75bb5c9d…`, `board` `2b2dc825…`, `photos` `50cf71e9…`, `notes` `cecd25c3…`, apps sharing `6f719283…`). Pre-existing gitignored WASM artifacts consumed via the SDK link: `crates/betterbase-wasm/pkg/betterbase_wasm_bg.wasm` sha256 `7b4bac10e1e186b0b0784d53a9c3c406b6a65a237ef3625ba9bfd8b5fc505827` (mtime 2026-09-20 16:12:11), `crates/betterbase-db-wasm/pkg/betterbase_db_wasm_bg.wasm` sha256 `3b39c4772c4aff0905552f1d7a6d29da1c3c5477c514741ad4bdefd60c6ce3e1` (mtime 2026-09-20 16:12:16). No SDK build was executed; hashes are provenance for what the example builds/tests actually loaded.
- Tool versions / operating system / browser: node v24.21.0 (mise shim), pnpm 12.4.2 (matches `packageManager`), vitest 5.0.1 / @vitest/browser-playwright 5.0.1 / playwright 1.58.2, TypeScript 5.9.3, Vite 8.3.0, tsup 8.5.1, macOS (darwin-arm64). Playwright browsers present: `chromium-1208`, `chromium_headless_shell-1208` (vitest browser mode ran real Chromium headless).
- Non-secret configuration / isolated services: none — no docker, no dev/e2e services touched, no `.env` used. Apps resolve the SDK locally; tests use vitest browser mode with local fixture/mocks only.
- Working directory and exact command or source-inspection method: `/Users/nchapman/Code/betterbase-dev/betterbase-examples`. Per package `P`: `(cd P && pnpm check)` plus `(cd shared && pnpm test)` because shared's `check` script does not include tests (see below). Full stdout/stderr per package captured to `/tmp/opencode/examples-audit/check-<pkg>.log` and `test-shared.log` (temp, outside repo).

## Scope correction

Task brief said "Packages (9)" but listed 8 names; the repo contains exactly 8 packages — `shared, launchpad, tasks, notes, passwords, photos, board, chat` — and no root `package.json` or `pnpm-workspace.yaml`. Each package is an independent pnpm project with its own lockfile.

## Check-script confirmation (from each package.json)

- 7 apps (`launchpad, tasks, notes, passwords, photos, board, chat`): `"check": "prettier --write . && tsc -b && vite build && pnpm test"` with `"test": "vitest run --config vitest.browser.config.ts"` — matches the brief.
- `shared`: `"check": "prettier --write . && pnpm build && pnpm typecheck"` (tsup 8.5.1 ESM+dts build, then `tsc --noEmit`) — **tests are NOT part of `check`**; its separate `"test"` script (same vitest browser config) was run additionally.

## SDK dependency resolution (recorded as required)

Every package declares `"betterbase": "link:../../betterbase/js"` (pnpm symlink; verified e.g. `shared/node_modules/betterbase -> ../../../betterbase/js`), and apps declare `"@betterbase/examples-shared": "link:../shared"`. The SDK package's `exports` point at `./src/*.ts` TypeScript source (not `dist/`), so app builds compile SDK TS directly; the only prebuilt artifacts consumed are the gitignored `pkg/` WASM directories listed above, which already existed. Consequence: the SDK `pnpm build` fallback was **not needed and not run** — notably, `betterbase/js/dist` does not exist and is **not** gitignored (`git check-ignore dist` fails), so running the SDK build would have dirtied the SDK repo. Both repos verified clean after all checks.

## Install record and churn

- `pnpm install` at the examples root: exited 0 but **created untracked `package.json` (placeholder "betterbase-examples" v1.0.0) and `pnpm-lock.yaml` at the repo root** — recorded churn; both deleted immediately, tree restored to clean. No tracked files affected.
- Per-package `pnpm install` (all 8): each "Already up to date" (1–2 ms); all 8 lockfiles byte-identical before/after (sha256 diff). `node_modules` pre-existed in every package.
- Prettier churn: **zero files rewritten in all 8 packages** — every file logged `(unchanged)`; count of rewritten files per package = 0. No `git restore` needed. Local formatting is clean, so `prettier --write` mutation risk did not materialize at this revision.
- Post-run `git status --short`: empty in `betterbase-examples` and in `betterbase`; HEADs unchanged.

## Expected behavior

`pnpm check` (plus shared `pnpm test`) exits 0 in each package: formatting stable, typecheck clean, vite production build succeeds, all vitest browser-mode tests pass with none skipped.

## Observed behavior — per-package results

| Package | prettier rewrites | tsc | vite/tsup build | vitest files | vitest tests (pass/fail/skip) | check exit |
| --- | --- | --- | --- | --- | --- | --- |
| shared | 0 | `tsc --noEmit` clean | tsup ESM+dts success (38.81 KB js / 14.94 KB d.ts) | 3 passed | 14 / 0 / 0 (via separate `pnpm test`) | 0 |
| launchpad | 0 | clean (`tsc -b`) | success (built in 242 ms) | 1 passed | 1 / 0 / 0 | 0 |
| tasks | 0 | clean | success (407 ms) | 1 passed | 2 / 0 / 0 | 0 |
| notes | 0 | clean | success (353 ms) | 1 passed | 3 / 0 / 0 | 0 |
| passwords | 0 | clean | success (314 ms) | 3 passed | 10 / 0 / 0 | 0 |
| photos | 0 | clean | success (310 ms) | 2 passed | 4 / 0 / 0 | 0 |
| board | 0 | clean | success (324 ms) | 1 passed | 3 / 0 / 0 | 0 |
| chat | 0 | clean | success (323 ms) | 1 passed | 4 / 0 / 0 | 0 |
| **Total** | **0** | **8/8 clean** | **8/8 success** | **13 passed** | **41 / 0 / 0** | **8× exit 0** |

Vitest browser-mode durations 0.8–2.0 s per package. One benign warning in shared's test run: `__dirname` deprecation in `vitest.browser.config.ts:15` (suggests `import.meta.dirname`) — cosmetic, did not affect execution.

## Exit code / assertions / skipped tests

All 41 tests passed; 0 failed; 0 skipped (a grep-based skip scan's single hit was the filename `src/lib/todos.ts`, a false positive). All 8 check scripts plus shared's test script exited 0.

## Result: pass

All example packages' check suites pass at the pinned revision in this environment. No environment-blocked items (Chromium binaries present). No deviations from expected behavior beyond the cosmetic notes recorded above.

## Seed / schedule / reproduction steps

1. `git -C betterbase-examples rev-parse HEAD` → `f8fc63bb…`, `git status --short` → clean.
2. Per package: `pnpm install` (no-op), then `pnpm check`; additionally `(cd shared && pnpm test)`.
3. Confirm `git status --short` empty in `betterbase-examples` and `betterbase`.

## Sanitized output or artifact links

Raw logs (temporary, outside workspace): `/tmp/opencode/examples-audit/check-{shared,launchpad,tasks,notes,passwords,photos,board,chat}.log`, `test-shared.log`. Representative tail (passwords): `✓ built in 314ms / Test Files 3 passed (3) / Tests 10 passed (10)`.

## Limits

- Baseline records a single execution on one machine (darwin-arm64, node 24 / pnpm 12.4.2 matching `packageManager` pins); no cross-platform or CI reproduction.
- `shared`'s `check` script omits tests by design; its test suite was executed separately here, but `just check`-style automation at platform level may silently skip those 14 tests (coverage gap worth noting for the audit, not fixed per ground rules).
- Browser tests exercise app code against local fixtures/mocks with real Chromium but no running accounts/sync services — server-integration paths are covered elsewhere (platform e2e), not here.
- Prettier stability observed at this revision does not preclude churn on other machines/versions; prettier `^3.8.1` resolves per lockfile.
- The root `pnpm install` placeholder-manifest creation is pnpm behavior when run without a manifest; treat root-level `pnpm install` in this repo as an unsafe no-op that writes files.

Never include real credentials, tokens, encryption keys, or private user data. Preserve enough synthetic setup to reproduce the result.
