# Evidence: examples findings re-verification (E-01..E-10)

- Date / reviewer: 2026-09-20; examples verification agent (wave 2). Analysis/verification only; no product code, dev/e2e services, browsers, or git state changed.
- Finding and invariant IDs: E-01..E-10 from [05-examples](../reviews/05-examples.md); INV-01, INV-03, INV-04, INV-06, INV-08 as cited per finding.
- Repository revisions / local patch: betterbase-examples `f8fc63bbce97b52d80ab603686212278af8318b9` (clean), betterbase (SDK) `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` (clean). Verified via `git rev-parse HEAD` + `git status --short` (empty) before and after all checks. No local patch.
- Lockfile hashes / generated artifact provenance: no builds; source read directly from pinned checkouts. Runtime harness imported the lockfile-installed `@mantine/hooks` 7.17.8 `.mjs` from `betterbase-examples/notes/node_modules` verbatim (no transpile). The executed Rust test compiled from the pinned checkout against the pre-existing `target/` cache.
- Tool versions / operating system / browser: macOS (darwin, arm64); Node v24.21.0; cargo/rustc from the repo toolchain (pinned checkout, warm `target/debug` cache). No browser used.
- Non-secret configuration / isolated services: none; no network, containers, databases, or dev/e2e services touched. All identifiers in checks are synthetic strings.
- Working directory and exact command or source-inspection method:
  - Source: independent re-read of every cited chain link across `betterbase-examples/{passwords,tasks,notes,photos,board,chat,shared,launchpad}/src` and `betterbase/js/src/{sync,db,auth}` plus `betterbase/crates/betterbase-db/src/{storage/record_manager.rs,crdt/schema_aware.rs}`, including hunts for defeating checks (space options on queries, auth gating of local views, catch/rollback paths, retry/recovery state).
  - Harness: `node /tmp/bb-examples-audit/e02_debounce.mjs` (+ `e02_loader.mjs`, `react-stub.mjs`; kept in /tmp per constraints).
  - Targeted existing test: `cargo test -p betterbase-db stale_full_value_write` (single filtered test, not a suite).

## Verdict summary

| ID | Verdict | Note |
|----|---------|------|
| E-01 | confirmed | All six persistent apps re-traced; no defeating check found |
| E-02 | confirmed (+ runtime) | Debounce schedule reproduced with installed @mantine/hooks |
| E-03 | confirmed | FK-patch failure after parent move permanently orphans children |
| E-04 | confirmed | Unavailable tile renders before delete controls |
| E-05 | confirmed (+ mechanism test) | No-base full-array write diffs against current model; executed SDK test documents peer-content tombstoning |
| E-06 | confirmed | Attribution trusts writable `senderHandle`; shield checks only `_editChainValid` |
| E-07 | confirmed | Draft cleared on send completion; preview-failure retry duplicates |
| E-08 | confirmed | Status UI blind to file upload queue; `useFileUploadQueue` unused |
| E-09 | confirmed | notes/board auto-create unawaited/uncaught; tasks catches |
| E-10 | confirmed | Child delete failures don't gate column deletion |

## Check 1 — E-01 source chain (source-only)

- Expected behavior (invariant): account B must not be presented account A's decrypted records, and unauthenticated views must not expose a prior account's private data.
- Observed behavior (all links present at the pinned baseline; no defeating check found):
  1. Fixed per-app database names opened by top-level `await` at module init, outside any auth lifecycle: `passwords` (`passwords/src/lib/db.ts:8`), `tasks` (`tasks/src/lib/db.ts:9`), `notes` (`notes/src/lib/db.ts:9`), `board` (`board/src/lib/db.ts:10`), `photos` (`photos/src/lib/db.ts:9`), `chat` (`chat/src/lib/db.ts:9`). All six persistent apps confirmed; launchpad has no `createDatabase` (auth-only, as the review excluded).
  2. Unauthenticated local views query the complete collections and expose mutations on the same module `db`: passwords `App.tsx:13-34` (query at 14, put/patch/delete at 20-28), selected after logout at 125; tasks `App.tsx:31`/`236`; notes `App.tsx:15-18`/`158`; photos `App.tsx:39-52`/`276-280`; board `App.tsx:37-59`/`356`. Password reveal/copy with no lock: `EntryDetail.tsx:150-173` (showPassword toggle 163-170, secret CopyField 171). Correction (cosmetic): review said `EntryDetail.tsx:149-173` — the Password FieldRow is 150-173.
  3. Authenticated hooks query with no space option: passwords `lib/sync.ts:24-29` (correction: review cited 21-29; the `useQuery` is at 24-29), chat `lib/sync.ts:30-45`; same pattern in tasks/notes/photos/board sync hooks (e.g. board `lib/sync.ts:35-57`).
  4. SDK: `js/src/sync/spaces-middleware.ts:138-150` `onQuery` returns `undefined` (no filter) unless `sameSpaceAs`/`space` is supplied (line 142); `js/src/db/middleware/typed-adapter.ts:227-267` `observeQuery` then delivers all records (line 257). Middleware enrichment (`_spaceId` stamping) is not an account filter — confirmed.
  5. Logout: `js/src/auth/react.ts:65-75` clears session state immediately; `js/src/auth/session.ts:390-417` `destroy()` removes the localStorage session, zeroes in-memory token/key fields, and clears KeyStore — nothing touches application databases/records.
  6. Labeling: `shared/src/layout/UserArea.tsx:117-119` menu item "Disconnect".
  7. Chat nuance: selection metadata is per-handle (`chat/src/App.tsx:67-82`, storageKey at 69), but the conversation/message queries (`lib/sync.ts:30-45`) still return all records, including account A's, once B is authenticated; the sign-in gate (`App.tsx:195`) hides data pre-auth only.
- Result: **source-only** (confirmed; no browser execution, per scope).

## Check 2 — E-02 runtime: installed debounce drops the pre-update save (executed)

- Expected behavior: a queued note edit must reach persistence unless superseded by a newer edit of the same draft; a peer update replacing editor state must not silently discard it.
- Observed behavior: harness loads the actual `@mantine/hooks` 7.17.8 `use-debounced-callback.mjs` from `notes/node_modules` (bare `react` redirected via a `node:module` register hook to a minimal stub providing `useRef`/`useCallback`/`useMemo`/`useEffect`; `globalThis.window` shimmed for `window.setTimeout/clearTimeout`), then drives the exact reported schedule (NoteEditor body debounce, 500 ms):

```
[+0ms]   queued save(A); debounce window 500ms started        # user types edit A
[+201ms] remote update B: editor content replaced (no debounced call)
[+252ms] keystroke C: debounced fn called again (args replaced)
[+953ms] observed fire times: [ 'B+C@+754ms' ]                # 252+500 — A's timer gone

PASS: P1 only the last queued save (B+C) persists (persisted=[B+C])
PASS: P1 save(A) never reached persistence (its t0+500 deadline passed) (A fired: false)
PASS: P2 without a post-update keystroke the pending save still runs (persisted=[A2])
PASS: P3 flush() writes only the last queued args (C3), A3 dropped (persisted=[C3])
PASS: P4 unmount flush persists only the last queued args (C4) (persisted=[C4])
exit=0
```

- The `B+C@+754ms` fire time is the timer started by the +252 ms call; A's would-be +500 ms deadline passed with no write — direct timestamped proof that each call clears the prior timer and rebinds args (implementation: `use-debounced-callback.mjs:12-28`, `clearTimeout` at 15, fresh closure over `args` at 16-24, flush rebind at 22-23). P2 reproduces the review's counterevidence schedule (stop typing → pending save survives). P3/P4 show the flush-on-note-switch (`NoteEditor.tsx:67-68`) and `flushOnUnmount` paths also write only the last queued args — the existing regression tests (`notes/src/App.test.tsx:37` flush-on-switch, `:79` delete-while-debounced) cover those schedules, not the remote-update-then-keystroke one (no peer/remote test exists).
- Source correspondence re-verified: debounces at `NoteEditor.tsx:45-52` (body, 500 ms) and `54-61` (title, 300 ms); peer effects overwrite local title at 64-73 (`setLocalTitle(current.title)` at 72) and editor body at 95-104 (`setContent` at 102 with `suppressNextUpdate`, so the replacement itself queues nothing); keystrokes re-queue at 88 and 108. The base captured at keystroke time cannot recover A — A's callback never runs.
- Result: **fail** (secure expectation violated; mechanism reproduced). Honest scope: this validates the debounce mechanism in isolation with stubbed React primitives — it does not run the full React/TipTap editor, the real peer-update effects, or IndexedDB.
- Reproduction: `/tmp/bb-examples-audit/e02_debounce.mjs` (deterministic; essential steps preserved above).

## Check 3 — E-03 source chain (source-only)

- Expected behavior: an interrupted share must leave children recoverable/retryable.
- Observed behavior (confirmed chain):
  1. `board/src/lib/sync.ts:122-165` `shareBoard`: `createSpace()` 127 → fresh child reads 131-132 → `bulkMoveToSpace` columns 134-139 → cards 142-150 (cards get `columnId` remap only; **`boardId` still old**) → `moveToSpace` board 152 → `Promise.all` of per-child `boardId` patches 156-159 (patch calls at 157-158, as cited).
  2. `betterbase/js/src/sync/move-to-space.ts:80-109`: `moveToSpace` creates the new record with a fresh id (99-105) and tombstones the old id (106) before returning; `db.get` on a tombstoned id throws at 91 — retry cannot move the old board.
  3. Rendering filters children by the selected live board id (`board/src/App.tsx:218-220`), so a child whose `boardId` patch failed points at the tombstoned id and disappears. Re-sharing queries children by `filter: { boardId: board.id }` with the *new* board id (131-132) — orphans are not found; no move mapping/recovery state exists anywhere in the app.
  4. The convergence comment at `lib/sync.ts:110-121` (review cited 115-120) is indeed too broad: it holds for pre-parent failures (originals survive, retry re-finds them by the still-live old board id) but not for post-parent FK-patch failures.
- Result: **source-only** (confirmed).

## Check 4 — E-04 source chain (source-only)

- Expected behavior: a record must not become permanently undeletable/undisplayable after a failed import.
- Observed behavior (confirmed chain): `photos/src/lib/photo-ops.ts:144-168` — `add(...)` persists the record (149-161) *before* `putPhotoFiles` (162), whose `File.arrayBuffer()` + `FileStore.put` happen at 75. Failure lands in `uploadOneByOne`'s catch (103-106) which records only the filename — no rollback, no repair op; re-upload generates a fresh `fileId`/record (147). `PhotoCard.tsx:39-57` returns the "Unavailable" div on `!url` before any delete control (delete UI exists only in the rendered branch at 98-147), so a standalone photo in All Photos has no tile-level delete. Album-whole deletion remains available (`App.tsx:162-173` → `ops.deleteAlbum` → `deleteTree`). SDK: `js/src/sync/file-store.ts:437-478` — `put` persists via the separate awaited IndexedDB `putFile` (465) and only then queues background upload; `useFile` (`js/src/sync/react.ts:1030-1094`) returns `url: null` with status `unavailable`/`error` for absent bytes, reaching the `!url` branch.
- Result: **source-only** (confirmed).

## Check 5 — E-05 source chain + executed mechanism test

- Expected behavior: a local read-modify-write must not remove a peer todo committed between the read and the write.
- Observed behavior (source): `tasks/src/lib/todos.ts:34-76` — every op awaits `db.get` then patches the *entire* reconstructed `todos` array (47-50, 58-61, 69-72); the `TodoDb` interface (13-19) accepts no patch options, so no CRDT base can be supplied. The mutex (21-32) serializes only calls through one `createTodoOps` instance — nothing serializes against the sync engine's merges. SDK: `prepare_patch` (`crates/betterbase-db/src/storage/record_manager.rs:515-547`) shallow-overlays the supplied array onto the latest record (524-544) and delegates to `prepare_update`, whose no-base arm (421-424) diffs the *current* model against the supplied value — a peer-added todo present in the model but absent from the supplied array emits removal ops. Counterevidence re-verified: `todos` is `t.array(...)` (`tasks/src/lib/collections.ts:7-13`) and arrays diff as positional RGA nodes (`crdt/schema_aware.rs:365-370`) — the hazard is the stale full-array write, not wholesale array LWW.
- Executed: `cargo test -p betterbase-db stale_full_value_write` → `crdt::schema_aware::tests::stale_full_value_write_tombstones_unseen_peer_text ... ok (1 passed)`. This is the SDK's own pinned assertion that a full-value write computed from a stale view tombstones unseen peer content and the tombstone wins merge replay (test at `schema_aware.rs:1212-1259`, doc comment explicitly generalizes to full-value writes and prescribes base-aware patching). Qualified: the executed test's fixture is a text field; the array-specific overlay is established by source only.
- Result: **fail** (mechanism confirmed by execution; tasks-app schedule source-only — no interleaved get/patch fault injection was run).

## Check 6 — E-06 source chain (source-only)

- Expected behavior: displayed sender attribution should derive from authenticated provenance, not writable content.
- Observed behavior (confirmed chain): `chat/src/lib/collections.ts:11-19` models `senderHandle: t.string()` (14) as ordinary mutable content. `ChatView.tsx:149-163` classifies own messages by `m.senderHandle === currentHandle` (155) and picks the display name from it (156); the shield condition is `m.senderHandle !== currentHandle && m._editChainValid === true` (157-160) — it never reads `_editChain` authors. `MessageBubble.tsx:41-43` renders the green `ShieldCheck` off that prop; message text renders as a React text node (61-63; correction: review cited 65-67). `chat/src/App.tsx:201` enables `editChainCollections={[messages.name]}`. SDK: chain entries carry the *writer's* did:key author (`spaces-middleware.ts:21-28`) signed with the local session keypair (`sync-engine.ts:473-481`) and `_editChainValid` is integrity-only (`spaces-middleware.ts:40-46`) — so a write-capable member's validly-signed message naming another member's handle yields a green shield beside the spoofed handle with no forgery required. No defeating comparison between chain author and handle exists anywhere in the app.
- Result: **source-only** (confirmed).

## Check 7 — E-07 source chain (source-only)

- Expected behavior: send completion must clear only the submitted draft; retry after a partial failure must not duplicate a committed message.
- Observed behavior (confirmed): `ChatView.tsx:100-109` captures `trimmed`, then `.then(() => setText(""))` clears whatever is in the `text` state at resolution — a replacement draft typed during the pending promise is lost. Input stays enabled while pending: `TextInput` 182-197 has no pending-disable; the send `ActionIcon` (198-206) is disabled only on empty text; Enter (190-195) re-fires `handleSend`, and each send submits the still-present draft again. Second half: `chat/src/lib/sync.ts:102-117` commits the message (`db.put`, 105-109) then patches the conversation preview (110-114) with no transaction or stable submission id; on preview failure `App.tsx:117-124` reports and preserves the draft, and retry performs a fresh `db.put` with a newly auto-generated id — the first committed message is duplicated. Counterevidence holds: failure of the initial `db.put` itself preserves the draft without duplication.
- Result: **source-only** (confirmed).

## Check 8 — E-08 source chain (source-only)

- Expected behavior: the UI should distinguish "record synced" from "photo bytes uploaded".
- Observed behavior (confirmed): `photos/src/App.tsx:134-135` (review cited 133-136) derives status solely from `useSync()`/`useConnectionStatus()`; `PhotoGallery.tsx:43-55` clears the uploading indicator as soon as the local `onUpload` resolves — and `onUpload` resolves after local import, while `FileStore.put` (`file-store.ts:437-478`) persists locally (465) and starts remote upload asynchronously (`processQueue`, 473-477). The SDK exposes `useFileUploadQueue` with pending/errored/retry (`js/src/sync/react.ts:906-949`); `rg useFileUploadQueue` over `betterbase-examples` returns zero uses. So a file queue can stall/fail while status reads Synced and the local cache keeps displaying.
- Result: **source-only** (confirmed observability gap).

## Check 9 — E-09 source chain (source-only)

- Expected behavior: startup auto-creation failures should surface through the shared error UI and remain retryable.
- Observed behavior (confirmed): notes `App.tsx:83-88` sets `autoCreated.current = true` then calls `createNotebook("My Notebook")` (86) with no await/catch — `createNotebook` is async (`notes/src/lib/sync.ts:41-47`) so a storage failure is an unhandled rejection and the one-shot guard blocks retry for that mount. Board `App.tsx:205-210` does the same with `createBoard` (async, `board/src/lib/sync.ts:66-76`), which also writes the board then three columns sequentially (70-72) — partial default creation (board without all columns) is possible. Tasks counterpart catches: `tasks/src/App.tsx:130-135` (`.catch(reportError)`); the local paths also catch (tasks 37-39, board local 75).
- Result: **source-only** (confirmed).

## Check 10 — E-10 source chain (source-only)

- Expected behavior: deleting a column must not leave surviving cards unrecoverable.
- Observed behavior (confirmed): board `App.tsx:106-113` — child deletions fire individually with per-child catches (109-111) and the column delete (112) is not gated on their success. `BoardView.tsx:213-232` renders cards only inside live columns (`effectiveCards.filter(c => c.columnId === col.id)` at 214), so a card whose delete failed after its column was deleted survives in storage unrendered and unreachable. The child list also comes from render state, which can omit a just-committed card. The authenticated path uses `deleteTree` (`board/src/lib/sync.ts:103-108`); its transactional guarantees remain with SDK review, as stated.
- Result: **source-only** (confirmed).

## Aggregate

- Expected behavior: INV-01/03/04/06/08 hold for the example apps' data lifecycle, editing, sharing, import, attribution, send, status, startup, and deletion paths.
- Observed behavior: all ten findings confirmed by independent source traces with no defeating checks found; E-02's debounce mechanism additionally reproduced at runtime (5/5 assertions) and E-05's CRDT mechanism corroborated by executing the SDK's own stale-write test (passes, i.e. the hazardous semantics are current and intended).
- Exit code / assertions / skipped tests: harness exit 0 with 5/5 assertions; cargo 1 passed / 0 failed (single filtered test); no app test suites, browsers, services, or fault injections run.
- Result: **fail** for the E-02 execution and E-05 mechanism execution (secure expectations violated); **source-only** (confirmed) for E-01..E-10 chain verification.
- Seed / schedule / reproduction steps: E-02 schedule — queue A → +200 ms remote update (no call) → +250 ms keystroke C → observe single fire at +754 ms; harness `/tmp/bb-examples-audit/e02_debounce.mjs` (+ loader/stub), deterministic.
- Sanitized output or artifact links: inline above; no credentials, tokens, key material, or private data (all identifiers synthetic).
- Limits: the E-02 harness stubs React primitives — it validates the installed debounce implementation and exact call schedule, not the React editor effects, TipTap, or persistence layer; E-05's executed test uses a text-field fixture (array overlay path is source-verified; no get/patch interleaving fault injection was run); no browser-level reproductions (E-01 account switch, E-03/E-04/E-10 partial-failure recovery, E-07 duplicate send) and no SDK reconciliation of the E-01 upload-routing consequence; `last_patch_deletes_peer_spans` shows the SDK itself dev-warns on this signature — severity triage and remediation remain with the coordinator; findings refer to the pinned baselines after any future fixes.
