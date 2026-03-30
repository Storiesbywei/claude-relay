import { Hono } from "hono";
import { getSessionCount } from "../store/memory.js";
import { getNostrStats } from "../nostr/handler.js";
import { syncEngine, getEnabledSessionCount, getQueueDepth } from "../solid/index.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  const solidStats = syncEngine.getStats();
  return c.json({
    status: "ok",
    version: "0.2.0",
    sessions: getSessionCount(),
    nostr: getNostrStats(),
    solid: {
      sync_engine: solidStats.running ? "running" : "stopped",
      queue_depth: getQueueDepth(),
      enabled_sessions: getEnabledSessionCount(),
    },
    uptime_seconds: Math.floor(process.uptime()),
  });
});
