/**
 * Noise Transport Session Store
 *
 * Manages active transport sessions (handshake results) with TTL-based
 * expiration. Each transport session holds the derived symmetric keys for
 * a single client connection.
 *
 * Design decisions:
 *   - In-memory Map (not SQLite) — transport sessions are ephemeral and
 *     don't need to survive server restarts. A restart invalidates all
 *     handshakes anyway since nonce counters reset.
 *   - 30-minute default TTL — matches typical relay session lifetimes.
 *   - Monotonic nonce counters prevent replay attacks.
 */

import type { TransportKeys } from "./keypair.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NoiseTransportSession {
  /** Opaque token identifying this transport session (UUID) */
  token: string;
  /** Derived transport keys for this session */
  keys: TransportKeys;
  /** Client's ephemeral public key (for identification/logging) */
  clientPublicKey: Uint8Array;
  /** Monotonic nonce counter for client→server direction */
  clientNonce: bigint;
  /** Monotonic nonce counter for server→client direction */
  serverNonce: bigint;
  /** When this transport session was established */
  createdAt: Date;
  /** When this transport session expires (absolute) */
  expiresAt: Date;
  /** Last time this session was used for encrypt/decrypt */
  lastUsedAt: Date;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000;   // 1 minute

// ─── Store ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, NoiseTransportSession>();

/**
 * Register a new transport session after a successful handshake.
 *
 * @param token         - UUID token for this transport session
 * @param keys          - Derived transport keys (client→server + server→client)
 * @param clientPubKey  - Client's ephemeral X25519 public key
 * @param ttlMs         - Time-to-live in milliseconds (default 30 min)
 */
export function createTransportSession(
  token: string,
  keys: TransportKeys,
  clientPubKey: Uint8Array,
  ttlMs = DEFAULT_TTL_MS,
): void {
  const now = new Date();
  sessions.set(token, {
    token,
    keys,
    clientPublicKey: clientPubKey,
    clientNonce: 0n,
    serverNonce: 0n,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    lastUsedAt: now,
  });
}

/**
 * Look up a transport session by its token.
 * Returns undefined if not found or expired.
 */
export function getTransportSession(token: string): NoiseTransportSession | undefined {
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

/**
 * Advance the client→server nonce counter and return the current value.
 * The caller must use this nonce for decryption, then it's consumed.
 */
export function advanceClientNonce(token: string): bigint | undefined {
  const session = sessions.get(token);
  if (!session) return undefined;
  const nonce = session.clientNonce;
  session.clientNonce += 1n;
  session.lastUsedAt = new Date();
  return nonce;
}

/**
 * Advance the server→client nonce counter and return the current value.
 * The caller must use this nonce for encryption, then it's consumed.
 */
export function advanceServerNonce(token: string): bigint | undefined {
  const session = sessions.get(token);
  if (!session) return undefined;
  const nonce = session.serverNonce;
  session.serverNonce += 1n;
  session.lastUsedAt = new Date();
  return nonce;
}

/**
 * Destroy a transport session (client disconnect or explicit teardown).
 * Zeroizes key material before deletion to minimize exposure window.
 */
export function destroyTransportSession(token: string): boolean {
  const session = sessions.get(token);
  if (session) {
    zeroizeKeys(session.keys);
    session.clientPublicKey.fill(0);
  }
  return sessions.delete(token);
}

/**
 * Sweep expired transport sessions. Called periodically.
 * Zeroizes key material before deletion.
 * @returns Number of sessions removed
 */
export function sweepExpiredTransportSessions(): number {
  const now = new Date();
  let swept = 0;
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) {
      zeroizeKeys(session.keys);
      session.clientPublicKey.fill(0);
      sessions.delete(token);
      swept++;
    }
  }
  return swept;
}

/**
 * Zeroize transport keys by overwriting with zeros.
 * This is a best-effort defense — JavaScript's GC may retain copies,
 * but this eliminates the most accessible reference.
 */
function zeroizeKeys(keys: TransportKeys): void {
  keys.clientToServer.fill(0);
  keys.serverToClient.fill(0);
}

/**
 * Get stats about active transport sessions.
 */
export function getTransportSessionStats(): {
  active: number;
  oldest_created_at: string | null;
} {
  if (sessions.size === 0) {
    return { active: 0, oldest_created_at: null };
  }
  let oldest = new Date();
  for (const session of sessions.values()) {
    if (session.createdAt < oldest) {
      oldest = session.createdAt;
    }
  }
  return {
    active: sessions.size,
    oldest_created_at: oldest.toISOString(),
  };
}

// ─── Periodic Sweep ─────────────────────────────────────────────────────────

const sweepTimer = setInterval(() => {
  const swept = sweepExpiredTransportSessions();
  if (swept > 0) {
    console.log(`[noise] Swept ${swept} expired transport session(s)`);
  }
}, SWEEP_INTERVAL_MS);

// Prevent the timer from keeping the process alive during shutdown
if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
  (sweepTimer as NodeJS.Timeout).unref();
}
