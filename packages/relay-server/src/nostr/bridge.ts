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
  KIND_TO_MESSAGE_TYPE,
  ALL_RELAY_KINDS,
  generateKeypair,
  signEvent,
} from "@claude-relay/shared";
import { eventStore } from "./event-store.js";

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
export function messageToEvent(msg: StoredMessage): NostrEvent {
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

/** Convert a Nostr event (from WebSocket) to a StoredMessage */
export function eventToMessage(event: NostrEvent): StoredMessage {
  const type = KIND_TO_MESSAGE_TYPE[event.kind] ?? "context";

  const titleTag = event.tags.find((t) => t[0] === "title");
  const senderTag = event.tags.find((t) => t[0] === "sender");

  // FIX: Extract searchable tags — only "t" tags, excluding the message type value
  const tags = event.tags
    .filter((t) => t[0] === "t")
    .map((t) => t[1])
    // Remove the message type itself from tags
    .filter((t) => t !== type);

  // Extract file references
  const references = event.tags
    .filter((t) => t[0] === "r")
    .map((t) => ({
      file: t[1],
      lines: t[2] || undefined,
      note: t[3] || undefined,
    }));

  // Extract context
  const projectTag = event.tags.find((t) => t[0] === "project");
  const stackTag = event.tags.find((t) => t[0] === "stack");
  const branchTag = event.tags.find((t) => t[0] === "branch");
  const context =
    projectTag || stackTag || branchTag
      ? {
          project: projectTag?.[1],
          stack: stackTag?.[1],
          branch: branchTag?.[1],
        }
      : undefined;

  return {
    message_id: event.id,
    sequence: 0, // Will be assigned by the session store
    type,
    title: titleTag?.[1] ?? "",
    content: event.content,
    tags: tags.length > 0 ? tags : undefined,
    references: references.length > 0 ? references : undefined,
    context,
    sender_name: senderTag?.[1] ?? `nostr:${event.pubkey.slice(0, 8)}`,
    sent_at: new Date(event.created_at * 1000).toISOString(),
  };
}

/**
 * Publish a StoredMessage (from HTTP API) to the Nostr event store
 * and broadcast to WebSocket subscribers.
 */
export function bridgeMessageToNostr(msg: StoredMessage): NostrEvent {
  const event = messageToEvent(msg);
  eventStore.store(event);
  // Broadcast to all WS subscribers
  if (_broadcastEvent) {
    _broadcastEvent(event);
  }
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
