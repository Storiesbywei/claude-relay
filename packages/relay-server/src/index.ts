import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/sessions.js";
import { relayRoutes } from "./routes/relay.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { sweepExpiredSessions } from "./store/memory.js";
import { RELAY_PORT, LIMITS, RELAY_INFO } from "@claude-relay/shared";
import { handleOpen, handleClose, handleMessage, getNostrStats, setCanonicalRelayUrl } from "./nostr/handler.js";

const app = new Hono();

// CORS — allow same-origin + configured origins (ngrok, etc.)
const allowedOrigins = [
  `http://localhost:${RELAY_PORT}`,
  `http://127.0.0.1:${RELAY_PORT}`,
  `http://0.0.0.0:${RELAY_PORT}`,
  `http://100.99.9.76:${RELAY_PORT}`,
  `http://100.71.141.45:${RELAY_PORT}`,
];
if (process.env.RELAY_ORIGIN) {
  allowedOrigins.push(process.env.RELAY_ORIGIN);
}
app.use("*", cors({
  origin: (origin) => {
    // Allow requests with no origin (MCP tools, curl, same-origin)
    if (!origin) return `http://localhost:${RELAY_PORT}`;
    // Allow ngrok and configured origins
    if (allowedOrigins.includes(origin) || origin.endsWith(".ngrok-free.app") || origin.endsWith(".ngrok.io")) {
      return origin;
    }
    return `http://localhost:${RELAY_PORT}`;
  },
}));

// NIP-11: Relay information document
// When Accept: application/nostr+json, return relay info instead of dashboard
app.get("/", async (c, next) => {
  const accept = c.req.header("Accept") || "";
  if (accept.includes("application/nostr+json")) {
    return c.json(RELAY_INFO, 200, {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
    });
  }
  await next();
});

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
const publicDir = resolve(__dirname, "../public");
app.use("/*", async (c, next) => {
  const path = c.req.path === "/" ? "/index.html" : c.req.path;
  const resolvedPath = resolve(publicDir, "." + path);
  if (!resolvedPath.startsWith(publicDir)) {
    return c.text("Forbidden", 403);
  }
  const file = Bun.file(resolvedPath);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "Content-Type": file.type },
    });
  }
  await next();
});

// TTL sweep
const sweepInterval = setInterval(() => {
  const swept = sweepExpiredSessions();
  if (swept > 0) {
    console.log(`[sweep] Removed ${swept} expired session(s)`);
  }
}, LIMITS.TTL_SWEEP_INTERVAL_MS);

// Graceful shutdown
const shutdown = () => {
  clearInterval(sweepInterval);
  console.log("\n[relay] Shutting down...");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const port = Number(process.env.RELAY_PORT || RELAY_PORT);

// Set canonical relay URL for NIP-42 validation
const canonicalWsUrl = `ws://localhost:${port}`;
setCanonicalRelayUrl(canonicalWsUrl);

console.log(`[relay] Claude Relay server starting on http://0.0.0.0:${port}`);
console.log(`[relay] Nostr WebSocket relay available at ${canonicalWsUrl}`);

export default {
  port,
  hostname: "0.0.0.0",
  fetch(req: Request, server: any): Response | Promise<Response> {
    // Upgrade WebSocket connections for Nostr protocol
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const success = server.upgrade(req);
      if (success) return undefined as any; // Bun handles the response
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(req, server);
  },
  websocket: {
    maxPayloadLength: LIMITS.MAX_MESSAGE_SIZE, // 100KB max per WS message
    open(ws: any) {
      handleOpen(ws);
      console.log(`[nostr] WebSocket connected (${getNostrStats().connections} total)`);
    },
    close(ws: any) {
      handleClose(ws);
      console.log(`[nostr] WebSocket disconnected (${getNostrStats().connections} total)`);
    },
    message(ws: any, data: string | Buffer) {
      handleMessage(ws, data);
    },
  },
};
