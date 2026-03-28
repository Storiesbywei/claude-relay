import type { Session, StoredMessage, ParticipantInfo } from "@claude-relay/shared";
import { LIMITS } from "@claude-relay/shared";

const sessions = new Map<string, Session>();

// Token → session ID lookup for auth
const tokenIndex = new Map<string, string>();

export function createSession(
  id: string,
  name: string,
  creatorToken: string,
  inviteToken: string,
  ttlMinutes: number
): Session {
  if (sessions.size >= LIMITS.MAX_SESSIONS) {
    throw new Error(`Max sessions (${LIMITS.MAX_SESSIONS}) reached`);
  }

  const now = new Date();
  const session: Session = {
    id,
    name,
    creatorToken,
    inviteToken,
    participants: new Map(),
    messages: [],
    sequenceCounter: 0,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    lastActivityAt: now,
  };

  sessions.set(id, session);
  tokenIndex.set(creatorToken, id);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getSessionByToken(token: string): Session | undefined {
  const sessionId = tokenIndex.get(token);
  if (!sessionId) return undefined;
  return sessions.get(sessionId);
}

export function isValidToken(token: string, sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.creatorToken === token) return true;
  return session.participants.has(token);
}

export function isInviteToken(token: string, sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return session.inviteToken === token;
}

export function addParticipant(
  sessionId: string,
  token: string,
  name: string
): ParticipantInfo {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.participants.size >= LIMITS.MAX_PARTICIPANTS) {
    throw new Error(`Max participants (${LIMITS.MAX_PARTICIPANTS}) reached`);
  }

  const info: ParticipantInfo = {
    token,
    name,
    joinedAt: new Date(),
  };

  session.participants.set(token, info);
  tokenIndex.set(token, sessionId);
  session.lastActivityAt = new Date();
  return info;
}

// SSE subscribers: sessionId → Set of callbacks
const sseSubscribers = new Map<string, Set<(msg: StoredMessage) => void>>();

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

export function addMessage(sessionId: string, message: StoredMessage): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.messages.length >= LIMITS.MAX_MESSAGES_PER_SESSION) {
    throw new Error(
      `Max messages (${LIMITS.MAX_MESSAGES_PER_SESSION}) reached`
    );
  }

  session.sequenceCounter++;
  message.sequence = session.sequenceCounter;
  session.messages.push(message);
  session.lastActivityAt = new Date();

  // Notify SSE subscribers
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
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");

  const filtered = session.messages.filter((m) => m.sequence > since);
  const sliced = filtered.slice(0, limit);
  const cursor =
    sliced.length > 0 ? sliced[sliced.length - 1].sequence : since;

  return {
    messages: sliced,
    cursor,
    has_more: filtered.length > limit,
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
  const now = Date.now();
  let swept = 0;

  for (const [id, session] of sessions) {
    if (session.expiresAt.getTime() < now) {
      tokenIndex.delete(session.creatorToken);
      for (const [token] of session.participants) {
        tokenIndex.delete(token);
      }
      sessions.delete(id);
      sseSubscribers.delete(id);
      swept++;
    }
  }

  return swept;
}

export function getSessionCount(): number {
  return sessions.size;
}
