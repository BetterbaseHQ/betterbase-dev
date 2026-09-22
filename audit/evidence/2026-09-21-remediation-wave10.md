# Remediation wave 10 — deployment cluster (AUD-055–059)

Date: 2026-09-21. Scope: the five deployment/dependency findings. Register: 51 → **56/60**.

Baselines: betterbase-dev `d2b519c`, accounts `44be272`, sync `200914d`, inference `f1ac02c`, betterbase `454be3e`, examples `591bff0`. Fix commits: accounts `fb3c5f1`, sync `a657e6b`, inference `8190318`, betterbase `eecda45`, examples `4bb0bac` + review round `6ad8514` (+ dev repo, this commit). Release pin re-stamped after the review fixes.

## Work packages

- **AUD-055 (TLS wiring):** caddy service gets `ACCOUNTS_SITE`/`SYNC_SITE`/`ACME_EMAIL` (explicit defaults preserving local HTTP behavior), ports 80/443 published, `caddy_data`/`caddy_config` cert-persistence volumes. `.env` template + AGENTS.md deployment section.
- **AUD-056 (prod env):** `SMTP_*` wired; accounts validates SMTP host at startup in SMTP mode (3 unit tests; observed live refusing an unconfigured stack); `SYNC_ENDPOINT` default no longer docker-internal; `FILE_STORAGE=fs` + `sync_files` volume with dev redirected to `dev_sync_files` (volume isolation re-verified empirically: `down -v` removes only attached volumes).
- **AUD-057 (rate-limit honesty):** dead events/push/pull tiers removed; `sync_ws` (120/min) and `sync_federation_ws` (60/min) tiers with long-lived transport settings; federation HTTP metadata tier; JWKS into health tier; header docs state per-connection bounds are server-side (mailbox caps, federation quotas).
- **AUD-058 (release + backup):** `release.toml` (6 components, exact commits) + `just release-pin`/`check-release` gate (passing); `just backup`/`just restore` (pg_dump custom format, file + cert volume archives, restarts only previously-running services) — round-trip smoke-tested on a real DB-only prod stack; examples CI sibling checkouts pinned to exact refs matching release.toml.
- **AUD-059 (dependencies):** rsa accepted-with-rationale via `.cargo/audit.toml` ×3 (cargo audit exit 0 everywhere); npm 47 → 2 accepted residuals (notes tiptap 2.x — patch is a major migration, reachability not established; shared build-only esbuild capped by tsup's range). Operational discoveries recorded: pnpm 12 overrides live in pnpm-workspace.yaml; vite 8 optional build peers must be explicit devDeps.

## Verification

- `docker compose config` ×2 (prod, merged dev) parse; `caddy validate` ×2 modes with the real plugin-built image.
- Backup → restore round-trip smoke test on a real prod DB stack (both directions green); test stack and volumes cleaned after.
- `just check-release`: 6/6 components OK.
- `cargo audit` ×3 exit 0; `pnpm audit`: 9/11 workspaces clean, 2 residuals documented.
- `just check-all` exit 0 (accounts 188 incl. web; SDK 519 node + 200 browser on the repaired peer graph); `just e2e` **125 passed + 3 skipped (4.4m), faults 3/3 (50s)**.
- A `check-all` failure during the wave (browser configs: "Cannot find module 'rollup'") was root-caused to the vite-8 optional-peer drop and fixed by explicit devDeps — not papered over.

## Review results

Independent review (adversarial, source-traced + commands re-run): **PASS** AUD-055/056/057/059, **PASS-with-notes** AUD-058. All load-bearing claims verified against reality (merged-compose mount *replacement* semantics, SMTP gate position on the startup path, route↔tier correspondence, broker caps, audit gating, all 11 workspace audits, release HEAD equality). Review findings and dispositions:

- **IMPORTANT — CI pinned a nonexistent betterbase SHA** (mistyped in transcription; shared prefix made it eyeball-deceptive): fixed — ref now byte-identical to release.toml (`examples 6ad8514`), record wording corrected.
- **MINOR — backup/restore hardening** (all fixed in `scripts/backup.sh`, round-trip re-smoke-tested): `--exit-on-error` on both `pg_restore`s (no half-applied SQL); caddy archive skipped when the volume doesn't exist (docker auto-create had made the fallback near-unreachable) and its restore guarded against empty archives (which would have wiped live certs); service capture fails closed (no `|| true`); hot-backup consistency semantics documented in the header.
- **MINOR — release gate now counts untracked files as dirty** (an untracked source file can alter a certified build); dev-repo-only untracked scratch stays outside the gate (the dev repo is not a pinned component).
- **MINOR — doc accuracy**: "1000/min sync default" corrected to 600/min (AGENTS.md + Caddyfile header; 1000/min is the accounts web default); AUD-059 precision (tiptap 2.27.3, esbuild devDep ^0.28.2).
- Disclosed, not fixed: both CI sibling pins point at unpushed commits (workflow documents that CI needs them pushed); ACME issuance not exercised locally.

## Residuals carried

AUD-055: real ACME issuance not exercised locally (config-validated both modes). AUD-056: bare `just prod` fails fast without SMTP config (deliberate). AUD-057: rate limiting still not under e2e test (unchanged posture); tier numbers are review values, not load-tested. AUD-059: the two accepted npm residuals above.
