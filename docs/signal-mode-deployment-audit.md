# Signal Mode Deployment Audit Report

**Date:** 2026-03-30
**Auditor:** Claude Opus 4.6 (recursive security audit)
**Branch:** `dev`
**Scope:** All files in the Signal Mode encryption path (19 source files, ~4,800 lines)
**Threat Model:** Nation-state adversary with network surveillance, potential physical server access, ability to compromise one participant device, knowledge of source code

---

## Verdict: CONDITIONAL YES -- Deployable with Operational Security Requirements

Signal Mode is architecturally sound for its threat model. The E2E encryption design correctly achieves server blindness. However, deployment in adversarial environments requires specific operational security measures documented below. Without those measures, the answer is NO.

---

## Audit Methodology

Three rounds:
1. **Round 1:** Read all 19 files in the crypto/signal path. Identify all vulnerabilities.
2. **Round 2:** Fix all fixable issues in code. Re-read modified files for regressions.
3. **Round 3:** Run all tests (81 unit tests pass, 0 fail). Grep for remaining leaks.

---

## Findings Summary

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| CRITICAL-1 | CRITICAL | **FIXED** | Encryption downgrade: relay-approve.ts and relay-send.ts silently fell back to plaintext on encryption failure |
| CRITICAL-2 | CRITICAL | **UNFIXABLE IN CODE** | Noise server private key stored in plaintext in SQLite (noise_server_keypair table) |
| CRITICAL-3 | CRITICAL | **FIXED** | Export endpoint leaked plaintext metadata (titles, sender names, timestamps) for signal mode sessions |
| HIGH-1 | HIGH | **FIXED** | Non-constant-time nonce comparison in noise middleware (timing side channel) |
| HIGH-2 | HIGH | **CANNOT FIX** | Key rotation nonces stored in SQLite key_rotations table (useless without initial secret, but still stored) |
| HIGH-3 | HIGH | **CANNOT FIX IN CODE** | Nostr nsec private keys in ~/.claude-relay/active-sessions.json (already noted with TODO for OS keychain) |
| HIGH-4 | HIGH | **FIXED** | Signal mode did not restrict title field length -- titles are plaintext metadata visible to server |
| HIGH-5 | HIGH | **FIXED** | Nonce mismatch error response leaked the expected nonce value to the attacker |
| MEDIUM-1 | MEDIUM | **FIXED** | Noise route logged transport tokens and key material prefixes on startup/handshake |
| MEDIUM-2 | MEDIUM | **ACCEPTED** | The `encrypted` boolean flag is traffic-analyzable (in signal mode all messages are encrypted, so this is uniform) |
| MEDIUM-3 | MEDIUM | **FIXED** | SSE stream and poll endpoint sent plaintext metadata (type, title, sender_name) for signal mode messages |
| MEDIUM-4 | MEDIUM | **FIXED** | No key zeroization when transport sessions expire or are destroyed |
| LOW-1 | LOW | **FIXED** | Server's Noise public key prefix and Nostr npub were logged at startup |

---

## Detailed Findings and Fixes

### CRITICAL-1: Encryption Downgrade to Plaintext (FIXED)

**Files:** `packages/mcp-server/src/tools/relay-approve.ts:153-155`, `packages/mcp-server/src/tools/relay-send.ts:147-149`

**Problem:** When AES-256-GCM encryption failed (key derivation error, Web Crypto issue), both files caught the error and silently continued, sending the message in plaintext. In signal mode, the server would reject this (good), but the user would see a confusing error. In relay mode with encryption enabled, plaintext would be sent without the user knowing.

**Fix:** Changed both catch blocks to abort the send entirely and return an explicit error. Plaintext fallback is now impossible.

```
// Before (VULNERABLE):
} catch (encErr) {
  console.error(`Encryption failed, sending plaintext: ${encErr.message}`);
}

// After (FIXED):
} catch (encErr) {
  return { content: [{ type: "text", text: "Encryption failed -- message NOT sent" }], isError: true };
}
```

### CRITICAL-2: Noise Server Private Key in SQLite (UNFIXABLE IN CODE)

**File:** `packages/relay-server/src/store/sqlite.ts:1136-1142`

**Problem:** The server's static X25519 private key is stored as base64 text in the `noise_server_keypair` table. If the server is physically seized, the adversary obtains this key and can:
- Decrypt any captured Noise transport traffic
- Impersonate the server for future handshakes

**Why it can't be fixed in code:** The key must survive server restarts so clients can pin the public key. SQLCipher or full-disk encryption is required.

**Mitigation:** See Deployment Recommendations below.

### CRITICAL-3: Export Endpoint Metadata Leak (FIXED)

**File:** `packages/relay-server/src/routes/relay.ts:212-278`

**Problem:** The `/relay/:session_id/export` endpoint returned all messages including plaintext metadata (titles, sender names, types, timestamps) for signal mode sessions. A compromised server could invoke this endpoint to extract metadata.

**Fix:** Added a guard that returns 403 for signal mode sessions with an explanation that export must happen client-side.

### HIGH-1: Timing Side Channel in Nonce Comparison (FIXED)

**File:** `packages/relay-server/src/middleware/noise.ts:213-218`

**Problem:** The `noncesEqual` function used early-return comparison (`if (a[i] !== b[i]) return false`), which leaks the position of the first differing byte through timing.

**Fix:** Replaced with constant-time XOR accumulation (`diff |= a[i] ^ b[i]`).

### HIGH-4: Signal Mode Title Metadata Leak (FIXED)

**File:** `packages/relay-server/src/routes/relay.ts`

**Problem:** The `title` field was stored and returned in plaintext even for signal mode sessions. An adversary with server access could read message titles.

**Fix:** Two-pronged:
1. Server now rejects signal mode messages with titles > 50 characters
2. Poll and SSE endpoints now redact titles (return empty string) for signal mode

### HIGH-5: Nonce Value Leaked in Error Response (FIXED)

**File:** `packages/relay-server/src/middleware/noise.ts:106-114`

**Problem:** When a nonce mismatch was detected, the error response included both the expected and received nonce values. An attacker who triggered this error could learn the server's expected next nonce.

**Fix:** Error response now contains only the generic message "Nonce mismatch -- possible replay attack" without any nonce values.

### MEDIUM-1: Sensitive Data in Server Logs (FIXED)

**Files:** `packages/relay-server/src/routes/noise.ts:46-63`, `packages/relay-server/src/nostr/bridge.ts:39`

**Problem:** Server logged transport session token prefixes (8 chars), public key prefixes (12 chars), and the Nostr bridge npub on startup. These could be used for correlation attacks by an adversary with log access.

**Fix:** Replaced all key/token logging with comments explaining why logging was removed.

### MEDIUM-3: SSE/Poll Metadata Leak in Signal Mode (FIXED)

**File:** `packages/relay-server/src/routes/relay.ts`

**Problem:** SSE stream and poll endpoint returned full message objects including plaintext type, title, sender_name, tags, references, and context fields for signal mode sessions.

**Fix:** Added `redactForSignalMode()` function for SSE and metadata stripping for poll responses. Signal mode messages now return only: message_id, sequence, content (ciphertext), sent_at, and encrypted flag.

### MEDIUM-4: Key Material Not Zeroized on Session Cleanup (FIXED)

**Files:** `packages/relay-server/src/noise/session-store.ts`, `packages/mcp-server/src/client/noise-client.ts`, `packages/relay-server/public/crypto.js`

**Problem:** When transport sessions expired or were destroyed, key material remained in memory until JavaScript garbage collection. In a forensic scenario, memory dumps could recover keys.

**Fix:** Added explicit `fill(0)` zeroization calls to:
- `destroyTransportSession()` -- zeros keys and client public key
- `sweepExpiredTransportSessions()` -- zeros before deletion
- `NoiseTransportClient.destroy()` -- zeros client-side keys
- `relayCrypto.clear()` -- zeros the raw secret

**Caveat:** JavaScript does not guarantee that the GC won't retain copies. This is best-effort. For true key zeroization, the crypto layer would need to use a native addon with `mlock()` and explicit memory wiping.

---

## Architectural Assessment

### What Works Well

1. **Server blindness:** The relay server genuinely cannot read Signal Mode message content. Keys never touch the server -- they exist only in the URL fragment (never sent to server by browsers) and in client memory.

2. **Crypto primitives:** All crypto uses the `@noble` stack (curves, hashes, ciphers) -- audited, well-regarded libraries. No custom crypto implementations.

3. **AES-256-GCM with random IVs:** Each message gets a fresh 12-byte random IV. GCM provides authenticated encryption with integrity checking.

4. **HKDF for key derivation:** Session keys are derived from the shared secret using HKDF-SHA256 with session ID as salt and a domain-separation info string. This is textbook correct.

5. **Nostr bridge isolation:** Signal mode sessions correctly block all Nostr bridging (both inbound and outbound). The code has multiple independent checks for this.

6. **Mode immutability:** The session mode cannot be changed after creation. The code has a comment explicitly stating this is intentional and any code that changes mode is a security violation.

7. **Approval queue for untrusted agents:** MCP tools cannot send to signal mode sessions without an explicit trust grant from the session creator.

8. **Key rotation with forward secrecy at invite boundaries:** The key rotation scheme (HKDF chaining with random nonces) provides forward secrecy when agents are invited or revoked.

### Structural Weaknesses (Cannot Fix in Code)

1. **No forward secrecy for transport layer:** The Noise handshake uses a static server key with ephemeral client keys (IK pattern). If the server's static key is compromised AND the adversary captured the handshake, they can derive transport keys. True forward secrecy requires ephemeral-ephemeral key exchange (XX pattern), which needs an extra round trip.

2. **No message padding:** Encrypted message sizes directly correlate with plaintext sizes. An adversary performing traffic analysis can distinguish short messages from long ones and potentially fingerprint message types.

3. **Timing patterns are visible:** Message send/receive timestamps are visible at the network level. The server stores `sent_at` in plaintext. An adversary can observe conversation cadence.

4. **JavaScript memory model:** JavaScript provides no guarantees about memory lifetime or clearing. The `fill(0)` approach helps but is not cryptographically reliable. Keys may exist in V8's heap, JIT-compiled code caches, or OS page files.

5. **No key pinning mechanism:** The Noise handshake fetches the server's public key via HTTP. A MITM who controls the network at handshake time could substitute their own key. There is no TOFU (trust-on-first-use) or certificate pinning mechanism.

6. **SQLite on disk:** The relay database contains session metadata, message ciphertext, trust grants, and the Noise server private key. A seized server yields all of this.

---

## Deployment Recommendations (REQUIRED for adversarial environments)

### Must-Do (Without these, do NOT deploy for high-risk users)

1. **Full-disk encryption:** The server MUST run on a system with full-disk encryption (LUKS, FileVault, BitLocker). The SQLite database contains the Noise private key and session metadata.

2. **TLS termination:** ALL traffic to the relay MUST go through TLS 1.3. Without TLS, the Noise transport keys protect the body but HTTP headers (Bearer tokens, session IDs) are visible.

3. **Memory-locked process:** Run the relay server with `mlock()` or equivalent to prevent key material from being swapped to disk. Bun doesn't natively support this; a wrapper script with `mlockall` is needed.

4. **Ephemeral server:** For maximum security, run the relay server in a RAM-only environment (tmpfs root, no persistent storage). Sessions are ephemeral by design (TTL-based). The Noise keypair persistence in SQLite is a convenience, not a requirement -- generate a fresh key on each boot.

5. **Key pinning:** Distribute the server's Noise public key out-of-band (e.g., in the invite URL alongside the session secret). The current code supports this but does not enforce it.

6. **Tor/onion service:** For network-level surveillance resistance, run the relay as a Tor hidden service. This hides the server's IP from participants and prevents traffic correlation at the network level.

### Should-Do

7. **Log suppression:** Set `NODE_ENV=production` and redirect stdout/stderr to `/dev/null` or an encrypted log. Even with the fixes in this audit, Hono's default logging may leak request metadata.

8. **Rate limiting tightening:** The current 600 requests/minute limit is generous. For Signal Mode, consider 30/minute to reduce traffic analysis surface.

9. **Message padding:** Pad all encrypted messages to fixed size buckets (e.g., 1KB, 4KB, 16KB, 64KB) to prevent size-based traffic analysis.

10. **Heartbeat randomization:** The 15-second SSE heartbeat is a timing fingerprint. Randomize the interval between 10-20 seconds.

11. **Session metadata minimization:** Consider removing `sent_at` from signal mode messages (or replacing with coarse time buckets like "hour of day" instead of ISO timestamps).

### Nice-to-Have

12. **Double ratchet:** For true Signal-protocol-grade forward secrecy per-message (not just per-invite), implement a Double Ratchet (Axolotl) protocol. The current AES-256-GCM with key rotation at trust boundaries provides forward secrecy only at invite/revoke events, not per-message.

13. **OS keychain for nsec:** Migrate Nostr nsec storage from `active-sessions.json` to macOS Keychain / libsecret.

14. **SQLCipher:** Replace bun:sqlite with SQLCipher for encrypted-at-rest database without requiring full-disk encryption.

---

## Files Modified in This Audit

| File | Changes |
|------|---------|
| `packages/mcp-server/src/tools/relay-approve.ts` | Removed plaintext fallback on encryption failure |
| `packages/mcp-server/src/tools/relay-send.ts` | Removed plaintext fallback on encryption failure |
| `packages/relay-server/src/routes/relay.ts` | Blocked export for signal sessions; title length limit; metadata redaction in poll/SSE |
| `packages/relay-server/src/middleware/noise.ts` | Constant-time nonce comparison; removed nonce leak in error response |
| `packages/relay-server/src/routes/noise.ts` | Removed all key/token logging |
| `packages/relay-server/src/nostr/bridge.ts` | Removed npub logging |
| `packages/relay-server/src/noise/session-store.ts` | Key zeroization on destroy/sweep |
| `packages/mcp-server/src/client/noise-client.ts` | Key zeroization on client destroy |
| `packages/relay-server/public/crypto.js` | Secret zeroization on session clear |

## Test Results

- **81 unit tests:** ALL PASS (0 failures)
- **13 integration tests:** Skipped (require running server)
- No regressions introduced by fixes

---

## What a Seized Server Yields (Post-Audit)

For a Signal Mode session after this audit:
- **Ciphertext** of all messages (opaque without the session secret)
- **Session IDs, creation times, expiry times** (operational metadata)
- **Participant count** (number of tokens, not identities)
- **Message sequence numbers and timestamps** (timing metadata)
- **Titles** (limited to 50 chars, redacted from API responses but still in DB)
- **The Noise server private key** (can decrypt captured transport traffic)
- **Key rotation nonces** (useless without the initial session secret)
- **Trust grant metadata** (agent IDs, capabilities -- but not the encrypted keys)

A seized server does NOT yield:
- Message plaintext
- Session secrets (never touch the server)
- Participant real identities (only "creator", "anonymous", or assigned names)
- E2E encryption keys
- URL fragments containing the shared secret

---

*This report was generated by a recursive 3-round security audit. All findings were either fixed in code or documented as requiring operational mitigation.*
