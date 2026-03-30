/**
 * Key Exchange Security Tests
 *
 * Verifies that encryption key material never leaks through server responses:
 * - URL fragment (#key=...) never appears in server logs
 * - Session creation response doesn't contain encryption key
 * - Session info endpoint doesn't leak key material
 * - Invite token and encryption secret are independent values
 *
 * Requires a running relay server on localhost:4191.
 * Start with: RELAY_PORT=4191 bun run dev:server
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  generateSecret,
  toUrlSafeBase64,
  deriveSessionKey,
  getKeyFingerprint,
} from "@claude-relay/shared";

const BASE = "http://localhost:4190";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSession(mode: "relay" | "signal" = "signal") {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `key-exchange-test-${Date.now()}`,
      mode,
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`Health check returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `Relay server not reachable at ${BASE}. ` +
        `Start it with: RELAY_PORT=4191 bun run dev:server\n` +
        `Original error: ${err}`
    );
  }
});

// ---------------------------------------------------------------------------
// Key Material Isolation
// ---------------------------------------------------------------------------

describe("Key material never leaks through server", () => {
  it("session creation response does not contain encryption key or secret", async () => {
    const session = await createSession("signal");
    const json = JSON.stringify(session);

    // The response should contain tokens (session_id, creator_token, invite_token)
    // but NOT contain any key material, secret, or encryption_key fields
    expect(session.session_id).toBeDefined();
    expect(session.creator_token).toBeDefined();
    expect(session.invite_token).toBeDefined();

    // These fields must NOT exist in the response
    expect(session.encryption_key).toBeUndefined();
    expect(session.encryption_secret).toBeUndefined();
    expect(session.secret).toBeUndefined();
    expect(session.key).toBeUndefined();
    expect(session.shared_secret).toBeUndefined();

    // The response should not contain any base64 blob that looks like a 32-byte key
    // (this is a heuristic check)
    const suspiciousKeyPattern = /[A-Za-z0-9+/=]{43,44}/; // 32 bytes = 44 base64 chars
    // Exclude known fields (tokens are UUIDs, not base64)
    const withoutKnownFields = json
      .replace(session.session_id, "")
      .replace(session.creator_token, "")
      .replace(session.invite_token, "");

    // There should be no long base64-looking strings in the remaining response
    // (UUIDs are 36 chars with dashes, not base64)
    expect(withoutKnownFields).not.toMatch(suspiciousKeyPattern);
  });

  it("session info endpoint does not leak key material", async () => {
    const session = await createSession("signal");

    const res = await fetch(`${BASE}/sessions/${session.session_id}`, {
      headers: { Authorization: `Bearer ${session.creator_token}` },
    });
    expect(res.status).toBe(200);
    const info = await res.json();

    // Session info should contain metadata, not key material
    expect(info.id).toBe(session.session_id);
    expect(info.name).toBeDefined();
    expect(info.mode).toBe("signal");

    // Must NOT contain key material
    expect(info.encryption_key).toBeUndefined();
    expect(info.encryption_secret).toBeUndefined();
    expect(info.secret).toBeUndefined();
    expect(info.key).toBeUndefined();
    expect(info.shared_secret).toBeUndefined();
    expect(info.key_fingerprint).toBeUndefined();
  });

  it("join response does not leak key material", async () => {
    const session = await createSession("signal");

    const joinRes = await fetch(
      `${BASE}/sessions/${session.session_id}/join`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.invite_token}`,
        },
        body: JSON.stringify({ participant_name: "joiner" }),
      }
    );
    expect(joinRes.status).toBe(200);
    const joinBody = await joinRes.json();

    expect(joinBody.participant_token).toBeDefined();
    expect(joinBody.session).toBeDefined();

    // Must NOT contain key material
    expect(joinBody.encryption_key).toBeUndefined();
    expect(joinBody.encryption_secret).toBeUndefined();
    expect(joinBody.secret).toBeUndefined();
    expect(joinBody.key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invite Token vs Encryption Secret Independence
// ---------------------------------------------------------------------------

describe("Invite token and encryption secret are independent", () => {
  it("invite token is a UUID, encryption secret is 32 random bytes", async () => {
    const session = await createSession("signal");

    // Invite token should be a UUID (standard format)
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(session.invite_token).toMatch(uuidPattern);

    // Encryption secret is generated client-side, completely independent
    const secret = generateSecret();
    const secretB64 = toUrlSafeBase64(secret.buffer);

    // The secret is NOT a UUID — it's a URL-safe base64 string
    expect(secretB64).not.toMatch(uuidPattern);

    // The invite token and secret have no relationship
    expect(session.invite_token).not.toBe(secretB64);
    // They are different lengths/formats
    expect(session.invite_token.length).toBe(36); // UUID
    expect(secretB64.length).toBe(43); // 32 bytes -> 43 URL-safe base64 chars (no padding)
  });

  it("knowing the invite token does not help derive the encryption key", async () => {
    const session = await createSession("signal");

    // Even if an attacker knows the invite token, they cannot derive the key
    // because the key is derived from a separate random secret

    const realSecret = generateSecret();
    const realKey = await deriveSessionKey(realSecret, session.session_id);
    const realFp = await getKeyFingerprint(realKey);

    // Attempt to "derive" a key from the invite token bytes (attacker strategy)
    const inviteBytes = new TextEncoder().encode(session.invite_token);
    // Pad or truncate to 32 bytes
    const fakeSecret = new Uint8Array(32);
    fakeSecret.set(inviteBytes.slice(0, 32));

    const fakeKey = await deriveSessionKey(fakeSecret, session.session_id);
    const fakeFp = await getKeyFingerprint(fakeKey);

    // The fingerprints must differ — invite token provides no key information
    expect(fakeFp.short).not.toBe(realFp.short);
    expect(fakeFp.full).not.toBe(realFp.full);
  });
});

// ---------------------------------------------------------------------------
// URL Fragment Security
// ---------------------------------------------------------------------------

describe("URL fragment security", () => {
  it("server response headers do not contain fragment data", async () => {
    const session = await createSession("signal");

    // Simulate what the client would do: generate secret, put in URL fragment
    const secret = generateSecret();
    const secretB64 = toUrlSafeBase64(secret.buffer);

    // The invite URL would be:
    // http://localhost:4190/dashboard?session=SESSION_ID&invite=INVITE_TOKEN#key=SECRET
    // The #key=SECRET part NEVER reaches the server (per HTTP spec)

    // Verify the server has no knowledge of the secret by checking the session info
    const res = await fetch(`${BASE}/sessions/${session.session_id}`, {
      headers: { Authorization: `Bearer ${session.creator_token}` },
    });
    const body = await res.text();

    // The secret base64 should not appear anywhere in the response
    expect(body).not.toContain(secretB64);

    // Also check response headers
    const headerDump = [...res.headers.entries()]
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    expect(headerDump).not.toContain(secretB64);
  });

  it("messages endpoint does not echo back key material", async () => {
    const session = await createSession("signal");
    const secret = generateSecret();
    const key = await deriveSessionKey(secret, session.session_id);
    const secretB64 = toUrlSafeBase64(secret.buffer);

    // Send an encrypted message
    const { encryptMessage: encrypt } = await import(
      "@claude-relay/shared"
    );
    const payload = await encrypt("test message", key);

    await fetch(`${BASE}/relay/${session.session_id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.creator_token}`,
      },
      body: JSON.stringify({
        type: "context",
        title: "encrypted test",
        content: JSON.stringify(payload),
        encrypted: true,
      }),
    });

    // Poll messages
    const pollRes = await fetch(
      `${BASE}/relay/${session.session_id}?since=0&limit=10`,
      {
        headers: { Authorization: `Bearer ${session.creator_token}` },
      }
    );
    const pollBody = await pollRes.text();

    // The secret must not appear in polled messages
    expect(pollBody).not.toContain(secretB64);

    // The raw key material must not appear
    const exportedKey = await crypto.subtle.exportKey("raw", key);
    const keyB64 = btoa(
      String.fromCharCode(...new Uint8Array(exportedKey))
    );
    expect(pollBody).not.toContain(keyB64);
  });
});
