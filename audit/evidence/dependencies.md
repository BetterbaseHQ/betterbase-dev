# Evidence: Dependency advisory scans (RustSec + npm) — regenerated for F-05

- Date / reviewer: 2026-09-20 / deployment-dependency verification agent (successor to interrupted coordinator run; review 06 §F-05 references this file)
- Finding and invariant IDs: F-05 (INV-07); supports AUD-001/AUD-002 context (check coverage)
- Repository revisions / local patch (all verified equal to audit baselines, working trees clean):
  - betterbase-dev `7a36c07`, betterbase `e3a9ad1`, betterbase-accounts `b7cda88`, betterbase-sync `324da35`, betterbase-inference `bf36ba4`, betterbase-examples `f8fc63b`, json-joy-rs `2dea0bd`
- Lockfile hashes / generated artifact provenance: scanned the committed `Cargo.lock` / `pnpm-lock.yaml` in each repo; no dependency versions changed, no lockfiles rewritten
- Tool versions / operating system: cargo-audit 0.22.2 (`cargo audit --version` → `cargo-audit-audit 0.22.2`), pnpm 12.4.2, node v24.21.0, macOS (darwin)
- Advisory database: RustSec advisory-db commit `d5c17953a895cf19e8d3ce66eaa42b6fcfe1fb16` (1251 advisories loaded; identical commit to the prior-run snapshot cited in review 06 §F-05)
- Non-secret configuration / isolated services: none needed; all scans are local lockfile evaluations against advisory databases. No containers, dev/e2e services, or product code were touched
- Working directory and exact command or source-inspection method:
  - Rust (per repo, run inside each repo): `cargo audit`; db commit via `git -C ~/.cargo/advisory-db rev-parse HEAD`
  - npm (per workspace, run inside each workspace): `pnpm audit --json` (lockfile-only; no `pnpm install` was required — all 11 workspaces audited directly from lockfiles, stderr empty)
  - Dependency path check: `cargo tree -i rsa` in betterbase-accounts
- Expected behavior (from prior run, review 06 §F-05): rsa 0.9.10 / RUSTSEC-2023-0071 in accounts, sync, inference (via jsonwebtoken); betterbase and json-joy-rs clean. npm counts: accounts web 16, SDK 2, shared 5, notes 7, each other example 3, e2e 1
- Observed behavior: identical to the prior run — every RustSec result and every npm advisory count matches (tables below)
- Exit code / assertions / skipped tests: `cargo audit` exit 0 for betterbase, json-joy-rs; exit 1 for accounts, sync, inference (1 vulnerability each). `pnpm audit` exit 1 in all 11 workspaces (advisories found); no scanner errors
- Result: pass (evidence regenerated; all prior counts reproduced)
- Seed / schedule / reproduction steps: rerun the commands above at the listed revisions with the listed tool versions and advisory-db commit
- Limits: scanner severity ≠ exploitability (see caveat); yanked-crate handling left at cargo-audit 0.22.2 defaults (the prior run disabled yanked lookup explicitly; no yanked or other warnings were emitted in any repo in this run); npm counts are package/advisory matches per workspace, not independent exploitable bugs; no reachability analysis or exploit payloads were performed. A first `cargo audit` invocation mistakenly run from the workspace root failed with `Couldn't load Cargo.lock` (root has no Cargo.lock); it was corrected by running inside each repo and had no effect on results

## RustSec (cargo audit) results

| Repo | Crates in lock | Vulnerabilities | Exit | Advisory-db commit |
|---|---|---|---|---|
| betterbase (SDK) | 209 | 0 | 0 | d5c17953… |
| betterbase-accounts | 339 | 1 — `rsa 0.9.10` RUSTSEC-2023-0071 | 1 | d5c17953… |
| betterbase-sync | 407 | 1 — `rsa 0.9.10` RUSTSEC-2023-0071 | 1 | d5c17953… |
| betterbase-inference | 294 | 1 — `rsa 0.9.10` RUSTSEC-2023-0071 | 1 | d5c17953… |
| json-joy-rs | 93 | 0 | 0 | d5c17953… |

### Single shared finding (accounts, sync, inference)

| Crate | Version | Severity | Advisory | Fixed | Dependency class |
|---|---|---|---|---|---|
| rsa | 0.9.10 | CVSS 5.9 (medium) — "Marvin Attack: potential key recovery through timing sidechannels" (2023-11-22) | [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) | "No fixed upgrade is available!" | Runtime (server binaries) |

Confirmed dependency path (betterbase-accounts, `cargo tree -i rsa`): `rsa 0.9.10 ← jsonwebtoken 11.1.0 ← betterbase-accounts-auth ← {api, app} ← bins/server` — i.e. a runtime dependency of the shipped server binary, reached via jsonwebtoken as stated in review 06. Review 06's note stands: reviewed JWT paths restrict verification/signing to ES256; no reachable RSA private-key timing operation was established.

No warnings (vulnerability, yanked, or informational) were emitted for any of the five repos.

## npm (pnpm audit) results

Class column: `runtime` = pnpm resolves the module outside devDependencies (ships in the built app); `build/dev-only` = resolved only through devDependencies. Severity as reported by the scanner.

### betterbase-accounts/web — 16 advisories (prior: 16 — match)

| Module | Version | Severity | Advisory | Class |
|---|---|---|---|---|
| react-router | 7.13.0 | high | GHSA-49rj-9fvp-4h2h | runtime |
| react-router | 7.13.0 | high | GHSA-8646-j5j9-6r62 | runtime |
| react-router | 7.13.0 | high | GHSA-8x6r-g9mw-2r78 | runtime |
| react-router | 7.13.0 | high | GHSA-chx6-hx7r-mcp5 | runtime |
| react-router | 7.13.0 | high | GHSA-qwww-vcr4-c8h2 | runtime |
| react-router | 7.13.0 | high | GHSA-rxv8-25v2-qmq8 | runtime |
| react-router | 7.13.0 | moderate | GHSA-2j2x-hqr9-3h42 | runtime |
| react-router | 7.13.0 | moderate | GHSA-337j-9hxr-rhxg | runtime |
| react-router | 7.13.0 | moderate | GHSA-f22v-gfqf-p8f3 | runtime |
| react-router | 7.13.0 | moderate | GHSA-h8fp-f39c-q6mh | runtime |
| react-router | 7.13.0 | moderate | GHSA-wrjc-x8rr-h8h6 | runtime |
| react-router | 7.13.0 | low | GHSA-84g9-w2xq-vcv6 | runtime |
| picomatch | 4.0.3 | high | GHSA-c2c7-rcm5-vvqj | build/dev-only |
| picomatch | 4.0.3 | moderate | GHSA-3v7f-55p6-f55p | build/dev-only |
| rollup | 4.58.0 | high | GHSA-mw96-cpmx-2vgc | build/dev-only |
| esbuild | 0.27.3 | low | GHSA-g7r4-m6w7-qqqr | build/dev-only |

### betterbase/js (SDK) — 2 advisories (prior: 2 — match)

| Module | Version | Severity | Advisory | Class |
|---|---|---|---|---|
| uuid | 10.0.0 | moderate | GHSA-w5hq-g745-h8pq | build/dev-only |
| esbuild | 0.27.3 | low | GHSA-g7r4-m6w7-qqqr | build/dev-only |

### betterbase-examples/shared — 5 advisories (prior: 5 — match)

| Module | Version | Severity | Advisory | Class |
|---|---|---|---|---|
| picomatch | 4.0.3 | high | GHSA-c2c7-rcm5-vvqj | build/dev-only |
| rollup | 4.57.1 | high | GHSA-mw96-cpmx-2vgc | build/dev-only |
| picomatch | 4.0.3 | moderate | GHSA-3v7f-55p6-f55p | build/dev-only |
| uuid | 10.0.0 | moderate | GHSA-w5hq-g745-h8pq | build/dev-only |
| esbuild | 0.27.3 | low | GHSA-g7r4-m6w7-qqqr | build/dev-only |

### betterbase-examples/notes — 7 advisories (prior: 7 — match)

| Module | Version | Severity | Advisory | Class |
|---|---|---|---|---|
| linkify-it | 5.0.0 | high | GHSA-22p9-wv53-3rq4 | runtime |
| linkify-it | 5.0.0 | high | GHSA-v245-v573-v5vm | runtime |
| rollup | 4.58.0 | high | GHSA-mw96-cpmx-2vgc | build/dev-only |
| @tiptap/core | 2.27.2 | moderate | GHSA-cp6q-959q-f8rh | runtime |
| markdown-it | 14.1.1 | moderate | GHSA-6v5v-wf23-fmfq | runtime |
| uuid | 10.0.0 | moderate | GHSA-w5hq-g745-h8pq | build/dev-only |
| esbuild | 0.27.3 | low | GHSA-g7r4-m6w7-qqqr | build/dev-only |

### Other examples — 3 advisories each (prior: 3 each — match)

Identical advisory set in each of launchpad, tasks, passwords, photos, board, chat:

| Module | Version | Severity | Advisory | Class |
|---|---|---|---|---|
| rollup | 4.58.0 | high | GHSA-mw96-cpmx-2vgc | build/dev-only |
| uuid | 10.0.0 | moderate | GHSA-w5hq-g745-h8pq | build/dev-only |
| esbuild | 0.27.3 | low | GHSA-g7r4-m6w7-qqqr | build/dev-only |

### e2e — 1 advisory (prior: 1 — match)

| Module | Version | Severity | Advisory | Class |
|---|---|---|---|---|
| esbuild | 0.27.3 | low | GHSA-g7r4-m6w7-qqqr | build/dev-only |

## Prior-count comparison

| Target | Prior (review 06) | Fresh | Verdict |
|---|---|---|---|
| RustSec betterbase | 0 | 0 | match |
| RustSec accounts / sync / inference | 1 each (rsa 0.9.10) | 1 each (rsa 0.9.10) | match |
| RustSec json-joy-rs | 0 | 0 | match |
| RustSec advisory-db snapshot | d5c17953… | d5c17953… (same commit) | match |
| npm accounts web | 16 | 16 (8 high / 6 moderate / 2 low) | match |
| npm SDK (betterbase/js) | 2 | 2 (1 moderate / 1 low) | match |
| npm shared | 5 | 5 (2 high / 2 moderate / 1 low) | match |
| npm notes | 7 | 7 (3 high / 3 moderate / 1 low) | match |
| npm launchpad/tasks/passwords/photos/board/chat | 3 each | 3 each (1 high / 1 moderate / 1 low) | match |
| npm e2e | 1 | 1 (1 low) | match |

## Interpretation caveats (per review 06 §F-05)

- Exploitability is **not** inferred from scanner severity. These are package/advisory matches, not demonstrated exploitable bugs; no exploit payloads were run and no reachability analysis was performed in this pass.
- Accounts web is a browser SPA: React Router advisories involving SSR/RSC code paths must not be described as demonstrated server-side RCE for this deployment.
- The Tiptap maintainer advisory (GHSA-cp6q-959q-f8rh) states standard fixed schemas discard unknown attributes; untrusted-attribute handling is required for exploitability, and that reachability has not been established in Notes.
- Advisory triage and dependency updates remain remediation tasks (out of scope for this audit wave; no product or lockfile edits were made).

---

## Wave-10 remediation rescan (2026-09-21, AUD-059 close)

Tooling unchanged (cargo-audit 0.22.2, pnpm 12.4.2). Post-fix state:

| Target | Before | After | Notes |
|---|---|---|---|
| RustSec accounts / sync / inference | 1 each (rsa 0.9.10) | **0 each (exit 0)** | RUSTSEC-2023-0071 ignored via `.cargo/audit.toml` with in-file rationale (ES256-only JWT usage; no RSA key loaded; no upstream fix) |
| npm accounts web | 16 (8 high) | **0** | react-router re-resolved in-range to fixed releases |
| npm SDK (betterbase/js) | 2 | **0** | uuid override ^11.1.1; esbuild devDep ^0.28.1 |
| npm shared | 5 (2 high) | **1 low** (accepted) | tsup range-caps esbuild at 0.27.7 (build-only) |
| npm launchpad/tasks/photos/board/passwords/chat | 3 each | **0 each** | uuid override; explicit rollup/esbuild devDeps |
| npm notes | 7 (3 high) | **1 moderate** (accepted) | linkify-it/markdown-it fixed; @tiptap/core 2.27.2 stays (patch = 2→3 major; advisory requires untrusted-attribute handling notes does not do) |
| npm e2e | 1 | **0** | esbuild re-resolved |

Net: 47 npm advisory matches → 2 accepted (both with reachability caveats); 3 RustSec findings → 0 unacknowledged.

Operational note: pnpm 12 reads `overrides` from `pnpm-workspace.yaml`, not package.json `pnpm.overrides`. Separately, `pnpm update` on vite 8's optional build peers (rollup/esbuild) can silently drop them from the graph while `vite-plugin-top-level-await` still requires rollup at config load — both are now explicit devDeps in the SDK and all example apps.
