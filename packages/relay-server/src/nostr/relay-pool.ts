import type { NostrEvent, NostrFilter, NostrKeypair } from "@claude-relay/shared";
import {
  ALL_RELAY_KINDS,
  SESSION_TAG,
  signEvent,
  createAuthEvent,
  verifySignedEvent,
} from "@claude-relay/shared";
import { bridgeNostrToHttp } from "./bridge.js";

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1000;

interface ExternalRelay {
  url: string;
  ws: WebSocket | null;
  status: "connecting" | "connected" | "authenticated" | "disconnected" | "error";
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  sessionFilter?: string;
  subscriptionId?: string;
}

let _serverKeypair: NostrKeypair | null = null;

/** Set the server keypair for signing auth events */
export function setPoolKeypair(keypair: NostrKeypair): void {
  _serverKeypair = keypair;
}

const relays = new Map<string, ExternalRelay>();

/** Connect to an external Nostr relay */
export function connectRelay(url: string, sessionFilter?: string): void {
  if (relays.has(url)) {
    const existing = relays.get(url)!;
    if (existing.status === "connected" || existing.status === "authenticated" || existing.status === "connecting") {
      return; // Already connected or connecting
    }
  }

  const relay: ExternalRelay = {
    url,
    ws: null,
    status: "connecting",
    retryCount: 0,
    retryTimer: null,
    sessionFilter,
  };
  relays.set(url, relay);
  openConnection(relay);
}

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
      scheduleReconnect(relay);
    });

    ws.addEventListener("error", (err) => {
      relay.status = "error";
      console.log(`[relay-pool] Error on ${relay.url}: ${err}`);
    });
  } catch (err) {
    relay.status = "error";
    console.log(`[relay-pool] Failed to connect to ${relay.url}: ${err}`);
    scheduleReconnect(relay);
  }
}

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
        // Verify signature before accepting
        if (verifySignedEvent(event)) {
          bridgeNostrToHttp(event);
        }
      }
      break;
    }
    case "EOSE": {
      // End of stored events — subscription is now live
      console.log(`[relay-pool] EOSE from ${relay.url}`);
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

function subscribeToRelay(relay: ExternalRelay): void {
  const subId = `pool-${Date.now()}`;
  relay.subscriptionId = subId;

  const filter: NostrFilter = { kinds: [...ALL_RELAY_KINDS] };
  if (relay.sessionFilter) {
    (filter as any)[`#${SESSION_TAG}`] = [relay.sessionFilter];
  }

  relay.ws?.send(JSON.stringify(["REQ", subId, filter]));
  console.log(`[relay-pool] Subscribed to ${relay.url} (sub: ${subId})`);
}

function scheduleReconnect(relay: ExternalRelay): void {
  if (relay.retryCount >= MAX_RETRIES) {
    console.log(`[relay-pool] Max retries reached for ${relay.url}`);
    relay.status = "error";
    return;
  }

  const delay = BASE_RETRY_MS * Math.pow(2, relay.retryCount);
  relay.retryCount++;
  relay.retryTimer = setTimeout(() => {
    if (relays.has(relay.url)) {
      console.log(`[relay-pool] Reconnecting to ${relay.url} (attempt ${relay.retryCount})`);
      openConnection(relay);
    }
  }, delay);
}

/** Publish a local event to all connected external relays */
export function publishToExternal(event: NostrEvent): void {
  for (const relay of relays.values()) {
    if (relay.ws && (relay.status === "connected" || relay.status === "authenticated")) {
      try {
        relay.ws.send(JSON.stringify(["EVENT", event]));
      } catch {
        // Connection issue — will reconnect
      }
    }
  }
}

/** Disconnect from a specific relay */
export function disconnectRelay(url: string): void {
  const relay = relays.get(url);
  if (!relay) return;

  if (relay.retryTimer) clearTimeout(relay.retryTimer);
  if (relay.ws) {
    if (relay.subscriptionId) {
      try { relay.ws.send(JSON.stringify(["CLOSE", relay.subscriptionId])); } catch {}
    }
    try { relay.ws.close(); } catch {}
  }
  relays.delete(url);
}

/** Disconnect all external relays */
export function disconnectAll(): void {
  for (const url of [...relays.keys()]) {
    disconnectRelay(url);
  }
}

/** Get status of all external relay connections */
export function getPoolStatus(): { url: string; status: string }[] {
  return [...relays.values()].map((r) => ({
    url: r.url,
    status: r.status,
  }));
}
