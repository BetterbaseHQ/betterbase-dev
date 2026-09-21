# Deployment, release and assurance review

2026-09-20. Root baseline `7a36c07c7fc8a44dc86f09b4c34d518771cece8e`; component revisions in [baseline](../baseline.md). Reviewed production/dev/E2E Compose, Caddy config/build, setup and just recipes, service Dockerfiles/entrypoints/configuration, CI workflows, test configuration, release dependency wiring, and lockfile advisory scans. No deployments or product fixes were made. Ordinary tests used synthetic data in an isolated audit PostgreSQL container and the already running E2E project; dev services were not targeted.

## F-01 — The production recipe exposes plain HTTP and does not wire TLS settings

**High if used as the advertised public production entry point; source and isolated startup evidence. INV-04.**

`docker-compose.yml:43–61` publishes ports 5377/5379 and supplies no environment to Caddy. `caddy/Caddyfile:48` and its sync counterpart default to `:5377`/`:5379`; comments describe `ACCOUNTS_SITE`/`SYNC_SITE` hostnames enabling HTTPS, but root `.env` values are not automatically passed into a container without Compose environment wiring. Ports 80/443 and persistent Caddy certificate storage are also not configured.

A network-disabled temporary `caddy-check` container loaded the checked-in Caddyfile and started HTTP listeners, logging that HTTP/2 and HTTP/3 were skipped because TLS was absent. The existing custom Caddy image was used; this was a config smoke test, not a clean image build or public network test. It was stopped after five seconds. The suspected admin/health port collision did **not** reproduce; Caddy started successfully, so it is not a finding.

Limits: an external TLS terminator or custom Compose override can provide a secure deployment. The checked-in production recipe does not provide or document a complete such deployment. Plain HTTP browser application delivery undermines client-side encryption even if record payloads are encrypted later.

## F-02 — Production service settings omit required operational integrations

**Medium availability/configuration defect; confirmed by source.**

`docker-compose.yml:80–101` does not pass SMTP settings; `betterbase-accounts/crates/app/src/lib.rs:78–89,172–182` defaults to SMTP mode with an empty host, and `crates/email/src/lib.rs` constructs an SMTP relay using that host when sending. Merely setting SMTP variables in the root `.env` does not wire them into accounts. Registration/recovery email delivery therefore needs an unprovided override.

The default advertised `SYNC_ENDPOINT` is the Docker-only `http://sync:5379/api/v1` (`docker-compose.yml:96`), which a remote browser cannot resolve. Production sync also has no file-backend config or file volume, unlike dev/E2E. Files are therefore disabled by default, rather than automatically durable as in the example workflows. No real email was sent. These are deployment contract gaps; external overrides can address them but are not represented by `just prod` alone.

## F-03 — Proxy rate-limit rules describe obsolete sync routes

**Medium assurance/configuration mismatch; confirmed source. INV-07.**

`caddy/Caddyfile:285–347` applies event/push/pull tiers to old HTTP endpoints. Current synchronization is WebSocket RPC at `/api/v1/ws`; those HTTP matchers do not limit individual messages on an established connection. The generic upgrade request is limited and server-side limits exist, so this is not a claim that every sync request is unbounded. Capacity/security reviews must validate actual RPC, connection, frame and storage quotas rather than relying on the documented HTTP tiers. E2E explicitly omits Caddy and CAP (`e2e/compose.yaml:7`).

## F-04 — Recovery and release compatibility have no demonstrated operational gate

**High-priority assurance gap, not a reproduced loss event. INV-01/05/06.**

There is no checked-in full backup/restore recipe or tested contract covering accounts/sync databases, object bytes, OPAQUE setup, signing/trust keys, and local unsynced data. No restore or mixed-version rollback exercise was run in this pass. Existing migration tests primarily bootstrap current schemas; arbitrary historical upgrade/rollback combinations are not established.

SDK/examples CI checks out sibling repositories without revision refs; lockfiles do not pin local path/link dependency source commits. Consequently a green component CI run alone cannot identify a reproducible platform release. The audit records exact local commits, but pre-existing E2E server images and SDK generated WASM were not rebuilt from a sealed release manifest. Their runtime results are useful compatibility observations, not proof of release provenance.

The CRDT port's upstream compatibility inventory is a useful model for explicit traceability. Apply the same principle to platform release combinations and restore contracts during remediation.

## F-05 — Lockfile advisory scans report unresolved dependencies

**Medium dependency-management finding; exploitability varies and is not inferred from scanner severity. INV-07.**

Fresh RustSec and npm scans were executed without changing dependency versions. RustSec snapshot `d5c17953a895cf19e8d3ce66eaa42b6fcfe1fb16` reports `rsa 0.9.10` / [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) in accounts, sync, and inference via jsonwebtoken. Reviewed application JWT paths restrict verification/signing to ES256; no reachable RSA private-key timing operation was established. The SDK and json-joy lockfiles had zero RustSec vulnerability matches in this snapshot. Yanked-crate lookup was disabled explicitly.

npm reported 16 advisory entries for accounts web; SDK 2; shared 5; notes 7; each other example 3; E2E 1. These are package/advisory matches, not that many independently exploitable application bugs. Counts were recorded here during the interrupted coordinator run; the referenced sanitized advisory file was not written at that time and has since been regenerated with identical counts and the same advisory-db commit ([dependency evidence](../evidence/dependencies.md)).

Notable runtime package matches are React Router and Tiptap/Markdown/linkification; many others are build/dev tools. Accounts uses a browser SPA, so Router SSR/RSC advisories must not be described as demonstrated server RCE here. The [Tiptap maintainer advisory](https://github.com/ueberdosis/tiptap/security/advisories/GHSA-cp6q-959q-f8rh) explicitly says standard fixed schemas discard unknown attributes and that additional untrusted attribute handling is required. That reachability has not been established in Notes. Advisory triage and dependency updates remain remediation tasks; no exploit payload was run.

## Existing defenses and gaps

Service runtime images use nonroot users; database ports are internal in production; CAP's image is digest-pinned; dev and E2E have separate volume namespaces; sync federation key provisioning preserves existing primary keys. The test PostgreSQL instance was separate again, on loopback port 25432. These provide useful isolation and should be retained.

Unverified here: complete clean Docker image builds/SBOM/container scanning; Caddy public TLS and reverse-proxy headers; actual CAP/SMTP failures; cloud object-store restore; multi-instance service bootstrap/key rotation; supported-browser matrix beyond Chromium; sustained capacity/chaos campaigns; dependency feature-level reachability and vendored unsafe VFS memory safety. These are explicit limits, not passing checks.
