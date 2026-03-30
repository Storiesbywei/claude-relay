# Session Report — Nostr Core Integration

**Date:** March 29, 2026
**Branch:** `feature/nostr-core` (commit `a112e89`, pushed to origin)
**Base:** `origin/dev`
**For:** claude-relay-cozy-fireplace worktree team

---

## What Was Built

### Sprint 1: Nostr Core (4 steps, all shipped)

**Step 1 — API Foundation**
- Session-to-Nostr-pubkey binding (`nostrPubkeys` Map + `pubkeyIndex` for O(1) lookup)
- Optional `nostr_pubkey` field on `POST /sessions` and `POST /sessions/:id/join` (Zod validated, 64-char hex)
- Session tags on all bridged events (`["session", sessionId]`) for scoped filtering
- Wired `onNostrRelayEvent` callback — **WebSocket events now flow into HTTP sessions** (was completely disconnected before)
- `server_pubkey` (npub) + `external_relays` array in `/health` response
- Version bumped to 0.3.0

**Step 2 — Nostr Security Hardening**
- **CRITICAL:** Timestamp bounds check — reject events >15min future or >1hr past
- **CRITICAL:** `event.pubkey` must match `state.authedPubkey` for ALL events (was only NIP-70 protected events)
- Content size check against `MAX_WS_MESSAGE_SIZE`
- Tag count check against `max_event_tags` (100)
- Event ID + pubkey format validation (64-char hex regex)
- NIP-09 deletion support (kind 5 events delete referenced events)
- `validateFilter()` — reject subscription filters with >1000 entries in ids/authors/kinds arrays
- Added NIP-9 to `SUPPORTED_NIPS`, `DELETION_KIND = 5` constant

**Step 3 — Relay Pool + Bridge**
- New file: `relay-pool.ts` (219 lines) — connect to external Nostr relays
  - WebSocket client with NIP-42 auto-auth
  - Exponential backoff reconnection (5 retries)
  - Session-scoped subscription filters
  - `publishToExternal()` called on every bridged message
- `getPoolStatus()` exposed in `/health` endpoint
- `disconnectAll()` in graceful shutdown handler
- Pool keypair wired to server keypair for NIP-42 auth

**Step 4 — MCP Nostr Tools (8 tools total, was 7)**
- New file: `nostr-client.ts` (174 lines) — WebSocket Nostr client for MCP
  - NIP-42 auto-auth using session keypair
  - Event buffering for poll-style retrieval
  - Session subscription convenience method
- New tool: `relay_nostr_connect` — connect to relay WS, auto-subscribe to session events
- `relay_poll` gains `via_nostr` boolean parameter — drain WS buffer instead of HTTP poll
- `relay_create_session` / `relay_join_session` now pass `nostr_pubkey` to server on create/join
- `reconstructKeypair()` — decode nsec bech32 back to Uint8Array private key
- `relay_status` shows Nostr WS connection status per session

### Audit Cleanup
- Deleted dead barrel file (`packages/relay-server/src/nostr/index.ts`)
- Removed unused imports: `ClientMessage`, `signEvent` (MCP), `SESSION_KIND`/`METADATA_KIND`/`AUTH_KIND`
- Removed unused exports: `pubkeyFromSecret()`, `toHex()`, `fromHex()`
- **Deduplicated `eventToMessage()`** — was in both `bridge.ts` and `nostr-utils.ts`, now single source in `shared/nostr-utils.ts`
- Fixed `NostrEvent` import path bug in `nostr-utils.ts`
- Fixed `RelayMessage` type name collision — renamed Zod-inferred type to `StoredRelayMessage`

---

## Stats

| Metric | Value |
|--------|-------|
| Files changed | 22 modified + 4 new + 1 deleted = 26 total |
| Lines | +944 / -119 (net +825) |
| Build errors | 0 (both relay-server and mcp-server) |
| Integration tests | 7/7 pass (health, create, join, send, poll, NIP-11, validation) |
| Security review | Pass (OWASP checks, no injection, no secrets, auth on all routes) |

---

## What's NOT Done (Known Gaps)

1. **`connectRelay()` is never called** — the relay pool is built but no API endpoint or MCP tool triggers it. It's infrastructure waiting for a caller.
2. **No persistence** — still in-memory. Server restart kills everything.
3. **No automated tests** — `bun test` returns nothing.
4. **Content scanner only in MCP** — direct `POST /relay/:id` bypasses scanning entirely (TC-09).
5. **Rate limiter `x-forwarded-for` fallback** — trivially spoofable (TC-02).
6. **Nostr audit remaining issues** — 7 of 15 fixed, 8 remaining (2 critical unaddressed).

---

## Sprint 2 Plan (SPRINT-2.md)

Filed at `SPRINT-2.md` in project root. 17 tasks, P0-P2 prioritized.

**P0 (must ship):** SQLite persistence, relay pool endpoint, server-side content scanner, rate limiter fix, atomic message ingestion, event ID dedup index, event catch-up on reconnect

**P1 (should ship):** Timing-safe token comparison, session export, participant identity in dashboard, WS ping/pong, reconnection jitter

**Research sources used:** 5 parallel agents analyzed Hacking APIs, Applied Cryptography, Twisted Network Programming, Mastering Bitcoin, Pragmatic Programmer + babel MCP library + raw book texts on disk

---

## For the Fireplace Team

The `feature/nostr-core` branch is clean and pushed. It branches from `origin/dev` and does NOT include any pixel-agents, fireplace mode, or dashboard cosmetic changes from `feature/fireplace-mode`. The two branches are independent — fireplace has the cozy UI extras, nostr-core has the protocol infrastructure.

**To merge both into dev:**
```bash
git checkout dev
git merge feature/nostr-core    # protocol infrastructure
git merge feature/fireplace-mode # UI extras (may need conflict resolution on index.ts, health.ts)
```

**Potential conflicts:** Both branches modify `index.ts` (imports) and `health.ts` (response shape). The nostr-core changes are additive — resolve by keeping both sets of imports and merging the health response fields.

**Files the fireplace branch should NOT touch** (owned by nostr-core):
- `packages/relay-server/src/nostr/*` (entire directory)
- `packages/shared/src/nostr-*` (all nostr type/crypto/constant files)
- `packages/mcp-server/src/client/nostr-client.ts`
- `packages/mcp-server/src/tools/relay-nostr.ts`
- `packages/relay-server/src/store/memory.ts` (pubkey binding added)

**Files safe for fireplace to modify:**
- `packages/relay-server/public/*` (dashboard UI)
- `packages/relay-server/src/routes/relay.ts` (sender_name override)
- `docs/*`
