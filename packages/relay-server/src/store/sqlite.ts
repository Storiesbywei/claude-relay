import { Database } from "bun:sqlite";
import type { Session, StoredMessage, ParticipantInfo } from "@claude-relay/shared";
import { LIMITS } from "@claude-relay/shared";

const db = new Database(process.env.RELAY_DB_PATH || "relay.db", { create: true });

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA foreign_keys=ON");

// --- Schema ---
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

  CREATE TABLE IF NOT EXISTS participants (
    token       TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    joined_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);

  CREATE TABLE IF NOT EXISTS messages (
    message_id  TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence    INTEGER NOT NULL,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    tags        TEXT,          -- JSON array
    refs        TEXT,          -- JSON array (renamed from "references" which is reserved)
    context     TEXT,          -- JSON object
    sender_name TEXT,
    sent_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, sequence);
`);

// --- Prepared statements ---
const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (id, name, creator_token, invite_token, sequence_counter, created_at, expires_at, last_activity_at)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?)
`);

const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

const getSessionByTokenStmt = db.prepare(`
  SELECT s.* FROM sessions s
  LEFT JOIN participants p ON s.id = p.session_id
  WHERE s.creator_token = ? OR p.token = ?
  LIMIT 1
`);

const insertParticipantStmt = db.prepare(`
  INSERT INTO participants (token, session_id, name, joined_at) VALUES (?, ?, ?, ?)
`);

const getParticipantsStmt = db.prepare(`
  SELECT * FROM participants WHERE session_id = ?
`);

const countParticipantsStmt = db.prepare(`
  SELECT COUNT(*) as cnt FROM participants WHERE session_id = ?
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (message_id, session_id, sequence, type, title, content, tags, refs, context, sender_name, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const bumpSequenceStmt = db.prepare(`
  UPDATE sessions SET sequence_counter = sequence_counter + 1, last_activity_at = ? WHERE id = ?
`);

const getSequenceStmt = db.prepare(`
  SELECT sequence_counter FROM sessions WHERE id = ?
`);

const countMessagesStmt = db.prepare(`
  SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?
`);

const getMessagesStmt = db.prepare(`
  SELECT * FROM messages WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
`);

const countRemainingStmt = db.prepare(`
  SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND sequence > ?
`);

const countSessionsStmt = db.prepare(`SELECT COUNT(*) as cnt FROM sessions`);

const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);

const getExpiredSessionsStmt = db.prepare(`
  SELECT id, creator_token FROM sessions WHERE expires_at < ?
`);

const getParticipantTokensStmt = db.prepare(`
  SELECT token FROM participants WHERE session_id = ?
`);

// --- Transaction helpers ---

const addMessageTx = db.transaction((sessionId: string, message: StoredMessage): number => {
  const msgCount = countMessagesStmt.get(sessionId) as { cnt: number };
  if (msgCount.cnt >= LIMITS.MAX_MESSAGES_PER_SESSION) {
    throw new Error(`Max messages (${LIMITS.MAX_MESSAGES_PER_SESSION}) reached`);
  }

  const now = new Date().toISOString();
  bumpSequenceStmt.run(now, sessionId);

  const row = getSequenceStmt.get(sessionId) as { sequence_counter: number };
  const sequence = row.sequence_counter;

  insertMessageStmt.run(
    message.message_id,
    sessionId,
    sequence,
    message.type,
    message.title,
    message.content,
    message.tags ? JSON.stringify(message.tags) : null,
    message.references ? JSON.stringify(message.references) : null,
    message.context ? JSON.stringify(message.context) : null,
    message.sender_name ?? null,
    message.sent_at,
  );

  return sequence;
});

// --- SSE subscribers (still in-memory — SSE is ephemeral by nature) ---
const sseSubscribers = new Map<string, Set<(msg: StoredMessage) => void>>();

export function subscribe(
  sessionId: string,
  cb: (msg: StoredMessage) => void,
): () => void {
  if (!sseSubscribers.has(sessionId)) {
    sseSubscribers.set(sessionId, new Set());
  }
  sseSubscribers.get(sessionId)!.add(cb);
  return () => sseSubscribers.get(sessionId)?.delete(cb);
}

// --- Public API (matches memory.ts interface) ---

export function createSession(
  id: string,
  name: string,
  creatorToken: string,
  inviteToken: string,
  ttlMinutes: number,
): Session {
  const sessionCount = countSessionsStmt.get() as { cnt: number };
  if (sessionCount.cnt >= LIMITS.MAX_SESSIONS) {
    throw new Error(`Max sessions (${LIMITS.MAX_SESSIONS}) reached`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  insertSessionStmt.run(
    id,
    name,
    creatorToken,
    inviteToken,
    now.toISOString(),
    expiresAt.toISOString(),
    now.toISOString(),
  );

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

function rowToSession(row: any): Session | undefined {
  if (!row) return undefined;

  const participants = new Map<string, ParticipantInfo>();
  const pRows = getParticipantsStmt.all(row.id) as any[];
  for (const p of pRows) {
    participants.set(p.token, {
      token: p.token,
      name: p.name,
      joinedAt: new Date(p.joined_at),
    });
  }

  // Load messages from DB
  const mRows = getMessagesStmt.all(row.id, 0, LIMITS.MAX_MESSAGES_PER_SESSION) as any[];
  const messages: StoredMessage[] = mRows.map(rowToMessage);

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
  };
}

function rowToMessage(row: any): StoredMessage {
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
  };
}

export function getSession(id: string): Session | undefined {
  const row = getSessionStmt.get(id);
  return rowToSession(row);
}

export function getSessionByToken(token: string): Session | undefined {
  const row = getSessionByTokenStmt.get(token, token);
  return rowToSession(row);
}

export function isValidToken(token: string, sessionId: string): boolean {
  const row = getSessionStmt.get(sessionId) as any;
  if (!row) return false;
  if (row.creator_token === token) return true;
  const pRow = db.prepare(`SELECT 1 FROM participants WHERE token = ? AND session_id = ?`).get(token, sessionId);
  return !!pRow;
}

export function isInviteToken(token: string, sessionId: string): boolean {
  const row = getSessionStmt.get(sessionId) as any;
  if (!row) return false;
  return row.invite_token === token;
}

export function addParticipant(
  sessionId: string,
  token: string,
  name: string,
): ParticipantInfo {
  const row = getSessionStmt.get(sessionId) as any;
  if (!row) throw new Error("Session not found");

  const count = countParticipantsStmt.get(sessionId) as { cnt: number };
  if (count.cnt >= LIMITS.MAX_PARTICIPANTS) {
    throw new Error(`Max participants (${LIMITS.MAX_PARTICIPANTS}) reached`);
  }

  const joinedAt = new Date();
  insertParticipantStmt.run(token, sessionId, name, joinedAt.toISOString());

  const info: ParticipantInfo = { token, name, joinedAt };
  return info;
}

export function addMessage(sessionId: string, message: StoredMessage): void {
  const row = getSessionStmt.get(sessionId);
  if (!row) throw new Error("Session not found");

  // FIX: Assign the DB-generated sequence back to the message object.
  // The caller (relay.ts POST handler) reads message.sequence for the response,
  // so we must propagate the value returned by the transaction.
  message.sequence = addMessageTx(sessionId, message);

  // Notify SSE subscribers
  const subs = sseSubscribers.get(sessionId);
  if (subs) {
    for (const cb of subs) cb(message);
  }
}

export function getMessages(
  sessionId: string,
  since: number,
  limit: number,
): { messages: StoredMessage[]; cursor: number; has_more: boolean } {
  const row = getSessionStmt.get(sessionId);
  if (!row) throw new Error("Session not found");

  const rows = getMessagesStmt.all(sessionId, since, limit) as any[];
  const messages = rows.map(rowToMessage);

  const remaining = countRemainingStmt.get(sessionId, since) as { cnt: number };

  const cursor = messages.length > 0 ? messages[messages.length - 1].sequence : since;

  return {
    messages,
    cursor,
    has_more: remaining.cnt > limit,
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
  const expired = getExpiredSessionsStmt.all(now) as any[];
  let swept = 0;

  for (const row of expired) {
    sseSubscribers.delete(row.id);
    deleteSessionStmt.run(row.id); // CASCADE deletes participants + messages
    swept++;
  }

  return swept;
}

export function getSessionCount(): number {
  const row = countSessionsStmt.get() as { cnt: number };
  return row.cnt;
}
