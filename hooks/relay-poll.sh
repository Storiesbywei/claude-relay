#!/usr/bin/env bash
# relay-poll.sh — Auto-poll relay server on Claude Code Stop events
# Writes incoming messages to ~/.claude-relay/inbox/ for discovery
# Non-blocking: exits silently if server is down or no active sessions
set -euo pipefail

RELAY_DIR="$HOME/.claude-relay"
ACTIVE_FILE="$RELAY_DIR/active-sessions.json"
INBOX_DIR="$RELAY_DIR/inbox"

# Graceful exit if no active sessions file
[[ -f "$ACTIVE_FILE" ]] || exit 0

mkdir -p "$INBOX_DIR"

/usr/bin/python3 << 'PYEOF'
import json, urllib.request, os, sys

relay_dir = os.path.expanduser("~/.claude-relay")
active_file = os.path.join(relay_dir, "active-sessions.json")
inbox_dir = os.path.join(relay_dir, "inbox")

try:
    with open(active_file) as f:
        sessions = json.load(f)
except Exception:
    sys.exit(0)

if not isinstance(sessions, list) or len(sessions) == 0:
    sys.exit(0)

changed = False
for s in sessions:
    try:
        sid = s["session_id"]
        token = s["token"]
        cursor = s.get("cursor", 0)
        url = f"http://localhost:4190/relay/{sid}?since={cursor}&limit=10"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read())
            if data.get("messages"):
                inbox_path = os.path.join(inbox_dir, f"{sid}.json")
                existing = []
                if os.path.exists(inbox_path):
                    try:
                        with open(inbox_path) as ef:
                            existing = json.load(ef)
                    except Exception:
                        existing = []
                existing.extend(data["messages"])
                with open(inbox_path, "w") as of:
                    json.dump(existing, of, indent=2)
                new_cursor = data.get("cursor", cursor)
                if new_cursor > cursor:
                    s["cursor"] = new_cursor
                    changed = True
    except Exception:
        pass

if changed:
    try:
        with open(active_file, "w") as f:
            json.dump(sessions, f, indent=2)
    except Exception:
        pass
PYEOF

exit 0
