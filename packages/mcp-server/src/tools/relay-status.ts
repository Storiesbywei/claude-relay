import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as relayClient from "../client/relay-client.js";
import { getActiveSessions } from "../state.js";
import { getPendingCount } from "../approval/queue.js";

export function registerStatusTool(server: McpServer) {
  server.tool(
    "relay_status",
    "Show current relay state — active sessions, pending approvals, and server health.",
    {
      session_id: z
        .string()
        .uuid()
        .optional()
        .describe("Specific session to check (omit for overview)"),
    },
    async ({ session_id }) => {
      // Check server health
      let serverStatus = "unknown";
      let serverSessions = 0;
      try {
        const health = await relayClient.healthCheck();
        serverStatus = health.status;
        serverSessions = health.sessions;
      } catch {
        serverStatus = "unreachable";
      }

      const activeSessions = getActiveSessions();
      const pendingCount = getPendingCount();

      // Specific session detail
      if (session_id) {
        const local = activeSessions.find(
          (s) => s.session_id === session_id
        );
        if (!local) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Not connected to session ${session_id}.`,
              },
            ],
          };
        }

        try {
          const info = await relayClient.getSessionInfo(
            session_id,
            local.token
          );
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Session: ${info.name}`,
                  `ID: ${info.id}`,
                  `Role: ${local.role}`,
                  `Participants: ${info.participants.join(", ")}`,
                  `Messages: ${info.message_count}`,
                  `Local cursor: ${local.cursor}`,
                  `Created: ${info.created_at}`,
                  `Expires: ${info.expires_at}`,
                  `Last activity: ${info.last_activity_at}`,
                ].join("\n"),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to get session info: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Overview
      const sessionList =
        activeSessions.length === 0
          ? "  (none)"
          : activeSessions
              .map(
                (s) =>
                  `  - ${s.name} (${s.role}, cursor: ${s.cursor}) [${s.session_id.slice(0, 8)}...]`
              )
              .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Relay Server: ${serverStatus} (${serverSessions} session(s) on server)`,
              ``,
              `Active Sessions (local):`,
              sessionList,
              ``,
              `Pending Approvals: ${pendingCount}`,
            ].join("\n"),
          },
        ],
      };
    }
  );
}
