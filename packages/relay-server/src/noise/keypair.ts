/**
 * Noise-Inspired Key Agreement — X25519 Keypair Management
 *
 * The server generates a static X25519 keypair at startup and persists it in
 * SQLite so it survives restarts. Clients pin this public key and use it for
 * the ECDH handshake that establishes transport encryption keys.
 *
 * Cryptographic primitives:
 *   - X25519 (Curve25519 Diffie-Hellman) via @noble/curves
 *   - HKDF-SHA256 via @noble/hashes for key derivation
 *
 * Inspired by the Noise IK pattern: the initiator (client) knows the
 * responder's (server) static public key upfront.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NoiseKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface TransportKeys {
  /** Key for encrypting client→server payloads */
  clientToServer: Uint8Array;
  /** Key for encrypting server→client payloads */
  serverToClient: Uint8Array;
}

// ─── Key Generation ──────────────────────────────────────────────────────────

/**
 * Generate a fresh X25519 keypair.
 * The private key is 32 bytes of cryptographic randomness.
 * The public key is the X25519 base point scalar multiplication.
 */
export function generateNoiseKeypair(): NoiseKeypair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ─── ECDH + Key Derivation ──────────────────────────────────────────────────

/**
 * Compute X25519 shared secret from our private key and their public key.
 * Returns a 32-byte shared secret (NOT suitable for direct use as a key —
 * must be passed through HKDF first).
 */
export function computeSharedSecret(
  ourPrivate: Uint8Array,
  theirPublic: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(ourPrivate, theirPublic);
}

/**
 * Derive directional transport keys from a shared secret using HKDF-SHA256.
 *
 * The salt is the concatenation of both public keys (initiator first, then
 * responder) to provide domain separation — even if two different handshakes
 * produce the same shared secret, the derived keys will differ.
 *
 * Output: 64 bytes split into two 32-byte ChaCha20-Poly1305 keys:
 *   - bytes  0..31: client→server encryption key
 *   - bytes 32..63: server→client encryption key
 *
 * @param sharedSecret    - Raw X25519 shared secret (32 bytes)
 * @param initiatorPublic - Client's ephemeral X25519 public key
 * @param responderPublic - Server's static X25519 public key
 */
export function deriveTransportKeys(
  sharedSecret: Uint8Array,
  initiatorPublic: Uint8Array,
  responderPublic: Uint8Array,
): TransportKeys {
  // Salt = initiator_pub || responder_pub (64 bytes)
  const salt = new Uint8Array(initiatorPublic.length + responderPublic.length);
  salt.set(initiatorPublic, 0);
  salt.set(responderPublic, initiatorPublic.length);

  const info = new TextEncoder().encode("claude-relay-noise-v1");

  // Derive 64 bytes: first 32 for client→server, last 32 for server→client
  const prk = hkdf(sha256, sharedSecret, salt, info, 64);

  return {
    clientToServer: prk.slice(0, 32),
    serverToClient: prk.slice(32, 64),
  };
}

// ─── Encoding Helpers ────────────────────────────────────────────────────────

/** Encode a Uint8Array as standard base64 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string to Uint8Array */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
