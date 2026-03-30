/**
 * Signal Mode Integration Tests
 *
 * Tests the signal mode enforcement in the relay server:
 * - Signal mode rejects plaintext messages
 * - Signal mode rejects MCP-origin messages
 * - Signal mode accepts encrypted messages
 * - Relay mode accepts both plaintext and encrypted
 * - Mode persists and is returned in session info / join responses
 * - Content scanner behavior differs between modes
 *
 * Requires a running relay server on localhost:4191.
 * Start with: RELAY_PORT=4191 bun run dev:server
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  generateSecret,
  deriveSessionKey,
  encryptMessage,
} from "@claude-relay/shared";

const BASE = "http://localhost:4190";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SessionTokens {
  session_id: string;
  creator_token: string;
  invite_token: string;
  mode: string;
}

async function createTestSession(
  mode: "relay" | "signal",
  name?: string
): Promise<SessionTokens> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name || `test-${mode}-${Date.now()}`,
      mode,
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function joinSession(
  sessionId: string,
  inviteToken: string,
  participantName = "worker"
) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${inviteToken}`,
    },
    body: JSON.stringify({ participant_name: participantName }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function sendPlaintext(
  sessionId: string,
  token: string,
  content: string,
  extra: Record<string, unknown> = {}
) {
  return fetch(`${BASE}/relay/${sessionId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      type: "context",
      title: "Test message",
      content,
      ...extra,
    }),
  });
}

async function sendEncrypted(
  sessionId: string,
  token: string,
  content: string
) {
  const secret = generateSecret();
  const key = await deriveSessionKey(secret, sessionId);
  const payload = await encryptMessage(content, key);

  return fetch(`${BASE}/relay/${sessionId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      type: "context",
      title: "Encrypted message",
      content: JSON.stringify(payload),
      encrypted: true,
    }),
  });
}

// ---------------------------------------------------------------------------
// Pre-flight: ensure server is reachable
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
// Session Creation: mode field
// ---------------------------------------------------------------------------

describe("Session creation — mode field", () => {
  it("signal mode session returns mode: 'signal'", async () => {
    const session = await createTestSession("signal");
    expect(session.mode).toBe("signal");
  });

  it("relay mode session returns mode: 'relay'", async () => {
    const session = await createTestSession("relay");
    expect(session.mode).toBe("relay");
  });

  it("default mode is 'relay' when not specified", async () => {
    const res = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `test-default-${Date.now()}` }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mode).toBe("relay");
  });
});

// ---------------------------------------------------------------------------
// Signal Mode Enforcement
// ---------------------------------------------------------------------------

describe("Signal mode enforcement", () => {
  it("rejects plaintext message with 400", async () => {
    const session = await createTestSession("signal");
    const res = await sendPlaintext(
      session.session_id,
      session.creator_token,
      "This is plaintext and should be rejected"
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("encrypted");
  });

  it("rejects MCP-origin message with 403", async () => {
    const session = await createTestSession("signal");
    const res = await sendEncrypted(
      session.session_id,
      session.creator_token,
      "encrypted but from MCP"
    );
    // Need to send with origin: 'mcp' — re-do with raw fetch
    const secret = generateSecret();
    const key = await deriveSessionKey(secret, session.session_id);
    const payload = await encryptMessage("encrypted mcp msg", key);

    const mcpRes = await fetch(`${BASE}/relay/${session.session_id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.creator_token}`,
      },
      body: JSON.stringify({
        type: "context",
        title: "MCP message",
        content: JSON.stringify(payload),
        encrypted: true,
        origin: "mcp",
      }),
    });
    expect(mcpRes.status).toBe(403);
    const body = await mcpRes.json();
    expect(body.error).toContain("MCP");
  });

  it("accepts encrypted message with 201", async () => {
    const session = await createTestSession("signal");
    const res = await sendEncrypted(
      session.session_id,
      session.creator_token,
      "This is properly encrypted"
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message_id).toBeDefined();
    expect(body.sequence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Relay Mode Permissiveness
// ---------------------------------------------------------------------------

describe("Relay mode permissiveness", () => {
  it("accepts plaintext message with 201", async () => {
    const session = await createTestSession("relay");
    const res = await sendPlaintext(
      session.session_id,
      session.creator_token,
      "Plaintext is fine in relay mode"
    );
    expect(res.status).toBe(201);
  });

  it("accepts encrypted message with 201", async () => {
    const session = await createTestSession("relay");
    const res = await sendEncrypted(
      session.session_id,
      session.creator_token,
      "Encrypted also fine in relay mode"
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Mode Persistence
// ---------------------------------------------------------------------------

describe("Mode persistence", () => {
  it("GET /sessions/:id returns mode", async () => {
    const session = await createTestSession("signal");
    const res = await fetch(`${BASE}/sessions/${session.session_id}`, {
      headers: { Authorization: `Bearer ${session.creator_token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("signal");
  });

  it("joiner sees mode in join response", async () => {
    const session = await createTestSession("signal");
    const joinRes = await joinSession(
      session.session_id,
      session.invite_token,
      "joiner"
    );
    expect(joinRes.session.mode).toBe("signal");
  });

  it("relay mode also persists in session info", async () => {
    const session = await createTestSession("relay");
    const res = await fetch(`${BASE}/sessions/${session.session_id}`, {
      headers: { Authorization: `Bearer ${session.creator_token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("relay");
  });
});

// ---------------------------------------------------------------------------
// Content Scanner Behavior
// ---------------------------------------------------------------------------

describe("Content scanner behavior by mode", () => {
  // In signal mode, the scanner should NOT be invoked — encrypted messages
  // pass through without scanning. We test by sending content that would
  // normally be blocked by the scanner (e.g., an API key pattern).

  it("signal mode: scanner NOT invoked on encrypted message", async () => {
    const session = await createTestSession("signal");
    // Content that would trigger the scanner in relay mode
    const sensitiveContent = 'password = "hunter2"';

    const secret = generateSecret();
    const key = await deriveSessionKey(secret, session.session_id);
    const payload = await encryptMessage(sensitiveContent, key);

    const res = await fetch(`${BASE}/relay/${session.session_id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.creator_token}`,
      },
      body: JSON.stringify({
        type: "context",
        title: "Encrypted sensitive data",
        content: JSON.stringify(payload),
        encrypted: true,
      }),
    });
    // Should succeed — scanner doesn't run on encrypted payloads in signal mode
    expect(res.status).toBe(201);
  });

  it("relay mode: scanner IS invoked on plaintext", async () => {
    const session = await createTestSession("relay");
    // Content that triggers the sensitive content scanner
    const sensitiveContent = 'api_key = "sk-1234567890abcdefghijklmnop"';

    const res = await sendPlaintext(
      session.session_id,
      session.creator_token,
      sensitiveContent
    );
    // Should be blocked by the scanner (422)
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("blocked");
  });

  it("relay mode: scanner NOT invoked on encrypted message", async () => {
    const session = await createTestSession("relay");
    // Even in relay mode, encrypted payloads skip the scanner
    const res = await sendEncrypted(
      session.session_id,
      session.creator_token,
      'password = "hunter2"'
    );
    expect(res.status).toBe(201);
  });
});
