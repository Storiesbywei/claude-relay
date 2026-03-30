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
  // Nostr pubkey → token lookup (for WS→HTTP bridge)
  nostrPubkeys: Map<string, string>;
  /** Session mode: 'relay' (agent collaboration) or 'signal' (encrypted human messenger) */
  mode?: 'relay' | 'signal';
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
  /** Protocol origin: how this message entered the relay */
  origin?: "http" | "nostr" | "solid" | "mcp";
  // Nostr event ID this message was created from (for dedup)
  nostr_event_id?: string;
  // Solid Pod resource URL this message was created from (for dedup)
  solid_resource_url?: string;
  /** True if content is an encrypted payload (Scan-then-Seal E2E encryption) */
  encrypted?: boolean;
}

export interface CreateSessionResponse {
  session_id: string;
  creator_token: string;
  invite_token: string;
  expires_at: string;
  /** Whether client-side E2E encryption is enabled for this session */
  encryption_enabled?: boolean;
  /** First 8 hex chars of the session key hash, for out-of-band verification */
  key_fingerprint?: string;
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

// ─── Capability Lattice Types ──────────────────────────────────────────────

/**
 * Trust levels in the Capability Lattice.
 *
 *   Level 0: Relay Server     — sees only encrypted envelopes + metadata
 *   Level 1: Untrusted Agent  — can see session exists, cannot read content
 *   Level 2: Trusted Agent    — holds session key, can read + send encrypted messages
 *                               approval queue BYPASSED (dangerouslySkipPermissions)
 *   Level 3: Human Participant — full session key holder, can invite/revoke agents
 */
export type TrustLevel = 0 | 1 | 2 | 3;

/** Granular capabilities that can be granted to a trusted agent */
export type AgentCapability =
  | 'read'          // can decrypt and read messages
  | 'write'         // can send encrypted messages
  | 'auto_approve'  // skip approval queue (dangerouslySkipPermissions)
  | 'bridge_nostr'  // can bridge messages to Nostr
  | 'bridge_solid'; // can bridge messages to Solid Pod

/** A trust grant issued by a Level 3 human to an agent */
export interface TrustGrant {
  /** Unique identifier for the agent (MCP client ID or human-assigned name) */
  agent_id: string;
  /** Participant name who granted trust */
  granted_by: string;
  /** ISO 8601 timestamp of when trust was granted */
  granted_at: string;
  /** Which key version the agent holds (cannot decrypt earlier versions) */
  key_version: number;
  /** Trust level — always 2 for agents */
  level: TrustLevel;
  /** Capabilities granted to this agent */
  capabilities: AgentCapability[];
  /** Base64-encoded encrypted session sub-key (opaque to the relay server) */
  encrypted_key: string;
  /** Whether the grant is currently active (false = revoked) */
  active: boolean;
}

/** Event inserted into the timeline when keys are rotated */
export interface KeyRotationEvent {
  /** Discriminator for the relay to store as opaque event */
  type: 'key_rotation';
  /** New key version number (monotonically increasing) */
  version: number;
  /** Why the rotation happened */
  reason: 'agent_invite' | 'agent_revoke' | 'manual';
  /** Base64-encoded nonce used for HKDF derivation of the new key */
  nonce: string;
  /** Encrypted key grants for each participant who should receive the new key */
  grants: TrustGrant[];
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent ID that triggered the rotation (for invite/revoke) */
  trigger_agent_id?: string;
}

/**
 * Stored in SQLite trust_grants table. The relay sees this metadata
 * but CANNOT decrypt the encrypted_key field.
 */
export interface StoredTrustGrant {
  id: number;
  session_id: string;
  agent_id: string;
  granted_by: string;
  granted_at: string;
  key_version: number;
  level: TrustLevel;
  capabilities: string; // JSON-encoded AgentCapability[]
  encrypted_key: string;
  active: number; // SQLite boolean (0/1)
  revoked_at: string | null;
}

/**
 * Trust token: a short-lived bearer token that proves an agent has been
 * granted Level 2 trust. The relay validates this to skip the approval queue
 * and allow MCP origin in signal mode.
 */
export interface TrustToken {
  /** The trust token string (UUID) */
  token: string;
  /** Agent ID this token belongs to */
  agent_id: string;
  /** Session ID the token is scoped to */
  session_id: string;
  /** Capabilities granted */
  capabilities: AgentCapability[];
  /** Expiry (matches session expiry) */
  expires_at: string;
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
  // Nostr identity for this session
  nostr?: {
    pubkey: string; // hex public key
    npub: string; // bech32 public key
    nsec: string; // bech32 secret key (stored locally only)
  };
  // E2E encryption secret (URL-safe base64). Used by MCP tools to
  // derive the session key via HKDF. Stored locally only.
  encryption_secret?: string;
  // ─── Capability Lattice (trusted agent) ──────────────
  /** Trust level: 1 = untrusted agent, 2 = trusted agent, 3 = human */
  trust_level?: TrustLevel;
  /** Trust token for Level 2 agents (proves trust grant to the relay) */
  trust_token?: string;
  /** Capabilities granted via trust (only for Level 2 agents) */
  capabilities?: AgentCapability[];
  /** Current key version this participant holds */
  key_version?: number;
}
