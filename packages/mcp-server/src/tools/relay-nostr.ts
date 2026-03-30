import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reconstructKeypair } from "@claude-relay/shared";
import { getRelayWsUrl } from "../client/relay-client.js";
import { getActiveSession, setNostrClient, getNostrClient } from "../state.js";
import { NostrClient } from "../client/nostr-client.js";

export function registerNostrTools(server: McpServer): void {
  server.tool(
    "relay_nostr_connect",
    "Connect to the relay's Nostr WebSocket for real-time event streaming. Supplements HTTP polling — events arrive immediately via WebSocket.",
    {
      session_id: z.string().uuid().describe("Session to connect for"),
      relay_url: z.string().url().optional().describe("WebSocket relay URL (default: local relay)"),
      subscribe_session: z.boolean().optional().default(true).describe("Auto-subscribe to session events"),
    },
    async ({ session_id, relay_url, subscribe_session }) => {
      const session = getActiveSession(session_id);
      if (!session) {
        return {
          content: [{ type: "text" as const, text: `No active session found for ${session_id}. Create or join a session first.` }],
          isError: true,
        };
      }

      if (!session.nostr) {
        return {
          content: [{ type: "text" as const, text: "Session has no Nostr identity. Re-create the session to generate one." }],
          isError: true,
        };
      }

      // Check if already connected
      const existing = getNostrClient(session_id);
      if (existing && existing.status === "ready") {
        return {
          content: [{ type: "text" as const, text: `Already connected to Nostr relay.\nStatus: ${existing.status}\nBuffered events: ${existing.bufferedCount}` }],
        };
      }

      const wsUrl = relay_url || getRelayWsUrl();

      try {
        const keypair = reconstructKeypair(session.nostr);
        const client = new NostrClient({
          relayUrl: wsUrl,
          keypair,
          sessionId: session_id,
        });

        await client.connect();

        if (subscribe_session) {
          client.subscribeToSession(session_id);
        }

        setNostrClient(session_id, client);

        return {
          content: [{
            type: "text" as const,
            text: [
              `Connected to Nostr relay: ${wsUrl}`,
              `Status: ${client.status}`,
              `Identity: ${session.nostr.npub}`,
              subscribe_session ? `Subscribed to session events` : `Not subscribed (use relay_poll with via_nostr to subscribe)`,
            ].join("\n"),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to connect: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
