/**
 * Symmetric Hash Ratchet — Per-message forward secrecy for Signal Mode
 *
 * Provides MLS-inspired key derivation without the complexity of asymmetric
 * tree operations. Each message gets a unique key derived from a hash chain.
 *
 * Properties:
 * - Forward secrecy: compromise of message N doesn't expose messages 0..N-1
 * - Post-compromise security: key update resets the chain with fresh entropy
 * - Out-of-order tolerance: skipped message keys are cached (up to maxSkip)
 *
 * Key schedule:
 *   chain_key[0]   = HKDF-Expand(HKDF-Extract(session_secret, session_id), "ratchet-init", 32)
 *   chain_key[n+1] = HKDF-Expand(chain_key[n], "chain-step", 32)
 *   message_key[n] = HKDF-Expand(chain_key[n], "message-key", 32)
 *
 * After deriving message_key[n], chain_key[n] is zeroed. Old keys are
 * unrecoverable — that's the whole point.
 *
 * Uses @noble/hashes for HKDF and @noble/ciphers for ChaCha20-Poly1305.
 * No new dependencies required.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { extract, expand } from "@noble/hashes/hkdf.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RatchetState {
  /** Current chain key (32 bytes). Ratchets forward on every encrypt/decrypt. */
  chainKey: Uint8Array;
  /** Current message index (monotonically increasing). */
  messageIndex: number;
  /** Cached keys for out-of-order messages. Map<index, messageKey>. */
  skippedKeys: Map<number, Uint8Array>;
  /** Max messages to skip forward (prevents DoS via huge index gaps). */
  maxSkip: number;
}

export interface RatchetCiphertext {
  /** Base64-encoded ciphertext (ChaCha20-Poly1305). */
  ciphertext: string;
  /** Base64-encoded 12-byte nonce. */
  iv: string;
  /** Message index in the ratchet chain. */
  index: number;
  /** Marker: ratchet-encrypted payload. */
  ratchet: true;
}

export interface KeyUpdatePayload {
  /** Fresh entropy mixed into the chain (32 bytes, base64). */
  entropy: string;
  /** Message index at which the update takes effect. */
  index: number;
  /** Marker: key update message. */
  key_update: true;
}

// ─── Encoding Helpers ────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Core Ratchet Operations ─────────────────────────────────────────────────

const CHAIN_STEP_INFO = new TextEncoder().encode("chain-step");
const MESSAGE_KEY_INFO = new TextEncoder().encode("message-key");
const RATCHET_INIT_INFO = new TextEncoder().encode("ratchet-init");

/**
 * Derive the next chain key and the message key for the current step.
 *
 * chain_key[n+1] = HKDF-Expand(chain_key[n], "chain-step", 32)
 * message_key[n] = HKDF-Expand(chain_key[n], "message-key", 32)
 *
 * The input chain key is NOT zeroed here — the caller is responsible
 * for zeroing it after this returns (since they may need to keep
 * a reference for error handling).
 */
export function stepChainKey(chainKey: Uint8Array): {
  nextChainKey: Uint8Array;
  messageKey: Uint8Array;
} {
  // Use the chain key as a PRK (it was already derived via HKDF-Extract)
  const nextChainKey = expand(sha256, chainKey, CHAIN_STEP_INFO, 32);
  const messageKey = expand(sha256, chainKey, MESSAGE_KEY_INFO, 32);

  return { nextChainKey, messageKey };
}

/**
 * Initialize a ratchet from a shared session secret and session ID.
 *
 * chain_key[0] = HKDF(session_secret, session_id, "ratchet-init")
 *
 * Both participants must call this with the same secret + sessionId
 * to get the same initial chain key.
 */
export function initRatchet(
  sessionSecret: Uint8Array,
  sessionId: string,
  maxSkip: number = 100
): RatchetState {
  const salt = new TextEncoder().encode(sessionId);

  // HKDF-Extract then HKDF-Expand to derive the initial chain key
  const prk = extract(sha256, sessionSecret, salt);
  const chainKey = expand(sha256, prk, RATCHET_INIT_INFO, 32);

  return {
    chainKey,
    messageIndex: 0,
    skippedKeys: new Map(),
    maxSkip,
  };
}

/**
 * Encrypt a plaintext message using the ratchet.
 *
 * Steps the chain forward, encrypts with ChaCha20-Poly1305 using a
 * fresh random 12-byte nonce, and returns the ciphertext + nonce + index.
 * The old chain key is zeroed after stepping.
 */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: string
): RatchetCiphertext {
  const { nextChainKey, messageKey } = stepChainKey(state.chainKey);
  const currentIndex = state.messageIndex;

  // Zero the old chain key before replacing
  state.chainKey.fill(0);
  state.chainKey = nextChainKey;
  state.messageIndex++;

  // Encrypt with ChaCha20-Poly1305
  const nonce = randomBytes(12);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const cipher = chacha20poly1305(messageKey, nonce);
  const ciphertextBytes = cipher.encrypt(plaintextBytes);

  // Zero the message key — it's single-use
  messageKey.fill(0);

  return {
    ciphertext: toBase64(ciphertextBytes),
    iv: toBase64(nonce),
    index: currentIndex,
    ratchet: true,
  };
}

/**
 * Decrypt a ratchet-encrypted message.
 *
 * Handles three cases:
 * 1. index === state.messageIndex: step the chain and decrypt (normal case)
 * 2. index > state.messageIndex: skip forward, caching intermediate keys
 * 3. index < state.messageIndex: look up from skippedKeys cache
 *
 * Throws if:
 * - The index gap exceeds maxSkip (DoS protection)
 * - The skipped key is not in the cache (message already consumed or too old)
 * - Decryption fails (wrong key, corrupted ciphertext, tampered auth tag)
 */
export function ratchetDecrypt(
  state: RatchetState,
  ciphertext: string,
  iv: string,
  index: number
): string {
  const ciphertextBytes = fromBase64(ciphertext);
  const nonce = fromBase64(iv);

  let messageKey: Uint8Array;

  if (index < state.messageIndex) {
    // Case 3: Message from the past — check skipped keys
    const cached = state.skippedKeys.get(index);
    if (!cached) {
      throw new Error(
        `Ratchet: no cached key for index ${index} (already consumed or too old)`
      );
    }
    messageKey = cached;
    state.skippedKeys.delete(index);
  } else if (index === state.messageIndex) {
    // Case 1: Expected next message — step the chain
    const { nextChainKey, messageKey: mk } = stepChainKey(state.chainKey);
    state.chainKey.fill(0);
    state.chainKey = nextChainKey;
    state.messageIndex++;
    messageKey = mk;
  } else {
    // Case 2: Future message — skip forward, caching intermediate keys
    const skip = index - state.messageIndex;
    if (skip > state.maxSkip) {
      throw new Error(
        `Ratchet: skip ${skip} exceeds maxSkip ${state.maxSkip} (DoS protection)`
      );
    }

    // Step forward, caching each skipped message key
    for (let i = state.messageIndex; i < index; i++) {
      const { nextChainKey, messageKey: skippedMk } = stepChainKey(
        state.chainKey
      );
      state.chainKey.fill(0);
      state.chainKey = nextChainKey;
      state.skippedKeys.set(i, skippedMk);
    }

    // Now step once more for the target index
    const { nextChainKey, messageKey: mk } = stepChainKey(state.chainKey);
    state.chainKey.fill(0);
    state.chainKey = nextChainKey;
    state.messageIndex = index + 1;
    messageKey = mk;
  }

  // Decrypt with ChaCha20-Poly1305
  const cipher = chacha20poly1305(messageKey, nonce);
  const plaintextBytes = cipher.decrypt(ciphertextBytes);

  // Zero the message key after use
  messageKey.fill(0);

  return new TextDecoder().decode(plaintextBytes);
}

/**
 * Perform a key update — mix fresh entropy into the chain for
 * post-compromise security.
 *
 * After a key update, even if the current chain key was compromised,
 * future messages are safe (the attacker doesn't have the entropy).
 *
 * Both sides must apply the same key update to stay in sync.
 * The update is typically sent as a special message in the stream.
 *
 * @returns The entropy bytes (to send to the peer) and the index at which the update applies.
 */
export function ratchetKeyUpdate(state: RatchetState): KeyUpdatePayload {
  const entropy = randomBytes(32);
  const currentIndex = state.messageIndex;

  applyKeyUpdate(state, entropy);

  return {
    entropy: toBase64(entropy),
    index: currentIndex,
    key_update: true,
  };
}

/**
 * Apply a key update received from a peer (or generated locally).
 *
 * new_chain_key = HKDF-Extract(entropy, old_chain_key)
 *                 -> HKDF-Expand(prk, "ratchet-init", 32)
 *
 * The old chain key is zeroed. All cached skipped keys are also purged
 * since they belong to the pre-update epoch.
 */
export function applyKeyUpdate(
  state: RatchetState,
  entropy: Uint8Array
): void {
  // Mix entropy with current chain key via HKDF
  const prk = extract(sha256, entropy, state.chainKey);
  const newChainKey = expand(sha256, prk, RATCHET_INIT_INFO, 32);

  // Zero old chain key
  state.chainKey.fill(0);
  state.chainKey = newChainKey;

  // Clear all skipped keys — they belong to the old epoch
  for (const [, key] of state.skippedKeys) {
    key.fill(0);
  }
  state.skippedKeys.clear();

  // messageIndex continues incrementing (no reset)
}

/**
 * Securely zero all key material in the ratchet state.
 * Call this when the session ends or on shutdown.
 *
 * Note: JavaScript GC may retain copies of the old Uint8Array contents.
 * This is a best-effort wipe — for true zeroization, use a native module.
 */
export function zeroize(state: RatchetState): void {
  state.chainKey.fill(0);

  for (const [, key] of state.skippedKeys) {
    key.fill(0);
  }
  state.skippedKeys.clear();

  state.messageIndex = 0;
}

// ─── Sealed Sender Helpers ───────────────────────────────────────────────────

/**
 * Wrap a plaintext message with the sender's identity INSIDE the payload.
 * The relay server sees only opaque ciphertext — no sender information.
 */
export function sealSender(senderName: string, content: string): string {
  return JSON.stringify({ sender: senderName, content });
}

/**
 * Extract the sender name and content from a sealed-sender payload.
 * Called after decryption on the receiving end.
 */
export function unsealSender(
  decryptedPayload: string
): { sender: string; content: string } | null {
  try {
    const parsed = JSON.parse(decryptedPayload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.sender === "string" &&
      typeof parsed.content === "string"
    ) {
      return { sender: parsed.sender, content: parsed.content };
    }
  } catch {
    // Not a sealed-sender payload — return null
  }
  return null;
}

/**
 * Check if a decrypted payload is a key update message.
 */
export function isKeyUpdatePayload(
  obj: unknown
): obj is KeyUpdatePayload {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    o.key_update === true &&
    typeof o.entropy === "string" &&
    typeof o.index === "number"
  );
}

/**
 * Check if an encrypted payload is a ratchet ciphertext.
 */
export function isRatchetPayload(
  obj: unknown
): obj is RatchetCiphertext {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    o.ratchet === true &&
    typeof o.ciphertext === "string" &&
    typeof o.iv === "string" &&
    typeof o.index === "number"
  );
}
