import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as client from "../client/relay-client.js";
import type { ActiveSession } from "@claude-relay/shared";
import { generateKeypair, generateSecret, toUrlSafeBase64 } from "@claude-relay/shared";
import {
  getActiveSessions,
  addActiveSession,
  saveState,
} from "../state.js";

export function registerSessionTools(server: McpServer) {
  server.tool(
    "relay_create_session",
    "Create a new relay session for sharing knowledge with another Claude Code instance. Returns a session_id and invite_token to share with the other user.",
    {
      name: z
        .string()
        .describe(
          "Human-readable session name, e.g. 'voxlight-arch-sync'"
        ),
      ttl_minutes: z
        .number()
        .optional()
        .default(60)
        .describe("Session lifetime in minutes (max 1440)"),
    },
    async ({ name, ttl_minutes }) => {
      try {
        const kp = generateKeypair();
        const result = await client.createSession(name, ttl_minutes, kp.publicKey);

        // Generate E2E encryption secret for this session
        const secret = generateSecret();
        const secretB64 = toUrlSafeBase64(secret.buffer);

        addActiveSession({
          session_id: result.session_id,
          token: result.creator_token,
          name,
          role: "creator",
          cursor: 0,
          nostr: {
            pubkey: kp.publicKey,
            npub: kp.npub,
            nsec: kp.nsec,
          },
          encryption_secret: secretB64,
        });
        await saveState();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Session created successfully!`,
                ``,
                `Session ID: ${result.session_id}`,
                `Invite Token: ${result.invite_token}`,
                `Encryption Secret: ${secretB64}`,
                `Nostr Identity: ${kp.npub}`,
                `Expires: ${result.expires_at}`,
                ``,
                `Share the session ID + invite token + encryption secret with the other user.`,
                `They should call relay_join_session with these values.`,
                `The encryption secret enables E2E encryption — the server cannot read messages.`,
                ``,
                `Dashboard URL: ${client.getRelayHost()}?sid=${result.session_id}&token=${result.creator_token}&name=${encodeURIComponent(name)}#key=${secretB64}`,
                ``,
                `Nostr WebSocket: ws://${client.getRelayHost()}`,
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create session: ${err.message}\n\nIs the relay server running? Start it with: bun run dev:server`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "relay_join_session",
    "Join an existing relay session using an invite token from another user. Call this before polling or sending messages.",
    {
      session_id: z.string().uuid().describe("Session ID to join"),
      invite_token: z
        .string()
        .describe("Invite token from session creator"),
      participant_name: z
        .string()
        .optional()
        .describe("Your name in this session"),
      encryption_secret: z
        .string()
        .optional()
        .describe("E2E encryption secret from session creator (URL-safe base64). Enables encrypted messaging."),
    },
    async ({ session_id, invite_token, participant_name, encryption_secret }) => {
      try {
        const kp = generateKeypair();
        const result = await client.joinSession(
          session_id,
          invite_token,
          participant_name,
          kp.publicKey
        );

        addActiveSession({
          session_id,
          token: result.participant_token,
          name: result.session.name,
          role: "participant",
          cursor: 0,
          nostr: {
            pubkey: kp.publicKey,
            npub: kp.npub,
            nsec: kp.nsec,
          },
          ...(encryption_secret ? { encryption_secret } : {}),
        });
        await saveState();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Joined session "${result.session.name}" successfully!`,
                ``,
                `Participants: ${result.session.participants.join(", ")}`,
                `Messages so far: ${result.session.message_count}`,
                `E2E Encryption: ${encryption_secret ? "enabled" : "disabled (no secret provided)"}`,
                `Nostr Identity: ${kp.npub}`,
                `Expires: ${result.session.expires_at}`,
                ``,
                `You can now use relay_poll to check for messages, or relay_send to share knowledge.`,
                `Nostr WebSocket: ws://${client.getRelayHost()}`,
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to join session: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
