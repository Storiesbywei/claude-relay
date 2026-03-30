import { Hono } from "hono";
import { RelayMessagePayloadSchema, scanContent } from "@claude-relay/shared";
import type { StoredMessage } from "@claude-relay/shared";
import { addMessage, getMessages, getSession, getParticipantNames, subscribe } from "../store/sqlite.js";
import { streamSSE } from "hono/streaming";
import { bridgeMessageToNostr } from "../nostr/bridge.js";

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

  // Scan content for sensitive data before accepting the message
  const allWarnings: string[] = [];
  const contentScan = scanContent(parsed.data.content);
  allWarnings.push(...contentScan.warnings);
  if (parsed.data.title) {
    const titleScan = scanContent(parsed.data.title);
    allWarnings.push(...titleScan.warnings);
  }
  if (allWarnings.length > 0) {
    return c.json({ error: "Content blocked", warnings: allWarnings }, 422);
  }

  const senderToken = c.get("token") as string;
  const defaultName = getSenderName(session, senderToken);
  // Allow sender_name override from body (for creator sending on behalf of subagents)
  const senderName = (body.sender_name && typeof body.sender_name === "string")
    ? body.sender_name.slice(0, 100)
    : defaultName;

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

    // Bridge: also publish to Nostr event store so WS subscribers get it
    bridgeMessageToNostr(message, sessionId);

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
    // Sprint 2: SSE catch-up -- replay missed messages on reconnect
    const lastEventId = c.req.header("Last-Event-ID");
    if (lastEventId) {
      const since = parseInt(lastEventId, 10);
      if (!isNaN(since)) {
        const catchup = getMessages(sessionId, since, 50);
        for (const msg of catchup.messages) {
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify(msg),
            id: String(msg.sequence),
          });
        }
      }
    }

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

// GET /relay/:session_id/export -- export session as JSON or Markdown (Sprint 2: dashboard)
relayRoutes.get("/:session_id/export", (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const format = (c.req.query("format") || "json").toLowerCase();

  // Fetch all messages (use large limit to get everything)
  const allMessages: StoredMessage[] = [];
  let cursor = 0;
  while (true) {
    const batch = getMessages(sessionId, cursor, 200);
    allMessages.push(...batch.messages);
    cursor = batch.cursor;
    if (!batch.has_more) break;
  }

  const participants = getParticipantNames(session);

  if (format === "md" || format === "markdown") {
    // Generate Markdown transcript
    let md = `# Session: ${session.name}\n\n`;
    md += `**Created:** ${session.createdAt.toISOString()}  \n`;
    md += `**Participants:** ${participants.join(", ")}  \n`;
    md += `**Messages:** ${allMessages.length}\n\n---\n`;

    for (const msg of allMessages) {
      md += `\n## [${msg.sequence}] ${msg.type} -- ${msg.title || "(untitled)"}\n`;
      md += `**From:** ${msg.sender_name || "unknown"} | **At:** ${msg.sent_at}\n\n`;
      md += `${msg.content}\n\n---\n`;
    }

    const filename = `session-${sessionId}.md`;
    return new Response(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // Default: JSON format
  return c.json({
    session: {
      id: session.id,
      name: session.name,
      created_at: session.createdAt.toISOString(),
      expires_at: session.expiresAt.toISOString(),
      participants,
    },
    messages: allMessages.map((msg) => ({
      message_id: msg.message_id,
      sequence: msg.sequence,
      type: msg.type,
      title: msg.title,
      content: msg.content,
      sender_name: msg.sender_name,
      sent_at: msg.sent_at,
    })),
    exported_at: new Date().toISOString(),
    message_count: allMessages.length,
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
