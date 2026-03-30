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

// ─── Capability Lattice: Key Rotation ────────────────────────────────────────

/**
 * Rotate the session key by deriving a new version from the current secret
 * plus a random nonce. Used when inviting or revoking an agent.
 *
 * The derivation chain is:
 *   keyV(n+1) = HKDF(currentSecret || nonce, sessionId + ":v" + version)
 *
 * This provides forward secrecy at the invite boundary:
 * - An invited agent receives keyV2 but NOT keyV1 (cannot read pre-invite messages)
 * - A revoked agent had keyV2 but does NOT receive keyV3 (cannot read post-revoke)
 * - Humans receive all key versions and can read the full history
 *
 * @param currentSecret - The current session secret (raw bytes)
 * @param nonce - 32-byte random nonce for this rotation
 * @param sessionId - Session ID for domain separation
 * @param version - New key version number
 * @returns The new CryptoKey and the new raw secret bytes
 */
export async function rotateSessionKey(
  currentSecret: Uint8Array,
  nonce: Uint8Array,
  sessionId: string,
  version: number
): Promise<{ key: CryptoKey; secret: Uint8Array }> {
  // Concatenate current secret + nonce to form new key material
  const combined = new Uint8Array(currentSecret.length + nonce.length);
  combined.set(currentSecret, 0);
  combined.set(nonce, currentSecret.length);

  // Hash the combined material to get a fixed-length 32-byte new secret
  const hashBuffer = await crypto.subtle.digest("SHA-256", combined);
  const newSecret = new Uint8Array(hashBuffer);

  // Derive the new session key with version-tagged info string
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    newSecret,
    "HKDF",
    false,
    ["deriveKey"]
  );

  const salt = new TextEncoder().encode(sessionId);
  const info = new TextEncoder().encode(`claude-relay-e2e:v${version}`);

  const key = await crypto.subtle.deriveKey(
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

  return { key, secret: newSecret };
}

/**
 * Generate a random 32-byte nonce for key rotation.
 */
export function generateRotationNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Create an encrypted key grant for an agent.
 *
 * The session secret is encrypted using AES-256-GCM with a wrapping key
 * derived from a pre-shared key (PSK) between the human and agent.
 * The PSK can be:
 *   - Embedded in the MCP transport configuration
 *   - Exchanged out-of-band (e.g., via the invite URL)
 *   - Derived from the agent's MCP client ID + a secret
 *
 * @param sessionSecret - Raw session secret bytes to grant
 * @param wrappingKey - AES-256-GCM key to encrypt the grant with
 * @returns Base64-encoded encrypted grant (ciphertext + IV)
 */
export async function createKeyGrant(
  sessionSecret: Uint8Array,
  wrappingKey: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    sessionSecret
  );

  // Pack IV (12 bytes) + ciphertext into a single buffer
  const packed = new Uint8Array(12 + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), 12);

  return bufferToBase64(packed.buffer);
}

/**
 * Decrypt a key grant to recover the session secret.
 *
 * @param encryptedGrant - Base64-encoded encrypted grant from createKeyGrant
 * @param wrappingKey - The same AES-256-GCM wrapping key used to create the grant
 * @returns The raw session secret bytes
 */
export async function decryptKeyGrant(
  encryptedGrant: string,
  wrappingKey: CryptoKey
): Promise<Uint8Array> {
  const packed = new Uint8Array(base64ToBuffer(encryptedGrant));

  // Unpack IV (first 12 bytes) + ciphertext (rest)
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    ciphertext
  );

  return new Uint8Array(plaintext);
}

/**
 * Derive a wrapping key from a pre-shared key string and agent ID.
 * Used to encrypt/decrypt key grants for a specific agent.
 *
 * @param psk - Pre-shared key (e.g., from MCP config or invite URL)
 * @param agentId - Agent identifier for domain separation
 * @returns AES-256-GCM wrapping key
 */
export async function deriveWrappingKey(
  psk: string,
  agentId: string
): Promise<CryptoKey> {
  const pskBytes = new TextEncoder().encode(psk);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    pskBytes,
    "HKDF",
    false,
    ["deriveKey"]
  );

  const salt = new TextEncoder().encode(agentId);
  const info = new TextEncoder().encode("claude-relay-key-grant");

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable — wrapping keys should not leak
    ["encrypt", "decrypt"]
  );
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
