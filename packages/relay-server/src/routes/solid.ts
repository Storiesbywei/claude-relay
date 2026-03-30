import { Hono } from "hono";
import { z } from "zod";
import { exportSessionToPod } from "../solid/export.js";
import { getSession, bindWebIdToSession } from "../store/sqlite.js";
import {
  setSolidFederationConfig,
  removeSolidFederationConfig,
  getSolidFederationConfig,
} from "../solid/bridge.js";
import { notificationPool } from "../solid/notification-pool.js";

export const solidRoutes = new Hono();

const SolidExportRequestSchema = z.object({
  pod_url: z.string().url(),
  oidc_issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  container_path: z.string().optional(),
});

// POST /solid/:session_id/export — export session to Solid Pod
solidRoutes.post("/:session_id/export", async (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Only the session creator can export
  const token = c.get("token") as string;
  if (token !== session.creatorToken) {
    return c.json({ error: "Only the session creator can export to Solid Pod" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = SolidExportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid Solid configuration", details: parsed.error.issues }, 400);
  }

  try {
    const result = await exportSessionToPod(sessionId, {
      podUrl: parsed.data.pod_url,
      oidcIssuer: parsed.data.oidc_issuer,
      clientId: parsed.data.client_id,
      clientSecret: parsed.data.client_secret,
      containerPath: parsed.data.container_path,
    });
    return c.json(result, 201);
  } catch (err: any) {
    // Sanitize error message — never leak client_secret in responses
    const safeMessage = (err.message || "Unknown error")
      .replace(parsed.data.client_secret, "[REDACTED]");

    // Distinguish network errors (Pod unreachable) from auth/logic errors
    const isNetworkError =
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.cause?.code === "ECONNREFUSED" ||
      err.cause?.code === "ENOTFOUND" ||
      safeMessage.includes("fetch failed");

    if (isNetworkError) {
      return c.json(
        { error: `Solid Pod unreachable at ${parsed.data.pod_url}. Is the Pod server running?` },
        502
      );
    }

    console.error(`[solid] Export failed for session ${sessionId}: ${safeMessage}`);
    return c.json({ error: `Solid export failed: ${safeMessage}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// Federation: bidirectional Solid bridge
// ---------------------------------------------------------------------------

const SolidFederateRequestSchema = z.object({
  pod_url: z.string().url(),
  oidc_issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  container_path: z.string().optional(),
  web_id: z.string().url().optional(),
});

// POST /solid/:session_id/federate — enable bidirectional Solid federation
solidRoutes.post("/:session_id/federate", async (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Only the session creator can enable federation
  const token = c.get("token") as string;
  if (token !== session.creatorToken) {
    return c.json({ error: "Only the session creator can enable Solid federation" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = SolidFederateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid Solid federation config", details: parsed.error.issues }, 400);
  }

  const config = {
    podUrl: parsed.data.pod_url,
    oidcIssuer: parsed.data.oidc_issuer,
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret,
    containerPath: parsed.data.container_path,
  };

  try {
    // Register federation config for outbound bridge
    setSolidFederationConfig(sessionId, config);

    // Bind WebID to session if provided
    if (parsed.data.web_id) {
      bindWebIdToSession(sessionId, parsed.data.web_id, token);
    }

    // Build the messages container URL and start watching for inbound messages
    const podBase = config.podUrl.endsWith("/") ? config.podUrl : config.podUrl + "/";
    const containerPath = config.containerPath || "relay-sessions/";
    const containerPathNorm = containerPath.endsWith("/") ? containerPath : containerPath + "/";
    const messagesContainerUrl = `${podBase}${containerPathNorm}${sessionId}/messages/`;

    notificationPool.subscribe(sessionId, messagesContainerUrl, config);

    return c.json({
      status: "federation_enabled",
      session_id: sessionId,
      pod_url: config.podUrl,
      messages_container: messagesContainerUrl,
      web_id: parsed.data.web_id || null,
      watching: true,
    }, 200);
  } catch (err: any) {
    // Sanitize error — never leak client_secret
    const safeMessage = (err.message || "Unknown error")
      .replace(parsed.data.client_secret, "[REDACTED]");

    console.error(`[solid] Federation setup failed for session ${sessionId}: ${safeMessage}`);
    return c.json({ error: `Solid federation failed: ${safeMessage}` }, 500);
  }
});

// DELETE /solid/:session_id/federate — disable Solid federation
solidRoutes.delete("/:session_id/federate", (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const token = c.get("token") as string;
  if (token !== session.creatorToken) {
    return c.json({ error: "Only the session creator can disable Solid federation" }, 403);
  }

  removeSolidFederationConfig(sessionId);
  notificationPool.unsubscribe(sessionId);

  return c.json({ status: "federation_disabled", session_id: sessionId });
});

// GET /solid/:session_id/federate — check federation status
solidRoutes.get("/:session_id/federate", (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const config = getSolidFederationConfig(sessionId);
  const subscriptions = notificationPool.getStatus();
  const sub = subscriptions.find((s) => s.sessionId === sessionId);

  return c.json({
    session_id: sessionId,
    federation_enabled: !!config,
    pod_url: config?.podUrl || null,
    notification_status: sub?.status || "not_subscribed",
    poll_count: sub?.pollCount || 0,
    last_poll_at: sub?.lastPollAt || null,
  });
});
