/**
 * Noise Transport Middleware
 *
 * When a request includes the `X-Noise-Token` header, this middleware:
 *   1. Looks up the transport session by token
 *   2. Decrypts the request body using the client→server key
 *   3. Passes the decrypted body to downstream handlers
 *   4. Encrypts the response body using the server→client key
 *
 * Requests WITHOUT `X-Noise-Token` pass through unmodified — this makes
 * noise transport opt-in and backward-compatible with existing plaintext API.
 *
 * Wire format:
 *   Request body:  base64(nonce || ChaCha20-Poly1305(plaintext_json))
 *   Response body: base64(nonce || ChaCha20-Poly1305(response_json))
 *
 * Headers:
 *   X-Noise-Token:  transport session token (from handshake)
 *   X-Noise-Nonce:  client's nonce counter (decimal string) — for replay detection
 *   Content-Type:   application/x-noise+json (encrypted) vs application/json (plain)
 */

import type { Context, Next } from "hono";
import {
  getTransportSession,
  advanceClientNonce,
  advanceServerNonce,
} from "../noise/session-store.js";
import {
  decryptTransport,
  encryptTransport,
  counterToNonce,
  unpackEncryptedPayload,
  packEncryptedPayload,
} from "../noise/transport.js";

/** Content type marker for noise-encrypted JSON payloads */
export const NOISE_CONTENT_TYPE = "application/x-noise+json";

/**
 * Noise transport decryption/encryption middleware.
 *
 * Behavior:
 *   - No X-Noise-Token header → skip (plaintext passthrough)
 *   - Invalid/expired token → 401
 *   - Nonce mismatch → 400 (potential replay)
 *   - Decrypt failure → 400 (tampered or wrong key)
 *   - Success → decrypt body, run handler, encrypt response
 */
export async function noiseMiddleware(c: Context, next: Next) {
  const noiseToken = c.req.header("X-Noise-Token");

  // No noise token → plaintext passthrough (backward compatible)
  if (!noiseToken) {
    await next();
    return;
  }

  // Look up transport session
  const session = getTransportSession(noiseToken);
  if (!session) {
    return c.json({ error: "Invalid or expired noise transport token" }, 401);
  }

  // ─── Decrypt Request Body ──────────────────────────────────────────────

  const method = c.req.method;
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH";

  if (hasBody) {
    const contentType = c.req.header("Content-Type") || "";
    if (!contentType.includes(NOISE_CONTENT_TYPE)) {
      // If the client sent a noise token but didn't encrypt the body, reject.
      // This prevents accidentally sending plaintext with a noise token.
      return c.json(
        { error: `Expected Content-Type: ${NOISE_CONTENT_TYPE} for noise-encrypted requests` },
        400,
      );
    }

    // Read the base64-encoded encrypted body
    const encryptedBody = await c.req.text();
    if (!encryptedBody) {
      return c.json({ error: "Empty encrypted body" }, 400);
    }

    // Validate nonce counter (anti-replay)
    const clientNonceHeader = c.req.header("X-Noise-Nonce");
    if (!clientNonceHeader) {
      return c.json({ error: "Missing X-Noise-Nonce header" }, 400);
    }

    let declaredNonce: bigint;
    try {
      declaredNonce = BigInt(clientNonceHeader);
    } catch {
      return c.json({ error: "Invalid X-Noise-Nonce — must be a decimal integer" }, 400);
    }

    // Advance the expected nonce counter
    const expectedNonce = advanceClientNonce(noiseToken);
    if (expectedNonce === undefined) {
      return c.json({ error: "Transport session not found" }, 401);
    }

    if (declaredNonce !== expectedNonce) {
      return c.json(
        {
          error: "Nonce mismatch — possible replay attack",
          expected: expectedNonce.toString(),
          received: declaredNonce.toString(),
        },
        400,
      );
    }

    // Decrypt
    let decryptedBody: string;
    try {
      const { nonce, ciphertext } = unpackEncryptedPayload(encryptedBody);
      const expectedNonceBytes = counterToNonce(expectedNonce);

      // Verify the nonce in the payload matches the expected counter
      if (!noncesEqual(nonce, expectedNonceBytes)) {
        return c.json({ error: "Nonce in payload does not match counter" }, 400);
      }

      const plaintext = decryptTransport(ciphertext, session.keys.clientToServer, nonce);
      decryptedBody = new TextDecoder().decode(plaintext);
    } catch (err) {
      return c.json(
        { error: "Decryption failed — tampered payload or wrong key" },
        400,
      );
    }

    // Replace the request with a new one containing the decrypted body
    // We store the decrypted body in the context for downstream handlers
    c.set("noise_decrypted_body", decryptedBody);
    c.set("noise_session", noiseToken);
  } else {
    // GET/DELETE — no body to decrypt, just mark as noise session
    c.set("noise_session", noiseToken);
  }

  // ─── Run Downstream Handler ────────────────────────────────────────────

  await next();

  // ─── Encrypt Response ──────────────────────────────────────────────────

  // Only encrypt if the response is JSON and the noise session is still valid
  const res = c.res;
  const resContentType = res.headers.get("Content-Type") || "";

  if (resContentType.includes("application/json") && res.body) {
    const serverNonce = advanceServerNonce(noiseToken);
    if (serverNonce === undefined) {
      // Session expired during request handling — return plaintext
      return;
    }

    // Read the response body
    const responseText = await res.text();
    const responsePlaintext = new TextEncoder().encode(responseText);

    // Encrypt
    const nonce = counterToNonce(serverNonce);
    const ciphertext = encryptTransport(responsePlaintext, session.keys.serverToClient, nonce);
    const packed = packEncryptedPayload(nonce, ciphertext);

    // Replace the response with the encrypted version
    c.res = new Response(packed, {
      status: res.status,
      headers: {
        "Content-Type": NOISE_CONTENT_TYPE,
        "X-Noise-Nonce": serverNonce.toString(),
      },
    });
  }
}

// ─── Helper: override request body parsing for noise-decrypted requests ─────

/**
 * Hono middleware that intercepts `c.req.json()` calls when a noise-decrypted
 * body is present. Place this AFTER noiseMiddleware in the middleware chain.
 *
 * This allows downstream route handlers to call `c.req.json()` as normal
 * and transparently get the decrypted body.
 */
export async function noiseBodyMiddleware(c: Context, next: Next) {
  const decryptedBody = c.get("noise_decrypted_body") as string | undefined;
  if (decryptedBody) {
    // Create a new Request with the decrypted body so c.req.json() works
    const originalReq = c.req.raw;
    const newReq = new Request(originalReq.url, {
      method: originalReq.method,
      headers: new Headers({
        ...Object.fromEntries(originalReq.headers.entries()),
        "Content-Type": "application/json",
      }),
      body: decryptedBody,
    });
    // Replace the raw request — Hono will use this for json() parsing
    (c.req as any).raw = newReq;
  }
  await next();
}

// ─── Utility ────────────────────────────────────────────────────────────────

function noncesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
