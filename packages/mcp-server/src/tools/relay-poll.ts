import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as client from "../client/relay-client.js";
import { getActiveSession, updateCursor, saveState } from "../state.js";

export function registerPollTool(server: McpServer) {
  server.tool(
    "relay_poll",
    "Check for new messages in a relay session. Returns messages received since the last poll. The cursor auto-advances so each message is only returned once.",
    {
      session_id: z.string().uuid().describe("Session to poll"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max messages to return"),
    },
    async ({ session_id, limit }) => {
      const session = getActiveSession(session_id);
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Not connected to session ${session_id}. Use relay_create_session or relay_join_session first.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await client.pollMessages(
          session_id,
          session.token,
          session.cursor,
          limit
        );

        // Advance cursor
        if (result.cursor > session.cursor) {
          updateCursor(session_id, result.cursor);
          await saveState();
        }

        if (result.messages.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No new messages in session "${session.name}".`,
              },
            ],
          };
        }

        const formatted = result.messages
          .map((m) => {
            let text = `## [${m.type}] ${m.title}\n`;
            text += `From: ${m.sender_name || "unknown"} | Seq: ${m.sequence} | ${m.sent_at}\n\n`;
            text += m.content;
            if (m.tags?.length) {
              text += `\n\nTags: ${m.tags.join(", ")}`;
            }
            if (m.references?.length) {
              text += `\n\nReferences:\n${m.references.map((r) => `  - ${r.file}${r.lines ? `:${r.lines}` : ""}${r.note ? ` (${r.note})` : ""}`).join("\n")}`;
            }
            return text;
          })
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${result.messages.length} new message(s) in "${session.name}":`,
                result.has_more ? `(more messages available — poll again)` : "",
                "",
                formatted,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to poll: ${err.message}\n\nIs the relay server running?`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
