// Nostr event kinds for Claude Relay messages
// Base: 4190 (our default port) — custom application range (1000-9999)

export const NOSTR_EVENT_KINDS = {
  // Core message types
  architecture: 4190,
  "api-docs": 4191,
  patterns: 4192,
  conventions: 4193,
  question: 4194,
  answer: 4195,
  context: 4196,
  insight: 4197,
  task: 4198,
  // Workspace message types
  file_tree: 4200,
  file_change: 4201,
  file_read: 4202,
  terminal: 4203,
  status_update: 4204,
} as const;

// Reverse lookup: kind number → message type string
export const KIND_TO_MESSAGE_TYPE = Object.fromEntries(
  Object.entries(NOSTR_EVENT_KINDS).map(([type, kind]) => [kind, type])
) as Record<number, string>;

// All relay event kinds for subscription filters
export const ALL_RELAY_KINDS = Object.values(NOSTR_EVENT_KINDS);

// Session-level event kinds
export const SESSION_KIND = 30078; // Addressable: application-specific data (NIP-78)
export const METADATA_KIND = 0; // Replaceable: user/session metadata (NIP-01)
export const AUTH_KIND = 22242; // Ephemeral: NIP-42 authentication

// Supported NIPs advertised in NIP-11 relay info
export const SUPPORTED_NIPS = [1, 11, 42, 70] as const;

// NIP-11 relay information document
export const RELAY_INFO = {
  name: "Claude Relay",
  description: "Inter-Claude knowledge relay — shared workspace for AI collaboration",
  supported_nips: [...SUPPORTED_NIPS],
  software: "claude-relay",
  version: "0.2.0",
  limitation: {
    max_message_length: 102_400,
    max_subscriptions: 20,
    max_filters: 10,
    max_event_tags: 100,
    auth_required: true,
    payment_required: false,
  },
} as const;
