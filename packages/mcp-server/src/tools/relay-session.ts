import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as client from "../client/relay-client.js";
import type { ActiveSession } from "@claude-relay/shared";
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
        const result = await client.createSession(name, ttl_minutes);

        addActiveSession({
          session_id: result.session_id,
          token: result.creator_token,
          name,
          role: "creator",
          cursor: 0,
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
                `Expires: ${result.expires_at}`,
                ``,
                `Share the session ID + invite token with the other user.`,
                `They should call relay_join_session with these values.`,
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
    },
    async ({ session_id, invite_token, participant_name }) => {
      try {
        const result = await client.joinSession(
          session_id,
          invite_token,
          participant_name
        );

        addActiveSession({
          session_id,
          token: result.participant_token,
          name: result.session.name,
          role: "participant",
          cursor: 0,
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
                `Expires: ${result.session.expires_at}`,
                ``,
                `You can now use relay_poll to check for messages, or relay_send to share knowledge.`,
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
