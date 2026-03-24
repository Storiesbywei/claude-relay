import { Hono } from "hono";
import { CreateSessionRequestSchema } from "@claude-relay/shared";
import {
  createSession,
  getSession,
  addParticipant,
  isInviteToken,
  isValidToken,
  getParticipantNames,
} from "../store/memory.js";

export const sessionRoutes = new Hono();

// POST /sessions — create a new relay session
sessionRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { name, ttl_minutes } = parsed.data;
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

    return c.json(
      {
        session_id: session.id,
        creator_token: creatorToken,
        invite_token: inviteToken,
        expires_at: session.expiresAt.toISOString(),
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

  return c.json({
    id: session.id,
    name: session.name,
    participants: getParticipantNames(session),
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
  const participantName = body.participant_name || "anonymous";
  const participantToken = crypto.randomUUID();

  try {
    addParticipant(id, participantToken, participantName);

    return c.json({
      participant_token: participantToken,
      session: {
        id: session.id,
        name: session.name,
        participants: getParticipantNames(session),
        message_count: session.messages.length,
        expires_at: session.expiresAt.toISOString(),
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});
