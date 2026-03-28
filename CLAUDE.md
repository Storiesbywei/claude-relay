# CLAUDE.md — Claude Relay

## What This Is
Inter-Claude knowledge relay — lets multiple Claude Code sessions (or a human director + Claude worker) share context through a lightweight server. Think Google Docs but for a coding IDE.

## Quick Start
```bash
# Docker (recommended)
docker compose up -d                  # start relay on localhost:4190
docker compose down                   # stop
docker compose logs -f                # view logs

# Without Docker
bun install                           # install deps (from project root)
bun run dev:server                    # start relay on localhost:4190

# Worker setup (MCP registration + hooks)
bash scripts/setup.sh                 # local worker
bash scripts/setup.sh https://xxx.ngrok-free.app  # remote worker

open http://localhost:4190            # dashboard UI
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
| `hooks/install.sh` | Add relay-poll hook to ~/.claude/settings.json |
| `scripts/setup.sh` | One-command install (deps + MCP + hooks) |
| `Dockerfile` | Multi-stage Bun Alpine image for relay server |
| `docker-compose.yml` | Single-service compose (port 4190, RELAY_ORIGIN env) |
| `.dockerignore` | Excludes mcp-server, hooks, scripts, docs from image |

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

## Message Types (14 in constants.ts)
Core (6 — exposed in relay_send): `architecture`, `api-docs`, `patterns`, `conventions`, `question`, `answer`
Extended (3): `context`, `insight`, `task`
Workspace (5 — Phase 3): `file_tree`, `file_change`, `file_read`, `terminal`, `status_update`

## Dashboard Modes
- **Director mode** — Human types instructions, Claude worker responds. File tree sidebar + file viewer + input box.
- **Peer mode** — Two Claude sessions exchange knowledge. Split-panel view with 4 simulation demos (Security Audit, Code Review, Bug Hunt, Workspace).

## Limits (from constants.ts)
| Constant | Value |
|----------|-------|
| `MAX_MESSAGE_SIZE` | 102,400 (100KB) |
| `MAX_MESSAGES_PER_SESSION` | 200 |
| `MAX_SESSIONS` | 50 |
| `MAX_PARTICIPANTS` | 10 |
| `MAX_TITLE_LENGTH` | 200 |
| `MAX_TAGS` | 20 |
| `MAX_TAG_LENGTH` | 50 |
| `MAX_REFERENCES` | 50 |
| `RATE_LIMIT_PER_MINUTE` | 600 |
| `DEFAULT_TTL_MINUTES` | 60 |
| `MAX_TTL_MINUTES` | 1440 (24h) |
| `TTL_SWEEP_INTERVAL_MS` | 60,000 (1min) |

## Conventions
- All messages validated with Zod before relay
- Sensitive content scanner checks for API keys, tokens, paths before send
- Bearer token auth on all relay/session endpoints
- Server binds to 0.0.0.0 (network-accessible, not localhost-only)
- CORS restricted to localhost + configured RELAY_ORIGIN env + ngrok domains
- In-memory store — sessions expire via TTL (default 60min, max 24h)
- Rate limit: 30 req/min per token
- XSS protection: escapeHtml with quote escaping in dashboard

## Testing
```bash
curl http://localhost:4190/health     # manual health check
```
No automated tests exist yet. `bun test` is configured in package.json but no test files have been written.

## State Files
- `~/.claude-relay/active-sessions.json` — MCP server persists active sessions
- `~/.claude-relay/inbox/` — hook writes incoming messages for discovery
- `localStorage` (browser) — dashboard persists session across refresh
