# Level 3: Federated Solid+Nostr Bridge -- Architecture Design

> Detailed architecture for the triple-bridge federation layer in claude-relay.
> Prerequisite reading: `docs/solid-protocol-integration.md` (sections 3, 6).
> Based on source analysis of the Nostr bridge (`packages/relay-server/src/nostr/bridge.ts`,
> `relay-pool.ts`, `handler.ts`) and the Level 1 Solid export (`packages/relay-server/src/solid/`).

---

## Table of Contents

1. [Triple Bridge Architecture](#1-triple-bridge-architecture)
2. [Identity Binding: WebID + Nostr Pubkey + Bearer Token](#2-identity-binding)
3. [Solid Notifications Integration](#3-solid-notifications-integration)
4. [Cross-Relay Session Sharing](#4-cross-relay-session-sharing)
5. [Data Flow Diagrams](#5-data-flow-diagrams)
6. [Security Model](#6-security-model)
7. [RDF Vocabulary Extensions](#7-rdf-vocabulary-extensions)
8. [Challenges](#8-challenges)
9. [Proof of Concept Plan](#9-proof-of-concept-plan)

---

## 1. Triple Bridge Architecture

### 1.1 High-Level Topology

The relay becomes a triple-protocol bridge. Events that enter via any protocol propagate to the other two, subject to dedup and access control.

```
                          +-----------------+
                          |   Relay Core    |
                          |  (Hono + SQLite)|
                          +--------+--------+
                         /         |         \
                        /          |          \
               +-------+    +-----+-----+    +--------+
               | HTTP   |    | Nostr     |    | Solid   |
               | Bridge |    | Bridge    |    | Bridge  |
               +---+---+    +-----+-----+    +----+---+
                   |               |               |
              MCP tools       External         User Pods
              Dashboard       Relays           (per-participant)
              curl/API        (gossip)         (persistent/owned)
```

### 1.2 Bridge Module Layout

Mirroring the existing Nostr bridge structure under `packages/relay-server/src/nostr/`, the Solid bridge gets its own parallel module tree:

```
packages/relay-server/src/
  nostr/                      # Existing Nostr bridge
    bridge.ts                 # messageToEvent, bridgeMessageToNostr, bridgeNostrToHttp
    relay-pool.ts             # Outbound WS connections to external Nostr relays
    handler.ts                # Inbound WS handler (NIP-42, subscriptions, broadcast)
    event-store.ts            # In-memory Nostr event store
    subscriptions.ts          # Filter matching, subscription manager

  solid/                      # Existing Level 1 (export only)
    auth.ts                   # Solid-OIDC session cache
    export.ts                 # exportSessionToPod (batch, one-shot)

  solid/                      # Level 3 additions
    bridge.ts          (NEW)  # bridgeMessageToSolid, bridgeSolidToHttp, bridgeSolidToNostr
    pod-pool.ts        (NEW)  # Manages connections to multiple participant Pods
    notifications.ts   (NEW)  # Solid Notifications Protocol subscriber (WebSocketChannel2023)
    acl.ts             (NEW)  # WAC rule generation for session containers
    identity.ts        (NEW)  # WebID verification, triple-identity binding
    sync.ts            (NEW)  # Cross-relay session synchronization via shared Pod containers
```

### 1.3 Core Bridge Interface

Following the pattern established by `bridge.ts` in the Nostr module, the Solid bridge exposes symmetric functions:

```typescript
// solid/bridge.ts -- parallels nostr/bridge.ts

/** Write a StoredMessage to the participant's Solid Pod */
export async function bridgeMessageToSolid(
  msg: StoredMessage,
  sessionId: string,
  senderWebId?: string
): Promise<string | null>;   // returns Pod resource URL or null if no Pod bound

/** Read a Solid Notification and inject into the HTTP session */
export async function bridgeSolidToHttp(
  notification: SolidNotification,
  sessionId: string
): Promise<boolean>;          // true if injected, false if dedup/no-match

/** Read a Solid Notification and broadcast as a Nostr event */
export async function bridgeSolidToNostr(
  notification: SolidNotification,
  sessionId: string
): Promise<NostrEvent | null>;
```

### 1.4 How the Existing Bridge Works (Reference)

The Nostr bridge in `bridge.ts` follows a clear pattern that Level 3 replicates:

1. **HTTP to Nostr** (`bridgeMessageToNostr`): Takes a `StoredMessage`, converts it to a signed `NostrEvent` using the server keypair, stores it in the event store, broadcasts to WS subscribers, and forwards to external relays via `publishToExternal`.

2. **Nostr to HTTP** (`bridgeNostrToHttp`): Takes a `NostrEvent`, checks the `bridge: http` tag to prevent loops, resolves the target session via pubkey binding or session tag, dedup-checks via `hasMessageWithEventId`, converts with `eventToMessage`, and calls `addMessage`.

3. **Loop prevention**: The `["bridge", "http"]` tag on events created by the HTTP bridge is checked in `bridgeNostrToHttp` to break the cycle.

Level 3 extends this to three-way:

```
HTTP message arrives:
  1. Store in SQLite (existing)
  2. bridgeMessageToNostr (existing)
  3. bridgeMessageToSolid (NEW)

Nostr event arrives:
  1. bridgeNostrToHttp (existing)
  2. bridgeNostrToSolid (NEW -- triggered after HTTP injection)

Solid notification arrives:
  1. bridgeSolidToHttp (NEW)
  2. bridgeSolidToNostr (NEW)
```

### 1.5 Deduplication Strategy

Every message that passes through the relay has up to three identifiers:

| Protocol | Identifier | Format | Storage |
|----------|-----------|--------|---------|
| HTTP | `message_id` | UUID v4 | `messages.message_id` column |
| Nostr | `event.id` | 64-char hex SHA256 | `messages.nostr_event_id` column |
| Solid | Resource URL | `https://pod.example/.../003.jsonld` | `messages.solid_resource_url` column (NEW) |

The dedup table (new SQLite column on the `messages` table):

```sql
ALTER TABLE messages ADD COLUMN solid_resource_url TEXT;
CREATE INDEX idx_messages_solid_url ON messages(solid_resource_url) WHERE solid_resource_url IS NOT NULL;
```

At each bridge point, the relay checks all three identifiers:

```typescript
function isDuplicate(sessionId: string, msg: {
  message_id?: string;
  nostr_event_id?: string;
  solid_resource_url?: string;
}): boolean {
  if (msg.message_id && hasMessageWithId(sessionId, msg.message_id)) return true;
  if (msg.nostr_event_id && hasMessageWithEventId(sessionId, msg.nostr_event_id)) return true;
  if (msg.solid_resource_url && hasMessageWithSolidUrl(sessionId, msg.solid_resource_url)) return true;
  return false;
}
```

### 1.6 Origin Tagging (Loop Prevention)

Each bridged artifact carries an origin marker:

| Protocol | Origin marker | Checked by |
|----------|--------------|-----------|
| Nostr event | `["bridge", "http"]` or `["bridge", "solid"]` tag | `bridgeNostrToHttp`, `bridgeNostrToSolid` |
| Solid resource | `relay:originProtocol "http"` or `relay:originProtocol "nostr"` predicate | `bridgeSolidToHttp`, `bridgeSolidToNostr` |
| HTTP message | `origin_protocol` field on StoredMessage | bridge dispatch logic |

This prevents the cycle: HTTP -> Nostr -> Solid -> HTTP.

---

## 2. Identity Binding

### 2.1 The Triple Identity

Each participant in a session can be identified by up to three credentials:

```
Bearer Token   <-->   Nostr Pubkey   <-->   WebID
(relay-local)         (Schnorr key)         (HTTP URI, dereferenceable)
```

The existing `nostr_pubkeys` table binds Nostr pubkeys to session tokens. Level 3 adds a `solid_bindings` table for WebIDs:

```sql
CREATE TABLE solid_bindings (
  session_id    TEXT NOT NULL,
  webid         TEXT NOT NULL,      -- e.g. "https://pod.example/alice/profile/card#me"
  pod_url       TEXT NOT NULL,      -- e.g. "https://pod.example/alice/"
  token         TEXT NOT NULL,      -- bearer token for this participant
  nostr_pubkey  TEXT,               -- optional: linked Nostr pubkey
  verified_at   TEXT,               -- ISO timestamp of last verification
  PRIMARY KEY (session_id, webid),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_solid_bindings_webid ON solid_bindings(webid);
CREATE INDEX idx_solid_bindings_token ON solid_bindings(session_id, token);
```

### 2.2 Verification Methods

Each identity type has its own verification mechanism:

**Bearer token** (existing):
- Generated by the relay on session create/join.
- Verified by O(1) lookup in the `sessions` / `participants` tables.
- Trust scope: relay-local only.

**Nostr pubkey** (existing, via NIP-42):
- Client connects via WebSocket, receives an `AUTH` challenge.
- Client signs the challenge with their Nostr private key.
- Relay verifies the signature against the claimed pubkey.
- See `handler.ts` lines 370-401 for the existing implementation.

**WebID** (new, via Solid-OIDC):
- Participant provides their WebID URI and a DPoP-bound ID Token.
- Relay dereferences the WebID to discover the OIDC issuer.
- Relay validates the token against the issuer.
- The `solid/identity.ts` module encapsulates this flow.

```typescript
// solid/identity.ts

export interface WebIdVerificationResult {
  valid: boolean;
  webid?: string;       // confirmed WebID URI
  podUrl?: string;      // discovered Pod storage URL
  issuer?: string;      // OIDC issuer that vouched for this identity
  reason?: string;      // error reason if invalid
}

/**
 * Verify a WebID claim by:
 * 1. Dereferencing the WebID to fetch the profile document
 * 2. Extracting the solid:oidcIssuer from the profile
 * 3. Validating the provided DPoP token against that issuer
 * 4. Extracting pim:storage to discover the Pod URL
 */
export async function verifyWebId(
  webid: string,
  dpopToken: string,
  dpopProof: string
): Promise<WebIdVerificationResult>;
```

### 2.3 Trust Model: Any-Two-of-Three

If a participant has proven two of their three identities, the third is trusted by association:

```
Scenario 1: Participant has verified bearer token + Nostr pubkey
  -> If they claim a WebID, relay trusts it (stored as unverified but accepted)

Scenario 2: Participant has verified bearer token + WebID
  -> If they send a Nostr event from a pubkey, relay binds that pubkey

Scenario 3: Participant has verified Nostr pubkey + WebID
  -> Relay generates a bearer token for this participant
```

This reduces friction: participants do not need all three credentials to start collaborating. The binding is progressive -- identities are linked as they become available.

### 2.4 Session Metadata with Triple Identity

The session's participant list extends to include all three identity types:

```typescript
// Extension to the existing Session type
interface ParticipantInfo {
  token: string;
  name: string;
  joinedAt: Date;
  // Level 3 additions:
  webid?: string;           // Solid WebID URI
  podUrl?: string;          // Pod storage root URL
  nostrPubkey?: string;     // Hex public key (already exists via nostr_pubkeys table)
  identityVerified: {
    bearer: boolean;        // always true (token is generated by relay)
    nostr: boolean;         // true after NIP-42 auth
    solid: boolean;         // true after Solid-OIDC verification
  };
}
```

### 2.5 New API Endpoints for Identity Binding

```
POST /sessions/:id/bind-webid
  Body: { webid: string, dpop_token: string, dpop_proof: string }
  Auth: Bearer token (existing participant)
  Response: { webid: string, pod_url: string, verified: boolean }

POST /sessions/:id/bind-nostr
  (Already exists via NIP-42 WebSocket auth + relay_nostr_connect MCP tool)

GET /sessions/:id/identities
  Auth: Bearer token
  Response: Array of { name, token_prefix, nostr_pubkey?, webid?, pod_url? }
```

---

## 3. Solid Notifications Integration

### 3.1 How Solid Notifications Work

The Solid Notifications Protocol provides real-time push when a Pod resource changes. The flow:

1. **Discovery**: Client GETs the resource and reads the `notify:subscription` link header or queries the `.well-known/solid` endpoint to find the notification subscription endpoint.

2. **Subscribe**: Client POSTs a JSON-LD subscription request to the subscription endpoint:
```json
{
  "@context": ["https://www.w3.org/ns/solid/notification/v1"],
  "type": "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023",
  "topic": "https://pod.example/alice/relay-sessions/abc123/messages/"
}
```

3. **Connect**: Server responds with a WebSocket URL. Client opens the WebSocket connection.

4. **Receive**: Server pushes JSON-LD notification payloads when the topic resource changes:
```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Add",
  "object": "https://pod.example/alice/relay-sessions/abc123/messages/004.jsonld",
  "target": "https://pod.example/alice/relay-sessions/abc123/messages/",
  "published": "2026-03-30T00:05:00Z"
}
```

### 3.2 Notification Subscriber Module

```typescript
// solid/notifications.ts

export interface SolidNotification {
  type: "Add" | "Update" | "Remove";
  object: string;       // URL of the resource that changed
  target?: string;      // URL of the container (for Add)
  published: string;    // ISO timestamp
  actor?: string;       // WebID of who made the change (if known)
}

export interface PodSubscription {
  podUrl: string;
  containerUrl: string;    // the container being watched
  sessionId: string;       // which relay session this maps to
  webSocketUrl: string;    // the notification WebSocket endpoint
  ws: WebSocket | null;
  status: "connecting" | "connected" | "disconnected" | "error";
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Subscribe to a Solid Pod container for real-time notifications.
 *
 * Mirrors the structure of relay-pool.ts:
 * - Manages a pool of WebSocket connections to Pod notification endpoints
 * - Exponential backoff on disconnect
 * - Calls bridgeSolidToHttp / bridgeSolidToNostr when notifications arrive
 */
export class PodNotificationPool {
  private subscriptions = new Map<string, PodSubscription>();

  /** Subscribe to a session container on a participant's Pod */
  async subscribe(
    podUrl: string,
    sessionId: string,
    containerUrl: string,
    fetchFn: typeof fetch
  ): Promise<PodSubscription>;

  /** Unsubscribe from a specific Pod container */
  unsubscribe(containerUrl: string): void;

  /** Unsubscribe from all Pods */
  unsubscribeAll(): void;

  /** List active Pod subscriptions */
  listSubscriptions(): { podUrl: string; containerUrl: string; status: string }[];
}
```

### 3.3 Comparison: Three Real-Time Channels

| Aspect | SSE (HTTP) | Nostr WS (gossip) | Solid Notifications |
|--------|-----------|-------------------|---------------------|
| **Direction** | Server to client | Bidirectional (relay mesh) | Server to client (Pod to relay) |
| **Latency** | ~0ms (same process, memory) | 50-200ms (network hop) | 100-500ms (HTTP discovery + WS) |
| **Scope** | Single session on this relay | Any relay in the mesh | Single Pod container |
| **Auth** | Bearer token in query param | NIP-42 challenge/response | Solid-OIDC DPoP |
| **Dedup needed** | No (authoritative source) | Yes (gossip duplicates) | Yes (relay may have already written) |
| **Use case** | Dashboard live updates | External relay federation | Cross-relay via shared Pod |
| **Existing code** | `subscribe()` in `sqlite.ts` | `relay-pool.ts` + `handler.ts` | **New** (`notifications.ts`) |

### 3.4 When Notifications Fire

For each participant with a bound Pod, the relay subscribes to their session container. Notifications arrive when:

1. **The same relay writes a message** -- the relay already has this message, so the notification is a no-op (dedup by `solid_resource_url`).

2. **Another relay writes to the same container** -- this is the cross-relay federation case. The relay reads the new resource, converts it to a `StoredMessage`, and injects it into the HTTP session + Nostr event store.

3. **A participant writes directly to their Pod** -- for example, a Solid-native app editing session data. This is a future case; the relay treats it as an external write and bridges it.

---

## 4. Cross-Relay Session Sharing

### 4.1 The Federation Model

Two relay instances (Relay A, Relay B) share a session through a common Solid Pod:

```
Relay A (Company X)                       Relay B (Company Y)
  |                                          |
  +--> writes to Alice's Pod <----- reads <--+
  |         |                                |
  +--> reads from Bob's Pod ----> writes  <--+
            |
      Pod Notification
      (WebSocketChannel2023)
```

Each relay:
1. Writes its participants' messages to their respective Pods.
2. Subscribes to all participants' Pod containers via Solid Notifications.
3. When a notification arrives from a foreign Pod, reads the new resource and injects it locally.

### 4.2 Session Initialization Across Relays

```
1. Relay A creates a session, writes metadata to Alice's Pod:
   PUT https://alice-pod.example/relay-sessions/SESSION_ID/metadata.jsonld

2. Alice shares the Pod container URL with Bob (out-of-band or via Nostr):
   "Join at: https://alice-pod.example/relay-sessions/SESSION_ID/"

3. Bob's relay (Relay B) reads the metadata from Alice's Pod:
   GET https://alice-pod.example/relay-sessions/SESSION_ID/metadata.jsonld

4. Relay B creates a local session mirror, subscribes to Alice's Pod container
   for notifications.

5. Bob's messages are written to Bob's Pod:
   PUT https://bob-pod.example/relay-sessions/SESSION_ID/messages/005.jsonld

6. Relay A subscribes to Bob's Pod container and gets notified of Bob's messages.
```

### 4.3 Session Discovery via Pod

The session metadata resource on a Pod includes federation information:

```json
{
  "@context": "https://vocab.claude-relay.dev/context.jsonld",
  "@type": "relay:Session",
  "identifier": "abc123",
  "relay:federatedRelays": [
    {
      "relay:relayUrl": "https://relay-a.example:4190",
      "relay:relayWebId": "https://relay-a.example/profile/card#me"
    },
    {
      "relay:relayUrl": "https://relay-b.example:4190",
      "relay:relayWebId": "https://relay-b.example/profile/card#me"
    }
  ],
  "relay:participantPods": [
    {
      "relay:webid": "https://alice-pod.example/profile/card#me",
      "relay:podContainer": "https://alice-pod.example/relay-sessions/abc123/"
    },
    {
      "relay:webid": "https://bob-pod.example/profile/card#me",
      "relay:podContainer": "https://bob-pod.example/relay-sessions/abc123/"
    }
  ]
}
```

### 4.4 Conflict Resolution

With multiple relays writing to the same logical session, conflicts arise. The resolution strategy uses a composite ordering key:

```
(sequence_number, timestamp, origin_relay_id)
```

**Sequence numbers**: Each relay maintains its own sequence counter for messages it originates. The global order is reconstructed by timestamp, with relay ID as tiebreaker.

**Last Write Wins (LWW) for metadata**: Session metadata (title, participant list, expiry) uses LWW semantics. The metadata resource with the latest `dcterms:modified` timestamp wins. Each relay writes its own copy; readers merge by taking the union of participants and the latest timestamps.

**Message ordering**: Messages are inherently append-only. The global order is:

```
1. Sort by relay:originTimestamp (ISO datetime from the originating relay)
2. Tiebreak by relay:originRelayId (lexicographic)
3. Sequence numbers are local to each relay and used only for cursor-based polling
```

**Pod-level concurrency**: Solid uses ETags for optimistic concurrency on individual resources. For append-only message containers, this is rarely a conflict -- each message is a new resource with a unique URL. For metadata updates, the relay reads the current ETag, merges, and writes with `If-Match`.

### 4.5 Sync Module

```typescript
// solid/sync.ts

export interface FederatedSession {
  sessionId: string;
  localSession: Session;           // local SQLite session
  participantPods: Map<string, {   // webid -> pod info
    podUrl: string;
    containerUrl: string;
    lastSyncSequence: number;
    subscriptionActive: boolean;
  }>;
  federatedRelays: Map<string, {   // relay URL -> relay info
    relayUrl: string;
    relayWebId: string;
    lastSeen: Date;
  }>;
}

/**
 * Synchronize a local session with all known participant Pods.
 *
 * Called on:
 * - Session join (initial sync: read all existing messages from Pod)
 * - Solid notification (incremental sync: read new resource only)
 * - Periodic reconciliation (catch missed notifications)
 */
export async function syncFromPod(
  sessionId: string,
  podContainerUrl: string,
  fetchFn: typeof fetch
): Promise<{ newMessages: number; errors: string[] }>;

/**
 * Write a message to the appropriate participant's Pod.
 *
 * Determines which Pod to write to based on the sender's WebID binding.
 * If the sender has no Pod binding, the message is written to the
 * relay's own Pod (fallback).
 */
export async function syncToPod(
  sessionId: string,
  message: StoredMessage,
  senderWebId?: string
): Promise<string | null>;   // Pod resource URL
```

---

## 5. Data Flow Diagrams

### 5.1 Message from HTTP -> Nostr + Solid

```
                             HTTP POST /relay/:id
                                    |
                                    v
                          +-------------------+
                          |  Validate + Store  |
                          |  (SQLite)          |
                          |  sequence = N+1    |
                          +----+----------+---+
                               |          |
                  +------------+          +-------------+
                  |                                     |
                  v                                     v
        bridgeMessageToNostr()              bridgeMessageToSolid()
                  |                                     |
                  v                                     v
        +------------------+               +--------------------+
        | Sign with server |               | Authenticate with  |
        | keypair          |               | sender's Pod       |
        | Add tags:        |               | via cached session |
        |  bridge=http     |               +--------+-----------+
        |  session=ID      |                        |
        |  message_id=UUID |                        v
        +--------+---------+               +--------------------+
                 |                          | Create resource:   |
                 v                          | <pod>/messages/    |
        +------------------+               |   <seq>.jsonld     |
        | Store in event   |               | Set predicates:    |
        | store + broadcast|               |   originProtocol   |
        | to WS subs       |               |     = "http"       |
        +--------+---------+               |   nostrEventId     |
                 |                          |     = <event.id>   |
                 v                          |   message_id       |
        publishToExternal()                 |     = <uuid>       |
        (all connected relays)              +--------------------+
```

### 5.2 Message from Nostr -> HTTP + Solid

```
           External Nostr Relay
                    |
        EVENT [sub_id, event]
                    |
                    v
        +------------------------+
        | relay-pool.ts          |
        | handleRelayMessage()   |
        | Verify signature       |
        +----------+-------------+
                   |
                   v
        bridgeNostrToHttp(event)
                   |
        +----------+-------------+
        | Skip if bridge=http    |  <-- loop prevention
        | Skip if bridge=solid   |  <-- new: also skip Solid-origin events
        | Find target session:   |
        |   1. pubkey binding    |
        |   2. session tag       |
        | Dedup: check event.id  |
        | Convert: eventToMessage|
        | addMessage(session, m) |
        +----------+-------------+
                   |
                   v
        bridgeMessageToSolid()     <-- new: triggered after HTTP injection
                   |
                   v
        (same as 5.1 Solid write path)
```

### 5.3 Message from Solid Notification -> HTTP + Nostr

```
        Pod Notification (WebSocketChannel2023)
                    |
            { type: "Add",
              object: "<pod>/messages/007.jsonld" }
                    |
                    v
        +---------------------------+
        | notifications.ts          |
        | PodNotificationPool       |
        | Parse notification JSON-LD|
        +----------+----------------+
                   |
                   v
        +---------------------------+
        | Fetch the new resource:   |
        | GET <pod>/messages/007    |
        | Parse RDF -> StoredMessage|
        +----------+----------------+
                   |
                   v
        +---------------------------+
        | Dedup check:              |
        | - solid_resource_url?     |
        | - message_id?             |
        | - nostr_event_id?         |
        +----------+----------------+
                   |
           (if not duplicate)
                   |
        +----------+-----------+
        |                      |
        v                      v
  bridgeSolidToHttp()   bridgeSolidToNostr()
        |                      |
        v                      v
  +----------------+   +--------------------+
  | addMessage()   |   | Sign with server   |
  | to local       |   | keypair, add:      |
  | SQLite session |   |   bridge=solid     |
  | SSE notify     |   |   session=ID       |
  +----------------+   |   solid_url=<url>  |
                        | Broadcast + publish|
                        | to external relays |
                        +--------------------+
```

### 5.4 Dedup Decision Table

When a message arrives at a bridge point, this table determines the action:

| Source | Has `message_id` match? | Has `nostr_event_id` match? | Has `solid_resource_url` match? | Action |
|--------|:-:|:-:|:-:|--------|
| HTTP -> Nostr | n/a (always new) | -- | -- | Bridge (sign + broadcast) |
| HTTP -> Solid | n/a (always new) | -- | -- | Bridge (write to Pod) |
| Nostr -> HTTP | No | No | -- | Bridge (inject into session) |
| Nostr -> HTTP | Yes | -- | -- | **Skip** (duplicate) |
| Nostr -> HTTP | -- | Yes | -- | **Skip** (duplicate) |
| Solid -> HTTP | No | No | No | Bridge (inject into session) |
| Solid -> HTTP | Yes | -- | -- | **Skip** |
| Solid -> HTTP | -- | Yes | -- | **Skip** |
| Solid -> HTTP | -- | -- | Yes | **Skip** |
| Solid -> Nostr | Check: has `bridge=solid` tag? | -- | -- | If origin tag present, **Skip**. Else, Bridge. |
| Nostr -> Solid | -- | -- | Check: has `originProtocol=nostr`? | If origin predicate present, **Skip**. Else, Bridge. |

---

## 6. Security Model

### 6.1 Pod Access Control (WAC)

Each session container on a participant's Pod has an ACL resource defining access rules:

```turtle
# <pod>/relay-sessions/SESSION_ID/.acl

@prefix acl: <http://www.w3.org/ns/auth/acl#> .

# Pod owner has full control
<#owner>
  a acl:Authorization ;
  acl:agent <https://pod.example/alice/profile/card#me> ;
  acl:accessTo <./> ;
  acl:default <./> ;
  acl:mode acl:Read, acl:Write, acl:Control .

# The relay server can write session metadata and manage the container
<#relay>
  a acl:Authorization ;
  acl:agent <https://relay.example/profile/card#me> ;
  acl:accessTo <./> ;
  acl:default <./> ;
  acl:mode acl:Read, acl:Write .

# Other session participants can read all messages
<#participants>
  a acl:Authorization ;
  acl:agent
    <https://pod.example/bob/profile/card#me> ,
    <https://pod.example/carol/profile/card#me> ;
  acl:accessTo <./> ;
  acl:default <./> ;
  acl:mode acl:Read, acl:Append .
```

Key properties:
- **Pod owner**: Full Read, Write, Control. Can modify ACLs, delete the session.
- **Relay server**: Read + Write. Can create/update resources in the session container. The relay authenticates with its own WebID.
- **Other participants**: Read + Append. Can read all messages; Append allows POSTing new resources to the messages container but not modifying existing ones.

### 6.2 Write Isolation

Each participant's messages are written to **their own Pod**. This means:

```
Alice's messages  -> Alice's Pod  /relay-sessions/SESSION_ID/messages/
Bob's messages    -> Bob's Pod    /relay-sessions/SESSION_ID/messages/
Carol's messages  -> Carol's Pod  /relay-sessions/SESSION_ID/messages/
```

No participant can modify another participant's data. The relay aggregates messages from all Pods into the local SQLite store.

If a participant has no Pod (Solid is optional), their messages live only in SQLite and Nostr -- no Pod write occurs.

### 6.3 Nostr Non-Repudiation

Nostr events are signed by the author's private key. This provides:

- **Authorship proof**: The signature cryptographically binds the event content to the pubkey.
- **Tamper detection**: Any modification to the event content, tags, or metadata invalidates the signature.
- **Relay independence**: The signature is valid regardless of which relay serves the event.

When a Nostr event is bridged to a Solid Pod, the original signature is preserved as an RDF predicate:

```turtle
<#msg>
  relay:nostrEventId "64-hex-char-event-id" ;
  relay:nostrSignature "128-hex-char-sig" ;
  relay:nostrPubkey "64-hex-char-pubkey" .
```

### 6.4 Solid Provenance

When the relay writes a resource to a Pod, it signs the resource metadata with its own WebID:

```turtle
<#msg>
  relay:writtenBy <https://relay.example/profile/card#me> ;
  relay:writtenAt "2026-03-30T00:05:00Z"^^xsd:dateTime ;
  relay:originRelay "https://relay.example:4190" ;
  relay:originProtocol "http" .   # or "nostr" or "solid"
```

This creates an auditable provenance chain: who wrote the data, which relay originated it, and through which protocol.

### 6.5 Sensitive Content Scanning

The existing `SENSITIVE_PATTERNS` scanner (from `constants.ts`) runs **before** any bridge operation. This prevents API keys, private keys, passwords, and local file paths from being written to Pods or broadcast via Nostr.

The scanner is already integrated into the MCP approval queue. For the Solid bridge, the same patterns apply to Pod writes:

```typescript
// In bridgeMessageToSolid:
if (containsSensitiveContent(msg.content)) {
  console.warn(`[solid] Blocked write of sensitive content to Pod`);
  return null;  // do not write to Pod
}
```

### 6.6 Token and Credential Management

| Credential | Storage | Exposure Risk | Mitigation |
|------------|---------|--------------|------------|
| Bearer token | SQLite `sessions.creator_token` / `participants.token` | Low (relay-local) | Never written to Pods; session-scoped |
| Nostr nsec | `~/.claude-relay/active-sessions.json` | Medium (filesystem) | File permissions; never sent to Pods |
| Solid client_secret | Request body only (not persisted by relay) | Low | Per-request; not stored after auth |
| DPoP token | Solid-OIDC session cache (memory) | Low | Short-lived; auto-refreshed |
| Pod ACL tokens | Pod server manages | Low | Standard Solid-OIDC |

---

## 7. RDF Vocabulary Extensions

### 7.1 New Predicates for Level 3

The relay vocabulary at `https://vocab.claude-relay.dev/` extends with federation-specific predicates:

```turtle
@prefix relay: <https://vocab.claude-relay.dev/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# --- Cross-protocol identity ---

relay:nostrPubkey a rdfs:Property ;
  rdfs:label "Nostr Public Key" ;
  rdfs:comment "Hex-encoded Schnorr public key (64 chars) for this participant" ;
  rdfs:domain relay:Participant ;
  rdfs:range xsd:string .

relay:nostrEventId a rdfs:Property ;
  rdfs:label "Nostr Event ID" ;
  rdfs:comment "Links this Solid resource to its corresponding Nostr event" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:string .

relay:nostrSignature a rdfs:Property ;
  rdfs:label "Nostr Event Signature" ;
  rdfs:comment "Schnorr signature from the original Nostr event (128 hex chars)" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:string .

# --- Provenance and origin ---

relay:originProtocol a rdfs:Property ;
  rdfs:label "Origin Protocol" ;
  rdfs:comment "Protocol through which this message first entered the relay (http, nostr, solid)" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:string .

relay:originRelay a rdfs:Property ;
  rdfs:label "Origin Relay URL" ;
  rdfs:comment "URL of the relay instance that originated this message" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:anyURI .

relay:writtenBy a rdfs:Property ;
  rdfs:label "Written By" ;
  rdfs:comment "WebID of the agent that wrote this resource to the Pod" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:anyURI .

relay:writtenAt a rdfs:Property ;
  rdfs:label "Written At" ;
  rdfs:comment "ISO timestamp when this resource was written to the Pod" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:dateTime .

# --- Federation ---

relay:federatedFrom a rdfs:Property ;
  rdfs:label "Federated From" ;
  rdfs:comment "URL of the remote relay that sent this message via federation" ;
  rdfs:domain relay:Message ;
  rdfs:range xsd:anyURI .

relay:federatedRelay a rdfs:Class ;
  rdfs:label "Federated Relay" ;
  rdfs:comment "A relay instance participating in a federated session" .

relay:relayUrl a rdfs:Property ;
  rdfs:label "Relay URL" ;
  rdfs:comment "HTTP endpoint of a federated relay" ;
  rdfs:domain relay:federatedRelay ;
  rdfs:range xsd:anyURI .

relay:relayWebId a rdfs:Property ;
  rdfs:label "Relay WebID" ;
  rdfs:comment "WebID of a federated relay server" ;
  rdfs:domain relay:federatedRelay ;
  rdfs:range xsd:anyURI .

# --- Session federation metadata ---

relay:participantPod a rdfs:Property ;
  rdfs:label "Participant Pod Container" ;
  rdfs:comment "URL of a participant's Pod container for this session" ;
  rdfs:domain relay:Session ;
  rdfs:range xsd:anyURI .

relay:federatedRelays a rdfs:Property ;
  rdfs:label "Federated Relays" ;
  rdfs:comment "List of relay instances participating in this federated session" ;
  rdfs:domain relay:Session ;
  rdfs:range relay:federatedRelay .
```

### 7.2 Extended Nostr Tags

Nostr events created by the bridge carry additional tags for Solid cross-referencing:

```
["webid", "https://pod.example/alice/profile/card#me"]     -- sender's WebID
["solid_url", "https://pod.example/.../003.jsonld"]         -- Pod resource URL
["bridge", "http" | "nostr" | "solid"]                      -- origin protocol
["message_id", "uuid-v4"]                                   -- HTTP message ID
["session", "session-id"]                                   -- session scoping (existing)
```

### 7.3 JSON-LD Context Document

A hosted context document at `https://vocab.claude-relay.dev/context.jsonld` enables compact JSON-LD in Pod resources:

```json
{
  "@context": {
    "relay": "https://vocab.claude-relay.dev/",
    "dcterms": "http://purl.org/dc/terms/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "xsd": "http://www.w3.org/2001/XMLSchema#",

    "Session": "relay:Session",
    "Message": "relay:Message",
    "Participant": "relay:Participant",

    "identifier": "dcterms:identifier",
    "title": "dcterms:title",
    "created": "dcterms:created",

    "messageId": "relay:messageId",
    "sequence": { "@id": "relay:sequence", "@type": "xsd:integer" },
    "messageType": "relay:messageType",
    "content": "relay:content",
    "senderName": "relay:senderName",
    "sentAt": "relay:sentAt",

    "nostrEventId": "relay:nostrEventId",
    "nostrPubkey": "relay:nostrPubkey",
    "nostrSignature": "relay:nostrSignature",

    "originProtocol": "relay:originProtocol",
    "originRelay": { "@id": "relay:originRelay", "@type": "@id" },
    "writtenBy": { "@id": "relay:writtenBy", "@type": "@id" },
    "writtenAt": { "@id": "relay:writtenAt", "@type": "xsd:dateTime" },
    "federatedFrom": { "@id": "relay:federatedFrom", "@type": "@id" },

    "webid": { "@id": "foaf:webid", "@type": "@id" },
    "participantPod": { "@id": "relay:participantPod", "@type": "@id" }
  }
}
```

---

## 8. Challenges

### 8.1 Eventual Consistency Across Three Protocols

Each protocol has different consistency guarantees:

| Protocol | Ordering | Delivery | Consistency |
|----------|----------|----------|-------------|
| **HTTP/SQLite** | Strong (atomic sequence counter via transaction) | Guaranteed (synchronous write) | Strong (single source of truth) |
| **Nostr** | None (events have `created_at` but no guaranteed order) | Best-effort (relays can drop events) | Eventual (gossip propagation) |
| **Solid** | Weak (container membership is eventually consistent) | Guaranteed (HTTP semantics, 2xx = persisted) | Eventual (notification delivery is async) |

The relay's local SQLite remains the authoritative ordering source. When messages arrive from Nostr or Solid, they are assigned a local sequence number by the `addMessageTx` transaction. The global order across relays is best-effort, resolved by timestamps.

**Consequence**: Two relays may present slightly different message orderings during active federation. This is acceptable for the collaborative use case (Claude sessions are conversational, not transactional). The ordering converges once all notifications propagate.

### 8.2 Ordering Guarantees (or Lack Thereof)

Problem: Relay A sends message M1 at T=0, Relay B sends M2 at T=1. Due to network latency:
- Relay A sees: M1 (local), M2 (via Pod notification at T=3)
- Relay B sees: M2 (local), M1 (via Pod notification at T=2)

Each relay orders by local injection time, which may differ from origin time.

**Mitigation**: Each message carries `relay:originTimestamp` (the timestamp from the originating relay). Clients that care about global order should sort by `originTimestamp`, not local `sequence`. The dashboard could display both orderings.

### 8.3 Pod Availability

Unlike Nostr relays (which are ephemeral and replaceable), a Solid Pod is a single point of failure for a participant's data:

- If Alice's Pod is down, Relay B cannot read Alice's messages.
- If Alice's Pod is down, the relay cannot write new messages to Alice's container.

**Mitigation**:
1. SQLite acts as a write-ahead cache. Messages are always stored locally first. Pod writes are async and retried on failure.
2. The relay queues failed Pod writes and retries with exponential backoff (same pattern as `relay-pool.ts` reconnection logic).
3. Nostr provides redundancy: even if the Pod is down, messages propagate via Nostr gossip and can be reconstructed.

### 8.4 Key Management Burden

Participants in a Level 3 session potentially manage:

| Credential | Required? | Complexity |
|------------|-----------|-----------|
| Bearer token | Yes (auto-generated) | Zero -- relay handles this |
| Nostr keypair | Optional | Medium -- generated by relay, stored in `~/.claude-relay/` |
| Solid Pod credentials | Optional | High -- requires OIDC registration, Pod provisioning |

**Mitigation**: Make Solid identity opt-in. A participant can join via bearer token only and progressively bind Nostr and Solid identities. The relay handles all credential management; participants only need to provide their Pod URL and authorize the relay.

### 8.5 Write Amplification

Every message written via HTTP results in:
1. SQLite write (local, <1ms)
2. Nostr event sign + broadcast + external relay publish (existing)
3. Solid Pod HTTP PUT (new, 50-300ms)

This is 3x write amplification on the hot path. The Solid write is the bottleneck.

**Mitigation**:
1. Solid writes are async (fire-and-forget with retry queue). The HTTP response returns immediately after SQLite + Nostr.
2. Batch Solid writes: buffer messages for up to 1 second and write them in a single PATCH request (if the Pod supports it).
3. Make Solid bridging configurable per-session. Sessions that do not need Pod persistence skip the Solid write entirely.

### 8.6 Solid Notifications Spec Maturity

The Solid Notifications Protocol (specifically WebSocketChannel2023) is less battle-tested than Nostr WebSocket subscriptions:

- Not all Pod servers implement it (CSS does; Inrupt ESS does; NSS does not).
- The subscription discovery mechanism requires multiple HTTP round-trips.
- Reconnection semantics are not fully specified -- unlike Nostr's `since` filter for catch-up, Solid Notifications do not guarantee delivery of notifications missed during disconnection.

**Mitigation**: After reconnecting to a Pod notification channel, the relay does a full container listing (GET on the container URL, parse the `ldp:contains` members) to discover any resources created during the disconnection window. This is analogous to `relay-pool.ts` using `since` timestamps on reconnection.

---

## 9. Proof of Concept Plan

### 9.1 Minimum Viable Federation

The smallest testable slice that proves the triple-bridge works end-to-end:

**Scope**: Two relay instances (Relay A, Relay B) sharing a single session through one Solid Pod. No Nostr involved in the PoC (HTTP + Solid only).

**Setup**:
```
Relay A (localhost:4190) <-- HTTP API
      |
      +--> writes to CSS Pod (localhost:3001)
      |         |
      |    Pod Notification (WebSocket)
      |         |
Relay B (localhost:4191) <-- HTTP API
```

### 9.2 PoC Steps

**Step 1: Two relay instances, one Pod** (Day 1-2)

1. Start a Community Solid Server: `npx @solid/community-server -p 3001 -f ./pod-data/`
2. Create a test account + Pod on the CSS.
3. Start Relay A on port 4190, Relay B on port 4191.
4. On Relay A: create a session, bind the Pod URL via `POST /sessions/:id/bind-webid`.

**Step 2: Outbound bridge -- HTTP to Solid** (Day 2-3)

5. On Relay A: send a message via `POST /relay/:id`. Verify the message appears in the Pod container.
6. Verify the Pod resource contains correct RDF (`relay:originProtocol "http"`, `relay:originRelay "http://localhost:4190"`).

**Step 3: Inbound bridge -- Solid notification to HTTP** (Day 3-4)

7. Relay B subscribes to the Pod container via Solid Notifications.
8. Relay A sends another message, which writes to the Pod.
9. Relay B receives the notification, fetches the resource, injects it into its local session.
10. Poll Relay B's HTTP API and verify the message appears.

**Step 4: Full round-trip** (Day 4-5)

11. Relay B sends a message via `POST /relay/:id` on Relay B.
12. Relay B writes the message to the same Pod container (or a second Pod for Bob).
13. Relay A receives the notification, fetches, injects.
14. Both relays now have both messages.

**Step 5: Dedup verification** (Day 5)

15. Send the same message twice (simulate a retry).
16. Verify dedup prevents duplicate injection on both sides.
17. Verify bridge loop prevention (message from Solid does not get re-written to same Pod).

### 9.3 PoC File Changes

| File | Change | Lines |
|------|--------|-------|
| `packages/shared/src/solid-types.ts` | Add `SolidNotification`, `FederatedSession` types | ~40 |
| `packages/relay-server/src/solid/bridge.ts` | **New**: `bridgeMessageToSolid`, `bridgeSolidToHttp` | ~150 |
| `packages/relay-server/src/solid/notifications.ts` | **New**: `PodNotificationPool` class | ~200 |
| `packages/relay-server/src/solid/sync.ts` | **New**: `syncFromPod`, `syncToPod` | ~120 |
| `packages/relay-server/src/solid/identity.ts` | **New**: `verifyWebId`, triple-identity binding | ~80 |
| `packages/relay-server/src/solid/acl.ts` | **New**: `generateSessionAcl` | ~60 |
| `packages/relay-server/src/store/sqlite.ts` | Add `solid_resource_url` column, `solid_bindings` table | ~30 |
| `packages/relay-server/src/routes/solid.ts` | Add `/bind-webid`, federation endpoints | ~60 |
| `packages/relay-server/src/nostr/bridge.ts` | Add `bridge=solid` origin tag handling | ~10 |
| `packages/relay-server/src/index.ts` | Wire `PodNotificationPool` into startup/shutdown | ~15 |
| `docker-compose.yml` | Add CSS service | ~15 |
| **Total** | | **~780** |

### 9.4 What the PoC Does NOT Cover

- Nostr integration in the triple-bridge (PoC is HTTP+Solid only; Nostr is added after PoC validates)
- WebID verification via Solid-OIDC (PoC uses pre-configured client credentials)
- ACL enforcement (PoC sets up ACLs but does not test unauthorized access)
- Multiple Pods per session (PoC uses one shared Pod; multi-Pod is Step 2)
- Cross-relay Nostr gossip (PoC relays share only through the Pod, not Nostr)
- Performance optimization (no batching, no caching, no parallel writes)

### 9.5 Success Criteria

The PoC is successful if:

1. A message sent on Relay A appears on Relay B within 5 seconds (via Pod notification).
2. A message sent on Relay B appears on Relay A within 5 seconds.
3. Duplicate messages are prevented (each message appears exactly once on each relay).
4. The Pod contains well-formed JSON-LD resources with correct provenance metadata.
5. Both relays survive the other relay going down and resuming (Pod is the persistence layer).

### 9.6 Post-PoC Roadmap

```
PoC     (2-3 days)  HTTP <-> Solid, two relays, one Pod
Phase A (1 week)    Add Nostr leg: full HTTP <-> Nostr <-> Solid triple bridge
Phase B (1 week)    Multi-Pod: each participant writes to their own Pod
Phase C (1 week)    Identity: WebID verification, any-two-of-three trust model
Phase D (1 week)    Hardening: reconnection, catch-up sync, error recovery, tests
```

---

## Appendix A: Updated Architecture Diagram

```
                               +--------------------------+
                               |      Relay Core          |
                               |   (Hono + SQLite + SSE)  |
                               |                          |
                               |   SQLite: authoritative  |
                               |   ordering + dedup       |
                               |   sequence counter       |
                               +--+--------+----------+--+
                                  |        |          |
                    +-------------+  +-----+-----+  +-----------+
                    |                |           |              |
               HTTP Bridge      Nostr Bridge  Solid Bridge    SSE
               (existing)       (existing)    (Level 3)       (existing)
                    |                |           |              |
               MCP Tools       WebSocket      HTTP REST       Dashboard
               curl/API        Handler        to Pods         Browser
                    |                |           |
                    |         External       User Pods (N)
                    |         Relays (M)     - Alice Pod
                    |         (gossip)       - Bob Pod
                    |                        - Relay Pod (fallback)
                    |                             |
                    |                        Pod Notifications
                    |                        (WebSocketChannel2023)
                    |                             |
                    +-------- Dedup Layer --------+
                         (message_id + event_id
                          + solid_resource_url)
```

## Appendix B: New SQLite Schema (Level 3 Additions)

```sql
-- Add Solid resource URL tracking to messages
ALTER TABLE messages ADD COLUMN solid_resource_url TEXT;
CREATE INDEX idx_messages_solid_url
  ON messages(solid_resource_url)
  WHERE solid_resource_url IS NOT NULL;

-- Add origin protocol tracking to messages
ALTER TABLE messages ADD COLUMN origin_protocol TEXT DEFAULT 'http';

-- Solid identity bindings per session
CREATE TABLE solid_bindings (
  session_id    TEXT NOT NULL,
  webid         TEXT NOT NULL,
  pod_url       TEXT NOT NULL,
  token         TEXT NOT NULL,
  nostr_pubkey  TEXT,
  verified_at   TEXT,
  PRIMARY KEY (session_id, webid),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_solid_bindings_webid ON solid_bindings(webid);
CREATE INDEX idx_solid_bindings_token ON solid_bindings(session_id, token);

-- Federated relay registry
CREATE TABLE federated_relays (
  session_id    TEXT NOT NULL,
  relay_url     TEXT NOT NULL,
  relay_webid   TEXT,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, relay_url),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Pod write queue (for retry on failure)
CREATE TABLE solid_write_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  resource_url  TEXT NOT NULL,
  payload       TEXT NOT NULL,     -- JSON-LD serialized
  retry_count   INTEGER DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_write_queue_retry ON solid_write_queue(next_retry_at);
```

## Appendix C: Configuration

New environment variables for Level 3:

```bash
# Solid federation (all optional -- Solid bridge is disabled if not set)
SOLID_ENABLED=true                              # Enable Solid bridge
SOLID_RELAY_WEBID=https://relay.example/card#me # Relay's own WebID
SOLID_RELAY_POD=https://relay.example/pod/      # Fallback Pod for participants without their own
SOLID_OIDC_ISSUER=https://idp.example.com       # Default OIDC issuer
SOLID_CLIENT_ID=claude-relay                    # Relay's OIDC client ID
SOLID_CLIENT_SECRET=secret                      # Relay's OIDC client secret
SOLID_WRITE_ASYNC=true                          # Async Pod writes (fire-and-forget + retry)
SOLID_NOTIFICATION_RECONNECT_MS=30000           # Reconnect interval for Pod notifications
```

---

*Architecture document for claude-relay Level 3 | March 2026 | Based on source analysis of v0.3.0*
