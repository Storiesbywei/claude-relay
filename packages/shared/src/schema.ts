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
});

// Full message as stored/returned by the relay server
export const RelayMessageSchema = RelayMessagePayloadSchema.extend({
  message_id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sender_name: z.string().optional(),
  sent_at: z.string().datetime(),
});

// --- Session Types ---

export const CreateSessionRequestSchema = z.object({
  name: z.string().min(1).max(100).describe("Human-readable session name"),
  ttl_minutes: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.MAX_TTL_MINUTES)
    .default(LIMITS.DEFAULT_TTL_MINUTES)
    .optional(),
});

export const JoinSessionRequestSchema = z.object({
  participant_name: z.string().max(100).optional(),
});

// --- Inferred Types ---

export type MessageType = z.infer<typeof MessageTypeSchema>;
export type FileReference = z.infer<typeof FileReferenceSchema>;
export type MessageContext = z.infer<typeof MessageContextSchema>;
export type RelayMessagePayload = z.infer<typeof RelayMessagePayloadSchema>;
export type RelayMessage = z.infer<typeof RelayMessageSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type JoinSessionRequest = z.infer<typeof JoinSessionRequestSchema>;
