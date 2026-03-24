// Server-side types (not Zod — these are internal to the relay server)

export interface Session {
  id: string;
  name: string;
  creatorToken: string;
  inviteToken: string;
  participants: Map<string, ParticipantInfo>;
  messages: StoredMessage[];
  sequenceCounter: number;
  createdAt: Date;
  expiresAt: Date;
  lastActivityAt: Date;
}

export interface ParticipantInfo {
  token: string;
  name: string;
  joinedAt: Date;
}

export interface StoredMessage {
  message_id: string;
  sequence: number;
  type: string;
  title: string;
  content: string;
  tags?: string[];
  references?: { file: string; lines?: string; note?: string }[];
  context?: { project?: string; stack?: string; branch?: string };
  sender_name?: string;
  sent_at: string;
}

export interface CreateSessionResponse {
  session_id: string;
  creator_token: string;
  invite_token: string;
  expires_at: string;
}

export interface JoinSessionResponse {
  participant_token: string;
  session: {
    id: string;
    name: string;
    participants: string[];
    message_count: number;
    expires_at: string;
  };
}

export interface PollResponse {
  messages: StoredMessage[];
  cursor: number;
  has_more: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  participants: string[];
  message_count: number;
  created_at: string;
  expires_at: string;
  last_activity_at: string;
}

// MCP-side types

export interface PendingMessage {
  id: string;
  sessionId: string;
  payload: {
    type: string;
    title: string;
    content: string;
    tags?: string[];
    references?: { file: string; lines?: string; note?: string }[];
    context?: { project?: string; stack?: string; branch?: string };
  };
  warnings: string[];
  createdAt: Date;
}

export interface ActiveSession {
  session_id: string;
  token: string;
  name: string;
  role: "creator" | "participant";
  cursor: number;
}
