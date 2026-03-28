import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MESSAGE_TYPES } from "@claude-relay/shared";
import { stageMessage, generatePreview } from "../approval/queue.js";
import { getActiveSession } from "../state.js";

export function registerSendTool(server: McpServer) {
  server.tool(
    "relay_send",
    "Stage a knowledge payload for user approval before sending to the relay. The payload is NOT sent immediately — it enters an approval queue. The user must approve via relay_approve to actually transmit it. Chat-visible types: architecture, api-docs, patterns, conventions, question, answer, context, insight, task. Metadata types (update UI indicators only): status_update, file_tree, file_change, file_read, terminal.",
    {
      session_id: z.string().uuid().describe("Session to send to"),
      message_type: z
        .enum(MESSAGE_TYPES)
        .describe("Chat-visible: architecture, api-docs, patterns, conventions, question, answer, context, insight, task. Metadata-only: status_update, file_tree, file_change, file_read, terminal."),
      title: z
        .string()
        .max(200)
        .describe("Short title for this knowledge unit"),
      content: z
        .string()
        .describe("The structured knowledge content (markdown)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Searchable tags"),
      references: z
        .array(
          z.object({
            file: z.string(),
            lines: z.string().optional(),
            note: z.string().optional(),
          })
        )
        .optional()
        .describe("Source file references"),
      project: z
        .string()
        .optional()
        .describe("Project name context"),
      stack: z
        .string()
        .optional()
        .describe("Tech stack context"),
      branch: z
        .string()
        .optional()
        .describe("Git branch context"),
    },
    async ({
      session_id,
      message_type,
      title,
      content,
      tags,
      references,
      project,
      stack,
      branch,
    }) => {
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

      const pending = stageMessage(session_id, {
        type: message_type,
        title,
        content,
        tags,
        references,
        context:
          project || stack || branch
            ? { project, stack, branch }
            : undefined,
      });

      const preview = generatePreview(pending);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Message staged for approval (pending_id: ${pending.id})`,
              ``,
              `--- PREVIEW ---`,
              preview,
              `--- END PREVIEW ---`,
              ``,
              `Call relay_approve with pending_id="${pending.id}" and action="approve" to send.`,
              `Call relay_approve with action="reject" to discard.`,
            ].join("\n"),
          },
        ],
      };
    }
  );
}
