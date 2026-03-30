import type { Context, Next } from "hono";
import { isValidToken, validateTrustToken } from "../store/sqlite.js";

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const sessionId = c.req.param("session_id");

  if (!sessionId) {
    return c.json({ error: "Missing session_id" }, 400);
  }

  // Check standard session tokens (creator or participant)
  if (isValidToken(token, sessionId)) {
    c.set("token", token);
    await next();
    return;
  }

  // Capability Lattice: also accept trust tokens for trusted agents.
  // A trust token grants a Level 2 agent access to the session's
  // relay endpoints (send, poll, stream). The trust token is scoped
  // to a specific session and carries the agent's capabilities.
  const trustInfo = validateTrustToken(token);
  if (trustInfo && trustInfo.session_id === sessionId) {
    c.set("token", token);
    c.set("trust_info", trustInfo);
    await next();
    return;
  }

  return c.json({ error: "Invalid token for this session" }, 403);
}
