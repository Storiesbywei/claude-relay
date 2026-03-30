# Claude Relay -- Actionable Roadmap

> Generated 2026-03-30 from 10 research docs + source analysis.
> Source branch: `master` (7 commits, ~3,800 source lines, 27 source files)

---

## 1. Current State (What's Shipped)

| Layer | Status | Key Files |
|-------|--------|-----------|
| **HTTP relay** | Working. Hono on port 4190, SQLite persistence, SSE streaming, rate limiting, CORS | `packages/relay-server/src/` |
| **MCP server** | Working. 7 tools (create, join, send, approve, poll, status, share_workspace) via stdio | `packages/mcp-server/src/tools/` |
| **Dashboard** | Working. Director mode + Peer mode, 4 simulation demos, file tree sidebar, file viewer | `packages/relay-server/public/` |
| **AES-256-GCM encryption** | Working. HKDF key derivation, Scan-then-Seal pattern, key fingerprint verification | `packages/shared/src/crypto.ts` |
| **Signal mode** | Partially working. Mode flag on sessions, encrypted-only enforcement (with bypass vectors) | `relay.ts`, `sessions.ts` |
| **Content scanner** | Working (HTTP path only). 11 regex patterns + base64 blob detection | `packages/shared/src/scanner.ts` |
| **Nostr bridge** | Working. NIP-01, NIP-09, NIP-11, NIP-42, NIP-70. External relay pool. Schnorr sig verification | `packages/relay-server/src/nostr/` |
| **Solid bridge** | Level 1 (export-only) working. OIDC auth, JSON-LD export, Pod resource creation | `packages/relay-server/src/solid/` |
| **Docker** | Working. `oven/bun:1.3-alpine`, single-service compose | `Dockerfile`, `docker-compose.yml` |
| **SQLite schema** | sessions, participants, messages (with `encrypted` column), nostr_pubkeys, solid_bindings | `packages/relay-server/src/store/sqlite.ts` |
| **Approval queue** | Working for `relay_send` only. Content scanning with warnings | `packages/mcp-server/src/approval/` |
| **Nostr crypto** | Working. `nostr-tools/pure` for Schnorr, NIP-42 challenge-response | `packages/shared/src/nostr-crypto.ts` |

**Not shipped:** Tests (0 automated), NIP-44 decryption, noble direct imports, forward secrecy, message franking, Solid L2 write-through, Solid L3 federation, iOS client, MLS.

---

## 2. Unfixed Security Findings (from `security-audit-signal-mode.md`)

All CRITICAL (C1-C3) and HIGH (H1-H5) findings were fixed. The following remain open:

| ID | Severity | Description |
|----|----------|-------------|
| M1 | MEDIUM | Client-side scanner (`crypto.js`) missing normalization layer (fullwidth Unicode, leet speak bypass) |
| M2 | MEDIUM | Client-side scanner missing Unicode Tags block detection (U+E0000-U+E007F steganography) |
| M3 | MEDIUM | Signal mode content scanning completely disabled -- no credential leak warnings for humans |
| M4 | MEDIUM | HKDF salt is the predictable session ID (UUID), not a random value |
| L1 | LOW | Derived AES-256-GCM key marked `extractable: true` -- any same-origin JS can export raw key bytes |
| L2 | LOW | URL fragment `#key=...` persists in browser history/bookmarks after session |
| L3 | LOW | Export endpoint leaks ciphertext without encryption metadata for signal-mode sessions |
| I1 | INFO | Crypto implementation is correct (confirmation, no action needed) |
| I2 | INFO | Relay crypto manager memory-only design is sound (confirmation) |
| I3 | INFO | MCP encryption fallback to plaintext is a design risk (intentional availability > confidentiality) |

---

## 3. P2 Security Tasks (from `security-hardening-v2.md`, not started)

| # | Task | Addresses Threat | Files |
|---|------|-----------------|-------|
| P2-11 | Dual LLM pattern for content inspection (Haiku classifier on inbound messages) | Prompt injection, delayed payload, scanner bypass | `scanner.ts`, new `llm-classifier.ts` |
| P2-12 | Disposable workspace sandboxing documentation | MCP tool chain exfiltration | `docs/` |
| P2-13 | Config hash integrity (startup hash of critical files, runtime drift detection) | Novel attack surfaces | New `integrity.ts` in relay-server |
| P2-14 | Canary tokens (decoy API keys in relayed content to detect exfiltration) | Tool chain exfiltration, scanner bypass | `scanner.ts`, `relay-send.ts` |
| P2-15 | Token rotation and expiry (rotate bearer tokens periodically, not just session TTL) | Cross-session data leakage | `sessions.ts`, `auth.ts`, `sqlite.ts` |

---

## 4. Stage 1 Crypto Improvements (1-2 weeks)

Source: `crypto-audit-report.md` findings W1-W6, AP1-AP5 + `e2e-encryption-research-2026.md` Stage 1.

### 4.1 Tasks

| # | Task | Finding | Files to Modify | Change | Complexity |
|---|------|---------|-----------------|--------|:----------:|
| S1-1 | Install noble libraries as direct deps | -- | `package.json` (root) | `bun add @noble/curves@^2.0.1 @noble/hashes@^2.0.1 @noble/ciphers@^2.1.1` | S |
| S1-2 | Fix key extractability | W1, L1 | `packages/shared/src/crypto.ts` | Compute fingerprint from `SHA-256(secret \|\| sessionId)` before HKDF. Set `extractable: false` on line 132. Remove `exportSessionKey`. Update `getKeyFingerprint` to accept `Uint8Array` secret instead of `CryptoKey`. | S |
| S1-3 | Add GCM nonce counter | W2 | `packages/shared/src/crypto.ts` | Add `messageCount` per session key. Log warning at 2^32. Force key rotation at configurable threshold. | S |
| S1-4 | Add AAD to GCM encryption | AP3 | `packages/shared/src/crypto.ts`, `packages/relay-server/public/crypto.js` | Pass `{ session: sessionId, seq: n, sender: name }` as `additionalData` in `encrypt()` and `decrypt()`. | M |
| S1-5 | Secret zeroization | AP2 | `packages/shared/src/crypto.ts`, `packages/mcp-server/src/tools/relay-session.ts` | Call `secret.fill(0)` after `deriveSessionKey()`. | S |
| S1-6 | Typed envelope format | Research Stage 1 | New `packages/shared/src/envelope.ts`, `packages/relay-server/src/routes/relay.ts` | Define `RelayEnvelope { version, metadata, payload }`. Refactor scanner to operate on envelope metadata. | M |
| S1-7 | Unify crypto.ts and crypto.js | W6 | `packages/relay-server/public/crypto.js`, build config | Bundle `crypto.ts` for browser via Bun build step. Delete manual `crypto.js` copy. Add build script to `package.json`. | M |
| S1-8 | NIP-44 decryption for Nostr bridge | Research Stage 1 | `packages/relay-server/src/nostr/bridge.ts` | Use `nostr-tools/nip44` to decrypt kind-1059 gift-wrapped DMs. Add `getConversationKey` caching. | M |
| S1-9 | Persist server keypair | AP5 | `packages/relay-server/src/nostr/bridge.ts` | Load keypair from `~/.claude-relay/server-keypair.json` (0600 perms). Generate only if missing. | S |
| S1-10 | Migrate nsec to macOS Keychain | W5 | `packages/mcp-server/src/state.ts` | Use `security` CLI or `keytar` npm package. Remove plaintext nsec from `active-sessions.json`. | L |
| S1-11 | Port normalization to client scanner | M1, M2 | `packages/relay-server/public/crypto.js` (or bundled from `scanner.ts` after S1-7) | Add `normalizeForScanning()` + Unicode Tags block pattern to client-side `clientSideScan()`. | S |

### 4.2 Dependency Graph

```
S1-1 (noble deps)
  └─→ S1-8 (NIP-44)

S1-2 (key extractability) ← no deps
S1-3 (nonce counter) ← no deps
S1-4 (AAD) ← no deps
S1-5 (zeroization) ← no deps

S1-6 (envelope format) ← no deps, but inform S1-7
S1-7 (unify crypto) ← S1-2, S1-3, S1-4, S1-5 (do crypto fixes first, then bundle)
  └─→ S1-11 (client scanner normalization — folded into unified build)

S1-9 (server keypair) ← no deps
S1-10 (keychain migration) ← no deps
```

### 4.3 Recommended Order

1. S1-1 (noble deps) -- unblocks S1-8
2. S1-2 (key extractability) -- quick win
3. S1-5 (zeroization) -- quick win
4. S1-3 (nonce counter) -- quick win
5. S1-4 (AAD) -- medium, touches encrypt + decrypt on both sides
6. S1-9 (server keypair) -- quick win
7. S1-6 (envelope format) -- medium, foundational for Stage 2
8. S1-7 + S1-11 (unify crypto + client scanner) -- do together after crypto fixes stabilize
9. S1-8 (NIP-44) -- depends on S1-1
10. S1-10 (keychain migration) -- largest task, independent

---

## 5. Stage 2 Crypto (1-3 months)

Source: `e2e-encryption-research-2026.md` Stage 2, `crypto-audit-report.md` W3/W4.

| # | Task | Finding | Files to Modify | Change | Complexity | Deps |
|---|------|---------|-----------------|--------|:----------:|------|
| S2-1 | Forward secrecy via per-message DEKs | W3 | `crypto.ts`, `envelope.ts` | Generate ephemeral X25519 keypair per message. Encrypt DEK with recipient pubkey. Derive message key via ECDH + HKDF. | L | S1-1, S1-6 |
| S2-2 | Message franking (HMAC-SHA256 commitment) | W4 | `crypto.ts`, `envelope.ts`, `relay.ts` | Sender computes `HMAC-SHA256(franking_key, plaintext)`, includes commitment in envelope. Server stores commitment. Recipient can prove message content to server. | L | S1-6 |
| S2-3 | Client-side attestation (Ed25519 signatures on scan results) | Research Stage 2 | New `packages/shared/src/attestation.ts`, `scanner.ts` | Client signs scan result + message hash with Ed25519. Server stores attestation. Provides cryptographic audit trail for scanning. | L | S1-1 |
| S2-4 | X25519 ECDH key agreement | Research Stage 2 | `crypto.ts`, `packages/mcp-server/src/tools/relay-session.ts` | Each participant generates X25519 keypair at session join. Public keys exchanged via session metadata. Shared secret derived via ECDH. | M | S1-1 |
| S2-5 | ChaCha20-Poly1305 as alternative cipher | Research Stage 2 | `crypto.ts`, `envelope.ts` | Add `CipherSuite` abstraction (`aes-256-gcm` or `chacha20-poly1305`). Session creation specifies cipher. Nostr/signal defaults to ChaCha20. | M | S1-1, S1-6 |
| S2-6 | CipherSuite negotiation in envelope | -- | `envelope.ts`, `schema.ts` | Add `cipher_suite` field to envelope version 2. Recipient checks before decrypting. | S | S2-5 |

### Dependency Chain

```
S1-1 + S1-6 (noble + envelope)
  ├─→ S2-4 (X25519 key agreement)
  │     └─→ S2-1 (per-message DEKs, forward secrecy)
  ├─→ S2-5 (ChaCha20-Poly1305)
  │     └─→ S2-6 (cipher negotiation)
  ├─→ S2-2 (message franking)
  └─→ S2-3 (attestation)
```

---

## 6. Capability Lattice / Agent Invite

Design for selective agent invitation with key grants.

### 6.1 Key Grant Mechanism

| Component | Description | Files |
|-----------|-------------|-------|
| Invite payload extension | `POST /sessions/:id/join` accepts optional `capabilities[]` array | `schema.ts`, `sessions.ts` |
| Capability enum | `read`, `write`, `scan_only`, `approve`, `bridge_nostr`, `bridge_solid` | `types.ts` |
| Per-participant key | Director derives a sub-key per invited agent via `HKDF(master_secret, agent_id)` | `crypto.ts` |
| Capability filter on poll | `relay_poll` filters messages based on agent's granted capabilities | `relay-poll.ts`, `relay.ts` |
| Capability filter on send | `relay_send` checks agent can write before staging | `relay-send.ts`, `relay.ts` |

### 6.2 Forward Secrecy at Invite Boundary

```
Director creates session → master_secret generated
Director invites Agent A with caps=[read, write]:
  1. Derive agent_key = HKDF(master_secret, "agent:" + agent_id + ":" + timestamp)
  2. Agent receives agent_key (not master_secret) in invite URL fragment
  3. Messages sent before invite are NOT decryptable by Agent A
  4. If Agent A is revoked, rotate master_secret → new sub-keys for remaining agents
```

| Task | Files | Complexity |
|------|-------|:----------:|
| Define `Capability` enum and `CapabilityGrant` type | `types.ts` | S |
| Extend `POST /sessions/:id/join` to accept capabilities | `schema.ts`, `sessions.ts`, `sqlite.ts` | M |
| Sub-key derivation per agent | `crypto.ts` | M |
| Capability enforcement in relay routes | `relay.ts` | M |
| Capability enforcement in MCP tools | `relay-poll.ts`, `relay-send.ts` | M |
| Key rotation on agent revoke | `crypto.ts`, `sessions.ts` | L |

### 6.3 Approval Queue Integration

- Agent messages go through approval queue (existing `relay_send` -> `relay_approve` flow)
- Director can set `auto_approve: true` per capability grant (skip queue for trusted agents)
- Stored in `participants` table: `capabilities TEXT` (JSON array), `auto_approve INTEGER DEFAULT 0`

### 6.4 UI: The Checkbox

Dashboard invite modal gets a capability picker:

```
[ ] Read messages
[ ] Write messages
[ ] Auto-approve (skip approval queue)
[ ] Bridge to Nostr
[ ] Bridge to Solid Pod
```

Files: `packages/relay-server/public/app.js`, `packages/relay-server/public/index.html`

---

## 7. Solid Federation (Level 2-3 Remaining Work)

### Level 2: Pod as Persistent Storage (write-through)

Source: `solid-level2-architecture.md`

| # | Task | Files | Complexity | Status |
|---|------|-------|:----------:|--------|
| L2-1 | `solid_sync_queue` table + prepared statements | `sqlite.ts` | M | Schema designed, not implemented |
| L2-2 | SyncEngine background worker (async loop, wake signal, batch processing) | New `solid/sync-engine.ts` | L | Designed, not implemented |
| L2-3 | PodWriter (HTTP PUT to Pod, retry with exponential backoff) | New `solid/pod-writer.ts` | M | Designed, not implemented |
| L2-4 | Startup catch-up flow (compare `pod_synced_sequence` vs `sequence_counter`) | `sync-engine.ts`, `sqlite.ts` | M | Designed, not implemented |
| L2-5 | Add `pod_url`, `pod_synced_sequence`, `solid_config` columns to sessions | `sqlite.ts` | S | Schema designed, not implemented |
| L2-6 | `POST /sessions/:id/solid/enable` endpoint | `sessions.ts` | S | Not implemented |
| L2-7 | Hook `addMessage()` to enqueue sync + signal worker | `sqlite.ts` or `relay.ts` | S | Not implemented |
| L2-8 | Dead letter queue handling + monitoring endpoint | `sync-engine.ts`, `health.ts` | M | Not designed |

### Level 3: Federated Triple Bridge

Source: `solid-level3-federation.md`

| # | Task | Files | Complexity | Status |
|---|------|-------|:----------:|--------|
| L3-1 | `bridgeMessageToSolid` + `bridgeSolidToHttp` + `bridgeSolidToNostr` | New `solid/bridge.ts` | L | Interface designed, not implemented |
| L3-2 | `PodNotificationPool` (WebSocket subscriptions to Pod containers) | New `solid/notification-pool.ts` | L | Interface designed, not implemented |
| L3-3 | Triple-identity binding (Bearer + Nostr pubkey + WebID) | New `solid/identity.ts`, `sqlite.ts` | L | Schema designed (solid_bindings table exists), verification not implemented |
| L3-4 | WAC rule generation for session containers | New `solid/acl.ts` | M | Not designed |
| L3-5 | `solid_resource_url` dedup column on messages + 3-way dedup | `sqlite.ts`, bridge modules | M | Not implemented |
| L3-6 | `POST /sessions/:id/bind-webid` endpoint (Solid-OIDC verification) | `sessions.ts`, `identity.ts` | L | Not implemented |
| L3-7 | Content scanning on Solid-ingested messages (P0-4 from hardening) | `solid/bridge.ts`, `scanner.ts` | M | Not implemented |
| L3-8 | Content scanning on Nostr-bridged messages (P0-5 from hardening) | `nostr/bridge.ts`, `scanner.ts` | M | Not implemented |

---

## 8. iOS Client Milestones

Source: `ios-relay-client.md`

| # | Milestone | Description | Complexity |
|---|-----------|-------------|:----------:|
| iOS-1 | Swift Codable models | Port all Zod schemas to Swift `Codable` structs (15 structs) | M |
| iOS-2 | HTTP REST client (`RelayService`) | `URLSession`-based client: create, join, send, poll, export | M |
| iOS-3 | SSE client (`SSEService`) | `URLSession` streaming via `AsyncStream<StoredMessage>` with `Last-Event-ID` reconnection | M |
| iOS-4 | `SessionManager` (`@Observable`) | Orchestrates RelayService + SSEService, publishes state for SwiftUI | M |
| iOS-5 | SwiftData local caching | `CachedSession` + `CachedMessage` models, offline message queue | M |
| iOS-6 | Keychain token storage | Store bearer tokens + Nostr keypairs in iOS Keychain | S |
| iOS-7 | Nostr WebSocket client (`NostrService`) | NIP-01 event publish/subscribe, NIP-42 auth, secp256k1 signing via `secp256k1.swift` | L |
| iOS-8 | E2E encryption (AES-256-GCM) | Port `crypto.ts` to Swift using `CryptoKit` (AES.GCM + HKDF) | M |
| iOS-9 | SwiftUI views | Session list, message thread, invite sharing, settings | L |
| iOS-10 | Voxlight integration | Embed relay client as a module in Voxlight for collaboration features | M |

**Recommended MVP path:** iOS-1 -> iOS-2 -> iOS-3 -> iOS-4 -> iOS-6 -> iOS-8 -> iOS-9

---

## 9. Priority Order

### NOW (this week)

| # | Task | Source | Complexity | Dependencies |
|---|------|--------|:----------:|:------------:|
| S1-1 | `bun add @noble/curves @noble/hashes @noble/ciphers` | Crypto audit | S | -- |
| S1-2 | Fix key extractability (`extractable: false`) | W1, L1 | S | -- |
| S1-5 | Secret zeroization after key derivation | AP2 | S | -- |
| S1-3 | Add GCM nonce counter per session key | W2 | S | -- |
| S1-4 | Add AAD to GCM encrypt/decrypt | AP3 | M | -- |
| S1-9 | Persist Nostr server keypair to disk | AP5 | S | -- |
| S1-11 | Port normalization + Tags block detection to client scanner | M1, M2 | S | -- |
| M3-fix | Add optional credential-leak warning in signal mode (scan before encrypt, warn-only) | M3 | S | -- |
| L3-fix | Add `encrypted` flag to export endpoint output | L3 | S | -- |

### NEXT (this month)

| # | Task | Source | Complexity | Dependencies |
|---|------|--------|:----------:|:------------:|
| S1-6 | Typed envelope format (`RelayEnvelope`) | Research Stage 1 | M | -- |
| S1-7 | Unify crypto.ts/crypto.js via Bun build | W6 | M | S1-2, S1-3, S1-4, S1-5 |
| S1-8 | NIP-44 decryption for Nostr bridge | Research Stage 1 | M | S1-1 |
| S1-10 | Migrate nsec/encryption_secret to macOS Keychain | W5, H4 | L | -- |
| S2-4 | X25519 ECDH key agreement | Research Stage 2 | M | S1-1 |
| S2-5 | ChaCha20-Poly1305 alternative cipher | Research Stage 2 | M | S1-1, S1-6 |
| S2-2 | Message franking (HMAC-SHA256 commitment) | W4 | L | S1-6 |
| P2-15 | Token rotation and expiry | Hardening v2 | M | -- |
| P2-13 | Config hash integrity (startup drift detection) | Hardening v2 | M | -- |
| CAP-1 | Capability enum + grant types + schema | Capability lattice | M | -- |
| CAP-2 | Sub-key derivation per agent | Capability lattice | M | S1-2 |
| CAP-3 | Capability enforcement in relay routes | Capability lattice | M | CAP-1 |

### LATER (this quarter)

| # | Task | Source | Complexity | Dependencies |
|---|------|--------|:----------:|:------------:|
| S2-1 | Forward secrecy via per-message DEKs | W3 | L | S2-4, S1-6 |
| S2-3 | Client-side attestation (Ed25519 scan signatures) | Research Stage 2 | L | S1-1 |
| S2-6 | CipherSuite negotiation in envelope v2 | Research Stage 2 | S | S2-5 |
| CAP-4 | Key rotation on agent revoke | Capability lattice | L | CAP-2 |
| CAP-5 | Dashboard capability picker UI | Capability lattice | M | CAP-1 |
| P2-11 | Dual LLM content classifier (Haiku) | Hardening v2 | L | -- |
| P2-14 | Canary tokens in relayed content | Hardening v2 | M | -- |
| L2-1..L2-8 | Solid Level 2 (write-through sync engine) | Solid L2 architecture | L (aggregate) | -- |
| L3-1..L3-8 | Solid Level 3 (triple bridge federation) | Solid L3 architecture | L (aggregate) | L2-* |
| MLS | MLS (RFC 9420) via ts-mls + post-quantum hybrid | Research Stage 4 | L | S2-1, S2-4 |
| iOS-1..iOS-9 | iOS client (MVP: HTTP + SSE + crypto) | iOS relay client doc | L (aggregate) | S1-4 (AAD format must be stable) |

---

*Roadmap generated from: e2e-encryption-research-2026.md, crypto-audit-report.md, security-audit-signal-mode.md, security-hardening-v2.md, solid-protocol-integration.md, solid-level2-architecture.md, solid-level3-federation.md, ios-relay-client.md, technical-architecture.md, dashboard-redesign.md, packages/shared/src/crypto.ts, packages/relay-server/src/store/sqlite.ts, packages/shared/src/types.ts*
