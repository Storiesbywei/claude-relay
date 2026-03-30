/**
 * Noise Transport Handshake Routes
 *
 * Implements the Noise-IK-inspired handshake for transport encryption:
 *
 *   1. GET  /noise/pubkey    → Server's static X25519 public key (base64)
 *   2. POST /noise/handshake → Client sends ephemeral pubkey, gets transport token
 *
 * After handshake, the client includes `X-Noise-Token` on subsequent requests
 * and the noise middleware handles encrypt/decrypt transparently.
 *
 * The server keypair is generated once and persisted in SQLite so clients can
 * pin the public key across server restarts.
 */

import { Hono } from "hono";
import {
  generateNoiseKeypair,
  computeSharedSecret,
  deriveTransportKeys,
  toBase64,
  fromBase64,
} from "../noise/keypair.js";
import {
  getNoiseServerKeypair,
  setNoiseServerKeypair,
} from "../store/sqlite.js";
import {
  createTransportSession,
  getTransportSessionStats,
} from "../noise/session-store.js";

// ─── Server Keypair (lazy-init on first import) ─────────────────────────────

let serverPrivateKey: Uint8Array;
let serverPublicKey: Uint8Array;
let serverPublicKeyB64: string;

function initServerKeypair(): void {
  // Try loading from SQLite first
  const stored = getNoiseServerKeypair();
  if (stored) {
    serverPrivateKey = fromBase64(stored.privateKey);
    serverPublicKey = fromBase64(stored.publicKey);
    serverPublicKeyB64 = stored.publicKey;
    console.log(
      `[noise] Loaded persisted server keypair (pubkey: ${serverPublicKeyB64.slice(0, 12)}...)`,
    );
    return;
  }

  // Generate fresh keypair and persist
  const kp = generateNoiseKeypair();
  serverPrivateKey = kp.privateKey;
  serverPublicKey = kp.publicKey;
  serverPublicKeyB64 = toBase64(kp.publicKey);

  const privB64 = toBase64(kp.privateKey);
  setNoiseServerKeypair(privB64, serverPublicKeyB64);
  console.log(
    `[noise] Generated new server keypair (pubkey: ${serverPublicKeyB64.slice(0, 12)}...)`,
  );
}

// Initialize eagerly so the keypair is available for routes
initServerKeypair();

/** Export for use in health endpoint stats */
export function getNoiseServerPublicKey(): string {
  return serverPublicKeyB64;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const noiseRoutes = new Hono();

/**
 * GET /noise/pubkey
 *
 * Returns the server's static X25519 public key in base64.
 * Clients pin this key and use it for the handshake.
 *
 * This is a public endpoint — no auth required. The public key is, well, public.
 */
noiseRoutes.get("/pubkey", (c) => {
  return c.json({
    public_key: serverPublicKeyB64,
    algorithm: "X25519",
    transport_cipher: "ChaCha20-Poly1305",
    kdf: "HKDF-SHA256",
    protocol: "claude-relay-noise-v1",
  });
});

/**
 * POST /noise/handshake
 *
 * Client sends its ephemeral X25519 public key. Server computes ECDH shared
 * secret, derives transport keys, creates a transport session, and returns
 * a transport_token the client uses for subsequent encrypted requests.
 *
 * Request body:
 *   { "client_public_key": "<base64 X25519 ephemeral pubkey>" }
 *
 * Response:
 *   {
 *     "transport_token": "<uuid>",
 *     "server_public_key": "<base64>",
 *     "expires_in_seconds": 1800
 *   }
 *
 * The client must independently derive the same transport keys using:
 *   - Its own ephemeral private key
 *   - The server's public key (already known/pinned)
 *   - The same HKDF parameters
 */
noiseRoutes.post("/handshake", async (c) => {
  let body: { client_public_key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { client_public_key } = body;
  if (!client_public_key || typeof client_public_key !== "string") {
    return c.json({ error: "Missing client_public_key (base64-encoded X25519 public key)" }, 400);
  }

  // Decode and validate the client's ephemeral public key
  let clientPubKey: Uint8Array;
  try {
    clientPubKey = fromBase64(client_public_key);
  } catch {
    return c.json({ error: "Invalid base64 encoding for client_public_key" }, 400);
  }

  if (clientPubKey.length !== 32) {
    return c.json(
      { error: `Invalid key length: expected 32 bytes, got ${clientPubKey.length}` },
      400,
    );
  }

  // Compute X25519 shared secret: ECDH(server_private, client_public)
  let sharedSecret: Uint8Array;
  try {
    sharedSecret = computeSharedSecret(serverPrivateKey, clientPubKey);
  } catch (err) {
    return c.json({ error: "ECDH computation failed — invalid public key" }, 400);
  }

  // Derive directional transport keys via HKDF
  const keys = deriveTransportKeys(sharedSecret, clientPubKey, serverPublicKey);

  // Generate a transport session token
  const transportToken = crypto.randomUUID();

  // Store the transport session (30-minute TTL)
  const ttlMs = 30 * 60 * 1000;
  createTransportSession(transportToken, keys, clientPubKey, ttlMs);

  console.log(
    `[noise] Handshake complete — transport session ${transportToken.slice(0, 8)}... established`,
  );

  return c.json({
    transport_token: transportToken,
    server_public_key: serverPublicKeyB64,
    expires_in_seconds: Math.floor(ttlMs / 1000),
  });
});

/**
 * GET /noise/status
 *
 * Returns stats about active transport sessions.
 * Useful for monitoring/debugging.
 */
noiseRoutes.get("/status", (c) => {
  const stats = getTransportSessionStats();
  return c.json({
    server_public_key: serverPublicKeyB64.slice(0, 12) + "...",
    transport_sessions: stats,
  });
});
