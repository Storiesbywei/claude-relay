/**
 * Bridge between Solid Pod resources and the HTTP relay session store.
 *
 * When a Solid Pod notification arrives (via webhook or polling), this
 * module converts the resource into a StoredMessage and injects it into
 * the appropriate session — subject to per-origin rate limiting.
 */

import type { StoredMessage } from "@claude-relay/shared";
import { checkBridgeRateLimit } from "../middleware/rate-limit.js";

/**
 * Bridge a Solid Pod resource into the HTTP session store.
 *
 * Checks the per-origin (solid) rate limit before injecting.  If the
 * token's solid bucket is exhausted, the message is logged and dropped.
 *
 * @param resource  - Parsed resource content from the Solid Pod
 * @param token     - Auth token of the session that will receive the message
 * @param sessionId - Target session ID
 * @param addMsg    - Callback to insert into the session store (avoids circular dep)
 * @returns `true` if the message was accepted, `false` if rate-limited
 */
export function bridgeSolidToHttp(
  resource: SolidResource,
  token: string,
  sessionId: string,
  addMsg: (sessionId: string, message: StoredMessage) => void,
): boolean {
  if (!checkBridgeRateLimit(token, "solid")) {
    console.warn(
      `[solid-bridge] Rate limited — dropping resource "${resource.uri.slice(0, 40)}" for token ${token.slice(0, 8)}…`
    );
    return false;
  }

  const message: StoredMessage = {
    message_id: crypto.randomUUID(),
    sequence: 0, // Assigned by the session store
    type: resource.type ?? "context",
    title: resource.title ?? "",
    content: resource.content,
    tags: resource.tags,
    sender_name: `solid:${resource.webId?.slice(0, 20) ?? "unknown"}`,
    sent_at: new Date().toISOString(),
  };

  addMsg(sessionId, message);
  return true;
}

// ---- Types ----

export interface SolidResource {
  /** The URI of the Solid resource */
  uri: string;
  /** The WebID of the resource owner */
  webId?: string;
  /** Mapped message type (defaults to "context") */
  type?: string;
  /** Resource title / label */
  title?: string;
  /** Resource content body */
  content: string;
  /** Optional tags for filtering */
  tags?: string[];
}
