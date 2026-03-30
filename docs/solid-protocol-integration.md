# Solid Protocol Integration -- Research & Architecture Analysis

> Integration analysis for bringing Tim Berners-Lee's Solid Protocol into the claude-relay system.
> Based on source analysis of claude-relay v0.3.0 and web research on Solid specifications (March 2026).

---

## Table of Contents

1. [What is Solid Protocol?](#1-what-is-solid-protocol)
2. [Where Solid Fits in claude-relay](#2-where-solid-fits-in-claude-relay)
3. [Architecture Options](#3-architecture-options)
4. [Data Model Mapping](#4-data-model-mapping)
5. [Implementation Sketch (Level 1)](#5-implementation-sketch-level-1)
6. [Solid + Nostr Synergy](#6-solid--nostr-synergy)
7. [Challenges & Trade-offs](#7-challenges--trade-offs)
8. [Recommendation](#8-recommendation)
9. [Sprint Plan](#9-sprint-plan)

---

## 1. What is Solid Protocol?

### 1.1 Overview

Solid (Social Linked Data) is a web decentralization project led by Sir Tim Berners-Lee, originally developed at MIT. The core idea: separate data from applications. Instead of each application storing user data in its own silo, data lives in personal data stores called **Pods** that the user owns and controls. Applications request access to the Pod; the user decides what to share.

Tim Berners-Lee formed a company called [Inrupt](https://www.inrupt.com/solid) to build a commercial ecosystem around Solid. The [W3C](https://www.w3.org/wiki/WebAccessControl) began an open standardization process for the Solid specifications in 2018. The Community Solid Server (CSS) is the primary open-source reference implementation.

### 1.2 Core Concepts

#### Pods (Personal Online Data Stores)

A Pod is an HTTP-accessible data store that belongs to an individual or organization. It stores data as **resources** (files) organized in **containers** (directories), forming a hierarchical URL structure -- similar to a filesystem exposed over HTTP.

```
https://pod.example/alice/
  profile/card           -- WebID profile document
  relay-sessions/        -- container for relay data
    session-abc123/      -- one session = one container
      msg-001.ttl        -- individual message resource
      msg-002.ttl
      metadata.ttl       -- session metadata
  settings/
    preferences.ttl
```

Key properties:
- URIs are resources: every piece of data has a URL
- Containers (paths ending in `/`) are collections that track their members
- The server auto-creates intermediate containers on PUT/POST
- Resources can be RDF (Turtle, JSON-LD, N-Triples) or non-RDF (binary, JSON, etc.)

#### WebID (Decentralized Identity)

A WebID is an HTTP URI that, when dereferenced, resolves to an RDF profile document. This profile contains identity information, links to the user's OIDC issuer, and pointers to their Pod storage.

```turtle
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .

<https://pod.example/alice/profile/card#me>
  a foaf:Person ;
  foaf:name "Alice" ;
  solid:oidcIssuer <https://idp.example.com> ;
  pim:storage <https://pod.example/alice/> .
```

The WebID enables decentralized identity verification: any party can dereference the URI, discover the OIDC issuer, and validate tokens against it -- no pre-existing trust relationship needed.

#### Linked Data (RDF / Turtle / JSON-LD)

Solid uses the Resource Description Framework (RDF) as its data model. Data is expressed as **triples** (subject-predicate-object), which can be serialized in multiple formats:

- **Turtle** (.ttl) -- compact, human-readable, the default in Solid
- **JSON-LD** (.jsonld) -- JSON with `@context` for RDF semantics, developer-friendly
- **N-Triples** (.nt) -- one triple per line, machine-friendly

All Solid servers must support GET requests returning `text/turtle` or `application/ld+json` for RDF resources.

### 1.3 Authentication: Solid-OIDC

Solid authentication extends OpenID Connect 1.0 with Demonstration of Proof-of-Possession (DPoP) tokens. The flow:

1. **Client** discovers the user's OIDC issuer from their WebID profile
2. **Client** performs Authorization Code Flow with PKCE against the issuer
3. **Issuer** returns a DPoP-bound ID Token containing a `webid` claim
4. **Client** sends the DPoP-bound token + a fresh DPoP proof JWT with each request
5. **Resource Server** validates the token, verifies the DPoP proof, dereferences the WebID to confirm the issuer

Key properties of the DPoP-bound ID Token:
```json
{
  "webid": "https://pod.example/alice/profile/card#me",
  "iss": "https://idp.example.com",
  "aud": ["https://client.example.com/client_id", "solid"],
  "azp": "https://client.example.com/client_id",
  "cnf": { "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" },
  "iat": 1711843200,
  "exp": 1711846800
}
```

For server-to-server (non-interactive) scenarios -- relevant to claude-relay -- Solid-OIDC supports **client credentials** grant: register the relay as a static client, obtain a client ID + secret, and authenticate without browser-based flows.

### 1.4 Access Control: WAC and ACP

Solid defines two authorization mechanisms. Servers must implement at least one.

**Web Access Control (WAC)** uses ACL resources (RDF documents) associated with each resource. Four access modes:

| Mode | Grants |
|------|--------|
| `acl:Read` | GET, HEAD on the resource |
| `acl:Write` | PUT, POST, PATCH, DELETE on the resource |
| `acl:Append` | POST, PATCH (add-only, no remove) |
| `acl:Control` | Read/write the ACL resource itself |

ACL inheritance: a resource without its own ACL inherits from the closest parent container's `acl:default` rules, walking up to the root.

Example ACL (Turtle):
```turtle
@prefix acl: <http://www.w3.org/ns/auth/acl#> .

<#owner>
  a acl:Authorization ;
  acl:agent <https://pod.example/alice/profile/card#me> ;
  acl:accessTo <./session-abc123/> ;
  acl:default <./session-abc123/> ;
  acl:mode acl:Read, acl:Write, acl:Control .

<#participant>
  a acl:Authorization ;
  acl:agent <https://pod.example/bob/profile/card#me> ;
  acl:accessTo <./session-abc123/> ;
  acl:default <./session-abc123/> ;
  acl:mode acl:Read, acl:Append .
```

**Access Control Policy (ACP)** is the newer, more expressive alternative, supporting fine-grained policy composition. WAC is more widely deployed; ACP is gaining traction.

### 1.5 Notifications: Solid Notifications Protocol

Solid defines a linked-data-based notification system for real-time updates:

- **WebSocketChannel2023**: Client POSTs a JSON-LD subscription request specifying a `topic` (resource URL), receives a WebSocket endpoint URL, then connects for live notifications
- Notifications respect access control -- only authorized agents receive updates
- Supports JSON-LD notification payloads with activity types (Create, Update, Delete)

This maps directly to claude-relay's SSE streaming model.

### 1.6 Key Differences: Solid vs Nostr

| Dimension | Solid | Nostr |
|-----------|-------|-------|
| **Core purpose** | Data ownership & interoperability | Censorship-resistant event relay |
| **Data model** | RDF triples (structured, semantic) | JSON events (flat, signed) |
| **Identity** | WebID (HTTP URI + OIDC) | Schnorr keypair (npub/nsec) |
| **Storage** | Persistent Pod (user-owned) | Ephemeral relay (relay-owned) |
| **Auth** | Solid-OIDC + DPoP | NIP-42 challenge/response |
| **Access control** | WAC/ACP (per-resource, granular) | Event-level (kind filters, NIP-70) |
| **Discovery** | WebID profile, Type Index | Relay lists (NIP-65), contact lists |
| **Real-time** | Solid Notifications (WebSocket) | Nostr subscriptions (WebSocket) |
| **Philosophy** | W3C standards, linked data web | Minimal protocol, simplicity-first |
| **Adoption** | Enterprise (Flanders gov, NHS, Inrupt) | Grassroots (Bitcoin community) |

**Summary**: Solid = where your data lives. Nostr = how events travel. They solve different problems and complement each other naturally.

---

## 2. Where Solid Fits in claude-relay

### 2.1 Concept Mapping

| Solid Concept | claude-relay Equivalent | Integration Point |
|---------------|------------------------|-------------------|
| **Pod** | Session data / message store | Replace or supplement SQLite with Pod-backed storage |
| **WebID** | Participant identity | Auth alongside Bearer tokens + Nostr pubkeys |
| **Container** | Session | Each session = a Solid container at `/<pod>/relay-sessions/<session-id>/` |
| **Resource** | Message | Each message = a Solid resource (Turtle or JSON-LD) |
| **ACL (WAC)** | Token-based auth | WAC rules per session container -- owner gets Control, participants get Read+Append |
| **Linked Data** | Message references | RDF triples for cross-session linking, file references as URIs |
| **Solid Notifications** | SSE streaming | WebSocketChannel2023 for live session updates |
| **OIDC Issuer** | (none currently) | Solid-OIDC issuer for WebID verification |
| **Type Index** | (none currently) | Session discovery across pods |
| **DPoP Token** | Bearer token | DPoP-bound tokens for authenticated Pod access |

### 2.2 Current Architecture (for reference)

```
Claude Code --> MCP tools --> relay-client --> Hono HTTP server --> SQLite
                                                   |
                                              Nostr bridge --> Nostr WebSocket --> External relays
                                                   |
                                              SSE stream --> Browser dashboard
```

### 2.3 Where Solid Would Insert

```
Claude Code --> MCP tools --> relay-client --> Hono HTTP server --> SQLite (hot path)
                                                   |                    |
                                              Nostr bridge         Solid bridge (new)
                                                   |                    |
                                           External relays        User's Solid Pod
                                                   |                    |
                                           (gossip/ephemeral)    (persistent/owned)
```

The Solid bridge follows the same architectural pattern as the existing Nostr bridge (`packages/relay-server/src/nostr/bridge.ts`): bidirectional translation between the internal message format and an external protocol.

---

## 3. Architecture Options

### Level 1: Pod as Export Target (minimal)

**What it does**: After a session completes (or on-demand), export the full session transcript to a user's Solid Pod as JSON-LD resources. The relay still owns the data during the active session; the Pod is a durable archive.

**New endpoint**: `POST /relay/:id/export-to-pod`

**How it works**:
1. User provides their Pod URL and authenticates via Solid-OIDC client credentials
2. Relay serializes the session as JSON-LD (session metadata + messages)
3. Relay creates a container in the Pod: `<pod>/relay-sessions/<session-id>/`
4. Relay writes `metadata.jsonld` (session info) + individual message resources
5. Relay sets WAC rules: session creator gets Control, participants get Read

**What changes**:
- New npm dependencies: `@inrupt/solid-client`, `@inrupt/solid-client-authn-node`
- New route in `packages/relay-server/src/routes/relay.ts`
- New `packages/relay-server/src/solid/` directory with export logic
- User provides Pod URL + credentials in session creation or export request

**What stays the same**: SQLite remains the primary store. SSE, Nostr bridge, all MCP tools -- unchanged. This is purely additive.

**Effort**: ~2-3 days. Low risk.

### Level 2: Pod as Persistent Storage (medium)

**What it does**: Replace SQLite with Solid Pod storage for sessions and messages. Each session is a container, each message is a resource. The relay becomes a "Solid app" that reads/writes to the user's Pod.

**How it works**:
1. On session creation, create a container in the creator's Pod
2. On message send, write a new resource to the session container
3. On poll, read resources from the container (filtered by sequence/date)
4. WebID replaces or supplements Bearer tokens for participant identity
5. WAC rules replace the current token-based auth model

**Architecture**:
```
packages/relay-server/src/store/
  memory.ts       -- Phase 1 (still available for fallback)
  sqlite.ts       -- Current default
  solid.ts        -- NEW: implements same interface, backed by Solid Pod
```

The store interface (`createSession`, `getSession`, `addMessage`, `getMessages`, etc.) remains identical -- only the backend changes.

**Challenges**:
- **Latency**: Every read/write is an HTTP round-trip to the Pod server. SQLite queries in <1ms; Pod HTTP requests take 50-200ms. This would make polling noticeably slower.
- **Atomic operations**: SQLite uses transactions for atomic sequence increment + message insert. Solid has no native transaction support -- you would need optimistic concurrency with ETags.
- **Session expiry**: SQLite's `sweepExpiredSessions` does a simple DELETE. On a Pod, you would need to delete the container and all its contents via HTTP.
- **SSE subscribers**: Still in-memory (not stored in the Pod).

**Mitigation**: Use SQLite as a write-ahead cache. Messages write to SQLite first (fast), then async-sync to the Pod. Reads come from SQLite. The Pod serves as the durable, portable copy.

**Effort**: ~1-2 weeks. Medium risk.

### Level 3: Federated Solid+Nostr (ambitious)

**What it does**: The relay becomes a triple-protocol bridge: HTTP, Nostr, and Solid. Events flow bidirectionally between all three. Each participant can choose their storage and transport preference.

**How it works**:
1. **Triple bridge**: HTTP messages create both Nostr events and Solid resources. Nostr events arriving from external relays also write to Solid. Solid Notifications trigger Nostr events.
2. **WebID-to-Nostr binding**: Extend the current `nostrPubkeys` table to include WebID URIs. A participant is identified by `(Bearer token, Nostr pubkey, WebID)`.
3. **Cross-pod session discovery**: Use the Solid Type Index to register relay sessions. Other Solid apps can discover sessions by querying the Type Index.
4. **Federated sessions**: Participants can bring their own Pods. Session data is distributed across multiple Pods, with each participant's messages stored in their own Pod.
5. **Solid Notifications**: Subscribe to Pod containers via WebSocketChannel2023 for real-time updates when a participant writes a message to their Pod.

**Architecture**:
```
                              Hono HTTP Server
                                    |
               +--------------------+--------------------+
               |                    |                    |
          Nostr Bridge         Solid Bridge         SQLite Store
               |                    |                    |
        External Relays       User Pods (N)         Local cache
               |                    |
        (gossip/fanout)      (persistent/owned)
```

**New tables** in SQLite:
```sql
CREATE TABLE solid_bindings (
  session_id TEXT NOT NULL,
  webid      TEXT NOT NULL,
  pod_url    TEXT NOT NULL,
  token      TEXT NOT NULL,
  PRIMARY KEY (session_id, webid),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

**New Nostr tag**: `["webid", "https://pod.example/alice/profile/card#me"]` on relay events, enabling cross-protocol identity resolution.

**Challenges**:
- Significant complexity increase (three-way sync, conflict resolution)
- Multi-pod writes require coordinating access tokens for each participant's Pod
- Solid Notifications spec is less mature than Nostr WebSocket subscriptions
- Cross-pod authorization requires each participant to grant the relay access

**Effort**: ~3-4 weeks. High risk. Should only be attempted after Level 1 is proven.

---

## 4. Data Model Mapping

### 4.1 Relay Vocabulary

Define a custom RDF vocabulary at `https://vocab.claude-relay.dev/` for relay-specific terms.

```turtle
# Vocabulary definition (would live at https://vocab.claude-relay.dev/ontology.ttl)

@prefix relay: <https://vocab.claude-relay.dev/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

relay:Session a rdfs:Class ;
  rdfs:label "Relay Session" ;
  rdfs:comment "A collaborative session between humans and AI agents" .

relay:Message a rdfs:Class ;
  rdfs:label "Relay Message" ;
  rdfs:comment "A knowledge message exchanged within a session" .

relay:Participant a rdfs:Class ;
  rdfs:label "Session Participant" ;
  rdfs:comment "An agent participating in a relay session" .
```

### 4.2 Session as RDF (Turtle)

```turtle
# Session: stored at <pod>/relay-sessions/abc123/metadata.ttl

@prefix relay: <https://vocab.claude-relay.dev/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

<#session>
  a relay:Session ;
  dcterms:identifier "abc123" ;
  dcterms:title "my-session" ;
  dcterms:created "2026-03-30T00:00:00Z"^^xsd:dateTime ;
  relay:expiresAt "2026-03-30T01:00:00Z"^^xsd:dateTime ;
  relay:lastActivityAt "2026-03-30T00:30:00Z"^^xsd:dateTime ;
  relay:sequenceCounter 42 ;
  relay:inviteToken "uuid-invite-token" ;
  relay:participant <#creator>, <#participant-1> .

<#creator>
  a relay:Participant ;
  foaf:name "creator" ;
  relay:role "creator" ;
  relay:joinedAt "2026-03-30T00:00:00Z"^^xsd:dateTime .

<#participant-1>
  a relay:Participant ;
  foaf:name "worker-claude" ;
  foaf:webid <https://pod.example/bob/profile/card#me> ;
  relay:role "participant" ;
  relay:nostrPubkey "abc123def456..." ;
  relay:joinedAt "2026-03-30T00:01:00Z"^^xsd:dateTime .
```

### 4.3 Session as JSON-LD

```json
{
  "@context": {
    "relay": "https://vocab.claude-relay.dev/",
    "dcterms": "http://purl.org/dc/terms/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "xsd": "http://www.w3.org/2001/XMLSchema#"
  },
  "@id": "#session",
  "@type": "relay:Session",
  "dcterms:identifier": "abc123",
  "dcterms:title": "my-session",
  "dcterms:created": {
    "@value": "2026-03-30T00:00:00Z",
    "@type": "xsd:dateTime"
  },
  "relay:expiresAt": {
    "@value": "2026-03-30T01:00:00Z",
    "@type": "xsd:dateTime"
  },
  "relay:participant": [
    {
      "@id": "#creator",
      "@type": "relay:Participant",
      "foaf:name": "creator",
      "relay:role": "creator"
    },
    {
      "@id": "#participant-1",
      "@type": "relay:Participant",
      "foaf:name": "worker-claude",
      "foaf:webid": { "@id": "https://pod.example/bob/profile/card#me" },
      "relay:nostrPubkey": "abc123def456..."
    }
  ]
}
```

### 4.4 All 14 Message Types as RDF Classes

Each message type from `constants.ts` maps to an RDF subclass of `relay:Message`:

```turtle
@prefix relay: <https://vocab.claude-relay.dev/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# Core message types (6)
relay:ArchitectureMessage  a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Architecture" .
relay:ApiDocsMessage       a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "API Docs" .
relay:PatternsMessage      a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Patterns" .
relay:ConventionsMessage   a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Conventions" .
relay:QuestionMessage      a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Question" .
relay:AnswerMessage        a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Answer" .

# Extended message types (3)
relay:ContextMessage       a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Context" .
relay:InsightMessage       a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Insight" .
relay:TaskMessage          a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Task" .

# Workspace message types (5)
relay:FileTreeMessage      a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "File Tree" .
relay:FileChangeMessage    a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "File Change" .
relay:FileReadMessage      a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "File Read" .
relay:TerminalMessage      a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Terminal" .
relay:StatusUpdateMessage  a rdfs:Class ; rdfs:subClassOf relay:Message ; rdfs:label "Status Update" .
```

### 4.5 Message as RDF (Turtle)

```turtle
# Message: stored at <pod>/relay-sessions/abc123/msg-001.ttl

@prefix relay: <https://vocab.claude-relay.dev/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<#msg>
  a relay:ArchitectureMessage ;
  dcterms:identifier "msg-uuid-001" ;
  relay:sequence 1 ;
  dcterms:title "System architecture overview" ;
  relay:content "## Architecture\n\nThe system uses..." ;
  relay:senderName "creator" ;
  dcterms:created "2026-03-30T00:05:00Z"^^xsd:dateTime ;
  relay:tag "hono", "typescript", "bun" ;
  relay:fileReference [
    relay:filePath "packages/relay-server/src/index.ts" ;
    relay:lineRange "1-50" ;
    relay:note "Server entry point"
  ] ;
  relay:context [
    relay:project "claude-relay" ;
    relay:stack "Bun, Hono, Zod" ;
    relay:branch "master"
  ] .
```

### 4.6 Message as JSON-LD

```json
{
  "@context": "https://vocab.claude-relay.dev/context.jsonld",
  "@id": "#msg",
  "@type": "ArchitectureMessage",
  "identifier": "msg-uuid-001",
  "sequence": 1,
  "title": "System architecture overview",
  "content": "## Architecture\n\nThe system uses...",
  "senderName": "creator",
  "created": "2026-03-30T00:05:00Z",
  "tag": ["hono", "typescript", "bun"],
  "fileReference": [
    {
      "filePath": "packages/relay-server/src/index.ts",
      "lineRange": "1-50",
      "note": "Server entry point"
    }
  ],
  "context": {
    "project": "claude-relay",
    "stack": "Bun, Hono, Zod",
    "branch": "master"
  }
}
```

### 4.7 Message Type to RDF Class Mapping Table

| Message Type (constants.ts) | Nostr Kind | RDF Class | JSON-LD `@type` |
|-----------------------------|------------|-----------|-----------------|
| `architecture` | 4190 | `relay:ArchitectureMessage` | `"ArchitectureMessage"` |
| `api-docs` | 4191 | `relay:ApiDocsMessage` | `"ApiDocsMessage"` |
| `patterns` | 4192 | `relay:PatternsMessage` | `"PatternsMessage"` |
| `conventions` | 4193 | `relay:ConventionsMessage` | `"ConventionsMessage"` |
| `question` | 4194 | `relay:QuestionMessage` | `"QuestionMessage"` |
| `answer` | 4195 | `relay:AnswerMessage` | `"AnswerMessage"` |
| `context` | 4196 | `relay:ContextMessage` | `"ContextMessage"` |
| `insight` | 4197 | `relay:InsightMessage` | `"InsightMessage"` |
| `task` | 4198 | `relay:TaskMessage` | `"TaskMessage"` |
| `file_tree` | 4200 | `relay:FileTreeMessage` | `"FileTreeMessage"` |
| `file_change` | 4201 | `relay:FileChangeMessage` | `"FileChangeMessage"` |
| `file_read` | 4202 | `relay:FileReadMessage` | `"FileReadMessage"` |
| `terminal` | 4203 | `relay:TerminalMessage` | `"TerminalMessage"` |
| `status_update` | 4204 | `relay:StatusUpdateMessage` | `"StatusUpdateMessage"` |

### 4.8 Container Layout on the Pod

```
<pod>/relay-sessions/                    -- root container for all relay data
  abc123/                                -- session container
    .acl                                 -- WAC rules for this session
    metadata.jsonld                      -- session info (name, participants, timestamps)
    messages/                            -- message container
      001-architecture.jsonld            -- sequence-prefixed for ordering
      002-question.jsonld
      003-answer.jsonld
      ...
    files/                               -- shared workspace files (optional, Level 2+)
      file-tree.jsonld                   -- latest file tree snapshot
```

---

## 5. Implementation Sketch (Level 1)

### 5.1 Dependencies

```bash
bun add @inrupt/solid-client @inrupt/solid-client-authn-node
```

| Package | Purpose | Size |
|---------|---------|------|
| `@inrupt/solid-client` | CRUD operations on Pod resources/containers | ~150KB |
| `@inrupt/solid-client-authn-node` | Solid-OIDC authentication (Node.js) | ~200KB |

These libraries target ES2018+ and work with Bun's Node.js compatibility layer.

### 5.2 Solid Configuration Types

New file: `packages/shared/src/solid-types.ts`

```typescript
/** Configuration for exporting to a Solid Pod */
export interface SolidExportConfig {
  /** The user's Pod URL (e.g., "https://pod.example/alice/") */
  podUrl: string;
  /** OIDC issuer for authentication */
  oidcIssuer: string;
  /** Client ID (from static registration with the Pod's OIDC provider) */
  clientId: string;
  /** Client secret */
  clientSecret: string;
  /** Container path within the Pod for relay data (default: "relay-sessions/") */
  containerPath?: string;
}

/** Result of a Solid export operation */
export interface SolidExportResult {
  /** URL of the created session container on the Pod */
  containerUrl: string;
  /** Number of messages exported */
  messageCount: number;
  /** URL of the session metadata resource */
  metadataUrl: string;
  /** Timestamp of the export */
  exportedAt: string;
}

/** Relay vocabulary namespace */
export const RELAY_VOCAB = "https://vocab.claude-relay.dev/" as const;

/** Message type to RDF class mapping */
export const MESSAGE_TYPE_TO_RDF_CLASS: Record<string, string> = {
  architecture: "ArchitectureMessage",
  "api-docs": "ApiDocsMessage",
  patterns: "PatternsMessage",
  conventions: "ConventionsMessage",
  question: "QuestionMessage",
  answer: "AnswerMessage",
  context: "ContextMessage",
  insight: "InsightMessage",
  task: "TaskMessage",
  file_tree: "FileTreeMessage",
  file_change: "FileChangeMessage",
  file_read: "FileReadMessage",
  terminal: "TerminalMessage",
  status_update: "StatusUpdateMessage",
};
```

### 5.3 Solid Authentication Helper

New file: `packages/relay-server/src/solid/auth.ts`

```typescript
import { Session } from "@inrupt/solid-client-authn-node";
import type { SolidExportConfig } from "@claude-relay/shared";

/** Cache of authenticated sessions keyed by podUrl */
const sessionCache = new Map<string, Session>();

/**
 * Get an authenticated Solid session using client credentials.
 * Sessions are cached and automatically refreshed by the library.
 */
export async function getAuthenticatedSession(
  config: SolidExportConfig
): Promise<Session> {
  const cacheKey = `${config.podUrl}:${config.clientId}`;

  const cached = sessionCache.get(cacheKey);
  if (cached?.info.isLoggedIn) {
    return cached;
  }

  const session = new Session();

  await session.login({
    oidcIssuer: config.oidcIssuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // No redirect needed for server-side client credentials flow
  });

  if (!session.info.isLoggedIn) {
    throw new Error(
      `Failed to authenticate with Solid Pod at ${config.podUrl} ` +
      `(issuer: ${config.oidcIssuer})`
    );
  }

  sessionCache.set(cacheKey, session);
  console.log(`[solid] Authenticated as ${session.info.webId}`);
  return session;
}

/** Clear cached sessions (for testing or shutdown) */
export function clearSessionCache(): void {
  for (const session of sessionCache.values()) {
    session.logout();
  }
  sessionCache.clear();
}
```

### 5.4 Solid Export Logic

New file: `packages/relay-server/src/solid/export.ts`

```typescript
import {
  createContainerAt,
  getSolidDataset,
  saveSolidDatasetAt,
  createSolidDataset,
  createThing,
  setThing,
  buildThing,
  setStringNoLocale,
  setInteger,
  setDatetime,
  setUrl,
  addStringNoLocale,
} from "@inrupt/solid-client";
import { DCTERMS, FOAF, RDF } from "@inrupt/vocab-common-rdf";
import type { Session as SolidSession } from "@inrupt/solid-client-authn-node";
import type { StoredMessage } from "@claude-relay/shared";
import {
  RELAY_VOCAB,
  MESSAGE_TYPE_TO_RDF_CLASS,
  type SolidExportConfig,
  type SolidExportResult,
} from "@claude-relay/shared";
import { getAuthenticatedSession } from "./auth.js";
import { getSession, getMessages } from "../store/sqlite.js";

/**
 * Export a relay session to a Solid Pod.
 *
 * Creates:
 *   <pod>/<containerPath>/<sessionId>/metadata.jsonld
 *   <pod>/<containerPath>/<sessionId>/messages/<seq>-<type>.jsonld
 */
export async function exportSessionToPod(
  sessionId: string,
  config: SolidExportConfig
): Promise<SolidExportResult> {
  // 1. Authenticate with the Pod
  const solidSession = await getAuthenticatedSession(config);
  const fetch = solidSession.fetch;

  // 2. Load the relay session from SQLite
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // 3. Fetch all messages
  const allMessages: StoredMessage[] = [];
  let cursor = 0;
  while (true) {
    const batch = getMessages(sessionId, cursor, 200);
    allMessages.push(...batch.messages);
    cursor = batch.cursor;
    if (!batch.has_more) break;
  }

  // 4. Create the session container on the Pod
  const containerPath = config.containerPath || "relay-sessions/";
  const baseUrl = config.podUrl.endsWith("/")
    ? config.podUrl
    : config.podUrl + "/";
  const sessionContainerUrl = `${baseUrl}${containerPath}${sessionId}/`;
  const messagesContainerUrl = `${sessionContainerUrl}messages/`;

  await createContainerAt(sessionContainerUrl, { fetch });
  await createContainerAt(messagesContainerUrl, { fetch });

  // 5. Write session metadata
  const metadataUrl = `${sessionContainerUrl}metadata.jsonld`;
  let metadataDataset = createSolidDataset();

  const sessionThing = buildThing(createThing({ name: "session" }))
    .setUrl(RDF.type, `${RELAY_VOCAB}Session`)
    .setStringNoLocale(DCTERMS.identifier, session.id)
    .setStringNoLocale(DCTERMS.title, session.name)
    .setDatetime(DCTERMS.created, session.createdAt)
    .setDatetime(`${RELAY_VOCAB}expiresAt`, session.expiresAt)
    .setDatetime(`${RELAY_VOCAB}lastActivityAt`, session.lastActivityAt)
    .setInteger(`${RELAY_VOCAB}sequenceCounter`, session.sequenceCounter)
    .setInteger(`${RELAY_VOCAB}messageCount`, allMessages.length)
    .build();

  metadataDataset = setThing(metadataDataset, sessionThing);

  // Add participant info
  const participantNames = ["creator"];
  for (const [, info] of session.participants) {
    participantNames.push(info.name || "anonymous");

    const participantThing = buildThing(
      createThing({ name: `participant-${info.name}` })
    )
      .setUrl(RDF.type, `${RELAY_VOCAB}Participant`)
      .setStringNoLocale(FOAF.name, info.name || "anonymous")
      .setDatetime(`${RELAY_VOCAB}joinedAt`, info.joinedAt)
      .build();

    metadataDataset = setThing(metadataDataset, participantThing);
  }

  await saveSolidDatasetAt(metadataUrl, metadataDataset, { fetch });

  // 6. Write each message as an individual resource
  for (const msg of allMessages) {
    const rdfClass =
      MESSAGE_TYPE_TO_RDF_CLASS[msg.type] || "ContextMessage";
    const filename = `${String(msg.sequence).padStart(4, "0")}-${msg.type}.jsonld`;
    const messageUrl = `${messagesContainerUrl}${filename}`;

    let msgDataset = createSolidDataset();

    let thingBuilder = buildThing(createThing({ name: "msg" }))
      .setUrl(RDF.type, `${RELAY_VOCAB}${rdfClass}`)
      .setStringNoLocale(DCTERMS.identifier, msg.message_id)
      .setInteger(`${RELAY_VOCAB}sequence`, msg.sequence)
      .setStringNoLocale(`${RELAY_VOCAB}messageType`, msg.type)
      .setStringNoLocale(DCTERMS.title, msg.title || "")
      .setStringNoLocale(`${RELAY_VOCAB}content`, msg.content)
      .setStringNoLocale(DCTERMS.created, msg.sent_at);

    if (msg.sender_name) {
      thingBuilder = thingBuilder.setStringNoLocale(
        `${RELAY_VOCAB}senderName`,
        msg.sender_name
      );
    }

    if (msg.tags) {
      for (const tag of msg.tags) {
        thingBuilder = thingBuilder.addStringNoLocale(
          `${RELAY_VOCAB}tag`,
          tag
        );
      }
    }

    if (msg.nostr_event_id) {
      thingBuilder = thingBuilder.setStringNoLocale(
        `${RELAY_VOCAB}nostrEventId`,
        msg.nostr_event_id
      );
    }

    // File references stored as blank-node-style nested Things
    if (msg.references) {
      for (let i = 0; i < msg.references.length; i++) {
        const ref = msg.references[i];
        const refThing = buildThing(createThing({ name: `ref-${i}` }))
          .setUrl(RDF.type, `${RELAY_VOCAB}FileReference`)
          .setStringNoLocale(`${RELAY_VOCAB}filePath`, ref.file)
          .build();
        msgDataset = setThing(msgDataset, refThing);

        thingBuilder = thingBuilder.setUrl(
          `${RELAY_VOCAB}fileReference`,
          `#ref-${i}`
        );
      }
    }

    const messageThing = thingBuilder.build();
    msgDataset = setThing(msgDataset, messageThing);

    await saveSolidDatasetAt(messageUrl, msgDataset, { fetch });
  }

  const result: SolidExportResult = {
    containerUrl: sessionContainerUrl,
    messageCount: allMessages.length,
    metadataUrl,
    exportedAt: new Date().toISOString(),
  };

  console.log(
    `[solid] Exported session ${sessionId} to ${sessionContainerUrl} ` +
    `(${allMessages.length} messages)`
  );

  return result;
}
```

### 5.5 New Route

Add to `packages/relay-server/src/routes/relay.ts`:

```typescript
import { exportSessionToPod } from "../solid/export.js";
import type { SolidExportConfig } from "@claude-relay/shared";

// POST /relay/:session_id/export-to-pod -- export session to a Solid Pod
relayRoutes.post("/:session_id/export-to-pod", async (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));

  // Validate required Solid config fields
  const { pod_url, oidc_issuer, client_id, client_secret, container_path } = body;
  if (!pod_url || !oidc_issuer || !client_id || !client_secret) {
    return c.json({
      error: "Missing required fields: pod_url, oidc_issuer, client_id, client_secret",
    }, 400);
  }

  const config: SolidExportConfig = {
    podUrl: pod_url,
    oidcIssuer: oidc_issuer,
    clientId: client_id,
    clientSecret: client_secret,
    containerPath: container_path,
  };

  try {
    const result = await exportSessionToPod(sessionId, config);
    return c.json(result, 201);
  } catch (err: any) {
    console.error(`[solid] Export failed for ${sessionId}:`, err);
    return c.json({ error: `Export failed: ${err.message}` }, 500);
  }
});
```

### 5.6 MCP Tool Extension

Add a new MCP tool `relay_export_pod` in the MCP server, or extend `relay_status` to include a Solid export action. The MCP tool would call the relay server's `/export-to-pod` endpoint.

### 5.7 Usage Flow

```
1. User sets up a Solid Pod (e.g., via Community Solid Server)
   $ npx @solid/community-server -c @css:config/file.json -f ./pod-data/ -p 3001

2. User registers a client application on the CSS to get client_id + client_secret

3. Session completes; user exports:
   $ curl -X POST http://localhost:4190/relay/SESSION_ID/export-to-pod \
     -H "Authorization: Bearer CREATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "pod_url": "http://localhost:3001/alice/",
       "oidc_issuer": "http://localhost:3001/",
       "client_id": "my-relay-app",
       "client_secret": "secret123",
       "container_path": "relay-sessions/"
     }'

4. Session data is now at:
   http://localhost:3001/alice/relay-sessions/SESSION_ID/metadata.jsonld
   http://localhost:3001/alice/relay-sessions/SESSION_ID/messages/0001-architecture.jsonld
   http://localhost:3001/alice/relay-sessions/SESSION_ID/messages/0002-question.jsonld
   ...
```

---

## 6. Solid + Nostr Synergy

### 6.1 Complementary Strengths

Solid and Nostr are not competing protocols -- they solve fundamentally different problems and complement each other with minimal overlap:

| Concern | Nostr | Solid |
|---------|-------|-------|
| **Real-time messaging** | Native (WebSocket subscriptions, instant relay) | Not native (Notifications spec is newer, higher latency) |
| **Data persistence** | Not guaranteed (relays can drop events) | Native (Pod = your data, you control retention) |
| **Data ownership** | None (relays hold the data, can censor) | Full (data lives in your Pod, you set access) |
| **Identity portability** | Strong (keypair-based, no server dependency) | Strong (WebID-based, self-hosted possible) |
| **Structured data** | Weak (flat JSON, no schema enforcement) | Strong (RDF, formal ontologies, SPARQL queryable) |
| **Censorship resistance** | Strong (multi-relay fanout) | Weak (single Pod provider) |
| **Cross-app interop** | Limited (NIP-based, app-specific kinds) | Strong (Linked Data, shared vocabularies) |

### 6.2 The Three-Layer Model

For claude-relay, the three protocols serve distinct architectural layers:

```
Layer 3: STORAGE    -- Solid Pods   -- "Where does the data live permanently?"
Layer 2: TRANSPORT  -- Nostr relays -- "How do events travel between participants?"
Layer 1: INTERFACE  -- HTTP API     -- "How do apps interact with the system?"
```

- **HTTP** is the synchronous API layer (request/response, CRUD, MCP tools)
- **Nostr** is the asynchronous gossip layer (event fanout, external relay federation, real-time)
- **Solid** is the persistence and ownership layer (durable storage, access control, data portability)

### 6.3 Concrete Use Cases

**Use case 1: Archival**
During an active session, messages flow through HTTP and Nostr. When the session ends (or the TTL expires), the relay exports the transcript to the creator's Solid Pod. The data survives server restarts, relay shutdowns, and even the relay itself being decommissioned. The Pod owner can share the session with any Solid-compatible app.

**Use case 2: Cross-session knowledge graph**
Solid's RDF model enables linking messages across sessions. A message in Session B can reference a message in Session A via URI:
```turtle
<#msg-in-session-B> relay:references <https://pod.example/relay-sessions/session-A/messages/0042-insight.jsonld#msg> .
```
This creates a knowledge graph of relay conversations that can be queried with SPARQL -- impossible with flat Nostr events or SQLite rows.

**Use case 3: Decentralized session resumption**
If the relay server goes down, participants can still access the session transcript from their Pods. A new relay instance can import the Pod data to resume the session. Combined with Nostr, the relay can discover the latest state from both Pod archives and relay event history.

**Use case 4: Multi-organization collaboration**
Two companies each running their own relay servers and Solid Pods. Their Claude instances collaborate through Nostr (gossip), with each company's session data stored exclusively in their own Pod (data sovereignty). The relay vocabulary ensures both sides interpret the data identically.

### 6.4 Identity Binding

The current relay binds Nostr pubkeys to session tokens via the `nostr_pubkeys` table. Solid adds a third identity dimension:

```
Bearer Token  <-->  Nostr Pubkey  <-->  WebID
(relay-local)       (Schnorr key)       (HTTP URI)
```

This triple binding means a participant can be identified from any of the three protocols. The session metadata stores all three:

```turtle
<#participant-1>
  a relay:Participant ;
  relay:bearerToken "uuid-token" ;       # relay-scoped
  relay:nostrPubkey "hex-pubkey..." ;     # Nostr-scoped
  foaf:webid <https://pod.example/...> ; # Solid-scoped (global, dereferenceable)
```

---

## 7. Challenges & Trade-offs

### 7.1 Latency

| Operation | SQLite | Solid Pod (local CSS) | Solid Pod (remote/cloud) |
|-----------|--------|----------------------|--------------------------|
| Write message | <1ms | 30-80ms | 100-300ms |
| Read 10 messages | <1ms | 50-150ms | 200-500ms |
| Create session | <1ms | 100-200ms | 300-600ms |

SQLite is 100-1000x faster for the hot path. **Mitigation**: Use SQLite as the primary store and Solid as an async export/backup (Level 1). Only move to Solid as primary storage (Level 2) if latency is acceptable for the use case.

### 7.2 Complexity: Authentication

| Auth Model | claude-relay (current) | Solid-OIDC |
|------------|----------------------|------------|
| Setup | Zero-config (server generates UUID tokens) | Register OIDC client, configure issuer, manage secrets |
| Token type | UUID Bearer token | DPoP-bound OIDC ID Token |
| Token lifetime | Session TTL (1-24h) | Access token expiry + refresh |
| Validation | O(1) Map lookup | HTTP round-trip to WebID, OIDC discovery, key verification |
| Dependencies | None | `@inrupt/solid-client-authn-node` (~200KB) |

Solid-OIDC is significantly more complex. For Level 1 (export only), this complexity is contained in one module. For Level 2 (primary storage), it permeates the entire auth model.

### 7.3 Ecosystem Maturity

| Aspect | Nostr | Solid |
|--------|-------|-------|
| Client libraries (JS) | nostr-tools (mature, many alternatives) | @inrupt/solid-client (primary, maintained by Inrupt) |
| Server implementations | Dozens (strfry, relay.tools, etc.) | CSS (primary), Node Solid Server (legacy), Inrupt ESS (commercial) |
| Developer community | Large, grassroots, fast-moving | Smaller, academic/enterprise, spec-driven |
| Documentation | Good (NIPs are readable) | Good but scattered (Inrupt docs, W3C specs, community forum) |
| Breaking changes | Rare (NIPs are stable once accepted) | More frequent (spec still evolving) |
| Production deployments | Many (Damus, Primal, Amethyst, etc.) | Few at scale (Flanders government, NHS pilot) |

### 7.4 Self-Hosting

**Community Solid Server (CSS)**:
- Node.js 18+ (or Docker)
- `npx @solid/community-server` to start
- File-based or in-memory storage
- Configurable via JSON-LD config files
- Port 3000 default (configurable)
- Good for development and small deployments

**Cloud Pods**:
- Inrupt PodSpaces (commercial, managed)
- solidcommunity.net (free, community-run -- limited reliability)

For claude-relay's development phase, a local CSS instance alongside the relay server is the pragmatic choice. Docker Compose could bundle both.

### 7.5 RDF Learning Curve

RDF/Turtle/JSON-LD has a genuine learning curve for developers accustomed to JSON APIs. Key friction points:

- Understanding triples (subject-predicate-object) vs key-value pairs
- Namespaces and prefix declarations
- The difference between a Thing, a Dataset, and a Resource
- Blank nodes and named nodes
- Content negotiation (Turtle vs JSON-LD vs N-Triples)

**Mitigation**: The `@inrupt/solid-client` library abstracts most RDF complexity. The code in Section 5 uses `buildThing()`, `setStringNoLocale()`, etc. -- developers don't need to write raw Turtle.

### 7.6 Operational Overhead

Running a Solid Pod adds another service to manage:
- CSS process (or Docker container) alongside the relay server
- Pod data directory backup
- OIDC issuer configuration
- ACL management for each session

For a single-user development setup, this is manageable. For a multi-user production deployment, it requires careful orchestration.

---

## 8. Recommendation

### Current State Assessment

Claude-relay is at v0.3.0 with:
- SQLite persistence (shipped in Sprint 2)
- Nostr bridge (shipped in Sprint 2, bidirectional)
- 14 message types, 7 MCP tools
- Dashboard with Director and Peer modes
- Export endpoint (JSON and Markdown formats)

The project is in active Phase 4 development (4-party collaborative mode) with Phase 5 (persistence) already partially addressed by SQLite.

### Pragmatic Path: Level 1 First

**Start with Level 1 (Pod as Export Target).** Reasons:

1. **Low risk, high learning value**: The implementation is contained (~300 lines of new code), additive (nothing existing changes), and teaches the team Solid fundamentals.

2. **Natural extension of existing export**: The `GET /relay/:id/export` endpoint already serializes sessions as JSON and Markdown. Adding Solid Pod export is the same operation with a different target.

3. **Follows the Nostr bridge pattern**: The existing `bridge.ts` architecture (bidirectional protocol translation, contained in its own module) is the template for `solid/export.ts`.

4. **Unblocks future levels**: Once Level 1 works, Level 2 is a matter of moving from "export after session" to "write during session." The auth, serialization, and container logic are reusable.

5. **Defers complexity**: Solid-OIDC, WAC management, and Pod-as-primary-store are all deferred until the team is comfortable with the basics.

**Do not attempt Level 2 or Level 3 until**:
- Level 1 is working and tested against both CSS and a cloud Pod provider
- Phase 4 (4-party mode) is stable -- it changes the session model significantly
- There is a concrete use case that requires Pod-as-primary (e.g., data sovereignty requirement, cross-relay session resumption)

### When Level 2 Makes Sense

Level 2 (Pod as persistent storage) becomes compelling when:
- Users want to own their session data (not just export it)
- The relay needs to survive total data loss (Pod = offsite backup)
- Multi-organization deployments require data sovereignty
- A Solid-native mobile client (the iOS relay client from `docs/ios-relay-client.md`) wants direct Pod access

### When Level 3 Makes Sense

Level 3 (federated triple bridge) is a research project, not a sprint. It becomes relevant when:
- Multiple relay instances need to share session state
- Cross-organization collaboration requires each party to control their own data
- The Solid Notifications spec matures to the point where it can replace/supplement SSE

---

## 9. Sprint Plan

### 1-Week Sprint: Level 1 Implementation

Assumes Solid basics are new to the developer. Calendar days, not effort-hours.

#### Day 1-2: Foundation (P0)

- [ ] **P0**: Install and run Community Solid Server locally
  - `npx @solid/community-server -c @css:config/file.json -f ./pod-data/ -p 3001`
  - Create a test Pod and account via the CSS web UI
  - Register a client application (client_id + client_secret)
  - Verify read/write with curl

- [ ] **P0**: Add npm dependencies
  - `bun add @inrupt/solid-client @inrupt/solid-client-authn-node`
  - Verify Bun compatibility (both packages target ES2018+, should work)

- [ ] **P0**: Create `packages/shared/src/solid-types.ts`
  - `SolidExportConfig`, `SolidExportResult`, `RELAY_VOCAB`, `MESSAGE_TYPE_TO_RDF_CLASS`
  - Export from `packages/shared/src/index.ts`

#### Day 3-4: Core Implementation (P0)

- [ ] **P0**: Create `packages/relay-server/src/solid/auth.ts`
  - Client credentials authentication with session caching
  - Error handling for auth failures
  - Logout/cleanup on server shutdown

- [ ] **P0**: Create `packages/relay-server/src/solid/export.ts`
  - `exportSessionToPod()` function
  - Session metadata serialization as JSON-LD
  - Message serialization (all 14 types)
  - Container creation (session + messages)

- [ ] **P0**: Add route `POST /relay/:id/export-to-pod` in `relay.ts`
  - Input validation for Solid config fields
  - Auth check (only session creator can export)
  - Call `exportSessionToPod()` and return result

#### Day 5: Testing & Polish (P1)

- [ ] **P1**: Manual end-to-end test
  - Create a relay session, send several messages of different types
  - Export to local CSS Pod
  - Verify the Pod contains correct containers and resources
  - Read back the resources and compare with SQLite data

- [ ] **P1**: Add docker-compose service for CSS
  - Add a `solid-pod` service to `docker-compose.yml`
  - Volume mount for Pod data persistence
  - Document the setup in CLAUDE.md

- [ ] **P1**: Update CLAUDE.md and technical-architecture.md
  - Document the new endpoint
  - Add Solid to the tech stack list
  - Describe the export flow

#### Day 5-7: Stretch Goals (P2)

- [ ] **P2**: JSON-LD context document
  - Create `https://vocab.claude-relay.dev/context.jsonld` (served by the relay or hosted statically)
  - Enables clean `@type: "ArchitectureMessage"` in exported JSON-LD

- [ ] **P2**: Dashboard "Export to Pod" button
  - Add a button in the dashboard session panel
  - Modal for entering Pod URL, OIDC issuer, client ID, client secret
  - Store config in localStorage for convenience
  - Progress indicator during export

- [ ] **P2**: MCP tool `relay_export_pod`
  - New tool in `packages/mcp-server/src/tools/`
  - Calls `/relay/:id/export-to-pod`
  - Claude Code can trigger exports directly

- [ ] **P2**: WAC rules on exported data
  - After creating the session container, write `.acl` with:
    - Creator: Read, Write, Control
    - Listed participants (by WebID): Read
  - Requires participants to have WebIDs (optional field in join)

---

## References

### Solid Protocol Specifications
- [Solid Protocol](https://solid.github.io/specification/protocol) -- core spec
- [Solid-OIDC](https://solid.github.io/solid-oidc/) -- authentication spec
- [Web Access Control (WAC)](https://solid.github.io/web-access-control-spec/) -- authorization spec
- [Solid Notifications Protocol](https://solid.github.io/notifications/protocol) -- real-time updates
- [WebSocketChannel2023](https://solid.github.io/notifications/websocket-channel-2023) -- WebSocket notification channel

### Developer Resources
- [Inrupt JavaScript Client Libraries](https://docs.inrupt.com/developer-tools/javascript/client-libraries/) -- official SDK docs
- [@inrupt/solid-client (npm)](https://www.npmjs.com/package/@inrupt/solid-client) -- Pod CRUD operations
- [@inrupt/solid-client-authn-node (npm)](https://www.npmjs.com/package/@inrupt/solid-client-authn-node) -- Node.js authentication
- [solid-client-js (GitHub)](https://github.com/inrupt/solid-client-js) -- library source

### Self-Hosting
- [Community Solid Server (GitHub)](https://github.com/CommunitySolidServer/CommunitySolidServer) -- open-source Pod server
- [CSS Getting Started Tutorial](https://github.com/CommunitySolidServer/tutorials/blob/main/getting-started.md)
- [CSS Docker Hub](https://hub.docker.com/r/solidproject/community-server) -- Docker images

### Background
- [Solid Project](https://solidproject.org/) -- project homepage
- [Solid (Wikipedia)](https://en.wikipedia.org/wiki/Solid_(web_decentralization_project)) -- overview
- [Inrupt](https://www.inrupt.com/solid) -- commercial Solid ecosystem
- [Tim Berners-Lee's Solid explained (TechTarget)](https://www.techtarget.com/whatis/feature/Tim-Berners-Lees-Solid-explained-What-you-need-to-know)

### Nostr Comparison
- [Solid (MIT)](https://solid.mit.edu/) -- original academic project
- [Nostr Protocol](https://nostr.com/) -- Nostr overview
- [Comparing Decentralized Social Protocols (Soapbox)](https://soapbox.pub/blog/comparing-protocols/) -- protocol comparison

---

*Document generated for claude-relay v0.3.0 | March 2026 | Research agent analysis*
