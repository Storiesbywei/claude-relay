/**
 * Crypto Module Unit Tests
 *
 * Tests for AES-256-GCM encryption, HKDF key derivation, key fingerprints,
 * and URL-safe base64 encoding used by the Scan-then-Seal E2E encryption.
 */

import { describe, it, expect } from "bun:test";
import {
  generateSecret,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  getKeyFingerprint,
  exportSessionKey,
  importSessionKey,
  toUrlSafeBase64,
  fromUrlSafeBase64,
  isEncryptedPayload,
  parseEncryptedContent,
  type EncryptedPayload,
} from "../src/crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeKey(sessionId = "test-session") {
  const secret = generateSecret();
  return { secret, key: await deriveSessionKey(secret, sessionId) };
}

// ---------------------------------------------------------------------------
// Secret Generation
// ---------------------------------------------------------------------------

describe("generateSecret", () => {
  it("produces a 32-byte Uint8Array", () => {
    const secret = generateSecret();
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret.length).toBe(32);
  });

  it("produces different values on each call", () => {
    const a = generateSecret();
    const b = generateSecret();
    // Probability of collision is negligible (2^-256)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Key Derivation (HKDF)
// ---------------------------------------------------------------------------

describe("deriveSessionKey", () => {
  it("is deterministic: same secret + session -> same key", async () => {
    const secret = generateSecret();
    const keyA = await deriveSessionKey(secret, "session-1");
    const keyB = await deriveSessionKey(secret, "session-1");

    const rawA = await crypto.subtle.exportKey("raw", keyA);
    const rawB = await crypto.subtle.exportKey("raw", keyB);

    expect(Buffer.from(rawA).equals(Buffer.from(rawB))).toBe(true);
  });

  it("different sessions produce different keys", async () => {
    const secret = generateSecret();
    const keyA = await deriveSessionKey(secret, "session-1");
    const keyB = await deriveSessionKey(secret, "session-2");

    const rawA = await crypto.subtle.exportKey("raw", keyA);
    const rawB = await crypto.subtle.exportKey("raw", keyB);

    expect(Buffer.from(rawA).equals(Buffer.from(rawB))).toBe(false);
  });

  it("different secrets with same session produce different keys", async () => {
    const secretA = generateSecret();
    const secretB = generateSecret();
    const keyA = await deriveSessionKey(secretA, "session-1");
    const keyB = await deriveSessionKey(secretB, "session-1");

    const rawA = await crypto.subtle.exportKey("raw", keyA);
    const rawB = await crypto.subtle.exportKey("raw", keyB);

    expect(Buffer.from(rawA).equals(Buffer.from(rawB))).toBe(false);
  });

  it("returns an AES-256-GCM CryptoKey", async () => {
    const { key } = await makeKey();
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.extractable).toBe(true);
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });
});

// ---------------------------------------------------------------------------
// Encrypt / Decrypt Round-Trip
// ---------------------------------------------------------------------------

describe("encryptMessage / decryptMessage", () => {
  it("round-trip: plaintext -> encrypt -> decrypt -> same plaintext", async () => {
    const { key } = await makeKey();
    const plaintext = "Hello, world!";

    const payload = await encryptMessage(plaintext, key);
    const decrypted = await decryptMessage(payload, key);

    expect(decrypted).toBe(plaintext);
  });

  it("wrong key: decrypt with different key throws", async () => {
    const { key: keyA } = await makeKey("session-a");
    const { key: keyB } = await makeKey("session-b");

    const payload = await encryptMessage("secret data", keyA);

    expect(decryptMessage(payload, keyB)).rejects.toThrow();
  });

  it("tampered ciphertext: modified bytes cause GCM auth tag failure", async () => {
    const { key } = await makeKey();
    const payload = await encryptMessage("sensitive info", key);

    // Decode ciphertext, flip a byte, re-encode
    const ctBytes = new Uint8Array(
      Uint8Array.from(atob(payload.ciphertext), (c) => c.charCodeAt(0)).buffer
    );
    ctBytes[0] ^= 0xff; // Flip first byte
    const tampered: EncryptedPayload = {
      ...payload,
      ciphertext: btoa(String.fromCharCode(...ctBytes)),
    };

    expect(decryptMessage(tampered, key)).rejects.toThrow();
  });

  it("tampered IV: modified IV causes decryption failure", async () => {
    const { key } = await makeKey();
    const payload = await encryptMessage("sensitive info", key);

    // Decode IV, flip a byte, re-encode
    const ivBytes = new Uint8Array(
      Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0)).buffer
    );
    ivBytes[0] ^= 0xff;
    const tampered: EncryptedPayload = {
      ...payload,
      iv: btoa(String.fromCharCode(...ivBytes)),
    };

    expect(decryptMessage(tampered, key)).rejects.toThrow();
  });

  it("unique IVs: two encryptions of same plaintext produce different ciphertexts", async () => {
    const { key } = await makeKey();
    const plaintext = "identical message";

    const payloadA = await encryptMessage(plaintext, key);
    const payloadB = await encryptMessage(plaintext, key);

    // IVs must differ
    expect(payloadA.iv).not.toBe(payloadB.iv);
    // Ciphertexts must differ (different IV -> different ciphertext even for same plaintext)
    expect(payloadA.ciphertext).not.toBe(payloadB.ciphertext);

    // Both must decrypt to the same plaintext
    expect(await decryptMessage(payloadA, key)).toBe(plaintext);
    expect(await decryptMessage(payloadB, key)).toBe(plaintext);
  });

  it("empty string: encrypt/decrypt handles empty content", async () => {
    const { key } = await makeKey();
    const payload = await encryptMessage("", key);
    const decrypted = await decryptMessage(payload, key);
    expect(decrypted).toBe("");
  });

  it("large message: encrypt/decrypt handles 100KB content", async () => {
    const { key } = await makeKey();
    const large = "A".repeat(102_400); // 100KB

    const payload = await encryptMessage(large, key);
    const decrypted = await decryptMessage(payload, key);
    expect(decrypted).toBe(large);
    expect(decrypted.length).toBe(102_400);
  });

  it("unicode content: emoji, CJK, RTL text survives encryption round-trip", async () => {
    const { key } = await makeKey();
    const unicode = "Hello! Emoji: \u{1F600}\u{1F680}\u{1F4A5} CJK: \u4F60\u597D\u4E16\u754C RTL: \u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 Mixed: caf\u00E9 \u00FC\u00F1\u00EE\u00E7\u00F6d\u00E9";

    const payload = await encryptMessage(unicode, key);
    const decrypted = await decryptMessage(payload, key);
    expect(decrypted).toBe(unicode);
  });

  it("encrypted payload has correct shape", async () => {
    const { key } = await makeKey();
    const payload = await encryptMessage("test", key);

    expect(payload.encrypted).toBe(true);
    expect(typeof payload.ciphertext).toBe("string");
    expect(typeof payload.iv).toBe("string");
    // IV should be 12 bytes -> 16 base64 chars
    expect(atob(payload.iv).length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Key Fingerprint
// ---------------------------------------------------------------------------

describe("getKeyFingerprint", () => {
  it("is deterministic for the same key", async () => {
    const { key } = await makeKey();
    const fpA = await getKeyFingerprint(key);
    const fpB = await getKeyFingerprint(key);

    expect(fpA.short).toBe(fpB.short);
    expect(fpA.full).toBe(fpB.full);
  });

  it("different keys produce different fingerprints", async () => {
    const { key: keyA } = await makeKey("session-a");
    const { key: keyB } = await makeKey("session-b");

    const fpA = await getKeyFingerprint(keyA);
    const fpB = await getKeyFingerprint(keyB);

    expect(fpA.short).not.toBe(fpB.short);
    expect(fpA.full).not.toBe(fpB.full);
  });

  it("short fingerprint is 8 hex characters", async () => {
    const { key } = await makeKey();
    const fp = await getKeyFingerprint(key);

    expect(fp.short).toMatch(/^[0-9a-f]{8}$/);
  });

  it("full fingerprint is 64 hex characters (SHA-256)", async () => {
    const { key } = await makeKey();
    const fp = await getKeyFingerprint(key);

    expect(fp.full).toMatch(/^[0-9a-f]{64}$/);
  });

  it("short is the prefix of full", async () => {
    const { key } = await makeKey();
    const fp = await getKeyFingerprint(key);

    expect(fp.full.startsWith(fp.short)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Key Export / Import
// ---------------------------------------------------------------------------

describe("exportSessionKey / importSessionKey", () => {
  it("round-trip: export -> import -> same key material", async () => {
    const { key } = await makeKey();
    const exported = await exportSessionKey(key);
    const imported = await importSessionKey(exported);

    // Verify by encrypting with original, decrypting with imported
    const payload = await encryptMessage("cross-key test", key);
    const decrypted = await decryptMessage(payload, imported);
    expect(decrypted).toBe("cross-key test");
  });
});

// ---------------------------------------------------------------------------
// URL-Safe Base64
// ---------------------------------------------------------------------------

describe("toUrlSafeBase64 / fromUrlSafeBase64", () => {
  it("round-trip encoding preserves data", () => {
    const original = crypto.getRandomValues(new Uint8Array(32));
    const encoded = toUrlSafeBase64(original.buffer);
    const decoded = fromUrlSafeBase64(encoded);

    expect(
      Buffer.from(new Uint8Array(decoded)).equals(Buffer.from(original))
    ).toBe(true);
  });

  it("output contains no +, /, or = characters", () => {
    // Generate many random buffers to increase chance of hitting +, /, =
    for (let i = 0; i < 50; i++) {
      const buf = crypto.getRandomValues(new Uint8Array(32));
      const encoded = toUrlSafeBase64(buf.buffer);

      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      expect(encoded).not.toContain("=");
    }
  });

  it("handles empty buffer", () => {
    const empty = new Uint8Array(0);
    const encoded = toUrlSafeBase64(empty.buffer);
    const decoded = fromUrlSafeBase64(encoded);
    expect(new Uint8Array(decoded).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Payload Detection
// ---------------------------------------------------------------------------

describe("isEncryptedPayload", () => {
  it("returns true for valid encrypted payload", () => {
    expect(
      isEncryptedPayload({
        encrypted: true,
        ciphertext: "abc123",
        iv: "def456",
      })
    ).toBe(true);
  });

  it("returns false for plaintext object", () => {
    expect(isEncryptedPayload({ content: "hello" })).toBe(false);
  });

  it("returns false for null/undefined/string", () => {
    expect(isEncryptedPayload(null)).toBe(false);
    expect(isEncryptedPayload(undefined)).toBe(false);
    expect(isEncryptedPayload("hello")).toBe(false);
  });

  it("returns false if encrypted is not true", () => {
    expect(
      isEncryptedPayload({
        encrypted: false,
        ciphertext: "abc",
        iv: "def",
      })
    ).toBe(false);
  });

  it("returns false if ciphertext or iv is missing", () => {
    expect(isEncryptedPayload({ encrypted: true, iv: "def" })).toBe(false);
    expect(isEncryptedPayload({ encrypted: true, ciphertext: "abc" })).toBe(
      false
    );
  });
});

describe("parseEncryptedContent", () => {
  it("parses valid encrypted JSON string", async () => {
    const { key } = await makeKey();
    const payload = await encryptMessage("test", key);
    const json = JSON.stringify(payload);

    const parsed = parseEncryptedContent(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.encrypted).toBe(true);
    expect(parsed!.ciphertext).toBe(payload.ciphertext);
  });

  it("returns null for plaintext string", () => {
    expect(parseEncryptedContent("just a regular message")).toBeNull();
  });

  it("returns null for non-encrypted JSON", () => {
    expect(parseEncryptedContent('{"foo": "bar"}')).toBeNull();
  });
});
