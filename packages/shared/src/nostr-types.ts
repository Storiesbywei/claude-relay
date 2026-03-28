// Nostr protocol types (NIP-01 compliant)

/** A Nostr event as defined by NIP-01 */
export interface NostrEvent {
  id: string; // 32-byte lowercase hex SHA256
  pubkey: string; // 32-byte lowercase hex public key
  created_at: number; // Unix timestamp in seconds
  kind: number; // Event kind (0-65535)
  tags: string[][]; // Array of tag arrays
  content: string; // Arbitrary string content
  sig: string; // 64-byte lowercase hex Schnorr signature
}

/** Unsigned event template (before id/sig are computed) */
export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** NIP-01 subscription filter */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  // Tag filters: #e, #p, #t, #d, etc.
  [key: `#${string}`]: string[] | undefined;
}

// --- Client-to-Relay messages ---

export type ClientEventMessage = ["EVENT", NostrEvent];
export type ClientReqMessage = ["REQ", string, ...NostrFilter[]];
export type ClientCloseMessage = ["CLOSE", string];
export type ClientAuthMessage = ["AUTH", NostrEvent];

export type ClientMessage =
  | ClientEventMessage
  | ClientReqMessage
  | ClientCloseMessage
  | ClientAuthMessage;

// --- Relay-to-Client messages ---

export type RelayEventMessage = ["EVENT", string, NostrEvent];
export type RelayOkMessage = ["OK", string, boolean, string];
export type RelayEoseMessage = ["EOSE", string];
export type RelayClosedMessage = ["CLOSED", string, string];
export type RelayNoticeMessage = ["NOTICE", string];
export type RelayAuthMessage = ["AUTH", string];

export type RelayMessage =
  | RelayEventMessage
  | RelayOkMessage
  | RelayEoseMessage
  | RelayClosedMessage
  | RelayNoticeMessage
  | RelayAuthMessage;

// --- Session keypair ---

export interface NostrKeypair {
  privateKey: Uint8Array; // 32-byte secret key
  publicKey: string; // hex-encoded public key
  npub: string; // NIP-19 bech32 public key
  nsec: string; // NIP-19 bech32 secret key
}

// --- WebSocket subscription state ---

export interface Subscription {
  id: string;
  filters: NostrFilter[];
  pubkey: string; // Authenticated pubkey of subscriber
}
