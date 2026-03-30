import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Session, StoredMessage, ParticipantInfo, SolidExportConfig } from "@claude-relay/shared";
import { LIMITS } from "@claude-relay/shared";

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../../..");
const DB_DIR = resolve(PROJECT_ROOT, "data");
const DB_PATH = resolve(DB_DIR, "relay.db");

if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema — CREATE TABLE IF NOT EXISTS (no migration system needed)
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    creator_token   TEXT NOT NULL,
    invite_token    TEXT NOT NULL,
    sequence_counter INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'relay'
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_creator_token ON sessions(creator_token);
  CREATE INDEX IF NOT EXISTS idx_sessions_invite_token  ON sessions(invite_token);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at    ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS participants (
    session_id TEXT NOT NULL,
    token      TEXT NOT NULL,
    name       TEXT NOT NULL,
    joined_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, token),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_participants_token ON participants(token);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    sequence        INTEGER NOT NULL,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    tags            TEXT,           -- JSON array
    refs            TEXT,           -- JSON array (references is a reserved-ish word)
    context         TEXT,           -- JSON object
    sender_name     TEXT,
    sent_at         TEXT NOT NULL,
    nostr_event_id  TEXT,
    encrypted       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_seq
    ON messages(session_id, sequence);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_event
    ON messages(session_id, nostr_event_id)
    WHERE nostr_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS nostr_pubkeys (
    session_id TEXT NOT NULL,
    pubkey     TEXT NOT NULL,
    token      TEXT NOT NULL,
    PRIMARY KEY (session_id, pubkey),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_nostr_pubkeys_pubkey ON nostr_pubkeys(pubkey);

  CREATE TABLE IF NOT EXISTS solid_bindings (
    session_id TEXT NOT NULL,
    web_id     TEXT NOT NULL,
    token      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, web_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_solid_bindings_web_id ON solid_bindings(web_id);
`);

// ---------------------------------------------------------------------------
// Schema migrations — add columns to existing tables
// ---------------------------------------------------------------------------

// Add solid_resource_url column if it doesn't exist
try {
  db.exec(`ALTER TABLE messages ADD COLUMN solid_resource_url TEXT`);
} catch {
  // Column already exists — ignore
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_solid_url
    ON messages(session_id, solid_resource_url)
    WHERE solid_resource_url IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Schema migration — idempotent ALTER TABLEs (fail silently if column exists)
// ---------------------------------------------------------------------------

const migrations: string[] = [
  "ALTER TABLE sessions ADD COLUMN pod_url TEXT",
  "ALTER TABLE sessions ADD COLUMN pod_synced_sequence INTEGER DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN solid_config TEXT",
  // NOTE: Existing sessions created before signal mode was introduced will default
  // to 'relay', which is correct — they were never created with signal guarantees.
  // The mode column is IMMUTABLE after creation. There is intentionally NO UPDATE
  // statement for mode anywhere in this file. Any code path that attempts to change
  // a session's mode after creation is a security violation.
  "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'relay'",
  "ALTER TABLE messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0",
  // Disappearing messages: TTL for auto-delete and per-message expiry
  "ALTER TABLE sessions ADD COLUMN disappearing_ttl INTEGER",
  "ALTER TABLE messages ADD COLUMN disappear_after TEXT",
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (_err) {
    // Column already exists — expected for idempotent migration
  }
}

// ─── Capability Lattice: trust_grants table ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS trust_grants (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    granted_by      TEXT NOT NULL,
    granted_at      TEXT NOT NULL,
    key_version     INTEGER NOT NULL,
    level           INTEGER NOT NULL DEFAULT 2,
    capabilities    TEXT NOT NULL DEFAULT '["read"]',
    encrypted_key   TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    revoked_at      TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_trust_grants_session
    ON trust_grants(session_id, active);

  CREATE INDEX IF NOT EXISTS idx_trust_grants_agent
    ON trust_grants(agent_id, active);

  CREATE TABLE IF NOT EXISTS trust_tokens (
    token       TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '["read"]',
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_trust_tokens_session
    ON trust_tokens(session_id);

  CREATE TABLE IF NOT EXISTS key_rotations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    version     INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    nonce       TEXT NOT NULL,
    trigger_agent_id TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, version)
  );

  CREATE INDEX IF NOT EXISTS idx_key_rotations_session
    ON key_rotations(session_id);
`);

// Add key_version column to sessions if it doesn't exist
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1`);
} catch {
  // Column already exists
}

// Sync queue table — always safe with CREATE TABLE IF NOT EXISTS
db.exec(`
  CREATE TABLE IF NOT EXISTS solid_sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_sequence INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, message_sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON solid_sync_queue(status);
`);

// Disappearing messages index — for efficient sweep queries
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_disappear_after
    ON messages(disappear_after)
    WHERE disappear_after IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Prepared statements — hot-path queries
// ---------------------------------------------------------------------------

const stmts = {
  insertSession: db.prepare(`
    INSERT INTO sessions (id, name, creator_token, invite_token, sequence_counter, created_at, expires_at, last_activity_at, mode, disappearing_ttl)
    VALUES ($id, $name, $creator_token, $invite_token, 0, $created_at, $expires_at, $last_activity_at, $mode, $disappearing_ttl)
  `),

  getSessionById: db.prepare(`
    SELECT * FROM sessions WHERE id = $id
  `),

  // Lightweight mode-only lookup — avoids loading all messages/participants.
  // Used by bridge modules for signal mode checks on hot paths.
  getSessionMode: db.prepare(`
    SELECT mode FROM sessions WHERE id = $id
  `),

  getSessionByCreatorToken: db.prepare(`
    SELECT * FROM sessions WHERE creator_token = $token
  `),

  getSessionByParticipantToken: db.prepare(`
    SELECT s.* FROM sessions s
    JOIN participants p ON p.session_id = s.id
    WHERE p.token = $token
  `),

  getParticipants: db.prepare(`
    SELECT token, name, joined_at FROM participants WHERE session_id = $session_id
  `),

  countParticipants: db.prepare(`
    SELECT COUNT(*) as cnt FROM participants WHERE session_id = $session_id
  `),

  insertParticipant: db.prepare(`
    INSERT INTO participants (session_id, token, name, joined_at)
    VALUES ($session_id, $token, $name, $joined_at)
  `),

  updateLastActivity: db.prepare(`
    UPDATE sessions SET last_activity_at = $now WHERE id = $id
  `),

  getSequenceCounter: db.prepare(`
    SELECT sequence_counter FROM sessions WHERE id = $id
  `),

  incrementSequence: db.prepare(`
    UPDATE sessions SET sequence_counter = sequence_counter + 1 WHERE id = $id
    RETURNING sequence_counter
  `),

  insertMessage: db.prepare(`
    INSERT INTO messages (session_id, message_id, sequence, type, title, content, tags, refs, context, sender_name, sent_at, nostr_event_id, solid_resource_url, encrypted, disappear_after)
    VALUES ($session_id, $message_id, $sequence, $type, $title, $content, $tags, $refs, $context, $sender_name, $sent_at, $nostr_event_id, $solid_resource_url, $encrypted, $disappear_after)
  `),

  countMessages: db.prepare(`
    SELECT COUNT(*) as cnt FROM messages WHERE session_id = $session_id
  `),

  getMessagesSince: db.prepare(`
    SELECT * FROM messages
    WHERE session_id = $session_id AND sequence > $since
    ORDER BY sequence ASC
    LIMIT $limit
  `),

  countMessagesSince: db.prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE session_id = $session_id AND sequence > $since
  `),

  hasEventId: db.prepare(`
    SELECT 1 FROM messages
    WHERE session_id = $session_id AND nostr_event_id = $event_id
    LIMIT 1
  `),

  getExpiredSessions: db.prepare(`
    SELECT id FROM sessions WHERE expires_at < $now
  `),

  deleteSession: db.prepare(`
    DELETE FROM sessions WHERE id = $id
  `),

  countSessions: db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions
  `),

  insertPubkey: db.prepare(`
    INSERT OR REPLACE INTO nostr_pubkeys (session_id, pubkey, token)
    VALUES ($session_id, $pubkey, $token)
  `),

  getSessionByPubkey: db.prepare(`
    SELECT np.token, s.* FROM nostr_pubkeys np
    JOIN sessions s ON s.id = np.session_id
    WHERE np.pubkey = $pubkey
  `),

  getPubkeysForSession: db.prepare(`
    SELECT pubkey, token FROM nostr_pubkeys WHERE session_id = $session_id
  `),

  isCreatorToken: db.prepare(`
    SELECT 1 FROM sessions WHERE id = $session_id AND creator_token = $token LIMIT 1
  `),

  isParticipantToken: db.prepare(`
    SELECT 1 FROM participants WHERE session_id = $session_id AND token = $token LIMIT 1
  `),

  isInviteTokenStmt: db.prepare(`
    SELECT 1 FROM sessions WHERE id = $session_id AND invite_token = $token LIMIT 1
  `),


  // -------------------------------------------------------------------------
  // Solid sync queue + config prepared statements
  // -------------------------------------------------------------------------

  enqueueSyncEntry: db.prepare(`
    INSERT OR IGNORE INTO solid_sync_queue
      (session_id, message_sequence, status, retry_count, last_error, created_at, updated_at)
    VALUES ($session_id, $message_sequence, 'pending', 0, NULL, $now, $now)
  `),

  dequeueSyncBatch: db.prepare(`
    SELECT * FROM solid_sync_queue
    WHERE status = 'pending'
    ORDER BY message_sequence ASC
    LIMIT $limit
  `),

  markSyncInProgress: db.prepare(`
    UPDATE solid_sync_queue SET status = 'in_progress', updated_at = $now
    WHERE id = $id AND status = 'pending'
  `),

  markSyncCompleted: db.prepare(`
    DELETE FROM solid_sync_queue WHERE id = $id
  `),

  markSyncFailed: db.prepare(`
    UPDATE solid_sync_queue
    SET status = CASE WHEN retry_count + 1 >= 15 THEN 'failed' ELSE 'pending' END,
        retry_count = retry_count + 1,
        last_error = $error,
        updated_at = $now
    WHERE id = $id
  `),

  requeueStaleSyncEntries: db.prepare(`
    UPDATE solid_sync_queue
    SET status = 'pending', updated_at = $now
    WHERE status = 'in_progress'
      AND updated_at < $stale_cutoff
  `),

  getSyncQueueDepth: db.prepare(`
    SELECT COUNT(*) as cnt FROM solid_sync_queue
    WHERE ($session_id IS NULL OR session_id = $session_id)
      AND status IN ('pending', 'in_progress')
  `),

  getSyncQueueStats: db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM solid_sync_queue
  `),

  getSolidConfig: db.prepare(`
    SELECT solid_config FROM sessions WHERE id = $session_id
  `),

  setSolidConfig: db.prepare(`
    UPDATE sessions
    SET solid_config = $config, pod_url = $pod_url
    WHERE id = $session_id
  `),

  getPodSyncedSequence: db.prepare(`
    SELECT pod_synced_sequence FROM sessions WHERE id = $session_id
  `),

  setPodSyncedSequence: db.prepare(`
    UPDATE sessions SET pod_synced_sequence = $sequence
    WHERE id = $session_id AND pod_synced_sequence < $sequence
  `),

  getSolidEnabledSessions: db.prepare(`
    SELECT id, solid_config, pod_synced_sequence
    FROM sessions
    WHERE solid_config IS NOT NULL
  `),

  // -------------------------------------------------------------------------
  // Capability Lattice: trust grants + tokens + key rotations
  // -------------------------------------------------------------------------

  insertTrustGrant: db.prepare(`
    INSERT OR REPLACE INTO trust_grants
      (session_id, agent_id, granted_by, granted_at, key_version, level, capabilities, encrypted_key, active, revoked_at)
    VALUES ($session_id, $agent_id, $granted_by, $granted_at, $key_version, $level, $capabilities, $encrypted_key, 1, NULL)
  `),

  getTrustGrant: db.prepare(`
    SELECT * FROM trust_grants
    WHERE session_id = $session_id AND agent_id = $agent_id AND active = 1
  `),

  getTrustGrantsForSession: db.prepare(`
    SELECT * FROM trust_grants
    WHERE session_id = $session_id
    ORDER BY granted_at ASC
  `),

  getActiveTrustGrantsForSession: db.prepare(`
    SELECT * FROM trust_grants
    WHERE session_id = $session_id AND active = 1
    ORDER BY granted_at ASC
  `),

  revokeTrustGrant: db.prepare(`
    UPDATE trust_grants
    SET active = 0, revoked_at = $revoked_at
    WHERE session_id = $session_id AND agent_id = $agent_id AND active = 1
  `),

  insertTrustToken: db.prepare(`
    INSERT OR REPLACE INTO trust_tokens
      (token, session_id, agent_id, capabilities, created_at, expires_at)
    VALUES ($token, $session_id, $agent_id, $capabilities, $created_at, $expires_at)
  `),

  getTrustToken: db.prepare(`
    SELECT * FROM trust_tokens WHERE token = $token
  `),

  getTrustTokenByAgent: db.prepare(`
    SELECT * FROM trust_tokens
    WHERE session_id = $session_id AND agent_id = $agent_id
  `),

  deleteTrustToken: db.prepare(`
    DELETE FROM trust_tokens WHERE session_id = $session_id AND agent_id = $agent_id
  `),

  deleteExpiredTrustTokens: db.prepare(`
    DELETE FROM trust_tokens WHERE expires_at < $now
  `),

  insertKeyRotation: db.prepare(`
    INSERT INTO key_rotations
      (session_id, version, reason, nonce, trigger_agent_id, created_at)
    VALUES ($session_id, $version, $reason, $nonce, $trigger_agent_id, $created_at)
  `),

  getKeyRotationsForSession: db.prepare(`
    SELECT * FROM key_rotations
    WHERE session_id = $session_id
    ORDER BY version ASC
  `),

  getSessionKeyVersion: db.prepare(`
    SELECT key_version FROM sessions WHERE id = $session_id
  `),

  setSessionKeyVersion: db.prepare(`
    UPDATE sessions SET key_version = $version WHERE id = $session_id
  `),

  // Solid bindings (Level 3 federation)
  insertSolidBinding: db.prepare(`
    INSERT OR REPLACE INTO solid_bindings (session_id, web_id, token, created_at)
    VALUES ($session_id, $web_id, $token, $created_at)
  `),

  getSessionByWebId: db.prepare(`
    SELECT sb.token, s.* FROM solid_bindings sb
    JOIN sessions s ON s.id = sb.session_id
    WHERE sb.web_id = $web_id
  `),

  getSolidBindingsForSession: db.prepare(`
    SELECT web_id, token FROM solid_bindings WHERE session_id = $session_id
  `),

  // Solid resource URL dedup
  hasSolidUrl: db.prepare(`
    SELECT 1 FROM messages
    WHERE session_id = $session_id AND solid_resource_url = $url
    LIMIT 1
  `),

  // Single message by sequence (O(1) indexed lookup)
  getMessageBySequence: db.prepare(`
    SELECT * FROM messages
    WHERE session_id = $session_id AND sequence = $sequence
    LIMIT 1
  `),

  // -------------------------------------------------------------------------
  // Disappearing messages: sweep expired messages
  // -------------------------------------------------------------------------

  sweepDisappearingMessages: db.prepare(`
    DELETE FROM messages
    WHERE disappear_after IS NOT NULL AND disappear_after < $now
  `),

  getDisappearingTtl: db.prepare(`
    SELECT disappearing_ttl FROM sessions WHERE id = $session_id
  `),

  setDisappearingTtl: db.prepare(`
    UPDATE sessions SET disappearing_ttl = $ttl WHERE id = $session_id
  `),
};

// ---------------------------------------------------------------------------
// SSE subscribers — in-memory only (not persisted)
// ---------------------------------------------------------------------------

const sseSubscribers = new Map<string, Set<(msg: StoredMessage) => void>>();

// ---------------------------------------------------------------------------
// Helper: reconstruct a Session object from DB rows
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  name: string;
  creator_token: string;
  invite_token: string;
  sequence_counter: number;
  created_at: string;
  expires_at: string;
  last_activity_at: string;
  pod_url: string | null;
  pod_synced_sequence: number | null;
  solid_config: string | null;
  mode: string | null;
  disappearing_ttl: number | null;
}

interface ParticipantRow {
  token: string;
  name: string;
  joined_at: string;
}

interface MessageRow {
  session_id: string;
  message_id: string;
  sequence: number;
  type: string;
  title: string;
  content: string;
  tags: string | null;
  refs: string | null;
  context: string | null;
  sender_name: string | null;
  sent_at: string;
  nostr_event_id: string | null;
  solid_resource_url: string | null;
  encrypted: number;
  disappear_after: string | null;
}

function rowToSession(row: SessionRow): Session {
  const participants = new Map<string, ParticipantInfo>();
  const pRows = stmts.getParticipants.all({ $session_id: row.id }) as ParticipantRow[];
  for (const p of pRows) {
    participants.set(p.token, {
      token: p.token,
      name: p.name,
      joinedAt: new Date(p.joined_at),
    });
  }

  // Load messages
  const mRows = stmts.getMessagesSince.all({
    $session_id: row.id,
    $since: 0,
    $limit: LIMITS.MAX_MESSAGES_PER_SESSION,
  }) as MessageRow[];
  const messages = mRows.map(rowToMessage);

  // Load nostr pubkey bindings
  const npRows = stmts.getPubkeysForSession.all({ $session_id: row.id }) as { pubkey: string; token: string }[];
  const nostrPubkeys = new Map<string, string>();
  for (const np of npRows) {
    nostrPubkeys.set(np.pubkey, np.token);
  }

  return {
    id: row.id,
    name: row.name,
    creatorToken: row.creator_token,
    inviteToken: row.invite_token,
    participants,
    messages,
    sequenceCounter: row.sequence_counter,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    lastActivityAt: new Date(row.last_activity_at),
    nostrPubkeys,
    mode: (row.mode as 'relay' | 'signal') || 'relay',
    ...(row.disappearing_ttl != null
      ? { disappearing: { enabled: true, ttl_seconds: row.disappearing_ttl } }
      : {}),
  };
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    message_id: row.message_id,
    sequence: row.sequence,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    references: row.refs ? JSON.parse(row.refs) : undefined,
    context: row.context ? JSON.parse(row.context) : undefined,
    sender_name: row.sender_name ?? undefined,
    sent_at: row.sent_at,
    nostr_event_id: row.nostr_event_id ?? undefined,
    solid_resource_url: row.solid_resource_url ?? undefined,
    ...(row.encrypted ? { encrypted: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Exported store functions — same interface as memory.ts
// ---------------------------------------------------------------------------

export function createSession(
  id: string,
  name: string,
  creatorToken: string,
  inviteToken: string,
  ttlMinutes: number,
  mode: 'relay' | 'signal' = 'relay',
  disappearingTtl?: number
): Session {
  const count = (stmts.countSessions.get() as { cnt: number }).cnt;
  if (count >= LIMITS.MAX_SESSIONS) {
    throw new Error(`Max sessions (${LIMITS.MAX_SESSIONS}) reached`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  stmts.insertSession.run({
    $id: id,
    $name: name,
    $creator_token: creatorToken,
    $invite_token: inviteToken,
    $created_at: now.toISOString(),
    $expires_at: expiresAt.toISOString(),
    $last_activity_at: now.toISOString(),
    $mode: mode,
    $disappearing_ttl: disappearingTtl ?? null,
  });

  return {
    id,
    name,
    creatorToken,
    inviteToken,
    participants: new Map(),
    messages: [],
    sequenceCounter: 0,
    createdAt: now,
    expiresAt,
    lastActivityAt: now,
    nostrPubkeys: new Map(),
    mode,
    ...(disappearingTtl != null
      ? { disappearing: { enabled: true, ttl_seconds: disappearingTtl } }
      : {}),
  };
}

export function getSession(id: string): Session | undefined {
  const row = stmts.getSessionById.get({ $id: id }) as SessionRow | null;
  if (!row) return undefined;
  return rowToSession(row);
}

/**
 * Lightweight mode lookup — returns 'relay' | 'signal' without loading
 * messages, participants, or pubkeys. Used by bridge modules on hot paths.
 */
export function getSessionMode(id: string): 'relay' | 'signal' | undefined {
  const row = stmts.getSessionMode.get({ $id: id }) as { mode: string | null } | null;
  if (!row) return undefined;
  return (row.mode as 'relay' | 'signal') || 'relay';
}

export function getSessionByToken(token: string): Session | undefined {
  // Check creator token first
  let row = stmts.getSessionByCreatorToken.get({ $token: token }) as SessionRow | null;
  if (row) return rowToSession(row);

  // Then check participant tokens
  row = stmts.getSessionByParticipantToken.get({ $token: token }) as SessionRow | null;
  if (row) return rowToSession(row);

  return undefined;
}

export function isValidToken(token: string, sessionId: string): boolean {
  if (stmts.isCreatorToken.get({ $session_id: sessionId, $token: token })) return true;
  if (stmts.isParticipantToken.get({ $session_id: sessionId, $token: token })) return true;
  return false;
}

export function isInviteToken(token: string, sessionId: string): boolean {
  return !!stmts.isInviteTokenStmt.get({ $session_id: sessionId, $token: token });
}

export function addParticipant(
  sessionId: string,
  token: string,
  name: string
): ParticipantInfo {
  const sessionRow = stmts.getSessionById.get({ $id: sessionId }) as SessionRow | null;
  if (!sessionRow) throw new Error("Session not found");

  const pCount = (stmts.countParticipants.get({ $session_id: sessionId }) as { cnt: number }).cnt;
  if (pCount >= LIMITS.MAX_PARTICIPANTS) {
    throw new Error(`Max participants (${LIMITS.MAX_PARTICIPANTS}) reached`);
  }

  const now = new Date();
  const info: ParticipantInfo = {
    token,
    name,
    joinedAt: now,
  };

  stmts.insertParticipant.run({
    $session_id: sessionId,
    $token: token,
    $name: name,
    $joined_at: now.toISOString(),
  });

  stmts.updateLastActivity.run({ $id: sessionId, $now: now.toISOString() });

  return info;
}

export function bindPubkeyToSession(sessionId: string, pubkey: string, token: string): void {
  stmts.insertPubkey.run({
    $session_id: sessionId,
    $pubkey: pubkey,
    $token: token,
  });
}

export function getSessionByPubkey(pubkey: string): { session: Session; token: string } | undefined {
  const row = stmts.getSessionByPubkey.get({ $pubkey: pubkey }) as (SessionRow & { token: string }) | null;
  if (!row) return undefined;
  const token = row.token;
  return { session: rowToSession(row), token };
}

export function hasMessageWithEventId(sessionId: string, eventId: string): boolean {
  return !!stmts.hasEventId.get({ $session_id: sessionId, $event_id: eventId });
}

/** Get all Nostr pubkeys registered to a session */
export function getSessionNostrPubkeys(sessionId: string): string[] {
  const rows = stmts.getPubkeysForSession.all({ $session_id: sessionId }) as { pubkey: string; token: string }[];
  return rows.map((r) => r.pubkey);
}

// SSE subscribers: sessionId -> Set of callbacks
export function subscribe(
  sessionId: string,
  cb: (msg: StoredMessage) => void
): () => void {
  if (!sseSubscribers.has(sessionId)) {
    sseSubscribers.set(sessionId, new Set());
  }
  sseSubscribers.get(sessionId)!.add(cb);
  return () => sseSubscribers.get(sessionId)?.delete(cb);
}

// Task 2: Atomic message ingestion — transaction wraps sequence increment + insert
const addMessageTx = db.transaction((sessionId: string, message: StoredMessage) => {
  const sessionRow = stmts.getSessionById.get({ $id: sessionId }) as SessionRow | null;
  if (!sessionRow) throw new Error("Session not found");

  const msgCount = (stmts.countMessages.get({ $session_id: sessionId }) as { cnt: number }).cnt;
  if (msgCount >= LIMITS.MAX_MESSAGES_PER_SESSION) {
    throw new Error(`Max messages (${LIMITS.MAX_MESSAGES_PER_SESSION}) reached`);
  }

  // Atomically increment sequence counter and get new value
  const result = stmts.incrementSequence.get({ $id: sessionId }) as { sequence_counter: number };
  const newSequence = result.sequence_counter;

  message.sequence = newSequence;

  // Compute disappear_after if session has a disappearing TTL
  let disappearAfter: string | null = null;
  const ttlRow = stmts.getDisappearingTtl.get({ $session_id: sessionId }) as { disappearing_ttl: number | null } | null;
  if (ttlRow?.disappearing_ttl) {
    const sentMs = new Date(message.sent_at).getTime();
    disappearAfter = new Date(sentMs + ttlRow.disappearing_ttl * 1000).toISOString();
  }

  stmts.insertMessage.run({
    $session_id: sessionId,
    $message_id: message.message_id,
    $sequence: newSequence,
    $type: message.type,
    $title: message.title,
    $content: message.content,
    $tags: message.tags ? JSON.stringify(message.tags) : null,
    $refs: message.references ? JSON.stringify(message.references) : null,
    $context: message.context ? JSON.stringify(message.context) : null,
    $sender_name: message.sender_name ?? null,
    $sent_at: message.sent_at,
    $nostr_event_id: (message as any).nostr_event_id ?? null,
    $solid_resource_url: (message as any).solid_resource_url ?? null,
    $encrypted: message.encrypted ? 1 : 0,
    $disappear_after: disappearAfter,
  });

  const now = new Date().toISOString();
  stmts.updateLastActivity.run({ $id: sessionId, $now: now });

  return newSequence;
});

export function addMessage(sessionId: string, message: StoredMessage): void {
  addMessageTx(sessionId, message);

  // Notify SSE subscribers (in-memory)
  const subs = sseSubscribers.get(sessionId);
  if (subs) {
    for (const cb of subs) cb(message);
  }
}

export function getMessages(
  sessionId: string,
  since: number,
  limit: number
): { messages: StoredMessage[]; cursor: number; has_more: boolean } {
  const sessionRow = stmts.getSessionById.get({ $id: sessionId }) as SessionRow | null;
  if (!sessionRow) throw new Error("Session not found");

  const rows = stmts.getMessagesSince.all({
    $session_id: sessionId,
    $since: since,
    $limit: limit,
  }) as MessageRow[];

  const messages = rows.map(rowToMessage);

  const totalAfterSince = (stmts.countMessagesSince.get({
    $session_id: sessionId,
    $since: since,
  }) as { cnt: number }).cnt;

  const cursor = messages.length > 0 ? messages[messages.length - 1].sequence : since;

  return {
    messages,
    cursor,
    has_more: totalAfterSince > limit,
  };
}

export function getParticipantNames(session: Session): string[] {
  const names = ["creator"];
  for (const [, info] of session.participants) {
    names.push(info.name || "anonymous");
  }
  return names;
}

export function sweepExpiredSessions(): number {
  const now = new Date().toISOString();
  const expired = stmts.getExpiredSessions.all({ $now: now }) as { id: string }[];

  for (const { id } of expired) {
    stmts.deleteSession.run({ $id: id });
    sseSubscribers.delete(id);
  }

  return expired.length;
}

/**
 * Delete messages whose disappear_after timestamp has passed.
 * Runs on the same sweep interval as session expiry.
 * Returns the number of messages deleted.
 */
export function sweepDisappearingMessages(): number {
  const now = new Date().toISOString();
  const result = stmts.sweepDisappearingMessages.run({ $now: now });
  return result.changes;
}

export function getSessionCount(): number {
  return (stmts.countSessions.get() as { cnt: number }).cnt;
}

// ---------------------------------------------------------------------------

// Solid Pod sync — store helpers
// ---------------------------------------------------------------------------

/** Get the Solid export config for a session, or null if not configured */
export function getSolidConfig(sessionId: string): SolidExportConfig | null {
  const row = stmts.getSolidConfig.get({ $session_id: sessionId }) as { solid_config: string | null } | null;
  if (!row?.solid_config) return null;
  return JSON.parse(row.solid_config) as SolidExportConfig;
}

/** Set the Solid export config for a session (enables sync) */
export function setSolidConfig(sessionId: string, config: SolidExportConfig): void {
  stmts.setSolidConfig.run({
    $session_id: sessionId,
    $config: JSON.stringify(config),
    $pod_url: config.podUrl,
  });
}

/** Get the last synced sequence for a session */
export function getPodSyncedSequence(sessionId: string): number {
  const row = stmts.getPodSyncedSequence.get({ $session_id: sessionId }) as { pod_synced_sequence: number | null } | null;
  return row?.pod_synced_sequence ?? 0;
}

/** Update the last synced sequence (only advances forward) */
export function setPodSyncedSequence(sessionId: string, sequence: number): void {
  stmts.setPodSyncedSequence.run({
    $session_id: sessionId,
    $sequence: sequence,
  });
}

/** Get all sessions that have Solid sync enabled */
export function getSolidEnabledSessions(): { sessionId: string; config: SolidExportConfig; lastSynced: number }[] {
  const rows = stmts.getSolidEnabledSessions.all() as {
    id: string;
    solid_config: string;
    pod_synced_sequence: number | null;
  }[];
  return rows.map((row) => ({
    sessionId: row.id,
    config: JSON.parse(row.solid_config) as SolidExportConfig,
    lastSynced: row.pod_synced_sequence ?? 0,
  }));
}

// Export the raw db instance for use by sync-queue.ts and other modules
export { db };

// ---------------------------------------------------------------------------
// Capability Lattice — trust grant store functions
// ---------------------------------------------------------------------------

import type { StoredTrustGrant, TrustToken, AgentCapability, TrustLevel } from "@claude-relay/shared";

/** Insert or replace a trust grant for an agent in a session */
export function upsertTrustGrant(grant: {
  session_id: string;
  agent_id: string;
  granted_by: string;
  key_version: number;
  level: TrustLevel;
  capabilities: AgentCapability[];
  encrypted_key: string;
}): void {
  const now = new Date().toISOString();
  stmts.insertTrustGrant.run({
    $session_id: grant.session_id,
    $agent_id: grant.agent_id,
    $granted_by: grant.granted_by,
    $granted_at: now,
    $key_version: grant.key_version,
    $level: grant.level,
    $capabilities: JSON.stringify(grant.capabilities),
    $encrypted_key: grant.encrypted_key,
  });
}

/** Get the active trust grant for an agent in a session */
export function getTrustGrant(sessionId: string, agentId: string): StoredTrustGrant | undefined {
  const row = stmts.getTrustGrant.get({ $session_id: sessionId, $agent_id: agentId }) as StoredTrustGrant | null;
  return row ?? undefined;
}

/** Get all trust grants (active + revoked) for a session */
export function getTrustGrantsForSession(sessionId: string): StoredTrustGrant[] {
  return stmts.getTrustGrantsForSession.all({ $session_id: sessionId }) as StoredTrustGrant[];
}

/** Get only active trust grants for a session */
export function getActiveTrustGrantsForSession(sessionId: string): StoredTrustGrant[] {
  return stmts.getActiveTrustGrantsForSession.all({ $session_id: sessionId }) as StoredTrustGrant[];
}

/** Revoke a trust grant. Returns true if a grant was actually revoked. */
export function revokeTrustGrant(sessionId: string, agentId: string): boolean {
  const now = new Date().toISOString();
  const result = stmts.revokeTrustGrant.run({
    $session_id: sessionId,
    $agent_id: agentId,
    $revoked_at: now,
  });
  // Also delete the trust token
  stmts.deleteTrustToken.run({ $session_id: sessionId, $agent_id: agentId });
  return result.changes > 0;
}

/** Issue a trust token for a trusted agent */
export function issueTrustToken(params: {
  session_id: string;
  agent_id: string;
  capabilities: AgentCapability[];
  expires_at: string;
}): string {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  stmts.insertTrustToken.run({
    $token: token,
    $session_id: params.session_id,
    $agent_id: params.agent_id,
    $capabilities: JSON.stringify(params.capabilities),
    $created_at: now,
    $expires_at: params.expires_at,
  });
  return token;
}

/** Validate a trust token and return its metadata, or undefined if invalid/expired */
export function validateTrustToken(token: string): TrustToken | undefined {
  const row = stmts.getTrustToken.get({ $token: token }) as {
    token: string;
    session_id: string;
    agent_id: string;
    capabilities: string;
    created_at: string;
    expires_at: string;
  } | null;

  if (!row) return undefined;

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    // Expired — clean up
    stmts.deleteTrustToken.run({ $session_id: row.session_id, $agent_id: row.agent_id });
    return undefined;
  }

  return {
    token: row.token,
    agent_id: row.agent_id,
    session_id: row.session_id,
    capabilities: JSON.parse(row.capabilities) as AgentCapability[],
    expires_at: row.expires_at,
  };
}

/** Record a key rotation event */
export function recordKeyRotation(params: {
  session_id: string;
  version: number;
  reason: 'agent_invite' | 'agent_revoke' | 'manual';
  nonce: string;
  trigger_agent_id?: string;
}): void {
  const now = new Date().toISOString();
  stmts.insertKeyRotation.run({
    $session_id: params.session_id,
    $version: params.version,
    $reason: params.reason,
    $nonce: params.nonce,
    $trigger_agent_id: params.trigger_agent_id ?? null,
    $created_at: now,
  });
  // Update session key version
  stmts.setSessionKeyVersion.run({
    $session_id: params.session_id,
    $version: params.version,
  });
}

/** Get the current key version for a session */
export function getSessionKeyVersion(sessionId: string): number {
  const row = stmts.getSessionKeyVersion.get({ $session_id: sessionId }) as { key_version: number } | null;
  return row?.key_version ?? 1;
}

/** Clean up expired trust tokens (called by TTL sweep) */
export function sweepExpiredTrustTokens(): number {
  const now = new Date().toISOString();
  const result = stmts.deleteExpiredTrustTokens.run({ $now: now });
  return result.changes;
}

// ---------------------------------------------------------------------------
// Solid bindings (Level 3 federation)
// ---------------------------------------------------------------------------

export function bindWebIdToSession(sessionId: string, webId: string, token: string): void {
  stmts.insertSolidBinding.run({
    $session_id: sessionId,
    $web_id: webId,
    $token: token,
    $created_at: new Date().toISOString(),
  });
}

export function getSessionByWebId(webId: string): { session: Session; token: string } | undefined {
  const row = stmts.getSessionByWebId.get({ $web_id: webId }) as (SessionRow & { token: string }) | null;
  if (!row) return undefined;
  const token = row.token;
  return { session: rowToSession(row), token };
}

export function getSolidBindingsForSession(sessionId: string): { webId: string; token: string }[] {
  const rows = stmts.getSolidBindingsForSession.all({ $session_id: sessionId }) as { web_id: string; token: string }[];
  return rows.map(r => ({ webId: r.web_id, token: r.token }));
}

export function hasMessageWithSolidUrl(sessionId: string, resourceUrl: string): boolean {
  return !!stmts.hasSolidUrl.get({ $session_id: sessionId, $url: resourceUrl });
}

/** Get a single message by session ID and sequence number (O(1) indexed lookup) */
export function getMessageBySequence(sessionId: string, sequence: number): StoredMessage | undefined {
  const row = stmts.getMessageBySequence.get({ $session_id: sessionId, $sequence: sequence }) as MessageRow | null;
  if (!row) return undefined;
  return rowToMessage(row);
}

// ─── Noise Transport: Server Keypair Persistence ────────────────────────────

// Table for the server's static X25519 keypair (persists across restarts)
db.exec(`
  CREATE TABLE IF NOT EXISTS noise_server_keypair (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    private_key TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
`);

const noiseStmts = {
  getKeypair: db.prepare(`SELECT private_key, public_key FROM noise_server_keypair WHERE id = 1`),
  upsertKeypair: db.prepare(`
    INSERT OR REPLACE INTO noise_server_keypair (id, private_key, public_key, created_at)
    VALUES (1, $private_key, $public_key, $created_at)
  `),
};

/**
 * Load the persisted server X25519 keypair from SQLite.
 * Returns null if no keypair has been stored yet.
 */
export function getNoiseServerKeypair(): { privateKey: string; publicKey: string } | null {
  const row = noiseStmts.getKeypair.get() as { private_key: string; public_key: string } | null;
  if (!row) return null;
  return { privateKey: row.private_key, publicKey: row.public_key };
}

/**
 * Persist the server X25519 keypair to SQLite.
 * Uses INSERT OR REPLACE to handle both initial creation and rotation.
 *
 * @param privateKey - Base64-encoded private key
 * @param publicKey  - Base64-encoded public key
 */
export function setNoiseServerKeypair(privateKey: string, publicKey: string): void {
  noiseStmts.upsertKeypair.run({
    $private_key: privateKey,
    $public_key: publicKey,
    $created_at: new Date().toISOString(),
  });
}
