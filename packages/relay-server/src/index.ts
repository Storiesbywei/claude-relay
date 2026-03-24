import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/sessions.js";
import { relayRoutes } from "./routes/relay.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { sweepExpiredSessions } from "./store/memory.js";
import { RELAY_PORT, LIMITS } from "@claude-relay/shared";

const app = new Hono();

// Global middleware
app.use("*", cors());

// Public routes
app.route("/health", healthRoutes);

// Session management (auth handled per-route)
app.route("/sessions", sessionRoutes);

// Relay routes (all require auth + rate limiting)
app.use("/relay/:session_id/stream", authMiddleware);
app.use("/relay/:session_id/*", authMiddleware);
app.use("/relay/:session_id/*", rateLimitMiddleware);
app.use("/relay/:session_id", authMiddleware);
app.use("/relay/:session_id", rateLimitMiddleware);
app.route("/relay", relayRoutes);

// Dashboard (static files)
app.use("/*", serveStatic({ root: "./packages/relay-server/public" }));

// TTL sweep
const sweepInterval = setInterval(() => {
  const swept = sweepExpiredSessions();
  if (swept > 0) {
    console.log(`[sweep] Removed ${swept} expired session(s)`);
  }
}, LIMITS.TTL_SWEEP_INTERVAL_MS);

// Graceful shutdown
process.on("SIGINT", () => {
  clearInterval(sweepInterval);
  console.log("\n[relay] Shutting down...");
  process.exit(0);
});

const port = Number(process.env.RELAY_PORT || RELAY_PORT);

console.log(`[relay] Claude Relay server starting on http://0.0.0.0:${port}`);

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
