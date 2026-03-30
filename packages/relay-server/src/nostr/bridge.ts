/**
 * Bridge between existing HTTP relay (sessions + messages) and Nostr events.
 *
 * Bidirectional:
 * - HTTP POST /relay/:id → creates a Nostr event and broadcasts to WS subscribers
 * - Nostr EVENT (kind 4190-4204) → stored and available via HTTP GET /relay/:id
 *
 * This allows the existing MCP tools and dashboard to work alongside
 * native Nostr clients during the migration period.
 */

import type { StoredMessage, NostrEvent, UnsignedEvent } from "@claude-relay/shared";
import {
  NOSTR_EVENT_KINDS,
  ALL_RELAY_KINDS,
  SESSION_TAG,
  generateKeypair,
  signEvent,
  eventToMessage,
} from "@claude-relay/shared";
import { eventStore } from "./event-store.js";
import { getSessionByPubkey, addMessage, getSession, hasMessageWithEventId } from "../store/memory.js";
import { publishToExternal } from "./relay-pool.js";

// Lazy import to avoid circular dependency — set by handler.ts init
let _broadcastEvent: ((event: NostrEvent) => void) | null = null;

/** Register the broadcast function (called from handler init) */
export function setBroadcastFn(fn: (event: NostrEvent) => void): void {
  _broadcastEvent = fn;
}

// Server keypair — used to sign events created via HTTP API (bridge events)
const serverKeypair = generateKeypair();

console.log(`[nostr] Bridge server pubkey: ${serverKeypair.npub}`);

/** Convert a StoredMessage (from HTTP API) to a signed Nostr event */
export function messageToEvent(msg: StoredMessage, sessionId?: string): NostrEvent {
  const kind = NOSTR_EVENT_KINDS[msg.type as keyof typeof NOSTR_EVENT_KINDS];
  if (!kind) {
    // Fallback to "context" kind for unknown types
    return messageToEvent({ ...msg, type: "context" });
  }

  const tags: string[][] = [];

  // Title tag
  if (msg.title) {
    tags.push(["title", msg.title]);
  }

  // Message type as tag (for filtering)
  tags.push(["t", msg.type]);

  // Sender name
  if (msg.sender_name) {
    tags.push(["sender", msg.sender_name]);
  }

  // Searchable tags
  if (msg.tags) {
    for (const tag of msg.tags) {
      tags.push(["t", tag]);
    }
  }

  // File references
  if (msg.references) {
    for (const ref of msg.references) {
      const refTag = ["r", ref.file];
      if (ref.lines) refTag.push(ref.lines);
      if (ref.note) refTag.push(ref.note);
      tags.push(refTag);
    }
  }

  // Context tags
  if (msg.context) {
    if (msg.context.project) tags.push(["project", msg.context.project]);
    if (msg.context.stack) tags.push(["stack", msg.context.stack]);
    if (msg.context.branch) tags.push(["branch", msg.context.branch]);
  }

  // Session scoping tag
  if (sessionId) {
    tags.push([SESSION_TAG, sessionId]);
  }

  // Bridge marker — identifies events created via HTTP, not native Nostr
  tags.push(["bridge", "http"]);

  // Original message ID for cross-reference
  if (msg.message_id) {
    tags.push(["message_id", msg.message_id]);
  }

  const template: UnsignedEvent = {
    pubkey: serverKeypair.publicKey,
    created_at: msg.sent_at
      ? Math.floor(new Date(msg.sent_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
    kind,
    tags,
    content: msg.content,
  };

  return signEvent(template, serverKeypair.privateKey);
}

/**
 * Publish a StoredMessage (from HTTP API) to the Nostr event store
 * and broadcast to WebSocket subscribers.
 */
export function bridgeMessageToNostr(msg: StoredMessage, sessionId?: string): NostrEvent {
  const event = messageToEvent(msg, sessionId);
  eventStore.store(event);
  // Broadcast to all WS subscribers
  if (_broadcastEvent) {
    _broadcastEvent(event);
  }
  // Forward to external relays
  publishToExternal(event);
  return event;
}

/** Check if a Nostr event kind is a Claude Relay message */
export function isRelayEventKind(kind: number): boolean {
  return ALL_RELAY_KINDS.includes(kind as any);
}

/** Get the server's public key (for identifying bridge-created events) */
export function getServerPubkey(): string {
  return serverKeypair.publicKey;
}

/** Get the server's npub (for display) */
export function getServerNpub(): string {
  return serverKeypair.npub;
}

/** Get the server's keypair (for relay pool signing) */
export function getServerKeypair() {
  return serverKeypair;
}

/**
 * Bridge a Nostr event (from WebSocket) into an HTTP session.
 * Returns true if the event was injected, false if no matching session found.
 */
export function bridgeNostrToHttp(event: NostrEvent): boolean {
  // Skip events we created (bridge marker) to avoid loops
  if (event.tags.some((t) => t[0] === "bridge" && t[1] === "http")) {
    return false;
  }

  // Determine target session: try pubkey binding first, then session tag
  let targetSessionId: string | undefined;

  const binding = getSessionByPubkey(event.pubkey);
  if (binding) {
    targetSessionId = binding.session.id;
  }

  if (!targetSessionId) {
    const sessionTag = event.tags.find((t) => t[0] === SESSION_TAG);
    if (sessionTag?.[1]) {
      const session = getSession(sessionTag[1]);
      if (session) {
        targetSessionId = session.id;
      }
    }
  }

  if (!targetSessionId) return false;

  // Dedup: skip if this event was already injected
  if (hasMessageWithEventId(targetSessionId, event.id)) {
    return false;
  }

  const msg = eventToMessage(event);
  msg.nostr_event_id = event.id;

  try {
    addMessage(targetSessionId, msg);
    return true;
  } catch {
    // Session full or expired
    return false;
  }
}
