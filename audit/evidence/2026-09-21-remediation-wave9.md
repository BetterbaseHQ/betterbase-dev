# Remediation wave 9 — examples tail (AUD-050/051/053/054)

Date: 2026-09-21. Scope: the four remaining example-app findings. Register: 47 → **51/60**.

Baselines: betterbase-examples `86c6dc6` (clean), betterbase `ca6f6d5`+`9c9735d`. Fix commits: examples `1750bd5` + review round `591bff0`; SDK `454be3e` (testing double only).

## Work packages

- **AUD-050 (chat attribution):** shield and display derive from the edit chain's *creator* did (signature-bound) resolved through `useMembers` (verified membership log): green shield only on valid-chain + handle match; amber warning on valid-chain mismatch; crypto-resolved handle preferred for display; spoof-as-local renders as the peer's. Review round hardened this: only chains passing `_editChainValid` drive attribution (a tampered chain falls back to claimed handle, no shield); shortHandle dedup uses resolved handles. SDK mock gained `setSpaceMembers`.
- **AUD-051 (send lifecycle):** clear-only-if-unchanged on success; `sending` guard blocks Enter/Send double-fire while pending; failed send keeps `{text, id}` so retrying the same draft reuses the submission id — explicit-id put upserts (verified through TypedAdapter → OpfsDb → Rust put), no duplicate. Modified text = fresh id.
- **AUD-053 (auto-create):** notes authed, board authed, board local — `.catch` → `reportError` + guard release on failure (were unhandled rejections / latched guards).
- **AUD-054 (column cascade):** local `deleteColumn` delegates to `deleteTree` — db-discovered children, deepest-first, parent gated on children's success; survivors stay reachable on partial failure. Authed path already used deleteTree.

## Review results

Independent review: **PASS** AUD-053; **PASS-with-notes** AUD-050/051/054; no FAILs, no regressions (prop signature fully propagated; mock change inert by default). Load-bearing semantics verified against SDK source by the reviewer (chain[0]=creator with did↔key binding; idempotent explicit-id upsert; fail-fast cascade). All MINOR issues fixed or documented:
- Fixed (`591bff0`): tampered-chain attribution gate (display no longer trusts unverified chains); double-fire test; resolved handles in the dedup set.
- Documented in records: degradation windows (pre-sync no-chain; membership-unresolved shield suppression incl. transient spoof-as-local) and the raised bar ("forging membership-log signatures", not a cryptographic guarantee); AUD-054's app test is a happy-path net — partial-failure semantics carried by SDK `delete-tree` tests; edited-back-to-identical-text draft edge; AUD-053 partial-create residual; exact-string handle comparison dependency.

## Verification

- chat `pnpm run check` (prettier + tsc + build + tests): **7/7** (3 new tests, 2 red on parent; AUD-050 test red on parent).
- board: **17/17** (1 new happy-path cascade test); notes: **4/4**; SDK `just check-js`: **519 node + 200 browser** (mock change).
- Platform `just check-all` + `just e2e`: results appended at close.

Wave-9 commits: examples `1750bd5`, `591bff0`; betterbase `454be3e`. Register: **51/60**.

**Platform gates (final):** `just check-all` exit 0 (all component suites green, zero TS errors); `just e2e` green: **125 passed + 3 skipped (4.4m), faults 3/3 (1.5m)**. Wave 9 complete. Register: **51/60**.
