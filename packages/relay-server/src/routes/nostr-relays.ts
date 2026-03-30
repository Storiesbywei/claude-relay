/**
 * HTTP routes for managing external Nostr relay connections via relay-pool.
 *
 * POST /nostr/relays     -- connect to an external relay
 * GET  /nostr/relays     -- list connected relays
 * DELETE /nostr/relays/:url -- disconnect (URL is base64-encoded)
 *
 * Auth: Bearer token must belong to any valid session (lightweight check).
 */

import { Hono } from "hono";
import { connectRelay, disconnectRelay, listRelays } from "../nostr/relay-pool.js";
import { getSessionByToken } from "../store/sqlite.js";

export const nostrRelayRoutes = new Hono();

/** Lightweight auth: verify Bearer token belongs to ANY session */
function extractAndVerifyToken(c: any): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const session = getSessionByToken(token);
  if (!session) return null;
  return token;
}

// POST /relays -- connect to an external relay
nostrRelayRoutes.post("/relays", async (c) => {
  const token = extractAndVerifyToken(c);
  if (!token) {
    return c.json({ error: "Unauthorized -- valid session token required" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const { url, session_filter } = body as { url?: string; session_filter?: string };

  if (!url || typeof url !== "string") {
    return c.json({ error: "Missing or invalid 'url' field" }, 400);
  }

  try {
    const result = connectRelay(url, session_filter);
    return c.json(result, 200);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /relays -- list connected relays
nostrRelayRoutes.get("/relays", (c) => {
  const token = extractAndVerifyToken(c);
  if (!token) {
    return c.json({ error: "Unauthorized -- valid session token required" }, 401);
  }

  const connected = listRelays();
  return c.json({ relays: connected });
});

// DELETE /relays/:url -- disconnect from a relay (URL is base64-encoded)
nostrRelayRoutes.delete("/relays/:url", (c) => {
  const token = extractAndVerifyToken(c);
  if (!token) {
    return c.json({ error: "Unauthorized -- valid session token required" }, 401);
  }

  const encodedUrl = c.req.param("url");
  let relayUrl: string;
  try {
    relayUrl = atob(encodedUrl);
  } catch {
    return c.json({ error: "Invalid base64-encoded URL" }, 400);
  }

  const disconnected = disconnectRelay(relayUrl);
  if (!disconnected) {
    return c.json({ error: "Relay not found in pool" }, 404);
  }

  return c.json({ disconnected: true });
});
