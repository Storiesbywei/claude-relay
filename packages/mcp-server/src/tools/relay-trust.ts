/**
 * relay_trust_status — MCP tool for agents to check their trust level
 * and for the Capability Lattice system to manage key grants.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveSession, getActiveSessions } from "../state.js";
import * as client from "../client/relay-client.js";

export function registerTrustTool(server: McpServer) {
  server.tool(
    "relay_trust_status",
    "Check this agent's trust level and capabilities in a session. Shows whether the agent is trusted (Level 2), what capabilities it has, the current key version, and whether approval queue bypass is active.",
    {
      session_id: z.string().uuid().describe("Session to check trust status for"),
    },
    async ({ session_id }) => {
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

      const trustLevel = session.trust_level ?? 1;
      const capabilities = session.capabilities ?? [];
      const keyVersion = session.key_version ?? 1;
      const hasTrustToken = !!session.trust_token;
      const hasEncryption = !!session.encryption_secret;

      const lines: string[] = [
        `## Trust Status for Session "${session.name}"`,
        ``,
        `**Trust Level:** ${trustLevel} (${trustLevelLabel(trustLevel)})`,
        `**Key Version:** v${keyVersion}`,
        `**Encryption:** ${hasEncryption ? "Active (session key held)" : "Not available"}`,
        `**Trust Token:** ${hasTrustToken ? "Valid" : "None"}`,
      ];

      if (capabilities.length > 0) {
        lines.push(``, `**Capabilities:**`);
        for (const cap of capabilities) {
          lines.push(`  - ${capabilityLabel(cap)}`);
        }
      }

      lines.push(``);

      if (trustLevel >= 2) {
        lines.push(
          `**Approval Queue:** ${capabilities.includes("auto_approve") ? "BYPASSED (auto-approve)" : "Active (requires human approval)"}`,
          ``,
          `This agent is trusted and can read/send encrypted messages in this session.`
        );
      } else {
        lines.push(
          `**Approval Queue:** Active (all messages require human approval)`,
          ``,
          `This agent is NOT trusted in this session. A human participant must`,
          `grant trust via the dashboard to enable encrypted access.`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    }
  );
}

function trustLevelLabel(level: number): string {
  switch (level) {
    case 0: return "Relay Server (blind)";
    case 1: return "Untrusted Agent";
    case 2: return "Trusted Agent";
    case 3: return "Human Participant";
    default: return "Unknown";
  }
}

function capabilityLabel(cap: string): string {
  switch (cap) {
    case "read": return "Read — can decrypt and read encrypted messages";
    case "write": return "Write — can send encrypted messages";
    case "auto_approve": return "Auto-approve — skip approval queue (dangerouslySkipPermissions)";
    case "bridge_nostr": return "Bridge Nostr — can bridge messages to Nostr relays";
    case "bridge_solid": return "Bridge Solid — can bridge messages to Solid Pods";
    default: return cap;
  }
}
