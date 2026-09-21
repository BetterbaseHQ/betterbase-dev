# Evidence: remediation wave 3 (silent data loss)

Date: 2026-09-21. Scope: AUD-025, AUD-022, AUD-046, AUD-049, AUD-019,
AUD-017 — the six "silent data loss" findings from the register's wave
plan (D-004). Every fix has a regression test pinning the reported
failure schedule.

## AUD-025 — pull cursor advances past unapplied work

- `ws-client.ts`: `pull.begin` no longer adopts the advertised head cursor;
  entries advance it, `pull.commit` confirms it. Partial stream (commit
  skipped, `_chunks` matches what was sent) leaves the cursor at the last
  delivered entry; nothing delivered falls back to `prev`.
- `ws-transport.ts`: decrypt failure at sequence N gates the space's
  cursor at N-1; `PullResult.failures` propagates to SyncManager (the
  "silent" half). Cursor advances are staged (memory + durable store) and
  committed only by `SyncTransport.commitPersistedCursors(collection)`
  after application; an apply throw or crash re-pulls the range. A
  superseded uncommitted stage is dropped by the next pull.
- Tests: ws-client (partial/no-delivery/full-commit cursor), ws-transport
  (failure gating + re-pull from gated cursor, staging, superseded stage),
  sync-manager (commit after success; no commit on apply throw; commit
  when collection-cursor write fails). INV-02 updated to "established at
  the pull boundary".

## AUD-022 — auto-ID replay duplication after failover

- `OpfsDb.put`/`bulkPut` preallocate a UUID into the document before
  dispatch (respecting `options.id`); replays carry the same id and the
  Rust upsert path (existing id → update, createdAt preserved) makes them
  idempotent.
- Tests: OpfsDb (preallocated UUID dispatched; replay carries identical
  payload; caller/options id precedence; distinct bulkPut ids); Rust
  adapter `put_with_existing_id_updates_instead_of_duplicating`.

## AUD-046 — notes debounce window discards drafts

- External-sync effects flush the pending debounced save before rebasing
  title/body to peer content.
- Mantine `useDebouncedCallback` replaced by shared
  `useFlushableDebouncedCallback`: Mantine's `flush()` zeroes the timer
  ref without cancelling the pending setTimeout — a stale timeout re-fires
  old args after a forced flush once another call re-arms the ref,
  silently swallowing the newest save (observed while testing; the
  replacement cancels and fires exactly once).
- Test: peer title update mid-debounce followed by another keystroke —
  the draft write fires and wins the LWW race (`title: t.string()` is LWW
  by schema design; see record for the judgement call).

## AUD-049 — task RMW clobbers intervening sync updates

- New `Database.getWithBase(def, id)`: record + CRDT base from a single
  worker dispatch (atomic w.r.t. sync application); TypedAdapter
  passthrough. `todos.ts` ops patch with the read's base.
- Tests: tasks app — a peer todo committing between the op's read and its
  write survives; SDK — `getWithBase` dispatch/decode contract.

## AUD-019 — stale ACK clears metadata-only changes

- `PushSnapshot` carries the pushed read's `meta` (optional, serde
  default); `prepare_mark_synced` treats a meta mismatch like a grown
  patch log. Both push paths (JS SyncManager, native sync manager)
  snapshot meta.
- Tests: record_manager — meta-only change after the snapshot survives a
  stale ack; matching meta acks cleanly; legacy snapshots unchanged.

## AUD-017 — OPFS journal_mode=MEMORY corruption risk (judgement call)

- Switched to `journal_mode=PERSIST` (file-backed rollback journal) with
  the corrected safety analysis in the code comment. Decision approved by
  the owner with fresh measurements: MEMORY 0.82ms vs PERSIST 2.59ms per
  single put (+1.8ms on debounced UI writes, 3.2x), bulk/transactional
  writes unchanged (~0.04ms/record). The old comment's "at most one
  in-flight write is lost" bound was factually wrong (SQLite-documented
  corruption of committed data; native crash harness reproduced it).
- Residual accepted: synchronous=NORMAL leaves a power-loss window.
- Pin: browser test asserts the database opens with journal mode
  `persist` (new `journalMode()` diagnostic through the worker boundary).

## Verification

- `betterbase`: `just check` green after each finding and at wave end —
  cargo tests + clippy (all targets incl. wasm), tsc, 498 vitest, 200
  browser tests (includes the new journal pin and getWithBase units).
- `betterbase-examples`: shared `pnpm check` + tests (14), notes
  `pnpm check` + tests (4, incl. AUD-046 regression), tasks `pnpm check` +
  tests (3, incl. AUD-049 regression).
- Commits: betterbase `b7760ce` (025), `7d98120` (022), `6850d63` (049
  plumbing), `a36ee0b` (019), `211277f` (017); examples `d92bb16`
  (046+049).
- Platform e2e: run after review fixes (recorded below).

## Review

Independent code-reviewer agents covered all wave-3 deltas; findings and
their resolutions are recorded in the reviews section of this file
(appended after the reviews completed).

## Review results (appended after completion)

Two independent code-reviewer agents covered the wave-3 deltas (SDK:
b7760ce, 6850d63, a36ee0b, 211277f; examples: d92bb16). All findings
fixed and re-verified:

- **CRITICAL — realtime fast-path leapt gated cursors** (applySyncEvent
  used the max collection cursor for gap/stale detection and advanced
  every collection on success): fixed with min-cursor detection +
  advance-only-if-contiguous (cursor === prev). Regressions: gated
  collection forces a full pull (no leap); contiguous events advance
  only collections at prev. Commit `bb4f730`.
- **IMPORTANT — permanent-decrypt gate wedged infinite re-pull**: gates
  held only by non-retryable failures release after 5 consecutive pulls
  with a loud error; retryable failures (key share pending) still gate
  indefinitely. Regression added.
- **IMPORTANT — note-switch with equal titles left the previous draft
  displayed and persistable into the new note** (restructure regression
  found by review): switch path now rebases the title input explicitly.
  Commit `c453100`.
- **IMPORTANT — racy final assertion in the notes regression**: now
  waits for the flushed draft to merge and the input to rebase before
  the follow-up keystroke.
- MINORs fixed: duplicate `pull.begin` rejects (regression added);
  commit-cursor adoption monotonic; staged-without-commit warning;
  `getWithBase` tombstone behavior documented; journal pin closes its
  db; debug logging removed; `as never` cast dropped; AUD-019 meta
  equality fidelity note.
- NITs acknowledged in code comments where applicable.

## Final verification

- `betterbase just check`: cargo + clippy (incl. wasm targets), tsc,
  501 vitest, 200 browser tests.
- examples: notes 4/4, tasks 3/3, shared 14/14, all check scripts green.
- Platform e2e full cycle: 125 passed + 3 gated-skips, fault phase 3/3.
- Wave-3 commits: betterbase `b7760ce`, `7d98120`, `6850d63`,
  `a36ee0b`, `211277f`, `bb4f730`; examples `d92bb16`, `c453100`.

Register: 23/60 fixed (was 17/60). Wave 3 complete — all six silent-data
loss findings closed with regression tests.
