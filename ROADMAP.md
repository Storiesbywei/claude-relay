# Claude Relay — Roadmap

## Vision
Google Docs for coding — a shared workspace where a director (human or cheap-plan Claude) and a worker (expensive-plan Claude) collaborate in real-time through a relay. Both parties see the same live session: chat, file structure, and code changes.

---

## Phase 1: Core Relay (DONE)
*Status: Complete and verified*

- [x] Relay server (Hono, port 4190, in-memory store)
- [x] Session management (create, join, invite tokens, TTL expiry)
- [x] Message relay (send, poll, cursor-based pagination)
- [x] Bearer token auth + rate limiting (30 req/min)
- [x] Sensitive content scanner (API keys, tokens, paths)
- [x] 6 MCP tools (create, join, send, approve, poll, status)
- [x] Approval queue (stage → review → approve/reject)
- [x] Auto-poll hook (relay-poll.sh on Claude Code Stop events)
- [x] One-command setup script

## Phase 2: Dashboard v2 (DONE)
*Status: Complete and verified*

- [x] Web dashboard at localhost:4190
- [x] Mode toggle slider (Director / Peer)
- [x] Director mode — single panel, message input, live polling
- [x] Peer mode — split-panel, relay spine visualization
- [x] 3 simulation scripts (Security Audit, Code Review, Bug Hunt) — 4th (Workspace) added in Phase 3
- [x] Session management in UI (create, join, copy invite token)
- [x] SSE endpoint for live streaming
- [x] Session persistence (localStorage)
- [x] Connection status indicator

## Phase 3: Shared Workspace View (DONE)
*Status: Complete and verified*

- [x] File tree sidebar — worker relays project structure snapshots
- [x] Live file changes — worker sends diffs as they edit
- [x] Code viewer in dashboard (diff highlighting, line numbers)
- [x] File reference linking (click a file ref in chat → see the code)
- [x] Worker status indicator (idle, reading, writing, testing)
- [x] Workspace simulation demo (4th simulation script)
- [x] 5 new message types (file_tree, file_change, file_read, terminal, status_update)

## Docker Support (DONE)
*Status: Complete and verified*

- [x] Dockerfile (oven/bun:1.3-alpine, multi-layer caching)
- [x] docker-compose.yml (single-service, port 4190, RELAY_ORIGIN env)
- [x] .dockerignore (excludes mcp-server, hooks, scripts, docs)

## Security Hardening (DONE)
*Status: Complete and verified*

- [x] CORS restricted to localhost + RELAY_ORIGIN env + ngrok domains
- [x] XSS protection — escapeHtml with quote escaping in dashboard
- [x] Shell injection prevention — quoted heredoc in relay-poll.sh

## Phase 4: Multi-User & Persistence
*Status: Future*

- [ ] SQLite or Redis store (survive server restarts)
- [ ] Session history & replay
- [ ] Multiple workers per session (team collaboration)
- [ ] Role-based permissions (director, reviewer, worker)
- [ ] Session bookmarks / save points

## Phase 5: Remote & Cloud
*Status: Partially done*

- [x] Remote worker support via ngrok (setup.sh accepts custom URL)
- [x] Dynamic API URL in dashboard (auto-detects origin)
- [x] URL parameters for auto-joining (?session=...&token=...)
- [ ] Deploy relay server to cloud (Fly.io / Railway)
- [ ] Secure WebSocket transport (wss://)
- [ ] End-to-end encryption for message content
- [ ] Authentication (API keys or OAuth)
- [ ] Session sharing via URL (no manual token copy)
- [ ] Public relay registry (opt-in discovery)

## Phase 6: IDE Integration
*Status: Aspirational*

- [ ] VS Code extension — embedded relay panel
- [ ] File tree sync from actual workspace
- [ ] Diff viewer for worker's changes
- [ ] One-click approve/reject for code changes
- [ ] Terminal output streaming

---

## Key Insight: Plan Asymmetry
The $20/mo Claude Pro user can direct a $200/mo Claude Max worker through the relay. The director sends lightweight text instructions (pennies of compute), while the worker does heavy coding (hours of work). The relay makes the expensive plan's compute accessible to the cheap plan user — a force multiplier.

## Tech Stack
- **Runtime**: Bun 1.3+
- **Server**: Hono (HTTP framework)
- **Validation**: Zod
- **MCP**: @modelcontextprotocol/sdk
- **Dashboard**: Vanilla HTML/CSS/JS (no framework)
- **State**: In-memory (Phase 1-3), SQLite (Phase 4+)
