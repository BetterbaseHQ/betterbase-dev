# Evidence: Deployment findings F-01/F-02/F-03 + AUD-001/AUD-002 re-verified at HEAD

- Date / reviewer: 2026-09-20 / deployment-dependency verification agent
- Finding and invariant IDs: F-01 (INV-04), F-02, F-03 (INV-07), AUD-001, AUD-002
- Repository revisions / local patch (all equal to audit baselines; all six component working trees clean):
  - betterbase-dev `7a36c07` (= baseline `7a36c07c7fc8a44dc86f09b4c34d518771cece8e`)
  - betterbase `e3a9ad1`, betterbase-accounts `b7cda88`, betterbase-sync `324da35`, betterbase-inference `bf36ba4`, betterbase-examples `f8fc63b`, json-joy-rs `2dea0bd` — all match [baseline](../baseline.md)
- Lockfile hashes / generated artifact provenance: n/a (source-only verification; dependency scans recorded separately in [dependencies.md](dependencies.md))
- Tool versions / operating system / browser: source inspection only (no scanners, containers, or browsers); macOS (darwin)
- Non-secret configuration / isolated services: none started — per task constraints, no docker containers were launched (the prior Caddy config smoke test cited in review 06 §F-01 was not re-run)
- Working directory and exact command or source-inspection method: `git rev-parse` / `git status` per repo; direct file reads of `docker-compose.yml`, `docker-compose.dev.yml`, `caddy/Caddyfile`, `e2e/compose.yaml`, `justfile`, `betterbase-accounts/.github/workflows/check.yml`, `betterbase-accounts/crates/app/src/lib.rs`, `betterbase-accounts/crates/email/src/lib.rs`, `betterbase-sync/crates/api/src/lib.rs`; `rg` route/service greps over `betterbase-sync/crates` and `e2e/compose.yaml`
- Expected behavior: each finding's cited chain still present at HEAD
- Observed behavior: all five findings re-confirmed verbatim (details below; F-03 strengthened — the rated HTTP routes no longer exist in the sync router at all)
- Exit code / assertions / skipped tests: n/a (source-only)
- Result: source-only — F-01 confirmed, F-02 confirmed, F-03 confirmed (strengthened), AUD-001 confirmed, AUD-002 confirmed
- Seed / schedule / reproduction steps: open the cited file:line at the revisions above
- Limits: source inspection only; runtime behavior of compose/Caddy was validated by the earlier isolated smoke test (review 06 §F-01) and is not repeated here; absence claims (no ports 80/443, no SMTP env, no caddy/cap in e2e) are verified by exhaustive read/grep of the cited files at HEAD, not by dynamic analysis

## F-01 — Production recipe exposes plain HTTP, no TLS wiring — CONFIRMED

- `docker-compose.yml:43–61` defines the `caddy` service with `ports: "5377:5377"` and `"5379:5379"` only (`docker-compose.yml:45–47`); the service has **no `environment:` key** anywhere in its block, so `ACCOUNTS_SITE`, `SYNC_SITE`, and `ACME_EMAIL` from the root `.env` are never passed into the container.
- `caddy/Caddyfile:48` — site address `{$ACCOUNTS_SITE::5377}`; `caddy/Caddyfile:231` — `{$SYNC_SITE::5379}`. With no env supplied, both default to bare `:5377`/`:5379` (plain HTTP). Comments at `caddy/Caddyfile:44–47` and `:228–230` describe the hostname→automatic-HTTPS mode that the production recipe never enables; `caddy/Caddyfile:30` (`email {$ACME_EMAIL:admin@localhost}`) is likewise env-dependent and unwired.
- No TLS entry ports: the only published port mappings in `docker-compose.yml` are 5377 and 5379 (lines 46–47); there is no `"80:…"`/`"443:…"` mapping anywhere in the file.
- No certificate storage: the caddy service's only volume is the read-only Caddyfile mount (`docker-compose.yml:48–50`); top-level volumes are `cap_data`, `valkey_data`, `accounts_db_data`, `sync_db_data` (`docker-compose.yml:147–151`) — no Caddy data/config volume for certs.

Verdict: **confirmed** — matches review 06 §F-01 including its limits (an external TLS terminator or custom override could still secure a deployment; the checked-in recipe does not).

## F-02 — Production omits SMTP wiring, advertises Docker-internal sync endpoint, no file backend — CONFIRMED

- SMTP: the `accounts` service environment (`docker-compose.yml:86–96`) passes `OPAQUE_SERVER_SETUP`, `OAUTH_ISSUER`, `DATABASE_URL`, `CAP_VERIFY_URL`, `CAP_KEY_ID`, `CAP_SECRET`, `IDENTITY_HASH_KEY`, `SYNC_ENDPOINT` — no `SMTP_*` variables. `betterbase-accounts/crates/app/src/lib.rs:78–89` defaults `SMTP_DEV_MODE` to `false` (i.e. SMTP mode) and `SMTP_HOST` to empty (`lib.rs:81`, `unwrap_or_default()`); `lib.rs:172–183` then constructs `SmtpMailer` whenever dev mode is off, and `betterbase-accounts/crates/email/src/lib.rs:88` builds `AsyncSmtpTransport::relay(&self.config.host)` from that host — an empty host fails at send time. Setting SMTP vars in the root `.env` alone does not reach the container. (Dev is explicitly rescued by `SMTP_DEV_MODE=true` in `docker-compose.dev.yml:18`; e2e likewise at `e2e/compose.yaml:61,153`.)
- SYNC_ENDPOINT: `docker-compose.yml:96` — `SYNC_ENDPOINT=${SYNC_ENDPOINT:-http://sync:5379/api/v1}`, the Docker-network-only hostname advertised in federation discovery, unresolvable for a remote browser unless overridden.
- File backend: production `sync` environment (`docker-compose.yml:128–135`) sets only `DATABASE_URL`, `TRUSTED_ISSUERS`, `AUDIENCES`, `IDENTITY_HASH_KEY` — no `FILE_STORAGE`/`FILE_STORAGE_BACKEND` and no file data volume (top-level volumes, `docker-compose.yml:147–151`). Contrast dev (`docker-compose.dev.yml:46–47`: `FILE_STORAGE=fs`, `FILE_FS_PATH=/var/lib/betterbase-sync/files`) and e2e (`e2e/compose.yaml:98–99` and `:189–190`, both sync servers). Files are therefore disabled by default in prod, unlike dev/e2e.

Verdict: **confirmed** — matches review 06 §F-02.

## F-03 — Caddy rate-limit tiers describe obsolete sync routes — CONFIRMED (strengthened)

- Obsolete tiers present at HEAD: `caddy/Caddyfile:289–309` (`sync_events` zone for `POST /api/v1/events`), `:315–328` (`sync_push` for `/api/v1/spaces/{id}/push`), `:334–347` (`sync_pull` for `POST /api/v1/pull`) — the block span `285–347` cited in review 06. File tiers at `:353–385` (`PUT/GET/HEAD /api/v1/spaces/{id}/files/{hash}`).
- Current sync router (`betterbase-sync/crates/api/src/lib.rs:274–297`): registered routes are `/health`, `/.well-known/jwks.json`, `/api/v1/ws` (`lib.rs:280`, client WS RPC, subprotocol `betterbase-rpc-v1`), `/api/v1/federation/ws` (`lib.rs:281–284`), `/api/v1/federation/trusted`, `/api/v1/federation/status/{domain}`, plus `/api/v1/spaces/{space_id}/files/{id}` only when file storage is configured (`lib.rs:294–297`). An exhaustive route grep over `betterbase-sync/crates` finds no `/api/v1/events`, `/api/v1/pull`, or `/api/v1/spaces/*/push` HTTP route — the endpoints those tiers rate-limit **no longer exist**; client sync is exclusively WS RPC over `/api/v1/ws`.
- Consequence unchanged from review 06: the WS upgrade request falls through to the generic `sync_default` zone (600/min, `caddy/Caddyfile:388–397`); individual messages on an established connection are not covered by any HTTP tier, and server-side RPC/connection limits must be validated separately. (The file tiers are the one partially current piece, matching the conditional file routes when files are enabled.)
- E2E omits proxy/CAPTCHA: `e2e/compose.yaml:8` — "No caddy/cap/examples: rate limiting and CAPTCHA are not under test"; grep of the full file finds no `caddy` or `cap` service definition.

Verdict: **confirmed, and strengthened**: review 06 said the tiers "apply … to old HTTP endpoints"; at HEAD those endpoints are absent from the router entirely, so three dedicated tiers (events/push/pull) are dead config.

## AUD-001 — Accounts CI lets DB tests skip without DATABASE_URL — CONFIRMED

`betterbase-accounts/.github/workflows/check.yml:43–44`:

> `# DB-dependent tests skip without DATABASE_URL, matching local `just test``
> `- run: cargo test --workspace`

The `rust` job defines no `DATABASE_URL` env and no PostgreSQL service container, so every DB-gated test silently skips in CI — still true at HEAD `b7cda88`. (`just test-db` exists locally but is not what CI runs.)

## AUD-002 — Root `check-all` omits inference, json-joy-rs, e2e — CONFIRMED

`justfile:81–113` — `check-all` runs: betterbase (SDK), betterbase-accounts, betterbase-sync, then `pnpm check` for examples shared/launchpad/tasks/notes/photos/board/passwords/chat. It does not invoke `betterbase-inference`, `json-joy-rs`, or `e2e` checks (those require `cd`-ing into those repos; also noted in root AGENTS.md). Still true at HEAD `7a36c07`.

## Revision record

| Repo | HEAD (2026-09-20) | Baseline | Match |
|---|---|---|---|
| betterbase-dev | 7a36c07 | 7a36c07 | yes |
| betterbase | e3a9ad1 | e3a9ad1 | yes |
| betterbase-accounts | b7cda88 | b7cda88 | yes |
| betterbase-sync | 324da35 | 324da35 | yes |
| betterbase-inference | bf36ba4 | bf36ba4 | yes |
| betterbase-examples | f8fc63b | f8fc63b | yes |
| json-joy-rs | 2dea0bd | 2dea0bd | yes |

No product code, compose files, or running services were modified during this verification.
