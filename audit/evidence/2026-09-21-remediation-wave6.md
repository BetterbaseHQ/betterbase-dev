# Remediation wave 6 — files/uploads cluster

**Date:** 2026-09-21 · **Scope:** AUD-027, AUD-036, AUD-045, AUD-047, AUD-048, AUD-052 · **Register:** 31/60 → **37/60**

All six findings re-verified at HEAD before work began (source state unchanged since wave-2 re-verification).

## Isolation policy decision (AUD-045)

User selected: **per-account DBs + retained anonymous namespace**. Anonymous/local data stays in the bare-named database (local-first retention — nothing deleted on switch); each signed-in account opens `name_<hash>`; the whole app remounts on scope change. Structural isolation, not query filtering (reviewer-rejected approach).

## Work packages and commits

| WP | Finding | Repo:commit | Essence |
|---|---|---|---|
| 1 | AUD-027 | betterbase-sync `040ebcb` | Retry runs the idempotent `record_file` commit instead of early-204; 409 on stale DEK |
| 2 | AUD-036 | betterbase `2d0fd71` | 15-min stale-window resets `uploading`→`pending` on scan; cross-instance reasoning documented |
| 6 | AUD-052 | examples `a130637` + betterbase `dd00ad1` | Shared UploadQueueStatus badge + Synced→Syncing downgrade; testing doubles |
| 5 | AUD-048 | examples `221d7d5` | Compensating record delete on byte-persistence failure; deletable unavailable tiles; awaited evictions |
| 4 | AUD-047 | examples `06aa06a` | Durable move marker, split board move (create→persist→tombstone), createdAt-fingerprint adoption, query-driven FK rewrite, mount-time reconciler |
| 3 | AUD-045 | examples `7726b6b` + betterbase `f60ad60` | Per-account live-binding db swap + DbScopeGate remount across all six apps; useSyncDb stub fix |

## Design notes worth carrying forward

- **AUD-027/036 interlock:** the stale-upload reset's safety against a live peer-tab uploader depends on the server-side idempotency fixed in AUD-027 — the race loser observes an already-recorded file (object create-mode + `ON CONFLICT DO NOTHING`). The two fixes were reviewed as a pair.
- **AUD-045 live-binding contract:** `db` is a `let` export; importers must not capture it. The App root's React-key remount is what prevents mid-swap observation. The one test bug found during development (a helper snapshotting `db`) is the exact caveat now documented in every db.ts.
- **AUD-047 adoption fingerprint:** the raw local adapter has no space metadata and ignores query filters — recovery logic matches strays in JS and identifies the created-but-unrecorded board by its preserved `createdAt`. Both constraints are load-bearing and commented at the site.
- **betterbase-examples is one repo** (apps are subdirectories) — per-app `git -C` commits sweep repo-wide; wave-6 commits are scoped by explicit pathspec staging from the repo root.

## Verification

- betterbase-sync: `just check` (fmt/clippy/all targets/tests) green; new handler-level tests 26 passing in files.rs.
- betterbase: `just check` green — 517 node + 200 browser (file-store 49 incl. 2 new; session/others unchanged).
- betterbase-examples: all seven packages (6 apps + shared) `pnpm check` green — tasks 5, notes 4, passwords 10, photos 6, board 13, chat 4, shared suite incl. 10 new UploadQueueStatus/account-db tests.
- Platform: `just check-all` green; `just e2e` — main phase **125 passed + 3 gated-skips (4.4m)**, fault-injection **3/3 (50.5s)**.

## Test-harness adjustments (documented, not papered over)

- `disconnect reverts to local-only` (file-store) restructured deterministically — its old form raced background queue processing.
- Local-path app suites pre-align the db scope before render (avoids a second database boot at mount); first post-render queries use `findByRole` (scope gate shows a loader for a microtask); boot-sensitive waits widened.
- photos App test renamed `.ts`→`.tsx` (JSX probe); unique record ids per test (tombstones persist within a file).

Wave-6 review round: pending (to be appended).

## Review results (appended after completion)

One code-reviewer agent covered all three repos' wave-6 deltas with empirical checks. Verdicts: AUD-027 **pass**, AUD-036 **pass**, AUD-052 **pass (clean)**, AUD-048 **pass** (one minor), AUD-047 **pass with follow-ups**, AUD-045 **partial** — all follow-ups fixed in the review round:

- **IMPORTANT — board strays patched in place never reached invitees (S5):** a personal-space stray (e.g. a card added from a second device mid-share) patched in place syncs only within the sharer's personal space — invisible to the invitee, the finding's harm scoped to peer views. Fixed: strays outside the target space are MOVED into it; shared-space strays still patch. Fake-db branch test (the raw adapter cannot attach `_spaceId` to schema-validated records).
- **IMPORTANT — photo bytes un-isolated and actively migrated across accounts (S9):** one origin-wide FileStore meant A→B connect migrated A's cached plaintext blobs and A's pending queue entries into B's space partition; local-only puts after logout landed under the last account's partition. Fixed: the FileStore is created inside the scope-keyed subtree with a per-account cache database and disposed on unmount.
- **IMPORTANT — worker/coordinator leak per scope switch (S10):** the displaced Database was never closed. Fixed with a deferred close (10s) — immediate close empirically contended with rapid same-name reopens through the OPFS handle (stalled reopens in the test suite).
- Ghost-board state (S6): a crash between persist-id and tombstone left the old board alive forever — recovery now always tombstones it (new regression).
- Adoption hardening (S7): createdAt AND name matching, refuse on ambiguity. Completion serialization (S8a): reconciler vs share vs StrictMode could double-create the board. `loadMarkers` index-shift (S8b) and unresolvable-marker churn (S8c) fixed. Remap-on-merged-record bug in the move branch found and fixed during the round.
- Disconnected stale-pin (S2): the reset now also runs from eviction, so a device that never reconnects still un-pins. O(n²) reset notifications (S3) batched. Thumbnail-eviction gap in import compensation (S4) fixed. `useDbScope` failure path surfaces an error with reload instead of an infinite loader; superseded-open assignment guarded (S11). Doc drift `name::<hash>` → `name_<hash>` (S12).
- **Accepted residuals, documented rather than fixed:** (a) *torn bytes/DEK pairing* (S1, server, MINOR): with two concurrent uploads of the same file id and different DEKs, store-order ≠ record-order can pair one request's ciphertext with the other's wrapper — every download then fails GCM auth; recovery is delete-and-reupload. Reachable only through millisecond server interleaving inside an already-rare race (e.g. the AUD-036 reset racing a stalled live uploader — the wave's "race is safe" claim was corrected accordingly). Proper fix is a client-sent ciphertext hash verified on conflict (a backward-compatible optional header); deferred as a v1.x hardening item. (b) Same-millisecond adoption collisions are theoretically possible but not realistically reachable (human-paced board creation); the hardened matcher refuses rather than guesses.

## Final e2e (after all review fixes)

Main phase **125 passed + 3 gated-skips (4.4m)**, fault-injection **3/3 (50.2s)**.

Wave-6 commits (final): betterbase-sync `040ebcb`; betterbase `2d0fd71`, `dd00ad1`, `f60ad60`, `8b01dcb`; betterbase-examples `a130637`, `221d7d5`, `06aa06a`, `7726b6b`, `662dff8`.

Register: **37/60**. Wave 6 complete.
