import { Hono } from "hono";
import { RelayMessagePayloadSchema } from "@claude-relay/shared";
import type { StoredMessage } from "@claude-relay/shared";
import { addMessage, getMessages, getSession, subscribe } from "../store/memory.js";
import { streamSSE } from "hono/streaming";

export const relayRoutes = new Hono();

// POST /relay/:session_id — send a message
relayRoutes.post("/:session_id", async (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = RelayMessagePayloadSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid message payload", details: parsed.error.issues },
      400
    );
  }

  const senderToken = c.get("token") as string;
  const senderName = getSenderName(session, senderToken);

  const message: StoredMessage = {
    message_id: crypto.randomUUID(),
    sequence: 0, // Will be set by addMessage
    type: parsed.data.type,
    title: parsed.data.title,
    content: parsed.data.content,
    tags: parsed.data.tags,
    references: parsed.data.references,
    context: parsed.data.context,
    sender_name: senderName,
    sent_at: new Date().toISOString(),
  };

  try {
    addMessage(sessionId, message);
    return c.json(
      {
        message_id: message.message_id,
        sequence: message.sequence,
        received_at: message.sent_at,
      },
      201
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /relay/:session_id — poll for messages
relayRoutes.get("/:session_id", (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const since = Number(c.req.query("since") || "0");
  const limit = Math.min(Number(c.req.query("limit") || "10"), 50);

  try {
    const result = getMessages(sessionId, since, limit);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /relay/:session_id/stream — SSE live message stream
relayRoutes.get("/:session_id/stream", (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    // Send heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }, 15_000);

    const unsubscribe = subscribe(sessionId, (msg) => {
      stream.writeSSE({
        event: "message",
        data: JSON.stringify(msg),
        id: String(msg.sequence),
      }).catch(() => {});
    });

    // Keep stream open until client disconnects
    try {
      await new Promise((_, reject) => {
        stream.onAbort(() => reject(new Error("aborted")));
      });
    } catch {
      // Client disconnected
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

function getSenderName(
  session: { creatorToken: string; participants: Map<string, { name: string }> },
  token: string
): string {
  if (token === session.creatorToken) return "creator";
  const participant = session.participants.get(token);
  return participant?.name || "anonymous";
}
