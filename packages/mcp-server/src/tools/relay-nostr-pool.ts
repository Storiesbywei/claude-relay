/**
 * MCP tool for managing the external Nostr relay pool.
 * Actions: connect, disconnect, list
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RELAY_URL_DEFAULT } from "@claude-relay/shared";
import { getActiveSessions } from "../state.js";

const RELAY_URL = process.env.RELAY_URL || RELAY_URL_DEFAULT;

/** Get a valid token from any active session for auth */
function getAnyToken(): string | null {
  const sessions = getActiveSessions();
  if (sessions.length === 0) return null;
  return sessions[0].token;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function registerNostrPoolTool(server: McpServer) {
  server.tool(
    "relay_nostr_pool",
    "Manage external Nostr relay connections. Connect to other relays to federate events, disconnect, or list current connections.",
    {
      action: z
        .enum(["connect", "disconnect", "list"])
        .describe("Action to perform"),
      url: z
        .string()
        .optional()
        .describe("Relay WebSocket URL (required for connect/disconnect). Must start with wss:// or ws://"),
      session_filter: z
        .string()
        .optional()
        .describe("Optional session filter tag for connect action"),
    },
    async ({ action, url, session_filter }) => {
      const token = getAnyToken();
      if (!token) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active session. Use relay_create_session or relay_join_session first to authenticate.",
            },
          ],
          isError: true,
        };
      }

      try {
        switch (action) {
          case "connect": {
            if (!url) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "URL is required for connect action. Must start with wss:// or ws://",
                  },
                ],
                isError: true,
              };
            }

            const res = await fetch(`${RELAY_URL}/nostr/relays`, {
              method: "POST",
              headers: authHeaders(token),
              body: JSON.stringify({ url, session_filter }),
            });
            const body = await res.json();

            if (!res.ok) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Failed to connect: ${(body as any).error || `HTTP ${res.status}`}`,
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Connected to relay: ${(body as any).url} (status: ${(body as any).status})`,
                },
              ],
            };
          }

          case "disconnect": {
            if (!url) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "URL is required for disconnect action.",
                  },
                ],
                isError: true,
              };
            }

            const encodedUrl = btoa(url);
            const res = await fetch(`${RELAY_URL}/nostr/relays/${encodedUrl}`, {
              method: "DELETE",
              headers: authHeaders(token),
            });
            const body = await res.json();

            if (!res.ok) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Failed to disconnect: ${(body as any).error || `HTTP ${res.status}`}`,
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Disconnected from relay: ${url}`,
                },
              ],
            };
          }

          case "list": {
            const res = await fetch(`${RELAY_URL}/nostr/relays`, {
              headers: authHeaders(token),
            });
            const body = await res.json();

            if (!res.ok) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Failed to list relays: ${(body as any).error || `HTTP ${res.status}`}`,
                  },
                ],
                isError: true,
              };
            }

            const relays = (body as any).relays as { url: string; status: string }[];
            if (relays.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "No external relays connected.",
                  },
                ],
              };
            }

            const lines = relays.map(
              (r) => `  - ${r.url} (${r.status})`
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `External Relay Pool (${relays.length}):\n${lines.join("\n")}`,
                },
              ],
            };
          }
        }
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Relay pool error: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
