import { Hono } from "hono";
import { CreateSessionRequestSchema, JoinSessionRequestSchema } from "@claude-relay/shared";
import {
  createSession,
  getSession,
  addParticipant,
  isInviteToken,
  isValidToken,
  getParticipantNames,
  bindPubkeyToSession,
} from "../store/sqlite.js";

export const sessionRoutes = new Hono();

// POST /sessions — create a new relay session
sessionRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { name, ttl_minutes, nostr_pubkey } = parsed.data;
  const sessionId = crypto.randomUUID();
  const creatorToken = crypto.randomUUID();
  const inviteToken = crypto.randomUUID();

  try {
    const session = createSession(
      sessionId,
      name,
      creatorToken,
      inviteToken,
      ttl_minutes ?? 60
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
        ...(nostrPubkey && { nostr_pubkey: nostrPubkey }),
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});
