# Claude Relay

A shared workspace relay for Claude Code sessions. One person directs, the other builds — both see everything in real-time through a live dashboard.

Think **Google Docs, but for a coding IDE**.

## Why

If you have the $20/mo Claude Pro plan and your friend has the $200/mo Claude Max plan, the relay lets you direct their Claude Code session through a browser dashboard. You type lightweight instructions (pennies of compute), their Claude does hours of heavy coding, and you watch the results flow back live.

Also works as a peer relay — two Claude Code sessions collaborating on the same codebase, sharing findings and coordinating work.

## Quick Start (Host — Docker)

```bash
git clone https://github.com/Storiesbywei/claude-relay
cd claude-relay
docker compose up -d
open http://localhost:4190
```

That's it. Dashboard is live. To stop: `docker compose down`

## Quick Start (Host — without Docker)

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/Storiesbywei/claude-relay
cd claude-relay
bun install
bun run dev:server
open http://localhost:4190
```

## Quick Start (Worker — same machine)

```bash
cd claude-relay
bash scripts/setup.sh
# Restart Claude Code — relay_* tools are now available
```

## Quick Start (Worker — remote)

The host exposes the relay with ngrok:

```bash
# On host machine
ngrok http 4190
# Copy the https://xxx.ngrok.io URL
```

The remote worker sets up with the ngrok URL:

```bash
git clone https://github.com/Storiesbywei/claude-relay
cd claude-relay
bun install
bash scripts/setup.sh https://xxx.ngrok.io
# Restart Claude Code — relay_* tools point to the host
```

## Dashboard

Open the relay URL in a browser. Two modes:

- **Director mode** — Type instructions, see results. File tree sidebar shows the worker's project structure. Click files to see code + diffs.
- **Peer mode** — Watch two Claude sessions collaborate. Includes 4 simulation demos.

Toggle between modes with the slider at the top.

## How It Works

```
Director (browser)  ──→  Relay Server (port 4190)  ←──  Worker (Claude Code + MCP)
     type instructions        stores messages             reads, codes, sends results
     see results live         manages sessions            shares file tree + diffs
```

1. Director creates a session in the dashboard, copies the invite token
2. Worker's Claude Code joins with `relay_join_session`
3. Director types instructions → Worker's Claude polls with `relay_poll`
4. Worker does the work, sends results via `relay_send` + `relay_approve`
5. Director sees results appear in real-time

## MCP Tools (6)

| Tool | Purpose |
|------|---------|
| `relay_create_session` | Create a session, get invite token |
| `relay_join_session` | Join with session ID + invite token |
| `relay_send` | Stage a message (enters approval queue) |
| `relay_approve` | Approve, reject, or list pending messages |
| `relay_poll` | Fetch new messages from the session |
| `relay_status` | Overview of sessions and server health |

## Architecture

Bun monorepo with 3 packages:

- **@claude-relay/shared** — Zod schemas, types, constants
- **@claude-relay/server** — Hono HTTP server + dashboard UI
- **@claude-relay/mcp** — MCP tools for Claude Code integration

~2,600 lines across 29 files. 77 tests passing.

## Security

- Bearer token auth on all endpoints
- Approval queue — nothing leaves without human consent
- Sensitive content scanner (API keys, tokens, paths)
- Rate limiting (30 req/min per token)
- Sessions auto-expire (default 1 hour)
- In-memory only — nothing persists on restart
