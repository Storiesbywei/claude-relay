import { describe, it, expect } from "bun:test";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  stepChainKey,
  ratchetKeyUpdate,
  applyKeyUpdate,
  zeroize,
  sealSender,
  unsealSender,
  isRatchetPayload,
  isKeyUpdatePayload,
  type RatchetState,
} from "../src/ratchet.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSecret(): Uint8Array {
  return randomBytes(32);
}

function cloneState(state: RatchetState): RatchetState {
  return {
    chainKey: new Uint8Array(state.chainKey),
    messageIndex: state.messageIndex,
    skippedKeys: new Map(
      [...state.skippedKeys.entries()].map(([k, v]) => [k, new Uint8Array(v)])
    ),
    maxSkip: state.maxSkip,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Hash Ratchet", () => {
  describe("initRatchet", () => {
    it("produces deterministic initial state from same secret + sessionId", () => {
      const secret = makeSecret();
      const s1 = initRatchet(secret, "session-1");
      const s2 = initRatchet(secret, "session-1");

      expect(s1.chainKey).toEqual(s2.chainKey);
      expect(s1.messageIndex).toBe(0);
      expect(s2.messageIndex).toBe(0);
    });

    it("produces different state for different session IDs", () => {
      const secret = makeSecret();
      const s1 = initRatchet(secret, "session-1");
      const s2 = initRatchet(secret, "session-2");

      expect(s1.chainKey).not.toEqual(s2.chainKey);
    });

    it("produces different state for different secrets", () => {
      const s1 = initRatchet(makeSecret(), "session-1");
      const s2 = initRatchet(makeSecret(), "session-1");

      expect(s1.chainKey).not.toEqual(s2.chainKey);
    });
  });

  describe("stepChainKey", () => {
    it("produces 32-byte nextChainKey and messageKey", () => {
      const state = initRatchet(makeSecret(), "test");
      const { nextChainKey, messageKey } = stepChainKey(state.chainKey);

      expect(nextChainKey.length).toBe(32);
      expect(messageKey.length).toBe(32);
    });

    it("nextChainKey differs from messageKey", () => {
      const state = initRatchet(makeSecret(), "test");
      const { nextChainKey, messageKey } = stepChainKey(state.chainKey);

      expect(nextChainKey).not.toEqual(messageKey);
    });

    it("is deterministic", () => {
      const secret = makeSecret();
      const s1 = initRatchet(secret, "test");
      const s2 = initRatchet(secret, "test");

      const step1 = stepChainKey(s1.chainKey);
      const step2 = stepChainKey(s2.chainKey);

      expect(step1.nextChainKey).toEqual(step2.nextChainKey);
      expect(step1.messageKey).toEqual(step2.messageKey);
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("encrypts and decrypts a simple message", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test-session");
      const receiver = initRatchet(secret, "test-session");

      const ct = ratchetEncrypt(sender, "hello world");
      const pt = ratchetDecrypt(receiver, ct.ciphertext, ct.iv, ct.index);

      expect(pt).toBe("hello world");
    });

    it("encrypts and decrypts multiple sequential messages", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      const messages = ["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"];

      for (let i = 0; i < messages.length; i++) {
        const ct = ratchetEncrypt(sender, messages[i]);
        expect(ct.index).toBe(i);
        const pt = ratchetDecrypt(receiver, ct.ciphertext, ct.iv, ct.index);
        expect(pt).toBe(messages[i]);
      }

      expect(sender.messageIndex).toBe(5);
      expect(receiver.messageIndex).toBe(5);
    });

    it("produces unique ciphertexts for same plaintext", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");

      const ct1 = ratchetEncrypt(sender, "same message");
      const ct2 = ratchetEncrypt(sender, "same message");

      expect(ct1.ciphertext).not.toBe(ct2.ciphertext);
      expect(ct1.index).not.toBe(ct2.index);
    });

    it("returns correct ratchet payload structure", () => {
      const sender = initRatchet(makeSecret(), "test");
      const ct = ratchetEncrypt(sender, "test");

      expect(ct.ratchet).toBe(true);
      expect(typeof ct.ciphertext).toBe("string");
      expect(typeof ct.iv).toBe("string");
      expect(typeof ct.index).toBe("number");
      expect(isRatchetPayload(ct)).toBe(true);
    });
  });

  describe("forward secrecy", () => {
    it("old chain key cannot decrypt future messages", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Send 5 messages, advancing the sender
      const ciphertexts = [];
      for (let i = 0; i < 5; i++) {
        ciphertexts.push(ratchetEncrypt(sender, `msg-${i}`));
      }

      // Decrypt all 5 on the receiver side
      for (let i = 0; i < 5; i++) {
        const pt = ratchetDecrypt(
          receiver,
          ciphertexts[i].ciphertext,
          ciphertexts[i].iv,
          ciphertexts[i].index
        );
        expect(pt).toBe(`msg-${i}`);
      }

      // Now the receiver is at index 5. It should NOT be able to decrypt
      // messages 0-4 again because those keys were consumed.
      expect(() => {
        ratchetDecrypt(
          receiver,
          ciphertexts[0].ciphertext,
          ciphertexts[0].iv,
          ciphertexts[0].index
        );
      }).toThrow(/no cached key for index 0/);
    });

    it("compromise of current chain key does not expose past messages", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");

      // Send 5 messages
      const ciphertexts = [];
      for (let i = 0; i < 5; i++) {
        ciphertexts.push(ratchetEncrypt(sender, `secret-${i}`));
      }

      // "Steal" the current chain key
      const stolenKey = new Uint8Array(sender.chainKey);

      // Create an attacker state from the stolen key
      const attacker: RatchetState = {
        chainKey: stolenKey,
        messageIndex: sender.messageIndex,
        skippedKeys: new Map(),
        maxSkip: 100,
      };

      // Attacker CAN decrypt future messages (expected — that's what
      // post-compromise security via key update is for)
      const futureCt = ratchetEncrypt(sender, "future message");
      const futureDecrypted = ratchetDecrypt(
        attacker,
        futureCt.ciphertext,
        futureCt.iv,
        futureCt.index
      );
      expect(futureDecrypted).toBe("future message");

      // But attacker CANNOT decrypt past messages (0-4)
      // because those chain keys were zeroed
      for (let i = 0; i < 5; i++) {
        expect(() => {
          ratchetDecrypt(
            attacker,
            ciphertexts[i].ciphertext,
            ciphertexts[i].iv,
            ciphertexts[i].index
          );
        }).toThrow();
      }
    });
  });

  describe("out-of-order messages", () => {
    it("handles receiving messages out of order", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Send 3 messages
      const ct0 = ratchetEncrypt(sender, "msg-0");
      const ct1 = ratchetEncrypt(sender, "msg-1");
      const ct2 = ratchetEncrypt(sender, "msg-2");

      // Receive out of order: 2, 0, 1
      const pt2 = ratchetDecrypt(receiver, ct2.ciphertext, ct2.iv, ct2.index);
      expect(pt2).toBe("msg-2");

      const pt0 = ratchetDecrypt(receiver, ct0.ciphertext, ct0.iv, ct0.index);
      expect(pt0).toBe("msg-0");

      const pt1 = ratchetDecrypt(receiver, ct1.ciphertext, ct1.iv, ct1.index);
      expect(pt1).toBe("msg-1");
    });

    it("handles large gap with skipped messages", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Send 50 messages
      const ciphertexts = [];
      for (let i = 0; i < 50; i++) {
        ciphertexts.push(ratchetEncrypt(sender, `msg-${i}`));
      }

      // Receive message 49 first (causes 49 keys to be cached)
      const pt49 = ratchetDecrypt(
        receiver,
        ciphertexts[49].ciphertext,
        ciphertexts[49].iv,
        ciphertexts[49].index
      );
      expect(pt49).toBe("msg-49");
      expect(receiver.skippedKeys.size).toBe(49);

      // Now receive all the earlier messages
      for (let i = 0; i < 49; i++) {
        const pt = ratchetDecrypt(
          receiver,
          ciphertexts[i].ciphertext,
          ciphertexts[i].iv,
          ciphertexts[i].index
        );
        expect(pt).toBe(`msg-${i}`);
      }
      expect(receiver.skippedKeys.size).toBe(0);
    });

    it("cannot reuse a skipped key (replay protection)", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      const ct0 = ratchetEncrypt(sender, "msg-0");
      const ct1 = ratchetEncrypt(sender, "msg-1");

      // Receive message 1 first (caches key 0)
      ratchetDecrypt(receiver, ct1.ciphertext, ct1.iv, ct1.index);

      // Receive message 0 (consumes cached key)
      ratchetDecrypt(receiver, ct0.ciphertext, ct0.iv, ct0.index);

      // Try to decrypt message 0 again — should fail
      expect(() => {
        ratchetDecrypt(receiver, ct0.ciphertext, ct0.iv, ct0.index);
      }).toThrow(/no cached key for index 0/);
    });
  });

  describe("max skip protection", () => {
    it("rejects skip exceeding maxSkip", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test", 10); // maxSkip = 10

      // Advance sender by 11 messages
      let ct: ReturnType<typeof ratchetEncrypt>;
      for (let i = 0; i <= 10; i++) {
        ct = ratchetEncrypt(sender, `msg-${i}`);
      }

      // Receiver tries to decrypt message 10 (gap of 10 from index 0 — at the limit)
      // The skip is 10 messages (0..9) which equals maxSkip, so this should work.
      // Wait, let's check: receiver is at 0, ct.index is 10, skip = 10 - 0 = 10.
      // maxSkip is 10, so 10 <= 10 should pass.
      // Let's instead test the boundary more precisely.

      // receiver at 0, skip to index 11 (gap of 11, exceeds maxSkip=10)
      const ct11 = ratchetEncrypt(sender, "msg-11");
      expect(() => {
        ratchetDecrypt(receiver, ct11.ciphertext, ct11.iv, ct11.index);
      }).toThrow(/exceeds maxSkip/);
    });

    it("allows skip at exactly maxSkip", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test", 5);

      // Advance sender by 5 messages (indices 0-4), then get index 5
      for (let i = 0; i < 5; i++) {
        ratchetEncrypt(sender, `skip-${i}`);
      }
      const ct5 = ratchetEncrypt(sender, "msg-5");

      // Receiver at index 0, receiving index 5. Skip = 5, maxSkip = 5. Should pass.
      const pt = ratchetDecrypt(receiver, ct5.ciphertext, ct5.iv, ct5.index);
      expect(pt).toBe("msg-5");
    });
  });

  describe("key update (post-compromise security)", () => {
    it("key update resets the chain with new entropy", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Send some messages
      const ct0 = ratchetEncrypt(sender, "before-update");
      ratchetDecrypt(receiver, ct0.ciphertext, ct0.iv, ct0.index);

      // Save the chain key before update
      const oldChainKey = new Uint8Array(sender.chainKey);

      // Perform key update on sender
      const update = ratchetKeyUpdate(sender);
      expect(isKeyUpdatePayload(update)).toBe(true);

      // Chain key must have changed
      expect(sender.chainKey).not.toEqual(oldChainKey);

      // Apply the same update on receiver
      const entropy = Uint8Array.from(atob(update.entropy), (c) =>
        c.charCodeAt(0)
      );
      applyKeyUpdate(receiver, entropy);

      // Both sides should now have the same chain key
      expect(sender.chainKey).toEqual(receiver.chainKey);

      // Messages after update can be decrypted
      const ct1 = ratchetEncrypt(sender, "after-update");
      const pt1 = ratchetDecrypt(receiver, ct1.ciphertext, ct1.iv, ct1.index);
      expect(pt1).toBe("after-update");
    });

    it("after key update, old ratchet state cannot decrypt new messages", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // "Steal" the receiver's chain key before update
      const eavesdropper: RatchetState = {
        chainKey: new Uint8Array(receiver.chainKey),
        messageIndex: receiver.messageIndex,
        skippedKeys: new Map(),
        maxSkip: 100,
      };

      // Perform key update
      const update = ratchetKeyUpdate(sender);
      const entropy = Uint8Array.from(atob(update.entropy), (c) =>
        c.charCodeAt(0)
      );
      applyKeyUpdate(receiver, entropy);

      // Send message after update
      const ct = ratchetEncrypt(sender, "post-compromise secret");
      const pt = ratchetDecrypt(receiver, ct.ciphertext, ct.iv, ct.index);
      expect(pt).toBe("post-compromise secret");

      // Eavesdropper (with pre-update chain key) cannot decrypt
      expect(() => {
        ratchetDecrypt(
          eavesdropper,
          ct.ciphertext,
          ct.iv,
          ct.index
        );
      }).toThrow();
    });

    it("key update clears skipped keys", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Create some skipped keys
      ratchetEncrypt(sender, "skip-0");
      ratchetEncrypt(sender, "skip-1");
      const ct2 = ratchetEncrypt(sender, "msg-2");

      // Receiver skips to index 2 (caches 0 and 1)
      ratchetDecrypt(receiver, ct2.ciphertext, ct2.iv, ct2.index);
      expect(receiver.skippedKeys.size).toBe(2);

      // Key update should clear all skipped keys
      const update = ratchetKeyUpdate(receiver);
      expect(receiver.skippedKeys.size).toBe(0);
    });
  });

  describe("zeroize", () => {
    it("zeros all key material", () => {
      const state = initRatchet(makeSecret(), "test");

      // Send some messages to create state
      ratchetEncrypt(state, "msg-0");
      ratchetEncrypt(state, "msg-1");

      // Verify chain key is non-zero
      expect(state.chainKey.some((b) => b !== 0)).toBe(true);
      expect(state.messageIndex).toBe(2);

      zeroize(state);

      // Verify everything is zeroed
      expect(state.chainKey.every((b) => b === 0)).toBe(true);
      expect(state.messageIndex).toBe(0);
      expect(state.skippedKeys.size).toBe(0);
    });

    it("zeros skipped keys", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Create skipped keys
      ratchetEncrypt(sender, "skip-0");
      const ct1 = ratchetEncrypt(sender, "msg-1");
      ratchetDecrypt(receiver, ct1.ciphertext, ct1.iv, ct1.index);
      expect(receiver.skippedKeys.size).toBe(1);

      zeroize(receiver);
      expect(receiver.skippedKeys.size).toBe(0);
    });
  });

  describe("sealed sender", () => {
    it("wraps and unwraps sender identity", () => {
      const sealed = sealSender("alice", "hello bob");
      const unsealed = unsealSender(sealed);

      expect(unsealed).not.toBeNull();
      expect(unsealed!.sender).toBe("alice");
      expect(unsealed!.content).toBe("hello bob");
    });

    it("returns null for non-sealed payloads", () => {
      expect(unsealSender("just a string")).toBeNull();
      expect(unsealSender('{"foo":"bar"}')).toBeNull();
      expect(unsealSender("")).toBeNull();
    });

    it("full flow: seal sender -> ratchet encrypt -> ratchet decrypt -> unseal sender", () => {
      const secret = makeSecret();
      const sender = initRatchet(secret, "test");
      const receiver = initRatchet(secret, "test");

      // Sender wraps their identity inside the payload
      const sealed = sealSender("alice", "secret message to bob");
      const ct = ratchetEncrypt(sender, sealed);

      // Receiver decrypts and extracts sender
      const decrypted = ratchetDecrypt(receiver, ct.ciphertext, ct.iv, ct.index);
      const unsealed = unsealSender(decrypted);

      expect(unsealed!.sender).toBe("alice");
      expect(unsealed!.content).toBe("secret message to bob");
    });
  });

  describe("payload type detection", () => {
    it("isRatchetPayload identifies ratchet payloads", () => {
      const sender = initRatchet(makeSecret(), "test");
      const ct = ratchetEncrypt(sender, "test");

      expect(isRatchetPayload(ct)).toBe(true);
      expect(isRatchetPayload({ ciphertext: "a", iv: "b", encrypted: true })).toBe(false);
      expect(isRatchetPayload(null)).toBe(false);
      expect(isRatchetPayload("string")).toBe(false);
    });

    it("isKeyUpdatePayload identifies key update payloads", () => {
      const sender = initRatchet(makeSecret(), "test");
      const update = ratchetKeyUpdate(sender);

      expect(isKeyUpdatePayload(update)).toBe(true);
      expect(isKeyUpdatePayload({ entropy: "x", index: 0 })).toBe(false);
      expect(isKeyUpdatePayload(null)).toBe(false);
    });
  });
});
