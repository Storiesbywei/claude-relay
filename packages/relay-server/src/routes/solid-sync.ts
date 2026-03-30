/**
 * Solid sync API routes.
 *
 * POST /solid/:session_id/enable  — enable Pod sync for a session
 * GET  /solid/:session_id/status  — get sync status for a session
 */

import { Hono } from "hono";
import { getSession } from "../store/memory.js";
import {
  setSolidConfig,
  getSolidConfig,
  hasSolidConfig,
  getSyncedSequence,
  getSessionQueueDepth,
  getLastError,
  enqueue,
} from "../solid/solid-store.js";
import { validatePodAccess } from "../solid/pod-writer.js";
import type { SolidExportConfig } from "../solid/types.js";

export const solidSyncRoutes = new Hono();

/**
 * POST /solid/:session_id/enable
 *
 * Enable Pod sync for a session. Only the session creator can enable.
 * Validates Pod access before storing config.
 * Triggers initial catch-up to sync any existing messages.
 *
 * Body: { podUrl, webId, accessToken, refreshToken? }
 */
solidSyncRoutes.post("/:session_id/enable", async (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Only creator can enable Solid sync
  const token = c.get("token") as string;
  if (token !== session.creatorToken) {
    return c.json(
      { error: "Only the session creator can enable Solid sync" },
      403
    );
  }

  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.podUrl || typeof body.podUrl !== "string") {
    return c.json({ error: "podUrl is required and must be a string" }, 400);
  }
  if (!body.webId || typeof body.webId !== "string") {
    return c.json({ error: "webId is required and must be a string" }, 400);
  }
  if (!body.accessToken || typeof body.accessToken !== "string") {
    return c.json(
      { error: "accessToken is required and must be a string" },
      400
    );
  }

  // Validate URL format
  try {
    new URL(body.podUrl);
  } catch {
    return c.json({ error: "podUrl must be a valid URL" }, 400);
  }

  const config: SolidExportConfig = {
    podUrl: body.podUrl,
    webId: body.webId,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken || undefined,
    enabledAt: new Date().toISOString(),
  };

  // Validate Pod access before storing
  const validation = await validatePodAccess(config);
  if (!validation.valid) {
    return c.json(
      {
        error: "Pod access validation failed",
        details: validation.error,
      },
      422
    );
  }

  // Store the config
  setSolidConfig(sessionId, config);

  // Trigger catch-up: enqueue any existing messages
  const currentSeq = session.sequenceCounter;
  let enqueued = 0;
  if (currentSeq > 0) {
    for (let seq = 1; seq <= currentSeq; seq++) {
      enqueue(sessionId, seq);
      enqueued++;
    }
  }

  console.log(
    `[solid-sync] Enabled for session ${sessionId} → ${config.podUrl} (${enqueued} existing messages enqueued)`
  );

  return c.json(
    {
      enabled: true,
      podUrl: config.podUrl,
      webId: config.webId,
      existingMessagesEnqueued: enqueued,
    },
    200
  );
});

/**
 * GET /solid/:session_id/status
 *
 * Returns sync status for a session:
 * - Whether Solid sync is enabled
 * - Pod URL
 * - How far sync has progressed vs current sequence
 * - Queue depth and last error
 */
solidSyncRoutes.get("/:session_id/status", (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const config = getSolidConfig(sessionId);
  const enabled = !!config;

  return c.json({
    enabled,
    podUrl: config?.podUrl ?? null,
    syncedSequence: getSyncedSequence(sessionId),
    currentSequence: session.sequenceCounter,
    queueDepth: getSessionQueueDepth(sessionId),
    lastError: getLastError(sessionId),
  });
});
