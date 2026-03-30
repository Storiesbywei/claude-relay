# Sprint 2 — Persistence + 4-Party Mode Foundation

**Branch:** `feature/nostr-core` (shipped) → Sprint 2 branches off `dev` after merge
**Duration:** 1 week (Mar 30 – Apr 5, 2026)
**Goal:** Make the relay survive restarts and support 2 humans + 2 Claudes in one session

**Research sources:** 5 agents — Hacking APIs, Applied Cryptography, Twisted Network Programming, Mastering Bitcoin, Pragmatic Programmer + minimalist auditor

---

## P0 — Must Ship

### 1. SQLite Persistence (L)
Replace in-memory store with `bun:sqlite`. Server restart = sessions survive.

| What | Detail |
|------|--------|
| Tables | `sessions`, `messages`, `nostr_events` |
| Migration | Auto-create on first run, same interface as `memory.ts` |
| Event store | Back `event-store.ts` with same DB |
| Files | `packages/relay-server/src/store/sqlite.ts` (new), update `index.ts` to swap |
| Test | Kill server mid-session, restart, poll → messages still there |

**Source:** Minimalist Auditor — "single biggest usability blocker"

### 2. Relay Pool Endpoint + MCP Tool (S)
Unblock the dead `connectRelay()` code. 3 routes + 1 MCP tool.

| What | Detail |
|------|--------|
| Routes | `POST /nostr/relays` (connect), `GET /nostr/relays` (list), `DELETE /nostr/relays/:url` (disconnect) |
| MCP | `relay_nostr_pool` tool — connect/disconnect/list external relays |
| Files | New route file + update `relay-nostr.ts` |
| Test | Connect to `wss://relay.damus.io`, verify events bridge in |

**Source:** Auditor — "2 hours max, strategically critical for federation"

### 3. Atomic Message Ingestion (S)
Prevent sequence corruption when HTTP + Nostr events arrive simultaneously.

| What | Detail |
|------|--------|
| Fix | Synchronous write queue in `addMessage()` using microtask funnel |
| Files | `packages/relay-server/src/store/memory.ts` (or sqlite.ts) |
| Test | Concurrent POST + WS event → sequences never duplicate |

**Source:** Networking Agent — Pragmatic Programmer Tip 57 "Shared State Is Incorrect State"

### 4. Event ID Dedup Index (S)
`hasMessageWithEventId()` is O(n) linear scan. Add `Set<string>` index.

| What | Detail |
|------|--------|
| Fix | `eventIdIndex: Set<string>` alongside messages array, O(1) lookup |
| Files | `store/memory.ts` or `store/sqlite.ts` |

**Source:** Networking Agent — "O(n) to O(1) per bridge event"

---

### 5. Server-Side Content Scanner on Relay Route (S)
**CRITICAL from TC-09:** Scanner only runs in MCP approval queue. Direct `POST /relay/:id` has zero scanning.

| What | Detail |
|------|--------|
| Fix | Add `scanContent()` call in `relay.ts` POST handler, return warnings in response |
| Files | `routes/relay.ts`, import scanner from shared |

**Source:** Security Agent — Hacking APIs Ch.13 encoding evasion + codebase audit

### 6. Rate Limiter: Remove X-Forwarded-For Fallback (S)
**CRITICAL from TC-02:** Fallback to `x-forwarded-for` lets attackers rotate IPs to bypass limits.

| What | Detail |
|------|--------|
| Fix | Key rate limit on auth token only. For unauthenticated endpoints, use socket IP |
| Files | `middleware/rate-limit.ts` |

**Source:** Security Agent — Hacking APIs Ch.13 "Origin Header Spoofing"

### 7. Event Catch-Up on Reconnect (S)
When relay-pool reconnects, include `since: lastEventTimestamp` in the subscription filter to catch missed events. For SSE, use `Last-Event-ID` header to replay from last sequence.

| What | Detail |
|------|--------|
| Fix | Track `relay.lastEventTimestamp`, pass as `since` in REQ filter on reconnect |
| SSE | Read `Last-Event-ID` header, replay via `getMessages(sessionId, lastId, limit)` |
| Files | `relay-pool.ts`, `routes/relay.ts` |

**Source:** Networking Agent — Mastering Bitcoin Ch.6 "Exchanging Inventory" catch-up protocol

---

## P1 — Should Ship

### 6. Timing-Safe Token Comparison (S)
Replace string equality in `isValidToken()` with `crypto.timingSafeEqual()`.

| What | Detail |
|------|--------|
| Fix | Encode tokens to Buffer, use `timingSafeEqual` |
| Files | `store/memory.ts` |
| Test | Verify auth still works, timing attack mitigated |

**Source:** Security Agent — Hypponen side-channel chapter

### 6. Session Export (S)
One endpoint to dump session as Markdown or JSON.

| What | Detail |
|------|--------|
| Route | `GET /relay/:id/export?format=md\|json` |
| Dashboard | Export button in UI |
| Test | Export mid-session → valid markdown with all messages |

**Source:** Auditor — "safety net before persistence is battle-tested"

### 7. Participant Identity in Dashboard (M)
Named participants with human/agent badges for 4-party mode.

| What | Detail |
|------|--------|
| API | Allow any participant to set `sender_name` (not just creator) |
| Dashboard | Colored badges, distinct names per sender |
| Files | `routes/relay.ts`, `public/app.js` |

**Source:** Auditor — "Can't do 4-party without knowing who said what"

### 8. WebSocket Ping/Pong Heartbeat (S)
Dead WS connections go undetected. Add 30s ping, 10s pong timeout.

| What | Detail |
|------|--------|
| Fix | Bun-native ping frames in `handler.ts` + `relay-pool.ts` |
| Test | Kill client silently → server detects and cleans up within 40s |

**Source:** Networking Agent — "Dead connections only detected when a send fails"

### 9. Reconnection Jitter + Periodic Retry (S)
RelayPool gives up after 5 retries (~31s). Add jitter and long-term periodic retry.

| What | Detail |
|------|--------|
| Fix | `delay * (0.5 + Math.random())` jitter, retry every 5min after max |
| Files | `relay-pool.ts` |

**Source:** Networking Agent — TCP/IP exponential backoff best practice

---

## P2 — Nice to Have

### 10. Rate Limiter Hardening (S)
Composite key (token + IP + session), LRU eviction, per-endpoint limits.

**Source:** Security Agent — "x-forwarded-for is trivially spoofable"

### 11. SSE Backpressure (M)
Track pending writes, drop/batch if slow client can't keep up.

**Source:** Networking Agent — "Messages queue in Hono stream buffer unboundedly"

### 12. nsec Private Key Scanner Pattern (S)
Add `nsec1...` and raw hex private key patterns to sensitive content scanner.

**Source:** Security Agent — "Prevents accidental key leak through relay"

### 13. WS Broadcast Backpressure (S)
Check `ws.getBufferedAmount()` before sending. Skip slow subscribers (>64KB buffered), count drops.

**Source:** Networking Agent — Twisted Ch.5 Producer/Consumer pattern

### 14. Timer Registry (S)
Central registry for all setInterval/setTimeout. Graceful shutdown cancels all. Expose on /health.

**Source:** Networking Agent — Twisted Ch.2 Reactor pattern

### 15. Basic Test Suite (M)
Auth bypass, rate limit burst, input validation, session lifecycle, bridge roundtrip.

**Source:** Both auditors — "Zero automated tests. Foundation for everything else."

---

## Sprint Metrics

| Priority | Tasks | Effort |
|----------|-------|--------|
| P0 | 7 tasks | 1L + 6S = ~16h |
| P1 | 5 tasks | 1M + 4S = ~10h |
| P2 | 5 tasks | 1M + 4S = ~10h |
| **Total** | **17 tasks** | **~36h** |

**Realistic scope for 1 week:** P0 (all 7) + P1 (pick 2-3) = 10 tasks

---

## Reference Skills Used

| Skill | Contribution |
|-------|-------------|
| Pragmatic Programmer (Ch.6) | Atomic writes, actor model, blackboard pattern |
| Hypponen — "If It's Smart, It's Vulnerable" | Side-channel attacks, metadata leakage |
| Nakamoto — cypherpunk lineage | Finney remailer → Nostr relay architecture mapping |
| Hacking APIs (raw text) | Bearer token attack vectors, rate limit evasion |
| Applied Cryptography (raw text) | Schnorr sigs, challenge-response patterns |
| Twisted Network Programming | Reactor pattern, ReconnectingClientFactory → relay-pool |
| Mastering Bitcoin | P2P gossip, event dedup, secp256k1 key management |

---

## Blockers & Dependencies

```
SQLite (1) ← blocks → Message cap raise, session archival
Relay Pool endpoint (2) ← blocks → Federation, cloud deploy (Phase 6)
Participant identity (7) ← blocks → 4-party mode (Phase 4)
Test suite (13) ← blocks → Confident iteration on everything above
```

## Definition of Done

- [ ] Server restart preserves sessions (SQLite)
- [ ] `connectRelay("wss://relay.damus.io")` works from MCP or API
- [ ] 4 participants visible with distinct names in dashboard
- [ ] Export session as markdown
- [ ] No sequence corruption under concurrent load
- [ ] WS dead connections detected within 40s
