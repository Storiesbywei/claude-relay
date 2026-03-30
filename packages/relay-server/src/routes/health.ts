import { Hono } from "hono";
import { getSessionCount } from "../store/sqlite.js";
import { getNostrStats } from "../nostr/handler.js";
import { getServerNpub } from "../nostr/bridge.js";
import { getPoolStatus } from "../nostr/relay-pool.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    version: "0.3.0",
    sessions: getSessionCount(),
    nostr: {
      ...getNostrStats(),
      server_pubkey: getServerNpub(),
      external_relays: getPoolStatus(),
    },
    uptime_seconds: Math.floor(process.uptime()),
  });
});
