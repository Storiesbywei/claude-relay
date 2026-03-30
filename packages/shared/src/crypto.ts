/**
 * Scan-then-Seal Encryption Module
 *
 * AES-256-GCM symmetric encryption using the Web Crypto API.
 * Session keys are derived from a shared secret via HKDF.
 * The content scanner runs client-side BEFORE encryption.
 * The server only ever sees ciphertext.
 *
 * Key flow:
 *   1. Creator generates a random 32-byte secret
 *   2. Secret is embedded in the invite URL fragment (#key=...)
 *   3. HKDF derives the AES-256-GCM key from that secret + session ID as salt
 *   4. Each message gets a fresh random 12-byte IV
 *   5. GCM provides authenticated encryption (integrity + confidentiality)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** Base64-encoded ciphertext (includes GCM auth tag) */
  ciphertext: string;
  /** Base64-encoded 12-byte initialization vector */
  iv: string;
  /** Marker flag — always true for encrypted payloads */
  encrypted: true;
}

export interface KeyFingerprint {
  /** First 8 hex characters of SHA-256 hash of the exported key */
  short: string;
  /** Full SHA-256 hex hash of the exported key */
  full: string;
}

// ─── Encoding Helpers ────────────────────────────────────────────────────────

/** Convert ArrayBuffer to base64 string */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert base64 string to ArrayBuffer */
function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Convert ArrayBuffer to hex string */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── URL-Safe Base64 ─────────────────────────────────────────────────────────

/** Encode to URL-safe base64 (no padding, +/ replaced with -_) */
export function toUrlSafeBase64(buffer: ArrayBuffer): string {
  return bufferToBase64(buffer)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode from URL-safe base64 */
export function fromUrlSafeBase64(urlSafe: string): ArrayBuffer {
  let b64 = urlSafe.replace(/-/g, "+").replace(/_/g, "/");
  // Re-add padding
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  return base64ToBuffer(b64);
}

// ─── Secret Generation ───────────────────────────────────────────────────────

/**
 * Generate a 32-byte random secret for key derivation.
 * This secret is shared out-of-band via the invite URL fragment.
 */
export function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ─── Key Derivation (HKDF) ──────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from a shared secret and session ID.
 * Uses HKDF with SHA-256.
 *
 * @param secret - 32-byte shared secret
 * @param sessionId - Session ID used as salt (binds key to session)
 */
export async function deriveSessionKey(
  secret: Uint8Array,
  sessionId: string
): Promise<CryptoKey> {
  // Import the raw secret as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secret,
    "HKDF",
    false,
    ["deriveKey"]
  );

  // Use session ID as salt, "claude-relay-e2e" as info
  const salt = new TextEncoder().encode(sessionId);
  const info = new TextEncoder().encode("claude-relay-e2e");

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true, // extractable for fingerprint computation
    ["encrypt", "decrypt"]
  );
}

// ─── Key Export/Import ───────────────────────────────────────────────────────

/**
 * Export a CryptoKey as a base64 string.
 * Used for debugging/display only — prefer deriveSessionKey for key management.
 */
export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufferToBase64(raw);
}

/**
 * Import a base64-encoded key as a CryptoKey.
 */
export async function importSessionKey(b64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(b64);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// ─── Key Fingerprint ─────────────────────────────────────────────────────────

/**
 * Compute a fingerprint of the session key for out-of-band verification.
 * Returns the first 8 hex chars of the SHA-256 hash of the raw key bytes.
 */
export async function getKeyFingerprint(
  key: CryptoKey
): Promise<KeyFingerprint> {
  const raw = await crypto.subtle.exportKey("raw", key);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  const full = bufferToHex(hash);
  return {
    short: full.slice(0, 8),
    full,
  };
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext message with AES-256-GCM.
 *
 * - Generates a fresh random 12-byte IV for every message (NEVER reused)
 * - GCM auth tag is appended to the ciphertext by Web Crypto
 * - Returns base64-encoded ciphertext and IV
 *
 * IMPORTANT: Run the content scanner on `plaintext` BEFORE calling this.
 */
export async function encryptMessage(
  plaintext: string,
  key: CryptoKey
): Promise<EncryptedPayload> {
  // 12-byte random IV — required for GCM, must never be reused with same key
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encoded = new TextEncoder().encode(plaintext);

  // AES-256-GCM encryption (auth tag is included in the output)
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    encrypted: true,
  };
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypt an AES-256-GCM encrypted payload.
 *
 * Throws if:
 * - The auth tag verification fails (tampered ciphertext)
 * - The key is wrong
 * - The IV is malformed
 */
export async function decryptMessage(
  payload: EncryptedPayload,
  key: CryptoKey
): Promise<string> {
  const ciphertextBuffer = base64ToBuffer(payload.ciphertext);
  const iv = base64ToBuffer(payload.iv);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertextBuffer
  );

  return new TextDecoder().decode(plaintextBuffer);
}

// ─── Payload Detection ───────────────────────────────────────────────────────

/**
 * Check if a message content string is an encrypted payload.
 * Encrypted messages are JSON-encoded EncryptedPayload objects stored in the
 * `content` field with the `encrypted` flag set on the message.
 */
export function isEncryptedPayload(obj: unknown): obj is EncryptedPayload {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    o.encrypted === true &&
    typeof o.ciphertext === "string" &&
    typeof o.iv === "string"
  );
}

/**
 * Parse a message content string that might be an encrypted payload.
 * Returns the parsed EncryptedPayload if valid, or null if it's plaintext.
 */
export function parseEncryptedContent(
  content: string
): EncryptedPayload | null {
  try {
    const parsed = JSON.parse(content);
    if (isEncryptedPayload(parsed)) return parsed;
  } catch {
    // Not JSON — it's plaintext
  }
  return null;
}
