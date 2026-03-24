# Claude Relay — Technical Architecture

## System Overview

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Director        │         │  Relay Server     │         │  Worker          │
│  (Human / $20)   │────────▶│  localhost:4190   │◀────────│  (Claude / $200) │
│                  │  HTTP   │                  │  MCP     │                  │
│  Browser UI      │◀────────│  Hono + Memory   │────────▶│  Claude Code     │
│  Dashboard       │  Poll   │  Store           │  Tools   │  MCP Server      │
└─────────────────┘         └──────────────────┘         └─────────────────┘
```

## Package Architecture

### @claude-relay/shared
Shared types, schemas, and constants used by both server and MCP packages.

```
src/
├── constants.ts    RELAY_PORT, LIMITS, MESSAGE_TYPES, SENSITIVE_PATTERNS
├── schema.ts       Zod schemas: RelayMessagePayloadSchema, CreateSessionRequestSchema, etc.
├── types.ts        TypeScript interfaces: Session, StoredMessage, ActiveSession, etc.
└── index.ts        Re-exports everything
```

**Key constants:**
- Port: 4190
- Max sessions: 50, max participants: 10, max messages/session: 200
- Message types: architecture, api-docs, patterns, conventions, question, answer, context, insight, task
- Rate limit: 30 req/min per token
- TTL: default 60min, max 24h

### @claude-relay/server
HTTP relay server built on Hono, serves both the REST API and the dashboard UI.

```
src/
├── index.ts              App setup, middleware chain, static files, TTL sweep
├── middleware/
│   ├── auth.ts           Bearer token extraction + validation
│   └── rate-limit.ts     Sliding window rate limiter (per-token)
├── routes/
│   ├── health.ts         GET /health → { status, version, sessions }
│   ├── sessions.ts       POST /sessions, POST /sessions/:id/join, GET /sessions/:id
│   └── relay.ts          POST /relay/:id (send), GET /relay/:id (poll), GET /relay/:id/stream (SSE)
└── store/
    └── memory.ts         In-memory Map<id, Session>, token index, SSE pub/sub
public/
├── index.html            Dashboard layout (director + peer views)
├── style.css             Dark theme, mode toggle, split panels
└── app.js                Mode switching, session management, polling, 3 simulation scripts
```

**Auth model:**
- `POST /sessions` → returns `creator_token` + `invite_token`
- `POST /sessions/:id/join` with invite_token → returns `participant_token`
- All `/relay/*` routes require `Authorization: Bearer <token>`
- Tokens are UUIDs, indexed in a Map for O(1) lookup

**Message flow:**
1. Client sends POST /relay/:id with `{ type, content, tags?, references?, context? }`
2. Zod validates payload
3. Server assigns sequence number, stores in session.messages[]
4. SSE subscribers notified immediately
5. Pollers get messages via GET /relay/:id?since=<cursor>&limit=<n>

**SSE streaming:**
- GET /relay/:id/stream opens a persistent connection
- Server pushes `event: message` with JSON data on each new message
- Heartbeat ping every 15s to keep connection alive
- Cleanup on client disconnect

### @claude-relay/mcp
MCP server exposing 6 tools to Claude Code via stdio transport.

```
src/
├── index.ts              McpServer setup, register all tools, stdio transport
├── state.ts              Persist active sessions to ~/.claude-relay/active-sessions.json
├── client/
│   └── relay-client.ts   HTTP client wrapping all relay server endpoints
├── approval/
│   ├── queue.ts          Stage messages, generate previews, approve/reject
│   └── scanner.ts        Regex scanner for API keys, tokens, paths, secrets
└── tools/
    ├── relay-session.ts  relay_create_session + relay_join_session
    ├── relay-send.ts     relay_send (stages in approval queue, does NOT send directly)
    ├── relay-approve.ts  relay_approve (approve/reject/list pending)
    ├── relay-poll.ts     relay_poll (fetch new messages, auto-advance cursor)
    └── relay-status.ts   relay_status (sessions, pending count, server health)
```

**Approval queue:**
- `relay_send` does NOT transmit immediately — it stages the message
- Content is scanned for sensitive patterns (API keys, tokens, paths)
- Warnings are surfaced to the user
- `relay_approve action=approve` actually POSTs to the relay server
- This ensures nothing leaves the machine without human consent

**State persistence:**
- Active sessions saved to `~/.claude-relay/active-sessions.json`
- Cursor position tracked per session (so each message is only returned once)
- State survives Claude Code restarts

## Dashboard UI

### Director Mode
```
┌────────────────────────────────────────────┐
│ ✦ Claude Relay  [no session]  Director ○ Peer  ● connected │
├────────────────────────────────────────────┤
│ [+ New Session]  [Session ID] [Token] [Join] │
├────────────────────────────────────────────┤
│  W  Worker Name                    0 msgs  │
│────────────────────────────────────────────│
│                                            │
│  ┌─────────────────────────────┐           │
│  │ Director: Do X              │  (sent)   │
│  └─────────────────────────────┘           │
│           ┌─────────────────────────────┐  │
│  (recv)   │ Worker: Done, here's what...│  │
│           └─────────────────────────────┘  │
│                                            │
├────────────────────────────────────────────┤
│ [question ▾] [Type an instruction...] [Send] │
└────────────────────────────────────────────┘
```

### Peer Mode
```
┌──────────────────┬───┬──────────────────┐
│  Claude Alpha    │ r │  Claude Beta     │
│  researcher      │ e │  implementer     │
│──────────────────│ l │──────────────────│
│  ┌────────────┐  │ a │  ┌────────────┐  │
│  │ A: insight │  │ y │  │ A: insight │  │
│  └────────────┘  │   │  └────────────┘  │
│  ┌────────────┐  │   │  ┌────────────┐  │
│  │ B: answer  │  │   │  │ B: answer  │  │
│  └────────────┘  │   │  └────────────┘  │
└──────────────────┴───┴──────────────────┘
```

## Security Model

1. **Token-based auth** — UUIDs, not guessable, scoped to session
2. **Invite-only sessions** — must have invite_token to join
3. **Approval queue** — messages staged before transmission, human reviews
4. **Content scanning** — regex patterns detect API keys, tokens, secrets, absolute paths
5. **Rate limiting** — 30 req/min per token, sliding window
6. **TTL expiry** — sessions auto-delete after timeout (default 1h)
7. **localhost only** — server binds to 127.0.0.1, not exposed to network
8. **No persistence** — in-memory store, everything gone on restart

## Line Count Summary

| Package | Lines | Files |
|---------|-------|-------|
| shared | 212 | 4 |
| relay-server (TS) | 534 | 7 |
| relay-server (UI) | 857 | 3 |
| mcp-server | 789 | 8 |
| hooks/scripts | 194 | 3 |
| config | 34 | 4 |
| **Total** | **~2,620** | **29** |
