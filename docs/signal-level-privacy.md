# Signal-Level Privacy for Betterbase

This document defines what Signal-level privacy means for an encrypted sync
platform and proposes concrete changes to achieve it. It is organized into
tiers — quick wins through research-grade — so we can ship improvements
incrementally without blocking on the hardest problems.

## Signal's Privacy Properties

Signal's design philosophy: **the server should learn as little as possible,
even under compulsion.** The key properties:

| Property | What it means |
|---|---|
| **Sealed sender** | Server delivers messages without knowing who sent them |
| **No persistent social graph** | Server does not store contact lists or group membership |
| **Minimal metadata retention** | Server stores only what is needed to deliver, then deletes |
| **Forward secrecy** | Compromising today's keys cannot decrypt yesterday's data |
| **Post-compromise security** | New key agreement heals the channel after a key compromise |
| **Private groups** | Group membership hidden from server via anonymous credentials |
| **Private contact discovery** | Server cannot learn who you look up (SGX-based PIR) |
| **Encrypted profiles** | Names, avatars stored encrypted; server sees nothing |

## Where Betterbase Stands Today

### What we do well

- **Zero-knowledge blob storage.** Server stores encrypted blobs, never
  decrypts. Collection names, field names, record content — all inside the
  encrypted envelope. This is equivalent to Signal's message encryption.

- **No server-side encryption keys.** The scoped key is derived client-side
  from the OPAQUE export key via HKDF. The server never sees it. Key delivery
  uses JWE encrypted to a client ephemeral key. This matches Signal's approach
  of keeping key material off the server.

- **OPAQUE password auth.** The server never sees the password. This is
  stronger than Signal's PIN-based SVR approach.

- **No persistent membership table.** UCAN delegation chains are presented
  per-request, not stored. This is better than most collaboration platforms.

### What the server currently knows

Assessed by tracing every database column and wire format field across
betterbase-accounts and betterbase-sync. Updated February 2026 to reflect Phase 1+2
privacy changes.

**betterbase-accounts:**
- Username, email, account ID
- Which OAuth clients a user has authorized (oauth_grants)
- App P-256 public key per grant (for DID computation)
- Mailbox ID per grant (HKDF-derived, used for invitation routing)
- Grant last-used timestamps

**betterbase-sync — stored permanently:**
- Space IDs (deterministic from issuer + userID + clientID)
- Record IDs (UUIDv4 — random, no timestamp)
- `records.blob` — encrypted (opaque)
- `records.sequence` — ordering
- Blob hashes and sizes (blobs table)
- Invitation mailbox IDs (opaque routing keys, not plaintext identity)
- Encrypted invitation payloads (opaque JWE)
- Revocations (space_id, ucan_cid) — no revoked_by or timestamp
- Encrypted membership log entries (opaque, hash-chained)

**Removed (Phase 1+2):**
- ~~`records.writer`~~ — dropped, server no longer knows who authored records
- ~~`records.created_at` / `updated_at`~~ — dropped, no per-record timestamps
- ~~`files.created_at`~~ — dropped
- ~~`members.created_at`~~ — dropped
- ~~`revocations.revoked_by` / `revoked_at`~~ — dropped
- ~~Invitation sender/recipient identity~~ — replaced with opaque mailbox IDs
- ~~`user_id` in request logs~~ — removed from logging

**betterbase-sync — seen transiently per-request:**
- Full UCAN delegation chain (iss/aud did:keys at every level) — mitigated by space session tokens (validated once, then opaque token used)
- JWT claims (sub, client_id, iss, scope, personal_space_id, mailbox_id)
- HTTP metadata (IP, timing, request size)

**betterbase-sync — broadcast via WebSocket:**
- Space IDs, record IDs, sequence numbers (plaintext framing)
- Encrypted blobs (opaque)
- Invitation notifications routed by mailbox_id (with 1-5s random delay for timing mitigation)

---

## Tier 1: Quick Wins (days of work)

Changes that remove metadata the server stores but never uses.

### 1.1 Remove `records.writer`

**Current state:** Every push stores `issuer:userID` in the writer column.
This is write-only — no server query ever reads it back.

**Change:** Drop the column, remove the parameter from `Push()`, remove the
`writer` assignment in `handlePush()`.

**Effect:** Server no longer knows who authored individual records. If clients
need write attribution, embed it inside the encrypted BlobEnvelope (the CRDT
session ID can already serve as a pseudonymous author identifier client-side).

**Signal equivalent:** Signal does not store sender identity on messages after
delivery.

### 1.2 Remove `records.created_at` / `updated_at`

**Current state:** Timestamp columns with an auto-update trigger. Never used
in any server query — `sequence` provides all the ordering the server needs.

**Change:** Drop both columns and the `records_updated_at` trigger.

**Effect:** The server no longer stores explicit per-record timestamps. It
still knows *approximately* when records were pushed (it processed the request
in real time), but this is transient knowledge, not stored and queryable.

### 1.3 Remove sender identity from invitations

**Current state:** `invitations` table stores `sender_issuer` and
`sender_user_id` in plaintext, plus an index for sender lookups.

**Change:** Move sender identity into the encrypted `payload` field. Drop
the `sender_issuer`, `sender_user_id` columns and `idx_invitations_sender`
index. If senders need to list their pending invitations, that's a client-side
concern (track locally).

**Effect:** Server knows *someone* invited a recipient, but not who. The
sender identity is only revealed to the recipient upon decrypting the payload.

### 1.4 Redact UCAN details from error logs

**Current state:** UCAN validation errors include did:key values in the error
message, which gets logged via `slog`.

**Change:** Log a generic error code (e.g., "ucan_validation_failed") with
the space ID, but redact iss/aud did:keys from logged messages.

**Effect:** Server operator logs no longer contain the delegation graph, even
on validation failures.

---

## Tier 2: Moderate Effort (weeks of work)

Changes that meaningfully reduce what the server can learn, requiring protocol
or schema changes.

### 2.1 Hash recipient identity in invitations

**Current state:** `recipient_issuer` and `recipient_user_id` stored in
plaintext for inbox queries.

**Change:** Store `SHA-256(recipient_issuer || "\0" || recipient_user_id)`
instead. Clients query their inbox by computing and sending their own hash.
Add a salt per-server instance to make rainbow tables impractical.

**Effect:** The invitation table no longer contains plaintext recipient
identities. An attacker with database access would need to enumerate the
user population to reverse the hashes. Combined with Tier 1.3, the server
sees neither sender nor recipient identity in the invitations table.

**Tradeoff:** If the user population is small, the hash is reversible by
enumeration. For larger populations, this is a meaningful improvement.

### 2.2 Opaque space session tokens

**Current state:** Every request to a shared space carries the full UCAN
delegation chain in the `X-UCAN` header. The server parses and validates
the entire chain on every request, seeing all iss/aud did:keys each time.

**Change:** On first access (or WebSocket connection), validate the UCAN chain
and issue a short-lived opaque session token (e.g., 15-minute HMAC token)
scoped to `(space_id, permission, expiry)`. Subsequent requests present
the session token instead of the UCAN. The session token reveals nothing
about the delegation chain.

**Effect:** The server sees the full delegation chain once per session
(~15 minutes), not on every request. The delegation graph exposure window
shrinks from "every API call" to "session establishment."

**Tradeoff:** Adds server-side session state (a signed token or small
cache). The UCAN still needs to be presented periodically for renewal.

### 2.3 Add AAD (Additional Authenticated Data) to AES-GCM

**Current state:** `SyncCrypto.encrypt()` uses AES-256-GCM with no AAD.
Encrypted blobs are not bound to their context.

**Change:** Version-bump the wire format to v2. Include
`space_id || record_id` as AAD. The server already knows both values (they're
in the URL/request), so this leaks nothing new, but it prevents ciphertext
relocation attacks — a malicious server cannot move an encrypted record from
one space/ID to another without detection.

**Effect:** Cryptographic binding of ciphertexts to their context. Important
for a multiplayer system where a compromised server could try to swap records
between users or spaces.

### 2.4 Pad encrypted blobs

**Current state:** Blob sizes are visible to the server (stored in the
`blobs` table and observable from `records.blob` column length). Size is a
powerful side channel — the server can distinguish a short todo from a long
document.

**Change:** Pad all encrypted blobs to fixed size buckets before encryption.
Example buckets: 256B, 1KB, 4KB, 16KB, 64KB, 256KB, 1MB. Each blob is
padded to the next bucket boundary. The padding is inside the encryption
envelope (added before encrypt, stripped after decrypt).

**Effect:** Server sees coarse size buckets instead of exact sizes. A 10-byte
todo and a 200-byte todo both produce 256B encrypted blobs.

**Tradeoff:** Storage overhead (average ~50% waste). Bandwidth overhead on
sync. Configurable bucket sizes let apps choose their tradeoff.

**Signal equivalent:** Signal pads messages to hide exact length.

---

## Tier 3: Significant Effort (months of work)

Architectural changes that approach true metadata privacy.

### 3.1 Sealed push (hide pusher identity from sync observers)

**Current state:** When user A pushes to a shared space, the server
broadcasts a SyncData event to all subscribers. The server knows it was
user A who pushed (from the JWT). Other users learn the record content
after decryption, but the server knows the write timing per-user.

**Change:** Separate the push endpoint from the push identity:

1. Client pushes via a **mix-style relay**: the push is encrypted to the
   sync server's public key, routed through an intermediary (or delayed
   and batched), so the sync server cannot correlate the push with a
   specific network connection.

2. Simpler alternative: **batch all pushes through a single server-side
   queue** with a short random delay (100-500ms jitter). The server still
   knows a push happened for a space, but cannot trivially correlate it
   with a specific concurrent connection.

**Effect:** Makes it harder for the server to attribute specific pushes to
specific users based on network timing.

**Signal equivalent:** Sealed sender encrypts the sender identity inside the
message envelope. The server delivers without knowing who sent it.

**Tradeoff:** Adds latency. The simpler jitter approach is much easier to
implement but only provides weak protection against a motivated server
operator.

### 3.2 Private group membership via anonymous credentials

**Current state:** UCAN delegation chains reveal the full delegation graph
to the server during validation. The server sees who delegated to whom.

**Change:** Replace UCAN validation with a **BBS+ anonymous credential**
scheme:

1. The space admin issues a BBS+ credential to each member, signing over
   `(space_id, permission, member_public_key)`.

2. When a member accesses the space, they present a **zero-knowledge proof**
   derived from their credential. The proof convinces the server that:
   - The member holds a valid credential for this space
   - The credential grants sufficient permission (read/write/admin)
   - The credential was signed by the space's root key
   - The credential has not been revoked

   ...without revealing *which* member they are or *who delegated to them*.

3. Revocation uses an **accumulator** (e.g., dynamic RSA accumulator or
   Merkle-based). The server publishes a revocation accumulator state; the
   client proves non-membership in the revoked set as part of their ZKP.

**Effect:** The server cannot distinguish between members of a shared space.
It knows "someone with valid access is pushing/pulling," but not who. The
delegation graph is completely hidden.

**Signal equivalent:** Signal's private groups use anonymous credentials
(based on the Keyed-Verification Anonymous Credentials construction) so the
server cannot see group membership.

**Tradeoff:** BBS+ is a newer primitive. The `@mattrglobal/bbs-signatures`
library exists but the ecosystem is less mature than ECDSA/EdDSA. Performance
is acceptable (proof generation ~5ms, verification ~10ms). The main cost is
protocol complexity — credential issuance, revocation accumulator management,
and the ZKP circuit for "valid credential + not revoked + sufficient
permission."

**Migration path:** BBS+ can coexist with UCANs during a transition period.
Shared spaces could opt into the anonymous credential scheme while personal
spaces (which don't need it) continue with JWT-only auth.

### 3.3 Oblivious space access (hide which space is being accessed)

**Current state:** Every API request includes the space ID in the URL path.
The server knows exactly which spaces each user accesses and when.

**Change:** Use **Oblivious HTTP (OHTTP)** or a similar relay architecture:

1. Client encrypts the request (including the space ID) to the sync
   server's public key.
2. Client sends the encrypted request through a relay that strips the
   client's IP and network identity.
3. Sync server decrypts and processes the request, returning the encrypted
   response through the relay.

The relay sees the client's IP but not the request content. The sync server
sees the request content but not the client's IP. Neither party sees both.

**Effect:** The sync server processes space operations without knowing which
network client is making the request. Combined with BBS+ credentials (3.2),
the server knows "someone with valid access is operating on space X" but
cannot link it to a network identity.

**Signal equivalent:** Signal uses Intel SGX enclaves for private contact
discovery, achieving a similar separation. OHTTP (RFC 9458) is the
standardized non-hardware approach.

**Tradeoff:** Requires operating (or trusting) a relay. Adds one network
hop of latency. WebSocket long-polling through a relay is architecturally complex.

### 3.4 Forward secrecy for sync keys

**Current state:** The scoped sync key is deterministically derived from the
OPAQUE export key via HKDF. The same password always produces the same key.
If an attacker captures encrypted blobs and later obtains the password, they
can derive the key and decrypt all historical data.

**Change:** Implement a **ratcheting key scheme**:

1. The initial key is derived from OPAQUE export key (as today).
2. After each sync epoch (e.g., daily, or every N pushes), the client
   derives a new key: `key_{n+1} = HKDF(key_n, "less:ratchet:v1")`.
3. The old key is securely deleted. The client stores only the current key
   and the epoch counter.
4. Each encrypted blob is tagged with its epoch number (inside the
   encryption envelope, or as a version field).
5. On pull, the client can re-derive forward from any stored checkpoint
   but cannot go backward.

**Effect:** Compromising the current key does not reveal data encrypted under
previous epoch keys (forward secrecy). An attacker who captures the database
at time T and later obtains the password can only decrypt data from time T
onward, not historical data.

**Signal equivalent:** Signal's Double Ratchet provides per-message forward
secrecy. A per-epoch ratchet is coarser but practical for a sync system
where the same data may be re-synced.

**Tradeoff:** Key ratcheting means a new device must sync from the current
epoch — it cannot decrypt historical blobs without the checkpoint chain.
Recovery becomes more complex (the recovery blob must include ratchet state).
Multi-device requires key synchronization between devices.

For shared spaces this is even more complex — all members must advance
through epochs together, requiring a group key agreement protocol.

---

## Tier 4: Aspirational (research-grade)

Properties that would make Betterbase's privacy exceed Signal's in some
dimensions, but require novel protocol design.

### 4.1 Private information retrieval (PIR) for pulls

**Problem:** When a client pulls from a space, the server knows which space
and which sequence range. Over time, the server builds a detailed access
pattern for each user.

**Approach:** Use computational PIR to let clients fetch records without the
server knowing which records were requested. The client queries a PIR scheme
over the records table; the server computes over all records and returns an
encrypted result that only the querier can decrypt.

**Reality check:** PIR is expensive. Current schemes (e.g., SealPIR) require
the server to touch every record in the database per query. For a sync
system with millions of records, this is impractical today. Approximate
schemes and hardware-accelerated PIR are active research areas.

### 4.2 Metadata-hiding push via DC-nets or mixnets

**Problem:** Even with sealed sender, the server sees *that* a push happened
to a space at a specific time, which reveals activity patterns.

**Approach:** Dining Cryptographers networks (DC-nets) or mix networks can
hide not just who pushed, but whether a push happened at all, by having all
clients constantly send cover traffic.

**Reality check:** Extremely high bandwidth overhead. Practical only for
small, high-security deployments.

---

## Recommended Implementation Order

For a team that wants to move toward Signal-level privacy incrementally:

**Done:**
1. ~~Remove `records.writer` (Tier 1.1)~~ ✓
2. ~~Remove `records.created_at` / `updated_at` (Tier 1.2)~~ ✓
3. ~~Remove sender identity from invitations (Tier 1.3)~~ ✓ replaced with mailbox_id scheme
4. Redact UCAN details from logs (Tier 1.4)
5. ~~Hash recipient identity in invitations (Tier 2.1)~~ ✓ surpassed with HKDF-derived mailbox IDs
6. ~~Opaque space session tokens for UCAN (Tier 2.2)~~ ✓
7. ~~Add AAD to AES-GCM encryption (Tier 2.3)~~ ✓ membership log uses AAD = (spaceId, seq)
8. Blob size padding (Tier 2.4)

**Next:**
9. BBS+ anonymous credentials for shared spaces (Tier 3.2)
10. Forward secrecy via key ratcheting (Tier 3.4)

**When ready:**
11. Sealed push (Tier 3.1)
12. OHTTP relay architecture (Tier 3.3)

---

## What Signal-Level Means for a Sync Platform

Signal is a messaging app. Less is a sync platform. The threat models
differ in important ways:

| Dimension | Signal | Betterbase |
|---|---|---|
| Data lifetime | Messages are ephemeral (disappearing messages) | Sync data is persistent (user expects it to survive) |
| Access pattern | Point-to-point or small groups | Continuous sync with push/pull/WS |
| Recovery | Phone number + PIN | Password + BIP39 mnemonic |
| Multi-device | Linked devices protocol | Deterministic key derivation |
| Group size | Typically < 1000 | Potentially unbounded (shared workspaces) |

The persistent nature of sync data makes forward secrecy harder (you can't
delete keys if the user might need to re-sync old data on a new device).
The continuous access pattern makes traffic analysis harder to prevent than
for discrete messages.

**The honest assessment:** Tiers 1-2 bring Betterbase to a level of
metadata privacy that exceeds most commercial sync platforms (iCloud,
Dropbox, Notion, etc.) and approaches Signal for the stored-data threat
model. Tier 3 (BBS+ credentials, forward secrecy) would match Signal's
privacy properties for the group-membership and key-compromise threat models.
Tier 4 addresses threat models that even Signal does not fully address today.

The most impactful single change is Tier 3.2 (BBS+ anonymous credentials),
because it eliminates the server's ability to observe the social graph of
shared spaces — the primary metadata exposure that distinguishes Less from
Signal's privacy model today.
