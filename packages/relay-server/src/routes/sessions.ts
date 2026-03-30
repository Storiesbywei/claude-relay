import { Hono } from "hono";
import { CreateSessionRequestSchema, JoinSessionRequestSchema } from "@claude-relay/shared";
import type { AgentCapability, StoredMessage, KeyRotationEvent } from "@claude-relay/shared";
import {
  createSession,
  getSession,
  addMessage,
  addParticipant,
  isInviteToken,
  isValidToken,
  getParticipantNames,
  bindPubkeyToSession,
  upsertTrustGrant,
  getTrustGrant,
  getActiveTrustGrantsForSession,
  revokeTrustGrant,
  issueTrustToken,
  recordKeyRotation,
  getSessionKeyVersion,
} from "../store/sqlite.js";

export const sessionRoutes = new Hono();

// POST /sessions — create a new relay session
sessionRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { name, ttl_minutes, nostr_pubkey, mode } = parsed.data;
  const sessionId = crypto.randomUUID();
  const creatorToken = crypto.randomUUID();
  const inviteToken = crypto.randomUUID();

  try {
    const session = createSession(
      sessionId,
      name,
      creatorToken,
      inviteToken,
      ttl_minutes ?? 60,
      mode ?? 'relay'
    );

    if (nostr_pubkey) {
      bindPubkeyToSession(sessionId, nostr_pubkey, creatorToken);
    }

    return c.json(
      {
        session_id: session.id,
        creator_token: creatorToken,
        invite_token: inviteToken,
        expires_at: session.expiresAt.toISOString(),
        mode: session.mode || 'relay',
        ...(nostr_pubkey && { nostr_pubkey }),
      },
      201
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /sessions/:id — get session info (requires valid token)
sessionRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (!isValidToken(token, id)) {
    return c.json({ error: "Invalid token" }, 403);
  }

  const session = getSession(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Sprint 2: Return participant objects with { name, role, joined_at } for identity badges
  const participantDetails = [
    { name: "creator", role: "creator", joined_at: session.createdAt.toISOString() },
  ];
  for (const [, info] of session.participants) {
    participantDetails.push({
      name: info.name || "anonymous",
      role: "participant",
      joined_at: info.joinedAt.toISOString(),
    });
  }

  return c.json({
    id: session.id,
    name: session.name,
    participants: participantDetails,
    message_count: session.messages.length,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
    last_activity_at: session.lastActivityAt.toISOString(),
    mode: session.mode || 'relay',
  });
});

// POST /sessions/:id/join — join with invite token
sessionRoutes.post("/:id/join", async (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const inviteTokenProvided = authHeader.slice(7);
  if (!isInviteToken(inviteTokenProvided, id)) {
    return c.json({ error: "Invalid invite token" }, 403);
  }

  const session = getSession(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = JoinSessionRequestSchema.safeParse(body);
  const participantName = parsed.success
    ? (parsed.data.participant_name || "anonymous")
    : (body.participant_name || "anonymous");
  const nostrPubkey = parsed.success ? parsed.data.nostr_pubkey : undefined;
  const participantToken = crypto.randomUUID();

  try {
    addParticipant(id, participantToken, participantName);

    if (nostrPubkey) {
      bindPubkeyToSession(id, nostrPubkey, participantToken);
    }

    return c.json({
      participant_token: participantToken,
      session: {
        id: session.id,
        name: session.name,
        participants: getParticipantNames(session),
        message_count: session.messages.length,
        expires_at: session.expiresAt.toISOString(),
        mode: session.mode || 'relay',
        ...(nostrPubkey && { nostr_pubkey: nostrPubkey }),
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ─── Capability Lattice Endpoints ─────────────────────────────────────────────

/**
 * POST /sessions/:id/trust — Grant trust to an agent (Level 3 human only)
 *
 * Only the session creator can grant trust. This endpoint:
 * 1. Stores the trust grant (with encrypted key — opaque to server)
 * 2. Issues a trust token for the agent
 * 3. Records the key rotation event
 * 4. Inserts a key_rotation system message into the timeline
 */
sessionRoutes.post("/:id/trust", async (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const session = getSession(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Only the creator (Level 3) can grant trust
  if (token !== session.creatorToken) {
    return c.json({ error: "Only the session creator can grant trust" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const {
    agent_id,
    capabilities,
    encrypted_key,
    key_version,
    rotation_nonce,
  } = body as {
    agent_id?: string;
    capabilities?: AgentCapability[];
    encrypted_key?: string;
    key_version?: number;
    rotation_nonce?: string;
  };

  if (!agent_id || typeof agent_id !== "string") {
    return c.json({ error: "agent_id is required" }, 400);
  }
  if (!encrypted_key || typeof encrypted_key !== "string") {
    return c.json({ error: "encrypted_key is required (opaque to server)" }, 400);
  }

  const validCaps: AgentCapability[] = ["read", "write", "auto_approve", "bridge_nostr", "bridge_solid"];
  const grantCaps: AgentCapability[] = (capabilities || ["read"]).filter(
    (cap: string) => validCaps.includes(cap as AgentCapability)
  ) as AgentCapability[];

  const currentVersion = getSessionKeyVersion(id);
  const newVersion = key_version ?? currentVersion + 1;

  try {
    // 1. Store the trust grant
    upsertTrustGrant({
      session_id: id,
      agent_id,
      granted_by: "creator",
      key_version: newVersion,
      level: 2,
      capabilities: grantCaps,
      encrypted_key,
    });

    // 2. Issue a trust token
    const trustToken = issueTrustToken({
      session_id: id,
      agent_id,
      capabilities: grantCaps,
      expires_at: session.expiresAt.toISOString(),
    });

    // 3. Record key rotation
    if (rotation_nonce) {
      recordKeyRotation({
        session_id: id,
        version: newVersion,
        reason: "agent_invite",
        nonce: rotation_nonce,
        trigger_agent_id: agent_id,
      });
    }

    // 4. Insert a system message for the key rotation event
    const rotationEvent: KeyRotationEvent = {
      type: "key_rotation",
      version: newVersion,
      reason: "agent_invite",
      nonce: rotation_nonce || "",
      grants: [{
        agent_id,
        granted_by: "creator",
        granted_at: new Date().toISOString(),
        key_version: newVersion,
        level: 2,
        capabilities: grantCaps,
        encrypted_key: "[redacted]", // Don't put the actual key in the timeline
        active: true,
      }],
      timestamp: new Date().toISOString(),
      trigger_agent_id: agent_id,
    };

    const systemMessage: StoredMessage = {
      message_id: crypto.randomUUID(),
      sequence: 0,
      type: "status_update",
      title: `Agent "${agent_id}" granted trust (Level 2)`,
      content: JSON.stringify(rotationEvent),
      sender_name: "system",
      sent_at: new Date().toISOString(),
    };
    addMessage(id, systemMessage);

    return c.json({
      trust_token: trustToken,
      agent_id,
      capabilities: grantCaps,
      key_version: newVersion,
      message: `Trust granted to agent "${agent_id}" with capabilities: ${grantCaps.join(", ")}`,
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * DELETE /sessions/:id/trust/:agent_id — Revoke trust from an agent
 *
 * Only the session creator can revoke trust. This endpoint:
 * 1. Revokes the trust grant
 * 2. Deletes the trust token
 * 3. Records the key rotation event
 * 4. Inserts a revocation system message into the timeline
 *
 * The client is responsible for distributing the new key (v+1) to
 * remaining trusted participants — the server stays blind to keys.
 */
sessionRoutes.delete("/:id/trust/:agent_id", async (c) => {
  const id = c.req.param("id");
  const agentId = c.req.param("agent_id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const session = getSession(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (token !== session.creatorToken) {
    return c.json({ error: "Only the session creator can revoke trust" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const { rotation_nonce } = body as { rotation_nonce?: string };

  const currentVersion = getSessionKeyVersion(id);
  const newVersion = currentVersion + 1;

  try {
    const revoked = revokeTrustGrant(id, agentId);
    if (!revoked) {
      return c.json({ error: `No active trust grant found for agent "${agentId}"` }, 404);
    }

    // Record key rotation for revocation
    if (rotation_nonce) {
      recordKeyRotation({
        session_id: id,
        version: newVersion,
        reason: "agent_revoke",
        nonce: rotation_nonce,
        trigger_agent_id: agentId,
      });
    }

    // Insert revocation system message
    const rotationEvent: KeyRotationEvent = {
      type: "key_rotation",
      version: newVersion,
      reason: "agent_revoke",
      nonce: rotation_nonce || "",
      grants: [],
      timestamp: new Date().toISOString(),
      trigger_agent_id: agentId,
    };

    const systemMessage: StoredMessage = {
      message_id: crypto.randomUUID(),
      sequence: 0,
      type: "status_update",
      title: `Agent "${agentId}" trust revoked`,
      content: JSON.stringify(rotationEvent),
      sender_name: "system",
      sent_at: new Date().toISOString(),
    };
    addMessage(id, systemMessage);

    return c.json({
      revoked: true,
      agent_id: agentId,
      new_key_version: newVersion,
      message: `Trust revoked for agent "${agentId}". Key rotated to v${newVersion}.`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * GET /sessions/:id/trust — List trust grants for a session
 *
 * Requires valid session token. Returns all active grants.
 */
sessionRoutes.get("/:id/trust", (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (!isValidToken(token, id)) {
    return c.json({ error: "Invalid token" }, 403);
  }

  const grants = getActiveTrustGrantsForSession(id);
  const keyVersion = getSessionKeyVersion(id);

  return c.json({
    session_id: id,
    key_version: keyVersion,
    grants: grants.map((g) => ({
      agent_id: g.agent_id,
      granted_by: g.granted_by,
      granted_at: g.granted_at,
      key_version: g.key_version,
      level: g.level,
      capabilities: JSON.parse(g.capabilities),
      active: !!g.active,
      revoked_at: g.revoked_at,
    })),
  });
});
