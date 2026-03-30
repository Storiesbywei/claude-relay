import { Hono } from "hono";
import { getSessionCount } from "../store/memory.js";
import { getNostrStats } from "../nostr/handler.js";
import { getFederationStatus } from "../federation/allowlist.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    version: "0.2.0",
    sessions: getSessionCount(),
    nostr: getNostrStats(),
    federation: getFederationStatus(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});
