import { Hono } from "hono";
import { RelayMessagePayloadSchema, scanAndGateMessage } from "@claude-relay/shared";
import type { StoredMessage, KeyRotationEvent } from "@claude-relay/shared";
import {
  addMessage,
  getMessages,
  getSession,
  getParticipantNames,
  subscribe,
  validateTrustToken,
  getActiveTrustGrantsForSession,
  recordKeyRotation,
  getSessionKeyVersion,
} from "../store/sqlite.js";
import { streamSSE } from "hono/streaming";
import { bridgeMessageToNostr } from "../nostr/bridge.js";
import { bridgeMessageToSolid } from "../solid/bridge.js";

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

  const isSignalMode = session.mode === 'signal';

  // Signal mode enforcement:
  // 1. All messages MUST be encrypted — reject plaintext
  if (isSignalMode && !parsed.data.encrypted) {
    return c.json({ error: "Signal mode requires all messages to be encrypted" }, 400);
  }

  // 1b. Title must not leak content in signal mode.
  // Enforce that signal mode titles are generic (no more than a type label).
  // Titles are stored as plaintext metadata — an adversary with server access
  // could read them. Reject titles that appear to contain meaningful content.
  if (isSignalMode && parsed.data.title && parsed.data.title.length > 50) {
    return c.json({
      error: "Signal mode: title must be <= 50 chars to prevent metadata leakage. Put details in encrypted content.",
    }, 400);
  }

  // 2. Reject messages from MCP origin UNLESS the agent has a valid trust token.
  //    Trusted agents (Level 2) are explicitly invited by a human and hold the
  //    session key — their messages are encrypted just like human messages.
  if (isSignalMode && parsed.data.origin === 'mcp') {
    // Check for trust token in X-Trust-Token header
    const trustTokenHeader = c.req.header("X-Trust-Token");
    let trustedAgent = false;
    if (trustTokenHeader) {
      const trustInfo = validateTrustToken(trustTokenHeader);
      if (trustInfo && trustInfo.session_id === sessionId) {
        const hasCap = trustInfo.capabilities.includes('write');
        if (hasCap) {
          trustedAgent = true;
          // Tag the message with the agent identity for audit trail
          (parsed.data as any)._trusted_agent_id = trustInfo.agent_id;
        }
      }
    }
    if (!trustedAgent) {
      return c.json({ error: "MCP tools are not allowed in signal mode without a valid trust grant" }, 403);
    }
  }

  // Verify encrypted payloads actually contain valid encrypted structure
  // Supports both AES-GCM payloads ({ ciphertext, iv, encrypted }) and
  // ratchet payloads ({ ciphertext, iv, index, ratchet }) for forward secrecy.
  if (parsed.data.encrypted) {
    try {
      const payload = JSON.parse(parsed.data.content);
      const isAesGcm = payload.encrypted === true && typeof payload.ciphertext === 'string' && typeof payload.iv === 'string';
      const isRatchet = payload.ratchet === true && typeof payload.ciphertext === 'string' && typeof payload.iv === 'string' && typeof payload.index === 'number';
      if (!isAesGcm && !isRatchet) {
        return c.json({ error: 'Invalid encrypted payload structure' }, 400);
      }
      if (payload.ciphertext.length < 20 || payload.iv.length < 12) {
        return c.json({ error: 'Encrypted payload too short' }, 400);
      }
    } catch {
      return c.json({ error: 'encrypted flag set but content is not valid encrypted JSON' }, 400);
    }
  }

  // Skip server-side content scanning for E2E encrypted payloads or signal mode.
  // In relay mode: client runs the scanner BEFORE encryption (Scan-then-Seal pattern).
  // In signal mode: no content scanning — humans don't need promptware protection.
  if (!isSignalMode && !parsed.data.encrypted) {
    const gate = scanAndGateMessage(parsed.data.content, parsed.data.title, "http");
    if (!gate.allowed) {
      return c.json({ error: "Content blocked", warnings: gate.warnings }, 422);
    }
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
    // Sealed sender: in signal mode, the relay stores "sealed" instead of the
    // real sender name. The actual sender identity is inside the encrypted payload.
    // This prevents the relay from building a sender/recipient graph.
    sender_name: isSignalMode ? "sealed" : senderName,
    sent_at: new Date().toISOString(),
    origin: parsed.data.origin || "http",
    ...(parsed.data.encrypted ? { encrypted: true } : {}),
  };

  try {
    addMessage(sessionId, message);

    // Bridge: also publish to Nostr event store so WS subscribers get it
    bridgeMessageToNostr(message, sessionId);

    // Bridge to Solid Pod (async, non-blocking)
    bridgeMessageToSolid(message, sessionId).catch(err => {
      console.error(`[solid bridge] Failed to bridge message: ${err.message}`);
    });

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

    // SECURITY: Redact plaintext metadata for signal mode sessions.
    // The server stores titles and sender names in plaintext — strip them
    // from the poll response so a compromised server yields less metadata.
    if (session.mode === 'signal') {
      result.messages = result.messages.map((msg) => ({
        ...msg,
        type: "encrypted",
        title: "",
        sender_name: undefined,
        tags: undefined,
        references: undefined,
        context: undefined,
      }));
    }

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

  const isSignalSession = session.mode === 'signal';

  /**
   * Strip plaintext metadata from signal mode messages before sending via SSE.
   * The server should not expose titles, sender names, or types as they are
   * unencrypted metadata that could reveal information about the conversation.
   */
  function redactForSignalMode(msg: StoredMessage): object {
    if (!isSignalSession) return msg;
    return {
      message_id: msg.message_id,
      sequence: msg.sequence,
      type: "encrypted",
      title: "",
      content: msg.content, // ciphertext — opaque to server
      sent_at: msg.sent_at,
      encrypted: msg.encrypted,
    };
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
            data: JSON.stringify(redactForSignalMode(msg)),
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
        data: JSON.stringify(redactForSignalMode(msg)),
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

  // SECURITY: Signal mode sessions must not expose metadata via server-side export.
  // The server holds only ciphertext, but titles, sender names, types, and timestamps
  // are stored in plaintext metadata. Exporting these would leak information that
  // signal mode is designed to protect. Clients must decrypt and export locally.
  if (session.mode === 'signal') {
    return c.json({
      error: "Export is disabled for signal mode sessions. Decrypt and export client-side.",
      reason: "Server-side export would leak plaintext metadata (titles, sender names, timestamps) that signal mode is designed to protect.",
    }, 403);
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
