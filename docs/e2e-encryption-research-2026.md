# E2E Encryption Meets Content Scanning: Architecture Research (March 2026)

> Source: Katharpy Autoresearch analysis, informed by [un]prompted 2026 conference findings

## Key Finding

No production system has achieved true E2E encryption with simultaneous server-side content scanning. Signal, Apple, Matrix, and Meta have each taken different positions on this tradeoff.

## 4-Stage Migration Plan for claude-relay

### Stage 1 (1-2 weeks): Encryption-aware envelope restructuring
- Typed envelope format separating scannable metadata from payload
- Install `@noble/curves`, `@noble/hashes`, `@noble/ciphers` (Paul Miller's audited, zero-dep, pure-TS crypto)
- Refactor 6-phase scanner to operate on envelope abstraction
- Implement NIP-44 decryption for incoming encrypted Nostr DMs
- Enable Tailnet Lock
- Content scanning remains 100% intact

### Stage 2 (1-3 months): Envelope encryption with message franking
- Per-message DEKs encrypted with recipient public keys via X25519 ECDH
- Message franking: sender HMAC-SHA256 commitment, ChaCha20-Poly1305 encryption
- Client-side scanner with Ed25519 attestation signatures
- Scanning drops to ~80% effectiveness but gains cryptographic audit trail

### Stage 3 (3-6 months): Per-bridge native E2E protocols
- Full NIP-44 + NIP-17/NIP-59 gift wrapping for Nostr bridge
- Client-side encryption before Solid pod writes
- X25519 key agreement for HTTP REST API clients
- Lightweight KMS in macOS Keychain + per-client public key registry
- Scanning ~50%, metadata + timing heuristics + client attestations

### Stage 4 (6-12+ months): Full MLS with post-quantum readiness
- MLS (RFC 9420) via ts-mls for group messaging (O(log N) group ops vs Signal's O(N))
- Post-quantum hybrid: `@noble/post-quantum` for ML-KEM-768 + X25519
- Key transparency log for public key auditing
- Content scanning ~20-30%, metadata + attestation + message franking

## Recommended Library Stack
- `@noble/curves` — secp256k1/X25519/Ed25519
- `@noble/hashes` — SHA-256/HMAC/HKDF
- `@noble/ciphers` — ChaCha20-Poly1305/AES-256-GCM
- `@noble/post-quantum` — ML-KEM (Stage 4)
- `libsodium-wrappers` — streaming encryption, sealed boxes
- AVOID: `@signalapp/libsignal-client` (144MB native Rust binaries), tweetnacl (deprecated)

## Signal Mode Architecture
When mode='signal', relay becomes dumb pipe. AI agents excluded, scanner unnecessary, clean E2E possible. Key exchange via existing Nostr keypair infrastructure (NIP-44 X25519 ECDH). Messages stored as encrypted blobs or not stored at all (ephemeral).

## TEE Status (2024-2025 vulnerabilities)
- Intel SGX → superseded by TDX (5 vulns found by Google Cloud, patched Feb 2026)
- AMD SEV-SNP: CVE-2024-56161, CVE-2025-0033 "RMPocalypse", CVE-2025-29943 "StackWarp"
- TEE.Fail (ACM CCS Oct 2025): sub-$1000 physical attack extracts keys from SGX/TDX/SEV-SNP
- ARM CCA: no public vulns yet, less scrutiny

## FHE Status
- 100x to 1,000,000x slower than plaintext
- Not viable for real-time messaging (2026)
- DARPA DPRIVE: Intel HERACLES ASIC ~1,000,000x speedup (research stage)

## MPC Status
- Production for: crypto custody (Fireblocks), analytics (Prio/ENPA), contact discovery (Signal)
- NOT used for real-time content scanning anywhere
- 3-5 node setup: seconds to minutes latency per message
