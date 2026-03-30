# Crypto Audit Report — claude-relay

> Date: 2026-03-30
> Scope: `packages/shared/src/crypto.ts`, `packages/relay-server/public/crypto.js`, Nostr key infrastructure, research doc alignment
> Branch: `dev`

---

## 1. Current Crypto Assessment

### What's Correct

**AES-256-GCM + HKDF implementation is fundamentally sound.** The core design follows best practices:

- **Fresh random 12-byte IV per message.** `crypto.getRandomValues(new Uint8Array(12))` is used in both `crypto.ts` and `crypto.js`. No IV reuse within a session unless the CSPRNG fails (astronomically unlikely).
- **HKDF key derivation with domain separation.** The info string `"claude-relay-e2e"` and session ID as salt correctly binds the derived key to the session context. This is textbook HKDF usage per RFC 5869.
- **GCM auth tag is handled correctly.** Web Crypto API appends the 16-byte auth tag to ciphertext automatically; the code does not strip or mishandle it.
- **Secret never touches the server.** The URL fragment (`#key=...`) is not sent in HTTP requests by browsers. The secret lives in memory only — `relayCrypto._sessionKey` is never persisted to localStorage.
- **Key fingerprint for out-of-band verification.** SHA-256 of the raw key bytes, displayed as hex — this is a reasonable approach for key confirmation.
- **Scan-then-Seal pattern is well-implemented.** Content scanner runs before encryption, preserving the ability to detect sensitive content while ensuring the server only sees ciphertext.

**Nostr cryptographic infrastructure is solid:**

- `nostr-tools/pure` used for Schnorr signature generation/verification (secp256k1).
- NIP-42 auth with challenge-response, challenge replay prevention, server-canonical relay URL enforcement.
- Event signature verification before store/broadcast.
- Timestamp bounds checking (reject events >15min future or >1hr old).

### What's Weak

#### W1: Key extractability is unnecessarily broad (LOW severity)

In `crypto.ts` line 132:
```typescript
true, // extractable for fingerprint computation
```

The AES-256-GCM key is marked extractable to compute fingerprints. This means any JS in the same origin can call `crypto.subtle.exportKey("raw", key)` and exfiltrate the raw key bytes. The fingerprint could instead be computed from the pre-derivation secret (which is already in memory as a `Uint8Array`), allowing the derived CryptoKey to be non-extractable.

**Recommendation:** Compute the fingerprint from `SHA-256(secret || sessionId)` before deriving the CryptoKey. Then set extractable to `false`.

#### W2: No GCM nonce exhaustion tracking (LOW severity, but architecturally important)

AES-256-GCM with random 96-bit IVs has a birthday-bound collision risk at ~2^48 messages under a single key. With the current `MAX_MESSAGES_PER_SESSION = 200` limit, this is not a practical risk today. However:

- There is no counter or warning mechanism if sessions are later extended.
- The research doc recommends ChaCha20-Poly1305 partly because its 192-bit nonce (XChaCha20) eliminates this concern entirely.

**Recommendation:** Add a message counter per session key. Log a warning or force key rotation if it exceeds 2^32 (conservative threshold). This becomes critical if `MAX_MESSAGES_PER_SESSION` is ever raised significantly.

#### W3: Symmetric-only encryption — no forward secrecy (MEDIUM severity)

The current scheme uses a single shared secret for the entire session lifetime. If the secret is compromised (e.g., URL fragment leaked in browser history, clipboard, or screen share), all past and future messages in that session are decryptable.

The research doc's Stage 2 addresses this with per-message DEKs encrypted via X25519 ECDH, providing forward secrecy.

#### W4: No message franking or sender authentication (MEDIUM severity)

Any participant with the shared secret can encrypt messages. There is no mechanism to prove which participant sent a specific message. The research doc's Stage 2 introduces HMAC-SHA256 message franking for sender commitment.

#### W5: nsec private keys stored in plaintext JSON (HIGH severity)

`packages/mcp-server/src/state.ts` stores Nostr nsec keys in `~/.claude-relay/active-sessions.json` as plaintext. The file has 0600 permissions and there's a secure-delete function, but:

- The TODO to migrate to macOS Keychain / libsecret is still open.
- Any process running as the same user can read the file.
- The 3-pass random overwrite in `secureDelete()` is good practice but doesn't protect against filesystem snapshots, Time Machine backups, or journaled filesystem recovery.

**Recommendation (Stage 1):** Migrate to macOS Keychain via `security` CLI or the `keytar` npm package. On Linux, use libsecret via the same package.

#### W6: Dashboard crypto.js duplicates crypto.ts without type safety (LOW severity)

`packages/relay-server/public/crypto.js` is a manual ES5-style copy of the TypeScript implementation. Any bug fix or improvement to `crypto.ts` must be manually ported. The `clientSideScan()` function pattern list could drift from the server-side scanner.

**Recommendation:** Build `crypto.js` from `crypto.ts` via a bundler step, or share the module.

---

## 2. Stage 1 Improvement Recommendations

Based on the research doc's Stage 1 plan ("Encryption-aware envelope restructuring"), the following concrete steps apply:

### 2a. Typed Envelope Format

Separate scannable metadata from encrypted payload:

```typescript
interface RelayEnvelope {
  version: 1;
  metadata: {
    session_id: string;
    sender_name: string;
    type: string;       // message type — scannable
    timestamp: number;
    tags: string[];     // scannable
  };
  payload: EncryptedPayload | string; // encrypted or plaintext
}
```

This allows the scanner to operate on `metadata` fields without touching the encrypted payload, preserving 100% scan coverage on metadata while encrypting message content.

### 2b. Install @noble stack as direct dependencies

The noble libraries are already present as transitive dependencies of `nostr-tools` (via Bun's `.bun/node_modules/@noble/`):
- `@noble/ciphers` 2.1.1
- `@noble/curves` 2.0.1
- `@noble/hashes` 2.0.1

However, they should be declared as direct dependencies for three reasons:
1. Importing from a transitive dependency is fragile — a `nostr-tools` update could change versions.
2. Direct dependency allows version pinning and audit trail.
3. Required for NIP-44 implementation outside of nostr-tools' bundled version.

```bash
bun add @noble/curves@^2.0.1 @noble/hashes@^2.0.1 @noble/ciphers@^2.1.1
```

### 2c. Refactor scanner to envelope abstraction

The 6-phase scanner currently operates on raw message content. Refactor to accept `RelayEnvelope` and scan:
- `metadata.tags` — sensitive tag content
- `metadata.sender_name` — path leakage
- `payload` — only if unencrypted (relay mode)
- Skip payload scan entirely in signal mode

### 2d. Fix key extractability (W1)

Compute fingerprint before HKDF derivation:
```typescript
async function getSecretFingerprint(secret: Uint8Array, sessionId: string): Promise<KeyFingerprint> {
  const material = new Uint8Array(secret.length + new TextEncoder().encode(sessionId).length);
  material.set(secret);
  material.set(new TextEncoder().encode(sessionId), secret.length);
  const hash = await crypto.subtle.digest("SHA-256", material);
  const full = bufferToHex(hash);
  return { short: full.slice(0, 8), full };
}
```
Then set `extractable: false` in `deriveSessionKey()`.

---

## 3. Noble Library Integration Plan

### Current State
- `nostr-tools@2.23.3` depends on `@noble/curves@2.0.1`, `@noble/hashes@2.0.1`, `@noble/ciphers@2.1.1`.
- These are installed in Bun's deduplicated store at `node_modules/.bun/node_modules/@noble/`.
- No direct imports of `@noble/*` exist in project source code.
- `nostr-tools/nip44` already bundles a full NIP-44 implementation using `@noble/ciphers/chacha`, `@noble/curves/secp256k1`, and `@noble/hashes/hkdf`.

### Integration Steps

**Phase A (Stage 1):** Add as direct dependencies, use for envelope crypto.

| Package | Use Case |
|---------|----------|
| `@noble/hashes` | Replace Web Crypto HKDF with `hkdf` from `@noble/hashes/hkdf` for synchronous key derivation (no async needed). Replace `crypto.subtle.digest` with `sha256` for fingerprints. |
| `@noble/ciphers` | Add ChaCha20-Poly1305 as an alternative cipher alongside AES-256-GCM. Required for NIP-44 compatibility and signal mode. |
| `@noble/curves` | X25519 ECDH for Stage 2 per-message DEKs. Already used indirectly via nostr-tools for secp256k1 Schnorr signatures. |

**Phase B (Stage 2):** X25519 key agreement for per-message encryption.

```typescript
import { x25519 } from "@noble/curves/ed25519";
// or for Nostr compatibility:
import { secp256k1 } from "@noble/curves/secp256k1";
```

**Phase C (Stage 4):** Add `@noble/post-quantum` for ML-KEM-768 hybrid key exchange.

### Browser Compatibility

`@noble/*` is pure TypeScript with no native dependencies — it works in both Bun (server/MCP) and browsers (dashboard). This means `crypto.js` can be replaced with a bundled version that shares the same noble-based implementation as `crypto.ts`, eliminating the duplication issue (W6).

---

## 4. NIP-44 Integration Feasibility

### TL;DR: Highly feasible — nostr-tools already ships a complete NIP-44 implementation.

### What NIP-44 Provides

NIP-44 is the Nostr encrypted direct messaging standard (replacing the broken NIP-04). It uses:
- **secp256k1 ECDH** for key agreement (X-only shared point, same curve as Nostr signatures)
- **HKDF-SHA256** for conversation key derivation (extract with `"nip44-v2"` salt)
- **HKDF-expand** for per-message key derivation (ChaCha key + nonce + HMAC key from 32-byte random nonce)
- **ChaCha20** (not Poly1305 — NIP-44 uses HMAC-SHA256 for authentication instead)
- **HMAC-SHA256** for message authentication
- **Padding** to hide message length (power-of-2 bucket padding)

### Integration Path

**Option 1 (Recommended): Use `nostr-tools/nip44` directly.**

```typescript
import { nip44 } from "nostr-tools";

// Encrypt for Nostr DM
const conversationKey = nip44.v2.utils.getConversationKey(myPrivkey, theirPubkey);
const ciphertext = nip44.v2.encrypt(plaintext, conversationKey);

// Decrypt incoming Nostr DM
const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
```

This is already battle-tested and matches the NIP-44 test vectors. The `getConversationKey` function uses `secp256k1.getSharedSecret()` from `@noble/curves` under the hood.

**Option 2: Implement from @noble primitives directly.**

Only needed if customization is required (e.g., different padding scheme, different auth tag construction). The NIP-44 source in `nostr-tools/lib/esm/nip44.js` is ~120 lines and straightforward to adapt.

### Where NIP-44 Fits in claude-relay

1. **Signal mode sessions.** When `mode='signal'`, the relay is a dumb pipe. NIP-44 encryption can be used end-to-end between participants using their existing Nostr keypairs. The relay never sees plaintext.

2. **Nostr bridge encrypted DMs.** External Nostr clients sending kind-4 (NIP-04, deprecated) or kind-1059 (NIP-44 gift-wrapped) events can be decrypted by the bridge for content scanning (relay mode) or passed through as-is (signal mode).

3. **Replacing AES-256-GCM for session encryption.** NIP-44's ChaCha20 + HMAC-SHA256 approach could replace the current AES-256-GCM for the session encryption layer, aligning both the Nostr bridge and HTTP relay on a single cipher suite. However, this is a Stage 2/3 change — the current AES-256-GCM is not broken.

### Gaps

- **No NIP-17 (private DMs) or NIP-59 (gift wrapping) support yet.** These are needed for full Nostr DM privacy (hiding sender/recipient metadata). Scheduled for Stage 3 in the research doc.
- **No conversation key caching.** Each NIP-44 encrypt/decrypt recomputes the ECDH shared secret. For high-throughput scenarios, cache the conversation key per pubkey pair.

---

## 5. AES-256-GCM vs ChaCha20-Poly1305

The research doc recommends ChaCha20-Poly1305. Here's the nuanced assessment:

| Factor | AES-256-GCM | ChaCha20-Poly1305 |
|--------|-------------|-------------------|
| **Current status** | Implemented, working | Not implemented |
| **Hardware accel** | AES-NI on x86, ARM Cryptography Extensions | No hardware accel (but fast in software) |
| **Nonce size** | 96-bit (birthday bound at ~2^48) | 96-bit standard, 192-bit for XChaCha20 |
| **Auth tag** | Built into GCM | Poly1305 MAC |
| **Side-channel risk** | AES lookup tables are timing-vulnerable without AES-NI; Web Crypto uses native impl so this is mitigated | Constant-time by construction |
| **NIP-44 alignment** | No (NIP-44 uses ChaCha20 + HMAC-SHA256) | Partial (same cipher family, different MAC) |
| **Noble support** | `@noble/ciphers` has AES-256-GCM | `@noble/ciphers` has ChaCha20-Poly1305 and XChaCha20-Poly1305 |
| **Browser support** | Web Crypto API native | Requires @noble/ciphers (no Web Crypto support) |

### Recommendation

**Keep AES-256-GCM for the HTTP relay path** (browser dashboard). Web Crypto provides hardware-accelerated, constant-time AES-GCM. Switching to noble's ChaCha20-Poly1305 in the browser would be a pure-JS implementation, slower and with less assurance against side channels.

**Use ChaCha20-Poly1305 (or NIP-44's ChaCha20 + HMAC-SHA256) for the Nostr bridge path.** This aligns with the Nostr ecosystem and the noble stack.

**For signal mode**, use NIP-44 directly — it's the Nostr standard and already available.

**Stage 2+ migration path:** Offer both ciphers behind a `CipherSuite` abstraction. Let the session creation specify `aes-256-gcm` (default for HTTP/browser) or `chacha20-poly1305` (default for Nostr/signal mode).

---

## 6. Crypto Anti-Patterns Found

### AP1: No IV/nonce reuse protection beyond randomness (LOW)

The code relies entirely on `crypto.getRandomValues()` for IV uniqueness. This is statistically safe given the 96-bit IV space and the 200-message session limit, but there is no deterministic fallback (e.g., counter-based nonce) and no tracking of used IVs.

**Risk:** Effectively zero with current limits. Would become relevant if session message limits are raised to thousands.

### AP2: Key material in JavaScript heap — no zeroization (LOW)

The shared secret (`Uint8Array(32)`) passed to `deriveSessionKey` remains in the JavaScript heap after use. There is no `secret.fill(0)` call. The `CryptoKey` object is at least opaque (when non-extractable), but the raw secret bytes used for derivation are not cleared.

**Recommendation:** After deriving the session key, zero out the raw secret buffer:
```typescript
const key = await deriveSessionKey(secret, sessionId);
secret.fill(0); // Best-effort zeroization
```
Note: JavaScript GC may have already copied the buffer, so this is defense-in-depth, not a guarantee.

### AP3: No authenticated associated data (AAD) in GCM (MEDIUM)

AES-GCM supports Additional Authenticated Data — plaintext metadata that is integrity-protected but not encrypted. The current implementation passes no AAD:

```typescript
await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
```

This means an attacker who can manipulate the ciphertext storage could swap messages between sessions or reorder them without detection (if they could also swap the IVs). Adding the session ID, message sequence number, and sender identity as AAD would bind the ciphertext to its context.

**Recommendation (Stage 1):**
```typescript
const aad = new TextEncoder().encode(JSON.stringify({
  session: sessionId,
  seq: messageSequenceNumber,
  sender: senderName,
}));
await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoded);
```

### AP4: Base64 encoding in error paths may leak timing (VERY LOW)

The `base64ToBuffer` and `bufferToBase64` functions use string concatenation in loops, which is not constant-time. However, since these operate on ciphertext (not secrets), and the Web Crypto decrypt function handles the actual timing-sensitive comparison (GCM tag verification), this is not exploitable in practice.

### AP5: Server keypair regenerated on every restart (LOW)

In `bridge.ts`:
```typescript
const serverKeypair = generateKeypair();
```

The bridge server generates a fresh keypair on each process start. This means:
- The server's Nostr identity changes on every restart.
- External relays subscribed to the server's pubkey lose continuity.
- No key continuity checking is possible.

**Recommendation:** Persist the server keypair in macOS Keychain (alongside the nsec migration in W5). Load on startup, generate only if not found.

### AP6: No certificate pinning or relay URL validation for external relay pool (LOW)

The relay pool connects to external Nostr relays via WebSocket without certificate pinning. A MITM on the WebSocket connection could inject events. The event signature verification mitigates this (forged events would fail sig check), but a MITM could still drop or delay events.

**Recommendation:** This is acceptable for Stage 1. TLS provides sufficient transport security for the relay pool. Certificate pinning would be a Stage 3+ hardening measure.

---

## 7. Summary Table

| ID | Finding | Severity | Stage to Fix |
|----|---------|----------|-------------|
| W1 | Key extractability unnecessarily broad | LOW | 1 |
| W2 | No GCM nonce exhaustion tracking | LOW | 1 |
| W3 | No forward secrecy (single session key) | MEDIUM | 2 |
| W4 | No message franking / sender auth | MEDIUM | 2 |
| W5 | nsec stored in plaintext JSON | HIGH | 1 |
| W6 | crypto.js duplicates crypto.ts | LOW | 1 |
| AP1 | No deterministic nonce fallback | LOW | 2 |
| AP2 | No secret zeroization | LOW | 1 |
| AP3 | No AAD in GCM encryption | MEDIUM | 1 |
| AP4 | Non-constant-time base64 | VERY LOW | N/A |
| AP5 | Server keypair regenerated on restart | LOW | 1 |
| AP6 | No cert pinning for relay pool | LOW | 3 |

**Stage 1 priority order:** W5 (nsec storage) > AP3 (AAD) > W1 (extractability) > AP2 (zeroization) > AP5 (server keypair persistence) > W6 (dedup crypto.js) > W2 (nonce tracking)

---

*Report generated by crypto research agent. No source code was modified.*
