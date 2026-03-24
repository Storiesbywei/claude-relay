import type { Context, Next } from "hono";
import { LIMITS } from "@claude-relay/shared";

// Simple sliding window rate limiter: token → timestamps[]
const windows = new Map<string, number[]>();

export async function rateLimitMiddleware(c: Context, next: Next) {
  const token = c.get("token") as string | undefined;
  const key = token || c.req.header("x-forwarded-for") || "anonymous";
  const now = Date.now();
  const windowMs = 60_000;

  let timestamps = windows.get(key) || [];
  // Remove timestamps outside the window
  timestamps = timestamps.filter((t) => now - t < windowMs);

  if (timestamps.length >= LIMITS.RATE_LIMIT_PER_MINUTE) {
    return c.json(
      {
        error: "Rate limit exceeded",
        retry_after_seconds: Math.ceil(
          (timestamps[0] + windowMs - now) / 1000
        ),
      },
      429
    );
  }

  timestamps.push(now);
  windows.set(key, timestamps);
  await next();
}
