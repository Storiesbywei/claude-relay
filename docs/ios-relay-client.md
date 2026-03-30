# iOS Relay Client -- Implementation Guide

> Handoff document for building an iOS application that integrates with the claude-relay system.
> Based on source analysis of claude-relay v0.3.0 (packages/shared, packages/relay-server, packages/mcp-server).

---

## Table of Contents

1. [Protocol Summary](#1-protocol-summary)
2. [iOS Swift Implementation Guide](#2-ios-swift-implementation-guide)
3. [MCP Integration](#3-mcp-integration)
4. [Architecture Recommendation for iOS](#4-architecture-recommendation-for-ios)
5. [Event Kind Reference Table](#5-event-kind-reference-table)
6. [Security Considerations](#6-security-considerations)
7. [Quick Start Code](#7-quick-start-code)

---

## 1. Protocol Summary

The relay exposes three integration paths: HTTP REST, Nostr WebSocket, and SSE streaming. All three can be used independently or together. The server runs on port 4190 and accepts connections on `0.0.0.0`.

### 1.1 HTTP REST API

Base URL: `http://<host>:4190`

#### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Server status, session count, Nostr stats |
| `POST` | `/sessions` | None | Create a new session |
| `GET` | `/sessions/:id` | Bearer (creator/participant token) | Get session info |
| `POST` | `/sessions/:id/join` | Bearer (invite token) | Join a session |
| `POST` | `/relay/:id` | Bearer (creator/participant token) | Send a message |
| `GET` | `/relay/:id` | Bearer (creator/participant token) | Poll messages |
| `GET` | `/relay/:id/stream` | Bearer (creator/participant token) | SSE live stream |
| `GET` | `/relay/:id/export` | Bearer (creator/participant token) | Export session (JSON or Markdown) |
| `POST` | `/nostr/relays` | Bearer (any session token) | Connect to external Nostr relay |
| `GET` | `/nostr/relays` | Bearer (any session token) | List connected external relays |
| `DELETE` | `/nostr/relays/:url` | Bearer (any session token) | Disconnect from external relay (URL is base64-encoded) |

#### Authentication Model

All `/relay/*` and `/sessions/:id` (GET) endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Three token types exist:
- **Creator token** -- returned by `POST /sessions`, grants full access to the session.
- **Invite token** -- returned by `POST /sessions`, used only for `POST /sessions/:id/join`.
- **Participant token** -- returned by `POST /sessions/:id/join`, grants full access to the session.

Tokens are UUIDs. The server validates them using constant-time comparison. A token is scoped to a specific session -- you cannot use a token from session A to access session B.

#### Request/Response Schemas

**POST /sessions -- Create Session**

Request:
```json
{
  "name": "my-sync-session",
  "ttl_minutes": 60,
  "nostr_pubkey": "abc123...64hexchars"
}
```
- `name` (string, required): 1-100 characters
- `ttl_minutes` (int, optional): 1-1440, default 60
- `nostr_pubkey` (string, optional): 64-character lowercase hex public key to bind

Response (201):
```json
{
  "session_id": "uuid",
  "creator_token": "uuid",
  "invite_token": "uuid",
  "expires_at": "2026-03-29T12:00:00.000Z",
  "nostr_pubkey": "abc123...64hexchars"
}
```

**POST /sessions/:id/join -- Join Session**

Request (Authorization: Bearer `<invite_token>`):
```json
{
  "participant_name": "ios-client",
  "nostr_pubkey": "def456...64hexchars"
}
```
- `participant_name` (string, optional): max 100 characters
- `nostr_pubkey` (string, optional): 64-character hex

Response (200):
```json
{
  "participant_token": "uuid",
  "session": {
    "id": "uuid",
    "name": "my-sync-session",
    "participants": ["creator", "ios-client"],
    "message_count": 5,
    "expires_at": "2026-03-29T12:00:00.000Z",
    "nostr_pubkey": "def456..."
  }
}
```

**GET /sessions/:id -- Session Info**

Response (200):
```json
{
  "id": "uuid",
  "name": "my-sync-session",
  "participants": [
    { "name": "creator", "role": "creator", "joined_at": "..." },
    { "name": "ios-client", "role": "participant", "joined_at": "..." }
  ],
  "message_count": 5,
  "created_at": "...",
  "expires_at": "...",
  "last_activity_at": "..."
}
```

**POST /relay/:id -- Send Message**

Request:
```json
{
  "type": "context",
  "title": "Project Architecture",
  "content": "# Architecture\n\nThis project uses...",
  "tags": ["swift", "ios"],
  "references": [
    { "file": "src/App.swift", "lines": "1-50", "note": "Entry point" }
  ],
  "context": {
    "project": "voxlight",
    "stack": "Swift 6, SwiftUI",
    "branch": "dev"
  },
  "sender_name": "ios-app"
}
```

Field constraints:
- `type` (string, required): one of the 14 message types (see Section 5)
- `title` (string, optional): max 200 characters
- `content` (string, required): max 102,400 bytes (100KB)
- `tags` (string[], optional): max 20 tags, each max 50 characters
- `references` (object[], optional): max 50 items
- `context` (object, optional): project/stack/branch metadata
- `sender_name` (string, optional): overrides auto-detected sender name (max 100 chars)

Response (201):
```json
{
  "message_id": "uuid",
  "sequence": 7,
  "received_at": "2026-03-29T10:30:00.000Z"
}
```

**Content Scanning**: The server blocks messages containing sensitive patterns. If flagged, the response is:
```json
// 422 Unprocessable Entity
{
  "error": "Content blocked",
  "warnings": ["Potential sensitive content detected: \"sk-pro...key1\""]
}
```

Blocked patterns include: OpenAI/Anthropic keys (`sk-*`), GitHub PATs (`ghp_*`), AWS keys (`AKIA*`), Slack tokens (`xox*`), password/secret/api_key assignments, absolute paths (`/Users/*/`, `/home/*/`), Nostr `nsec` keys, bare hex private keys.

**GET /relay/:id -- Poll Messages**

Query parameters:
- `since` (int, default 0): return messages with sequence > since
- `limit` (int, default 10, max 50): max messages per response

Response (200):
```json
{
  "messages": [
    {
      "message_id": "uuid",
      "sequence": 1,
      "type": "context",
      "title": "Project Architecture",
      "content": "...",
      "tags": ["swift"],
      "references": [{ "file": "src/App.swift", "lines": "1-50" }],
      "context": { "project": "voxlight" },
      "sender_name": "creator",
      "sent_at": "2026-03-29T10:30:00.000Z"
    }
  ],
  "cursor": 1,
  "has_more": false
}
```

The `cursor` value should be passed as `since` on the next poll to get only new messages.

**GET /relay/:id/export -- Export Session**

Query parameters:
- `format` (string, default "json"): `json` or `md`/`markdown`

JSON response includes a `session` object, `messages` array, `exported_at` timestamp, and `message_count`.
Markdown response returns a `Content-Disposition: attachment` markdown file.

**Error Codes**

| Status | Meaning |
|--------|---------|
| 400 | Invalid request body / session full |
| 401 | Missing Authorization header |
| 403 | Invalid token for this session |
| 404 | Session not found |
| 422 | Content blocked by scanner |
| 429 | Rate limit exceeded |

Rate limit: 600 requests per minute per token. The 429 response includes:
```json
{
  "error": "Rate limit exceeded",
  "retry_after_seconds": 42
}
```

### 1.2 Nostr WebSocket Protocol

The relay implements NIP-01 (basic protocol), NIP-09 (event deletion), NIP-11 (relay info), NIP-42 (client authentication), and NIP-70 (protected events). The WebSocket endpoint is the same host/port as HTTP -- upgrade via standard `Upgrade: websocket` header.

WebSocket URL: `ws://<host>:4190`

#### NIP-11 Relay Information

Request `GET /` with `Accept: application/nostr+json`:
```json
{
  "name": "Claude Relay",
  "description": "Inter-Claude knowledge relay -- shared workspace for AI collaboration",
  "supported_nips": [1, 9, 11, 42, 70],
  "software": "claude-relay",
  "version": "0.2.0",
  "limitation": {
    "max_message_length": 102400,
    "max_subscriptions": 20,
    "max_filters": 10,
    "max_event_tags": 100,
    "auth_required": true,
    "payment_required": false
  }
}
```

#### NIP-42 Authentication Flow

1. Client connects via WebSocket.
2. Server immediately sends: `["AUTH", "<challenge>"]` where challenge is a UUID.
3. Client constructs a kind 22242 event with `["relay", "<relay_url>"]` and `["challenge", "<challenge>"]` tags, signs it, and sends: `["AUTH", <signed_event>]`.
4. Server validates: correct kind (22242), valid Schnorr signature, timestamp within 10 minutes, challenge match, relay URL match against canonical server URL.
5. Server responds: `["OK", "<event_id>", true, ""]` on success, or `["OK", "<event_id>", false, "auth-required: <reason>"]` on failure.
6. Each challenge can only be used once. If a challenge is reused, the server issues a new one.

**Critical**: `auth_required` is true -- you MUST authenticate before sending events (`EVENT`) or subscribing (`REQ`). Unauthenticated attempts are rejected.

#### Client-to-Relay Messages

```
["EVENT", <event>]           -- Publish an event
["REQ", "<sub_id>", <filter>, ...]  -- Subscribe (1+ filters)
["CLOSE", "<sub_id>"]        -- Unsubscribe
["AUTH", <event>]            -- NIP-42 auth response
```

#### Relay-to-Client Messages

```
["EVENT", "<sub_id>", <event>]      -- Event matching subscription
["OK", "<event_id>", <bool>, "<msg>"]  -- Publish result
["EOSE", "<sub_id>"]               -- End of stored events
["CLOSED", "<sub_id>", "<msg>"]     -- Subscription closed
["NOTICE", "<msg>"]                -- Human-readable notice
["AUTH", "<challenge>"]             -- Auth challenge
```

#### Nostr Event Structure (NIP-01)

```json
{
  "id": "32-byte-hex-sha256",
  "pubkey": "32-byte-hex-public-key",
  "created_at": 1711700000,
  "kind": 4196,
  "tags": [
    ["session", "uuid-session-id"],
    ["title", "My Message Title"],
    ["t", "context"],
    ["t", "swift"],
    ["sender", "ios-client"],
    ["r", "src/App.swift", "1-50", "Entry point"],
    ["project", "voxlight"],
    ["stack", "Swift 6"],
    ["branch", "dev"]
  ],
  "content": "The actual message content in markdown...",
  "sig": "64-byte-hex-schnorr-signature"
}
```

**Event ID computation** (per NIP-01): SHA256 of the JSON serialization `[0, <pubkey>, <created_at>, <kind>, <tags>, <content>]`.

**Signature**: Schnorr signature (BIP-340) over the event ID using the secp256k1 private key.

#### Subscription Filters

```json
{
  "ids": ["abc123..."],
  "authors": ["pubkey..."],
  "kinds": [4190, 4191, 4192],
  "since": 1711700000,
  "until": 1711800000,
  "limit": 100,
  "#session": ["uuid-session-id"],
  "#t": ["context", "architecture"]
}
```

All fields are optional. Multiple filters in a single REQ are OR-ed. Within a filter, all specified fields are AND-ed. Tag filters use `#<tagname>` syntax. The `limit` default is 500.

#### Server Validation Rules for Events

- Event pubkey must match authenticated identity (no impersonation)
- Schnorr signature must be valid
- Content max 100KB
- Max 100 tags
- `created_at` must be within -3600s to +900s of server time
- Rate limit: 10 messages per second per connection
- Max 100 concurrent WebSocket connections
- Max 20 subscriptions per connection
- Max 10 filters per subscription

#### Bidirectional Bridge

The relay bridges between HTTP and WebSocket:
- Messages sent via `POST /relay/:id` are converted to Nostr events and broadcast to WebSocket subscribers.
- Events published via WebSocket (kinds 4190-4204) with a `session` tag or pubkey binding are injected into the HTTP session store.
- Bridge events are tagged with `["bridge", "http"]` to prevent re-bridging loops.

### 1.3 SSE Streaming

Endpoint: `GET /relay/:id/stream`

Headers:
```
Authorization: Bearer <token>
Last-Event-ID: <sequence>    (optional, for reconnection catch-up)
```

Message format:
```
event: message
data: {"message_id":"uuid","sequence":7,"type":"context","title":"...","content":"...","sender_name":"creator","sent_at":"..."}
id: 7

event: ping
data:
```

- Each message has `event: message`, `data:` (JSON), and `id:` (sequence number).
- Heartbeat pings every 15 seconds to keep the connection alive.
- On reconnect, set `Last-Event-ID` to the last received sequence number. The server replays all messages with sequence > that value.

### 1.4 Limits Reference

| Constant | Value |
|----------|-------|
| `MAX_MESSAGE_SIZE` | 102,400 bytes (100KB) |
| `MAX_MESSAGES_PER_SESSION` | 200 |
| `MAX_SESSIONS` | 50 |
| `MAX_PARTICIPANTS` | 10 |
| `MAX_TITLE_LENGTH` | 200 chars |
| `MAX_TAGS` | 20 |
| `MAX_TAG_LENGTH` | 50 chars |
| `MAX_REFERENCES` | 50 |
| `RATE_LIMIT_PER_MINUTE` (HTTP) | 600 |
| `DEFAULT_TTL_MINUTES` | 60 |
| `MAX_TTL_MINUTES` | 1440 (24h) |
| `WS_RATE_LIMIT_PER_SECOND` | 10 |
| `MAX_WS_CONNECTIONS` | 100 |
| `MAX_SUBSCRIPTIONS` (per WS) | 20 |
| `MAX_FILTERS` (per REQ) | 10 |
| `MAX_EVENT_TAGS` | 100 |
| `MAX_EXTERNAL_RELAYS` | 10 |

---

## 2. iOS Swift Implementation Guide

### 2.1 Swift Codable Models

These structs are the Swift equivalents of the Zod schemas in `packages/shared/src/schema.ts` and `packages/shared/src/types.ts`.

```swift
import Foundation

// MARK: - Message Types

enum RelayMessageType: String, Codable, CaseIterable {
    // Core types
    case architecture
    case apiDocs = "api-docs"
    case patterns
    case conventions
    case question
    case answer
    case context
    case insight
    case task
    // Workspace types
    case fileTree = "file_tree"
    case fileChange = "file_change"
    case fileRead = "file_read"
    case terminal
    case statusUpdate = "status_update"
}

// MARK: - Request/Response Models

struct FileReference: Codable {
    let file: String
    var lines: String?
    var note: String?
}

struct MessageContext: Codable {
    var project: String?
    var stack: String?
    var branch: String?
}

struct RelayMessagePayload: Codable {
    let type: RelayMessageType
    var title: String?
    let content: String
    var tags: [String]?
    var references: [FileReference]?
    var context: MessageContext?
    var senderName: String?

    enum CodingKeys: String, CodingKey {
        case type, title, content, tags, references, context
        case senderName = "sender_name"
    }
}

struct StoredMessage: Codable, Identifiable {
    let messageId: String
    let sequence: Int
    let type: String
    let title: String
    let content: String
    var tags: [String]?
    var references: [FileReference]?
    var context: MessageContext?
    var senderName: String?
    let sentAt: String

    var id: String { messageId }

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case sequence, type, title, content, tags, references, context
        case senderName = "sender_name"
        case sentAt = "sent_at"
    }
}

struct CreateSessionRequest: Codable {
    let name: String
    var ttlMinutes: Int?
    var nostrPubkey: String?

    enum CodingKeys: String, CodingKey {
        case name
        case ttlMinutes = "ttl_minutes"
        case nostrPubkey = "nostr_pubkey"
    }
}

struct CreateSessionResponse: Codable {
    let sessionId: String
    let creatorToken: String
    let inviteToken: String
    let expiresAt: String
    var nostrPubkey: String?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case creatorToken = "creator_token"
        case inviteToken = "invite_token"
        case expiresAt = "expires_at"
        case nostrPubkey = "nostr_pubkey"
    }
}

struct JoinSessionRequest: Codable {
    var participantName: String?
    var nostrPubkey: String?

    enum CodingKeys: String, CodingKey {
        case participantName = "participant_name"
        case nostrPubkey = "nostr_pubkey"
    }
}

struct JoinSessionResponse: Codable {
    let participantToken: String
    let session: SessionSummary

    enum CodingKeys: String, CodingKey {
        case participantToken = "participant_token"
        case session
    }
}

struct SessionSummary: Codable {
    let id: String
    let name: String
    let participants: [String]
    let messageCount: Int
    let expiresAt: String
    var nostrPubkey: String?

    enum CodingKeys: String, CodingKey {
        case id, name, participants
        case messageCount = "message_count"
        case expiresAt = "expires_at"
        case nostrPubkey = "nostr_pubkey"
    }
}

struct ParticipantDetail: Codable {
    let name: String
    let role: String
    let joinedAt: String

    enum CodingKeys: String, CodingKey {
        case name, role
        case joinedAt = "joined_at"
    }
}

struct SessionInfo: Codable {
    let id: String
    let name: String
    let participants: [ParticipantDetail]
    let messageCount: Int
    let createdAt: String
    let expiresAt: String
    let lastActivityAt: String

    enum CodingKeys: String, CodingKey {
        case id, name, participants
        case messageCount = "message_count"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
        case lastActivityAt = "last_activity_at"
    }
}

struct PollResponse: Codable {
    let messages: [StoredMessage]
    let cursor: Int
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case messages, cursor
        case hasMore = "has_more"
    }
}

struct SendMessageResponse: Codable {
    let messageId: String
    let sequence: Int
    let receivedAt: String

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case sequence
        case receivedAt = "received_at"
    }
}

struct HealthResponse: Codable {
    let status: String
    let version: String
    let sessions: Int
    let uptimeSeconds: Int

    enum CodingKeys: String, CodingKey {
        case status, version, sessions
        case uptimeSeconds = "uptime_seconds"
    }
}

struct RelayError: Codable {
    let error: String
    var warnings: [String]?
    var retryAfterSeconds: Int?
    var details: [ValidationDetail]?

    enum CodingKeys: String, CodingKey {
        case error, warnings, details
        case retryAfterSeconds = "retry_after_seconds"
    }
}

struct ValidationDetail: Codable {
    let message: String
    var path: [String]?
}

struct ExportResponse: Codable {
    let session: ExportSessionInfo
    let messages: [ExportMessage]
    let exportedAt: String
    let messageCount: Int

    enum CodingKeys: String, CodingKey {
        case session, messages
        case exportedAt = "exported_at"
        case messageCount = "message_count"
    }
}

struct ExportSessionInfo: Codable {
    let id: String
    let name: String
    let createdAt: String
    let expiresAt: String
    let participants: [String]

    enum CodingKeys: String, CodingKey {
        case id, name, participants
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }
}

struct ExportMessage: Codable {
    let messageId: String
    let sequence: Int
    let type: String
    let title: String
    let content: String
    var senderName: String?
    let sentAt: String

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case sequence, type, title, content
        case senderName = "sender_name"
        case sentAt = "sent_at"
    }
}
```

### 2.2 HTTP REST Client (Path A)

```swift
import Foundation

enum RelayClientError: Error, LocalizedError {
    case unauthorized          // 401
    case forbidden             // 403
    case notFound              // 404
    case contentBlocked([String])  // 422
    case rateLimited(retryAfter: Int)  // 429
    case validationError(String)  // 400
    case serverError(Int, String)
    case networkError(Error)
    case decodingError(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Missing or invalid authorization"
        case .forbidden: return "Invalid token for this session"
        case .notFound: return "Session not found"
        case .contentBlocked(let warnings): return "Content blocked: \(warnings.joined(separator: ", "))"
        case .rateLimited(let seconds): return "Rate limited, retry after \(seconds)s"
        case .validationError(let msg): return "Validation error: \(msg)"
        case .serverError(let code, let msg): return "Server error (\(code)): \(msg)"
        case .networkError(let err): return "Network error: \(err.localizedDescription)"
        case .decodingError(let err): return "Decoding error: \(err.localizedDescription)"
        }
    }
}

actor RelayHTTPClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: - Session Management

    func createSession(
        name: String,
        ttlMinutes: Int = 60,
        nostrPubkey: String? = nil
    ) async throws -> CreateSessionResponse {
        let body = CreateSessionRequest(
            name: name,
            ttlMinutes: ttlMinutes,
            nostrPubkey: nostrPubkey
        )
        return try await post("/sessions", body: body)
    }

    func joinSession(
        sessionId: String,
        inviteToken: String,
        participantName: String? = nil,
        nostrPubkey: String? = nil
    ) async throws -> JoinSessionResponse {
        let body = JoinSessionRequest(
            participantName: participantName,
            nostrPubkey: nostrPubkey
        )
        return try await post(
            "/sessions/\(sessionId)/join",
            body: body,
            token: inviteToken
        )
    }

    func getSessionInfo(
        sessionId: String,
        token: String
    ) async throws -> SessionInfo {
        return try await get("/sessions/\(sessionId)", token: token)
    }

    // MARK: - Messaging

    func sendMessage(
        sessionId: String,
        token: String,
        payload: RelayMessagePayload
    ) async throws -> SendMessageResponse {
        return try await post(
            "/relay/\(sessionId)",
            body: payload,
            token: token
        )
    }

    func pollMessages(
        sessionId: String,
        token: String,
        since: Int = 0,
        limit: Int = 10
    ) async throws -> PollResponse {
        return try await get(
            "/relay/\(sessionId)?since=\(since)&limit=\(min(limit, 50))",
            token: token
        )
    }

    func exportSession(
        sessionId: String,
        token: String,
        format: String = "json"
    ) async throws -> ExportResponse {
        return try await get(
            "/relay/\(sessionId)/export?format=\(format)",
            token: token
        )
    }

    // MARK: - Health

    func healthCheck() async throws -> HealthResponse {
        return try await get("/health")
    }

    // MARK: - Internal HTTP

    private func get<T: Decodable>(
        _ path: String,
        token: String? = nil
    ) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return try await execute(request)
    }

    private func post<T: Decodable, B: Encodable>(
        _ path: String,
        body: B,
        token: String? = nil
    ) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return try await execute(request)
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw RelayClientError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw RelayClientError.serverError(0, "Invalid response")
        }

        switch httpResponse.statusCode {
        case 200...201:
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw RelayClientError.decodingError(error)
            }
        case 401:
            throw RelayClientError.unauthorized
        case 403:
            throw RelayClientError.forbidden
        case 404:
            throw RelayClientError.notFound
        case 422:
            if let err = try? decoder.decode(RelayError.self, from: data) {
                throw RelayClientError.contentBlocked(err.warnings ?? [err.error])
            }
            throw RelayClientError.contentBlocked(["Unknown content violation"])
        case 429:
            if let err = try? decoder.decode(RelayError.self, from: data) {
                throw RelayClientError.rateLimited(retryAfter: err.retryAfterSeconds ?? 60)
            }
            throw RelayClientError.rateLimited(retryAfter: 60)
        default:
            let errMsg: String
            if let err = try? decoder.decode(RelayError.self, from: data) {
                errMsg = err.error
            } else {
                errMsg = String(data: data, encoding: .utf8) ?? "Unknown error"
            }
            throw RelayClientError.serverError(httpResponse.statusCode, errMsg)
        }
    }
}
```

### 2.3 Nostr WebSocket Client (Path B)

This is the Swift port of `packages/mcp-server/src/client/nostr-client.ts`.

#### Nostr Types

```swift
import Foundation

// MARK: - Nostr Protocol Types

struct NostrEvent: Codable {
    let id: String          // 32-byte lowercase hex SHA256
    let pubkey: String      // 32-byte lowercase hex public key
    let createdAt: Int      // Unix timestamp in seconds
    let kind: Int           // Event kind (0-65535)
    let tags: [[String]]    // Array of tag arrays
    let content: String     // Arbitrary string content
    let sig: String         // 64-byte lowercase hex Schnorr signature

    enum CodingKeys: String, CodingKey {
        case id, pubkey
        case createdAt = "created_at"
        case kind, tags, content, sig
    }
}

struct UnsignedEvent {
    let pubkey: String
    let createdAt: Int
    let kind: Int
    let tags: [[String]]
    let content: String
}

struct NostrFilter: Codable {
    var ids: [String]?
    var authors: [String]?
    var kinds: [Int]?
    var since: Int?
    var until: Int?
    var limit: Int?

    // Tag filters are encoded as dynamic keys (#session, #t, etc.)
    // Use the custom encoding below
    var tagFilters: [String: [String]] = [:]

    enum StaticCodingKeys: String, CodingKey {
        case ids, authors, kinds, since, until, limit
    }

    // Custom encoding to handle dynamic #tag keys
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        if let ids { try container.encode(ids, forKey: .init("ids")) }
        if let authors { try container.encode(authors, forKey: .init("authors")) }
        if let kinds { try container.encode(kinds, forKey: .init("kinds")) }
        if let since { try container.encode(since, forKey: .init("since")) }
        if let until { try container.encode(until, forKey: .init("until")) }
        if let limit { try container.encode(limit, forKey: .init("limit")) }
        for (key, values) in tagFilters {
            try container.encode(values, forKey: .init("#\(key)"))
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicCodingKey.self)
        ids = try container.decodeIfPresent([String].self, forKey: .init("ids"))
        authors = try container.decodeIfPresent([String].self, forKey: .init("authors"))
        kinds = try container.decodeIfPresent([Int].self, forKey: .init("kinds"))
        since = try container.decodeIfPresent(Int.self, forKey: .init("since"))
        until = try container.decodeIfPresent(Int.self, forKey: .init("until"))
        limit = try container.decodeIfPresent(Int.self, forKey: .init("limit"))
        tagFilters = [:]
        for key in container.allKeys where key.stringValue.hasPrefix("#") {
            let tagName = String(key.stringValue.dropFirst())
            tagFilters[tagName] = try container.decode([String].self, forKey: key)
        }
    }

    init(
        ids: [String]? = nil,
        authors: [String]? = nil,
        kinds: [Int]? = nil,
        since: Int? = nil,
        until: Int? = nil,
        limit: Int? = nil,
        tagFilters: [String: [String]] = [:]
    ) {
        self.ids = ids
        self.authors = authors
        self.kinds = kinds
        self.since = since
        self.until = until
        self.limit = limit
        self.tagFilters = tagFilters
    }
}

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    init(_ string: String) { self.stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { return nil }
}

struct NostrKeypair {
    let privateKey: Data    // 32 bytes
    let publicKey: String   // hex-encoded
    let npub: String        // NIP-19 bech32
    let nsec: String        // NIP-19 bech32
}
```

#### Nostr Crypto

```swift
import Foundation
import CryptoKit

// Recommended: Add `secp256k1.swift` (GigaBitcoin) via SPM
// https://github.com/GigaBitcoin/secp256k1.swift
import secp256k1

// MARK: - Key Generation

struct NostrCrypto {

    /// Generate a fresh Nostr keypair
    static func generateKeypair() throws -> NostrKeypair {
        // Generate 32 random bytes for the private key
        var privateKeyBytes = Data(count: 32)
        let status = privateKeyBytes.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw NostrCryptoError.keyGenerationFailed
        }

        let privateKey = try secp256k1.Signing.PrivateKey(
            dataRepresentation: privateKeyBytes
        )

        // x-only public key (32 bytes, no prefix)
        let publicKeyData = privateKey.publicKey.xonly.bytes
        let publicKeyHex = publicKeyData.map { String(format: "%02x", $0) }.joined()

        let npub = Bech32.encode(hrp: "npub", data: Data(publicKeyData))
        let nsec = Bech32.encode(hrp: "nsec", data: privateKeyBytes)

        return NostrKeypair(
            privateKey: privateKeyBytes,
            publicKey: publicKeyHex,
            npub: npub,
            nsec: nsec
        )
    }

    /// Compute event ID per NIP-01: SHA256([0, pubkey, created_at, kind, tags, content])
    static func computeEventId(event: UnsignedEvent) -> String {
        let serialization: [Any] = [
            0,
            event.pubkey,
            event.createdAt,
            event.kind,
            event.tags,
            event.content,
        ]

        // Serialize to JSON with sorted keys for deterministic output
        guard let jsonData = try? JSONSerialization.data(
            withJSONObject: serialization,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ) else {
            fatalError("Failed to serialize event for ID computation")
        }

        let hash = SHA256.hash(data: jsonData)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Sign an unsigned event, producing a fully signed NostrEvent
    static func signEvent(
        event: UnsignedEvent,
        privateKey: Data
    ) throws -> NostrEvent {
        let eventId = computeEventId(event: event)
        let eventIdData = Data(hex: eventId)

        let signingKey = try secp256k1.Signing.PrivateKey(
            dataRepresentation: privateKey
        )

        // Schnorr signature (BIP-340)
        let signature = try signingKey.schnorr.signature(for: eventIdData)
        let sigHex = signature.dataRepresentation
            .map { String(format: "%02x", $0) }.joined()

        return NostrEvent(
            id: eventId,
            pubkey: event.pubkey,
            createdAt: event.createdAt,
            kind: event.kind,
            tags: event.tags,
            content: event.content,
            sig: sigHex
        )
    }

    /// Verify a signed Nostr event (checks id hash + signature)
    static func verifyEvent(_ event: NostrEvent) -> Bool {
        // 1. Recompute the event ID
        let unsigned = UnsignedEvent(
            pubkey: event.pubkey,
            createdAt: event.createdAt,
            kind: event.kind,
            tags: event.tags,
            content: event.content
        )
        let computedId = computeEventId(event: unsigned)
        guard computedId == event.id else { return false }

        // 2. Verify Schnorr signature
        guard let eventIdData = Data(hexString: event.id),
              let sigData = Data(hexString: event.sig),
              let pubkeyData = Data(hexString: event.pubkey) else {
            return false
        }

        do {
            let publicKey = try secp256k1.Signing.XonlyKey(
                dataRepresentation: pubkeyData
            )
            let signature = try secp256k1.Signing.SchnorrSignature(
                dataRepresentation: sigData
            )
            return publicKey.isValidSignature(signature, for: eventIdData)
        } catch {
            return false
        }
    }

    /// Create a NIP-42 auth response event
    static func createAuthEvent(
        challenge: String,
        relayUrl: String,
        privateKey: Data,
        publicKey: String
    ) throws -> NostrEvent {
        let unsigned = UnsignedEvent(
            pubkey: publicKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: 22242,
            tags: [
                ["relay", relayUrl],
                ["challenge", challenge],
            ],
            content: ""
        )
        return try signEvent(event: unsigned, privateKey: privateKey)
    }
}

enum NostrCryptoError: Error {
    case keyGenerationFailed
    case invalidPrivateKey
    case signingFailed
}

// MARK: - Data hex helpers

extension Data {
    init?(hexString: String) {
        let hex = hexString.lowercased()
        guard hex.count % 2 == 0 else { return nil }
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let nextIndex = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<nextIndex], radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }
        self = data
    }
}
```

#### Bech32 Encoding (NIP-19)

For `npub`/`nsec` encoding, use the `Bech32` implementation from Bitcoin or a lightweight NIP-19 library. A minimal implementation:

```swift
/// Minimal Bech32 encoder/decoder for NIP-19 (npub/nsec).
/// For production, consider using a tested library like `NostrSDK` or `BitcoinKit`.
struct Bech32 {
    private static let charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    private static let generator: [UInt32] = [
        0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3
    ]

    static func encode(hrp: String, data: Data) -> String {
        let values = convertBits(data: data, fromBits: 8, toBits: 5, pad: true)
        let checksum = createChecksum(hrp: hrp, values: values)
        let combined = values + checksum
        return hrp + "1" + String(combined.map { charset[charset.index(charset.startIndex, offsetBy: Int($0))] })
    }

    static func decode(_ str: String) -> (hrp: String, data: Data)? {
        let lowered = str.lowercased()
        guard let sepIndex = lowered.lastIndex(of: "1") else { return nil }
        let hrp = String(lowered[lowered.startIndex..<sepIndex])
        let dataChars = lowered[lowered.index(after: sepIndex)...]
        var values: [UInt8] = []
        for char in dataChars {
            guard let idx = charset.firstIndex(of: char) else { return nil }
            values.append(UInt8(charset.distance(from: charset.startIndex, to: idx)))
        }
        guard verifyChecksum(hrp: hrp, values: values) else { return nil }
        let decoded = convertBits(data: Data(values.dropLast(6)), fromBits: 5, toBits: 8, pad: false)
        return (hrp, Data(decoded))
    }

    private static func polymod(_ values: [UInt8]) -> UInt32 {
        var chk: UInt32 = 1
        for v in values {
            let top = chk >> 25
            chk = (chk & 0x1ffffff) << 5 ^ UInt32(v)
            for i in 0..<5 {
                chk ^= ((top >> i) & 1) != 0 ? generator[i] : 0
            }
        }
        return chk
    }

    private static func hrpExpand(_ hrp: String) -> [UInt8] {
        var result = hrp.map { UInt8($0.asciiValue! >> 5) }
        result.append(0)
        result.append(contentsOf: hrp.map { UInt8($0.asciiValue! & 31) })
        return result
    }

    private static func createChecksum(hrp: String, values: [UInt8]) -> [UInt8] {
        let polyVal = polymod(hrpExpand(hrp) + values + [0, 0, 0, 0, 0, 0]) ^ 1
        return (0..<6).map { UInt8((polyVal >> (5 * (5 - $0))) & 31) }
    }

    private static func verifyChecksum(hrp: String, values: [UInt8]) -> Bool {
        polymod(hrpExpand(hrp) + values) == 1
    }

    private static func convertBits(data: Data, fromBits: Int, toBits: Int, pad: Bool) -> [UInt8] {
        var acc: UInt32 = 0
        var bits = 0
        var result: [UInt8] = []
        let maxv = UInt32((1 << toBits) - 1)
        for byte in data {
            acc = (acc << fromBits) | UInt32(byte)
            bits += fromBits
            while bits >= toBits {
                bits -= toBits
                result.append(UInt8((acc >> bits) & maxv))
            }
        }
        if pad && bits > 0 {
            result.append(UInt8((acc << (toBits - bits)) & maxv))
        }
        return result
    }
}
```

#### NostrClient (WebSocket)

```swift
import Foundation

enum NostrClientStatus {
    case disconnected
    case connecting
    case authenticating
    case ready
    case error(Error)
}

actor NostrWebSocketClient {
    private var webSocket: URLSessionWebSocketTask?
    private let urlSession: URLSession
    private var _status: NostrClientStatus = .disconnected
    private let keypair: NostrKeypair
    private let relayUrl: String
    private let sessionId: String?
    private var subscriptions: [String: (NostrEvent) -> Void] = [:]
    private var messageBuffer: [NostrEvent] = []
    private var authContinuation: CheckedContinuation<Void, Error>?

    var status: NostrClientStatus { _status }
    var bufferedCount: Int { messageBuffer.count }

    init(relayUrl: String, keypair: NostrKeypair, sessionId: String? = nil) {
        self.relayUrl = relayUrl
        self.keypair = keypair
        self.sessionId = sessionId
        self.urlSession = URLSession(configuration: .default)
    }

    /// Connect and authenticate via NIP-42
    func connect() async throws {
        guard case .disconnected = _status else { return }

        guard let url = URL(string: relayUrl) else {
            throw NostrCryptoError.invalidPrivateKey
        }

        let ws = urlSession.webSocketTask(with: url)
        webSocket = ws
        _status = .connecting
        ws.resume()
        _status = .authenticating

        // Start listening for messages
        startReceiving()

        // Wait for auth to complete (will be resolved in handleMessage)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            authContinuation = continuation
        }

        // Set up a timeout
        // Note: In production, add a Task.sleep-based timeout
    }

    /// Subscribe to session events
    func subscribeToSession(_ sessionIdOverride: String? = nil) {
        let sid = sessionIdOverride ?? sessionId
        guard let sid else { return }

        var filter = NostrFilter(
            kinds: NostrEventKind.allRelayKinds
        )
        filter.tagFilters["session"] = [sid]

        subscribe(subId: "session-\(sid)", filters: [filter])
    }

    /// Subscribe with custom filters
    func subscribe(
        subId: String,
        filters: [NostrFilter],
        onEvent: ((NostrEvent) -> Void)? = nil
    ) {
        guard case .ready = _status else { return }
        if let onEvent {
            subscriptions[subId] = onEvent
        }

        // Build REQ message: ["REQ", subId, filter1, filter2, ...]
        var message: [Any] = ["REQ", subId]
        for filter in filters {
            if let data = try? JSONEncoder().encode(filter),
               let dict = try? JSONSerialization.jsonObject(with: data) {
                message.append(dict)
            }
        }

        sendRaw(message)
    }

    /// Unsubscribe
    func unsubscribe(_ subId: String) {
        subscriptions.removeValue(forKey: subId)
        guard case .ready = _status else { return }
        sendRaw(["CLOSE", subId])
    }

    /// Publish a signed event
    func publish(_ event: NostrEvent) {
        guard case .ready = _status else { return }
        if let data = try? JSONEncoder().encode(event),
           let dict = try? JSONSerialization.jsonObject(with: data) {
            sendRaw(["EVENT", dict])
        }
    }

    /// Drain buffered events
    func drainBuffer() -> [NostrEvent] {
        let events = messageBuffer
        messageBuffer = []
        return events
    }

    /// Disconnect
    func disconnect() {
        for subId in subscriptions.keys {
            sendRaw(["CLOSE", subId])
        }
        subscriptions.removeAll()
        messageBuffer.removeAll()
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        _status = .disconnected
    }

    // MARK: - Private

    private func startReceiving() {
        webSocket?.receive { [weak self] result in
            guard let self else { return }
            Task {
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        await self.handleMessage(text)
                    case .data(let data):
                        await self.handleMessage(String(data: data, encoding: .utf8) ?? "")
                    @unknown default:
                        break
                    }
                    await self.startReceiving()
                case .failure(let error):
                    await self.handleError(error)
                }
            }
        }
    }

    private func handleMessage(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [Any],
              msg.count >= 2,
              let type = msg[0] as? String else {
            return
        }

        switch type {
        case "AUTH":
            // NIP-42 challenge
            guard let challenge = msg[1] as? String else { return }
            do {
                let authEvent = try NostrCrypto.createAuthEvent(
                    challenge: challenge,
                    relayUrl: relayUrl,
                    privateKey: keypair.privateKey,
                    publicKey: keypair.publicKey
                )
                if let eventData = try? JSONEncoder().encode(authEvent),
                   let eventDict = try? JSONSerialization.jsonObject(with: eventData) {
                    sendRaw(["AUTH", eventDict])
                }
            } catch {
                authContinuation?.resume(throwing: error)
                authContinuation = nil
            }

        case "OK":
            guard msg.count >= 3, let success = msg[2] as? Bool else { return }
            if success, case .authenticating = _status {
                _status = .ready
                authContinuation?.resume()
                authContinuation = nil
            } else if !success, case .authenticating = _status {
                let reason = msg.count >= 4 ? msg[3] as? String ?? "Unknown" : "Unknown"
                authContinuation?.resume(throwing: RelayClientError.forbidden)
                authContinuation = nil
            }

        case "EVENT":
            guard msg.count >= 3,
                  let subId = msg[1] as? String,
                  let eventDict = msg[2] as? [String: Any],
                  let eventData = try? JSONSerialization.data(withJSONObject: eventDict),
                  let event = try? JSONDecoder().decode(NostrEvent.self, from: eventData) else {
                return
            }
            if NostrCrypto.verifyEvent(event) {
                messageBuffer.append(event)
                subscriptions[subId]?(event)
            }

        case "EOSE", "NOTICE", "CLOSED":
            break // Handle as needed

        default:
            break
        }
    }

    private func handleError(_ error: Error) {
        _status = .error(error)
        authContinuation?.resume(throwing: error)
        authContinuation = nil
    }

    private func sendRaw(_ message: [Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        webSocket?.send(.string(text)) { error in
            if let error {
                // Log but don't throw -- connection may recover
                print("[NostrClient] Send error: \(error)")
            }
        }
    }
}
```

### 2.4 SSE Client (Path C)

```swift
import Foundation

/// Server-Sent Events client for real-time relay message streaming.
actor RelaySSEClient {
    private let baseURL: URL
    private var task: URLSessionDataTask?
    private var urlSession: URLSession?
    private var lastEventId: String?

    /// Callback for incoming messages
    var onMessage: ((StoredMessage) -> Void)?
    /// Callback for connection state changes
    var onStateChange: ((SSEState) -> Void)?

    enum SSEState {
        case connecting
        case connected
        case disconnected
        case error(Error)
    }

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Start streaming messages for a session
    func connect(sessionId: String, token: String) {
        disconnect()

        let url = baseURL
            .appendingPathComponent("relay")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("stream")

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = TimeInterval.infinity

        // Set Last-Event-ID for catch-up on reconnect
        if let lastEventId {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }

        let delegate = SSEDelegate { [weak self] event, data, id in
            guard let self else { return }
            Task { await self.handleSSEMessage(event: event, data: data, id: id) }
        }

        let session = URLSession(
            configuration: .default,
            delegate: delegate,
            delegateQueue: nil
        )
        self.urlSession = session

        let dataTask = session.dataTask(with: request)
        self.task = dataTask

        onStateChange?(.connecting)
        dataTask.resume()
        onStateChange?(.connected)
    }

    /// Disconnect the SSE stream
    func disconnect() {
        task?.cancel()
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        onStateChange?(.disconnected)
    }

    private func handleSSEMessage(event: String?, data: String, id: String?) {
        // Update Last-Event-ID for reconnection
        if let id {
            lastEventId = id
        }

        // Skip ping events
        guard event == "message", !data.isEmpty else { return }

        guard let jsonData = data.data(using: .utf8),
              let message = try? JSONDecoder().decode(StoredMessage.self, from: jsonData) else {
            return
        }

        onMessage?(message)
    }
}

/// URLSession delegate that parses SSE stream data
private class SSEDelegate: NSObject, URLSessionDataDelegate {
    private var buffer = ""
    private let handler: (String?, String, String?) -> Void

    init(handler: @escaping (String?, String, String?) -> Void) {
        self.handler = handler
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        guard let chunk = String(data: data, encoding: .utf8) else { return }
        buffer += chunk

        // Parse SSE format: lines separated by \n\n
        while let range = buffer.range(of: "\n\n") {
            let block = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer = String(buffer[range.upperBound...])

            var event: String?
            var data: String?
            var id: String?

            for line in block.components(separatedBy: "\n") {
                if line.hasPrefix("event: ") {
                    event = String(line.dropFirst(7))
                } else if line.hasPrefix("data: ") {
                    data = String(line.dropFirst(6))
                } else if line.hasPrefix("id: ") {
                    id = String(line.dropFirst(4))
                }
            }

            if let data {
                handler(event, data, id)
            }
        }
    }
}
```

---

## 3. MCP Integration

### 3.1 MCP Tool Inventory

The relay provides 8 MCP tools for Claude Code CLI:

| Tool | Description |
|------|-------------|
| `relay_create_session` | Create a session. Generates a Nostr keypair and binds it. |
| `relay_join_session` | Join with session ID + invite token. Also generates a keypair. |
| `relay_send` | Stage a message into an approval queue (NOT sent immediately). |
| `relay_approve` | Approve/reject/list pending messages. Actually sends on approve. |
| `relay_poll` | Fetch new messages via HTTP or drain Nostr WebSocket buffer. |
| `relay_status` | Overview of active sessions, pending approvals, server health. |
| `relay_share_workspace` | Scan project directory and share file tree + summary. |
| `relay_nostr_connect` | Connect to the Nostr WebSocket relay for real-time streaming. |
| `relay_nostr_pool` | Manage external Nostr relay connections (connect/disconnect/list). |

### 3.2 iOS Should Not Use MCP

MCP (Model Context Protocol) is a CLI-oriented protocol designed for Claude Code's stdio transport. It operates as:

```
Claude Code CLI --> stdio --> MCP Server --> HTTP/WS --> Relay Server
```

An iOS app should bypass MCP entirely and talk directly to the relay server:

```
iOS App --> HTTP REST + WebSocket --> Relay Server
```

**Reasoning**:
- MCP tools include an approval queue (relay_send stages, relay_approve sends) which is a UX pattern for CLI. An iOS app should send directly via `POST /relay/:id`.
- MCP state is persisted to `~/.claude-relay/active-sessions.json`, which is irrelevant on iOS.
- The MCP server generates keypairs and manages them in a flat file. iOS should use Keychain.
- MCP's stdio transport is incompatible with iOS.

The one useful reference from the MCP layer is `NostrClient` in `packages/mcp-server/src/client/nostr-client.ts` -- the Swift port above is based on it.

---

## 4. Architecture Recommendation for iOS

### 4.1 Service Layer

```
RelayService (HTTP)
  |-- createSession, joinSession, sendMessage, pollMessages, exportSession
  |-- Holds session tokens (from Keychain)

NostrService (WebSocket)
  |-- connect, authenticate (NIP-42), publish, subscribe
  |-- Holds keypair (from Keychain)
  |-- Real-time event delivery via AsyncStream

SSEService (EventSource)
  |-- connect, reconnect with Last-Event-ID
  |-- Delivers StoredMessage via AsyncStream
  |-- Simpler than NostrService; good for read-only monitoring

SessionManager (Orchestrator)
  |-- Coordinates all three services
  |-- Manages active session state
  |-- Publishes @Observable state for SwiftUI
```

### 4.2 Which Integration Path to Use

| Use Case | Recommended Path |
|----------|-----------------|
| Simple read/write | HTTP REST only |
| Real-time monitoring (read-only) | HTTP + SSE |
| Full bidirectional real-time | HTTP + Nostr WebSocket |
| Federation with external relays | Nostr WebSocket |

For an initial MVP, **HTTP REST + SSE** is the simplest. Nostr WebSocket adds real-time publishing and federation but requires secp256k1 crypto.

### 4.3 SwiftData Models for Local Caching

```swift
import SwiftData

@Model
class CachedSession {
    @Attribute(.unique) var sessionId: String
    var name: String
    var role: String  // "creator" or "participant"
    var creatorToken: String?
    var participantToken: String?
    var inviteToken: String?
    var cursor: Int
    var createdAt: Date
    var expiresAt: Date
    var nostrPublicKey: String?

    // Token is stored in Keychain, not here.
    // This model only caches metadata.

    @Relationship(deleteRule: .cascade)
    var messages: [CachedMessage]

    var token: String? {
        // Read from Keychain using sessionId as key
        KeychainService.shared.getToken(for: sessionId)
    }

    init(sessionId: String, name: String, role: String, cursor: Int = 0,
         createdAt: Date, expiresAt: Date) {
        self.sessionId = sessionId
        self.name = name
        self.role = role
        self.cursor = cursor
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.messages = []
    }
}

@Model
class CachedMessage {
    @Attribute(.unique) var messageId: String
    var sequence: Int
    var type: String
    var title: String
    var content: String
    var senderName: String?
    var sentAt: Date
    var tags: [String]?

    var session: CachedSession?

    init(messageId: String, sequence: Int, type: String, title: String,
         content: String, senderName: String?, sentAt: Date) {
        self.messageId = messageId
        self.sequence = sequence
        self.type = type
        self.title = title
        self.content = content
        self.senderName = senderName
        self.sentAt = sentAt
    }
}
```

### 4.4 Observable Session Manager

```swift
import Foundation
import Observation

@Observable
class SessionManager {
    var activeSessions: [SessionState] = []
    var currentSession: SessionState?
    var connectionStatus: ConnectionStatus = .disconnected
    var recentMessages: [StoredMessage] = []

    private let httpClient: RelayHTTPClient
    private var nostrClient: NostrWebSocketClient?
    private var sseClient: RelaySSEClient?
    private var pollTimer: Timer?

    enum ConnectionStatus {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    struct SessionState: Identifiable {
        let id: String  // session_id
        let name: String
        let role: String
        let token: String
        var cursor: Int
        var nostrKeypair: NostrKeypair?
    }

    init(relayHost: String = "localhost", port: Int = 4190) {
        let url = URL(string: "http://\(relayHost):\(port)")!
        self.httpClient = RelayHTTPClient(baseURL: url)
    }

    func createSession(name: String, ttlMinutes: Int = 60) async throws {
        let keypair = try NostrCrypto.generateKeypair()
        let response = try await httpClient.createSession(
            name: name,
            ttlMinutes: ttlMinutes,
            nostrPubkey: keypair.publicKey
        )

        // Store tokens in Keychain
        KeychainService.shared.store(
            token: response.creatorToken,
            for: response.sessionId
        )
        KeychainService.shared.store(
            inviteToken: response.inviteToken,
            for: response.sessionId
        )
        // Store nsec in Keychain (NEVER in UserDefaults)
        KeychainService.shared.storeNostrKey(
            nsec: keypair.nsec,
            for: response.sessionId
        )

        let state = SessionState(
            id: response.sessionId,
            name: name,
            role: "creator",
            token: response.creatorToken,
            cursor: 0,
            nostrKeypair: keypair
        )
        activeSessions.append(state)
        currentSession = state
    }

    func joinSession(
        sessionId: String,
        inviteToken: String,
        name: String = "ios-client"
    ) async throws {
        let keypair = try NostrCrypto.generateKeypair()
        let response = try await httpClient.joinSession(
            sessionId: sessionId,
            inviteToken: inviteToken,
            participantName: name,
            nostrPubkey: keypair.publicKey
        )

        KeychainService.shared.store(
            token: response.participantToken,
            for: sessionId
        )
        KeychainService.shared.storeNostrKey(
            nsec: keypair.nsec,
            for: sessionId
        )

        let state = SessionState(
            id: sessionId,
            name: response.session.name,
            role: "participant",
            token: response.participantToken,
            cursor: 0,
            nostrKeypair: keypair
        )
        activeSessions.append(state)
        currentSession = state
    }

    func sendMessage(type: RelayMessageType, title: String, content: String) async throws {
        guard let session = currentSession else { return }
        let payload = RelayMessagePayload(
            type: type,
            title: title,
            content: content
        )
        _ = try await httpClient.sendMessage(
            sessionId: session.id,
            token: session.token,
            payload: payload
        )
    }

    func poll() async throws {
        guard var session = currentSession else { return }
        let response = try await httpClient.pollMessages(
            sessionId: session.id,
            token: session.token,
            since: session.cursor
        )
        if response.cursor > session.cursor {
            session.cursor = response.cursor
            // Update in activeSessions
            if let idx = activeSessions.firstIndex(where: { $0.id == session.id }) {
                activeSessions[idx].cursor = response.cursor
            }
            currentSession = session
        }
        recentMessages.append(contentsOf: response.messages)
    }
}
```

### 4.5 Voxlight Ecosystem Fit

The iOS relay client could integrate with Voxlight in several ways:

1. **Development companion**: An iOS "relay dashboard" app for monitoring Claude-to-Claude sessions from your phone while Claude instances work on Voxlight code.
2. **Embedded in Voxlight**: Add relay capabilities directly to the Voxlight app for collaborative reading sessions where a "director" Claude helps find alignment issues.
3. **Standalone app**: A dedicated iOS client for managing relay sessions, viewing messages, and directing Claude workers from mobile.

Recommended approach for a standalone app: Build it as a separate target or project (not embedded in Voxlight) since the use cases are distinct. Share the relay client code via a Swift Package if you later want to embed relay features in Voxlight.

---

## 5. Event Kind Reference Table

| Kind | Message Type | Description | Example Content | Swift Enum |
|------|-------------|-------------|-----------------|------------|
| 4190 | `architecture` | System architecture decisions, diagrams, component relationships | `"# Auth System\n\nJWT + refresh tokens..."` | `.architecture` |
| 4191 | `api-docs` | API endpoint documentation, schemas, contracts | `"## POST /users\n\nCreates a new user..."` | `.apiDocs` |
| 4192 | `patterns` | Design patterns, code patterns, reusable solutions | `"## Repository Pattern\n\nAll data access..."` | `.patterns` |
| 4193 | `conventions` | Coding conventions, naming rules, style guides | `"## Naming\n\n- camelCase for vars..."` | `.conventions` |
| 4194 | `question` | Questions between Claude instances or from director | `"How should we handle auth refresh?"` | `.question` |
| 4195 | `answer` | Responses to questions | `"Use silent refresh with..."` | `.answer` |
| 4196 | `context` | General context sharing, project info, summaries | `"# Project: voxlight\n\nSwift 6..."` | `.context` |
| 4197 | `insight` | Discoveries, learnings, analysis results | `"Found that AVAudioEngine..."` | `.insight` |
| 4198 | `task` | Task assignments, work items, instructions | `"Implement the sync engine..."` | `.task` |
| 4200 | `file_tree` | Project file structure snapshot | `"voxlight/\n  src/\n    App.swift..."` | `.fileTree` |
| 4201 | `file_change` | File diffs, edits, code changes | `"--- a/src/App.swift\n+++ b/..."` | `.fileChange` |
| 4202 | `file_read` | Shared file contents | `"// App.swift\nimport SwiftUI..."` | `.fileRead` |
| 4203 | `terminal` | Terminal output, build logs, test results | `"$ swift build\nCompiling..."` | `.terminal` |
| 4204 | `status_update` | Worker status (idle, reading, writing, testing) | `"reading src/SyncEngine.swift"` | `.statusUpdate` |

Special kinds (not relay messages):

| Kind | Purpose | NIP |
|------|---------|-----|
| 0 | User/session metadata (replaceable) | NIP-01 |
| 5 | Event deletion | NIP-09 |
| 22242 | NIP-42 authentication (ephemeral) | NIP-42 |
| 30078 | Application-specific data (addressable) | NIP-78 |

### Swift Enum Definition

```swift
enum NostrEventKind: Int, Codable, CaseIterable {
    // Core relay message types
    case architecture = 4190
    case apiDocs = 4191
    case patterns = 4192
    case conventions = 4193
    case question = 4194
    case answer = 4195
    case context = 4196
    case insight = 4197
    case task = 4198
    // Workspace types
    case fileTree = 4200
    case fileChange = 4201
    case fileRead = 4202
    case terminal = 4203
    case statusUpdate = 4204

    /// All relay event kinds (for subscription filters)
    static let allRelayKinds: [Int] = Self.allCases.map(\.rawValue)

    /// Convert to message type string
    var messageType: RelayMessageType? {
        switch self {
        case .architecture: return .architecture
        case .apiDocs: return .apiDocs
        case .patterns: return .patterns
        case .conventions: return .conventions
        case .question: return .question
        case .answer: return .answer
        case .context: return .context
        case .insight: return .insight
        case .task: return .task
        case .fileTree: return .fileTree
        case .fileChange: return .fileChange
        case .fileRead: return .fileRead
        case .terminal: return .terminal
        case .statusUpdate: return .statusUpdate
        }
    }

    /// Create from message type string
    static func from(messageType: RelayMessageType) -> NostrEventKind {
        switch messageType {
        case .architecture: return .architecture
        case .apiDocs: return .apiDocs
        case .patterns: return .patterns
        case .conventions: return .conventions
        case .question: return .question
        case .answer: return .answer
        case .context: return .context
        case .insight: return .insight
        case .task: return .task
        case .fileTree: return .fileTree
        case .fileChange: return .fileChange
        case .fileRead: return .fileRead
        case .terminal: return .terminal
        case .statusUpdate: return .statusUpdate
        }
    }
}

// Special protocol kinds
enum NostrProtocolKind: Int {
    case metadata = 0           // NIP-01
    case deletion = 5           // NIP-09
    case auth = 22242           // NIP-42
    case applicationData = 30078 // NIP-78
}
```

### Tag Encoding for Events

When constructing Nostr events from relay messages, use this tag mapping:

| Tag | Purpose | Example |
|-----|---------|---------|
| `["session", "<uuid>"]` | Scope event to a session | `["session", "abc-123-def"]` |
| `["title", "<text>"]` | Message title | `["title", "Auth Architecture"]` |
| `["t", "<type>"]` | Message type (for filtering) | `["t", "architecture"]` |
| `["t", "<tag>"]` | Searchable tags | `["t", "swift"]` |
| `["sender", "<name>"]` | Sender name | `["sender", "ios-client"]` |
| `["r", "<file>", "<lines>?", "<note>?"]` | File reference | `["r", "src/App.swift", "1-50"]` |
| `["project", "<name>"]` | Project context | `["project", "voxlight"]` |
| `["stack", "<text>"]` | Tech stack | `["stack", "Swift 6"]` |
| `["branch", "<text>"]` | Git branch | `["branch", "dev"]` |
| `["bridge", "http"]` | Marks events created via HTTP bridge | (server-only) |
| `["message_id", "<uuid>"]` | Cross-reference to HTTP message ID | (server-only) |

---

## 6. Security Considerations

### 6.1 Token Storage

**Bearer tokens** (creator_token, participant_token, invite_token) must be stored in the iOS Keychain, never in UserDefaults, files, or Core Data.

```swift
import Security

struct KeychainService {
    static let shared = KeychainService()

    func store(token: String, for sessionId: String) {
        let key = "relay-token-\(sessionId)"
        let data = token.data(using: .utf8)!

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.bythewei.relay",
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    func getToken(for sessionId: String) -> String? {
        let key = "relay-token-\(sessionId)"

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.bythewei.relay",
            kSecReturnData as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func store(inviteToken: String, for sessionId: String) {
        store(token: inviteToken, for: "invite-\(sessionId)")
    }

    func storeNostrKey(nsec: String, for sessionId: String) {
        store(token: nsec, for: "nsec-\(sessionId)")
    }

    func getNostrKey(for sessionId: String) -> String? {
        getToken(for: "nsec-\(sessionId)")
    }

    func deleteAll(for sessionId: String) {
        for prefix in ["relay-token-", "invite-", "nsec-"] {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: "\(prefix)\(sessionId)",
                kSecAttrService as String: "com.bythewei.relay",
            ]
            SecItemDelete(query as CFDictionary)
        }
    }
}
```

### 6.2 Nostr Private Key Storage

The `nsec` (bech32-encoded private key) is the most sensitive credential. It MUST:
- Be stored in Keychain with `kSecAttrAccessibleAfterFirstUnlock`
- Never appear in logs, error messages, or analytics
- Never be sent over the network (only public key is shared)
- Be generated fresh per session (the server generates per-session keypairs)
- Consider using `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` for higher security

### 6.3 Content Scanner Patterns (Server-Side)

The server blocks messages containing these patterns. Your iOS client should be aware of these to provide good UX (warn before sending):

| Pattern | Description |
|---------|-------------|
| `sk-[a-zA-Z0-9-]{20,}` | OpenAI/Anthropic API keys |
| `ghp_[a-zA-Z0-9]{36,}` | GitHub PATs |
| `AKIA[A-Z0-9]{16}` | AWS access keys |
| `xox[bpsa]-*` | Slack tokens |
| `password\s*[:=]\s*"..."` | Password assignments |
| `secret\s*[:=]\s*"..."` | Secret assignments |
| `api[_-]?key\s*[:=]\s*"..."` | API key assignments |
| `/Users/*/...` | macOS absolute paths |
| `/home/*/...` | Linux absolute paths |
| `C:\...` | Windows absolute paths |
| `nsec1[a-z0-9]{56,}` | Nostr nsec private keys |
| `^[0-9a-f]{64}$` (own line) | Hex-encoded private keys |
| Base64 blobs > 1KB | Binary data detection |

Server returns HTTP 422 with `warnings` array. The iOS client should catch `RelayClientError.contentBlocked` and display the warnings to the user.

### 6.4 Rate Limits

| Scope | Limit |
|-------|-------|
| HTTP per token | 600 requests/minute |
| WebSocket per connection | 10 messages/second |

On HTTP 429, the response includes `retry_after_seconds`. Implement exponential backoff:

```swift
func pollWithBackoff(sessionId: String, token: String) async {
    var retryDelay: TimeInterval = 1.0
    let maxDelay: TimeInterval = 60.0

    while true {
        do {
            let response = try await httpClient.pollMessages(
                sessionId: sessionId, token: token
            )
            retryDelay = 1.0  // Reset on success
            // Process messages...
            try await Task.sleep(for: .seconds(2))  // Normal poll interval
        } catch RelayClientError.rateLimited(let retryAfter) {
            retryDelay = min(TimeInterval(retryAfter), maxDelay)
            try? await Task.sleep(for: .seconds(retryDelay))
        } catch {
            retryDelay = min(retryDelay * 2, maxDelay)
            try? await Task.sleep(for: .seconds(retryDelay))
        }
    }
}
```

### 6.5 Network Security

- The relay currently runs over plain HTTP/WS. For production, terminate TLS at a reverse proxy (nginx, Caddy) or use ngrok.
- When connecting over Tailscale, traffic is already encrypted (WireGuard). Plain HTTP is acceptable within the Tailscale network.
- The relay validates CORS origins server-side, but this is irrelevant for native iOS clients (CORS is browser-only).

---

## 7. Quick Start Code

A complete minimal Swift example that creates a session, connects via WebSocket, authenticates, publishes an event, and subscribes to receive events.

```swift
import Foundation
// Requires: secp256k1.swift SPM package

// ============================================================
// Quick Start: iOS Relay Client
// ============================================================

// --- Configuration ---
let relayHost = "100.71.141.45"  // Tailscale IP of Mac mini
let relayPort = 4190
let httpBaseURL = URL(string: "http://\(relayHost):\(relayPort)")!
let wsURL = "ws://\(relayHost):\(relayPort)"

// --- Step 1: Create a session via HTTP ---
func quickStart() async throws {
    let httpClient = RelayHTTPClient(baseURL: httpBaseURL)

    // Generate a Nostr keypair for this session
    let keypair = try NostrCrypto.generateKeypair()
    print("Generated keypair: \(keypair.npub)")

    // Create the session
    let session = try await httpClient.createSession(
        name: "ios-quick-start",
        ttlMinutes: 60,
        nostrPubkey: keypair.publicKey
    )
    print("Session created: \(session.sessionId)")
    print("Invite token: \(session.inviteToken)")
    print("Expires at: \(session.expiresAt)")

    // Store tokens securely
    KeychainService.shared.store(token: session.creatorToken, for: session.sessionId)
    KeychainService.shared.storeNostrKey(nsec: keypair.nsec, for: session.sessionId)

    // --- Step 2: Connect via WebSocket ---
    let nostrClient = NostrWebSocketClient(
        relayUrl: wsURL,
        keypair: keypair,
        sessionId: session.sessionId
    )

    // Step 3: Authenticate (NIP-42 -- happens automatically during connect)
    try await nostrClient.connect()
    print("WebSocket connected and authenticated!")

    // --- Step 4: Subscribe to session events ---
    await nostrClient.subscribeToSession(session.sessionId)
    print("Subscribed to session events")

    // --- Step 5: Publish an event via WebSocket ---
    let messageEvent = try NostrCrypto.signEvent(
        event: UnsignedEvent(
            pubkey: keypair.publicKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: NostrEventKind.context.rawValue,  // 4196
            tags: [
                ["session", session.sessionId],
                ["title", "Hello from iOS"],
                ["t", "context"],
                ["sender", "ios-client"],
            ],
            content: "This message was sent from an iOS device via Nostr WebSocket!"
        ),
        privateKey: keypair.privateKey
    )
    await nostrClient.publish(messageEvent)
    print("Published event: \(messageEvent.id.prefix(8))...")

    // --- Alternative: Send via HTTP REST ---
    let payload = RelayMessagePayload(
        type: .context,
        title: "Hello from iOS (HTTP)",
        content: "This message was sent from an iOS device via HTTP REST!"
    )
    let sendResult = try await httpClient.sendMessage(
        sessionId: session.sessionId,
        token: session.creatorToken,
        payload: payload
    )
    print("Sent via HTTP: sequence \(sendResult.sequence)")

    // --- Step 6: Poll for messages (HTTP) ---
    let pollResult = try await httpClient.pollMessages(
        sessionId: session.sessionId,
        token: session.creatorToken,
        since: 0,
        limit: 50
    )
    print("Polled \(pollResult.messages.count) message(s), cursor: \(pollResult.cursor)")

    for msg in pollResult.messages {
        print("  [\(msg.type)] \(msg.title) -- from \(msg.senderName ?? "unknown")")
    }

    // --- Or drain WebSocket buffer ---
    let events = await nostrClient.drainBuffer()
    print("Drained \(events.count) event(s) from WebSocket buffer")

    // --- Cleanup ---
    await nostrClient.disconnect()
    print("Disconnected")
}

// Run it
Task {
    do {
        try await quickStart()
    } catch {
        print("Error: \(error)")
    }
}
```

### SPM Dependencies

Add to your `Package.swift` or Xcode project:

```swift
// Package.swift
dependencies: [
    // secp256k1 for Schnorr signatures (required for Nostr)
    .package(url: "https://github.com/GigaBitcoin/secp256k1.swift", from: "0.17.0"),
]

// Target dependency
.target(
    name: "RelayClient",
    dependencies: [
        .product(name: "secp256k1", package: "secp256k1.swift"),
    ]
)
```

If you prefer a higher-level Nostr library that handles NIP-01/NIP-19/NIP-42 out of the box:

```swift
// Alternative: nostr-sdk (includes key management, event building, relay connection)
.package(url: "https://github.com/nickkuijpers/NostrSDK-iOS", from: "1.0.0"),
```

---

## Appendix: Nostr Event Conversion Helpers

Convert between HTTP relay messages and Nostr events (port of `packages/shared/src/nostr-utils.ts`):

```swift
extension NostrEvent {
    /// Convert a Nostr event to a StoredMessage (for display)
    func toStoredMessage() -> StoredMessage {
        let type = NostrEventKind(rawValue: kind)?.messageType?.rawValue ?? "context"

        let titleTag = tags.first(where: { $0.first == "title" })
        let senderTag = tags.first(where: { $0.first == "sender" })

        let searchTags = tags
            .filter { $0.first == "t" && $0.count > 1 }
            .map { $0[1] }
            .filter { $0 != type }

        let references = tags
            .filter { $0.first == "r" && $0.count > 1 }
            .map { tag in
                FileReference(
                    file: tag[1],
                    lines: tag.count > 2 ? tag[2] : nil,
                    note: tag.count > 3 ? tag[3] : nil
                )
            }

        let projectTag = tags.first(where: { $0.first == "project" })
        let stackTag = tags.first(where: { $0.first == "stack" })
        let branchTag = tags.first(where: { $0.first == "branch" })
        let context: MessageContext? = (projectTag != nil || stackTag != nil || branchTag != nil)
            ? MessageContext(
                project: projectTag.flatMap { $0.count > 1 ? $0[1] : nil },
                stack: stackTag.flatMap { $0.count > 1 ? $0[1] : nil },
                branch: branchTag.flatMap { $0.count > 1 ? $0[1] : nil }
            )
            : nil

        return StoredMessage(
            messageId: id,
            sequence: 0,
            type: type,
            title: titleTag.flatMap { $0.count > 1 ? $0[1] : nil } ?? "",
            content: content,
            tags: searchTags.isEmpty ? nil : searchTags,
            references: references.isEmpty ? nil : references,
            context: context,
            senderName: senderTag.flatMap { $0.count > 1 ? $0[1] : nil }
                ?? "nostr:\(pubkey.prefix(8))",
            sentAt: ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: TimeInterval(createdAt)))
        )
    }
}

extension StoredMessage {
    /// Convert a StoredMessage to a signed Nostr event
    func toNostrEvent(
        keypair: NostrKeypair,
        sessionId: String? = nil
    ) throws -> NostrEvent {
        let messageType = RelayMessageType(rawValue: type) ?? .context
        let kind = NostrEventKind.from(messageType: messageType)

        var eventTags: [[String]] = []

        if !title.isEmpty {
            eventTags.append(["title", title])
        }
        eventTags.append(["t", type])

        if let senderName {
            eventTags.append(["sender", senderName])
        }
        if let tags {
            for tag in tags {
                eventTags.append(["t", tag])
            }
        }
        if let references {
            for ref in references {
                var refTag = ["r", ref.file]
                if let lines = ref.lines { refTag.append(lines) }
                if let note = ref.note { refTag.append(note) }
                eventTags.append(refTag)
            }
        }
        if let context {
            if let project = context.project { eventTags.append(["project", project]) }
            if let stack = context.stack { eventTags.append(["stack", stack]) }
            if let branch = context.branch { eventTags.append(["branch", branch]) }
        }
        if let sessionId {
            eventTags.append(["session", sessionId])
        }

        let unsigned = UnsignedEvent(
            pubkey: keypair.publicKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: kind.rawValue,
            tags: eventTags,
            content: content
        )

        return try NostrCrypto.signEvent(event: unsigned, privateKey: keypair.privateKey)
    }
}
```

---

*Document generated from source analysis of claude-relay v0.3.0*
*Packages analyzed: shared (9 files), relay-server (11 files), mcp-server (10 files)*
