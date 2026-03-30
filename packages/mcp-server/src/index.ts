import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSessionTools } from "./tools/relay-session.js";
import { registerSendTool } from "./tools/relay-send.js";
import { registerApproveTool } from "./tools/relay-approve.js";
import { registerPollTool } from "./tools/relay-poll.js";
import { registerStatusTool } from "./tools/relay-status.js";
import { registerWorkspaceTool } from "./tools/relay-workspace.js";
import { registerNostrTools } from "./tools/relay-nostr.js";
import { registerNostrPoolTool } from "./tools/relay-nostr-pool.js";
import { registerSolidExportTool } from "./tools/relay-solid.js";
import { registerSecurityTool } from "./tools/relay-security.js";
import { registerTrustTool } from "./tools/relay-trust.js";
import { loadState } from "./state.js";

const server = new McpServer({
  name: "claude-relay",
  version: "0.1.0",
});

// Register all 11 tools
registerSessionTools(server);      // relay_create_session, relay_join_session
registerSendTool(server);          // relay_send
registerApproveTool(server);       // relay_approve
registerPollTool(server);          // relay_poll
registerStatusTool(server);        // relay_status
registerWorkspaceTool(server);     // relay_share_workspace
registerNostrTools(server);        // relay_nostr_connect
registerNostrPoolTool(server);     // relay_nostr_pool
registerSolidExportTool(server);   // relay_export_pod
registerSecurityTool(server);      // relay_security_status
registerTrustTool(server);         // relay_trust_status

// Load persisted session state, then connect
await loadState();

const transport = new StdioServerTransport();
await server.connect(transport);
