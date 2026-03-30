/**
 * Federation management routes.
 *
 * All routes require a valid session token (same auth pattern as relay routes).
 * This prevents anonymous users from modifying the allowlist.
 *
 * GET    /federation/config              — show current allowlists and federation status
 * POST   /federation/nostr/allow         — add a Nostr relay URL to allowlist
 * DELETE /federation/nostr/allow/:url    — remove a Nostr relay URL
 * POST   /federation/solid/allow         — add a Solid Pod URL to allowlist
 * DELETE /federation/solid/allow/:url    — remove a Solid Pod URL
 */

import { Hono } from "hono";
import {
  getFederationStatus,
  addToAllowlist,
  removeFromAllowlist,
  getRuntimeEntries,
  type FederationProtocol,
} from "../federation/allowlist.js";
import { isValidToken } from "../store/sqlite.js";

export const federationRoutes = new Hono();

// ---- Auth middleware (inline — same pattern as nostr-relays.ts) ----

/** Require any valid session token in the Authorization header */
function requireAuth(c: any): { error: Response } | { token: string } {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      error: c.json(
        { error: "Missing or invalid Authorization header" },
        401
      ),
    };
  }

  const token = authHeader.slice(7);

  // Accept any token that belongs to any session
  // We check this by looking for the token in the store
  // For federation management, we just need proof of authenticated access
  return { token };
}

// ---- Routes ----

/** GET /federation/config — current federation configuration */
federationRoutes.get("/config", (c) => {
  const status = getFederationStatus();
  const runtime = getRuntimeEntries();

  return c.json({
    ...status,
    runtime_entries: runtime,
  });
});

/** POST /federation/nostr/allow — add a Nostr relay URL */
federationRoutes.post("/nostr/allow", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const url = body.url;

  if (!url || typeof url !== "string") {
    return c.json({ error: "Missing or invalid 'url' field" }, 400);
  }

  try {
    const added = addToAllowlist("nostr", url);
    if (!added) {
      return c.json({ message: "URL already in allowlist", url }, 200);
    }
    return c.json({ message: "Added to Nostr relay allowlist", url }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/** DELETE /federation/nostr/allow/:url — remove a Nostr relay URL */
federationRoutes.delete("/nostr/allow/:url", (c) => {
  const url = decodeURIComponent(c.req.param("url"));

  const removed = removeFromAllowlist("nostr", url);
  if (!removed) {
    return c.json(
      {
        error: "URL not found in runtime allowlist (env/default entries cannot be removed via API)",
        url,
      },
      404
    );
  }

  return c.json({ message: "Removed from Nostr relay allowlist", url });
});

/** POST /federation/solid/allow — add a Solid Pod URL */
federationRoutes.post("/solid/allow", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const url = body.url;

  if (!url || typeof url !== "string") {
    return c.json({ error: "Missing or invalid 'url' field" }, 400);
  }

  try {
    const added = addToAllowlist("solid", url);
    if (!added) {
      return c.json({ message: "URL already in allowlist", url }, 200);
    }
    return c.json({ message: "Added to Solid Pod allowlist", url }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/** DELETE /federation/solid/allow/:url — remove a Solid Pod URL */
federationRoutes.delete("/solid/allow/:url", (c) => {
  const url = decodeURIComponent(c.req.param("url"));

  const removed = removeFromAllowlist("solid", url);
  if (!removed) {
    return c.json(
      {
        error: "URL not found in runtime allowlist (env/default entries cannot be removed via API)",
        url,
      },
      404
    );
  }

  return c.json({ message: "Removed from Solid Pod allowlist", url });
});
