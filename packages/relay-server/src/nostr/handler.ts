import type { ServerWebSocket } from "bun";
import type {
  NostrEvent,
  NostrFilter,
} from "@claude-relay/shared";
import { verifySignedEvent, validateAuthEvent, RELAY_INFO, LIMITS } from "@claude-relay/shared";
import { eventStore } from "./event-store.js";
import { SubscriptionManager, matchesSubscription, validateFilter } from "./subscriptions.js";
import { isRelayEventKind, eventToMessage, setBroadcastFn, getServerKeypair, bridgeNostrToHttp } from "./bridge.js";
import { isGiftWrap, isAddressedTo, unwrapGiftWrap, GIFT_WRAP_KIND } from "./nip44.js";
import { getSessionByPubkey, getSessionMode } from "../store/sqlite.js";

// ---- Configuration ----

const MAX_WS_CONNECTIONS = 100;
const MAX_WS_MESSAGE_SIZE = LIMITS.MAX_MESSAGE_SIZE; // 100KB
const WS_RATE_LIMIT_PER_SECOND = 10; // max messages per second per connection

/** Server's canonical relay URL — used for NIP-42 validation */
let _canonicalRelayUrl = "ws://localhost:4190";

/** Set the server's canonical WebSocket URL (called from index.ts) */
export function setCanonicalRelayUrl(url: string): void {
  _canonicalRelayUrl = url;
}

// ---- Per-connection state ----

interface ConnectionState {
  authedPubkey: string | null;
  challenge: string;
  challengeUsed: boolean; // FIX: prevent challenge replay
  subscriptions: SubscriptionManager;
  // Rate limiting
  msgCount: number;
  msgWindowStart: number; // timestamp ms
  // Ping/pong heartbeat (Sprint 2: detect dead connections)
  pingInterval: ReturnType<typeof setInterval> | null;
  lastPongAt: number;
}

// All active WebSocket connections and their state
const connections = new Map<ServerWebSocket<any>, ConnectionState>();

// Callback for bridging Nostr events to HTTP session store
type EventCallback = (event: NostrEvent) => void;
let onRelayEvent: EventCallback | null = null;

/** Register a callback for when relay-kind events arrive via WebSocket */
export function onNostrRelayEvent(cb: EventCallback): void {
  onRelayEvent = cb;
}

function send(ws: ServerWebSocket<any>, msg: RelayMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection already closed
  }
}

// ---- Rate limiting ----

/** Check and enforce per-connection rate limit. Returns true if allowed. */
function checkRateLimit(state: ConnectionState): boolean {
  const now = Date.now();
  if (now - state.msgWindowStart > 1000) {
    // New window
    state.msgCount = 1;
    state.msgWindowStart = now;
    return true;
  }
  state.msgCount++;
  return state.msgCount <= WS_RATE_LIMIT_PER_SECOND;
}

// ---- Connection lifecycle ----

/** Called when a new WebSocket connects */
export function handleOpen(ws: ServerWebSocket<any>): void {
  // FIX: Connection limit
  if (connections.size >= MAX_WS_CONNECTIONS) {
    send(ws, ["NOTICE", "error: too many connections"]);
    ws.close();
    return;
  }

  const challenge = crypto.randomUUID();
  const state: ConnectionState = {
    authedPubkey: null,
    challenge,
    challengeUsed: false,
    subscriptions: new SubscriptionManager(),
    msgCount: 0,
    msgWindowStart: Date.now(),
    pingInterval: null,
    lastPongAt: Date.now(),
  };
  connections.set(ws, state);

  // Sprint 2: Ping/pong heartbeat -- detect dead connections
  state.pingInterval = setInterval(() => {
    if (Date.now() - state.lastPongAt > 40_000) {
      // No pong in 40s (missed at least one ping cycle) -- close dead connection
      ws.close();
      return;
    }
    try {
      ws.ping();
    } catch {
      // Connection already dead
      ws.close();
    }
  }, 30_000);

  // Send NIP-42 AUTH challenge
  send(ws, ["AUTH", challenge]);
}

/** Called when a WebSocket disconnects */
export function handleClose(ws: ServerWebSocket<any>): void {
  const state = connections.get(ws);
  if (state) {
    // Sprint 2: Clean up ping interval
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }
    state.subscriptions.clear();
  }
  connections.delete(ws);
}

/** Called when a pong is received from a WebSocket client (Sprint 2: heartbeat) */
export function handlePong(ws: ServerWebSocket<any>): void {
  const state = connections.get(ws);
  if (state) {
    state.lastPongAt = Date.now();
  }
}

/** Called when a WebSocket message arrives */
export function handleMessage(ws: ServerWebSocket<any>, data: string | Buffer): void {
  const state = connections.get(ws);
  if (!state) return;

  // FIX: Message size check
  const raw = typeof data === "string" ? data : data.toString();
  if (raw.length > MAX_WS_MESSAGE_SIZE) {
    send(ws, ["NOTICE", "error: message too large"]);
    return;
  }

  // FIX: Rate limiting
  if (!checkRateLimit(state)) {
    send(ws, ["NOTICE", "error: rate-limited"]);
    return;
  }

  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, ["NOTICE", "error: invalid JSON"]);
    return;
  }

  if (!Array.isArray(msg) || msg.length < 2) {
    send(ws, ["NOTICE", "error: message must be a JSON array"]);
    return;
  }

  const type = msg[0];

  switch (type) {
    case "EVENT":
      handleEvent(ws, state, msg[1]);
      break;
    case "REQ":
      handleReq(ws, state, msg[1], msg.slice(2));
      break;
    case "CLOSE":
      handleCloseSubscription(ws, state, msg[1]);
      break;
    case "AUTH":
      handleAuth(ws, state, msg[1]);
      break;
    default:
      send(ws, ["NOTICE", `error: unknown message type: ${type}`]);
  }
}

/** Handle EVENT — publish a new event */
function handleEvent(
  ws: ServerWebSocket<any>,
  state: ConnectionState,
  event: NostrEvent
): void {
  // FIX: Input guard — must be a non-null object with id field
  if (!event || typeof event !== "object" || !event.id) {
    send(ws, ["OK", "", false, "invalid: malformed event object"]);
    return;
  }

  // Validate event ID format (64 hex chars)
  if (!/^[0-9a-f]{64}$/.test(event.id)) {
    send(ws, ["OK", event.id || "", false, "invalid: malformed event id"]);
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(event.pubkey)) {
    send(ws, ["OK", event.id, false, "invalid: malformed pubkey"]);
    return;
  }

  // FIX: Enforce auth_required — reject unauthenticated clients
  if (!state.authedPubkey) {
    send(ws, ["OK", event.id, false, "auth-required: please authenticate first"]);
    return;
  }

  // Enforce pubkey must match authenticated identity (supersedes NIP-70 check).
  // Exception: kind 1059 (gift wrap) uses a random one-time keypair per NIP-59,
  // so the outer event's pubkey won't match the sender's authenticated identity.
  if (event.kind !== GIFT_WRAP_KIND && state.authedPubkey !== event.pubkey) {
    send(ws, ["OK", event.id, false, "restricted: event pubkey must match authenticated identity"]);
    return;
  }

  // Verify event signature
  if (!verifySignedEvent(event)) {
    send(ws, ["OK", event.id, false, "invalid: bad signature"]);
    return;
  }

  // Content size check
  if (event.content.length > MAX_WS_MESSAGE_SIZE) {
    send(ws, ["OK", event.id, false, "invalid: content too large"]);
    return;
  }

  // Tag count check
  if (event.tags.length > (RELAY_INFO.limitation.max_event_tags ?? 100)) {
    send(ws, ["OK", event.id, false, "invalid: too many tags"]);
    return;
  }

  // Timestamp bounds: reject events too far in the future or too old.
  // NIP-59 gift wraps randomize created_at within +/- 2 days for metadata
  // protection, so we use a wider window for kind 1059.
  const now = Math.floor(Date.now() / 1000);
  const maxFuture = event.kind === GIFT_WRAP_KIND ? 2 * 24 * 3600 : 900;
  const maxPast = event.kind === GIFT_WRAP_KIND ? 2 * 24 * 3600 : 3600;
  if (event.created_at > now + maxFuture) {
    send(ws, ["OK", event.id, false, "invalid: created_at too far in future"]);
    return;
  }
  if (event.created_at < now - maxPast) {
    send(ws, ["OK", event.id, false, "invalid: created_at too old"]);
    return;
  }

  // Store the event
  const result = eventStore.store(event);

  if (!result.stored && result.reason?.startsWith("duplicate:")) {
    send(ws, ["OK", event.id, true, result.reason]);
    return;
  }

  send(ws, ["OK", event.id, true, ""]);

  // NIP-09: Handle deletion events
  if (event.kind === 5) {
    const idsToDelete = event.tags
      .filter((t) => t[0] === "e")
      .map((t) => t[1]);
    if (idsToDelete.length > 0) {
      const deleted = eventStore.deleteByIds(idsToDelete, event.pubkey);
      if (deleted > 0) {
        console.log(`[nostr] NIP-09: Deleted ${deleted} event(s) by ${event.pubkey.slice(0, 8)}`);
      }
    }
  }

  // Broadcast to all matching subscribers
  broadcastEvent(event);

  // Bridge: if this is a relay event kind, notify the HTTP bridge
  if (isRelayEventKind(event.kind) && onRelayEvent) {
    onRelayEvent(event);
  }

  // NIP-59: Handle gift-wrapped events (kind 1059)
  if (isGiftWrap(event)) {
    handleGiftWrap(event);
  }
}

/**
 * Handle a NIP-59 gift-wrapped event (kind 1059).
 *
 * - If the gift wrap is addressed to the server's pubkey, try to unwrap it.
 * - Check whether the target session is in signal mode:
 *   - Signal mode: do NOT decrypt — the gift wrap was already stored and
 *     broadcast as-is. The relay stays blind to the content.
 *   - Relay mode: decrypt, validate the inner event, and bridge to HTTP
 *     so MCP tools and the dashboard can see the plaintext message.
 */
function handleGiftWrap(event: NostrEvent): void {
  const serverKp = getServerKeypair();

  // Only process gift wraps addressed to the server
  if (!isAddressedTo(event, serverKp.publicKey)) {
    return;
  }

  // Check if the sender's session is in signal mode.
  // In signal mode, we must NOT decrypt — pass through as opaque ciphertext.
  const binding = getSessionByPubkey(event.pubkey);
  if (binding) {
    const mode = getSessionMode(binding.session.id);
    if (mode === "signal") {
      console.log(
        `[nostr] Gift wrap ${event.id.slice(0, 8)} — signal mode, passing through without decryption`
      );
      return;
    }
  }

  // Relay mode: unwrap and bridge the inner event to HTTP
  const inner = unwrapGiftWrap(event, serverKp.privateKey);
  if (!inner) {
    console.warn(
      `[nostr] Gift wrap ${event.id.slice(0, 8)} — failed to unwrap (not addressed to us or corrupted)`
    );
    return;
  }

  console.log(
    `[nostr] Gift wrap ${event.id.slice(0, 8)} unwrapped — inner kind ${inner.kind} from ${inner.pubkey?.slice(0, 8) ?? "unknown"}`
  );

  // Bridge the inner (plaintext) event to the HTTP session store
  if (isRelayEventKind(inner.kind)) {
    const bridged = bridgeNostrToHttp(inner);
    if (bridged) {
      console.log(
        `[nostr] Gift wrap inner event bridged to HTTP session`
      );
    }
  }
}

/** Handle REQ — subscribe to events */
function handleReq(
  ws: ServerWebSocket<any>,
  state: ConnectionState,
  subscriptionId: string,
  filters: NostrFilter[]
): void {
  // FIX: Enforce auth_required for subscriptions too
  if (!state.authedPubkey) {
    send(ws, ["CLOSED", subscriptionId || "", "auth-required: please authenticate first"]);
    return;
  }

  if (!subscriptionId || typeof subscriptionId !== "string") {
    send(ws, ["NOTICE", "error: subscription ID must be a non-empty string"]);
    return;
  }

  if (filters.length === 0) {
    send(ws, ["CLOSED", subscriptionId, "error: no filters provided"]);
    return;
  }

  if (filters.length > (RELAY_INFO.limitation.max_filters ?? 10)) {
    send(ws, [
      "CLOSED",
      subscriptionId,
      `error: too many filters (max ${RELAY_INFO.limitation.max_filters})`,
    ]);
    return;
  }

  if (state.subscriptions.count() >= (RELAY_INFO.limitation.max_subscriptions ?? 20)) {
    send(ws, [
      "CLOSED",
      subscriptionId,
      `error: too many subscriptions (max ${RELAY_INFO.limitation.max_subscriptions})`,
    ]);
    return;
  }

  // Validate individual filters
  for (const filter of filters) {
    const validation = validateFilter(filter);
    if (!validation.valid) {
      send(ws, ["CLOSED", subscriptionId, `error: ${validation.reason}`]);
      return;
    }
  }

  // Replace existing subscription with same ID
  state.subscriptions.remove(subscriptionId);

  state.subscriptions.add({
    id: subscriptionId,
    filters,
    pubkey: state.authedPubkey,
  });

  // Send matching stored events
  const events = eventStore.query(filters);
  for (const event of events) {
    send(ws, ["EVENT", subscriptionId, event]);
  }

  // Signal end of stored events
  send(ws, ["EOSE", subscriptionId]);
}

/** Handle CLOSE — unsubscribe */
function handleCloseSubscription(
  ws: ServerWebSocket<any>,
  state: ConnectionState,
  subscriptionId: string
): void {
  if (state.subscriptions.has(subscriptionId)) {
    state.subscriptions.remove(subscriptionId);
    send(ws, ["CLOSED", subscriptionId, ""]);
  } else {
    send(ws, ["CLOSED", subscriptionId, "error: no such subscription"]);
  }
}

/** Handle AUTH — NIP-42 authentication */
function handleAuth(
  ws: ServerWebSocket<any>,
  state: ConnectionState,
  event: NostrEvent
): void {
  // FIX: Input guard
  if (!event || typeof event !== "object" || !event.id) {
    send(ws, ["OK", "", false, "auth-required: malformed auth event"]);
    return;
  }

  // FIX: Prevent challenge replay — each challenge can only be used once
  if (state.challengeUsed) {
    // Issue a new challenge
    state.challenge = crypto.randomUUID();
    state.challengeUsed = false;
    send(ws, ["OK", event.id, false, "auth-required: challenge already used"]);
    send(ws, ["AUTH", state.challenge]);
    return;
  }

  // FIX: Use server's canonical URL, NOT the client-supplied relay tag
  const result = validateAuthEvent(event, state.challenge, _canonicalRelayUrl);

  if (result.valid) {
    state.authedPubkey = event.pubkey;
    state.challengeUsed = true; // Mark challenge as consumed
    send(ws, ["OK", event.id, true, ""]);
  } else {
    send(ws, ["OK", event.id, false, `auth-required: ${result.reason}`]);
  }
}

/** Broadcast an event to all WebSocket subscribers with matching filters */
export function broadcastEvent(event: NostrEvent): void {
  for (const [subWs, subState] of connections) {
    for (const sub of subState.subscriptions.getAll()) {
      if (matchesSubscription(event, sub)) {
        send(subWs, ["EVENT", sub.id, event]);
        break; // Only send once per connection even if multiple subs match
      }
    }
  }
}

// Wire up bridge broadcast (breaks circular dep via setter)
setBroadcastFn(broadcastEvent);

/** Get stats for health/status endpoints */
export function getNostrStats(): {
  connections: number;
  subscriptions: number;
  events: number;
} {
  let totalSubs = 0;
  for (const state of connections.values()) {
    totalSubs += state.subscriptions.count();
  }
  return {
    connections: connections.size,
    subscriptions: totalSubs,
    events: eventStore.count(),
  };
}
