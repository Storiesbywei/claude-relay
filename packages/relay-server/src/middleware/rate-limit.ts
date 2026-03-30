import type { Context, Next } from "hono";
import { LIMITS } from "@claude-relay/shared";

/**
 * Per-origin rate limiting.
 *
 * Each (token, origin) pair gets its own sliding-window bucket with
 * origin-specific caps.  A global per-token cap (600/min) prevents any
 * combination of origins from exceeding the overall budget.
 *
 * Origin types:
 *   http  — direct HTTP API requests        (600/min)
 *   nostr — events bridged from Nostr WS     (200/min)
 *   solid — resources ingested from Solid Pod (100/min)
 */

// ---- Per-origin limits ----

export const ORIGIN_LIMITS: Record<string, number> = {
  http: LIMITS.RATE_LIMIT_PER_MINUTE,    // 600
  nostr: 200,                              // Bridged events
  solid: 100,                              // Pod-ingested resources
  default: LIMITS.RATE_LIMIT_PER_MINUTE,
};

const GLOBAL_LIMIT = LIMITS.RATE_LIMIT_PER_MINUTE; // 600
const WINDOW_MS = 60_000;

// Composite key  `${token}:${origin}` → timestamps[]
const windows = new Map<string, number[]>();

/** Resolve the per-origin ceiling for the given origin string. */
function originLimit(origin: string): number {
  return ORIGIN_LIMITS[origin] ?? ORIGIN_LIMITS.default;
}

/**
 * Prune timestamps older than the sliding window and return the remainder.
 */
function pruneWindow(key: string, now: number): number[] {
  let ts = windows.get(key) || [];
  ts = ts.filter((t) => now - t < WINDOW_MS);
  windows.set(key, ts);
  return ts;
}

/**
 * Count total requests across all origins for a given token within the
 * current window.
 */
function globalCount(token: string, now: number): number {
  let total = 0;
  for (const [key, timestamps] of windows) {
    if (key === token || key.startsWith(`${token}:`)) {
      total += timestamps.filter((t) => now - t < WINDOW_MS).length;
    }
  }
  return total;
}

// ---- Hono middleware (HTTP origin) ----

export async function rateLimitMiddleware(c: Context, next: Next) {
  const token = c.get("token") as string | undefined;
  const baseKey = token || c.req.header("x-forwarded-for") || "anonymous";
  const origin = "http";
  const compositeKey = `${baseKey}:${origin}`;
  const now = Date.now();

  // 1. Per-origin check
  const timestamps = pruneWindow(compositeKey, now);
  if (timestamps.length >= originLimit(origin)) {
    return c.json(
      {
        error: "Rate limit exceeded",
        origin,
        retry_after_seconds: Math.ceil(
          (timestamps[0] + WINDOW_MS - now) / 1000
        ),
      },
      429
    );
  }

  // 2. Global per-token check
  if (globalCount(baseKey, now) >= GLOBAL_LIMIT) {
    return c.json(
      {
        error: "Global rate limit exceeded",
        retry_after_seconds: 1,
      },
      429
    );
  }

  timestamps.push(now);
  windows.set(compositeKey, timestamps);
  await next();
}

// ---- Bridge rate-limit check (called by Nostr / Solid bridges) ----

/**
 * Check whether a bridge-originated message is within rate limits.
 * Returns `true` if the message is allowed, `false` if it should be dropped.
 *
 * If allowed, the timestamp is recorded (consuming one unit of quota).
 */
export function checkBridgeRateLimit(
  token: string,
  origin: "nostr" | "solid"
): boolean {
  const compositeKey = `${token}:${origin}`;
  const now = Date.now();

  // Per-origin check
  const timestamps = pruneWindow(compositeKey, now);
  if (timestamps.length >= originLimit(origin)) {
    return false;
  }

  // Global per-token check
  if (globalCount(token, now) >= GLOBAL_LIMIT) {
    return false;
  }

  timestamps.push(now);
  windows.set(compositeKey, timestamps);
  return true;
}

// ---- Stats (for /health endpoint) ----

export interface RateLimitBucketStats {
  key: string;
  origin: string;
  current: number;
  limit: number;
}

export interface RateLimitStats {
  buckets: RateLimitBucketStats[];
  total_tracked_keys: number;
}

/**
 * Snapshot of current rate-limit state for diagnostics.
 * Exposed via the /health endpoint.
 */
export function getRateLimitStats(): RateLimitStats {
  const now = Date.now();
  const buckets: RateLimitBucketStats[] = [];

  for (const [key, timestamps] of windows) {
    const active = timestamps.filter((t) => now - t < WINDOW_MS);
    if (active.length === 0) continue;

    // Extract origin from composite key (token:origin)
    const lastColon = key.lastIndexOf(":");
    const origin = lastColon !== -1 ? key.slice(lastColon + 1) : "http";

    buckets.push({
      key: key.slice(0, 8) + "...", // truncate token for security
      origin,
      current: active.length,
      limit: originLimit(origin),
    });
  }

  return {
    buckets,
    total_tracked_keys: windows.size,
  };
}
