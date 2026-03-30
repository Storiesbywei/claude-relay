/**
 * Noise-Inspired Transport Encryption — ChaCha20-Poly1305
 *
 * Provides authenticated encryption for HTTP request/response bodies once
 * a Noise handshake has established transport keys.
 *
 * Wire format (binary, sent as base64 over HTTP):
 *   [12-byte nonce][ciphertext + 16-byte Poly1305 tag]
 *
 * Nonce management:
 *   - Each direction maintains an independent 64-bit counter (little-endian)
 *     stored in the low 8 bytes of the 12-byte nonce (high 4 bytes are zero).
 *   - The counter MUST be incremented after every encrypt/decrypt.
 *   - Counter overflow at 2^64 is not a practical concern for HTTP transport
 *     (would require ~18 quintillion messages).
 *
 * Security properties:
 *   - Confidentiality: ChaCha20 stream cipher
 *   - Integrity: Poly1305 MAC (AEAD)
 *   - Replay protection: monotonic nonce counters (enforced by the session store)
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// ─── Nonce Counter ──────────────────────────────────────────────────────────

/**
 * Build a 12-byte nonce from a 64-bit counter value.
 * Layout: [4 zero bytes][8-byte little-endian counter]
 */
export function counterToNonce(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  // Store counter as two 32-bit LE values in bytes 4..11
  view.setUint32(4, Number(counter & 0xFFFFFFFFn), true);
  view.setUint32(8, Number((counter >> 32n) & 0xFFFFFFFFn), true);
  return nonce;
}

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────────

/**
 * Encrypt a plaintext payload with ChaCha20-Poly1305.
 *
 * @param plaintext - Raw bytes to encrypt
 * @param key       - 32-byte symmetric key (from HKDF)
 * @param nonce     - 12-byte nonce (from counterToNonce)
 * @returns Ciphertext with appended 16-byte Poly1305 auth tag
 */
export function encryptTransport(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const cipher = chacha20poly1305(key, nonce);
  return cipher.encrypt(plaintext);
}

/**
 * Decrypt a ChaCha20-Poly1305 ciphertext.
 *
 * @param ciphertext - Ciphertext + 16-byte Poly1305 auth tag
 * @param key        - 32-byte symmetric key (from HKDF)
 * @param nonce      - 12-byte nonce (from counterToNonce)
 * @returns Decrypted plaintext bytes
 * @throws If the auth tag verification fails (tampered or wrong key)
 */
export function decryptTransport(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const cipher = chacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Encode binary payload as base64 for HTTP transport.
 * Wire format: base64(nonce || ciphertext_with_tag)
 */
export function packEncryptedPayload(nonce: Uint8Array, ciphertext: Uint8Array): string {
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);
  let binary = "";
  for (let i = 0; i < packed.length; i++) {
    binary += String.fromCharCode(packed[i]);
  }
  return btoa(binary);
}

/**
 * Unpack a base64 encrypted payload into nonce + ciphertext.
 */
export function unpackEncryptedPayload(b64: string): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const binary = atob(b64);
  const packed = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    packed[i] = binary.charCodeAt(i);
  }
  return {
    nonce: packed.slice(0, 12),
    ciphertext: packed.slice(12),
  };
}
