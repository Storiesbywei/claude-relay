/**
 * NIP-44 / NIP-59 Unit Tests
 *
 * Tests NIP-44 encrypt/decrypt round-trips, conversation key caching,
 * and NIP-59 gift wrap creation/unwrap without requiring a running server.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  getConversationKey,
  encryptNip44,
  decryptNip44,
  clearConversationKeyCache,
  createGiftWrap,
  unwrapGiftWrap,
  isGiftWrap,
  isAddressedTo,
  GIFT_WRAP_KIND,
} from "../src/nostr/nip44.js";

// ---- Helpers ----

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { privateKey: sk, publicKey: pk };
}

// ---- Tests ----

describe("NIP-44 encryption", () => {
  const alice = makeKeypair();
  const bob = makeKeypair();

  beforeEach(() => {
    clearConversationKeyCache();
  });

  it("encrypts and decrypts a round-trip message", () => {
    const convKey = getConversationKey(alice.privateKey, bob.publicKey);
    const plaintext = "Hello from Alice to Bob via NIP-44!";

    const ciphertext = encryptNip44(plaintext, convKey);

    // Ciphertext should be base64, not plaintext
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);

    // Bob derives the same conversation key (ECDH is symmetric)
    const convKeyBob = getConversationKey(bob.privateKey, alice.publicKey);
    const decrypted = decryptNip44(ciphertext, convKeyBob);

    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext each time (random nonce)", () => {
    const convKey = getConversationKey(alice.privateKey, bob.publicKey);
    const plaintext = "same message";

    const ct1 = encryptNip44(plaintext, convKey);
    const ct2 = encryptNip44(plaintext, convKey);

    // Each encryption uses a random nonce, so ciphertext should differ
    expect(ct1).not.toBe(ct2);

    // Both should decrypt to the same plaintext
    expect(decryptNip44(ct1, convKey)).toBe(plaintext);
    expect(decryptNip44(ct2, convKey)).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", () => {
    const convKey = getConversationKey(alice.privateKey, bob.publicKey);
    const ciphertext = encryptNip44("secret", convKey);

    // Eve tries to decrypt with a different conversation key
    const eve = makeKeypair();
    const wrongKey = getConversationKey(eve.privateKey, alice.publicKey);

    expect(() => decryptNip44(ciphertext, wrongKey)).toThrow();
  });
});

describe("Conversation key cache", () => {
  const alice = makeKeypair();
  const bob = makeKeypair();

  beforeEach(() => {
    clearConversationKeyCache();
  });

  it("caches conversation keys for the same peer", () => {
    const key1 = getConversationKey(alice.privateKey, bob.publicKey);
    const key2 = getConversationKey(alice.privateKey, bob.publicKey);

    // Should be the exact same Uint8Array reference (cached)
    expect(key1).toBe(key2);
  });

  it("returns different keys for different peers", () => {
    const eve = makeKeypair();
    const keyBob = getConversationKey(alice.privateKey, bob.publicKey);
    const keyEve = getConversationKey(alice.privateKey, eve.publicKey);

    expect(keyBob).not.toBe(keyEve);
    // Also verify the bytes differ
    expect(Buffer.from(keyBob).equals(Buffer.from(keyEve))).toBe(false);
  });

  it("clears cache properly", () => {
    const key1 = getConversationKey(alice.privateKey, bob.publicKey);
    clearConversationKeyCache();
    const key2 = getConversationKey(alice.privateKey, bob.publicKey);

    // Same value but different object reference (re-derived after cache clear)
    expect(key1).not.toBe(key2);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
  });
});

describe("NIP-59 gift wrap", () => {
  const sender = makeKeypair();
  const recipient = makeKeypair();

  it("creates a valid kind 1059 gift wrap", () => {
    const innerEvent = {
      kind: 4190, // architecture
      content: "This is a secret architecture doc",
      tags: [["t", "architecture"]],
    };

    const wrapped = createGiftWrap(innerEvent, sender.privateKey, recipient.publicKey);

    expect(wrapped.kind).toBe(GIFT_WRAP_KIND);
    expect(wrapped.id).toBeDefined();
    expect(wrapped.sig).toBeDefined();
    // Content should be encrypted (not the original plaintext)
    expect(wrapped.content).not.toBe(innerEvent.content);
    // Should have a "p" tag addressing the recipient
    expect(wrapped.tags.some((t) => t[0] === "p" && t[1] === recipient.publicKey)).toBe(true);
    // Outer pubkey should NOT be the sender (random one-time key per NIP-59)
    expect(wrapped.pubkey).not.toBe(sender.publicKey);
  });

  it("unwraps a gift wrap to recover the inner event", () => {
    const innerEvent = {
      kind: 4194, // question
      content: "What is the relay's architecture?",
      tags: [["t", "question"], ["session", "test-session-123"]],
    };

    const wrapped = createGiftWrap(innerEvent, sender.privateKey, recipient.publicKey);
    const unwrapped = unwrapGiftWrap(wrapped, recipient.privateKey);

    expect(unwrapped).not.toBeNull();
    expect(unwrapped!.kind).toBe(innerEvent.kind);
    expect(unwrapped!.content).toBe(innerEvent.content);
    expect(unwrapped!.pubkey).toBe(sender.publicKey);
  });

  it("fails to unwrap with wrong recipient key", () => {
    const innerEvent = {
      kind: 4190,
      content: "private data",
      tags: [],
    };

    const wrapped = createGiftWrap(innerEvent, sender.privateKey, recipient.publicKey);

    // Eve can't unwrap
    const eve = makeKeypair();
    const result = unwrapGiftWrap(wrapped, eve.privateKey);

    expect(result).toBeNull();
  });

  it("isGiftWrap correctly identifies kind 1059", () => {
    expect(isGiftWrap({ kind: GIFT_WRAP_KIND } as any)).toBe(true);
    expect(isGiftWrap({ kind: 1 } as any)).toBe(false);
    expect(isGiftWrap({ kind: 4190 } as any)).toBe(false);
  });

  it("isAddressedTo checks p tag", () => {
    const event = {
      kind: GIFT_WRAP_KIND,
      tags: [["p", recipient.publicKey]],
    } as any;

    expect(isAddressedTo(event, recipient.publicKey)).toBe(true);
    expect(isAddressedTo(event, sender.publicKey)).toBe(false);
  });
});
