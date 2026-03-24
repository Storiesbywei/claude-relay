import type { Context, Next } from "hono";
import { isValidToken } from "../store/memory.js";

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

  if (!isValidToken(token, sessionId)) {
    return c.json({ error: "Invalid token for this session" }, 403);
  }

  // Store token on context for downstream use
  c.set("token", token);
  await next();
}
