# Less Platform Federation Specification

**Status**: Draft v1
**Date**: 2026-02-14

## 1. Overview

Federation enables Less Platform servers to replicate shared spaces across trust boundaries. Users on different servers can collaborate on shared encrypted documents without either server seeing plaintext data.

### Design principles

1. **Home-server-authoritative**: Each shared space has one home server that sequences writes and manages membership. No multi-master.
2. **One protocol**: c2s and s2s share the same WebSocket + CBOR frame format and core sync methods (subscribe, push, pull). c2s adds resource management methods (invitations, spaces, membership, epochs, DEKs). Only auth differs (JWT for c2s, HTTP Signature for s2s).
3. **Servers are dumb pipes**: Servers transport encrypted blobs without understanding their content. The home server stores them; federated servers forward them. CRDTs handle merge on clients.
4. **Opt-in trust**: Federation is off by default. Servers must explicitly trust each other before replicating.
5. **PoW admission control**: Untrusted peers must solve proof-of-work challenges. Trusted peers use quotas only.

### What federates

- **Shared spaces**: Yes. Home server sends live events to federated servers that have members in the space; clients catch up via forwarded pull requests.
- **Personal spaces**: No. Personal data stays on the user's home server.
- **Invitations**: Yes. Routed server-to-server for cross-server invites.
- **Files**: Yes. File metadata forwarded alongside records; encrypted bytes fetched via HTTP from the home server.

---

## 2. Identity

### User identity

Users are identified as `user@domain`:

```
alice@less.so
bob@company.example.com
```

The `@domain` portion identifies the user's home server. The local part is the username on that server. Usernames are public — they are fundamental to the system and designed to be shared freely, like email addresses. Usernames MUST NOT contain null bytes (`\0`) — they are used as field separators in membership entry signatures, and embedded null bytes would shift field boundaries.

Under the hood, each user has a stable P-256 keypair **per app** (OAuth client), identified by a `did:key` in JWT claims. The keypair is generated on first login and recovered on subsequent logins (even from different devices) via an encrypted blob stored in the OAuth grant. The `user@domain` handle is a human-readable layer for discovery and routing; the `did:key` is the cryptographic identity used in UCAN chains and key wrapping. For federation, the same app (same OAuth client ID) must be registered on both servers — the public key exchange is app-scoped.

### Identity resolution

Resolving `user@domain` is a two-step process:

1. **Discover the server**: Fetch `https://domain/.well-known/less-platform` to get all endpoint URLs (including the WebFinger endpoint)
2. **Resolve the user**: Fetch WebFinger at the discovered endpoint

```http
GET https://accounts.company.example.com/.well-known/webfinger?resource=acct:bob@company.example.com
```

```json
{
  "subject": "acct:bob@company.example.com",
  "links": [
    {
      "rel": "https://less.so/ns/sync",
      "href": "https://sync.company.example.com/api/v1"
    }
  ]
}
```

Servers MUST serve all discovery and federation endpoints over HTTPS. The `rel` link points to the server's sync API base URL.

### Identity portability

If a user migrates to a new server:

1. Their per-app `did:key` identities remain the same (keypairs are recovered via the encrypted blob in the OAuth grant)
2. Existing UCAN delegations remain valid (they reference `did:key`, not the domain)
3. The user re-registers as `alice@newserver.com`
4. Space memberships are unaffected — only the routing changes

---

## 3. Discovery

### Server metadata

`/.well-known/less-platform` is the single discovery entry point for federation. It MUST be served from the identity domain (the domain used in `user@domain` identifiers). This is the only endpoint that must be on the identity domain — all other endpoints can live on any host, because the discovery document tells you where to find them.

For self-hosters, this can be a static JSON file served by any web server or reverse proxy — it does not require the sync or accounts services to be on the identity domain.

```http
GET https://example.com/.well-known/less-platform
Cache-Control: max-age=3600
```

```json
{
  "version": 1,
  "federation": true,
  "sync_endpoint": "https://sync.example.com/api/v1",
  "federation_ws": "wss://sync.example.com/api/v1/federation/ws",
  "jwks_uri": "https://sync.example.com/.well-known/jwks.json",
  "webfinger": "https://accounts.example.com/.well-known/webfinger",
  "protocols": ["less-rpc-v1"],
  "pow_required": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | int | Metadata schema version (1) |
| `federation` | bool | Whether this server accepts federation |
| `sync_endpoint` | string | Base URL for the sync API (c2s and s2s) |
| `federation_ws` | string | WebSocket URL for s2s federation connections |
| `jwks_uri` | string | JWKS endpoint for verifying this server's JWTs and federation keys |
| `webfinger` | string | WebFinger endpoint URL (if different from identity domain) |
| `protocols` | string[] | Supported wire protocol versions |
| `pow_required` | bool | Whether untrusted peers must solve PoW |

All URL fields are absolute. This allows services to run on separate subdomains, ports, or even entirely different hosts. The simplest deployment serves everything from one domain; split deployments just set different URLs.

**Caching**: Servers SHOULD return `Cache-Control: max-age=3600` (1 hour). This allows reasonable caching while enabling timely updates during migrations.

### WebFinger

WebFinger (RFC 7033) resolves `user@domain` to a sync endpoint and enables discovering a user's home server for cross-server invitations.

When the `webfinger` field is present in the server metadata, clients and servers MUST use that URL instead of the identity domain's `/.well-known/webfinger`. When absent, WebFinger falls back to the identity domain per RFC 7033.

```http
GET https://accounts.example.com/.well-known/webfinger?resource=acct:bob@example.com
Cache-Control: max-age=300
```

Servers SHOULD return `Cache-Control: max-age=300` (5 minutes) for WebFinger responses. Servers SHOULD rate-limit WebFinger lookups — usernames are public identifiers (like email addresses), but bulk enumeration should be prevented.

---

## 4. Trust model

### Trust levels

| Level | Discovery | Invitations | Replication | PoW required |
|-------|-----------|-------------|-------------|--------------|
| **Trusted** | Full | Allowed | Allowed | No |
| **Known** (open federation) | Full | Allowed | Allowed | Yes, for handshake |
| **Unknown** | WebFinger only | Blocked | Blocked | Yes, for all |

### Trusted relationships

Trust is bilateral — both servers must configure trust for each other. A server's trust configuration:

```yaml
federation:
  enabled: true
  mode: "allowlist"  # "allowlist" (default) or "open"
  trusted_servers:
    - domain: "partner.example.com"
    - domain: "company.example.com"
```

In **allowlist mode** (default), only explicitly trusted servers can federate. In **open mode**, any server with a valid `/.well-known/less-platform` endpoint can initiate federation, subject to PoW admission control.

### Trust establishment

Two server operators establish trust out-of-band (email, config file, admin UI). There is no automatic trust negotiation in v1.

**Shared app registration**: Both servers must register the same OAuth client (same `client_id`) for each app that will be used across servers. This is because cryptographic identity (`did:key`) is per (user, app) — the public key exchange endpoint is app-scoped, and UCANs are bound to a specific app's `did:key`. This is analogous to email clients: both mail servers must support the same protocol for users to communicate.

The verification flow:

1. Admin of server A adds `server-b.example.com` to trusted list
2. Server A fetches `https://server-b.example.com/.well-known/less-platform` to validate
3. Server A fetches the JWKS to cache server B's signing keys
4. Server B does the same for server A
5. Both servers register the same OAuth client IDs for federated apps
6. Federation is active once both sides have completed verification

### Trust revocation

Removing a server from the trusted list:
1. Active WebSocket connections from that server are closed
2. Pending invitations from that server are rejected
3. Live event forwarding for spaces with members on that server stops
4. Clients on the revoked server retain their UCAN credentials and local data

---

## 5. Server-to-server authentication

### HTTP Signatures on WebSocket upgrade

s2s WebSocket connections are authenticated via HTTP Signatures (RFC 9421) on the upgrade request. Each server has an Ed25519 signing keypair published at its JWKS endpoint with `use: "federation"`.

```http
GET /api/v1/federation/ws HTTP/1.1
Host: server-a.example.com
Upgrade: websocket
Connection: Upgrade
Signature-Input: sig=("@method" "@target-uri" "host");keyid="https://server-b.example.com/.well-known/jwks.json#fed-1";alg="ed25519";created=1706745600
Signature: sig=:base64-encoded-signature:
```

The receiving server:
1. Extracts the `keyid` from `Signature-Input`
2. Fetches the JWKS (cached — see JWKS cache policy below)
3. Verifies the signature covers the required components
4. Validates the `created` timestamp is within 5 minutes
5. Completes the WebSocket upgrade if valid

After the upgrade, the connection is trusted for the lifetime of the WebSocket. No per-message signing.

Servers MUST accept signatures from any key in the peer's JWKS that has `use: "federation"`, not just the first one. The `kid` in the JWKS MUST match the fragment in the `keyid` URI (e.g., `#fed-1`). `kid` values MUST be unique and immutable per key.

### JWKS cache policy

JWKS availability is critical — if a peer's JWKS endpoint is unreachable, federation with that peer breaks. To prevent transient outages from cascading:

- **Minimum cache TTL**: 1 hour. Servers MUST NOT re-fetch more frequently than this under normal operation.
- **Stale-while-revalidate**: 24 hours. If a refresh attempt fails, servers MUST continue accepting signatures from cached keys for up to 24 hours.
- **Retry logic**: On fetch failure, retry with exponential backoff (1s, 2s, 4s) with jitter, max 3 retries per attempt.
- **Unknown `kid`**: If a signature references a `kid` not in the cached JWKS, the server SHOULD attempt a single out-of-cycle refresh before rejecting (allows for key rotation discovery).

### Federation key rotation

To rotate a federation signing key without disrupting peers:

1. Generate a new Ed25519 keypair with a new `kid` (e.g., `fed-2`)
2. Add the new key to the JWKS alongside the old key
3. Begin signing with the new key
4. Wait at least **2× the JWKS cache TTL** (e.g., if cache TTL is 1 hour, wait 2 hours) for all peers to discover the new key
5. Remove the old key from the JWKS

Removing the old key before peers refresh their cache will cause all federation connections from this server to fail authentication until the peer caches update. This is the most common cause of federation outages in practice.

### Algorithm note

Federation HTTP Signatures use **Ed25519**, while UCANs use **ES256** (P-256 ECDSA). These serve different purposes:

- **Ed25519** for s2s: faster signatures, smaller keys, widely used in RFC 9421 examples, ideal for server identity
- **ES256** for UCANs: matches the existing `did:key` infrastructure (multicodec `0x1200` for P-256)

The JWKS endpoint serves keys for both algorithms, differentiated by the `use` field:
- `"use": "sig"` — ES256 keys for JWT signing and UCAN validation
- `"use": "federation"` — Ed25519 keys for s2s HTTP Signatures (multicodec `0xED` in `did:key` encoding)

---

## 6. WebSocket protocol

c2s and s2s use the same WebSocket frame protocol. The only differences are:
- **Auth**: c2s authenticates via JWT (query parameter on upgrade). s2s authenticates via HTTP Signature on upgrade.
- **Method subset**: Core sync methods (subscribe, push, pull) work in both contexts. `fed.invitation` is s2s-only. c2s adds resource management methods not relevant to federation.
- **Routing**: s2s connections are space-scoped, not user-scoped. A federated server subscribes to spaces that its local users are members of. When it receives events for a space, it fans them out to its own c2s connections internally — the home server doesn't need to know about individual users on the federated server.

### 6.1 Connection

**c2s:**
```
wss://server.example.com/api/v1/ws?token=<JWT>
```

**s2s:**
```
wss://<federation_ws from discovery document>
(HTTP Signature on upgrade request)
```

The s2s WebSocket URL is discovered from the `federation_ws` field in `/.well-known/less-platform`. Both endpoints accept the WebSocket upgrade and begin the frame protocol.

**Protocol version negotiation**: The `Sec-WebSocket-Protocol` header negotiates the wire protocol version:

```http
Sec-WebSocket-Protocol: less-rpc-v1
```

The server responds with the selected protocol. If the server doesn't support the requested version, it rejects the upgrade with `400 Bad Request`. This allows future protocol versions (`less-cbor-v2`, etc.) without breaking existing clients.

**Max connection lifetime**: Connections are limited to **1 hour**. The server sends a close frame with code `4001` (token expired) when the limit is reached. Clients reconnect with a fresh token and resume via `since` values. This ensures periodic re-authentication and prevents stale authorization from persisting indefinitely. For s2s, the reconnecting server re-signs the upgrade request with a fresh HTTP Signature.

### 6.2 RPC frame format

The protocol uses a generic RPC envelope with four frame types. Every WebSocket message is a single CBOR-encoded object with string keys:

| Type | Name | Direction | Description |
|------|------|-----------|-------------|
| 0 | Request | Client→Server | RPC call expecting a response |
| 1 | Response | Server→Client | Result or error for a request |
| 2 | Notification | Either | Fire-and-forget event |
| 3 | Stream | Server→Client | Streaming data for an in-flight request |

**Request** (type 0):
```cbor
{"type": 0, "method": "<method>", "id": "<request-uuid>", "params": {...}}
```

**Response** (type 1):
```cbor
{"type": 1, "id": "<request-uuid>", "result": {...}}
{"type": 1, "id": "<request-uuid>", "error": {"code": "...", "message": "..."}}
```

**Notification** (type 2):
```cbor
{"type": 2, "method": "<method>", "params": {...}}
```

**Stream** (type 3) — sent during a streaming request, before the final response:
```cbor
{"type": 3, "id": "<request-uuid>", "name": "<stream-name>", "data": {...}}
```

The `id` field correlates requests, stream frames, and responses. Multiple requests can be in-flight concurrently on the same connection. Stream frames are scoped to a specific request via their `id`.

**Keepalive**: A CBOR null byte (`0xF6`) is used as a keepalive frame. Sent every 30 seconds by either side. Receivers MUST silently ignore `0xF6` bytes. WebSocket ping/pong is used for transport-level liveness.

**Forward compatibility**: Receivers MUST ignore unknown string keys in frame objects and unknown method names. Unknown notification methods are silently dropped. Unknown request methods receive an error response.

### 6.3 RPC methods

Methods are grouped by function:

```
Method              Type          Direction     Description
──────              ────          ─────────     ───────────
subscribe           Request       Client/Peer→  Subscribe to spaces (s2s responses include FST)
unsubscribe         Notification  Client→       Unsubscribe from spaces
push                Request       Client/Peer→  Push changes to a space
pull                Request       Client/Peer→  Request entries since cursor (streaming)
token.refresh       Request       Client→       Refresh JWT without reconnecting (c2s only)
fed.invitation      Request       Either        Cross-server invitation (s2s only)

sync                Notification  Server→       New records for a subscribed space
revoked             Notification  Server→       Space access revoked
resubscribe         Notification  Server→       Re-authorization needed for spaces
membership          Notification  Server→       Membership log update for a space
file                Notification  Server→       File metadata for a space

pull.begin          Stream        Server→       Start of pull response for a space
pull.record         Stream        Server→       Individual record in pull response
pull.membership     Stream        Server→       Membership entry in pull response
pull.file           Stream        Server→       File metadata in pull response
pull.commit         Stream        Server→       End of pull response for a space
```

c2s connections also support resource management methods (`invitation.*`, `space.*`, `membership.*`, `epoch.*`, `deks.*`) — these are not relevant to federation and are documented in the sync service API.

Streaming methods (`pull`) send stream frames (type 3) before the final response (type 1). The response signals completion — an empty result means success, an error means failure.

### 6.4 Subscribe

After connecting, the first meaningful frame is a `subscribe` request. It can be sent again at any time to add spaces.

**Request:**
```cbor
{"type": 0, "method": "subscribe", "id": "sub-1", "params": {
  "spaces": [
    {"id": "space-uuid-1", "since": 0, "ucan": "..."},
    {"id": "space-uuid-2", "since": 1547}
  ]
}}
```

**Response:**
```cbor
{"type": 1, "id": "sub-1", "result": {
  "spaces": [
    {"id": "space-uuid-1", "cursor": 1548, "key_generation": 3, "rewrap_epoch": null},
    {"id": "space-uuid-2", "cursor": 42, "key_generation": 1, "rewrap_epoch": null}
  ],
  "errors": [{"space": "bad-uuid", "error": "forbidden"}]
}}
```

The response delivers the **space state** for each successfully subscribed space: current cursor, `key_generation`, and `rewrap_epoch`. This establishes the client's baseline before any cursor stream events arrive.

**Catch-up and interleaving semantics**: The subscription is registered *before* catch-up begins, so no events are missed. The sequence is:

1. Server registers the subscription (events begin buffering in the channel)
2. Server sends catch-up notifications for each space with `since > 0` (sync, membership, file)
3. Server sends `subscribe` response
4. Live events begin flowing

If catch-up data is small enough, it is sent as inline `sync`, `membership`, and `file` notifications. If the data exceeds the WebSocket frame size limit, the server falls back to pull streaming frames (`pull.begin`/`pull.record`/`pull.membership`/`pull.file`/`pull.commit`) which handle backpressure and unbounded data. The client processes both forms identically — the only difference is framing.

Subsequent `subscribe` requests add spaces to the connection without affecting existing subscriptions.

**s2s subscribe and catch-up**: The federated server tracks one **high-water-mark cursor** per subscribed space — the highest cursor value it has observed in live events. This is the only state it maintains (one int64 per space, no record data). On s2s reconnect, the federated server re-subscribes with `since` set to its tracked cursor for each space. The home server sends catch-up events from that point. The federated server broadcasts these catch-up events to all local c2s connections watching that space, then resumes normal live event forwarding. This avoids a thundering herd: instead of N clients each sending individual pull requests to the home server after a connection gap, the federated server does one catch-up and fans out locally.

Individual c2s clients that were offline longer than the s2s connection (their cursor is behind the federated server's tracked cursor) still catch up via forwarded `pull` requests — but this is the uncommon case and does not cause a herd.

**s2s subscribe authorization**: Federated servers use the same `subscribe` method as clients. The server knows the connection type (c2s vs s2s) and behaves accordingly:

- **c2s**: Validates JWT + UCAN, returns space state
- **s2s**: Validates UCAN or FST, returns space state **plus a `token` field** containing a Federation Subscribe Token (FST)

The FST is an opaque, stateless HMAC token that allows the federated server to re-subscribe without holding raw UCANs (which contain identity-revealing `did:key` values). Clients ignore the `token` field (forward compatibility — receivers ignore unknown fields per Section 6.2).

Push forwarding requires a separate per-push UCAN from the actual writing user — the subscription authorization only grants receiving events, not writing.

### 6.4.1 Federation Subscribe Token (FST)

**s2s subscribe response** (extra `token` field compared to c2s):

```cbor
{"type": 1, "id": "sub-1", "result": {
  "spaces": [
    {"id": "space-uuid-1", "cursor": 1548, "key_generation": 3, "rewrap_epoch": null, "token": "base64url-encoded-FST"}
  ],
  "errors": [{"space": "bad-uuid", "error": "forbidden"}]
}}
```

**s2s subscribe request with FST** (reconnect, no UCAN needed):

```cbor
{"type": 0, "method": "subscribe", "id": "sub-2", "params": {
  "spaces": [
    {"id": "space-uuid-1", "token": "base64url-encoded-FST", "since": 1548}
  ]
}}
```

Each space provides `ucan`, `token`, or neither (personal space). If both are present, `ucan` takes precedence (upgrade path). The home server verifies the FST (stateless HMAC check), reactivates the subscription, and returns a refreshed FST.

**Proxy flow**: When a client on Server B subscribes to a space homed on Server A, Server B forwards the `subscribe` to Server A. Server A returns the response with a `token` field. Server B reads and stores the FST, then forwards the full response to the client (the client ignores the `token` field). No response stripping or tampering.

**Token upgrade**: When a new client subscribes to a space that already has an active s2s subscription, Server B forwards the new UCAN to Server A. Server A returns a fresh FST. Server B replaces its stored token if the new one has a later expiry. Server B does not inspect or compare UCANs — it always forwards them and lets Server A decide the token expiry.

**FST structure:**

```
FST = version(1) || nonce(16) || space_id(16) || peer_domain_hash(32) || expires(8) || hmac(32)
```

| Field | Size | Description |
|-------|------|-------------|
| `version` | 1 byte | Token format version (`0x01`) |
| `nonce` | 16 bytes | Random bytes for non-determinism |
| `space_id` | 16 bytes | UUID of the subscribed space |
| `peer_domain_hash` | 32 bytes | SHA-256 of the canonicalized peer domain |
| `expires` | 8 bytes | Unix timestamp, big-endian int64 |
| `hmac` | 32 bytes | HMAC-SHA256 over all preceding fields |

Total: 105 bytes, base64url-encoded (~140 chars).

The HMAC key is derived from `SPACE_SESSION_SECRET` via domain separation: `fst_key = HMAC-SHA256(SPACE_SESSION_SECRET, "fst-key-v1")`. This prevents cross-protocol interactions with session tokens that use the same base secret.

**FST expiry:** `min(ucan_expiry, now + 24h)`. The token never outlives the UCAN that authorized it, and is capped at 24 hours.

**Domain canonicalization:** Peer domains are canonicalized before hashing: lowercase, no trailing dot, no port if default (443), no scheme. Applied at both creation and verification.

**Stateless verification:** The home server verifies an FST by recomputing the HMAC and comparing (constant-time). No database storage or lookup is needed.

**FST expiry sweep:** The home server runs a periodic sweep (e.g., every minute) over active s2s subscriptions. When an FST expires, the home server drops the subscription and sends a `resubscribe` notification (Section 6.4.2). This is cheap (one pass over in-memory subscriptions) and ensures no subscription outlives its authorization, regardless of connection lifetime.

**Security properties:**

- No PII on federated server — FST is opaque HMAC blob, no `did:key` or identity info
- No forgery — HMAC-SHA256 with derived 32-byte key
- No cross-peer replay — `peer_domain_hash` binding
- No cross-space replay — `space_id` binding
- Non-deterministic — random nonce prevents token prediction
- Bounded authorization — 24h max, never outlives authorizing UCAN
- Forward secrecy on revocation — revoked members lose space keys after key rotation; even if FST is honored briefly, encrypted blobs are unreadable

**HMAC key rotation:** To rotate `SPACE_SESSION_SECRET` without disrupting federation, support dual-key validation during the transition: verify with the new key first, fall back to the old key. Remove the old key after 24 hours (all outstanding FSTs will have expired). This mirrors the JWKS key rotation pattern in Section 5.

### 6.4.2 Resubscribe notification

The `resubscribe` notification tells a connection that re-authorization is needed for one or more spaces:

```cbor
{"type": 2, "method": "resubscribe", "params": {"spaces": ["space-uuid-1", "space-uuid-2"]}}
```

Used in two contexts:

1. **Home server → federated server (s2s):** An FST expired or was invalidated. The federated server must obtain a fresh UCAN from a local client and send a new `subscribe`.

2. **Federated server → client (c2s):** The federated server needs a client to re-subscribe (providing its UCAN) so the server can re-authorize with the home server.

**Client handling is minimal:**

```ts
case "resubscribe":
  this.subscribe(params.spaces) // re-subscribes with fresh UCANs
```

**Failure path:** When Server B receives `resubscribe` from Server A, it forwards the notification to all local clients subscribed to those spaces. If a client re-subscribes (providing a UCAN), Server B uses it to send a fresh `subscribe` to Server A. If no client responds (all offline, all UCANs expired), the subscription simply lapses — Server B does not retry. The space becomes inactive until a client reconnects and subscribes.

### 6.5 Unsubscribe

```cbor
{"type": 2, "method": "unsubscribe", "params": {"spaces": ["space-uuid-1"]}}
```

Sent as a notification (fire-and-forget). No response. The server immediately stops sending events for those spaces. Clients MUST silently discard any events for unsubscribed spaces that were in-flight at the time of unsubscription.

### 6.6 Space state and cursor stream

Sync uses a two-layer model:

1. **Space state** — a snapshot of the space's current configuration, delivered on the `subscribe` response, `pull.begin`, and sync event frames. This includes `key_generation`, `rewrap_epoch`, and other space-level metadata. The client uses this to know the current epoch for encrypting new records and to detect in-progress key rotations. Space state is not history — it's always the latest value.

2. **Cursor stream** — an ordered log of data changes (records, membership entries, files). Every mutation to a space increments a single monotonic counter called the **cursor**. All data types share this counter. Clients track one cursor value per space and pass it as `since` to resume from where they left off.

This separation is deliberate. Space state (like the current epoch) doesn't need history — the client only cares about the current value, and each record's wrapped DEK is self-describing (the epoch is encoded as a 4-byte big-endian prefix on the 44-byte wrapped DEK). Data changes need ordered history because the client must process every change to converge on the correct state.

The cursor guarantees ordering by construction. A membership entry at cursor 47 is naturally delivered before the record at cursor 48 that depends on it. No special ordering logic is needed — the cursor defines the total order.

**Schema design**: Each synced data table (`records`, `members`, `files`) has a `cursor` column. When the server performs a mutation, it increments `spaces.cursor` and assigns the new value to the row being inserted/updated. The catch-up query is a UNION ALL across these tables ordered by cursor. No separate log table is needed — the cursor values on the data tables provide the unified timeline.

**Tombstone policy**: Deletions use tombstones — the row is marked `deleted = true` and its data is zeroed, but the row is retained in the table. Zeroing ensures ciphertext and key material are purged from the database, not just dereferenced. This is a direct consequence of the cursor stream: if a row were physically deleted, catching-up clients would see a gap in the cursor timeline and never learn the deletion happened. All synced data tables (`records`, `files`) use explicit `deleted` booleans. Membership entries are append-only by design and don't need tombstones — a member revocation is an append to the hash chain, not a deletion.

### 6.6.1 Sync events

Sent by the server as a `sync` notification when a space the connection is subscribed to receives new records (or deletions):

```cbor
{"type": 2, "method": "sync", "params": {
  "space": "space-uuid",
  "prev": 1547,
  "cursor": 1548,
  "key_generation": 3,
  "rewrap_epoch": null,
  "records": [
    {"id": "record-uuid", "blob": <bytes>, "cursor": 1548, "dek": <bytes>},
    {"id": "record-uuid-2", "deleted": true, "cursor": 1548}
  ]
}}
```

Both records share cursor 1548 (they were pushed together). The outer `cursor` field is the space's current cursor after this sync event. `key_generation` and `rewrap_epoch` reflect the space's current epoch state (see section 6.6.3). Deleted records omit `blob` and `dek` — the `deleted: true` flag tells the client to remove the record locally.

All records in a push share the same cursor value (the space cursor after the push). Conflict detection is per-record: each record in the push carries its expected cursor, and the server compares against the record's current cursor in the database.

Same format for c2s and s2s. The federated server forwards events from the home server to its local clients' c2s connections.

**Live sync vs pull framing**: Live `sync` notifications bundle all records from a push into a single frame for atomicity — the client processes them as one unit. Pull responses use individual `pull.record` stream frames streamed between `pull.begin`/`pull.commit` markers, which allows backpressure and bounded memory on large catch-ups. The record fields are the same in both; only the framing differs.

### 6.6.2 Membership log events

Sent by the server as a `membership` notification when the membership log for a subscribed space is updated (new delegation, acceptance, revocation, etc.):

```cbor
{"type": 2, "method": "membership", "params": {
  "space": "space-uuid",
  "cursor": 1547,
  "entries": [
    {"chain_seq": 5, "prev_hash": <bytes>, "entry_hash": <bytes>, "payload": <bytes>}
  ]
}}
```

`chain_seq` is the entry's position in the membership hash chain (1, 2, 3...). This is separate from `cursor` — `chain_seq` is for hash chain integrity validation, `cursor` is for ordering in the unified timeline.

The `payload` is the encrypted membership entry (opaque to the server). Clients decrypt it using the space key to extract the UCAN, entry type, wrapped KEKs, and other membership data.

For s2s, the home server sends membership log entries to all federated servers subscribed to the space. Federated servers forward them to their local clients.

### 6.6.3 Epoch state (space state layer)

Epoch information is part of the space state layer, not the cursor stream. `key_generation` and `rewrap_epoch` are delivered on space-level frames (the `subscribe` response, `pull.begin`, sync events) as current values. Epoch state lives entirely on the `spaces` row — no separate epoch table is needed.

The client determines which epoch a record was encrypted under by reading the 4-byte big-endian epoch prefix on the 44-byte wrapped DEK. This makes records self-describing — the client derives the correct KEK via its HKDF chain without needing the server to tell it which epoch each record belongs to.

The typical member removal flow:

```
cursor 1547: record (normal activity)
cursor 1548: membership (revocation entry for removed member)
cursor 1549: membership (remaining member re-encrypted under new key)
cursor 1550: record (encrypted under new epoch)
```

The membership entries at 1548-1549 are cursor stream events — they deliver the new wrapped KEKs to remaining members. Records at 1550+ carry wrapped DEKs with the new epoch prefix. The `key_generation` on subsequent space-level frames reflects the advanced epoch.

### 6.6.4 File events

Sent by the server as a `file` notification when file metadata is added to a space. File uploads happen after the push transaction, so the file's cursor value will be after the record that references it.

```cbor
{"type": 2, "method": "file", "params": {
  "space": "space-uuid",
  "cursor": 1549,
  "files": [
    {"id": "file-uuid", "record_id": "record-uuid", "size": 2048576, "dek": <bytes>},
    {"id": "file-uuid-2", "record_id": "record-uuid", "deleted": true}
  ]
}}
```

This delivers file metadata (existence, size, wrapped DEK) — not the file bytes themselves. Clients fetch the actual file content lazily via the HTTP file endpoint, or eagerly if they want full offline availability. Deleted files omit `size` and `dek` — the `deleted: true` flag tells the client to remove the file locally.

All files in the same request share the same cursor value (same batching rule as records). The `record_id` links the file to the record that references it.

For s2s, the home server sends file metadata to all federated servers subscribed to the space. Federated servers forward it to their local clients.

### 6.7 Push

Client pushes changes to a space via the `push` RPC method. For s2s, this is how a federated server forwards its clients' writes to the home server.

**Request:**
```cbor
{"type": 0, "method": "push", "id": "push-1", "params": {
  "space": "space-uuid",
  "ucan": "...",
  "changes": [
    {"id": "record-uuid", "blob": <bytes>, "expected_cursor": 1548, "dek": <bytes>}
  ]
}}
```

**Response (success):**
```cbor
{"type": 1, "id": "push-1", "result": {
  "ok": true,
  "cursor": 1549
}}
```

**Response (conflict):**
```cbor
{"type": 1, "id": "push-1", "result": {
  "ok": false,
  "error": "conflict",
  "cursor": 1550
}}
```

The `id` field correlates requests with responses, enabling concurrent pushes to different spaces on the same connection. If a push succeeds but the response is lost (e.g., connection drops), the client will see a conflict on retry because its `expected_cursor` no longer matches. This is the correct behavior — the client should pull, CRDT-merge (which is idempotent), and retry with the updated cursor.

**Conflict semantics**: Pushes use cursor-based optimistic concurrency. Each record carries an `expected_cursor` — the cursor value the client last saw for this record (0 for new records). The server compares this against the record's current cursor in the database. On mismatch, the *entire push is rejected* — all-or-nothing, transactional. The client must pull to get the latest state, re-merge via CRDTs, and retry.

**Self-notification exclusion**: The server does NOT send a `sync` notification back to the connection that pushed the changes (exclusion by connection ID).

**Federation push forwarding**: When a federated server forwards its clients' writes to the home server, the home server validates the push independently — UCAN authorization, cursor values, blob sizes. The forwarding server's identity is not trusted for authorization; only the UCAN chain matters.

**Push forwarding is synchronous**: The federated server acts as a transparent proxy — it forwards the push to the home server over the s2s WebSocket and blocks until it receives the response. The home server's result (ok or conflict) is then returned to the local client. This means c2s push latency includes the s2s round-trip, but keeps the client protocol unchanged and avoids split-brain ambiguity about whether a push succeeded.

### 6.8 Pull

Multiplexed pull over the WebSocket via the `pull` streaming RPC method.

**Request:**
```cbor
{"type": 0, "method": "pull", "id": "pull-1", "params": {
  "spaces": [
    {"id": "space-uuid-1", "since": 0, "ucan": "..."},
    {"id": "space-uuid-2", "since": 1547}
  ]
}}
```

**Stream frames** (interleaving all data types in cursor order within each space):
```cbor
{"type": 3, "id": "pull-1", "name": "pull.begin",      "data": {"space": "space-uuid-1", "prev": 0, "cursor": 7, "key_generation": 3, "rewrap_epoch": null}}
{"type": 3, "id": "pull-1", "name": "pull.membership",  "data": {"space": "space-uuid-1", "cursor": 1, "entries": [{"chain_seq": 1, ...}]}}
{"type": 3, "id": "pull-1", "name": "pull.record",      "data": {"space": "space-uuid-1", "id": "record-1", "blob": <bytes>, "cursor": 2, "dek": <bytes>}}
{"type": 3, "id": "pull-1", "name": "pull.record",      "data": {"space": "space-uuid-1", "id": "record-2", "blob": <bytes>, "cursor": 3, "dek": <bytes>}}
{"type": 3, "id": "pull-1", "name": "pull.membership",  "data": {"space": "space-uuid-1", "cursor": 4, "entries": [{"chain_seq": 2, ...}]}}
{"type": 3, "id": "pull-1", "name": "pull.membership",  "data": {"space": "space-uuid-1", "cursor": 5, "entries": [{"chain_seq": 3, ...}]}}
{"type": 3, "id": "pull-1", "name": "pull.record",      "data": {"space": "space-uuid-1", "id": "record-3", "blob": <bytes>, "cursor": 6, "dek": <bytes>}}
{"type": 3, "id": "pull-1", "name": "pull.file",        "data": {"space": "space-uuid-1", "id": "file-1", "record_id": "record-3", "size": 2048576, "dek": <bytes>, "cursor": 7}}
{"type": 3, "id": "pull-1", "name": "pull.commit",      "data": {"space": "space-uuid-1", "prev": 0, "cursor": 7, "count": 7}}
{"type": 3, "id": "pull-1", "name": "pull.begin",       "data": {"space": "space-uuid-2", "prev": 1547, "cursor": 1549, "key_generation": 1, "rewrap_epoch": null}}
{"type": 3, "id": "pull-1", "name": "pull.record",      "data": {"space": "space-uuid-2", "id": "record-4", "blob": <bytes>, "cursor": 1548, "dek": <bytes>}}
{"type": 3, "id": "pull-1", "name": "pull.file",        "data": {"space": "space-uuid-2", "id": "file-2", "record_id": "record-4", "size": 512000, "dek": <bytes>, "cursor": 1549}}
{"type": 3, "id": "pull-1", "name": "pull.commit",      "data": {"space": "space-uuid-2", "prev": 1547, "cursor": 1549, "count": 2}}
```

**Final response** (signals completion):
```cbor
{"type": 1, "id": "pull-1", "result": {}}
```

Every stream frame carries its own `space` field — frames are self-describing. The pull stream interleaves `pull.membership`, `pull.record`, and `pull.file` frames in cursor order within each space. `pull.begin` carries the space's current state (`key_generation`, `rewrap_epoch`). The example shows: initial membership at cursor 1, records at cursors 2-3, membership updates at cursors 4-5 (member changes), a record at cursor 6, and a file upload at cursor 7.

**Ordering constraints**: Pull responses for different spaces within a single pull request are serialized — all stream frames for space A (`pull.begin` through `pull.commit`) are sent before space B begins. Pull stream frames from different concurrent pull requests MUST NOT interleave at the record level.

The `count` in `pull.commit` is the number of **stream frames** sent between `pull.begin` and `pull.commit` (all types combined). A membership frame with multiple entries in its `entries` array counts as one frame.

Same transactional commit rule: entries for a space are discarded unless a matching `pull.commit` is received with the correct count.

> **Future improvement**: `pull.commit` could include a rolling hash of entry IDs for stronger integrity verification. For v1, the `count` field is sufficient given TLS transport security.

**Cursor rollback detection**: If a `since` value exceeds the space's current cursor (e.g., after a home server backup restore), the server responds with an error:

```cbor
{"type": 1, "id": "pull-1", "error": {"code": "cursor_ahead", "message": "since 1548 exceeds current cursor 1200"}}
```

On receiving `cursor_ahead`, the client (or federated server) MUST reset its cursor and re-pull with `since: 0` to converge on the restored state. See Section 13, "Home server restored from backup."

### 6.9 Token refresh (c2s only)

Clients refresh their JWT without disconnecting via the `token.refresh` RPC method:

**Request:**
```cbor
{"type": 0, "method": "token.refresh", "id": "tok-1", "params": {"token": "<new-jwt>"}}
```

**Response (success):**
```cbor
{"type": 1, "id": "tok-1", "result": {"ok": true}}
```

**Response (failure):**
```cbor
{"type": 1, "id": "tok-1", "result": {"ok": false, "error": "invalid_token"}}
```

The server validates the new token and responds. On success, the connection's auth context is updated — all subsequent frames are processed under the new token. On failure, the server sends the error response and then closes the connection with close code `4001`. The explicit response prevents ambiguity about which auth context is active. Clients SHOULD wait for the response before sending frames that depend on the new token's permissions.

### 6.10 Cross-server invitations (s2s only)

**Request:**
```cbor
{"type": 0, "method": "fed.invitation", "id": "inv-1", "params": {
  "sender": "alice@server-a.com",
  "recipient": "bob@server-b.com",
  "space_id": "space-uuid",
  "home_server": "server-a.com",
  "wrapped_space_key": <bytes>,
  "delegation_ucan": "...",
  "key_fingerprint": <bytes>
}}
```

The `key_fingerprint` is the full 32-byte `SHA-256` hash of the recipient's **33-byte SEC1 compressed P-256 public key** (`0x02` or `0x03` prefix byte + 32-byte X coordinate). Not the `did:key` string — the raw compressed point bytes. The recipient verifies this matches their own key to detect key substitution (see Section 7, Key confirmation).

**Response:**
```cbor
{"type": 1, "id": "inv-1", "result": {"status": "delivered"}}
```

Status values: `"delivered"`, `"rejected"` (untrusted, rate-limited), `"not_found"` (user doesn't exist).

### 6.11 Keepalive

WebSocket has native ping/pong for connection health. Application-level keepalive uses a CBOR null byte (`0xF6`) — not an RPC frame:

```
0xF6
```

Sent every 30 seconds by either side. Receivers MUST silently ignore this byte. This is simpler than wrapping keepalive in an RPC envelope and allows zero-allocation handling.

### 6.12 Reconnection

On disconnect, the reconnecting party includes `since` values in its subscribe request to resume from where it left off. For c2s, the client sends `subscribe` with UCANs. For s2s, the federated server sends `subscribe` with its stored FSTs (no client interaction needed). The catch-up mechanism handles the gap.

**Backoff strategy**:
- Close code `1001` (Going Away): Reconnect immediately with no backoff. This code indicates an intentional server shutdown (e.g., rolling restart, graceful upgrade), not an error.
- Close code `4001` (Token Expired): Reconnect immediately with a fresh token. This is the normal max-lifetime timeout.
- All other close codes: Exponential backoff — 1s, 2s, 4s, 8s, ... up to 60s max, with jitter.

### 6.12.1 Revoked

The server sends a `revoked` notification when a client's access to a space is revoked (UCAN revoked, membership removed, or trust revoked for s2s):

```cbor
{"type": 2, "method": "revoked", "params": {"space": "space-uuid", "reason": "ucan_revoked"}}
```

Reason values: `"ucan_revoked"`, `"membership_removed"`, `"trust_revoked"` (s2s only). The server unsubscribes the connection from the space immediately after sending this notification.

### 6.13 WebSocket close codes

| Code | Name | Description |
|------|------|-------------|
| 1000 | Normal | Clean shutdown |
| 1001 | Going Away | Server shutting down |
| 4000 | Auth Failed | JWT/HTTP Signature validation failed on upgrade |
| 4001 | Token Expired | JWT expired or max connection lifetime reached; reconnect with fresh token |
| 4002 | Forbidden | Server not in trust list or federation disabled |
| 4003 | Too Many Connections | Per-mailbox or per-peer connection limit exceeded |
| 4004 | PoW Required | Missing or invalid proof-of-work solution |
| 4005 | Protocol Error | Invalid frame format, unknown frame type, or protocol violation |
| 4006 | Slow Consumer | Too many dropped events; client cannot keep up |
| 4007 | Rate Limited | Per-peer quota exceeded |

### 6.14 UCAN authorization in requests

Space-scoped RPC methods carry UCANs for authorization, following UCAN 0.10.0 semantics. This includes `subscribe`, `push`, and `pull` (plus c2s management methods not covered here). The server validates the full UCAN chain for each space:

1. **Chain structure**: Each UCAN's `iss` matches the parent's `aud` (`did:key` format)
2. **Root verification**: The chain root's `iss` matches the space's `root_public_key`
3. **Permission attenuation**: Permissions can only narrow (`admin` → `write` → `read`), never widen
4. **Expiry**: All tokens in the chain must be unexpired
5. **Revocation**: Checked at every level via the revocation list
6. **Resource match**: The `with` field must match the space being accessed
7. **Max depth**: Chain depth is limited to 8 delegations

**s2s authorization**: The federated server always includes the full UCAN chain from its member client. The home server validates the chain directly — it does not trust the federated server's authorization judgment.

---

## 7. Cross-server invitations

Invitations are routed server-to-server over the federation WebSocket. This aligns invitation delivery with the trust model — you can only invite users on trusted servers.

### Flow

```
Alice (alice@server-a.com) invites Bob (bob@server-b.com) to a space:

1. Alice's client resolves bob@server-b.com via WebFinger
   → discovers server B's sync endpoint

2. Alice's client checks trust:
   GET /api/v1/federation/trusted → includes server-b.com? ✓

3. Alice's client fetches Bob's public key for this app
   (server A requests from server B via s2s, scoped to the shared client_id)

4. Alice's client wraps the space key for Bob's did:key
   (ECDH + AES-KW, same as JWE key wrapping)

5. Alice's client submits invitation to server A via WebSocket RPC:
   method "invitation.create"
   {
     "mailbox_id": "...",
     "payload": <encrypted invitation bytes>
   }

6. Server A routes to server B via federation WebSocket:
   RPC request: method "fed.invitation"

7. Server B derives the `mailbox_id` for Bob (same HMAC-SHA256
   derivation used for local invitations, using the recipient's
   identity hash) and stores the invitation in its local
   `invitations` table. Server B notifies Bob via c2s WebSocket:
   notification: method "invitation"

8. Server B responds:
   RPC response: {"status": "delivered"}

9. Bob's client fetches invitation from server B via WebSocket RPC
   (invitation.list / invitation.get)
   Bob accepts → unwraps space key → joins space
   Server B subscribes to this space on server A's federation WebSocket
```

### Key confirmation

The invitation includes a `key_fingerprint` — a SHA-256 hash of the recipient's 33-byte SEC1 compressed P-256 public key as seen by the sender. The recipient's client computes the same hash over their own compressed public key and compares. If they don't match, the invitation MUST be rejected (the key was substituted in transit). This binds the wrapped space key to the intended recipient, complementing the signed key assertions from the public key exchange.

### Client-side key wrapping

The ECDH key wrapping for cross-server invitations (`ECDH-ES+A256KW`) MUST happen on the **inviting client**, never on a server. The space key never leaves the client — servers only transport the resulting JWE ciphertext. Server A acts as a proxy to fetch Bob's public key from server B (via s2s, scoped to the app's `client_id`), but the actual ECDH agreement and AES key wrapping are performed locally on Alice's device.

### Invitation routing

**Servers route invitations, not clients.** The client submits a cross-server invitation to its own server, which forwards it. This:

- Enforces trust at the server level (untrusted server → invitation blocked)
- Keeps the client protocol simple (same `invitation.create` RPC method)
- Enables server-side rate limiting on cross-server invitations
- Avoids clients needing direct connectivity to foreign servers

### Public key exchange

For Alice to wrap the space key for Bob, she needs Bob's public key for the app they share. Since keys are per (user, app) and the same OAuth client ID is registered on both servers, the endpoint is app-scoped:

```http
GET /api/v1/federation/users/{username}/keys?client_id={clientId}
(s2s authenticated via HTTP Signature)
```

```json
{
  "username": "bob",
  "client_id": "com.example.todo",
  "did": "did:key:z6Mk...",
  "public_key_jwk": { ... },
  "signed_assertion": "base64url..."
}
```

The response returns Bob's stable `did:key` for the specified app. This is the same key regardless of which device Bob is logged in on — the keypair is recovered from the server-stored encrypted blob on each login (see Section 2).

Usernames are public identifiers, so exposing them via this endpoint is by design. The endpoint SHOULD be rate-limited to prevent bulk scraping. It MUST NOT reveal social graph information (which spaces a user belongs to, who they communicate with, etc.).

**Prerequisite**: The same OAuth client (same `client_id`) must be registered on both servers. This is analogous to email — both servers must support the same "app" for users to collaborate within it.

### Signed key assertions (TOFU verification)

The `signed_assertion` is a self-signed JWT proving the user controls the `did:key`:

```json
{
  "iss": "did:key:z6Mk...",
  "sub": "bob@server-b.com",
  "iat": 1706745600,
  "exp": 1738281600
}
```

Signed with the private key corresponding to the `did:key`. This allows the inviting client to verify that the public key genuinely belongs to the claimed identity, preventing the federated server from substituting a key it controls (trust-on-first-use). Clients MUST cache signed assertions and compare them across interactions — a changed key for the same `user@domain` + `client_id` pair MUST trigger a visible warning to the user. Without persistent key caching, TOFU provides zero protection against repeated key substitution by a malicious server.

**TOFU limitation**: On first contact with a federated user, there is no way to distinguish a genuine key from one substituted by a malicious home server. The signed assertion only proves "whoever controls this key claims to be bob@server-b.com" — it does not prove the home server is honest about which key belongs to Bob. For high-security spaces, users SHOULD verify keys out-of-band (e.g., compare `did:key` fingerprints in person or over a trusted channel). This is the same bootstrapping limitation shared by SSH, Signal (before safety number verification), and most federation protocols.

---

## 8. Replication lifecycle

### Creating a replication agreement

When a user on server B joins a space homed on server A:

1. Client on server B subscribes to the space (c2s `subscribe` with UCAN)
2. Server B detects the space is homed on server A
3. Server B sends `subscribe` to server A with the client's UCAN
4. Server A validates the UCAN chain, creates the subscription, returns an FST (Section 6.4.1)
5. Server B stores the FST in memory and begins forwarding live events to local clients
6. The joining client catches up via a `pull` request forwarded through server B to server A

### State tracking

**Home server (Server A):** Active subscriptions tracked in the broker (in-memory). FST verification is stateless — no per-subscription database state.

**Federated server (Server B):** Per-space state, all in memory:

```
space: "abc-123"
tracked_cursor: 1548      // high-water-mark for catch-up on reconnect
fst: "base64url..."       // opaque FST for re-subscribing without client UCANs
```

This is lost on restart and rebuilt from client re-subscriptions. No record data is stored.

### Event forwarding and client catch-up

The federated server is a transparent proxy — it does not store space data. Three event flows:

1. **Live events** (broadcast forwarding): When the home server sends a `sync`, `membership`, or `file` notification over the s2s connection, the federated server updates its tracked cursor and fans the event out to all local c2s connections subscribed to that space.

2. **s2s catch-up** (after reconnect): On s2s reconnect, the federated server re-subscribes with its FSTs and tracked cursors (`since` values). The home server sends catch-up events from each cursor. The federated server broadcasts these to all local clients — clients that already have some of this data safely ignore duplicates (CRDTs are idempotent). This is O(1) catch-up requests to the home server regardless of the number of local clients.

3. **Individual client catch-up** (pull forwarding): When a single c2s client reconnects and its cursor is behind what live events have covered, it sends a `pull` request forwarded through the federated server. This is the uncommon case — it only happens when the client was offline longer than the s2s connection.

### Re-authorization

Two scenarios require the federated server to re-authorize a subscription:

**FST expiry:** The home server's periodic sweep detects an expired FST and sends a `resubscribe` notification (Section 6.4.2). The federated server forwards this to its local clients. If a client re-subscribes with a valid UCAN, the federated server sends a fresh `subscribe` (including `since: <tracked_cursor>` to avoid an event gap). If no client responds, the subscription lapses.

**Membership revocation:** When a member is revoked from a space, the home server checks if the federated peer still has any active members. If none remain, it sends a `revoked` notification and drops the subscription. If other members remain, the subscription continues — the FST is not tied to a specific member's UCAN.

### Tearing down replication

Replication stops when:
- All members from the federated server leave the space → server sends `unsubscribe`
- The federated server is removed from the trust list → WebSocket is closed
- The FST expires and no client re-authorizes → subscription lapses
- Either server sends `unsubscribe` for the space

After replication stops, the federated server stops forwarding events and pushes for the space. Clients retain their local data (CRDTs in IndexedDB) for offline access but cannot sync until re-invited via a different trusted path.

---

## 9. Spam and abuse mitigation

### PoW admission control

Proof-of-work as an admission valve for untrusted peers. This aligns with Less Platform's existing CAP (proof-of-work CAPTCHA) infrastructure.

| Operation | Trusted peer | Known/open peer | Unknown peer |
|-----------|-------------|-----------------|-------------|
| Federation handshake | No PoW | PoW required | PoW required |
| WebFinger lookup | No limit | Rate limited | Rate limited |
| Space replication | Quotas only | PoW + quotas | Blocked |
| Cross-server invitation | Quotas only | PoW per invitation | Blocked |
| Public key lookup | Rate limited | PoW required | Blocked |

### PoW challenge flow

Before opening a federation WebSocket, unknown/open peers must solve a challenge:

```http
POST /api/v1/federation/challenge
{"server": "server-b.example.com"}
```

```json
{"challenge": "random-bytes", "difficulty": 20, "algorithm": "sha256", "expires": 1706832000}
```

The solution is included as a query parameter on the WebSocket upgrade:

```
wss://server-a.example.com/api/v1/federation/ws?pow_challenge=...&pow_nonce=12345678
```

Difficulty scales with server load. Trusted peers skip this entirely.

**Replay protection**: Each challenge includes a unique `challenge` nonce and an `expires` timestamp. The server tracks used challenge nonces until expiry (short-lived, typically 5 minutes). A solved challenge cannot be reused — the server rejects duplicate nonce submissions.

### Per-peer quotas

Even trusted peers have quotas to prevent runaway replication:

| Resource | Default quota | Configurable |
|----------|--------------|-------------|
| Spaces per peer | 1000 | Yes |
| Records per space per hour | 10,000 | Yes |
| Bytes per space per hour | 100 MB | Yes |
| Invitations per hour | 100 | Yes |
| Concurrent WebSocket connections | 3 | Yes |

Exceeding quotas triggers backpressure (slowed frame delivery) or temporary rejection, not disconnection.

**Connection multiplexing**: Implementations SHOULD use a single s2s WebSocket connection per peer for all spaces. The subscribe/push/pull frame protocol is designed for multiplexing across spaces on one connection. The 3-connection limit exists to handle reconnection overlap and parallel bulk pulls, not routine operation.

### Abuse response

Servers SHOULD implement:
- **Per-peer bandwidth accounting**: Track bytes sent/received per federated peer
- **Anomaly detection**: Alert on sudden replication volume spikes
- **Quarantine mode**: Temporarily pause replication from a peer pending admin review
- **Reputation scoring**: Track reliability (uptime, valid requests vs errors) for open federation peers

---

## 10. Client protocol (implemented)

The c2s protocol uses the same WebSocket RPC protocol described in Section 6. Clients connect to `WS /api/v1/ws` with JWT auth and use the `less-rpc-v1` subprotocol. c2s shares the core sync methods (subscribe, push, pull, token refresh) with s2s and adds resource management methods (invitations, spaces, membership, epochs, DEKs) that are not relevant to federation.

The only HTTP endpoints are file upload/download/head (`PUT/GET/HEAD /api/v1/spaces/{spaceID}/files/{id}`), which use streaming binary and don't benefit from RPC framing.

---

## 11. Encryption across federation

### Key hierarchy glossary

The encryption system uses three layers of keys:

- **Space root key**: The original AES-256 key generated when the space is created. Used to derive epoch KEKs.
- **Epoch KEK** (Key Encryption Key): Derived per-epoch via HKDF from the space root key (or generated fresh on key rotation). Wraps per-record DEKs. Each `key_generation` increment on the server corresponds to a new epoch with a new KEK.
- **Per-record DEK** (Data Encryption Key): Random AES-256-GCM key generated per-record. Encrypts the record blob. The DEK is wrapped (AES-KW) with the current epoch KEK and stored alongside the record as 44 bytes.

`key_generation` (server counter), epoch (client concept), and KEK all advance together. When the server reports `key_generation: 3`, the client uses the epoch 3 KEK to unwrap DEKs.

### Principle: servers never have keys

Federated servers forward encrypted blobs between the home server and their local clients. They never see plaintext, never hold encryption keys, and never participate in key exchange. Key distribution is client-to-client, using servers as transport.

### Cross-server key distribution

When Alice invites Bob across servers:

1. Alice's client gets Bob's `did:key` (P-256 public key) via the app-scoped public key exchange endpoint
2. Alice wraps the space key: `ECDH-ES+A256KW(bob_pubkey, space_key)` → wrapped key bytes
3. The wrapped key travels as part of the invitation payload
4. Bob's client unwraps with its private key

This is the same JWE key wrapping mechanism used for local key delivery, but peer-to-peer instead of server-to-client.

### Key rotation across federation

When a space key rotates (member removal):

1. Rotating member's client generates new epoch KEK
2. Re-wraps all record DEKs: `unwrap(old_KEK) → wrap(new_KEK)` — cost is O(n × 44 bytes)
3. Wraps new KEK for each remaining member's `did:key`
4. Pushes wrapped keys via membership log
5. Home server sends the membership log update to all federated servers
6. Federated members' clients receive the new wrapped KEK and re-derive

No server (home or federated) ever sees the plaintext KEK or DEK.

### File encryption

Files use the same envelope encryption as records. File DEKs are wrapped with the space KEK. File metadata (id, size, wrapped DEK) is delivered in the unified cursor stream alongside records and membership entries. The encrypted file bytes are fetched separately via HTTP.

**Federated file access**: Clients on a federated server fetch files through their own server, which proxies the request to the home server with s2s authentication. Clients MUST NOT connect directly to the home server for file operations — this would leak the client's IP address to the home server operator, breaking the privacy boundary that the federated server provides. The federated server exposes the same file HTTP endpoints (`PUT/GET/HEAD /api/v1/spaces/{spaceID}/files/{id}`) and forwards requests to the home server. No re-encryption is needed — the encrypted bytes pass through as-is.

---

## 12. Metadata exposure

Federation necessarily exposes some metadata. Being explicit about what leaks:

| Metadata | Home server | Federated server | Clients |
|----------|-------------|------------------|---------|
| Space existence | Yes | Yes (spaces it forwards for) | Yes (spaces they're in) |
| Space membership | Yes | Yes (spaces it forwards for) | Yes (spaces they're in) |
| Record count per space | Yes | Yes | Yes |
| Record sizes | Yes | Yes | Yes |
| Push/pull timing | Yes | Yes (its own users) | Own activity |
| Collection names | **No** (inside encrypted blob) | **No** | Yes |
| Record content | **No** (encrypted) | **No** (encrypted) | Yes |
| User identity (user@domain) | Yes | Yes (for its members) | Yes (space members) |
| Federation peer list | Yes (own config) | Yes (own config) | Partial (trusted list) |

Usernames are public by design. Social graphs (who is in which space, who communicates with whom) are not exposed to servers or federated peers beyond the spaces they participate in.

### Mitigations

- **Record padding**: Encrypt-then-pad to standard size classes to reduce size-based inference
- **Timing decorrelation**: Random delays on cross-server invitation delivery (already implemented for local invitations)
- **Opaque space IDs**: Space UUIDs reveal nothing about content or membership
- **No cross-space correlation**: A federated server only sees spaces it forwards for

---

## 13. Failure modes

### Federated server goes offline

- **Impact**: Users on that server lose real-time sync for federated spaces
- **Mitigation**: Clients continue working locally (CRDT local-first). When the server recovers, it reconnects and re-subscribes to resume live events. Individual clients catch up on missed events via forwarded `pull` requests with their own `since` cursors.
- **Home server behavior**: No buffering for offline peers. The s2s connection is stateless — reconnection simply resumes live event delivery.

### Home server goes offline

- **Impact**: No new writes can be sequenced for the space. Federated servers cannot forward pushes or pull catch-up data.
- **Mitigation**: Clients work locally. When the home server recovers, all pending writes from all federated servers are forwarded and sequenced.
- **Future consideration**: Automated home server failover is possible but deferred beyond v1.

### Home server restored from backup

- **Impact**: If a home server restores from a backup, its cursor values may be behind what federated peers have seen. Federated peers' `since` values may reference cursor positions that no longer exist, causing missed entries or errors.
- **Recovery**: After a restore, the home server returns `cursor_ahead` errors when peers or clients request `since` values beyond the current cursor (see Section 6.8). Receivers reset to `since: 0` and re-pull to converge on the restored state. The home server can also close and re-establish federation connections to force re-subscription.
- **Important**: Federated servers do not store space data — they are transparent proxies. Home server operators MUST maintain independent database backups.
- **AAD binding**: Membership log entries are encrypted with AAD bound to `(spaceId, chain_seq)`. If a restore changes chain positions, the AAD will not match and decryption will fail. This is a safety feature — it prevents replay of old membership entries at different positions — but operators should be aware that partial restores of the membership log are not possible.

### Trust revocation during active replication

- **Impact**: WebSocket connections from the revoked server are closed. Pending writes from that server are rejected.
- **Mitigation**: Users on the revoked server retain local data and UCAN credentials. They can be re-invited via a different trusted path.

### Split brain (network partition between servers)

- **Impact**: Each server continues serving its local clients. However, federated servers **cannot accept writes** to spaces they don't home — push forwarding to the home server fails, and pushes are rejected with an appropriate error. Clients continue working locally (CRDT local-first) and queue writes for retry.
- **Recovery**: When the partition heals, the federated server reconnects and re-subscribes. Clients retry their queued writes (forwarded pushes) and catch up via pull. CRDTs ensure convergence regardless of ordering.
- **Key distinction from multi-master**: There is no split-brain conflict resolution needed. The home server is the single sequencer. During partition, writes are deferred, not diverged.

### Malicious federated server

- **Threat**: A federated server sends invalid records, forged cursor values, or excessive data.
- **Mitigation**:
  - Per-peer quotas bound resource consumption
  - Home server validates all forwarded pushes (cursor values, blob sizes)
  - UCAN authorization is verified independently of the forwarding server
  - Record content is encrypted — a malicious server can't inject meaningful data without the space key

---

## 14. Observability

Federation introduces cross-server state that must be monitored. Servers SHOULD expose the following metrics and health information.

### Required metrics

| Metric | Type | Description |
|--------|------|-------------|
| `federation_peers_active` | Gauge | Number of active federation WebSocket connections |
| `federation_spaces_replicated` | Gauge | Number of spaces being replicated per peer |
| `federation_frames_sent_total` | Counter | Frames sent, labeled by type and peer |
| `federation_frames_received_total` | Counter | Frames received, labeled by type and peer |
| `federation_push_forward_latency_seconds` | Histogram | Time to forward a push to the home server |
| `federation_replication_lag_seconds` | Gauge | Time since last sync event per space per peer |
| `federation_invitation_delivery_total` | Counter | Cross-server invitations, labeled by status |
| `federation_connection_lifetime_seconds` | Histogram | Duration of federation WebSocket connections |
| `federation_quota_usage_ratio` | Gauge | Per-peer quota usage (0.0–1.0) per resource type |
| `federation_jwks_fetch_errors_total` | Counter | JWKS fetch failures, labeled by peer |
| `federation_jwks_cache_age_seconds` | Gauge | Age of cached JWKS per peer |
| `federation_handshake_duration_seconds` | Histogram | WebSocket upgrade latency including signature verification |
| `federation_push_forward_errors_total` | Counter | Push forwarding failures, labeled by peer and error type |
| `federation_websocket_reconnections_total` | Counter | Reconnections per peer |

### Health endpoint

The existing `/health` endpoint SHOULD include federation status:

```json
{
  "status": "ok",
  "federation": {
    "enabled": true,
    "peers": 3,
    "active_connections": 5
  }
}
```

### Structured logging

Federation events SHOULD be logged with consistent fields: `peer` (domain), `space_id`, `frame_type`, `direction` (sent/received), `request_id` (for correlating push-forward round trips), and `connection_id` (for tracking events within a WebSocket lifetime). These are essential for cross-server incident correlation.

---

## 15. API summary

### WebSocket endpoints

| Path | Auth | Description |
|------|------|-------------|
| `WS /api/v1/ws` | JWT (query param) | Client connection (see Section 6.3 for RPC methods) |
| `WS /api/v1/federation/ws` | HTTP Signature (upgrade) | Server-to-server connection (see Section 6.3 for RPC methods) |

### Federation HTTP endpoints (s2s)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/federation/challenge` | None | Request PoW challenge (open federation) |
| GET | `/api/v1/federation/users/{username}/keys?client_id={id}` | HTTP Signature | Get user's public key + signed assertion (app-scoped) |

### HTTP endpoints (admin / c2s)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/federation/trusted` | JWT | List trusted federation peers |
| GET | `/api/v1/federation/status/{domain}` | JWT (admin) | Federation health check for a specific peer |
| PUT/GET/HEAD | `/api/v1/spaces/{spaceID}/files/{id}` | JWT + UCAN | File upload/download/metadata (binary, c2s only) |

### Discovery endpoints (public, no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/.well-known/less-platform` | Server metadata (MUST be on identity domain) |
| GET | `/.well-known/jwks.json` (URL from metadata `jwks_uri`) | JWKS for JWT verification and federation keys |
| GET | WebFinger (URL from metadata `webfinger`) | User discovery (RFC 7033) |

---

## 16. Protocol versioning and upgrades

The `Sec-WebSocket-Protocol` header negotiates the wire protocol version (Section 6.1). The `.well-known/less-platform` `protocols` array advertises all supported versions.

### Version lifecycle

- **Support window**: New protocol versions MUST be supported alongside the previous version for at least **6 months**.
- **Negotiation**: The connecting side requests the highest mutually-supported version. The `protocols` array in the server metadata document determines what the peer supports.
- **Deprecation**: Deprecated versions are announced via a `deprecated_protocols` field in `.well-known/less-platform`. Servers MUST NOT remove support for a protocol version while any trusted peer still lists it as their only supported version.
- **Minimum version**: Servers MAY set a minimum supported version. Connections requesting only unsupported versions are rejected with `400 Bad Request` on the WebSocket upgrade.

### Rolling upgrades

When upgrading the sync service:

1. The server sends close code `1001` (Going Away) to all WebSocket connections before shutting down
2. Peers reconnect immediately (no backoff on `1001`)
3. The new version advertises updated `protocols` in `.well-known/less-platform`
4. Federation resumes on the negotiated protocol version

---

## 17. Phased implementation

### Phase 0: Foundation (no federation, independently useful)

- [ ] Add `/.well-known/less-platform` metadata endpoint (can be static JSON)
- [ ] Add WebFinger endpoint to less-accounts
- [ ] Add `user@domain` display format to identity model
- [x] Implement `less-rpc-v1` WebSocket protocol with subscribe, push, pull, token refresh
- [x] Unified cursor stream (records, membership, files in cursor order)
- [x] Real-time notifications (sync, membership, file, revoked)
- [ ] Extend invitation model to store `user@domain` recipients

### Phase 1: Minimal federation

- [ ] Server federation signing keypair generation and JWKS publication (`use: "federation"`)
- [ ] Federation keypair included in backup/restore procedures
- [ ] HTTP Signature verification on WebSocket upgrade
- [ ] JWKS cache with stale-while-revalidate policy
- [ ] Trust configuration (allowlist mode, hot-reloadable)
- [ ] Federation WebSocket endpoint (at URL from `federation_ws` in discovery)
- [ ] Basic replication: subscribe → catch-up → live sync events + membership log
- [ ] Push forwarding (federated server → home server, synchronous)
- [ ] Cross-server invitation routing with key fingerprint
- [ ] Public key exchange endpoint with signed assertions
- [ ] Per-peer quotas
- [ ] Federation health check endpoint (`GET /api/v1/federation/status/{domain}`)

### Phase 2: Production readiness

- [ ] PoW admission control (open federation mode)
- [ ] Replication monitoring, alerting, and health checks
- [ ] File replication
- [ ] Anomaly detection and quarantine mode
- [ ] Federation admin UI (trust management, key rotation)
- [ ] Integration tests with multi-server docker-compose

### Phase 3: Advanced

- [ ] Identity migration tooling
- [ ] Automated home server failover
- [ ] Federation mesh (server B replicates to server C directly)
- [ ] Cross-server presence/typing indicators (optional, privacy-sensitive)

---

## Appendix A: Design decisions and alternatives considered

### Why WebSocket?

The protocol is inherently bidirectional — both sides send events, control messages, and data. Forcing this into one-way HTTP streams + separate request/response endpoints fights the natural shape of the problem.

WebSocket was chosen over alternatives:
- **gRPC/HTTP/2 bidi streaming**: gRPC-web does not support bidirectional streaming in browsers. Would require a separate protocol for web vs native.
- **WebTransport (HTTP/3)**: Safari support incomplete, no React Native or Flutter support. Future option when platform support matures.
- **Raw QUIC**: Not available in browsers.
- **HTTP POST streaming**: Works but requires separate endpoints for control operations, creating endpoint proliferation and correlation complexity.

WebSocket has universal support across all target platforms: browsers, React Native, Flutter, native iOS (`URLSessionWebSocketTask`), native Android (OkHttp), Go (`nhooyr.io/websocket`).

The CBOR frame format is transport-agnostic. If WebTransport or another protocol matures, the frame types and semantics can migrate without protocol-level changes.

### Why not multi-master?

Multi-master (append-only operation stream) was seriously considered. It enables any server to accept writes independently without a home server. However:

1. **CRDTs already solve the merge problem.** Two servers independently accepting writes to the same record aren't in conflict — the CRDT Model merge converges deterministically on clients.
2. **Storage cost scales with edits, not records.** For an iCloud-replacement used at scale, O(edits) storage vs O(records) is significant.
3. **Bootstrap cost for new clients.** Replaying full operation history is expensive; compaction reintroduces coordinator complexity.
4. **Local-first handles the availability argument.** Clients work offline regardless. The "home server down" scenario only affects server-to-server replication, not user experience.
5. **Burden distribution.** Multi-master means every server shoulders the storage and bandwidth burden for every other server's users. Home-server-authoritative keeps the burden local to the data owner.

### Why HTTP Signatures over mTLS?

- Stateless (authenticates the upgrade request, not the TCP connection)
- Works through CDNs and reverse proxies
- No certificate authority or PKI infrastructure needed
- JWKS-based key discovery aligns with existing JWT validation
- Lower operational burden for small self-hosted deployments

### Why home-server-authoritative over replicated state (Matrix model)?

- Matrix state resolution is their most complex subsystem; it is especially hard when servers can't inspect event content (encrypted blobs)
- Linear sequencing at the home server is dramatically simpler than DAG-based causal ordering
- CRDTs handle merge at the data layer, so the transport layer doesn't need to
- Single sequencer eliminates split-brain coordination problems
- Home server failure is bounded by local-first client operation

### Why not ActivityPub?

ActivityPub is designed for public content distribution (push-to-inbox model). It has no encryption support, no concept of shared mutable state, and its eventual consistency model (best-effort delivery, incomplete thread views) is unsuitable for collaborative document editing.
