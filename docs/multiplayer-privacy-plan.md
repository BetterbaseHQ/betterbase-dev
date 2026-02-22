# Multiplayer Privacy Implementation Plan

**Status:** Phase 1, 2, 2.5, 3+4, 5 Complete
**Date:** 2026-02-12

---

## Who This Is For

Betterbase is designed for **consumer productivity applications** that handle private data:

- **Notes apps** (personal knowledge bases, journals)
- **Todo/task managers** (project planning, GTD systems)
- **Bookmarks/read-later** (personal libraries, research collections)
- **Password managers** (credentials, secure notes)
- **Email clients** (personal communication)
- **Messaging apps** (chat, collaboration)
- **Other productivity tools** (calendars, habit trackers, financial apps)

These apps typically use cloud sync for convenience across devices. Today, most store data in plaintext on servers operated by large tech companies. Users accept this trade-off because:

1. **Multi-device sync** — seamless access from phone, tablet, desktop
2. **Collaboration** — sharing with family, teams, friends
3. **Zero-friction onboarding** — no complicated setup
4. **Real-time updates** — changes appear instantly everywhere

**Betterbase's goal:** Provide the same convenience and developer experience, but with true end-to-end encryption and privacy by default. Developers should be able to build these apps as easily as they build against Firebase or Supabase, but users get strong metadata privacy — sealed-sender-equivalent for invitations, pseudonymous access for sync operations, and zero-knowledge blob storage.

## Design Principles

### 1. Proven Patterns Over Novel Cryptography

We use battle-tested constructions from production systems:
- **Signal's sealed sender** for anonymous invitations
- **OPAQUE** for password authentication (IETF RFC 9497)
- **UCAN** for capability-based authorization
- **Envelope encryption** (per-record DEKs + KEK wrapping)
- **HKDF ratcheting** for forward secrecy
- **Standard Web Crypto API** primitives (P-256 ECDH, AES-GCM, HKDF, HMAC)

**Why:** Established patterns have been vetted by cryptographers, implemented in multiple libraries, and stress-tested in production at scale. Novel cryptography is exciting but risky — we only use it when existing patterns don't solve the problem.

### 2. Privacy as a Side Effect of Good Architecture

The best privacy guarantees come from **not collecting data in the first place**, not from securing collected data.

- Server doesn't need to know who sent an invitation → **don't send plaintext identity**
- Server doesn't need to know which specific user is pushing to a shared space → **use opaque session tokens**
- Server doesn't need timestamps on metadata tables → **don't store them**

**Why:** Data you don't collect can't leak. Data you don't log can't be subpoenaed. Architecture that minimizes server knowledge is inherently more private than architecture that collects everything and tries to secure it.

### 3. Privacy Against the Server Operator

**Assumption:** Most users will use hosted services (accounts + sync operated by the same organization), not self-hosted infrastructure.

**Therefore:** The server operator is **honest-but-curious**. The server:
- Runs the correct code (not actively malicious)
- Provides the service reliably
- But wants to learn as little as possible about user behavior

Our privacy goal is to minimize what the server operator can learn through **normal operation** of the system. We separate accounts and sync architecturally so that:

```
Accounts Server              Sync Server
(knows: identities)          (knows: encrypted blobs, access patterns)
       │                            │
       └──── Same Operator ─────────┘
              BUT
       Separate databases, separate processes
       → Forces explicit choice about what to correlate
```

**Why this matters:**

1. **Legal compliance** — Data that isn't collected can't be subpoenaed. Server logs that don't contain user identity can't identify users.

2. **Breach mitigation** — If the sync database leaks, it contains opaque mailbox IDs and encrypted blobs, not a social graph.

3. **Trust minimization** — Even if you trust the operator today, minimizing server knowledge means less risk from:
   - Operator acquisition/change of control
   - Insider threats (rogue employees)
   - Legal compulsion (government data requests)
   - Future policy changes

4. **Federation-ready** — While most deployments will have accounts + sync under one operator, the architecture supports scenarios where they're separate:
   - University provides identity, user chooses sync provider
   - Enterprise SSO for auth, third-party for data storage
   - User migrates data between providers without changing identity

The key principle: **the server should only learn what's necessary to perform its function**, even if the operator is trustworthy.

### 4. Multiplayer Built on Solid Foundations

Multiplayer is the hardest part to get right. We're auditing multiplayer privacy now because:

- **Single-user sync already works** and is truly E2EE
- **Multiplayer introduces metadata** (who's collaborating with whom, when, how often)
- **Getting the fundamentals right** ensures excellent multiplayer privacy

If the foundation has privacy leaks (e.g., server learns who is in each space), no amount of fancy crypto on top will fix it. This audit ensures the architecture is sound before we build more on top.

---

## Executive Summary

The Betterbase has strong foundational privacy properties (zero-knowledge blob storage, OPAQUE auth, no server-side encryption keys). However, the multiplayer features currently expose more metadata than necessary during normal operation.

**Key Finding:** The sync server learns which users are collaborating in which spaces, even though it only needs to know "a valid member is accessing space X."

This document proposes concrete changes to achieve sealed-sender-equivalent privacy for invitations and pseudonymous sync operations, organized into three phases:

- **Phase 1 (days):** Remove unnecessary metadata from storage
- **Phase 2 (weeks):** Blind the server to user identity during operations
- **Phase 2.5 (days):** Encrypt members log to eliminate delegation graph leakage

---

## Current State Assessment

### What's Already Good

✅ **Records table has no writer column** — the schema is `(id, space_id, blob, sequence)` only
✅ **No timestamp columns on records** — removed early in development
✅ **UCAN errors sanitized** — `classifyUCANError()` prevents DID leakage in logs
✅ **Session tokens implemented** — 15-minute opaque HMAC tokens for space access
✅ **AAD on AES-GCM** — `buildAAD(context)` binds ciphertext to `spaceId + recordId`
✅ **Blob padding** — size buckets prevent exact size leakage
✅ **Epoch-based forward secrecy** — HKDF ratcheting with 30-day default
✅ **UUIDv4 record IDs** — switched from UUIDv7 to eliminate timestamp leakage

**Added by Phase 1 & 2:**
✅ **Invitations use opaque mailbox_id** — client-derived via HKDF, server never sees plaintext identity
✅ **WebSocket broker keyed by mailbox_id** — no `issuer:userID` concatenation anywhere
✅ **No sender identity stored** — rate limiting uses ephemeral HMAC hash in `rate_limit_actions` table, not stored in invitations
✅ **No `user_id` in request logs** — removed from `logging.go`
✅ **No `revoked_by` or timestamps** — dropped from revocations, files, members tables
✅ **Session handler audited** — PRIVACY comment, no user-to-token mapping logged
✅ **BroadcastRevocation uses mailbox_id** — signature updated to `(spaceID, targetMailboxID)`
✅ **Signed membership entries** — ECDSA P-256 signatures on all membership log entries (delegation, acceptance, decline, revocation)
✅ **Membership log status tracking** — accept/decline/revoke entry types give UI visibility into member state
✅ **General-purpose rate limiting** — `rate_limit_actions` table supports multiple action types (invitations + membership appends)
✅ **Any member can append to membership log** — server requires read permission (not admin), integrity via client-side signatures + server-side hash chain

### What the Server Still Learns

| Issue | Server Learns | Status | Impact |
|-------|--------------|--------|--------|
| **Push/pull attribution** | Which user accesses which space | Only at session creation (15-min TTL) | High |
| **UCAN delegation graph** | Full chain at session creation | Ephemeral only — Phase 2.5 encrypts persistent storage | Medium |
| **Members log DIDs** | Permanent UCAN `iss`/`aud` chain in hash log | ✅ Encrypted under space key + ECDSA-signed entries | Medium |
| **Space creator linkage** | `spaces.root_public_key` links to creator's DID | Needed for UCAN validation | Low |
| **Timing correlation** | Invitation WebSocket notification timing | ✅ 1-5s random delay in `BroadcastInvitation()` (`46a025d`) | Low |

### Additional Metadata (Out of Scope for Phase 2)

These are lower-priority issues or inherent to the architecture:

| Issue | Why Not Addressed Now |
|-------|----------------------|
| **Contact discovery leak** | `GET /users/{user}/keys/{client}` reveals to the accounts server who looks up whom, building a social intent graph. Inherent to username-based sharing — unlike Signal's contact-list intersection, this is an intentional user action. No practical mitigation without PIR or OPRF-based lookup (disproportionate complexity). |
| **Accounts server as metadata aggregator** | The accounts server knows `(user → mailbox_id)` mapping, sees key lookups, and processes token refreshes hourly. It is the primary metadata risk in the system. Architectural separation limits what the sync server learns, but the accounts server has a broader view. |
| **Session re-exposure (15-min TTL)** | Session tokens expire every 15 minutes, requiring JWT re-presentation to the sync server. Each renewal exposes `sub`, `mailbox_id`, `did`. Consider increasing TTL to 1-4 hours (acceptable for productivity apps) to reduce exposure frequency. Tradeoff: slower revocation. |
| **WebSocket connection fingerprinting** | Multiple devices with the same mailbox_id reveal device count and per-device activity patterns to the sync server. |
| **Space ID as social graph edge** | Server sees `(mailbox_A, space_X)` and `(mailbox_B, space_X)` from session creations, building the collaboration graph even with pseudonymous mailbox IDs. Inherent to shared spaces. |
| **Personal space ID is deterministic** | By design for multi-device sync. Server can link if it enumerates user IDs, but provides no new information beyond what accounts server already knows. |
| **File sizes** | Already padded for record blobs. File padding is expensive (files are large). Defer to separate file privacy review. |
| **`spaces.root_public_key`** | Needed for UCAN validation. Only linkable by joining with accounts DB. Acceptable for current threat model. |
| **Members log DID keys** | Encrypted under space key (Phase 2.5) and signed (Phase 5). Server stores opaque ciphertext. Full elimination of ephemeral exposure requires anonymous credentials (see Future Considerations). |
| **Timing correlation** | Fundamental to real-time systems. Mitigations (random delays, batching) trade privacy for latency. |

---

## Design Philosophy: Blind Invitations

The solution draws from Signal's sealed sender protocol. Three key insights:

### 1. Decouple Authentication from Routing

**Current:** JWT identifies the user for both auth and routing.
**Proposed:** JWT proves "valid user," but operations use an opaque routing identifier.

```
┌─────────────────────────────────────────────────────────────┐
│ Signal Sealed Sender Analogy                                │
├─────────────────────────────────────────────────────────────┤
│ Sender Certificate (server-signed, short-lived)             │
│   → Proves "this is a legitimate user"                      │
│   → Not linked to the actual message delivery               │
│                                                              │
│ Recipient UUID (routing identifier)                         │
│   → Server knows where to deliver                           │
│   → Server doesn't know who sent it                         │
└─────────────────────────────────────────────────────────────┘
```

### 2. Mailbox ID Derivation

**Problem:** Invitations currently route by `HMAC(server_key, issuer || user_id)`. If the server holds the HMAC key, it can reverse the mapping.

**Solution:** Derive mailbox IDs from client-side key material that the server never sees:

```typescript
// Client computes (server cannot):
mailbox_id = hex(await crypto.subtle.deriveBits(
  {
    name: "HKDF",
    hash: "SHA-256",
    salt: utf8("betterbase-mailbox-salt-v1"),  // Fixed salt for domain separation
    info: utf8("betterbase:mailbox:v1\0" + issuer + "\0" + user_id)
  },
  encryption_key,  // The scoped key from OPAQUE (32 bytes), NOT the P-256 private key
  256  // 32 bytes output
))  // 64-char hex string

// Client registers mailbox_id with accounts server during OAuth
// Accounts server includes mailbox_id as a JWT claim
// Inviter looks up mailbox_id from public key directory
// Sync server extracts mailbox_id from verified JWT (not from client header)
```

**Critical details:**

1. **Derive from `encryption_key`, not `app_private_key`**: Web Crypto API does not support exporting raw bytes from P-256 private keys. The OPAQUE-derived encryption key is already available as raw key material suitable for HKDF.

2. **Use null separator `\0` in info string**: Prevents collision attacks where `issuer="a\0b"` + `user_id="c"` could collide with `issuer="a"` + `user_id="b\0c"`.

3. **Include as JWT claim**: The accounts server includes `mailbox_id` in the JWT, so the sync server can extract it from the verified token without trusting a client-supplied header.

**Key property:** The sync server sees only the mailbox ID (from JWT). The accounts server knows the mapping but never sees invitation payloads. Neither server alone has full information.

### 3. Unlinkable Session Tokens

**Current:** Session tokens don't carry user identity, but the server can log the mapping at issuance.

**Proposed:** Explicit policy not to log the mapping. Session token issuance becomes:

```
User → JWT + UCAN chain → validate → issue opaque token
                                      ↓
                              token = random(32 bytes)
                              store: token → { spaceId, expiresAt }
                              DO NOT STORE: which user requested it
```

All push/pull/events operations use the opaque token. The server validates "this token is valid for space X" without knowing which member is using it.

---

## Phase 1: Remove Unnecessary Metadata

**Timeline:** 2-3 days
**Risk:** Low (all changes are deletions of write-only columns)

### 1.1 Drop `revocations.revoked_by`

**Current State:**
```sql
CREATE TABLE revocations (
    space_id   UUID NOT NULL,
    ucan_cid   TEXT NOT NULL,
    revoked_by TEXT NOT NULL,  -- ← plaintext did:key, never read
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (space_id, ucan_cid)
);
```

**Why:** The column is populated at `membership.go:284` but never queried. The server only needs `IsRevoked(spaceID, ucanCID)` which checks existence, not who revoked.

**Changes:**
- Migration: `ALTER TABLE revocations DROP COLUMN revoked_by, DROP COLUMN revoked_at`
- Go: Remove `revokedBy` parameter from `RevokeUCAN(ctx, spaceID, ucanCID, revokedBy)` → `RevokeUCAN(ctx, spaceID, ucanCID)`
- Update `handleRevoke()` to not extract or pass `revokedBy`

**Impact:** None. The column is write-only.

### 1.2 Drop Unnecessary Timestamps

**Columns to remove:**
- `files.created_at` — never queried (files looked up by `(space_id, id)`)
- `members.created_at` — never queried (log fetched by `(space_id, seq)`)
- `invitations.created_at` — optional, but consider keeping for TTL ordering

**Changes:**
```sql
ALTER TABLE files DROP COLUMN created_at;
DROP INDEX idx_files_created_at;

ALTER TABLE members DROP COLUMN created_at;
```

**Why:** These timestamps exist by convention but are never used in queries. The server processes requests in real-time, so it already knows "approximately when" without storing it.

**Impact:** Reduces stored metadata. No functional change.

### 1.3 Remove `user_id` from Request Logs

**Current:** `logging.go:93-95`
```go
if userID := UserIDFromContext(r.Context()); userID != "" {
    attrs = append(attrs, slog.String("user_id", userID))
}
```

**Change:** Delete these lines. Logs will still include method, path, status, duration, and space_id (when applicable).

**If debugging value is needed:** Replace with a per-request pseudonym:
```go
requestID := r.Header.Get("X-Request-ID")  // or generate one
attrs = append(attrs, slog.String("request_id", requestID))
```

**Impact:** Server logs no longer create a persistent record of which user performed which action.

---

## Phase 2: Blind the Server to Identity

**Timeline:** 2-3 weeks
**Risk:** Moderate (protocol changes, requires coordination between accounts and sync servers)

### 2.1 Mailbox ID System for Invitations

This is the core change. It eliminates plaintext identity from the invitation flow.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Accounts Server                            │
│  - Knows: (userID, mailbox_id) mapping                         │
│  - Stores: oauth_grants.mailbox_id                             │
│  - Doesn't see: invitation payloads                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ GET /users/{user}/keys/{client}
                              │ returns { publicKey, mailbox_id }
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                       Sync Server                               │
│  - Knows: mailbox_id (opaque routing ID)                       │
│  - Stores: invitations by mailbox_id                           │
│  - Doesn't know: which user owns which mailbox                 │
└─────────────────────────────────────────────────────────────────┘
```

**Neither server alone can build a complete social graph.**

#### Changes: Accounts Server

**Schema:**
```sql
-- Add to oauth_grants table:
ALTER TABLE oauth_grants ADD COLUMN mailbox_id CHAR(64);
CREATE INDEX idx_oauth_grants_mailbox_id ON oauth_grants(mailbox_id);
```

**Client-side derivation:**
```typescript
// During OAuth consent flow (must match canonical derivation in §2):
const mailbox_id = hex(await crypto.subtle.deriveBits(
  {
    name: "HKDF",
    hash: "SHA-256",
    salt: utf8("betterbase-mailbox-salt-v1"),
    info: utf8("betterbase:mailbox:v1\0" + issuer + "\0" + user_id)  // null separators
  },
  encryption_key,  // 32 bytes from OPAQUE export key, NOT app_private_key
  256
));

// Register via new endpoint or include in consent POST
```

**JWT changes:**
```go
// Add mailbox_id to OAuth access token claims:
type OAuthAccessClaims struct {
    // ... existing claims ...
    PersonalSpaceID string `json:"personal_space_id"`
    DID             string `json:"did"`
    MailboxID       string `json:"mailbox_id"`  // NEW
}
```

**API changes:**
```go
// Modify GET /users/{username}/keys/{client_id} response:
type UserKeyResponse struct {
    PublicKey  []byte `json:"public_key"`   // existing
    DID        string `json:"did"`          // existing
    Issuer     string `json:"issuer"`       // existing
    UserID     string `json:"user_id"`      // existing
    MailboxID  string `json:"mailbox_id"`   // NEW
}
```

#### Changes: Sync Server

**Schema:**
```sql
-- Replace recipient_hash and sender_hash with mailbox_id:
ALTER TABLE invitations
    DROP COLUMN recipient_hash,
    DROP COLUMN sender_hash,
    ADD COLUMN mailbox_id CHAR(64) NOT NULL;

CREATE INDEX idx_invitations_mailbox ON invitations(mailbox_id, created_at DESC);
```

**API changes:**

`POST /invitations`:
```go
// OLD request body:
type createInvitationRequest struct {
    RecipientIssuer string `json:"recipient_issuer"`
    RecipientUserID string `json:"recipient_user_id"`
    Payload         string `json:"payload"`
}

// NEW request body:
type createInvitationRequest struct {
    MailboxID string `json:"mailbox_id"`  // 64-char hex
    Payload   string `json:"payload"`     // opaque JWE
}
```

**Handler changes:**

`handleCreateInvitation()`:
```go
// Remove:
// - Lines extracting recipient_issuer/recipient_user_id from request
// - Lines computing recipient_hash
// - Lines computing sender_hash for rate limiting
// - Line 140: recipientKey := req.RecipientIssuer + ":" + req.RecipientUserID

// Add:
if req.MailboxID == "" || len(req.MailboxID) != 64 {
    writeError(w, http.StatusBadRequest, "invalid mailbox_id")
    return
}

// Rate limiting: dual-layer approach
// Layer 1: Per-JWT (use HMAC of sub claim, prevents single-user spam)
senderID := UserIDFromContext(ctx)  // from JWT
senderHash := hmac(rateLimitKey, senderID)  // dedicated HMAC key, NOT unsalted SHA256
if count := rateLimiter.Check(senderHash); count >= 10 {
    writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
    return
}

// Layer 2: Per-space (prevents shared space invitation flooding)
// Not shown here, but check invitation count for any shared spaces the sender is admin of

inv := &storage.Invitation{
    MailboxID: req.MailboxID,
    Payload:   []byte(req.Payload),
}

// WebSocket notification:
s.broker.BroadcastInvitation(req.MailboxID)  // not recipientKey
```

`handleListInvitations()`:
```go
// Extract mailbox_id from verified JWT (not from client header):
mailboxID := MailboxIDFromContext(ctx)  // new context helper
if mailboxID == "" {
    writeError(w, http.StatusBadRequest, "JWT missing mailbox_id claim")
    return
}

invitations, err := s.storage.ListInvitations(ctx, mailboxID, limit, after)
```

`middleware.go`:
```go
// Add to auth middleware context extraction:
if mailboxID, ok := claims["mailbox_id"].(string); ok {
    ctx = context.WithValue(ctx, mailboxIDKey, mailboxID)
}

// New context helper:
func MailboxIDFromContext(ctx context.Context) string {
    if v := ctx.Value(mailboxIDKey); v != nil {
        return v.(string)
    }
    return ""
}
```

#### Changes: Client

**InvitationClient:**
```typescript
// OLD:
async createInvitation(recipientIssuer: string, recipientUserID: string, payload: string)

// NEW:
async createInvitation(recipientMailboxID: string, payload: string)
```

**Lookup flow:**
```typescript
// Inviter:
const recipientKeys = await accountsClient.getUserKeys(username, clientId);
const mailboxID = recipientKeys.mailbox_id;

const invitation = {
  spaceId,
  spaceKey: base64(spaceKey),
  ucanChain: ucanToken,
  // ... other fields
};

const jwe = await encryptJwe(invitation, recipientKeys.publicKey);
await invitationClient.createInvitation(mailboxID, jwe);
```

**Self-invite prevention** (client-side):
```typescript
if (recipientKeys.publicKey === myPublicKey) {
  throw new Error("Cannot invite yourself");
}
```

### 2.2 WebSocket Broker Anonymization

**Current:** Broker indexes by `userKey = issuer + ":" + userID`

**Change:** Index by `mailbox_id` instead.

**Go changes:**

`events.go`:
```go
// OLD:
type Subscription struct {
    ch      chan *protocol.EventFrame
    jti     string
    userKey string  // "issuer:userID"
    mu      sync.Mutex
    spaces  map[string]struct{}
}

// NEW:
type Subscription struct {
    ch        chan *protocol.EventFrame
    jti       string
    mailboxID string  // 64-char hex
    mu        sync.Mutex
    spaces    map[string]struct{}
}

// Update broker indexes:
type MultiBroker struct {
    mu              sync.RWMutex
    subscriptions   map[*Subscription]struct{}
    spaceIndex      map[string]map[*Subscription]struct{}
    mailboxIndex    map[string]map[*Subscription]struct{}  // was userIndex
    connectionCount map[string]int                         // by mailboxID
    logger          *slog.Logger
}
```

**handleMultiEvents:**
```go
// OLD:
userKey := issuer + ":" + userID
sub, unsubscribe, err := s.broker.Subscribe(userKey, jti, successSpaceIDs)

// NEW:
mailboxID := MailboxIDFromContext(ctx)  // from verified JWT claim
if mailboxID == "" {
    writeError(w, http.StatusBadRequest, "JWT missing mailbox_id claim")
    return
}
sub, unsubscribe, err := s.broker.Subscribe(mailboxID, jti, successSpaceIDs)
```

**Client changes:**

`MultiSpaceTransport`:
```typescript
// No changes needed — mailbox_id comes from JWT automatically
// Server extracts MailboxIDFromContext(ctx)
```

**Note:** The mailbox_id is now in the JWT claim, so clients don't need to compute or send it separately. The sync server extracts it from the verified Bearer token.

### 2.3 Sender-Blind Invitations

After implementing 2.1, the sender identity is no longer in the request body or stored in the database.

**Remove sender_hash entirely:**

Migration:
```sql
ALTER TABLE invitations DROP COLUMN sender_hash;
DROP INDEX idx_invitations_sender;
```

**Rate limiting (dual-layer):**

```go
// Layer 1: Per-user (10/hour)
senderID := UserIDFromContext(ctx)  // from JWT sub claim
senderHash := hmac(s.rateLimitKey, []byte(senderID))  // dedicated HMAC key
count, _ := s.storage.CountRecentInvitationsBySender(ctx, hex.EncodeToString(senderHash), since)
if count >= 10 { /* reject */ }

// Layer 2: Per-shared-space admin (optional, prevents space-based abuse)
// Check if sender is admin of any spaces and count invitations sent "from" those spaces
```

**Implementation note:** Use HMAC with a dedicated rate-limit key (not unsalted SHA256, which is reversible by enumeration of the user population). Store the hash ephemerally for rate limiting (write-only, not indexed).

**Sender identity only exists inside JWE payload:**

The recipient decrypts and sees:
```json
{
  "spaceId": "...",
  "spaceKey": "...",
  "ucanChain": "...",
  "sender": {
    "issuer": "https://accounts.betterbase.dev",
    "userId": "...",
    "username": "alice"
  }
}
```

The server never sees this plaintext.

### 2.4 Session Token Strengthening

**Current:** Session tokens are opaque, but the server could log the mapping at issuance.

**Change:** Explicit code audit and policy.

**Verification checklist:**
- [ ] `handleCreateSession()` does not log `(userID, token)` mapping
- [ ] `handleMultiEvents()` line 704-708 does not log `user_key` (remove or replace with `mailbox_id`)
- [ ] For shared space operations using session tokens, don't extract `sub`/`issuer` from JWT into context beyond initial session creation

**Documentation:**

Add comment at session issuance:
```go
// PRIVACY: Do not log the mapping between user identity and session token.
// The session token is intentionally unlinkable to provide sender anonymity
// within shared spaces.
token := issueSpaceToken(spaceID)
```

---

## Phase 2.5: Membership Client + Encrypt Members Log

**Timeline:** 3-5 days (after Phase 2)
**Risk:** Low (additive encryption layer, no server protocol changes)

### Problem

The `members` table stores UCAN payloads containing `iss` and `aud` DID keys — a permanent, append-only record of the delegation graph. After Phase 2, this is the largest remaining metadata leak in the sync server's persistent storage.

Additionally, there's no TypeScript client for the membership log endpoints yet. The server has `POST /spaces/{spaceId}/membership-log` and `GET /spaces/{spaceId}/membership-log` handlers, but `SpaceManager` tracks members via a local in-memory cache instead of the server's authoritative log.

### Solution

Two parts: (1) build the `MembershipClient` in `@betterbase/sdk/sync`, (2) encrypt payloads before sending so the server stores opaque ciphertext.

**Server changes:** None. The server already treats payloads as opaque bytes and validates `SHA-256(payload) == entry_hash`. The `authorizeSpace()` flow validates UCAN chains from the `X-UCAN` header (in memory, ephemeral), not from the members log.

#### Part 1: MembershipClient

New `membership.ts` in `@betterbase/sdk/sync` that calls the existing server endpoints:

```typescript
class MembershipClient {
  // POST /spaces/{spaceId}/membership-log
  // Body: { expected_version, prev_hash, entry_hash, payload }
  async appendMember(spaceId: string, entry: MembershipEntry): Promise<AppendResult>;

  // GET /spaces/{spaceId}/membership-log
  async getMembers(spaceId: string): Promise<MembershipLog>;

  // POST /spaces/{spaceId}/revoke
  async revoke(spaceId: string, ucanCid: string): Promise<void>;
}
```

Hash chain maintenance: client computes `entry_hash = SHA-256(payload)` and tracks `prev_hash` from the last entry. Server validates chain integrity via `expected_version` and hash linkage.

#### Part 2: Encrypt Payloads

```typescript
// Before appending to members log:
const plaintext = encodeUCANPayload(ucanChain);
const ciphertext = await encrypt(spaceKey, plaintext, buildAAD("members", spaceId, seq));

// POST /spaces/{spaceId}/membership-log
// body: { payload: base64(ciphertext), entry_hash: SHA-256(ciphertext), ... }

// entry_hash is computed over ciphertext (server validates hash chain over ciphertext)
```

After `GET /membership-log`: decrypt each entry's payload, validate UCAN chains locally. Reuse `@betterbase/sdk/crypto` encrypt/decrypt (already have AAD support).

#### Part 3: Integrate into SpaceManager

Replace the `memberCache` with server-authoritative membership:
- `invite()`: after sending invitation, append encrypted UCAN to membership log
- `accept()`: append acceptance entry to membership log
- `getMembers()`: fetch + decrypt membership log from server

**What this achieves:**
- The permanent members log no longer reveals the delegation graph
- Server validates UCAN chains ephemerally during session creation (every 15 minutes) but the persistent record is encrypted
- Membership is server-authoritative instead of a local cache
- No new cryptographic primitives needed

**Residual leak:** The server still sees the full UCAN chain at session creation time. It could log it. This is a policy-based protection, not cryptographic. For the honest-but-curious threat model, this is acceptable. Cryptographic enforcement would require anonymous credentials (see Future Considerations).

---

## Implementation Checklist

### Phase 1 — COMPLETE ✓

- [x] Migration `006_privacy_phase1.sql`: Drop `revocations.revoked_by`, `revocations.revoked_at`
- [x] Go: Remove `revokedBy` parameter from `RevokeUCAN()` signature
- [x] Go: Update `handleRevoke()` to not extract `revokedBy`
- [x] Migration `006_privacy_phase1.sql`: Drop `files.created_at`, `members.created_at`
- [x] Go: Remove `user_id` from request logs in `logging.go`
- [x] Test: All `just check` passing (revocation, files, membership)

### Phase 2 — COMPLETE ✓

**Accounts Server:** (committed `3649d53`)
- [x] Migration `002_mailbox_id.sql`: Add `oauth_grants.mailbox_id CHAR(64)` with partial unique index
- [x] Go: `POST /oauth/mailbox` endpoint for client registration (first-write-wins)
- [x] Go: Include `mailbox_id` in JWT claims (alongside `personal_space_id`, `did`)
- [x] Go: Update `GET /users/{user}/keys/{client}` to return `mailbox_id`
- [x] Test: All `just check` passing

**Sync Server:** (committed `1400dd4`)
- [x] Migration `007_mailbox_invitations.sql`: Replace `recipient_hash`/`sender_hash` with `mailbox_id`
- [x] Go: Update `createInvitationRequest` to accept `mailbox_id` (64-char hex validated)
- [x] Go: Update all invitation handlers to use `MailboxIDFromContext(ctx)` from JWT
- [x] Go: Rate limiting via `RateLimitHash` (HMAC of sub claim, not stored in invitation)
- [x] Go: Update `BroadcastInvitation()` to take `mailboxID`
- [x] Go: Update `MultiBroker` — all indexes/counts keyed by `mailboxID`
- [x] Go: Update `handleMultiEvents()` to route by `mailboxID` from JWT
- [x] Go: Add `MailboxIDFromContext()` helper to middleware
- [x] Go: Update `BroadcastRevocation()` signature to `(spaceID, targetMailboxID)`
- [x] Go: Session handler audit — PRIVACY comment added, no identity logged
- [x] Go: `IDENTITY_HASH_KEY` comment updated to reflect rate-limiting purpose
- [x] Test: All `just check` passing (invitations, WebSocket, connection limits)
- [x] Go: Add random delay (1-5s) to `BroadcastInvitation()` for timing mitigation

**Client:** (committed `a0dbc56`)
- [x] `@betterbase/sdk/auth`: `deriveMailboxId()` using HKDF-SHA256 with 32-byte key validation
- [x] `@betterbase/sdk/auth`: Register mailbox ID via `POST /oauth/mailbox` in `handleCallback()`
- [x] `@betterbase/sdk/auth`: `mailboxId` on `AuthResult` type
- [x] `@betterbase/sdk/sync`: `sendInvitation()` takes `recipientMailboxID` (validated 64-char hex)
- [x] `@betterbase/sdk/sync`: Removed `sender_issuer`/`sender_user_id` from `Invitation` type
- [x] `@betterbase/sdk/sync`: `SpaceManager.invite()` uses `recipientKey.mailbox_id`
- [x] Test: All `pnpm check` passing (108 auth + 76 crypto + 21 inference + 361 sync = 566 tests)

**Still TODO:**
- [x] Integration tests (invitation flow end-to-end with running services)

### Phase 2.5 — COMPLETE ✓

Phase 2.5 encrypts membership log payloads so the sync server can't read the UCAN delegation graph. The server already treats payloads as opaque bytes and validates `SHA-256(payload) == entry_hash`, so **no server changes needed**. All work is in `@betterbase/sdk/sync`.

**MembershipClient:** (committed `b2b86bf`)
- [x] New `membership.ts` in `@betterbase/sdk/sync` with `MembershipClient` class
- [x] `appendEntry(spaceId, entry)` → `POST /spaces/{spaceId}/membership-log`
- [x] `getEntries(spaceId)` → `GET /spaces/{spaceId}/membership-log`
- [x] `revokeUCAN(spaceId, ucanCid)` → `POST /spaces/{spaceId}/revoke`
- [x] `rotateKey(spaceId, expectedVersion)` → `POST /spaces/{spaceId}/rotate-key`
- [x] Wire format: `{ expected_version, prev_hash, entry_hash, payload }` (base64 bytes)
- [x] Hash chain: client computes `entry_hash = SHA-256(payload)`, tracks `prev_hash`

**Encrypt payloads under space key:**
- [x] Before `POST /membership-log`: encrypt UCAN payload with AES-256-GCM, AAD = `(spaceId, seq)`
- [x] `entry_hash = SHA-256(ciphertext)` — server validates hash chain over ciphertext
- [x] After `GET /membership-log`: decrypt each entry's payload, validate UCAN chains locally
- [x] Reuse `@betterbase/sdk/crypto` encrypt/decrypt (already have AAD support)

**Integrate into SpaceManager:**
- [x] `invite()`: after sending invitation, append encrypted UCAN to membership log
- [x] `accept()`: append acceptance entry to membership log
- [x] `getMembers()`: fetch + decrypt membership log instead of local cache
- [x] Replace `memberCache` with server-authoritative membership queries

**Tests:**
- [x] MembershipClient: unit tests with mocked fetch (append, get, revoke, rotateKey)
- [x] Round-trip: encrypt payload → append → fetch → decrypt → validate UCAN
- [x] Hash chain validates over ciphertext (not plaintext)
- [x] New member can decrypt existing log entries (they have the space key)
- [x] SpaceManager integration: invite appends to log, accept appends to log
- [x] `computeUCANCID()`: deterministic SHA-256 hex, different inputs differ, 64-char output

### Phase 5 — COMPLETE ✓

Signed membership entries + ephemeral rate limiting. Ensures membership log integrity and prevents log spam.

**Crypto signing utilities (`@betterbase/sdk/crypto`):**
- [x] `sign(privateKey, message)` — ECDSA P-256, IEEE P1363 format (64-byte r||s)
- [x] `verify(publicKeyJwk, message, signature)` — returns false (not throw) on invalid
- [x] Tests: round-trip, wrong key, wrong message, 64-byte output, deterministic import

**Membership entry format (`@betterbase/sdk/sync`):**
- [x] Entry types: `"d"` (delegation), `"a"` (accepted), `"x"` (declined), `"r"` (revoked)
- [x] Canonical signing message: `betterbase:membership:v1\0<type>\0<spaceId>\0<signerDID>\0<ucan>`
- [x] `signature` and `signerPublicKey` are required fields (no legacy/unsigned support)
- [x] `verifyMembershipEntry()` — validates signer DID against entry type role, verifies ECDSA signature
- [x] Self-issued UCANs (iss == aud): also verifies UCAN JWT signature to prevent creator impersonation
- [x] `parseMembershipEntry()` rejects anything that isn't valid signed JSON

**SpaceManager changes (`@betterbase/sdk/sync`):**
- [x] `createSpace()` signs creator's root UCAN delegation entry
- [x] `invite()` signs delegation entry with recipient contact info
- [x] `accept()` appends signed acceptance entry (`type: "a"`) before creating sync stack
- [x] `decline()` appends signed decline entry (`type: "x"`) before deleting space record
- [x] `removeMember()` appends signed revocation entries (`type: "r"`) for revoked UCANs
- [x] `getMembers()` derives member status: active (self-issued or accepted), pending, declined, revoked
- [x] `getMembers()` skips entries with invalid signatures (logs warning)

**Server permission change (`less-sync`):**
- [x] `handleAppendMember()` authorization: `PermissionAdmin` → `PermissionRead`
- [x] Any member with a valid UCAN can append (integrity via signatures + hash chain)
- [x] Rate limited: 10 membership appends per hour per actor

**Ephemeral rate limiting (`less-sync`):**
- [x] Migration `008_ephemeral_rate_limits.sql`: general-purpose `rate_limit_actions` table
- [x] Schema: `(action VARCHAR(32), actor_hash CHAR(64), created_at TIMESTAMPTZ)`
- [x] `rate_limit_hash` column dropped from `invitations` table
- [x] `RecordAction(ctx, action, actorHash)` — records after successful operation (not before)
- [x] `CountRecentActions(ctx, action, actorHash, since)` — counts by action type
- [x] `CleanupExpiredActions(ctx, before)` — background cleanup every 10 minutes
- [x] Used for both `"invitation"` and `"membership_append"` actions

**Tests:**
- [x] 82 crypto tests, 427 sync tests pass
- [x] All Go tests pass (`just check` in less-sync)

### Phase 3+4 — COMPLETE ✓

Member revocation with key rotation, wired into SpaceManager. (committed `686de98`)

**MembershipClient additions:**
- [x] `rotateKey(spaceId, expectedVersion)` → `POST /spaces/{spaceId}/rotate-key` with CAS
- [x] `computeUCANCID(ucan)` → SHA-256 hex of UCAN string for revocation lookups

**SpaceManager.removeMember():**
- [x] Validate preconditions (admin-only, no self-removal)
- [x] Find all active UCANs for member in encrypted membership log (skip expired)
- [x] Revoke all UCANs for the member (handles re-invite deduplication)
- [x] Rotate encryption key (CAS on metadata_version)
- [x] Re-wrap all DEKs under new epoch key via `rewrapSpace()`
- [x] Update local SyncCrypto, spaceKeys, spaceEpochs, persist new key
- [x] Error recovery: wrap rewrapSpace failure with recovery guidance

**Epoch tracking:**
- [x] `spaceEpochs` map for forward-secrecy DEK re-wrapping
- [x] Persist epoch in space record (`f51eb99`)

**Tests (14 new):**
- [x] removeMember: revoke→rotate→rewrap sequence
- [x] Throws if not admin / removing self / member not found / space not found / no sync crypto
- [x] Revokes all UCANs when member has multiple
- [x] Skips expired UCANs
- [x] Updates local crypto state + persists new key
- [x] Wraps rewrapSpace failure with recovery guidance
- [x] rotateKey: correct JSON, 409→VersionConflictError, 404→SpaceNotFoundError
- [x] computeUCANCID: deterministic, different inputs differ, 64-char hex

---

## Security Analysis

### Threat Model

**What this protects against:**

1. **Passive database compromise** — attacker with DB read access cannot link invitations to user identities (mailbox IDs are one-way derived)
2. **Honest-but-curious server operator** — sync server operator cannot build a social graph from invitation patterns
3. **Cross-server collusion threshold** — requires both accounts + sync servers to collude to link invitations to identities

**What this does NOT protect against:**

1. **Active server instrumentation** — a compromised server binary can log anything in memory. The plan establishes policy ("don't log this mapping"), but a modified binary can violate that.
2. **Traffic analysis** — server sees timing, request sizes, and can correlate with online users
3. **Small anonymity sets** — in a 2-person space, sender anonymity is meaningless
4. **Accounts server alone** — accounts server knows `(user → mailbox_id)` mapping

### Benefits for Same-Operator Deployments

Even when accounts + sync are run by the same operator, architectural separation provides value:

**1. Explicit correlation boundary:**
- Accounts DB contains: `(user_id, email, username, mailbox_id)`
- Sync DB contains: `(mailbox_id, encrypted_blobs, space_id)`
- To link "Alice sent Bob an invitation," operator must JOIN across databases
- This makes surveillance **visible in code** (not implicit in the architecture)

**2. Selective data retention:**
- Accounts: Must keep user records (identity, auth)
- Sync: Can purge old invitations, expired sessions, etc. without affecting identity
- Separation enables different retention policies per database

**3. Access control:**
- Engineering can grant sync DB access to on-call without giving accounts DB access
- Reduces insider threat surface (most operational issues in sync, not auth)

**4. Audit trail:**
- Cross-database queries are explicit and loggable
- "Who looked up which user's invitation mailbox?" becomes auditable

### Federation Benefits (Optional Future)

The same design supports federated operation where accounts and sync are separate operators:

```
┌──────────────────────┐          ┌──────────────────────┐
│  accounts.alice.com  │          │   sync.shared.net    │
│                      │          │                      │
│  Knows:              │          │  Knows:              │
│  - Alice's identity  │          │  - mailbox_abc123    │
│  - mailbox_abc123    │          │  - invitation blob   │
│                      │          │  - NOT Alice         │
│  Doesn't see:        │          │                      │
│  - invitation blobs  │          │  Doesn't know:       │
└──────────────────────┘          │  - who owns mailbox  │
                                  └──────────────────────┘
```

Neither server alone has full information. The architecture supports this without requiring it.

---

## Privacy Properties: Before vs. After

### Invitations

| Property | Before | After Phase 2 |
|----------|--------|---------------|
| Recipient identity in transit | ✗ Plaintext `issuer:userID` | ✓ Opaque mailbox_id |
| Recipient identity stored | △ HMAC hash (server holds key) | ✓ One-way derived ID |
| Sender identity stored | △ HMAC hash | ✓ Not stored |
| Sender identity in transit | ✓ Only in JWT (auth) | ✓ Same |
| Server can link invitation to recipient | ✗ Yes (with HMAC key) | △ Only if accounts server colludes |
| Server can link invitation to sender | ✗ Yes (with HMAC key) | ✓ No |

### Push/Pull Operations

| Property | Before | After Phase 2 |
|----------|--------|---------------|
| Server knows which user pushes | ✗ Yes (JWT sub) | △ Only at session creation |
| Server knows which user pulls | ✗ Yes (JWT sub) | △ Only at session creation |
| Server knows user-to-space mapping | ✗ Yes (real-time) | △ Yes, but aging (session TTL) |
| Operations linkable across sessions | ✗ Yes (same user ID) | ✓ No (new opaque token) |

### WebSocket/Real-time

| Property | Before | After Phase 2 |
|----------|--------|---------------|
| Server knows which user is online | ✗ Yes (`issuer:userID`) | △ Knows mailbox_id is online |
| Server can link WebSocket to user account | ✗ Yes (directly) | △ Only via accounts server |
| Connection limits per-user | ✗ By identity | ✓ By mailbox (same effect) |

### Stored Metadata

| Column | Before | After Phase 1 | After Phase 2 | After Phase 2.5 |
|--------|--------|---------------|---------------|-----------------|
| `revocations.revoked_by` | ✗ Plaintext DID | ✓ Removed | ✓ Removed | ✓ Removed |
| `files.created_at` | ✗ Upload timestamp | ✓ Removed | ✓ Removed | ✓ Removed |
| `members.created_at` | ✗ Event timestamp | ✓ Removed | ✓ Removed | ✓ Removed |
| `members.payload` (DIDs) | ✗ Plaintext UCAN | ✗ Same | ✗ Same | ✓ Encrypted under space key |
| `invitations.recipient_hash` | △ HMAC hash | △ Same | ✓ Replaced with mailbox_id | ✓ Same |
| `invitations.sender_hash` | △ HMAC hash | △ Same | ✓ Removed | ✓ Same |

**Legend:**
✓ = Privacy-preserving
△ = Partial protection (requires additional assumptions)
✗ = Server learns plaintext/linkable identity

---

## Critical Issues Identified (Expert Review)

### Issue 1: Mailbox ID Derivation Key Material ⚠️

**Problem:** The original proposal used `app_private_key` as HKDF input. Web Crypto API does not expose raw bytes from P-256 private keys — you cannot export an ECDH private key in "raw" format.

**Fix:** Derive from the `encryption_key` (scoped key from OPAQUE) which is already available as raw key material:

```typescript
mailbox_id = hex(await crypto.subtle.deriveBits(
  {
    name: "HKDF",
    hash: "SHA-256",
    salt: utf8("betterbase-mailbox-salt-v1"),
    info: utf8("betterbase:mailbox:v1\0" + issuer + "\0" + user_id)  // null separators
  },
  encryption_key,  // 32 bytes from OPAQUE export key
  256
))
```

**Status:** ✅ RESOLVED — `deriveMailboxId()` uses `encryption_key` with 32-byte validation.

### Issue 2: JWT Claim Verification ⚠️ → ✅

**Problem:** Original proposal had clients send `X-Mailbox-ID` header. Without verification, any authenticated user could subscribe to any mailbox (invitation enumeration attack).

**Fix:** Include `mailbox_id` as a JWT claim (alongside `personal_space_id`, `did`). Sync server extracts from verified token, not from untrusted header.

**Status:** ✅ RESOLVED — `mailbox_id` is a JWT claim, sync server uses `MailboxIDFromContext(ctx)`.

### Issue 3: Members Log DID Leakage ✅

**Newly identified:** The membership log (`members` table) stores UCAN payloads that contain `iss` and `aud` DID keys. This creates a permanent, append-only record of the delegation graph that survives Phase 2.

**Fix:** Encrypt members log payloads under the space key (Phase 2.5). Server stores opaque ciphertext, validates hash chain over ciphertext. UCAN chains validated client-side after decryption. Phase 5 adds ECDSA P-256 signatures on all entries for integrity verification.

**Status:** ✅ RESOLVED — Payloads encrypted (Phase 2.5) and signed (Phase 5). Full cryptographic enforcement at session creation would require anonymous credentials (see Future Considerations).

### Issue 4: BroadcastRevocation Uses `issuer:userID` 🔍 → ✅

**Location:** `membership.go:303-306` and `events.go:200` (targeted revocation case).

**Fix:** Migrate to `mailbox_id` routing. When revoking a specific user, use their mailbox_id instead of `issuer:userID`.

**Status:** ✅ RESOLVED — `BroadcastRevocation(spaceID, targetMailboxID)` signature updated.

### Issue 5: Timing Correlation on Invitation WebSocket Notification 🔍

**Attack:** When Alice creates invitation, Bob's WebSocket immediately receives notification. Server correlates "the JWT that just called POST /invitations" with "the mailbox that just got notified."

**Mitigation:** Add random delay (1-5s) before broadcasting invitation notifications.

**Status:** ✅ RESOLVED — 1-5s random delay implemented (`46a025d`).

## Resolved Questions

### Rate Limiting

**Decision:** Dual-layer approach (expert recommendation)
- **Layer 1:** Per-JWT rate limit (HMAC of `sub` claim with dedicated key, 10/hour)
- **Layer 2:** Per-space rate limit (10/hour per shared space)

**Why:** Layer 1 prevents single-account abuse. Layer 2 prevents shared space invitation flooding. Combined, they're stronger than either alone. Use HMAC (not unsalted SHA256) to prevent enumeration-based reversal.

### Mailbox ID Rotation

**Decision:** Do NOT rotate on a schedule.

**Why:** The cost (all contacts must re-fetch, pending invitations unretrievable) exceeds the benefit. Mailbox IDs rotate only when underlying key material changes (password change, account recovery).

**Migration:** During recovery, accounts server updates `mailbox_id`, old invitations expire naturally (7-day TTL), contacts re-fetch on next invitation attempt.

### Session Token Blind Issuance

**Decision:** Defer to Phase 3.

**Why:** Policy-based unlinkability ("don't log the mapping") is sufficient for honest-but-curious operator. Privacy Pass adds complexity and requires OPRF libraries. Revisit if threat model changes or mature libraries become available.

### Multi-Device Mailbox ID

**Decision:** Re-derive deterministically from encryption key.

**Why:** The encryption key is synced to all devices (part of normal OAuth flow). Mailbox ID derivation is deterministic, so all devices compute the same value. No extra storage needed.

**Verification:** Include `client_id` check if per-client mailboxes are ever needed (currently not, so omit from info string).

---

## Migration Strategy

### Existing Invitations

**Current state:** System is pre-production (no deployed users per ROADMAP.md).

**If invitations exist in dev/staging:**
1. Drop and recreate invitations table (acceptable since no production data)
2. All existing invitations lost (notify test users to re-invite)

**If production deployment occurs before Phase 2:**
1. Add `mailbox_id` column as nullable
2. Backfill: Accounts server provides `GET /internal/mailbox-lookup?user_id=X` (admin-only endpoint)
3. Sync server queries accounts to backfill `mailbox_id` for existing invitations
4. After backfill, make column NOT NULL and drop `recipient_hash`/`sender_hash`

**Timeline constraint:** Phase 2 should complete before any production launch to avoid migration complexity.

### Session Token Transition

**Current:** Sessions created before Phase 2 have no mailbox_id logging restrictions.

**Migration:** Sessions expire naturally (15-minute TTL). No migration needed — wait 15 minutes after deploy and all sessions are new.

### JWT Claim Addition

**Current:** JWTs in flight don't have `mailbox_id` claim.

**Migration:**
1. Accounts server adds `mailbox_id` to new tokens immediately
2. Sync server handles missing `mailbox_id` gracefully (fall back to old behavior) for 1-hour grace period (max JWT lifetime)
3. After grace period, require `mailbox_id` claim

---

## Known Limitations & Future Work

### What Phase 2 Does NOT Solve

**1. Small Anonymity Sets**

In a 2-person shared space, sender anonymity is meaningless. The server knows mailbox `abc123` and `def456` are collaborating. If only one is online at 3am and pushes, it's obvious which one.

**Mitigation:** None practical. This is fundamental to real-time collaboration systems. Document as expected behavior.

**2. Members Log Delegation Graph**

The `members` table stores UCAN payloads containing `iss` → `aud` delegation chains.

**Phase 2.5 mitigation:** Encrypt payloads under the space key. The permanent log becomes opaque ciphertext. The server still sees UCAN chains ephemerally during session creation (15-min TTL), but cannot build a persistent delegation graph from storage.

**Residual after Phase 2.5:** Server sees the full UCAN chain in memory at session creation. Eliminating this would require anonymous credentials (see Future Considerations).

**3. Personal Space Access Patterns**

Personal space IDs are deterministic (`UUID5(LESS_NS, issuer||userID||clientID)`). If the operator controls both accounts and sync, they can link personal space activity to users trivially.

**Why not fixed:** Personal spaces are single-user by definition. The privacy model for personal spaces is "server knows this is your space but not what's in it" (blob encryption). Mailbox ID scheme only affects multiplayer (shared spaces, invitations).

**4. Traffic Analysis**

Server sees: request timing, payload sizes (even with padding buckets), push/pull frequency, WebSocket connection duration.

**Mitigation options:**
- Random delays on WebSocket notifications (1-5s) — Phase 2 includes this
- Constant-rate padding — expensive, defer to future
- Cover traffic — very expensive, not practical for mobile apps

**5. Account Recovery Changes Mailbox ID**

When a user recovers their account (password reset via OPAQUE re-registration), the encryption key changes, which changes the mailbox ID. Consequences:
- Pending invitations unretrievable
- Contacts must re-fetch public keys to get new mailbox ID
- WebSocket subscriptions on old mailbox stop working

**Mitigation:**
- Accounts server maintains mailbox ID forwarding for 7 days (TTL of invitations)
- Or: client checks both old and new mailbox during transition
- Document this as expected recovery behavior

---

## Success Metrics

**Privacy metrics:**
- [ ] Zero occurrences of plaintext `recipient_issuer` or `recipient_user_id` in sync server request handlers
- [ ] Zero occurrences of `issuer:userID` string concatenation in broker code
- [ ] Database audit: No columns storing plaintext user identity in relation to invitations
- [ ] Log audit: No `user_id` in access logs (except auth endpoints)

**Functional metrics:**
- [ ] Invitation acceptance rate unchanged (user-facing flow works)
- [ ] WebSocket connection success rate unchanged
- [ ] Push/pull latency unchanged (session tokens don't degrade performance)

**Federation readiness:**
- [ ] Accounts server and sync server can be operated by different parties
- [ ] Neither server alone can build a complete social graph

---

## Future Considerations: Anonymous Credentials (BBS+)

### The Goal

After Phase 2.5, the one remaining metadata leak is that the server sees the full UCAN delegation chain at session creation (every 15 minutes). Anonymous credentials would let a member prove "I hold a valid credential for space X with write permission" without revealing *which* member they are. The server could verify the proof but learn nothing about the presenter's identity.

### BBS+ Signatures

BBS+ is a pairing-based signature scheme that supports zero-knowledge selective disclosure. A credential issuer signs a set of messages (e.g., `[spaceID, permission, memberPublicKey]`). The holder can derive a proof that selectively discloses some messages (e.g., `[spaceID, permission]`) while hiding others (`memberPublicKey`). The verifier confirms the proof is valid without learning the hidden values.

**Key library:** [`@mattrglobal/pairing-crypto`](https://github.com/mattrglobal/pairing_crypto) (v0.4.4) — Rust BBS signatures compiled to WASM. Provides `sign`, `verify`, `proof_gen`, `proof_verify` on BLS12-381. Not independently audited.

### Why Not Now

1. **Spec not finalized.** The IETF BBS Signatures draft is at draft-09 (not RFC). MATTR's library implements draft-03 — several breaking revisions behind. Building on a stale draft risks wire format incompatibility.

2. **No audited library for Go or TypeScript.** The MATTR library is unaudited. Go options (`go-bbs-signatures`, Hyperledger AnonCreds v2) are even less mature. We'd need both JS/WASM (client) and Go (server).

3. **Loss of transitive delegation.** UCAN's strength is hierarchical delegation: Alice → Bob → Carol without Alice's involvement. BBS+ credentials can only be issued by the key holder (space admin). Every new member needs the admin online. This is a significant product regression for collaborative spaces.

4. **Revocation is hard.** With UCAN, revocation is simple: `IsRevoked(spaceID, ucanCID)`. With BBS+ ZK proofs, the server never sees the credential, so revocation requires cryptographic accumulators (complex, another unaudited dependency) or short-lived credentials (admin must be constantly online).

5. **~500KB-1MB WASM bundle.** Non-trivial for consumer apps, though manageable.

### Alternatives Considered

| Approach | Fits Betterbase? | Why / Why Not |
|----------|-------------------|---------------|
| **KVAC** (Signal's approach) | No | Requires the verifier (server) to hold the secret key. Defeats our E2EE trust model. |
| **Privacy Pass** (RFC 9576/9577) | Marginal | Single-use unlinkable tokens. No selective disclosure (can't encode permission levels). Essentially a fancier version of what session tokens already provide. |
| **Group signatures** | Same issues as BBS+ | Same pairing dependency, same library maturity problems. |
| **Encrypt members log** (Phase 2.5) | Yes | Gets ~80% of the privacy benefit at ~5% of the cost. Already planned. |

### When to Revisit

Revisit BBS+ when all three conditions are met:
1. The IETF BBS spec reaches RFC status
2. An audited library exists for both WASM and Go
3. Revocation has a practical, standardized solution

Estimated timeline: 12-24 months. The EU eIDAS 2.0 digital identity wallet initiative is driving investment in BBS+ tooling, which may accelerate this.

### Architectural Readiness

The current design is already well-positioned for a future BBS+ migration:

- **`authorizeSpace()` is the single integration point.** Replace UCAN validation with BBS+ proof verification; everything downstream (session tokens, push/pull/WebSocket) is unchanged.
- **Session tokens are already unlinkable.** No user identity stored. BBS+ would only change what happens at token issuance.
- **UCAN and BBS+ can coexist.** UCAN for delegation (admin → member), BBS+ for presentation (member → server). Members hold both.

**Key invariant to maintain:** All post-session-creation operations must go through the opaque session token. Do not add code paths that extract `userID` or `did` from JWT context for shared space operations. This discipline makes the future BBS+ migration mechanical.

### Preparatory Step: TOFU Key Pinning

Add a `key_id` field (SHA-256 of public key) to the `GET /users/{user}/keys/{client}` response and JWT claims. Clients persist this locally and warn on unexpected changes (Trust On First Use). This is 1-2 hours of work and provides:
- Basic key-change detection immediately
- Foundation for key transparency (append-only Merkle log of key changes) post-launch

---

## References

**Signal Protocol Research:**
- Signal Sealed Sender: https://signal.org/blog/sealed-sender/
- KVAC (Keyed-Verification Anonymous Credentials): Chase-Meiklejohn-Zaverucha, CCS 2014
- Signal Private Groups: https://signal.org/blog/signal-private-group-system/

**IETF Standards:**
- Privacy Pass (RFC 9576/9577): https://datatracker.ietf.org/doc/rfc9576/
- OPRF (draft): https://datatracker.ietf.org/doc/draft-irtf-cfrg-voprf/
- BBS Signatures (draft-09): https://datatracker.ietf.org/doc/draft-irtf-cfrg-bbs-signatures/

**BBS+ Libraries:**
- MATTR pairing-crypto (Rust/WASM): https://github.com/mattrglobal/pairing_crypto

**Existing Betterbase Docs:**
- `signal-level-privacy.md` — Original privacy analysis (now partially outdated)
- `FEDERATION.md` — Federation design (will need update for mailbox IDs)
- `ROADMAP.md` — Implementation milestones

---

## Expert Review Summary

**Reviewer:** Subject-matter expert in applied cryptography and privacy-preserving protocols
**Date:** 2026-02-12

**Overall Assessment:** Sound design with critical issues identified and resolved in this revision. Privacy posture exceeds all comparable platforms (iCloud, Notion, Google Drive, Obsidian Sync).

**Key Findings:**
1. ✅ **Phase 1 approved** — removing write-only metadata is low-risk and correct
2. ⚠️ **Mailbox ID derivation flaw fixed** — switched from `app_private_key` (not exportable in Web Crypto) to `encryption_key`
3. ⚠️ **JWT claim verification added** — prevents malicious clients from subscribing to arbitrary mailboxes
4. ⚠️ **Rate limiting regression prevented** — keep HMAC (with dedicated key), not unsalted SHA256 which is reversible by enumeration
5. 🔍 **Additional leaks documented** — contact discovery, accounts server as aggregator, session re-exposure, WebSocket fingerprinting, members log DIDs, BroadcastRevocation, timing correlation
6. ✅ **Phase 2.5 added** — encrypt members log under space key (days of work, eliminates delegation graph from storage)
7. ✅ **Rate limiting strategy finalized** — dual-layer (per-user HMAC + per-space)
8. ✅ **Migration strategy added** — handles pre-production state correctly

**Privacy characterization:** Sealed-sender-equivalent privacy for invitations. Pseudonymous access for sync operations. Zero-knowledge blob storage. Does NOT achieve private group membership (would require anonymous credentials — see Future Considerations). Appropriate for the target use cases (productivity apps, not whistleblowing).

**Recommendation:** Implement Phase 1 immediately. Proceed with Phase 2 and 2.5 after addressing the critical issues documented above.

---

## Next Steps

1. ~~**Phase 1 implementation**~~ ✓ Complete
2. ~~**Phase 2 implementation**~~ ✓ Complete
3. ~~**Phase 2.5 implementation**~~ ✓ Complete (`b2b86bf`)
4. ~~**Phase 3+4 implementation**~~ ✓ Complete (`686de98`)
5. ~~**BroadcastInvitation timing mitigation**~~ ✓ Complete (1-5s random delay)
6. ~~**Integration tests**~~ ✓ Complete (invitation flow end-to-end with mailbox registration)
7. ~~**Persist epoch in space record**~~ ✓ Complete (`f51eb99`)
8. ~~**Phase 5: Signed membership entries + ephemeral rate limiting**~~ ✓ Complete
9. **TOFU key pinning** (1-2 hours, can be done anytime) — add `key_id` to keys API response and JWT claims
