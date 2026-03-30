# Security Audit: Signal Mode & E2E Encryption

**Date:** 2026-03-30
**Auditor:** Security review (adversarial)
**Branch:** `dev`
**Scope:** Signal Mode enforcement, AES-256-GCM implementation, key exchange, bridge security, storage, client-side scanner

---

## Summary

The encryption primitives are correctly implemented using Web Crypto API with AES-256-GCM. However, the Signal Mode enforcement layer has multiple bypass vectors, the bridge protocols are completely unaware of signal mode, the `encrypted` flag is not persisted to the database, and the MCP origin check is non-functional. Several findings are HIGH or CRITICAL severity.

**Findings:** 3 CRITICAL, 5 HIGH, 4 MEDIUM, 3 LOW, 3 INFO

---

## CRITICAL

### C1. MCP Signal Mode Check Is Non-Functional — Origin Never Set

**File:** `packages/relay-server/src/routes/relay.ts:38-39`
**File:** `packages/mcp-server/src/client/relay-client.ts:88-98`

The server checks `body.origin === 'mcp'` to reject MCP messages in signal mode. However, the MCP client (`relay-client.ts`) never sets an `origin` field on the payload. The `sendMessage` function passes `payload` (a `RelayMessagePayload`) directly, and `RelayMessagePayload` (schema.ts:21-43) does not include an `origin` field.

**Impact:** MCP tools can freely send messages into signal mode sessions. The signal mode promise of "human-to-human only" is entirely unenforceable. Any Claude Code instance with a valid session token can inject messages, including plaintext if the `encrypted` field is also forged (see C2).

**Reproduction:** Call `relay_approve` on a message destined for a signal-mode session. The MCP client sends a normal POST with no `origin` field. The server hardcodes `origin: "http"` on line 70 regardless of actual origin. The check on line 38 never triggers.

---

### C2. Encrypted Flag Is Client-Asserted — No Server Verification

**File:** `packages/relay-server/src/routes/relay.ts:33-35`
**File:** `packages/shared/src/schema.ts:39-42`

The server trusts the client-provided `encrypted: true` boolean to determine whether a message is encrypted. There is no server-side validation that the `content` field actually contains a valid `EncryptedPayload` JSON structure (with `ciphertext` and `iv` fields).

**Impact:** An attacker can send plaintext content to a signal-mode session by setting `encrypted: true` in the payload while putting readable plaintext in `content`. The server will accept it because:
1. `isSignalMode && !parsed.data.encrypted` is false (encrypted flag is set)
2. The content scanning is skipped for "encrypted" payloads (line 45)
3. The plaintext is stored and delivered to other participants

This completely defeats signal mode encryption enforcement AND bypasses all content scanning.

**Reproduction:**
```bash
curl -X POST http://localhost:4190/relay/<signal-session-id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"type":"context","title":"","content":"This is plaintext pretending to be encrypted","encrypted":true}'
```

---

### C3. Encrypted Flag Not Persisted to SQLite — Lost on Server Restart

**File:** `packages/relay-server/src/store/sqlite.ts:59-74` (messages table schema)
**File:** `packages/relay-server/src/store/sqlite.ts:207-209` (insertMessage)
**File:** `packages/relay-server/src/store/sqlite.ts:475-490` (rowToMessage)

The `messages` table has no `encrypted` column. The `insertMessage` prepared statement does not store the `encrypted` flag. The `rowToMessage` function does not reconstruct it.

**Impact:** After a server restart, all messages lose their `encrypted` flag. Clients polling these messages will not know they need decryption. In the dashboard, encrypted messages will be displayed as raw JSON ciphertext blobs (`{"ciphertext":"...","iv":"...","encrypted":true}`) instead of being decrypted. The MCP poll tool (relay-poll.ts:84) checks `(m as any).encrypted` which will be `undefined` for all persisted messages, so decryption is never attempted.

This is a data integrity issue that silently degrades signal mode sessions after any server restart.

---

## HIGH

### H1. Nostr Bridge Bypasses Signal Mode Entirely

**File:** `packages/relay-server/src/nostr/bridge.ts:168-225` (bridgeNostrToHttp)
**File:** `packages/relay-server/src/routes/relay.ts:77-78` (bridgeMessageToNostr)

The Nostr bridge has zero awareness of signal mode:

1. **Outbound (line 77-78):** Every HTTP message is unconditionally bridged to Nostr via `bridgeMessageToNostr`. In signal mode, this publishes encrypted ciphertext blobs to the Nostr event store and broadcasts them to WebSocket subscribers. The Nostr event `content` field contains the raw ciphertext JSON, which leaks the existence and size of messages.

2. **Inbound (line 168-225):** `bridgeNostrToHttp` injects Nostr events into HTTP sessions without checking if the session is in signal mode. It runs `scanAndGateMessage` (plaintext content scanning) but does not enforce encryption. A Nostr client can inject plaintext messages into a signal-mode session.

**Impact:** Signal mode's "no MCP, encrypted only" guarantees are completely bypassed via the Nostr bridge. An attacker who knows the session's Nostr pubkey binding or session tag can inject unencrypted messages.

---

### H2. Solid Bridge Bypasses Signal Mode Entirely

**File:** `packages/relay-server/src/solid/bridge.ts:62-132` (bridgeMessageToSolid)
**File:** `packages/relay-server/src/solid/bridge.ts:146-199` (bridgeSolidToHttp)

Identical to H1 but for the Solid Pod bridge:

1. **Outbound:** All messages are unconditionally written to Solid Pods as JSON-LD, including ciphertext from signal-mode sessions. The `relay:content` field contains the raw encrypted JSON.

2. **Inbound:** `bridgeSolidToHttp` injects Pod resources into sessions without signal mode checks. Plaintext messages from a Pod bypass encryption enforcement.

**Impact:** Same as H1 — signal mode is bypassable via Solid federation.

---

### H3. Session Mode Is Mutable — No Immutability Enforcement

**File:** `packages/relay-server/src/store/sqlite.ts:125-138` (migrations)
**File:** `packages/relay-server/src/routes/sessions.ts` (no update endpoint, but...)

While there is no explicit "update mode" API endpoint, the `mode` column has no database-level constraint preventing modification. More critically, the mode defaults in the migration (`DEFAULT 'relay'`) mean that if the column addition migration runs on an existing session, it silently downgrades from signal to relay mode.

The client-side `refreshStatus` (app.js:575-583) syncs mode from the server, but only upgrades to signal — it does not enforce that a session cannot be downgraded. If a future endpoint or database modification changes the mode, clients will silently follow.

**Impact:** No defense-in-depth against mode downgrade. A single bug in any future endpoint could silently disable signal mode for active sessions.

---

### H4. Encryption Secret Stored in Plaintext on Disk (MCP State File)

**File:** `packages/mcp-server/src/state.ts:1-5` (security warning)
**File:** `packages/shared/src/types.ts:116` (encryption_secret field)
**File:** `packages/mcp-server/src/tools/relay-session.ts:48` (secret stored)

The `encryption_secret` (the 32-byte shared secret used to derive the AES-256-GCM key) is stored in plaintext in `~/.claude-relay/active-sessions.json` alongside Nostr nsec private keys. While the file has `0600` permissions, this means:

1. Any process running as the same user can read the encryption secret
2. The secret survives session expiry (no cleanup on TTL expiration)
3. Backups, Time Machine, or cloud sync could capture it
4. The `secureDelete` function (state.ts:101) only runs on explicit invocation, not on session expiry

The existing security warning comment acknowledges this for nsec keys but the encryption_secret is equally sensitive — it enables decryption of all messages in a session.

**Impact:** The E2E encryption key material is at rest in plaintext. An attacker with filesystem read access to the MCP client machine can decrypt all session messages.

---

### H5. Session Token Exposed in URL Query Parameters

**File:** `packages/relay-server/public/app.js:302-308`

The session token (bearer auth credential) is placed in URL query parameters:
```javascript
url.searchParams.set('token', sess.token);
```

Unlike the encryption key which is correctly placed in the URL fragment, the auth token is in the query string. This means:
1. The token is sent to the server in the URL (visible in server access logs)
2. It appears in browser history
3. It can leak via the `Referer` header to any external resources loaded by the page
4. Shared URLs (e.g., copied from address bar) include the auth token

**Impact:** Bearer token leakage through multiple channels. Anyone with access to browser history, server logs, or a referrer header can impersonate the session participant.

---

## MEDIUM

### M1. Client-Side Scanner Missing Normalization Layer

**File:** `packages/relay-server/public/crypto.js:157-233` (clientSideScan)
**File:** `packages/shared/src/scanner.ts:67-81` (normalizeForScanning)

The server-side scanner (scanner.ts) includes a normalization phase that converts fullwidth Unicode characters to ASCII and normalizes leet speak substitutions before pattern matching. The client-side scanner (crypto.js) does NOT include this normalization.

**Impact:** In relay mode with encryption, the client-side scanner is the only scanning layer (server sees only ciphertext). An attacker can bypass the client scanner by encoding sensitive content with fullwidth Unicode (e.g., `password` as `password`) or leet speak. The server-side scanner would catch this, but it never sees the plaintext.

---

### M2. Client-Side Scanner Missing Unicode Tags Block Detection

**File:** `packages/relay-server/public/crypto.js:172-185` (INVISIBLE_CHARS)
**File:** `packages/shared/src/scanner.ts:18` (Tags block pattern)

The server-side scanner includes detection of Unicode Tags block characters (U+E0000-U+E007F) used for steganography. This pattern requires the `u` flag for astral plane support. The client-side scanner in crypto.js omits this pattern entirely.

**Impact:** In encrypted sessions, steganographic content using Tags block characters passes through without detection. This is a known vector for embedding hidden instructions in LLM-consumed text.

---

### M3. Signal Mode Content Scanning Completely Disabled

**File:** `packages/relay-server/src/routes/relay.ts:42-50`

The comment on line 44 reads: "In signal mode: no content scanning — humans don't need promptware protection." This is a design decision, but it means signal mode sessions have zero protection against:
1. Accidental credential leakage (API keys, passwords pasted into chat)
2. Markdown exfiltration attacks embedded in messages
3. Steganographic content injection

While the client-side scanner runs before encryption in relay mode (Scan-then-Seal), in signal mode the client-side scanner is explicitly skipped (app.js:782: `if (!isSignal && sealed.scanResult ...`).

**Impact:** Signal mode has no content scanning at any layer. If a human pastes an API key into a signal-mode chat, it is encrypted and stored without any warning.

---

### M4. Encryption Key Derivation Uses Predictable Session ID as Salt

**File:** `packages/shared/src/crypto.ts:119-134`

HKDF salt is the session ID (a UUID). While not a vulnerability per se (UUIDs have sufficient entropy), the salt is not random — it is knowable to the server and any participant. The HKDF info string is the static `"claude-relay-e2e"`.

If two sessions somehow share the same secret (e.g., secret reuse by a human), the different session IDs would produce different keys, which is correct. However, since the session ID is public (visible in URLs, API responses, server logs), the salt provides no additional secrecy — only domain separation.

**Impact:** Low additional risk given proper secret generation, but deviates from HKDF best practice of using a random salt unknown to adversaries.

---

## LOW

### L1. Key Marked as Extractable

**File:** `packages/shared/src/crypto.ts:132`
**File:** `packages/relay-server/public/crypto.js:89`

The derived AES-256-GCM key is created with `extractable: true`. This is needed for the fingerprint computation (which exports the raw key to hash it), but it means any JavaScript code running in the page context can call `crypto.subtle.exportKey('raw', key)` to extract the key material.

**Impact:** A browser extension, XSS vulnerability, or injected script can extract the session key from memory. If the key were non-extractable, Web Crypto would refuse export even to same-origin scripts. The fingerprint could alternatively be computed from the secret before key derivation.

---

### L2. URL Fragment Key Exposure via Browser History and Bookmarks

**File:** `packages/relay-server/public/app.js:310`

The encryption key is placed in the URL fragment (`#key=...`). While fragments are never sent to the server per HTTP spec, they are:
1. Visible in the browser address bar
2. Saved in browser history (most browsers store the full URL including fragment)
3. Captured by bookmarks
4. Potentially captured by browser extensions with `tabs` permission
5. Visible in `document.referrer` in some edge cases with same-origin navigation

The `endSession` function (app.js:403) correctly clears the fragment via `history.replaceState`, but the key exists in the URL for the entire session duration.

**Impact:** The encryption key can be recovered from browser history even after the session ends, as `history.replaceState` only replaces the current entry, not previous ones.

---

### L3. Export Endpoint Leaks Ciphertext Without Encryption Metadata

**File:** `packages/relay-server/src/routes/relay.ts:169-235`

The `/relay/:session_id/export` endpoint exports all messages in JSON or Markdown format. For signal-mode sessions with encrypted messages, this exports the raw ciphertext JSON strings without any indication that decryption is needed. The export does not include the `encrypted` flag (see C3 — it is not persisted).

Combined with C3, exported signal-mode sessions are unrecoverable blobs with no metadata to indicate they need decryption.

**Impact:** Exported signal-mode sessions are unusable. The Markdown format will contain raw `{"ciphertext":"...","iv":"...","encrypted":true}` strings.

---

## INFO

### I1. Crypto Implementation Is Correct

**Files:** `packages/shared/src/crypto.ts`, `packages/relay-server/public/crypto.js`

The core cryptographic implementation is sound:
- AES-256-GCM is used correctly with 12-byte random IVs per message
- HKDF-SHA256 derivation is correctly parameterized
- The GCM auth tag is handled by Web Crypto (included in ciphertext output)
- No IV reuse is possible given `crypto.getRandomValues` for each encryption
- The crypto.js browser port is a faithful translation of crypto.ts
- Base64 encoding/decoding is correct
- Key fingerprint (SHA-256 of raw key, first 8 hex chars) is correctly computed

---

### I2. Relay Crypto Manager Memory-Only Design Is Sound

**File:** `packages/relay-server/public/crypto.js:239-339`

The `relayCrypto` manager correctly:
- Stores the session key in a closure variable (memory only)
- Explicitly excludes `_cryptoSecret` from localStorage persistence (app.js:285-289)
- Clears key material on session end (app.js:393-394)
- Falls back gracefully when no key is available

---

### I3. MCP Encryption Fallback to Plaintext Is a Design Risk

**File:** `packages/mcp-server/src/tools/relay-approve.ts:139-141`

When MCP encryption fails, the code falls back to sending plaintext with only a console warning:
```typescript
console.error(`[relay-mcp] Encryption failed, sending plaintext: ${encErr.message}`);
```

This is noted as an intentional design decision (availability over confidentiality), but in a signal-mode session this would violate the encryption guarantee if C1 were fixed. Currently moot since C1 means MCP bypass is already possible.

---

## Attack Scenarios

### Scenario 1: Complete Signal Mode Bypass (C1 + C2)
An attacker with a valid session token sends a POST to a signal-mode session with `{"type":"context","content":"plaintext spy message","encrypted":true}`. The server accepts it (C2). No origin check fires (C1). The message is stored and delivered to all participants as "encrypted" even though it is plaintext.

### Scenario 2: Bridge Injection (H1/H2)
An attacker binds a Nostr pubkey to a signal-mode session, then sends a plaintext Nostr event. The bridge injects it without encryption enforcement. All dashboard participants see the injected message.

### Scenario 3: Key Recovery After Session End (H4 + L2)
After a signal-mode session ends: (a) the encryption secret persists in `~/.claude-relay/active-sessions.json` indefinitely, and (b) the key persists in browser history. An attacker with filesystem or browser history access can derive the session key and decrypt all stored ciphertext.

---

## Recommendations (Priority Order)

1. **Server-side ciphertext validation (C2):** When `encrypted: true`, parse and validate that `content` is a valid `EncryptedPayload` JSON with `ciphertext` and `iv` fields before accepting.
2. **Add `encrypted` column to messages table (C3):** Persist the flag so it survives restarts.
3. **Fix MCP origin tagging (C1):** Either have the MCP client set `origin: 'mcp'` or (better) determine origin server-side from the authentication token type.
4. **Add signal mode checks to bridges (H1, H2):** Reject inbound bridge messages for signal-mode sessions. Suppress outbound bridging for signal-mode sessions.
5. **Make session mode immutable (H3):** Add a CHECK constraint or application-level guard.
6. **Migrate encryption_secret to OS keychain (H4):** As the existing TODO notes for nsec keys.
7. **Move session token to URL fragment or cookie (H5):** Remove from query parameters.
8. **Port normalization and Tags block detection to client scanner (M1, M2).**
9. **Make derived key non-extractable; compute fingerprint from secret (L1).**
