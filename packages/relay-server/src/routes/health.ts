import { Hono } from "hono";
import { getSessionCount } from "../store/sqlite.js";
import { getNostrStats } from "../nostr/handler.js";
import { getServerNpub } from "../nostr/bridge.js";
import { getPoolStatus } from "../nostr/relay-pool.js";
import { getRateLimitStats } from "../middleware/rate-limit.js";
import { syncEngine } from "../solid/sync-engine.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  const solidStats = syncEngine.getStats();
  return c.json({
    status: "ok",
    version: "0.3.0",
    sessions: getSessionCount(),
    nostr: {
      ...getNostrStats(),
      server_pubkey: getServerNpub(),
      external_relays: getPoolStatus(),
    },
    solid: {
      sync_engine: solidStats.running ? "running" : "stopped",
      queue_depth: solidStats.queueDepth,
    },
    rate_limits: getRateLimitStats(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});
