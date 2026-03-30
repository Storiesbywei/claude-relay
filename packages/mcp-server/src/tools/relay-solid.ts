import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RELAY_URL_DEFAULT } from "@claude-relay/shared";
import { getActiveSessions } from "../state.js";

const RELAY_URL = process.env.RELAY_URL || RELAY_URL_DEFAULT;

export function registerSolidExportTool(server: McpServer) {
  server.tool(
    "relay_export_pod",
    "Export a relay session to a Solid Pod for decentralized persistent storage. Creates session metadata and all messages as JSON-LD resources.",
    {
      session_id: z.string().uuid().describe("Session ID to export"),
      pod_url: z.string().url().describe("Solid Pod URL (e.g., https://pod.example/alice/)"),
      oidc_issuer: z.string().url().describe("OIDC issuer URL for Pod authentication"),
      client_id: z.string().describe("OAuth2 client ID"),
      client_secret: z.string().describe("OAuth2 client secret"),
      container_path: z.string().optional().describe("Container path within Pod (default: relay-sessions/)"),
    },
    async ({ session_id, pod_url, oidc_issuer, client_id, client_secret, container_path }) => {
      // Find the active session to get the token
      const sessions = getActiveSessions();
      const activeSession = sessions.find(s => s.session_id === session_id);
      if (!activeSession) {
        return {
          content: [{ type: "text" as const, text: `No active session found for ${session_id}. Create or join a session first.` }],
          isError: true,
        };
      }

      try {
        const res = await fetch(`${RELAY_URL}/solid/${session_id}/export`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${activeSession.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            pod_url,
            oidc_issuer,
            client_id,
            client_secret,
            container_path,
          }),
        });

        const body = await res.json();

        if (!res.ok) {
          return {
            content: [{ type: "text" as const, text: `Solid export failed: ${(body as any).error || `HTTP ${res.status}`}` }],
            isError: true,
          };
        }

        const result = body as any;
        return {
          content: [{
            type: "text" as const,
            text: [
              `Session exported to Solid Pod`,
              `  Container: ${result.containerUrl}`,
              `  Metadata: ${result.metadataUrl}`,
              `  Messages: ${result.messageCount}`,
              `  Exported at: ${result.exportedAt}`,
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Solid export error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
