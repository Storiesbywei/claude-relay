# Claude Relay — Q1 Roadmap

## Vision
Google Docs for coding — a shared workspace where humans and Claude Code instances collaborate in real-time through a relay. Everyone sees the same live session: chat, file structure, and code changes.

**Ultimate goal**: Two humans and two Claudes in one session. Start your Claude working on a project, walk away, and your friend keeps directing your Claude through the dashboard — using your compute, saving their tokens.

---

## Phase 1: Core Relay (DONE)

- [x] Relay server (Hono, port 4190, in-memory store)
- [x] Session management (create, join, invite tokens, TTL expiry)
- [x] Message relay (send, poll, cursor-based pagination)
- [x] Bearer token auth + rate limiting (600 req/min)
- [x] Sensitive content scanner (API keys, tokens, paths)
- [x] 7 MCP tools (create, join, send, approve, poll, status, share_workspace)
- [x] Approval queue (stage → review → approve/reject)
- [x] Auto-poll hook (relay-poll.sh on Claude Code Stop events)
- [x] One-command setup script

## Phase 2: Dashboard (DONE)

- [x] Web dashboard at relay URL
- [x] Mode toggle slider (Director / Peer)
- [x] Director mode — single panel, message input, live polling
- [x] Peer mode — split-panel, relay spine visualization
- [x] 4 simulation scripts (Security Audit, Code Review, Bug Hunt, Workspace)
- [x] Session management in UI (create, join, copy invite token)
- [x] SSE endpoint for live streaming
- [x] Session persistence (localStorage)
- [x] Connection status indicator

## Phase 3: Shared Workspace View (DONE)

- [x] File tree sidebar — worker relays project structure snapshots
- [x] Live file changes — worker sends diffs as they edit
- [x] Code viewer in dashboard (diff highlighting, line numbers)
- [x] File reference linking (click a file ref in chat → see the code)
- [x] Worker status indicator (idle, reading, writing, testing)
- [x] Workspace simulation demo (4th simulation script)
- [x] 15 message types (6 core + 3 extended + 5 workspace + file_read)
- [x] All message types exposed through MCP relay_send tool

## Infrastructure (DONE)

- [x] Docker support (oven/bun:1.3-alpine, docker-compose)
- [x] Cross-machine via Tailscale (tested: MacBook Air ↔ Mac mini)
- [x] Remote worker support via ngrok
- [x] Dynamic API URL in dashboard (auto-detects origin)
- [x] Clipboard copy fallback for plain HTTP origins
- [x] Path traversal protection in static file serving
- [x] Graceful shutdown (SIGINT + SIGTERM)

## Security Audit Fixes (DONE)

- [x] Path traversal vulnerability — validate resolved path stays in publicDir
- [x] SIGTERM handler — Docker sends SIGTERM, not SIGINT
- [x] MCP relay_send blocked Phase 3 message types — expanded to all 15
- [x] SSE subscriber memory leak — clean up on session sweep
- [x] Dashboard footer hardcoded localhost:4190 — now uses actual host
- [x] Clipboard API fails on plain HTTP — added execCommand fallback
- [x] Click-to-copy missing on join path — added
- [x] CLAUDE.md rate limit doc wrong (30 vs 600) — fixed

---

## Phase 4: 4-Party Collaborative Mode (NEXT)

The big one. Two humans + two Claudes in one shared session.

```
Dashboard (shared chat room)
├── Human A (MacBook Air)          — types in dashboard or Claude Code
├── Claude-A (bot, MacBook Air)    — responds, writes code
├── Human B (Mac mini)             — types in dashboard, uses A's compute
└── Claude-B (bot, Mac mini)       — responds, writes code
```

### What needs to happen:

- [ ] **Auto-response loop** — Claude Code automatically polls for new messages and responds (not just on Stop events)
- [ ] **Message injection** — Dashboard messages feed into Claude Code's active conversation
- [ ] **4-party chat UI** — Dashboard shows distinct participants with names/avatars
- [ ] **Continuous polling agent** — Claude Code runs in "relay mode" with standing instructions to poll and respond
- [ ] **CLAUDE.md relay config** — Project-level config that auto-enables relay mode for any Claude session
- [ ] **Participant handoff** — Human A walks away, Human B takes over directing the same Claude
- [ ] **Token usage tracking** — Show compute cost per participant

### Key insight:
The $20/mo user can direct the $200/mo user's Claude through the dashboard. The relay makes expensive compute accessible through a cheap browser tab.

## Phase 4.5: Dashboard UX

- [x] Agent/human badges on messages — infer from sender name
- [x] `status_update` renders in chat (was metadata-only, now does both)
- [x] MCP tool description clarifies chat-visible vs metadata-only types
- [ ] **Sender name from POST body** — allow creator to send "on behalf of" named senders
- [ ] **Virtual participants** — creator registers subagent names without requiring join+invite flow
- [ ] **Broader agent detection** — inferSenderTag() keyword list too narrow
- [ ] **Export button** — export session as Markdown (for humans) or JSON/YAML (for LLMs)
- [ ] **Context-safe message sharing** — options for which messages to include, avoid mixing contexts
- [ ] **Context window protection** — virtualized/paginated chat to prevent browser memory issues on long sessions
- [ ] **Message editing** — edit/delete messages in dashboard
- [ ] **Nostr audit fixes** — 15 security issues from 3-agent audit (2 critical)
- [ ] **Nostr→HTTP bridge** — currently one-directional only

## Phase 5: Persistence & History

- [ ] SQLite or Redis store (survive server restarts)
- [ ] Session history & replay
- [ ] Message search
- [ ] Session bookmarks / save points
- [ ] Export session transcript

## Phase 6: Cloud & Security

- [ ] Deploy relay server to cloud (Fly.io / Railway)
- [ ] Secure WebSocket transport (wss://)
- [ ] End-to-end encryption for message content
- [ ] Authentication (API keys or OAuth)
- [ ] Session sharing via URL (no manual token copy)
- [ ] HTTPS / TLS termination

## Phase 7: IDE Integration

- [ ] VS Code extension — embedded relay panel
- [ ] File tree sync from actual workspace (not snapshots)
- [ ] Diff viewer for worker's changes
- [ ] One-click approve/reject for code changes
- [ ] Terminal output streaming

---

## Tech Stack
- **Runtime**: Bun 1.3+
- **Server**: Hono (HTTP + WebSocket)
- **Validation**: Zod
- **MCP**: @modelcontextprotocol/sdk
- **Nostr**: nostr-tools (NIP-01, NIP-11, NIP-42, NIP-70)
- **Dashboard**: Vanilla HTML/CSS/JS (no framework)
- **State**: In-memory (Phase 1-3), SQLite (Phase 5+)
- **Container**: Docker (oven/bun:1.3-alpine)
