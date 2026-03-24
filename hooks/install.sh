#!/usr/bin/env bash
# install.sh — Add relay-poll hook to ~/.claude/settings.json
set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD="$(cd "$(dirname "$0")" && pwd)/relay-poll.sh"

# Make hook executable
chmod +x "$HOOK_CMD"

if [[ ! -f "$SETTINGS" ]]; then
  echo "Error: $SETTINGS not found"
  exit 1
fi

/usr/bin/python3 << PYEOF
import json, sys

settings_path = "$SETTINGS"
hook_cmd = "$HOOK_CMD"

with open(settings_path) as f:
    settings = json.load(f)

hooks = settings.setdefault("hooks", {})
stop_hooks = hooks.setdefault("Stop", [])

# Check if already installed
for entry in stop_hooks:
    for h in entry.get("hooks", []):
        if "relay-poll.sh" in h.get("command", ""):
            print("relay-poll hook already installed.")
            sys.exit(0)

# Add the hook
stop_hooks.append({
    "hooks": [{
        "type": "command",
        "command": hook_cmd,
        "timeout": 5
    }]
})

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)

print(f"Installed relay-poll hook: {hook_cmd}")
PYEOF
