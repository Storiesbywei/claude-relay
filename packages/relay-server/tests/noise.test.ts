/**
 * Noise Transport Encryption Tests
 *
 * Tests the full Noise-IK-inspired handshake and encrypted transport:
 *   1. Unit tests for crypto primitives (no server required)
 *   2. Integration tests against a running relay server
 *
 * Unit tests run with `bun test packages/relay-server/tests/noise.test.ts`
 * Integration tests require: RELAY_PORT=4190 bun run dev:server
 */

import { describe, it, expect } from "bun:test";

// ─── Unit Tests: Crypto Primitives ──────────────────────────────────────────

import {
  generateNoiseKeypair,
  computeSharedSecret,
  deriveTransportKeys,
  toBase64,
  fromBase64,
} from "../src/noise/keypair.js";

import {
  encryptTransport,
  decryptTransport,
  counterToNonce,
  packEncryptedPayload,
  unpackEncryptedPayload,
} from "../src/noise/transport.js";

describe("Noise Keypair", () => {
  it("generates a valid X25519 keypair", () => {
    const kp = generateNoiseKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it("generates unique keypairs", () => {
    const kp1 = generateNoiseKeypair();
    const kp2 = generateNoiseKeypair();
    expect(Buffer.from(kp1.privateKey).equals(Buffer.from(kp2.privateKey))).toBe(false);
    expect(Buffer.from(kp1.publicKey).equals(Buffer.from(kp2.publicKey))).toBe(false);
  });
});

describe("X25519 ECDH", () => {
  it("produces matching shared secrets from both sides", () => {
    const alice = generateNoiseKeypair();
    const bob = generateNoiseKeypair();

    const sharedAlice = computeSharedSecret(alice.privateKey, bob.publicKey);
    const sharedBob = computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(sharedAlice.length).toBe(32);
    expect(Buffer.from(sharedAlice).equals(Buffer.from(sharedBob))).toBe(true);
  });

  it("produces different shared secrets for different key pairs", () => {
    const alice = generateNoiseKeypair();
    const bob = generateNoiseKeypair();
    const charlie = generateNoiseKeypair();

    const sharedAB = computeSharedSecret(alice.privateKey, bob.publicKey);
    const sharedAC = computeSharedSecret(alice.privateKey, charlie.publicKey);

    expect(Buffer.from(sharedAB).equals(Buffer.from(sharedAC))).toBe(false);
  });
});

describe("Transport Key Derivation", () => {
  it("derives 32-byte keys for both directions", () => {
    const client = generateNoiseKeypair();
    const server = generateNoiseKeypair();
    const shared = computeSharedSecret(client.privateKey, server.publicKey);

    const keys = deriveTransportKeys(shared, client.publicKey, server.publicKey);

    expect(keys.clientToServer.length).toBe(32);
    expect(keys.serverToClient.length).toBe(32);
  });

  it("derives different keys for each direction", () => {
    const client = generateNoiseKeypair();
    const server = generateNoiseKeypair();
    const shared = computeSharedSecret(client.privateKey, server.publicKey);

    const keys = deriveTransportKeys(shared, client.publicKey, server.publicKey);

    expect(Buffer.from(keys.clientToServer).equals(Buffer.from(keys.serverToClient))).toBe(false);
  });

  it("client and server derive identical keys", () => {
    const client = generateNoiseKeypair();
    const server = generateNoiseKeypair();

    // Client side
    const clientShared = computeSharedSecret(client.privateKey, server.publicKey);
    const clientKeys = deriveTransportKeys(clientShared, client.publicKey, server.publicKey);

    // Server side
    const serverShared = computeSharedSecret(server.privateKey, client.publicKey);
    const serverKeys = deriveTransportKeys(serverShared, client.publicKey, server.publicKey);

    expect(Buffer.from(clientKeys.clientToServer).equals(Buffer.from(serverKeys.clientToServer))).toBe(true);
    expect(Buffer.from(clientKeys.serverToClient).equals(Buffer.from(serverKeys.serverToClient))).toBe(true);
  });

  it("key order matters — swapping initiator/responder produces different keys", () => {
    const client = generateNoiseKeypair();
    const server = generateNoiseKeypair();
    const shared = computeSharedSecret(client.privateKey, server.publicKey);

    const keysCorrect = deriveTransportKeys(shared, client.publicKey, server.publicKey);
    const keysSwapped = deriveTransportKeys(shared, server.publicKey, client.publicKey);

    expect(Buffer.from(keysCorrect.clientToServer).equals(Buffer.from(keysSwapped.clientToServer))).toBe(false);
  });
});

describe("ChaCha20-Poly1305 Transport", () => {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  it("encrypts and decrypts a message", () => {
    const nonce = counterToNonce(0n);
    const plaintext = new TextEncoder().encode("hello, noise transport");

    const ciphertext = encryptTransport(plaintext, key, nonce);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // auth tag adds 16 bytes

    const decrypted = decryptTransport(ciphertext, key, nonce);
    expect(new TextDecoder().decode(decrypted)).toBe("hello, noise transport");
  });

  it("fails decryption with wrong key", () => {
    const nonce = counterToNonce(0n);
    const plaintext = new TextEncoder().encode("secret message");
    const ciphertext = encryptTransport(plaintext, key, nonce);

    const wrongKey = new Uint8Array(32);
    crypto.getRandomValues(wrongKey);

    expect(() => decryptTransport(ciphertext, wrongKey, nonce)).toThrow();
  });

  it("fails decryption with wrong nonce", () => {
    const nonce = counterToNonce(0n);
    const plaintext = new TextEncoder().encode("secret message");
    const ciphertext = encryptTransport(plaintext, key, nonce);

    const wrongNonce = counterToNonce(1n);
    expect(() => decryptTransport(ciphertext, wrongNonce, key)).toThrow();
  });

  it("fails decryption with tampered ciphertext", () => {
    const nonce = counterToNonce(0n);
    const plaintext = new TextEncoder().encode("integrity check");
    const ciphertext = encryptTransport(plaintext, key, nonce);

    // Flip a byte
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    expect(() => decryptTransport(tampered, key, nonce)).toThrow();
  });
});

describe("Nonce Counter", () => {
  it("produces 12-byte nonces", () => {
    const nonce = counterToNonce(0n);
    expect(nonce.length).toBe(12);
  });

  it("produces different nonces for different counters", () => {
    const n0 = counterToNonce(0n);
    const n1 = counterToNonce(1n);
    const n100 = counterToNonce(100n);

    expect(Buffer.from(n0).equals(Buffer.from(n1))).toBe(false);
    expect(Buffer.from(n1).equals(Buffer.from(n100))).toBe(false);
  });

  it("handles large counter values", () => {
    const large = counterToNonce(0xFFFFFFFFFFFFFFFFn);
    expect(large.length).toBe(12);
    // First 4 bytes should be zero
    expect(large[0]).toBe(0);
    expect(large[1]).toBe(0);
    expect(large[2]).toBe(0);
    expect(large[3]).toBe(0);
  });
});

describe("Payload Pack/Unpack", () => {
  it("round-trips nonce + ciphertext through base64", () => {
    const nonce = counterToNonce(42n);
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const packed = packEncryptedPayload(nonce, ciphertext);
    expect(typeof packed).toBe("string"); // base64

    const { nonce: unpacked_nonce, ciphertext: unpacked_ct } = unpackEncryptedPayload(packed);
    expect(Buffer.from(unpacked_nonce).equals(Buffer.from(nonce))).toBe(true);
    expect(Buffer.from(unpacked_ct).equals(Buffer.from(ciphertext))).toBe(true);
  });
});

describe("Base64 Encoding", () => {
  it("round-trips key material", () => {
    const original = new Uint8Array(32);
    crypto.getRandomValues(original);

    const encoded = toBase64(original);
    const decoded = fromBase64(encoded);

    expect(Buffer.from(decoded).equals(Buffer.from(original))).toBe(true);
  });
});

describe("Full Handshake Simulation (no server)", () => {
  it("simulates a complete handshake and encrypted exchange", () => {
    // Server generates a static keypair
    const server = generateNoiseKeypair();

    // Client generates an ephemeral keypair
    const clientEphemeral = generateNoiseKeypair();

    // Both sides compute the shared secret
    const clientShared = computeSharedSecret(clientEphemeral.privateKey, server.publicKey);
    const serverShared = computeSharedSecret(server.privateKey, clientEphemeral.publicKey);

    // Both derive transport keys
    const clientKeys = deriveTransportKeys(clientShared, clientEphemeral.publicKey, server.publicKey);
    const serverKeys = deriveTransportKeys(serverShared, clientEphemeral.publicKey, server.publicKey);

    // Client encrypts a request
    const requestPlain = JSON.stringify({ type: "question", content: "hello from client" });
    const clientNonce = counterToNonce(0n);
    const requestCiphertext = encryptTransport(
      new TextEncoder().encode(requestPlain),
      clientKeys.clientToServer,
      clientNonce,
    );

    // Server decrypts the request
    const requestDecrypted = decryptTransport(
      requestCiphertext,
      serverKeys.clientToServer,
      clientNonce,
    );
    expect(new TextDecoder().decode(requestDecrypted)).toBe(requestPlain);

    // Server encrypts a response
    const responsePlain = JSON.stringify({ status: "ok", message_id: "abc123" });
    const serverNonce = counterToNonce(0n);
    const responseCiphertext = encryptTransport(
      new TextEncoder().encode(responsePlain),
      serverKeys.serverToClient,
      serverNonce,
    );

    // Client decrypts the response
    const responseDecrypted = decryptTransport(
      responseCiphertext,
      clientKeys.serverToClient,
      serverNonce,
    );
    expect(new TextDecoder().decode(responseDecrypted)).toBe(responsePlain);
  });

  it("simulates multiple messages with incrementing nonces", () => {
    const server = generateNoiseKeypair();
    const client = generateNoiseKeypair();

    const shared = computeSharedSecret(client.privateKey, server.publicKey);
    const keys = deriveTransportKeys(shared, client.publicKey, server.publicKey);

    // Send 10 messages with incrementing nonces
    for (let i = 0; i < 10; i++) {
      const nonce = counterToNonce(BigInt(i));
      const msg = `message ${i}`;
      const ct = encryptTransport(new TextEncoder().encode(msg), keys.clientToServer, nonce);
      const pt = decryptTransport(ct, keys.clientToServer, nonce);
      expect(new TextDecoder().decode(pt)).toBe(msg);
    }
  });
});

// ─── Integration Tests (require running server) ────────────────────────────

const BASE = process.env.RELAY_URL || "http://localhost:4190";

describe("Noise API Integration", () => {
  it("GET /noise/pubkey returns a valid public key", async () => {
    const res = await fetch(`${BASE}/noise/pubkey`);
    if (!res.ok) {
      console.warn("Skipping integration test — server not running");
      return;
    }
    const data = await res.json();
    expect(data.public_key).toBeDefined();
    expect(typeof data.public_key).toBe("string");
    expect(data.algorithm).toBe("X25519");
    expect(data.transport_cipher).toBe("ChaCha20-Poly1305");
    expect(data.kdf).toBe("HKDF-SHA256");

    // Decode and verify key length
    const pubkey = fromBase64(data.public_key);
    expect(pubkey.length).toBe(32);
  });

  it("POST /noise/handshake completes successfully", async () => {
    // Check if server is running with noise routes
    const pubkeyRes = await fetch(`${BASE}/noise/pubkey`).catch(() => null);
    if (!pubkeyRes?.ok) {
      console.warn("Skipping integration test — server not running");
      return;
    }

    const { public_key: serverPubB64 } = await pubkeyRes.json();
    const serverPub = fromBase64(serverPubB64);

    // Generate ephemeral keypair
    const clientKp = generateNoiseKeypair();

    // Handshake
    const res = await fetch(`${BASE}/noise/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_public_key: toBase64(clientKp.publicKey) }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.transport_token).toBeDefined();
    expect(typeof data.transport_token).toBe("string");
    expect(data.server_public_key).toBe(serverPubB64);
    expect(data.expires_in_seconds).toBeGreaterThan(0);
  });

  it("POST /noise/handshake rejects invalid public key", async () => {
    const pubkeyRes = await fetch(`${BASE}/noise/pubkey`).catch(() => null);
    if (!pubkeyRes?.ok) {
      console.warn("Skipping integration test — server not running");
      return;
    }

    const res = await fetch(`${BASE}/noise/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_public_key: "not-valid-base64!!!" }),
    });

    expect(res.status).toBe(400);
  });

  it("POST /noise/handshake rejects wrong-length key", async () => {
    const pubkeyRes = await fetch(`${BASE}/noise/pubkey`).catch(() => null);
    if (!pubkeyRes?.ok) {
      console.warn("Skipping integration test — server not running");
      return;
    }

    // 16-byte key instead of 32
    const shortKey = new Uint8Array(16);
    crypto.getRandomValues(shortKey);

    const res = await fetch(`${BASE}/noise/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_public_key: toBase64(shortKey) }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid key length");
  });

  it("GET /noise/status returns session stats", async () => {
    const res = await fetch(`${BASE}/noise/status`);
    if (!res.ok) {
      console.warn("Skipping integration test — server not running");
      return;
    }
    const data = await res.json();
    expect(data.transport_sessions).toBeDefined();
    expect(typeof data.transport_sessions.active).toBe("number");
  });
});
