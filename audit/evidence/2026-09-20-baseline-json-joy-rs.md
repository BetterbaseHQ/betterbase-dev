# Evidence: json-joy-rs baseline check suite (quality/parity gates + live interop)

- Date / reviewer: 2026-09-20 / baseline-execution agent (defensive security audit, Betterbase platform)
- Finding and invariant IDs: none (baseline execution, no findings)
- Repository revisions / local patch: json-joy-rs `2dea0bd9669f53ce0007225fe80d55a9a1525924` ("Surface str diff anchor-lookup failures instead of head-inserting"); worktree clean before and after — `git status --short` empty at both checkpoints, no local patch.
- Lockfile hashes / generated artifact provenance:
  - `Cargo.lock` sha256 `8b0e976a13b5bbac63f0b9d190f2f82480933cc43368da8d0d3a7eb577e4fbd5`
  - `bench/package-lock.json` sha256 `8b80a08b4cd70dd4a6e0ebc353ecb9a4e6ddcf883541918212e56391d21503e8` (pins upstream oracle `json-joy@18.0.0`, vendored in `bench/node_modules/json-joy`, verified version 18.0.0)
  - Fixtures: `tests/compat/fixtures/manifest.json` pins 1398 fixtures across 20 scenarios (1399 files incl. manifest). Fixtures were replayed as-is; regeneration (`bin/generate-compat-fixtures.sh`, requires `mise x -- npm install` in `tools/oracle-node`) was NOT run — networked step, not part of `just check`.
  - WASM pkg rebuilt by `parity-live` into gitignored `crates/json-joy-wasm/pkg` (wasm-pack 0.15.0, `--target nodejs --release`, `CARGO_NET_OFFLINE=true`).
- Tool versions / operating system / browser: rustc 1.98.1 (48a229cea 2026-09-01), cargo 1.98.1 (797e8a9bc 2026-08-05), node v24.21.0, pnpm 12.4.2 (unused by gates), wasm-pack 0.15.0, just (mise-pinned); macOS (darwin). No browser used.
- Non-secret configuration / isolated services: none required — pure local cargo/node execution, no Docker, no network services, no secrets.
- Working directory and exact command or source-inspection method: `/Users/nchapman/Code/betterbase-dev/json-joy-rs`; commands in order:
  1. `just check` (= `fmt` → `lint` → `test-gates` → `test`, per justfile)
  2. `just parity-live` (= `wasm-build` + `node bench/interop.cjs`)
  Also read `justfile`, `tests/compat/PARITY_AUDIT.md`, `bench/interop.cjs`, `bin/generate-compat-fixtures.sh`, `crates/json-joy/tests/compat_fixtures.rs`, `tests/compat/fixtures/manifest.json`.

- Expected behavior: all gates pass with zero failures; parity fixture replay covers all 1398 manifest fixtures; live interop passes 300/300 in both directions; worktree remains clean at baseline HEAD.

- Observed behavior (per-suite results):

  | Stage / suite | Command | Result | Counts |
  | --- | --- | --- | --- |
  | fmt | `cargo fmt --all` | pass, no file churn | `git status --short` empty after — no `git restore` needed |
  | lint | `cargo clippy --workspace --all-features --all-targets -- -D warnings` | pass | 0 warnings (finished clean under `-D warnings`) |
  | test-smoke | `cargo test -p json-joy --lib` | pass | 1207 passed / 0 failed / 0 ignored |
  | parity-fixtures: compat_fixtures | `cargo test -p json-joy --test compat_fixtures` | pass | 1 test (`compat_fixtures_replay_with_xfail_policy`) replaying **all 1398 manifest fixtures** across 20 scenarios; xfail.toml has **0 active xfails**; stale-xfail guard also enforced |
  | parity-fixtures: compat_inventory | `cargo test -p json-joy --test compat_inventory` | pass | 3 passed (manifest pinned, scenario set+counts match expected, entries unique+on-disk) |
  | full workspace test | `cargo test --workspace` | pass | 4405 passed / 0 failed / 1 ignored across 100 test binaries (includes gates suites a second time; covers json-joy, json-expression, base64, buffers, json-equal, json-pack, json-path, json-pointer, json-random, json-type, util, wasm, sonic-forest + doc-tests) |
  | parity-live: wasm-build | `CARGO_NET_OFFLINE=true wasm-pack build crates/json-joy-wasm --target nodejs --release` | pass | pkg built offline in 0.62s (cached release artifacts) |
  | parity-live: interop | `node bench/interop.cjs` | pass | **ts→wasm (A): 300/300; wasm→ts (B): 300/300**; 0 errors; 300 `model_diff_parity` fixtures, exit 0 |

  Fixture manifest scenario breakdown (replayed by compat_fixtures): codec_indexed_binary_parity 40, codec_sidecar_binary_parity 40, lessdb_model_manager 90, model_api_proxy_fanout_workflow 40, model_api_workflow 60, model_apply_replay 140, model_canonical_encode 30, model_decode_error 35, model_diff_dst_keys 80, model_diff_parity 300, model_lifecycle_workflow 60, model_roundtrip 110, patch_alt_codecs 44, patch_canonical_encode 44, patch_clock_codec_parity 40, patch_compaction_parity 45, patch_decode_error 35, patch_diff_apply 40, patch_schema_parity 45, util_diff_parity 80 — total 1398.

- Exit code / assertions / skipped tests:
  - `just check` exit 0; `just parity-live` exit 0.
  - Ignored (1): doc-test `crates/json-joy/src/json_crdt_extensions/peritext/mod.rs - json_crdt_extensions::peritext (line 13)` — marked ```rust,ignore``` by design; illustrative quick-start snippet ("... set up StrNode/ArrNode ..." placeholders), not runnable. No other ignores; 0 filtered out anywhere.
- Result: pass (all executed stages)
- Seed / schedule / reproduction steps: no RNG seeds relevant (tests deterministic per repo rules). Reproduce: checkout `2dea0bd9…`, clean tree, run `just check` then `just parity-live` in repo root. Node oracle must be present in `bench/node_modules` (`npm ci` in `bench/` — already vendored here).
- Sanitized output or artifact links: full `just check` output retained in agent tool log (`tool_0c1a7b327001XBGRs4nuUpBqSS`, 100 `test result:` summary lines, all `ok`, 0 failed); interop summary quoted above verbatim.

- What the gates cover vs live interop: `just test-gates` verifies fixture-backed parity **offline** — Rust replay of the 1398 JSON fixtures generated from the upstream JS oracle (model/patch codec round-trips, diff/apply, canonical encodings, error paths) plus manifest-pinning inventory checks. `parity-live` goes further: it builds the Rust core to WASM and runs **two-way live interop** (`bench/interop.cjs`) where upstream TypeScript `json-joy@18.0.0` generates patches applied by Rust/WASM and vice versa across the 300 `model_diff_parity` fixtures. Live interop is NOT part of `just check`; it is a separate recipe and needs node + the wasm-pack toolchain + the npm oracle — all present in this environment (oracle vendored, build forced offline), so it was executed and passed. Fixture *regeneration* against the oracle (`just compat-fixtures` → `mise x -- npm install` + `npm run generate` in `tools/oracle-node`) is networked and was not executed.

- Environment-blocked items:
  1. `just compat-fixtures` (fixture regeneration via `bin/generate-compat-fixtures.sh`): blocked by design — requires network `npm install` in `tools/oracle-node`; audit constraint forbids network. Existing committed fixtures replayed instead. (Oracle deps appear pre-vendored in `tools/oracle-node/node_modules`, but the script unconditionally re-runs `npm install`, so it was not attempted.)
  2. No other blocked items: `just parity-live` ran fully offline as configured.

- Limits: fixtures are a frozen snapshot of oracle behavior at generation time (manifest-pinned); this run proves Rust matches the pinned fixtures, not against a freshly regenerated oracle (item 1 above). Live interop exercises only the `model_diff_parity` scenario (300 of 1398) and only via the nodejs WASM target. Benchmarks (`just bench`) not run (not part of check). Upstream v18.0.0→v18.30.0 deltas are triaged in `tests/compat/PARITY_AUDIT.md` (deferred families listed there, e.g. delta codecs, patch batch codecs) — out of scope for this baseline. Worktree confirmed clean at `2dea0bd9669f53ce0007225fe80d55a9a1525924` after all runs; `crates/json-joy-wasm/pkg` output is gitignored.
