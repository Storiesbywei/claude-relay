import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MESSAGE_TYPES,
  deriveSessionKey,
  encryptMessage,
  fromUrlSafeBase64,
} from "@claude-relay/shared";
import { stageMessage, generatePreview } from "../approval/queue.js";
import { hasAutoApprove } from "./relay-approve.js";
import { scanContent, scanForToolUsePatterns, recordScanEvent } from "../approval/scanner.js";
import { getActiveSession } from "../state.js";
import * as client from "../client/relay-client.js";

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

      const payload = {
        type: message_type,
        title,
        content,
        tags,
        references,
        context:
          project || stack || branch
            ? { project, stack, branch }
            : undefined,
      };

      // ─── Auto-approve bypass for trusted agents ──────────────
      // If this agent has the auto_approve capability (Level 2 trusted),
      // skip the approval QUEUE but NOT the content scanner.
      // The scanner still runs to protect against adversarial payloads
      // (prompt injection, steganography, exfiltration) — the diplomatic
      // pouch problem: encrypting for surveillance protection must NOT
      // disable injection protection. "Auto-approve" means no human
      // review needed, NOT no safety inspection.
      if (hasAutoApprove(session_id)) {
        // ── Client-side scan BEFORE send (even for trusted agents) ──
        const contentScan = scanContent(content);
        const titleScan = scanContent(title);
        const toolUseScan = scanForToolUsePatterns(content);
        const allWarnings = [...contentScan.warnings, ...titleScan.warnings];
        const isSuspicious = toolUseScan.suspicious;

        if (allWarnings.length > 0 || isSuspicious) {
          recordScanEvent("mcp-trusted", "blocked", allWarnings.join("; "));
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Auto-approve BLOCKED by content scanner (trusted agent bypass does not skip safety inspection).`,
                  ``,
                  `Warnings:`,
                  ...allWarnings.map(w => `  - ${w}`),
                  ...(isSuspicious ? [`  - Suspicious tool-use patterns: ${toolUseScan.patterns.join(", ")}`] : []),
                  ``,
                  `The message was not sent. Review the content and retry.`,
                ].join("\n"),
              },
            ],
            isError: true,
          };
        }

        try {
          let payloadToSend = { ...payload, origin: 'mcp' as const };
          let encrypted = false;

          if (session.encryption_secret) {
            try {
              const secretBuffer = fromUrlSafeBase64(session.encryption_secret);
              const secret = new Uint8Array(secretBuffer);
              const key = await deriveSessionKey(secret, session_id);
              const encPayload = await encryptMessage(payloadToSend.content, key);
              payloadToSend = {
                ...payloadToSend,
                content: JSON.stringify(encPayload),
                encrypted: true,
              } as any;
              encrypted = true;
            } catch (encErr: any) {
              console.error(`[relay-mcp] Auto-approve encryption failed: ${encErr.message}`);
            }
          }

          // Include trust token in the request headers
          const extraHeaders: Record<string, string> = {};
          if (session.trust_token) {
            extraHeaders["X-Trust-Token"] = session.trust_token;
          }

          const result = await client.sendMessage(
            session_id,
            session.token,
            payloadToSend,
            extraHeaders
          );

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Auto-approved and sent (trusted agent bypass).`,
                  ``,
                  `Message ID: ${result.message_id}`,
                  `Sequence: ${result.sequence}`,
                  `Title: "${title}"`,
                  encrypted ? `Encryption: E2E encrypted` : `Encryption: plaintext`,
                  `Trust: Level 2 (auto_approve)`,
                ].join("\n"),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Auto-approve send failed: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      }

      // ─── Normal path: stage for approval ──────────────────────
      const pending = stageMessage(session_id, payload);
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
