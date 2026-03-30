/**
 * Subscribes to Solid Pod containers for real-time change notifications.
 *
 * PoC implementation uses polling (GET with ETag/If-None-Match) rather than
 * full Solid Notifications Protocol WebSocket channels. Polling runs every
 * 5 seconds per subscription.
 *
 * Parallels nostr/relay-pool.ts in structure and lifecycle:
 * - subscribe: start watching a container
 * - unsubscribe: stop watching
 * - getStatus: inspect all active subscriptions
 * - shutdown: clean up everything
 */

import type { SolidExportConfig } from "@claude-relay/shared";
import { bridgeSolidToHttp } from "./bridge.js";
import { getAuthenticatedSession } from "./auth.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000; // 5 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriptionStatus = "active" | "polling" | "error" | "stopped";

interface PodSubscription {
  sessionId: string;
  containerUrl: string;
  config: SolidExportConfig;
  status: SubscriptionStatus;
  timer: ReturnType<typeof setInterval> | null;
  etag: string | null;
  /** Track resource URLs we have already seen to detect new ones */
  knownResources: Set<string>;
  pollCount: number;
  lastPollAt: string | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// PodNotificationPool
// ---------------------------------------------------------------------------

export class PodNotificationPool {
  private subscriptions = new Map<string, PodSubscription>();

  /**
   * Subscribe to a session's message container on a Pod.
   * Starts polling for new resources immediately.
   */
  subscribe(sessionId: string, containerUrl: string, config: SolidExportConfig): void {
    // Don't double-subscribe
    if (this.subscriptions.has(sessionId)) {
      console.log(`[solid notifications] Already subscribed to session ${sessionId}`);
      return;
    }

    const sub: PodSubscription = {
      sessionId,
      containerUrl: containerUrl.endsWith("/") ? containerUrl : containerUrl + "/",
      config,
      status: "active",
      timer: null,
      etag: null,
      knownResources: new Set(),
      pollCount: 0,
      lastPollAt: null,
      lastError: null,
    };

    this.subscriptions.set(sessionId, sub);

    // Do an initial poll to seed known resources (so we don't re-ingest old messages)
    this.seedKnownResources(sub).then(() => {
      // Start periodic polling after seeding
      sub.timer = setInterval(() => {
        this.pollContainer(sub);
      }, POLL_INTERVAL_MS);

      console.log(`[solid notifications] Subscribed to ${containerUrl} for session ${sessionId}`);
    }).catch((err) => {
      sub.status = "error";
      sub.lastError = err.message;
      console.error(`[solid notifications] Failed to seed ${containerUrl}: ${err.message}`);

      // Start polling anyway — the container might not exist yet
      sub.timer = setInterval(() => {
        this.pollContainer(sub);
      }, POLL_INTERVAL_MS);
    });
  }

  /**
   * Unsubscribe from a session's container.
   */
  unsubscribe(sessionId: string): void {
    const sub = this.subscriptions.get(sessionId);
    if (!sub) return;

    if (sub.timer) {
      clearInterval(sub.timer);
      sub.timer = null;
    }
    sub.status = "stopped";
    this.subscriptions.delete(sessionId);
    console.log(`[solid notifications] Unsubscribed from session ${sessionId}`);
  }

  /**
   * Get status of all subscriptions.
   */
  getStatus(): { sessionId: string; containerUrl: string; status: string; pollCount: number; lastPollAt: string | null }[] {
    return Array.from(this.subscriptions.values()).map((sub) => ({
      sessionId: sub.sessionId,
      containerUrl: sub.containerUrl,
      status: sub.status,
      pollCount: sub.pollCount,
      lastPollAt: sub.lastPollAt,
    }));
  }

  /**
   * Shutdown all connections.
   */
  shutdown(): void {
    for (const [sessionId, sub] of this.subscriptions) {
      if (sub.timer) {
        clearInterval(sub.timer);
        sub.timer = null;
      }
      sub.status = "stopped";
    }
    this.subscriptions.clear();
    console.log(`[solid notifications] All subscriptions shut down`);
  }

  // -------------------------------------------------------------------------
  // Internal: Polling logic
  // -------------------------------------------------------------------------

  /**
   * Initial fetch of the container to populate knownResources.
   * This prevents re-ingesting all existing messages when we start watching.
   */
  private async seedKnownResources(sub: PodSubscription): Promise<void> {
    const resources = await this.listContainerResources(sub);
    for (const url of resources) {
      sub.knownResources.add(url);
    }
    console.log(`[solid notifications] Seeded ${resources.length} known resources for session ${sub.sessionId}`);
  }

  /**
   * Poll a container for new resources.
   */
  private async pollContainer(sub: PodSubscription): Promise<void> {
    if (sub.status === "stopped") return;

    sub.status = "polling";
    sub.pollCount++;
    sub.lastPollAt = new Date().toISOString();

    try {
      const resources = await this.listContainerResources(sub);

      // Find new resources (not in knownResources set)
      const newResources = resources.filter((url) => !sub.knownResources.has(url));

      if (newResources.length > 0) {
        console.log(`[solid notifications] Found ${newResources.length} new resource(s) in session ${sub.sessionId}`);

        for (const resourceUrl of newResources) {
          sub.knownResources.add(resourceUrl);

          // Bridge each new resource into the HTTP session (async, non-blocking per resource)
          bridgeSolidToHttp(resourceUrl, sub.sessionId).catch((err) => {
            console.error(`[solid notifications] Failed to bridge ${resourceUrl}: ${err.message}`);
          });
        }
      }

      sub.status = "active";
      sub.lastError = null;
    } catch (err: any) {
      sub.status = "error";
      sub.lastError = err.message;
      // Don't log every poll failure — only if it's a new error
      if (sub.pollCount % 12 === 1) {
        console.error(`[solid notifications] Poll error for session ${sub.sessionId}: ${err.message}`);
      }
    }
  }

  /**
   * List resource URLs in a Solid container.
   *
   * Uses a GET on the container with Accept: application/ld+json, then
   * extracts contained resource URLs from the response. Falls back to
   * parsing the ldp:contains predicate from the container representation.
   */
  private async listContainerResources(sub: PodSubscription): Promise<string[]> {
    const authSession = await getAuthenticatedSession(sub.config);
    const fetchFn = authSession.fetch.bind(authSession);

    const headers: Record<string, string> = {
      "Accept": "application/ld+json",
    };

    // Use ETag for conditional request (304 Not Modified = no changes)
    if (sub.etag) {
      headers["If-None-Match"] = sub.etag;
    }

    const response = await fetchFn(sub.containerUrl, { headers });

    // 304 Not Modified — no changes since last poll
    if (response.status === 304) {
      return Array.from(sub.knownResources);
    }

    // 404 — container doesn't exist yet (might be created later)
    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new Error(`GET ${sub.containerUrl} returned ${response.status}`);
    }

    // Store ETag for next conditional request
    const etag = response.headers.get("ETag");
    if (etag) {
      sub.etag = etag;
    }

    // Parse the container representation to extract resource URLs
    const body = await response.json();
    return extractContainedResources(body, sub.containerUrl);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract contained resource URLs from a Solid container's JSON-LD representation.
 *
 * Handles both:
 * - ldp:contains predicate (standard LDP)
 * - @graph with @id references
 */
function extractContainedResources(
  jsonLd: Record<string, unknown>,
  containerUrl: string
): string[] {
  const resources: string[] = [];

  // Method 1: ldp:contains (most common for CSS)
  const contains =
    jsonLd["ldp:contains"] ??
    jsonLd["http://www.w3.org/ns/ldp#contains"];

  if (Array.isArray(contains)) {
    for (const item of contains) {
      if (typeof item === "string") {
        resources.push(resolveUrl(item, containerUrl));
      } else if (item && typeof item === "object" && "@id" in item) {
        resources.push(resolveUrl(item["@id"] as string, containerUrl));
      }
    }
  } else if (contains && typeof contains === "object" && "@id" in (contains as any)) {
    resources.push(resolveUrl((contains as any)["@id"], containerUrl));
  }

  // Method 2: @graph array
  if (Array.isArray(jsonLd["@graph"])) {
    for (const node of jsonLd["@graph"] as Record<string, unknown>[]) {
      const nodeContains =
        node["ldp:contains"] ??
        node["http://www.w3.org/ns/ldp#contains"];

      if (Array.isArray(nodeContains)) {
        for (const item of nodeContains) {
          if (typeof item === "string") {
            resources.push(resolveUrl(item, containerUrl));
          } else if (item && typeof item === "object" && "@id" in item) {
            resources.push(resolveUrl(item["@id"] as string, containerUrl));
          }
        }
      }
    }
  }

  // Filter out the container URL itself and sub-containers (ending with /)
  return resources.filter(
    (url) => url !== containerUrl && !url.endsWith("/")
  );
}

/**
 * Resolve a possibly relative URL against a base URL.
 */
function resolveUrl(url: string, base: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return new URL(url, base).href;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const notificationPool = new PodNotificationPool();
