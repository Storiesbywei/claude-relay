/**
 * Relay Pool -- manages outbound WebSocket connections to external Nostr relays.
 *
 * Features (Sprint 1 + Sprint 2 network hardening):
 * - NIP-42 auth via server keypair
 * - Connect/disconnect/list external relays with URL validation + max 10 limit
 * - Auto-resubscribe on reconnect with `since` for catch-up
 * - Exponential backoff with jitter + periodic long-term retry
 * - Publish bridged events to all connected relays
 * - Bidirectional bridge integration (bridgeNostrToHttp)
 */

import type { NostrEvent, NostrFilter, NostrKeypair } from "@claude-relay/shared";
import {
  ALL_RELAY_KINDS,
  SESSION_TAG,
  signEvent,
  createAuthEvent,
  verifySignedEvent,
} from "@claude-relay/shared";
import { bridgeNostrToHttp } from "./bridge.js";

// ---- Configuration ----

const MAX_EXTERNAL_RELAYS = 10;
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1000;
const PERIODIC_RETRY_MS = 300_000; // 5 minutes

// ---- Types ----

export type RelayStatus = "connecting" | "connected" | "authenticated" | "disconnected" | "error";

export interface ExternalRelay {
  url: string;
  ws: WebSocket | null;
  status: RelayStatus;
  sessionFilter?: string;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  subscriptionId?: string;
  lastEventTimestamp?: number; // Track last received event time for catch-up on reconnect
}

// ---- State ----

let _serverKeypair: NostrKeypair | null = null;

/** Set the server keypair for signing auth events */
export function setPoolKeypair(keypair: NostrKeypair): void {
  _serverKeypair = keypair;
}

const relays = new Map<string, ExternalRelay>();

// ---- Public API ----

/** Connect to an external Nostr relay */
export function connectRelay(url: string, sessionFilter?: string): { url: string; status: RelayStatus } {
  // Validate URL
  if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
    throw new Error("URL must start with wss:// or ws://");
  }

  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  // Check capacity
  if (relays.size >= MAX_EXTERNAL_RELAYS && !relays.has(url)) {
    throw new Error(`Max external relay connections (${MAX_EXTERNAL_RELAYS}) reached`);
  }

  // Already connected?
  const existing = relays.get(url);
  if (existing && (existing.status === "connected" || existing.status === "authenticated" || existing.status === "connecting")) {
    return { url: existing.url, status: existing.status };
  }

  const relay: ExternalRelay = {
    url,
    ws: null,
    status: "connecting",
    sessionFilter,
    retryCount: 0,
    retryTimer: null,
    lastEventTimestamp: existing?.lastEventTimestamp, // Preserve catch-up timestamp
  };

  relays.set(url, relay);
  openConnection(relay);

  return { url: relay.url, status: relay.status };
}

/** Disconnect from a specific relay. Returns true if found and disconnected. */
export function disconnectRelay(url: string): boolean {
  const relay = relays.get(url);
  if (!relay) return false;

  if (relay.retryTimer) {
    clearTimeout(relay.retryTimer);
    relay.retryTimer = null;
  }

  if (relay.ws) {
    try {
      if (relay.subscriptionId) {
        relay.ws.send(JSON.stringify(["CLOSE", relay.subscriptionId]));
      }
      relay.ws.close();
    } catch {
      // Already closed
    }
    relay.ws = null;
  }

  relays.delete(url);
  return true;
}

/** Disconnect all external relays */
export function disconnectAll(): void {
  for (const url of [...relays.keys()]) {
    disconnectRelay(url);
  }
}

/** List all external relay connections */
export function listRelays(): { url: string; status: RelayStatus }[] {
  return Array.from(relays.values()).map((r) => ({
    url: r.url,
    status: r.status,
  }));
}

/** Get count of connected relays */
export function getRelayCount(): number {
  return relays.size;
}

/** Get status of all external relay connections (legacy alias) */
export function getPoolStatus(): { url: string; status: string }[] {
  return [...relays.values()].map((r) => ({
    url: r.url,
    status: r.status,
  }));
}

/** Publish a local event to all connected external relays */
export function publishToExternal(event: NostrEvent): void {
  for (const relay of relays.values()) {
    if (relay.ws && (relay.status === "connected" || relay.status === "authenticated")) {
      try {
        relay.ws.send(JSON.stringify(["EVENT", event]));
      } catch {
        // Connection issue -- will reconnect
      }
    }
  }
}

/** Clean up all relay connections (for graceful shutdown) */
export function shutdownPool(): void {
  for (const relay of relays.values()) {
    if (relay.retryTimer) clearTimeout(relay.retryTimer);
    if (relay.ws) {
      try {
        relay.ws.close();
      } catch {
        // Ignore
      }
    }
  }
  relays.clear();
}

// ---- Internal ----

function openConnection(relay: ExternalRelay): void {
  try {
    const ws = new WebSocket(relay.url);
    relay.ws = ws;
    relay.status = "connecting";

    ws.addEventListener("open", () => {
      relay.status = "connected";
      relay.retryCount = 0;
      console.log(`[relay-pool] Connected to ${relay.url}`);
    });

    ws.addEventListener("message", (ev) => {
      handleRelayMessage(relay, typeof ev.data === "string" ? ev.data : ev.data.toString());
    });

    ws.addEventListener("close", () => {
      relay.status = "disconnected";
      relay.ws = null;
      console.log(`[relay-pool] Disconnected from ${relay.url}`);
      // Only reconnect if still in our pool
      if (relays.has(relay.url)) {
        scheduleReconnect(relay);
      }
    });

    ws.addEventListener("error", (err) => {
      relay.status = "error";
      console.error(`[relay-pool] Error on ${relay.url}:`, err);
    });
  } catch (err) {
    relay.status = "error";
    console.error(`[relay-pool] Failed to connect to ${relay.url}:`, err);
    if (relays.has(relay.url)) {
      scheduleReconnect(relay);
    }
  }
}

/** Handle incoming messages from an external relay */
function handleRelayMessage(relay: ExternalRelay, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (!Array.isArray(msg) || msg.length < 2) return;

  const type = msg[0];

  switch (type) {
    case "AUTH": {
      // NIP-42 challenge from external relay
      const challenge = msg[1] as string;
      if (_serverKeypair) {
        const authEvent = createAuthEvent(challenge, relay.url, _serverKeypair.privateKey);
        relay.ws?.send(JSON.stringify(["AUTH", authEvent]));
      }
      break;
    }
    case "OK": {
      const [, eventId, success, message] = msg;
      if (success) {
        relay.status = "authenticated";
      }
      if (!success && typeof message === "string" && message.includes("auth")) {
        console.log(`[relay-pool] Auth issue on ${relay.url}: ${message}`);
      }
      break;
    }
    case "EVENT": {
      // Incoming event from external relay
      const [, subId, event] = msg as [string, string, NostrEvent];
      if (event && typeof event === "object" && event.id) {
        // Track last event timestamp for catch-up on reconnect
        if (event.created_at) {
          relay.lastEventTimestamp = Math.max(
            relay.lastEventTimestamp || 0,
            event.created_at
          );
        }

        // Verify signature before accepting
        if (verifySignedEvent(event)) {
          bridgeNostrToHttp(event);
          console.log(`[relay-pool] Received event ${event.id.slice(0, 8)} from ${relay.url}`);
        }
      }
      break;
    }
    case "EOSE": {
      console.log(`[relay-pool] EOSE from ${relay.url} (sub: ${msg[1]})`);
      break;
    }
    case "NOTICE": {
      console.log(`[relay-pool] Notice from ${relay.url}: ${msg[1]}`);
      break;
    }
  }

  // After connection established, subscribe if we haven't yet
  if ((relay.status === "connected" || relay.status === "authenticated") && !relay.subscriptionId) {
    subscribeToRelay(relay);
  }
}

/** Subscribe to relay events with optional catch-up via `since` */
function subscribeToRelay(relay: ExternalRelay): void {
  const subId = `pool-${crypto.randomUUID().slice(0, 8)}`;
  relay.subscriptionId = subId;

  const filter: NostrFilter = {
    kinds: [...ALL_RELAY_KINDS],
    since: relay.lastEventTimestamp || undefined,
  };

  if (relay.sessionFilter) {
    (filter as any)[`#${SESSION_TAG}`] = [relay.sessionFilter];
  }

  relay.ws?.send(JSON.stringify(["REQ", subId, filter]));
  console.log(`[relay-pool] Subscribed to ${relay.url} (sub: ${subId}${relay.lastEventTimestamp ? `, since: ${relay.lastEventTimestamp}` : ""})`);
}

/**
 * Schedule a reconnection attempt with exponential backoff + jitter.
 * After MAX_RETRIES, switches to periodic retry every 5 minutes.
 */
function scheduleReconnect(relay: ExternalRelay): void {
  if (relay.retryTimer) {
    clearTimeout(relay.retryTimer);
    relay.retryTimer = null;
  }

  let delay: number;
  if (relay.retryCount >= MAX_RETRIES) {
    // Long-term periodic retry (every 5 min with jitter)
    delay = PERIODIC_RETRY_MS * (0.5 + Math.random());
    console.log(`[relay-pool] Periodic retry for ${relay.url} in ${Math.round(delay / 1000)}s`);
  } else {
    // Exponential backoff with jitter
    delay = BASE_RETRY_MS * Math.pow(2, relay.retryCount) * (0.5 + Math.random());
    relay.retryCount++;
    console.log(`[relay-pool] Reconnecting to ${relay.url} in ${Math.round(delay / 1000)}s (attempt ${relay.retryCount}/${MAX_RETRIES})`);
  }

  relay.retryTimer = setTimeout(() => {
    if (relays.has(relay.url)) {
      console.log(`[relay-pool] Reconnecting to ${relay.url} (attempt ${relay.retryCount})`);
      openConnection(relay);
    }
  }, delay);
}
