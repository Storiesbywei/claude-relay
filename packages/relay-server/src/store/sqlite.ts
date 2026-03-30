import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Session, StoredMessage, ParticipantInfo } from "@claude-relay/shared";
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
    last_activity_at TEXT NOT NULL
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
`);

// ---------------------------------------------------------------------------
// Prepared statements — hot-path queries
// ---------------------------------------------------------------------------

const stmts = {
  insertSession: db.prepare(`
    INSERT INTO sessions (id, name, creator_token, invite_token, sequence_counter, created_at, expires_at, last_activity_at)
    VALUES ($id, $name, $creator_token, $invite_token, 0, $created_at, $expires_at, $last_activity_at)
  `),

  getSessionById: db.prepare(`
    SELECT * FROM sessions WHERE id = $id
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
    INSERT INTO messages (session_id, message_id, sequence, type, title, content, tags, refs, context, sender_name, sent_at, nostr_event_id)
    VALUES ($session_id, $message_id, $sequence, $type, $title, $content, $tags, $refs, $context, $sender_name, $sent_at, $nostr_event_id)
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
  ttlMinutes: number
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
  };
}

export function getSession(id: string): Session | undefined {
  const row = stmts.getSessionById.get({ $id: id }) as SessionRow | null;
  if (!row) return undefined;
  return rowToSession(row);
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

export function getSessionCount(): number {
  return (stmts.countSessions.get() as { cnt: number }).cnt;
}
