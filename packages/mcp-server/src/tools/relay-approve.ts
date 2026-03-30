import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getPending,
  removePending,
  listPending,
  generatePreview,
} from "../approval/queue.js";
import { getActiveSession, getActiveSessions } from "../state.js";
import * as client from "../client/relay-client.js";
import {
  deriveSessionKey,
  encryptMessage,
  fromUrlSafeBase64,
} from "@claude-relay/shared";

export function registerApproveTool(server: McpServer) {
  server.tool(
    "relay_approve",
    "Review and approve/reject a pending knowledge payload. Use action='list' to see all pending items, 'approve' to send, or 'reject' to discard.",
    {
      pending_id: z
        .string()
        .optional()
        .describe("ID from relay_send (required for approve/reject)"),
      action: z
        .enum(["approve", "reject", "list"])
        .describe(
          "approve=send it, reject=discard, list=show all pending"
        ),
    },
    async ({ pending_id, action }) => {
      // List pending — scoped to this MCP client's active sessions only
      // to prevent cross-session information leakage
      if (action === "list") {
        const activeSessionIds = getActiveSessions().map((s) => s.session_id);
        const pending = activeSessionIds.length > 0
          ? activeSessionIds.flatMap((sid) => listPending(sid))
          : [];
        if (pending.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No pending messages in the approval queue.",
              },
            ],
          };
        }

        const summaries = pending.map((p) => generatePreview(p));
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${pending.length} pending message(s):`,
                "",
                ...summaries.map(
                  (s, i) =>
                    `--- #${i + 1} (${pending[i].id}) ---\n${s}`
                ),
              ].join("\n"),
            },
          ],
        };
      }

      // Approve or reject require pending_id
      if (!pending_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "pending_id is required for approve/reject actions.",
            },
          ],
          isError: true,
        };
      }

      const pending = getPending(pending_id);
      if (!pending) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No pending message found with id "${pending_id}". It may have already been approved or rejected.`,
            },
          ],
          isError: true,
        };
      }

      // Reject
      if (action === "reject") {
        removePending(pending_id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Rejected and discarded: "${pending.payload.title}"`,
            },
          ],
        };
      }

      // Approve — actually send to relay
      const session = getActiveSession(pending.sessionId);
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${pending.sessionId} is no longer active.`,
            },
          ],
          isError: true,
        };
      }

      try {
        // If session has an encryption secret, encrypt the content before sending
        let payloadToSend = { ...pending.payload, origin: 'mcp' as const };
        let encrypted = false;

        if (session.encryption_secret) {
          try {
            const secretBuffer = fromUrlSafeBase64(session.encryption_secret);
            const secret = new Uint8Array(secretBuffer);
            const key = await deriveSessionKey(secret, pending.sessionId);
            const encPayload = await encryptMessage(payloadToSend.content, key);
            payloadToSend = {
              ...payloadToSend,
              content: JSON.stringify(encPayload),
              encrypted: true,
            };
            encrypted = true;
          } catch (encErr: any) {
            // Encryption failed — fall back to plaintext with warning
            console.error(`[relay-mcp] Encryption failed, sending plaintext: ${encErr.message}`);
          }
        }

        const result = await client.sendMessage(
          pending.sessionId,
          session.token,
          payloadToSend
        );

        removePending(pending_id);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Approved and sent!`,
                ``,
                `Message ID: ${result.message_id}`,
                `Sequence: ${result.sequence}`,
                `Title: "${pending.payload.title}"`,
                encrypted ? `Encryption: E2E encrypted` : `Encryption: plaintext`,
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to send approved message: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
