# Cross-review: registration, recovery, and consent identity binding

- Reviewer: examples_review, independently tracing the identity review's A-01, A-03, A-04, and A-05 source arguments.
- Date / baseline: 2026-09-20; accounts `b7cda8872ee09cfad44f4186ff40096ee3c95483`, working tree clean. SDK baseline remains `e3a9ad167d8d3cf0d8310304716e5c4e75861a47` but SDK behavior is not needed to establish these four findings.
- Status: analyzed; source conclusions confirmed, runtime regressions outstanding.
- Invariants: INV-04, INV-05, INV-07.
- Scope: accounts API handlers, route registration, CAP client, verification service/JWTs, PostgreSQL implementations/migration, OPAQUE registration wrapper, consent/login/recovery pages and their API wrapper.
- Exclusions: no live accounts, crafted requests, attacks, network calls, database mutations, tests, or product edits. No claim of independent cryptographic certification. No findings outside the four assigned candidates were fully re-reviewed.

## Results

| Candidate | Conclusion | Qualification |
| --- | --- | --- |
| A-01 recovery account binding | Confirmed | Valid verification for some controlled email and CAP success are required. The flaw grants authentication/control, not automatic recovery of the old plaintext root. |
| A-03 consent client/key mismatch | Confirmed, reachability explicitly bounded | Requires an existing attacker-controlled registered OAuth client/redirect and victim approval/root availability. Changing only recipient JWK in an otherwise fixed legitimate request is not the demonstrated path; extended PKCE can reject that mismatch. |
| A-04 registration credential overwrite | Confirmed | Registration email verification is real, but binds the wrong identifier for the username-selected account. A fresh controlled email avoids email uniqueness conflicts. |
| A-05 recovery token double-consumption | Confirmed | Normal page/API flow reuses the same token. A separately issued second token could permit a manually assembled flow, but the page does not obtain one. |

None of the four findings is rejected. Existing controls were traced to their actual enforcement boundary rather than inferred from comments.

## A-01: recovery token verifies one email while request chooses another account

`betterbase-accounts/crates/api/src/handlers/recovery.rs:103-130` validates the verification JWT, requires recovery purpose, and consumes its JTI. The selected account instead comes from canonicalizing `req.email` and `get_account_by_email` at `132-149`. There is no comparison with `v_claims.email`. The signed registration state then stores the selected account UUID (`168-185`), and finalization uses that UUID for credential update and auth-token issuance (`201-256`).

Counterevidence checked:

- **Verification is not forgeable merely because of the bug.** `crates/auth/src/jwt.rs:312-323` verifies HS256, expiration, and token type. However, no target account is supplied to that validator; it cannot compare the target selected later.
- **Obtaining the controlled-email token is reachable.** `crates/api/src/handlers/verification.rs:63-78` forwards recovery email to `verification::send_code`; `crates/api/src/verification.rs:33-72` creates a code and sends it without an account lookup. Confirmation binds the token to the submitted/verified email (`handlers/verification.rs:102-126`). Even requiring an existing controlled account would not bind that token to the different requested target.
- **CAP is enforced when enabled.** Recovery init invokes CAP before token validation (`handlers/recovery.rs:96-101`); `crates/cap/src/lib.rs:65-112` accepts a proof response after a service check, with no email/account in its request. This is a cost gate, not identity proof. The five-per-hour recovery gate at `handlers/recovery.rs:134-143` limits attempts against the selected email but does not reject the first mismatched identity.
- **The recovery phrase is not a server precondition.** The init/finalize route handlers accept a valid OPAQUE re-registration and optional wrapped root; neither verifies recovery-blob decryption. The phrase check occurs only in the normal browser (`web/src/pages/recover.tsx:110-123`). Route wiring (`crates/api/src/lib.rs:109-115`) has no additional authenticated middleware; global layers add protocol header, body limit, and CORS (`143-147`).
- **OPAQUE registration does not require the previous password.** `crates/auth/src/opaque.rs:75-104` starts registration with the selected account's credential identifier and finishes a syntactically valid registration upload; it does not verify the previous registration record. This is correct primitive behavior but makes the missing authorization check material.

The returned auth token is directly usable as that account under `handlers/auth.rs:365-380`; account deletion requires that auth context only (`352-359`). Thus the takeover/control claim is supported without demonstrating later password login. The old root wrapper and scoped-key ciphertexts are not decrypted by this path. “Historical plaintext recovered” would be an unsupported expansion of the finding.

## A-04: existing account checks do not prevent registration overwrite

`betterbase-accounts/crates/api/src/handlers/auth.rs:49-54` correctly matches registration-token email to request email. The subsequent account lookup is keyed by canonical username, through `get_or_create_account` (`75-82`). Its PostgreSQL implementation (`crates/storage/src/postgres/accounts.rs:37-61`) resolves a conflict on `(issuer, username)` with an UPDATE of issuer to the same value and returns that existing row, including the victim UUID and original email. The handler does not compare the returned email to the verified email or inspect `opaque_record` before storing a registration state.

Finalization consumes that state, validates OPAQUE upload and wrapper length, then calls `finalize_registration_with_root_key` and issues an auth token for the state account (`handlers/auth.rs:130-175`). The storage UPDATE (`postgres/accounts.rs:155-179`) has only `WHERE id = $1`, with no `opaque_record IS NULL`, reservation owner, verified-email equality, or expected version.

Counterevidence checked:

- **Availability checks exist but are discarded.** `handlers/verification.rs:36-51` reads by email and username; both results are assigned to `_` and code sending proceeds. The comment promising a finalize-time conflict does not correspond to a guard in finalization.
- **Database uniqueness does not establish identity equality.** `crates/storage/migrations/0001_initial.sql:25-26` requires unique issuer/username and issuer/email. The username conflict branch returns the existing account and leaves its email unchanged. A fresh submitted email does not collide with another row. The only accounts update trigger changes `updated_at` (`7-11`, `28-30`); it does not reject registered-account changes.
- **State consumption prevents replay, not unauthorized initial targeting.** `crates/storage/src/postgres/registration.rs:86-116` atomically deletes the state and checks expiry. It legitimately returns the wrong account that init placed there. There is no operation-purpose or verified-email field in the stored state.
- **CAP/input validation are enforced.** They require a valid request and proof-of-work when enabled, not knowledge of the existing username's password/email. There is no hidden auth route layer on registration (`crates/api/src/lib.rs:53-61`, `143-147`).

This is an independent takeover path from A-01. The severity remains appropriate for unauthorized credential/root-wrapper replacement and issuance of an existing account's auth token. Previous encrypted data does not become plaintext merely because its wrapper is replaced.

## A-03: signed OAuth state and extended PKCE do not bind the SPA's grant selection

The server correctly validates registered client, exact redirect, response type, scopes, and recipient public-key shape before signing OAuth state (`betterbase-accounts/crates/api/src/handlers/oauth.rs:90-211`). It then places duplicate client, display name, scope, and recipient parameters beside the signed token in the redirect (`217-228`).

The consent page reads those duplicate parameters directly (`web/src/pages/consent.tsx:75-85`). It does not fetch a validated authorization context or compare them with the signed state. Its selected `clientId` determines grant lookup (`183`), scoped-root unwrap (`193-199`), app-keypair unwrap (`209-213`), and the payload client key (`223-237`); the URL recipient controls encryption and thumbprint (`239-244`). Both unsigned values survive a required reauthentication through `web/src/pages/login.tsx:15-39`.

The account-authenticated grant endpoint reads the grant for `(authenticated account, query client_id)` (`crates/api/src/handlers/oauth.rs:872-902`), which is appropriate for the accounts browser but allows the confused consent UI to fetch a different application's existing encrypted keys. There is no grant lookup that independently ties this read to the OAuth transaction.

The consent backend validates signed OAuth state and takes its client ID (`oauth.rs:279-295`), while accepting the SPA's opaque JWE/thumbprint (`407-424`). Code exchange enforces that signed client's ID/redirect and the verifier/thumbprint commitment (`519-578`) before returning the saved JWE (`624`). The server never obtains the browser payload's selected client identity to compare it against the signed context.

Counterevidence and reachability limits:

- **Not an arbitrary redirect or unsigned-JWT bypass.** OAuth state signature/type/expiry checks (`crates/auth/src/jwt.rs:249-260`) and exact redirect/code client checks are real and remain intact. An attacker needs an already registered client with an attacker-controlled allowed redirect. This snapshot exposes administrative client provisioning through `bins/oauth-client/src/main.rs`; this review found no public registration route in `crates/api/src/lib.rs`. Do not describe any unauthenticated visitor as able to mint a suitable registered client.
- **No victim root means no existing-key unwrap.** The page requires authenticated victim state and root availability; absent root redirects to reauthentication (`consent.tsx:115-133`, `151-155`). User approval is required. An attacker-created account's own auth token would only retrieve its own grants.
- **Changing recipient alone may be stopped by extended PKCE.** For a fixed signed challenge, a different recipient thumbprint will not generally satisfy code exchange. The supported composition failure keeps the attacker-controlled registered client's originally committed recipient/verifier consistent and changes the SPA's grant-selection `client_id`. This preserves all routing and PKCE checks while selecting the victim's target-app key material for the JWE.
- **A valid target grant is necessary to disclose an existing target key.** Without its wrapped scoped key and decryptable app-keypair blob, the UI creates fresh keys; that does not establish disclosure of another app's historical keys. Network/decryption fallback errors are A-06, outside this cross-review.
- **No unique public-key constraint blocks the mismatched consent.** The app keypair is stored under the signed client's grant (`oauth.rs:382-397`); `crates/storage/migrations/0001_initial.sql:109-131` has uniqueness for account/client and mailbox ID, not `app_public_key`. This step does not compare the selected grant ID to the signed transaction.
- **Resource access is a separate boundary.** Token issuance uses the signed client's grant and scope (`oauth.rs:580-609`). Disclosing a target application's key does not prove that the malicious client's access token can fetch that target's existing ciphertext. Historical-data decryption needs a ciphertext access path and should not be asserted from this finding alone.

The original critical cross-application key disclosure finding is confirmed under those preconditions. Its remediation must bind browser display and grant/recipient selection to the same server-validated authorization context, rather than merely checking JWT validity again at the backend.

## A-05: normal recovery consumes one JTI at both read and mutation stages

`betterbase-accounts/web/src/pages/recover.tsx:110` fetches the recovery blob with the verification token. After local phrase validation it stores **the same** token in recovery state (`127`), then supplies it to recovery init (`146-151`). `web/src/lib/api.ts:203-226` confirms fetch sends that token as authorization and init sends it in the JSON field; neither wrapper refreshes or replaces the token.

`crates/api/src/handlers/recovery.rs:74-81` consumes the JTI before loading the blob. Init validates purpose and calls the same consume operation (`119-130`). `crates/storage/src/postgres/verification.rs:168-190` inserts the JTI with `ON CONFLICT DO NOTHING` and returns `VerificationTokenUsed` if no row was inserted. Therefore successful blob fetch implies the subsequent init rejects that still-valid token as used.

Counterevidence checked:

- **No continuation credential is returned.** Blob fetch returns only `GetRecoveryBlobResponse { blob }` (`recovery.rs:92`). The UI has no second verification step between phrase and password.
- **CAP does not explain or resolve it.** The page gets a fresh CAP token for init (`recover.tsx:139`); this is separate from the consumed email-verification token.
- **Expiration cleanup does not provide a valid reuse interval.** JTI expiry is the signed token's expiry; once the row can be cleaned up, normal JWT validation also expires the credential. No reliance on a timing window is needed to establish the ordinary failure.
- **A-01 remains reachable despite this defect.** The unauthorized init path need not fetch the recovery blob first. The server has no proof-of-blob-decryption gate tying init to that read.
- **Wrong-phrase retry is also broken for the same reason.** The phrase is checked only after token-consuming fetch; a second phrase attempt fetches again using the consumed token. A new separately verified token could work for a custom continuation, but the page neither requests nor manages that transition.

This confirms a deterministic workflow composition defect from source, not merely an absent end-to-end test.

## Checks executed and remaining work

Read the original report and the actual source paths above, including the counterevidence surfaces requested by the coordinator. Verified accounts HEAD/clean status. No runtime reproduction or product changes occurred; only this audit report was added.

Required later regression coverage remains: mismatched verified/target account in recovery; existing registered username with another verified email; real browser recovery with correct and incorrect phrase; consent duplicate-parameter mismatch with server-valid original context. Tests must assert absence of credential/key mutation on rejected transitions and preserve exact client/account/recipient binding across the browser-server handoff. Source agreement is supporting analysis, not substitute executable evidence.
