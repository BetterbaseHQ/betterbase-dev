# Review: examples and shared application UI

- Reviewer / assignment: examples_review; analysis only, no product changes.
- Date / baseline: 2026-09-20; examples `f8fc63bbce97b52d80ab603686212278af8318b9`; SDK `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`. Examples working tree clean when inspected.
- Status: analyzed (source review); runtime reproductions and remediation remain outstanding.
- Invariants: INV-01, INV-03, INV-04, INV-06, INV-08.
- Entry points: all seven apps' application/provider wiring; six persistent apps' database, collection, and sync modules; notes editor/workspace; tasks mutation and rendering paths; board sharing, drag/drop, card editing, and deletion; photo import/cache/display/deletion; passwords entry form/detail/generator/clipboard; chat send/render/auth; shared auth/sync shell, sharing, presence, invitation, and error components.
- Exclusions: server enforcement, crypto primitives, OPFS implementation, complete SDK shareTree/file-queue semantics, generated WASM, deployment and third-party dependency audit are other assignments. No active attacks, service mutations, browser sessions, or new tests were run. Existing app tests were read, not executed by this reviewer. This is not a certification of all third-party rendering behavior.

## Guarantees and state transitions

All persistent apps open one database named for the app at module initialization, outside authentication. Authenticated views add the SDK sync provider to that same database. Tasks, notes, photos, board, and passwords also render a local view without authentication; chat gates its UI but retains the same database across account changes. Logout destroys session/key material; it does not establish a local data ownership boundary. The shared menu calls this operation **Disconnect**, which is relevant to the intended retention policy but does not isolate account B from account A.

Writes use normal SDK record operations, with no app-level transaction spanning record creation and file persistence, parent moves and FK rewriting, or message creation and conversation preview updates. Most handlers catch failures and show a six-second toast. Password entry save waits and retains the form on error; several other inputs clear before persistence or overwrite an active draft on asynchronous completion. Connection badges describe the record sync engine, not all file upload work.

Plain strings generally render through React text nodes. Chat does not interpret Markdown/HTML. Board card colors are allowlisted. Photos render object URLs through image elements. Password links set `noopener noreferrer`; password generation uses Web Crypto rejection sampling and shuffling. Notes are the exceptional structured-content path: serialized TipTap JSON is stored in a text CRDT, parsed, and sent to TipTap.

## Evidence and candidate findings

These severities are provisional. “Confirmed” below means a complete source argument; no runtime reproduction is implied.

### E-01 — High: prior account data remains visible to another account and in unauthenticated views

**Confirmed; INV-04 / INV-08.** Preconditions: A previously used an app in this browser profile, then disconnected or B signed in to the same origin. The app should preserve any intended offline data without presenting A's private records as B's records.

Source chain:

- `betterbase-examples/passwords/src/lib/db.ts:8` opens fixed `passwords`; the other apps do the same at `tasks/src/lib/db.ts:9`, `notes/src/lib/db.ts:9`, `board/src/lib/db.ts:10`, `photos/src/lib/db.ts:9`, `chat/src/lib/db.ts:9`.
- `passwords/src/App.tsx:13-27` queries all entries and exposes mutation operations without auth; `106-125` selects that view after logout, reusing the same `db`.
- `passwords/src/components/EntryDetail.tsx:149-173` presents the persisted password through reveal/copy controls without a lock. Other local fallbacks likewise query their complete collections (`tasks/src/App.tsx:26-32`, `notes/src/App.tsx:14-18`, `photos/src/App.tsx:34-52`, `board/src/App.tsx:32-60`).
- All authenticated domain hooks query without an explicit allowed-space filter, for example `passwords/src/lib/sync.ts:21-29` and `chat/src/lib/sync.ts:28-44`.
- `betterbase/js/src/sync/spaces-middleware.ts:138-149` returns no filter unless a space option is supplied; `betterbase/js/src/db/middleware/typed-adapter.ts:227-257` then delivers all underlying records. Middleware enrichment is not an account filter.
- `betterbase/js/src/auth/react.ts:65-76` clears the session immediately; `auth/session.ts:390-414` clears auth storage and keys, not application records.

Actual result: B can see A's previously decrypted records without possessing A's keys; five apps expose the records before B signs in. Chat's per-handle selected-conversation key (`chat/src/App.tsx:67-73`) protects selection metadata only; its query still includes A's conversations. No remote cryptographic break or OS attacker is necessary. This report does **not** assert that A's records are automatically uploaded to B: that separate routing consequence needs SDK reconciliation.

Counterevidence / policy: `shared/src/layout/UserArea.tsx:117-118` says “Disconnect,” and offline-first operation intentionally preserves local data. That can explain retention, but there is no independent lock/account partition. Define local-retention semantics and separate anonymous/local work from authenticated namespaces; do not solve it by indiscriminately deleting unsynced data. Regression: A → disconnect → B in the same browser, including password reveal, chat selection, restart, and unsynced records.

### E-02 — High: a peer update can erase unsaved note text before it reaches the database

**Confirmed; INV-03 / INV-08.** `betterbase-examples/notes/src/components/NoteEditor.tsx:45-60` queues body/title persistence for 500/300 ms. The peer-update effects overwrite local title (`64-73`) and the editor body (`94-104`) immediately. The next keystroke replaces the queued arguments (`83-88`, `106-108`). The installed Mantine callback implementation also confirms that each call clears the old timer and replaces its closure (`notes/node_modules/@mantine/hooks/esm/use-debounced-callback/use-debounced-callback.mjs:13-24`; dependency evidence only, not a tracked source revision).

Failure schedule: type edit A, receive remote version B before the timer fires, then type edit C into the newly reset editor before the original timer fires. Only B+C is saved; A was never persisted and its pending callback was replaced. Capturing a CRDT base protects committed edits during merging but cannot recover the discarded application draft. Title has the same failure mechanism and does not depend on TipTap event details.

Counterevidence: stopping typing after the remote update can allow the old pending save to run; note-switch/unmount flush and the delete-flush regression tests cover other schedules. They do not cover this one. Preserve/rebase the pending local draft before replacing editor state, and test a peer update in the debounce window followed by another keystroke.

### E-03 — High: interrupted board sharing leaves children permanently disconnected from the moved board

**Confirmed; INV-03 / INV-06.** `betterbase-examples/board/src/lib/sync.ts:127-159` creates a space, moves columns/cards, then moves the board and separately patches every child's `boardId` with `Promise.all`. `betterbase/js/src/sync/move-to-space.ts:90-108` creates a new ID and tombstones the old parent before returning.

If any FK patch at `board/src/lib/sync.ts:157-158` fails after the parent move succeeds, that child still refers to the tombstoned old board ID. App rendering filters children by the selected live board ID (`board/src/App.tsx:218-225`), so these records disappear from the board. No persistent move mapping, recovery state, or retry of FK rewrites is retained. Re-running against the old ID cannot move a tombstone; sharing the new board will query children by its new ID and omit the orphaned records. The comment at `lib/sync.ts:115-120` claiming all intermediate failures converge on retry is therefore too broad.

Counterevidence: children-first order does preserve the parent until line 152, improving some earlier failures; data rows can still exist and may be manually repaired. Additional pre-parent failures can also leave card `columnId` links stale because columns are moved before cards. Use one transaction where possible or a durable, resumable move mapping. Regression: fail each phase, including one FK rewrite, reload, and recover all columns/cards without losing IDs needed for reconciliation. Reconcile common move/share helpers with SDK review.

### E-04 — Medium: failed photo byte persistence leaves an undeletable unavailable tile

**Confirmed; INV-01 / INV-06 / INV-08.** `betterbase-examples/photos/src/lib/photo-ops.ts:147-163` persists the photo record before `File.arrayBuffer()` and the full blob's `FileStore.put` (`75`). Quota failure, read failure, or interruption in between leaves a live record pointing to absent bytes. The catch at `103-106` records only a filename; it neither rolls back nor retains a repair operation. Re-upload generates new IDs rather than completing the existing record.

`photos/src/components/PhotoCard.tsx:39-56` returns an “Unavailable” div before rendering the delete controls. A standalone photo in All Photos therefore cannot be deleted through its tile after this failure. An album can still be deleted as a whole. `betterbase/js/src/sync/file-store.ts:437-465` confirms full-file persistence is a separate awaited IndexedDB operation after record creation.

Counterevidence: upload failure does produce a toast, and a thumbnail generation failure intentionally falls back to the full file. Those do not repair a missing full file. Persist a recoverable import state or compensate for record creation, and keep delete/retry controls available for unavailable files. Regression: fail full-file persistence after record creation and verify reload, retry, and deletion.

### E-05 — High: task read/modify/write can overwrite an intervening sync update

**Confirmed source schedule; INV-03.** `betterbase-examples/tasks/src/lib/todos.ts:34-72` serializes only calls through one `createTodoOps` instance. Each operation awaits `db.get`, then submits an entire reconstructed `todos` array in a separate `db.patch`, without the read's CRDT base.

An incoming sync update can commit between that read and patch. For example, the read sees todo X incomplete, sync adds todo Y, and the later toggle submits only completed X. The patch overlays that array on the latest stored record (`betterbase/crates/betterbase-db/src/storage/record_manager.rs:515-546`), and no-base updates diff the current model against the supplied value (`332-423`). Consequently Y is removed as part of the local patch. A mutex around app handlers does not serialize them with the sync engine.

Counterevidence: rapid same-instance local edits are serialized; arrays use recursive/positional CRDT nodes (`crdt/schema_aware.rs:365-370`), **not** wholesale LWW arrays. This finding concerns a stale full-array write diffed against a newer local model, not a claim that all independent array edits necessarily lose data. Capture record/base atomically or use transactional semantic todo mutations. Regression: deliver a peer update precisely between get and patch. Coordinate with the local-data reviewer on the same class in SDK consumers.

### E-06 — Medium: chat display attribution trusts a writable sender handle

**Confirmed application trust mismatch; INV-04.** `betterbase-examples/chat/src/lib/collections.ts:11-19` models `senderHandle` as ordinary mutable content. `chat/src/components/ChatView.tsx:149-160` uses it both to choose the displayed author and to classify “own” messages; it does not resolve a cryptographic author to a member identity. A write-capable conversation member can therefore submit a message record naming another member, and the UI presents that identity as the sender.

The green shield additionally checks only `_editChainValid`, not whether the signed author owns the displayed handle. `betterbase/js/src/sync/spaces-middleware.ts:28-45` explicitly distinguishes chain author DID and integrity validity. The current `chat/src/App.tsx:201` provider enables `editChainCollections={[messages.name]}`. Consequently a valid signature by one authorized member can result in a green shield beside a different member's content-supplied handle: the cryptographic signature itself need not be forged. The client verifies chain integrity but does not bind display attribution to the chain author.

React escapes message text (`chat/src/components/MessageBubble.tsx:65-67`); this is not an HTML injection finding. Bind sender identity to authenticated provenance and define whether messages may be edited by other members. Regression should validate attribution from actual authorized author metadata, including an inconsistent content handle.

### E-07 — Medium: chat send completion can clear a newer draft; preview failure makes retry duplicate a sent message

**Confirmed; INV-03 / INV-08.** `betterbase-examples/chat/src/components/ChatView.tsx:100-108` captures text, starts a promise, and unconditionally clears the current draft on resolution. The input remains enabled and Enter/send can be repeated while the promise is pending (`182-205`). Typing a replacement draft before completion loses that draft, and repeated sends can create duplicate messages.

Separately, `chat/src/lib/sync.ts:102-114` commits a new message and then patches the conversation preview. If the second operation fails, `chat/src/App.tsx:117-123` reports send failure and preserves the draft; retry performs another `db.put` with a new message ID although the first message was committed. There is no stable submission ID or record transaction spanning these writes.

Counterevidence: a failure of the initial message write preserves the draft as intended. Serialize submissions, clear only the submitted draft generation, and make preview maintenance independent/recoverable or transactional. Regression: hold a send promise while editing, repeated Enter, and fail preview update after message commit.

### E-08 — Medium: photo upload failures are omitted from the sync status UI

**Confirmed observability gap; INV-08.** `betterbase-examples/photos/src/App.tsx:133-136` gets status solely from `useSync` / `useConnectionStatus`; `photos/src/components/PhotoGallery.tsx:43-55` stops its uploading indicator once local `onUpload` completes. `betterbase/js/src/sync/file-store.ts:430-478` makes clear that put persists locally and starts remote upload asynchronously. The SDK separately exposes `useFileUploadQueue` with errors/retry (`sync/react.ts:906-935`), but no examples source uses it.

After successful local import, a file queue can remain pending or fail while the normal record-sync status reports Synced. Cached images continue to display on the originating device. There is no app queue/error/retry display distinguishing “record synced” from “photo bytes uploaded.” This is an app-level evidence gap about completeness of the status, not a claim that every file failure is permanently discarded by the SDK. Reconcile SDK error forwarding with the sync reviewer; test remote upload failure with local cache intact.

### E-09 — Low: default notebook/board creation failures bypass the shared error UI

**Confirmed; INV-08.** `betterbase-examples/notes/src/App.tsx:83-88` and `board/src/App.tsx:205-210` set their one-shot `autoCreated` flag and call an async create without awaiting or catching it. A local storage failure yields an unhandled rejection and the one-shot guard prevents retry in that mount. This differs from tasks, whose matching path catches and reports the failure (`tasks/src/App.tsx:130-135`). Board creation also performs sequential board/column writes (`board/src/lib/sync.ts:68-77`), so partial default creation can leave a board without all default columns. Catch/report startup mutations and define retry/partial creation behavior. No claim that all app mutation errors are hidden.

### E-10 — Medium: local column deletion can hide surviving cards after partial failure

**Confirmed; INV-06.** `betterbase-examples/board/src/App.tsx:106-112` starts deletion of each rendered child and independently deletes the column; child failures are caught individually and do not prevent parent deletion. If one child fails and the column succeeds, the card remains in storage but no column renders it (`board/src/components/BoardView.tsx:211-217`). The child snapshot can also omit a newly committed card. The authenticated counterpart uses `deleteTree` (`board/src/lib/sync.ts:102-106`); its transactional guarantees belong to SDK review. Reuse a defined cascade operation and test one child failure without losing the ability to recover/delete the surviving card.

## Checks executed

- Read repository/audit guidance, source, targeted existing tests, and installed Mantine debounce source. Searched production source for raw HTML/script evaluation, URL/image sinks, ignored asynchronous errors, file-queue UI, database naming, and provider cleanup.
- Verified examples HEAD and clean working tree. Product code was not changed.
- No runtime suites, attack payloads, fault-injection runs, network requests, or database/container operations executed. Coordinator owns baseline execution; do not count the source schedules above as passing regression tests.
- Existing tests cover provider collection registration, normal local CRUD, quick note switching/deletion, password generation/clipboard behavior, photo thumbnail success/deleted-record handling, and a chat scroll regression. Those are useful counterevidence for their exact cases; they do not establish account isolation, interrupted multi-record recovery, active-editor peer merge, or file queue visibility.

## Architecture and cross-component handoffs

1. **Account boundary:** application DB lifecycle is outside auth lifecycle. A reusable per-account database/session owner should define anonymous adoption, disconnect, logout/lock, unsynced edits, and cache retention together. SDK query enrichment cannot substitute for ownership isolation. Reconcile E-01 with SDK auth teardown and active-space discovery.
2. **Draft ownership:** notes, cards, and passwords use atomic record/base hooks in some places, but local draft lifetime differs per component. Commit acknowledgement, active editing, peer update, and failed save should have one explicit contract. Merely exposing a toast does not preserve a cleared draft.
3. **Resumable workflows:** share/move and file import are multi-stage writes with no app recovery log. E-03/E-04 need an owner for unfinished work that survives reload. Notes/photos pass child IDs from render refs into `shareTree`; whether that can miss newly arriving children should be covered alongside the SDK's tree-discovery policy.
4. **File status and cleanup:** photo full-file and thumbnail persistence, remote queue completion, record sync, and cache eviction are distinct events. `photo-ops.ts:179` uses `forEach(fileStore.evict)` without awaiting the promises, so cache-eviction rejection bypasses its catch; record deletion alone should not be represented as verified byte cleanup. A nearby comment says peer caches linger, while declared `fileFields` and later comments say tombstones evict them; synchronize those claims after SDK review.
5. **Rendering:** no production `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` sink was found. This narrows the direct app XSS surface, but is not a complete dependency audit. Notes JSON parsing validates syntax only; syntactically valid but invalid TipTap documents and large/deep input remain resilience tests, not a confirmed exploit.
6. **Launchpad:** inspected auth-only wiring, hardcoded localhost links, and shared shell. No persistent domain data or import/export flow exists there. The header still calls an authenticated auth-only launchpad “Encrypted” and defaults its status to Synced; this is misleading display copy, not evidence of plaintext remote storage. Deployment behavior of hardcoded origins is a separate review.

## Remaining work

- Runtime regressions for all confirmed source schedules, beginning with E-01/E-02/E-03/E-05; coordinator-run normal checks alone will not establish them.
- Define whether disconnect deliberately retains an unlocked device-wide dataset, and whether cross-account isolation is a launch guarantee. Password vault language should accurately state local protection.
- Validate rich-text concurrent *structural* editing: `notes/src/lib/collections.ts:14` stores JSON as `t.text()`, and `NoteEditor.tsx:244-261` itself acknowledges character merges can produce invalid JSON. The fallback displays raw JSON as text, preserving bytes but not valid rich-text structure. This is a known representation limitation pending a deterministic supported-workflow reproduction, distinct from E-02's lost draft.
- Cross-check file rehoming when photos/albums move spaces, tombstone eviction during an in-flight put, and remote upload error propagation against SDK/sync review. This report establishes the app-side import and status gaps, not all service-side file semantics.
- Review account-switch teardown with operations still in flight and startup auth restoration while local UI is already mounted. The basic disclosure is established in E-01; timing-specific mutations are additional follow-up.
- No fixes are authorized within this analysis report. The complete audit and coordinator reconciliation precede remediation.
