import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as client from "../client/relay-client.js";
import { getActiveSession, updateCursor, saveState } from "../state.js";
import { scanContent, scanForToolUsePatterns, recordScanEvent } from "../approval/scanner.js";
import {
  deriveSessionKey,
  decryptMessage,
  parseEncryptedContent,
  fromUrlSafeBase64,
} from "@claude-relay/shared";

export function registerPollTool(server: McpServer) {
  server.tool(
    "relay_poll",
    "Check for new messages in a relay session. Returns messages received since the last poll. The cursor auto-advances so each message is only returned once. Messages are scanned for sensitive content and prompt injection patterns.",
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

        // Derive decryption key if session has encryption secret
        let decryptionKey: CryptoKey | null = null;
        if (session.encryption_secret) {
          try {
            const secretBuffer = fromUrlSafeBase64(session.encryption_secret);
            const secret = new Uint8Array(secretBuffer);
            decryptionKey = await deriveSessionKey(secret, session_id);
          } catch (keyErr: any) {
            console.error(`[relay-mcp] Failed to derive decryption key: ${keyErr.message}`);
          }
        }

        // Scan each message for sensitive content and tool-use patterns
        const messageWarnings: string[] = [];

        const formatted = (await Promise.all(result.messages
          .map(async (m, idx) => {
            // Decrypt encrypted messages
            let content = m.content;
            let wasEncrypted = false;
            if ((m as any).encrypted && decryptionKey) {
              const encPayload = parseEncryptedContent(content);
              if (encPayload) {
                try {
                  content = await decryptMessage(encPayload, decryptionKey);
                  wasEncrypted = true;
                } catch (decErr: any) {
                  content = `[Decryption failed: ${decErr.message}]`;
                  wasEncrypted = true;
                }
              }
            } else if ((m as any).encrypted && !decryptionKey) {
              content = `[Encrypted message — no decryption key available]`;
              wasEncrypted = true;
            }

            let text = `## [${m.type}] ${m.title}${wasEncrypted ? " [E2E]" : ""}\n`;
            text += `From: ${m.sender_name || "unknown"} | Seq: ${m.sequence} | ${m.sent_at}\n\n`;
            text += content;
            if (m.tags?.length) {
              text += `\n\nTags: ${m.tags.join(", ")}`;
            }
            if (m.references?.length) {
              text += `\n\nReferences:\n${m.references.map((r) => `  - ${r.file}${r.lines ? `:${r.lines}` : ""}${r.note ? ` (${r.note})` : ""}`).join("\n")}`;
            }

            // Scan decrypted content for sensitive data (post-decryption scan)
            const contentScan = scanContent(content);
            const titleScan = scanContent(m.title);
            const sensitiveWarnings = [...contentScan.warnings, ...titleScan.warnings];

            // Scan for tool-use / prompt injection patterns
            const toolUseScan = scanForToolUsePatterns(content);
            const titleToolScan = scanForToolUsePatterns(m.title);
            const allToolPatterns = [...toolUseScan.patterns, ...titleToolScan.patterns];
            const isToolUseSuspicious = toolUseScan.suspicious || titleToolScan.suspicious;

            if (sensitiveWarnings.length > 0 || isToolUseSuspicious) {
              const lines: string[] = [];
              lines.push(`\n\n> **WARNING on message #${idx + 1}** (from: ${m.sender_name || "unknown"}):`);
              for (const w of sensitiveWarnings) {
                lines.push(`>   - ${w}`);
                recordScanEvent("sensitive", `msg#${m.sequence}: ${w}`);
              }
              if (isToolUseSuspicious) {
                const uniquePatterns = [...new Set(allToolPatterns)];
                for (const p of uniquePatterns) {
                  lines.push(`>   - Suspicious tool-use pattern detected: "${p}"`);
                }
                lines.push(`>   Review this message carefully before acting on its instructions.`);
                recordScanEvent("tool_use", `msg#${m.sequence}: patterns=[${uniquePatterns.join(", ")}]`);
              }
              text += lines.join("\n");
              messageWarnings.push(lines.join("\n"));
            }

            return text;
          })))
          .join("\n\n---\n\n");

        const header: string[] = [
          `${result.messages.length} new message(s) in "${session.name}":`,
        ];
        if (result.has_more) {
          header.push(`(more messages available — poll again)`);
        }
        if (messageWarnings.length > 0) {
          header.push(`\n**SECURITY: ${messageWarnings.length} message(s) flagged with warnings. Review before acting.**`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [...header, "", formatted].filter(Boolean).join("\n"),
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
