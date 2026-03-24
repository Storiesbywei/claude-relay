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
- Message types (14): architecture, api-docs, patterns, conventions, question, answer, context, insight, task, file_tree, file_change, file_read, terminal, status_update
- Rate limit: 30 req/min per token
- TTL: default 60min, max 24h
- Max message size: 100KB, max title: 200 chars, max tags: 20, max references: 50

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
├── index.html            Dashboard layout (director + peer views, file tree sidebar, file viewer)
├── style.css             Dark theme, mode toggle, split panels, workspace styles
└── app.js                Mode switching, session management, polling, 4 simulation scripts
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
┌──────────────────────────────────────────────────────────────┐
│ ✦ Claude Relay  [session]  Director ○ Peer  [worker: idle]   │
├──────────────────────────────────────────────────────────────┤
│ [+ New Session]  [Invite token: xxx] [Copy] [End]            │
├────────┬────────────────────────────────┬────────────────────┤
│ Work-  │  W  Worker Name       0 msgs  │  File Viewer       │
│ space  │────────────────────────────────│  (click file in    │
│        │  ┌──────────────────┐          │   tree or chat     │
│ src/   │  │ Dir: Do X        │  (sent)  │   to open)         │
│  comp/ │  └──────────────────┘          │                    │
│  api/  │       ┌──────────────────┐     │  path: src/api/..  │
│  ...   │       │ Worker: Done...  │     │  ┌──────────────┐  │
│        │       └──────────────────┘     │  │ diff view    │  │
│        │────────────────────────────────│  │ + added      │  │
│        │ [question ▾] [instruction] [Send]│  │ - removed    │  │
├────────┴────────────────────────────────┴────────────────────┤
│ relay server: localhost:4190 | v0.1.0        0 messages      │
└──────────────────────────────────────────────────────────────┘
```
Features: file tree sidebar (populated by file_tree messages), file viewer (code + diff highlighting), worker status pill (idle/reading/writing/testing), typing indicators.

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
4 built-in simulation demos: Security Audit, Code Review, Bug Hunt, Workspace (with file_tree/file_change/file_read messages).

## Security Model

1. **Token-based auth** — UUIDs, not guessable, scoped to session
2. **Invite-only sessions** — must have invite_token to join
3. **Approval queue** — messages staged before transmission, human reviews
4. **Content scanning** — regex patterns detect API keys, tokens, secrets, absolute paths
5. **Rate limiting** — 30 req/min per token, sliding window
6. **TTL expiry** — sessions auto-delete after timeout (default 1h)
7. **CORS restriction** — allows localhost, RELAY_ORIGIN env, and *.ngrok-free.app / *.ngrok.io origins only
8. **XSS protection** — escapeHtml with &, <, >, ", ' escaping on all user content in dashboard
9. **Shell injection prevention** — relay-poll.sh uses quoted heredoc (`<< 'PYEOF'`) to prevent variable expansion
10. **Network-accessible** — server binds to 0.0.0.0 (use firewall or ngrok for controlled exposure)
11. **No persistence** — in-memory store, everything gone on restart

## Docker Architecture

```
Dockerfile: oven/bun:1.3-alpine
├── Layer 1: Copy package.json + bun.lock + bunfig.toml (cached)
├── Layer 2: bun install --frozen-lockfile
├── Layer 3: Copy shared/ + relay-server/ + tsconfig.json
├── Expose: 4190
└── CMD: bun run packages/relay-server/src/index.ts
```

docker-compose.yml:
- Single `relay` service, port 4190:4190
- Environment: RELAY_PORT=4190, RELAY_ORIGIN (optional, for ngrok)
- Restart policy: unless-stopped

.dockerignore excludes: mcp-server/src, hooks, scripts, docs, ROADMAP.md, CLAUDE.md

## Line Count Summary

| Package | Lines | Files |
|---------|-------|-------|
| shared | 218 | 4 |
| relay-server (TS) | 552 | 7 |
| relay-server (UI) | 1,842 | 3 |
| mcp-server | 939 | 10 |
| hooks/scripts | 207 | 3 |
| config (json/toml/yml/Dockerfile/ignore) | 74 | 7 |
| docs (md) | 452 | 4 |
| package.json (sub-packages) | 33 | 3 |
| **Total** | **~4,300** | **41** |
| **Source only (ts/js/html/css/sh)** | **~3,800** | **27** |
