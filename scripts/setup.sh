#!/usr/bin/env bash
# setup.sh — Full setup for Claude Relay
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MCP_CONFIG="$HOME/.claude/.mcp.json"

# Allow custom relay URL (for remote/ngrok setups)
RELAY_URL="${1:-http://localhost:4190}"

echo "=== Claude Relay Setup ==="
echo "Relay URL: $RELAY_URL"
echo ""

# 1. Check Bun
if ! command -v bun &>/dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
echo "Bun: $(bun --version)"

# 2. Install dependencies
echo ""
echo "Installing dependencies..."
cd "$PROJECT_DIR"
bun install

# 3. Create state directory
mkdir -p "$HOME/.claude-relay/inbox"
echo "Created ~/.claude-relay/"

# 4. Register MCP server
echo ""
echo "Registering MCP server..."
/usr/bin/python3 << PYEOF
import json

mcp_path = "$MCP_CONFIG"
mcp_entry_point = "$PROJECT_DIR/packages/mcp-server/src/index.ts"

try:
    with open(mcp_path) as f:
        config = json.load(f)
except FileNotFoundError:
    config = {"mcpServers": {}}

servers = config.setdefault("mcpServers", {})

if "claude-relay" in servers:
    print("MCP server already registered.")
else:
    servers["claude-relay"] = {
        "command": "bun",
        "args": ["run", mcp_entry_point],
        "env": {
            "RELAY_URL": "$RELAY_URL"
        }
    }
    with open(mcp_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"Registered claude-relay MCP server in {mcp_path}")
PYEOF

# 5. Install hooks
echo ""
bash "$PROJECT_DIR/hooks/install.sh"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Relay URL configured: $RELAY_URL"
echo ""
echo "To start the relay server (host only):"
echo "  cd $PROJECT_DIR && bun run dev:server"
echo ""
echo "To expose via ngrok (for remote workers):"
echo "  ngrok http 4190"
echo ""
echo "Then in Claude Code, you'll have these tools:"
echo "  relay_create_session  — Start a new sharing session"
echo "  relay_join_session    — Join someone else's session"
echo "  relay_send            — Stage knowledge for sharing"
echo "  relay_approve         — Approve/reject pending shares"
echo "  relay_poll            — Check for incoming knowledge"
echo "  relay_status          — View active sessions"
