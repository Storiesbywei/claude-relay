import type { ServerWebSocket } from "bun";
import type {
  NostrEvent,
  NostrFilter,
  ClientMessage,
  RelayMessage,
} from "@claude-relay/shared";
import { verifySignedEvent, validateAuthEvent, RELAY_INFO, LIMITS } from "@claude-relay/shared";
import { eventStore } from "./event-store.js";
import { SubscriptionManager, matchesSubscription } from "./subscriptions.js";
import { isRelayEventKind, eventToMessage, setBroadcastFn } from "./bridge.js";

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
}

// All active WebSocket connections and their state
const connections = new Map<ServerWebSocket<any>, ConnectionState>();

// Global broadcast registry: all subscription managers for live EVENT relay
const allSubscribers = new Set<{
  ws: ServerWebSocket<any>;
  state: ConnectionState;
}>();

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
  };
  connections.set(ws, state);
  allSubscribers.add({ ws, state });

  // Send NIP-42 AUTH challenge
  send(ws, ["AUTH", challenge]);
}

/** Called when a WebSocket disconnects */
export function handleClose(ws: ServerWebSocket<any>): void {
  const state = connections.get(ws);
  if (state) {
    state.subscriptions.clear();
  }
  connections.delete(ws);
  // FIX: Use connections Map for cleanup instead of linear scan
  for (const entry of allSubscribers) {
    if (entry.ws === ws) {
      allSubscribers.delete(entry);
      break;
    }
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

  // FIX: Enforce auth_required — reject unauthenticated clients
  if (!state.authedPubkey) {
    send(ws, ["OK", event.id, false, "auth-required: please authenticate first"]);
    return;
  }

  // Verify event signature
  if (!verifySignedEvent(event)) {
    send(ws, ["OK", event.id, false, "invalid: bad signature"]);
    return;
  }

  // For protected events (NIP-70), require pubkey match
  if (event.tags.some((t) => t[0] === "-")) {
    if (state.authedPubkey !== event.pubkey) {
      send(ws, [
        "OK",
        event.id,
        false,
        "auth-required: protected events must be published by the authenticated user",
      ]);
      return;
    }
  }

  // Store the event
  const result = eventStore.store(event);

  if (!result.stored && result.reason?.startsWith("duplicate:")) {
    send(ws, ["OK", event.id, true, result.reason]);
    return;
  }

  send(ws, ["OK", event.id, true, ""]);

  // Broadcast to all matching subscribers
  broadcastEvent(event);

  // Bridge: if this is a relay event kind, notify the HTTP bridge
  if (isRelayEventKind(event.kind) && onRelayEvent) {
    onRelayEvent(event);
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
  for (const { ws: subWs, state: subState } of allSubscribers) {
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
