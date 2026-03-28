# Claude Relay

A shared workspace relay for Claude Code sessions. Two machines, two humans, two Claudes — all collaborating through one live dashboard.

Think **Google Docs, but for a coding IDE**.

## Why

If you have the $20/mo Claude Pro plan and your friend has the $200/mo Claude Max plan, the relay lets you direct their Claude Code session through a browser dashboard. You type lightweight instructions (pennies of compute), their Claude does hours of heavy coding, and you watch the results flow back live.

**Tested and working**: MacBook Air at a cafe directing a Mac mini at home over Tailscale — full bidirectional messaging, file trees, and code diffs in real-time.

## Quick Start

### Host the relay server

```bash
# With Docker
git clone https://github.com/Storiesbywei/claude-relay
cd claude-relay
docker compose up -d
open http://localhost:4190

# Without Docker (Bun)
bun install
bun run dev:server                           # default port 4190
RELAY_PORT=4197 bun run dev:server           # custom port

# Docker lifecycle
docker compose down     # stop
docker compose up -d    # start
docker compose logs -f  # view logs
```

### Set up a worker (same machine)

```bash
bash scripts/setup.sh
# Restart Claude Code — relay_* tools are now available
```

### Set up a remote worker

On the host machine, expose the relay:

```bash
ngrok http 4190         # copy the https://xxx.ngrok-free.app URL
```

On the remote worker's machine:

```bash
git clone https://github.com/Storiesbywei/claude-relay
cd claude-relay
bun install
bash scripts/setup.sh https://xxx.ngrok-free.app
# Restart Claude Code — relay_* tools point to the host
```

### Cross-machine via Tailscale

No ngrok needed — the relay binds to `0.0.0.0` and is accessible over Tailscale directly:

```bash
# On Mac mini (host)
RELAY_PORT=4197 bun run dev:server

# From MacBook Air (worker) — test connectivity
curl http://<tailscale-ip>:4197/health

# Open dashboard from anywhere on the tailnet
open http://<tailscale-ip>:4197
```

## Dashboard

Open the relay URL in a browser. Two modes:

- **Director mode** — Type instructions, see results. File tree sidebar shows the worker's project structure. Click files to see code + diffs.
- **Peer mode** — Watch two Claude sessions collaborate. Includes 4 simulation demos (Security Audit, Code Review, Bug Hunt, Workspace).

Toggle between modes with the slider at the top.

## How It Works

```
Director (browser)  ──→  Relay Server  ←──  Worker (Claude Code + MCP)
     type instructions      stores msgs       reads, codes, sends results
     see results live       manages sessions   shares file tree + diffs
```

1. Director creates a session in the dashboard, copies the invite token
2. Worker's Claude Code joins with `relay_join_session`
3. Director types instructions → Worker's Claude polls with `relay_poll`
4. Worker does the work, sends results via `relay_send` + `relay_approve`
5. Director sees results appear in real-time

## MCP Tools (7)

| Tool | Purpose |
|------|---------|
| `relay_create_session` | Create a session, get invite token |
| `relay_join_session` | Join with session ID + invite token |
| `relay_send` | Stage a message (enters approval queue first) |
| `relay_approve` | Approve, reject, or list pending messages |
| `relay_poll` | Fetch new messages from the session |
| `relay_status` | Overview of sessions and server health |
| `relay_share_workspace` | Scan and share project file tree + key files |

### Message Types (15)

Core (6): `architecture`, `api-docs`, `patterns`, `conventions`, `question`, `answer`
Extended (3): `context`, `insight`, `task`
Workspace (5): `file_tree`, `file_change`, `file_read`, `terminal`, `status_update`

All 15 types are available through the MCP `relay_send` tool.

## Architecture

Bun monorepo with 3 packages:

```
├── packages/shared/        Zod schemas, types, constants
├── packages/relay-server/  Hono HTTP server + dashboard UI (HTML/CSS/JS)
├── packages/mcp-server/    7 MCP tools for Claude Code integration
├── hooks/                  Auto-poll hook for Claude Code Stop events
├── scripts/                One-command setup (MCP registration + hooks)
├── tests/scenarios/        7 test scenario docs with curl scripts
└── docs/                   Technical architecture documentation
```

**Data flow**: Claude Code → MCP tools → approval queue → relay-client → relay-server → in-memory store ↔ browser dashboard (polling)

**Stats**: ~3,800 lines of source across 30 source files. 16 commits. No automated tests yet.

## Server Endpoints

```
GET  /health                → server status + uptime + session count
POST /sessions              → create session (returns tokens)
POST /sessions/:id/join     → join with invite token
GET  /sessions/:id          → session info (auth required)
POST /relay/:id             → send message (auth required)
GET  /relay/:id             → poll messages (auth required, cursor-based)
GET  /relay/:id/stream      → SSE live stream (auth required)
GET  /                      → dashboard UI
```

## Security

- **Path traversal protection** — static file serving validates resolved paths stay within public directory
- **Bearer token auth** on all relay/session endpoints
- **Approval queue** — nothing leaves Claude Code without human consent
- **Sensitive content scanner** — detects API keys, tokens, absolute paths (10 regex patterns)
- **Rate limiting** — 600 req/min per token (sliding window)
- **CORS** — restricted to localhost + configured `RELAY_ORIGIN` env + ngrok domains + Tailscale IPs
- **XSS protection** — `escapeHtml` with quote escaping on all user-facing content
- **Shell injection prevention** — quoted heredoc in relay-poll hook
- **Graceful shutdown** — handles both SIGINT and SIGTERM
- **Sessions auto-expire** — default 1 hour, max 24 hours
- **In-memory only** — nothing persists on restart (by design for Phase 1-3)

## Limits

| Constant | Value |
|----------|-------|
| `MAX_MESSAGE_SIZE` | 100 KB |
| `MAX_MESSAGES_PER_SESSION` | 200 |
| `MAX_SESSIONS` | 50 |
| `MAX_PARTICIPANTS` | 10 |
| `RATE_LIMIT_PER_MINUTE` | 600 |
| `DEFAULT_TTL_MINUTES` | 60 |
| `MAX_TTL_MINUTES` | 1440 (24h) |

## Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `RELAY_PORT` | Server port | 4190 |
| `RELAY_ORIGIN` | Additional CORS origin (ngrok URL, etc.) | none |
| `RELAY_URL` | MCP client target (for remote relay servers) | `http://localhost:4190` |

## Tech Stack

- **Runtime**: Bun 1.3+
- **Server**: Hono (HTTP framework)
- **Validation**: Zod
- **MCP**: @modelcontextprotocol/sdk
- **Dashboard**: Vanilla HTML/CSS/JS (no framework)
- **Container**: Docker (oven/bun:1.3-alpine)
- **State**: In-memory (Phase 1-3)

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full plan.

**Done**: Core relay, dashboard, workspace view, Docker, security hardening, cross-machine Tailscale support

**Next**: 4-party collaborative mode (2 humans + 2 Claudes in one session), auto-polling agent loop, persistent sessions (SQLite), cloud deployment
