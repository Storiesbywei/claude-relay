import { Hono } from "hono";
import { getSessionCount } from "../store/sqlite.js";
import { getNostrStats } from "../nostr/handler.js";
<<<<<<< HEAD
import { getServerNpub } from "../nostr/bridge.js";
import { getPoolStatus } from "../nostr/relay-pool.js";
=======
import { syncEngine, getEnabledSessionCount, getQueueDepth } from "../solid/index.js";
>>>>>>> worktree-agent-a89c3f44

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  const solidStats = syncEngine.getStats();
  return c.json({
    status: "ok",
    version: "0.3.0",
    sessions: getSessionCount(),
<<<<<<< HEAD
    nostr: {
      ...getNostrStats(),
      server_pubkey: getServerNpub(),
      external_relays: getPoolStatus(),
=======
    nostr: getNostrStats(),
    solid: {
      sync_engine: solidStats.running ? "running" : "stopped",
      queue_depth: getQueueDepth(),
      enabled_sessions: getEnabledSessionCount(),
>>>>>>> worktree-agent-a89c3f44
    },
    uptime_seconds: Math.floor(process.uptime()),
  });
});
