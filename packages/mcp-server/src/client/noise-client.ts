/**
 * Noise Transport Client
 *
 * Client-side implementation of the Noise-IK-inspired transport encryption.
 * Performs the handshake with the relay server and provides encrypt/decrypt
 * wrappers for subsequent API calls.
 *
 * Usage:
 *   const noise = new NoiseTransportClient(relayUrl);
 *   await noise.handshake();
 *   const response = await noise.encryptedFetch("/relay/session-id", {
 *     method: "POST",
 *     body: JSON.stringify(payload),
 *   });
 *
 * The client lifecycle:
 *   1. Fetch the server's public key via GET /noise/pubkey
 *   2. Generate an ephemeral X25519 keypair
 *   3. POST /noise/handshake with the ephemeral public key
 *   4. Derive transport keys locally (same HKDF as server)
 *   5. Use transport keys for all subsequent requests
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TransportKeys {
  clientToServer: Uint8Array;
  serverToClient: Uint8Array;
}

interface NoiseSession {
  transportToken: string;
  keys: TransportKeys;
  clientNonce: bigint;
  serverNonce: bigint;
  expiresAt: Date;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class NoiseTransportClient {
  private relayUrl: string;
  private session: NoiseSession | null = null;
  private serverPublicKey: Uint8Array | null = null;

  constructor(relayUrl: string) {
    // Strip trailing slash
    this.relayUrl = relayUrl.replace(/\/$/, "");
  }

  /** Whether a noise session is active and not expired */
  get isActive(): boolean {
    return this.session !== null && this.session.expiresAt > new Date();
  }

  /** The transport token (for logging/debugging) */
  get transportToken(): string | null {
    return this.session?.transportToken ?? null;
  }

  /**
   * Fetch the server's static X25519 public key.
   * Called automatically by handshake() if not already fetched.
   */
  async fetchServerPublicKey(): Promise<Uint8Array> {
    const res = await fetch(`${this.relayUrl}/noise/pubkey`);
    if (!res.ok) {
      throw new Error(`Failed to fetch server public key: HTTP ${res.status}`);
    }
    const data = await res.json();
    const b64 = data.public_key as string;
    this.serverPublicKey = fromBase64(b64);
    return this.serverPublicKey;
  }

  /**
   * Perform the Noise-IK-inspired handshake.
   *
   * 1. Fetch server pubkey (if not cached)
   * 2. Generate ephemeral X25519 keypair
   * 3. Send ephemeral pubkey to server
   * 4. Derive transport keys locally
   * 5. Store session
   */
  async handshake(): Promise<void> {
    // Step 1: Get server public key
    if (!this.serverPublicKey) {
      await this.fetchServerPublicKey();
    }

    // Step 2: Generate ephemeral keypair
    const ephemeralPrivate = x25519.utils.randomSecretKey();
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

    // Step 3: Send ephemeral public key to server
    const res = await fetch(`${this.relayUrl}/noise/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_public_key: toBase64(ephemeralPublic) }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Noise handshake failed: HTTP ${res.status} — ${(body as any).error || "unknown"}`,
      );
    }

    const handshakeRes = await res.json();
    const transportToken = handshakeRes.transport_token as string;
    const expiresIn = (handshakeRes.expires_in_seconds as number) || 1800;

    // Step 4: Derive transport keys locally
    const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, this.serverPublicKey!);
    const keys = deriveTransportKeysClient(
      sharedSecret,
      ephemeralPublic,
      this.serverPublicKey!,
    );

    // Step 5: Store session
    this.session = {
      transportToken,
      keys,
      clientNonce: 0n,
      serverNonce: 0n,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * Send an encrypted request through the noise transport.
   *
   * @param path    - URL path (e.g., "/relay/session-id")
   * @param options - Standard fetch options (method, headers, body)
   * @returns Parsed JSON response (decrypted)
   */
  async encryptedFetch<T = any>(
    path: string,
    options: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<T> {
    if (!this.session || !this.isActive) {
      throw new Error("No active noise session — call handshake() first");
    }

    const session = this.session;
    const url = `${this.relayUrl}${path}`;
    const method = options.method || "GET";
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";

    // Build headers
    const headers: Record<string, string> = {
      ...options.headers,
      "X-Noise-Token": session.transportToken,
    };

    let body: string | undefined;

    if (hasBody && options.body) {
      // Encrypt the body
      const plaintext = typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

      const nonce = counterToNonce(session.clientNonce);
      const key = session.keys.clientToServer;
      const ciphertext = chacha20poly1305(key, nonce).encrypt(
        new TextEncoder().encode(plaintext),
      );

      body = packPayload(nonce, ciphertext);
      headers["Content-Type"] = "application/x-noise+json";
      headers["X-Noise-Nonce"] = session.clientNonce.toString();
      session.clientNonce += 1n;
    }

    // Send
    const res = await fetch(url, {
      method,
      headers,
      body,
    });

    // Check if response is encrypted
    const resContentType = res.headers.get("Content-Type") || "";
    if (resContentType.includes("application/x-noise+json")) {
      // Decrypt response
      const encryptedResponse = await res.text();
      const { nonce: resNonce, ciphertext: resCiphertext } = unpackPayload(encryptedResponse);

      const expectedNonce = counterToNonce(session.serverNonce);
      session.serverNonce += 1n;

      const plaintext = chacha20poly1305(session.keys.serverToClient, resNonce).decrypt(
        resCiphertext,
      );
      const text = new TextDecoder().decode(plaintext);

      // Re-create a response-like object with the status
      if (!res.ok) {
        const parsed = JSON.parse(text);
        throw new Error(parsed.error || `HTTP ${res.status}`);
      }

      return JSON.parse(text) as T;
    }

    // Plaintext response (e.g., error before middleware ran)
    const responseBody = await res.json();
    if (!res.ok) {
      throw new Error((responseBody as any).error || `HTTP ${res.status}`);
    }
    return responseBody as T;
  }

  /**
   * Tear down the noise session.
   */
  destroy(): void {
    this.session = null;
  }
}

// ─── Crypto Helpers (client-side) ───────────────────────────────────────────

/**
 * Derive transport keys — must produce identical output to server-side
 * deriveTransportKeys() in keypair.ts.
 */
function deriveTransportKeysClient(
  sharedSecret: Uint8Array,
  initiatorPublic: Uint8Array,
  responderPublic: Uint8Array,
): TransportKeys {
  const salt = new Uint8Array(initiatorPublic.length + responderPublic.length);
  salt.set(initiatorPublic, 0);
  salt.set(responderPublic, initiatorPublic.length);
  const info = new TextEncoder().encode("claude-relay-noise-v1");
  const prk = hkdf(sha256, sharedSecret, salt, info, 64);
  return {
    clientToServer: prk.slice(0, 32),
    serverToClient: prk.slice(32, 64),
  };
}

function counterToNonce(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Number(counter & 0xFFFFFFFFn), true);
  view.setUint32(8, Number((counter >> 32n) & 0xFFFFFFFFn), true);
  return nonce;
}

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

function packPayload(nonce: Uint8Array, ciphertext: Uint8Array): string {
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);
  let binary = "";
  for (let i = 0; i < packed.length; i++) {
    binary += String.fromCharCode(packed[i]);
  }
  return btoa(binary);
}

function unpackPayload(b64: string): { nonce: Uint8Array; ciphertext: Uint8Array } {
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
