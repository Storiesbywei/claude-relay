import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getScannerStats } from "../approval/scanner.js";
import { getPendingCount, listPending } from "../approval/queue.js";
import * as relayClient from "../client/relay-client.js";
import { getActiveSessions } from "../state.js";

export function registerSecurityTool(server: McpServer) {
  server.tool(
    "relay_security_status",
    "Show security posture — scanner stats, recent scan events, approval queue depth, and server health. Use this to audit relay safety before trusting polled messages.",
    {
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe("Show full detail including recent scan events"),
    },
    async ({ verbose }) => {
      const stats = getScannerStats();
      const pendingCount = getPendingCount();
      const pending = listPending();
      const sessions = getActiveSessions();

      // Server health
      let serverStatus = "unknown";
      let serverSessions = 0;
      try {
        const health = await relayClient.healthCheck();
        serverStatus = health.status;
        serverSessions = health.sessions;
      } catch {
        serverStatus = "unreachable";
      }

      // Count high-risk pending messages
      const highRiskPending = pending.filter((p) =>
        p.warnings.some((w) => w.startsWith("[HIGH RISK]"))
      );

      const lines: string[] = [
        `# Relay Security Status`,
        ``,
        `## Scanner Statistics`,
        `  Total messages scanned: ${stats.totalScanned}`,
        `  Sensitive content flagged: ${stats.sensitiveBlocked}`,
        `  Tool-use patterns detected: ${stats.toolUseDetected}`,
        ``,
        `## Approval Queue`,
        `  Pending messages: ${pendingCount}`,
        `  High-risk (tool-use flagged): ${highRiskPending.length}`,
      ];

      if (highRiskPending.length > 0) {
        lines.push(`  High-risk details:`);
        for (const p of highRiskPending) {
          const riskWarning = p.warnings.find((w) => w.startsWith("[HIGH RISK]"));
          lines.push(`    - [${p.id.slice(0, 8)}...] "${p.payload.title}": ${riskWarning}`);
        }
      }

      lines.push(
        ``,
        `## Server Health`,
        `  Status: ${serverStatus}`,
        `  Active server sessions: ${serverSessions}`,
        `  Local tracked sessions: ${sessions.length}`,
      );

      // Rate limit — display configured limit
      lines.push(
        ``,
        `## Rate Limiting`,
        `  Configured: 600 req/min per token (server-side enforcement)`,
      );

      // Recent scan events
      if (verbose && stats.recentEvents.length > 0) {
        lines.push(``, `## Recent Scan Events (last ${stats.recentEvents.length})`);
        for (const event of stats.recentEvents) {
          const icon = event.type === "tool_use" ? "TOOL-USE" : "SENSITIVE";
          lines.push(`  [${event.timestamp}] ${icon}: ${event.summary}`);
        }
      } else if (stats.recentEvents.length > 0) {
        lines.push(
          ``,
          `## Recent Scan Events`,
          `  ${stats.recentEvents.length} event(s) recorded. Use verbose=true for details.`,
        );
      } else {
        lines.push(
          ``,
          `## Recent Scan Events`,
          `  No scan events recorded yet.`,
        );
      }

      // Security posture summary
      const issues: string[] = [];
      if (serverStatus === "unreachable") issues.push("Server unreachable");
      if (highRiskPending.length > 0) issues.push(`${highRiskPending.length} high-risk message(s) in queue`);
      if (stats.toolUseDetected > 0) issues.push(`${stats.toolUseDetected} tool-use pattern(s) detected historically`);

      lines.push(
        ``,
        `## Posture`,
        issues.length === 0
          ? `  All clear — no active security concerns.`
          : `  ${issues.length} concern(s):\n${issues.map((i) => `    - ${i}`).join("\n")}`,
      );

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
