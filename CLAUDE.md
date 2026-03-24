# CLAUDE.md — Claude Relay

## What This Is
Inter-Claude knowledge relay — lets multiple Claude Code sessions (or a human director + Claude worker) share context through a lightweight server. Think Google Docs but for a coding IDE.

## Quick Start
```bash
bun install                           # install deps (from project root)
bun run dev:server                    # start relay on localhost:4190
open http://localhost:4190            # dashboard UI
bash scripts/setup.sh                 # full setup (MCP registration + hooks)
```

## Architecture
```
Monorepo (Bun workspaces)
├── packages/shared/       Zod schemas, types, constants
├── packages/relay-server/ Hono HTTP server + dashboard UI
└── packages/mcp-server/   6 MCP tools for Claude Code
```

**Data flow:** Claude Code → MCP tools → relay-client → relay-server (port 4190) → in-memory store ↔ browser dashboard

## Key Files
| File | Purpose |
|------|---------|
| `packages/shared/src/constants.ts` | Port, limits, message types, sensitive patterns |
| `packages/shared/src/schema.ts` | Zod validation for all payloads |
| `packages/shared/src/types.ts` | TypeScript interfaces (Session, Message, etc.) |
| `packages/relay-server/src/index.ts` | Server entry — Hono app, middleware, routes |
| `packages/relay-server/src/store/memory.ts` | In-memory session store + SSE subscribers |
| `packages/relay-server/src/routes/relay.ts` | POST (send), GET (poll), GET /stream (SSE) |
| `packages/relay-server/src/routes/sessions.ts` | Create, join, info endpoints |
| `packages/relay-server/public/` | Dashboard UI (HTML + CSS + JS) |
| `packages/mcp-server/src/tools/` | 6 MCP tools (session, send, approve, poll, status) |
| `packages/mcp-server/src/approval/` | Approval queue + sensitive content scanner |
| `hooks/relay-poll.sh` | Auto-poll on Claude Code Stop events |
| `scripts/setup.sh` | One-command install (deps + MCP + hooks) |

## Server Endpoints
```
GET  /health                         → server status
POST /sessions                       → create session (returns tokens)
POST /sessions/:id/join              → join with invite token
GET  /sessions/:id                   → session info (auth required)
POST /relay/:id                      → send message (auth required)
GET  /relay/:id                      → poll messages (auth required)
GET  /relay/:id/stream               → SSE live stream (auth required)
GET  /                               → dashboard UI
```

## MCP Tools (6)
| Tool | What It Does |
|------|-------------|
| `relay_create_session` | Create session, get invite token |
| `relay_join_session` | Join with session ID + invite token |
| `relay_send` | Stage message into approval queue |
| `relay_approve` | Approve/reject/list pending messages |
| `relay_poll` | Fetch new messages (cursor auto-advances) |
| `relay_status` | Overview: sessions, pending approvals, health |

## Dashboard Modes
- **Director mode** — Human types instructions, Claude worker responds. Single panel + input box.
- **Peer mode** — Two Claude sessions exchange knowledge. Split-panel view with 3 simulation demos.

## Conventions
- All messages validated with Zod before relay
- Sensitive content scanner checks for API keys, tokens, paths before send
- Bearer token auth on all relay/session endpoints
- In-memory store — sessions expire via TTL (default 60min, max 24h)
- Rate limit: 30 req/min per token
- Max: 50 sessions, 10 participants, 200 messages per session

## Testing
```bash
bun test                              # all tests
bun test packages/relay-server/       # server tests only
curl http://localhost:4190/health     # manual health check
```

## State Files
- `~/.claude-relay/active-sessions.json` — MCP server persists active sessions
- `~/.claude-relay/inbox/` — hook writes incoming messages for discovery
- `localStorage` (browser) — dashboard persists session across refresh
