import { z } from "zod";
import { LIMITS, MESSAGE_TYPES } from "./constants.js";

// --- Message Types ---

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);

export const FileReferenceSchema = z.object({
  file: z.string().describe("Relative file path"),
  lines: z.string().optional().describe("Line range, e.g. '42-67'"),
  note: z.string().optional().describe("Why this file is relevant"),
});

export const MessageContextSchema = z.object({
  project: z.string().optional().describe("Project name"),
  stack: z.string().optional().describe("Tech stack summary"),
  branch: z.string().optional().describe("Git branch"),
});

// Payload sent by a user (before server adds metadata)
export const RelayMessagePayloadSchema = z.object({
  type: MessageTypeSchema,
  title: z.string().max(LIMITS.MAX_TITLE_LENGTH).optional().describe("Short descriptive title"),
  content: z
    .string()
    .max(LIMITS.MAX_MESSAGE_SIZE)
    .describe("Structured knowledge in markdown"),
  tags: z
    .array(z.string().max(LIMITS.MAX_TAG_LENGTH))
    .max(LIMITS.MAX_TAGS)
    .optional()
    .describe("Searchable tags"),
  references: z
    .array(FileReferenceSchema)
    .max(LIMITS.MAX_REFERENCES)
    .optional()
    .describe("Source file references (relative paths only)"),
  context: MessageContextSchema.optional(),
  encrypted: z
    .boolean()
    .optional()
    .describe("True if content is E2E encrypted (Scan-then-Seal). Server skips content scanning for encrypted payloads."),
  origin: z
    .enum(["http", "mcp", "nostr", "solid"])
    .optional()
    .describe("Protocol origin: how this message entered the relay"),
});

// Full message as stored/returned by the relay server
export const RelayMessageSchema = RelayMessagePayloadSchema.extend({
  message_id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sender_name: z.string().optional(),
  sent_at: z.string().datetime(),
  encrypted: z.boolean().optional(),
});

// --- Session Types ---

// Hex-encoded Nostr public key (64 characters)
export const NostrPubkeySchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Must be a 64-character lowercase hex string")
  .optional()
  .describe("Nostr public key (hex) to bind to this session");

export const DisappearingConfigSchema = z.object({
  enabled: z.boolean(),
  ttl_seconds: z.number().int().min(5).max(86400)
    .describe("Time-to-live in seconds: 30, 60, 300, 3600, 86400"),
}).optional().describe("Disappearing messages config (signal mode only)");

export const CreateSessionRequestSchema = z.object({
  name: z.string().min(1).max(100).describe("Human-readable session name"),
  ttl_minutes: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.MAX_TTL_MINUTES)
    .default(LIMITS.DEFAULT_TTL_MINUTES)
    .optional(),
  nostr_pubkey: NostrPubkeySchema,
  mode: z.enum(['relay', 'signal']).optional().default('relay')
    .describe("Session mode: 'relay' for agent collaboration, 'signal' for encrypted human messenger"),
  disappearing: DisappearingConfigSchema,
});

export const JoinSessionRequestSchema = z.object({
  participant_name: z.string().max(100).optional(),
  nostr_pubkey: NostrPubkeySchema,
});

// --- Inferred Types ---

export type MessageType = z.infer<typeof MessageTypeSchema>;
export type FileReference = z.infer<typeof FileReferenceSchema>;
export type MessageContext = z.infer<typeof MessageContextSchema>;
export type RelayMessagePayload = z.infer<typeof RelayMessagePayloadSchema>;
export type StoredRelayMessage = z.infer<typeof RelayMessageSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type JoinSessionRequest = z.infer<typeof JoinSessionRequestSchema>;
