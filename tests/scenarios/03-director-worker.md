# Scenario 03: Director/Worker Pattern

**Pattern:** Human architect (director) sends high-level instructions through the dashboard; Claude Code (worker) executes, reports progress, and sends results back through the relay.

**Precondition:** Relay server running on `http://localhost:4190` (via `bun run dev:server` or `docker compose up -d`).

---

## Technical Analysis

### What This Scenario Tests

The director/worker pattern is the primary use case for claude-relay: a human on the $20 plan
directs a Claude Code session on the $200 plan, using the relay as the communication channel.
The director operates through the browser dashboard (port 4190), while the worker connects
via MCP tools registered in Claude Code. This scenario validates:

- Session lifecycle from creation through a full work cycle to completion
- Bidirectional message flow between dashboard (HTTP POST) and worker (MCP/HTTP)
- Worker state transitions visible to the director in real time
- File content and diff reporting through workspace message types
- Multi-step instruction chaining without session interruption
- SSE streaming so the director sees worker output the moment it arrives

### Dashboard as Director Interface

The dashboard runs in "Director mode" by default. The mapping between workflow intent and
message types:

| Director Intent | Message Type | UI Rendering |
|----------------|-------------|-------------|
| Give instructions | `context` | Rendered as a directive card in the message feed |
| Ask a question | `question` | Highlighted with question styling |
| Approve/reject work | `answer` | Confirmation card sent back to the worker |
| Provide architecture context | `architecture` | Structured code block display |
| Share conventions | `conventions` | Reference-style display |

| Worker Intent | Message Type | UI Rendering |
|--------------|-------------|-------------|
| Report progress | `status_update` | Status badge in the worker panel |
| Show current code | `file_read` | Syntax-highlighted file viewer |
| Send a diff/fix | `file_change` | Diff view in the file sidebar |
| Share project structure | `file_tree` | Populates the sidebar tree |
| Report findings | `insight` | Highlighted insight card |
| Answer a question | `answer` | Response card |
| Share terminal output | `terminal` | Monospace terminal block |

### Worker Lifecycle

```
[Director creates session]
        |
        v
    JOIN --> IDLE
              |
    [Director sends instruction]
              |
              v
          WORKING (status_update: "reading codebase")
              |
              v
          WORKING (file_read: shares current code)
              |
              v
          WORKING (insight: "found the issue")
              |
              v
         REPORTING (file_change: the fix)
              |
              v
    [Director sends answer: approved/rejected]
              |
              v
            IDLE (status_update: "idle")
              |
    [Director sends next instruction, or session expires]
```

The worker does not have a formal state machine on the server. State is communicated
conventionally through `status_update` messages with content like `"reading"`, `"writing"`,
`"testing"`, or `"idle"`. The dashboard renders these in the worker status panel
(`#worker-status`), giving the director visibility into what the worker is doing.

### Status Update Flow

When the worker sends a `status_update` message, it flows:

1. Worker's Claude Code calls `relay_send` (MCP) or `POST /relay/:id` (HTTP)
2. If via MCP: message enters the approval queue, worker must call `relay_approve`
3. If via HTTP: message goes directly to the in-memory store
4. Server assigns a sequence number and pushes to SSE subscribers
5. Dashboard receives the SSE event and updates the worker status badge
6. Director sees the live status without polling

In practice, the dashboard uses SSE (`GET /relay/:id/stream`) for real-time updates. The
SSE connection sends a heartbeat ping every 15 seconds to keep the connection alive. Each
message event includes the sequence number as the SSE `id` field, enabling cursor-based
reconnection.

### File Change Reporting

The worker reports code changes using two complementary message types:

- **`file_read`** -- shares the current state of a file, typically sent before modification
  to establish context. The `references` field carries the file path and line range.
- **`file_change`** -- sends the diff or the modified code. Content is markdown with
  fenced code blocks. References point to the affected files.

These messages populate the dashboard's file sidebar (the tree view on the left) and the
file viewer panel, giving the director a code-review-like experience without leaving the
browser.

### Instruction Chaining

The director can send multiple instructions sequentially without creating new sessions.
Each instruction is a `POST /relay/:id` with type `context` or `task`. The worker polls
or receives via SSE, executes, reports results, and returns to idle. The conversation
history is preserved in the session's message array (up to 200 messages), and the director
can scroll back through the full exchange.

Key constraint: the session TTL (default 60 minutes, max 24 hours) bounds the total work
window. The `lastActivityAt` timestamp updates on every message, but the `expiresAt` is
fixed at creation time. For long refactoring sessions, the director should set
`ttl_minutes: 1440` at session creation.

### Real-Time Feedback via SSE and Polling

Two mechanisms exist for the worker to receive director messages:

1. **SSE** (`GET /relay/:id/stream`) -- persistent connection, sub-second latency.
   The dashboard always uses this. A worker Claude Code session can also use it via the
   `relay-poll.sh` hook, which runs on Claude Code Stop events.

2. **Polling** (`GET /relay/:id?since=<cursor>&limit=<n>`) -- stateless HTTP. The
   `since` parameter is a sequence number; the response includes a `cursor` for the
   next call and a `has_more` boolean. Default limit is 10, max 50.

The dashboard opens an SSE stream immediately after creating or joining a session. The
worker (via MCP) typically uses polling through `relay_poll`, which advances an internal
cursor stored in `~/.claude-relay/active-sessions.json`.

### The Approval Queue

The approval queue is an **MCP-layer concern only**. It does not exist in the HTTP server.

- When a worker calls `relay_send` (MCP tool), the message enters `pendingQueue` in the
  MCP server process. It is **not** sent to the relay server yet.
- The sensitive content scanner (`SENSITIVE_PATTERNS` in constants.ts) runs against the
  content, title, and tags. It flags: API keys (OpenAI, GitHub, AWS, Slack), password/secret
  assignments, absolute filesystem paths (`/Users/...`, `/home/...`, `C:\`), and large
  base64 blobs (>1KB).
- If any pattern matches, the `warnings` array is populated and shown to the user.
- The user must call `relay_approve` with `action="approve"` to transmit, or
  `action="reject"` to discard.
- Even clean messages (no warnings) require explicit approval -- the queue is mandatory
  for all MCP-initiated sends.
- Direct HTTP `POST /relay/:id` (as used by the dashboard and curl) bypasses the approval
  queue entirely. The dashboard is trusted because the director is the human in the loop.

When the director sends messages through the dashboard, they hit `POST /relay/:id` directly
with the creator token. No approval queue is involved. The queue only gates outbound
messages from Claude Code sessions using the MCP transport.

---

## Test Cases

All commands use bash variables for token/session reuse. Run these sequentially against
a running relay server at `http://localhost:4190`.

### Setup: Verify Server Health

```bash
curl -s http://localhost:4190/health | jq .
# Expected: { "status": "ok", "version": "...", "sessions": N }
```

### Test 1: Director Creates Session

```bash
# Director creates a 2-hour session for an auth refactor project
RESPONSE=$(curl -s -X POST http://localhost:4190/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Auth Module Refactor",
    "ttl_minutes": 120
  }')

echo "$RESPONSE" | jq .

# Extract tokens for subsequent calls
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
DIRECTOR_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')

echo "Session:  $SESSION_ID"
echo "Director: $DIRECTOR_TOKEN"
echo "Invite:   $INVITE_TOKEN"

# Expected: 201 response with session_id, creator_token, invite_token, expires_at
```

### Test 2: Worker Joins Session

```bash
# Worker joins using the invite token and identifies itself
WORKER_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{
    "participant_name": "claude-worker-1"
  }')

echo "$WORKER_RESPONSE" | jq .

WORKER_TOKEN=$(echo "$WORKER_RESPONSE" | jq -r '.participant_token')
echo "Worker token: $WORKER_TOKEN"

# Verify session now shows both participants
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq '.participants'

# Expected: participant_token returned, participants = ["creator", "claude-worker-1"]
```

### Test 3: Director Sends High-Level Instruction

```bash
# Director sends the refactoring instruction through the relay
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -d '{
    "type": "context",
    "title": "Refactor auth module to use JWT",
    "content": "## Instruction\n\nRefactor the authentication module in `src/auth/` from session-based to JWT.\n\n### Requirements\n1. Replace express-session with jsonwebtoken\n2. Add refresh token rotation\n3. Keep backward compat with existing `/api/login` and `/api/logout` routes\n4. Add token expiry (15min access, 7d refresh)\n\n### Constraints\n- Do not change the database schema\n- Maintain all existing tests\n- Report back before making changes",
    "tags": ["refactor", "auth", "jwt"],
    "context": {
      "project": "my-saas-app",
      "stack": "Node.js, Express, PostgreSQL",
      "branch": "feat/jwt-auth"
    }
  }' | jq .

# Expected: 201 with message_id, sequence: 1, sender_name: "creator"
```

### Test 4: Worker Sends Status Update -- Reading Codebase

```bash
# Worker acknowledges and reports it is reading the codebase
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d '{
    "type": "status_update",
    "title": "Reading codebase",
    "content": "Acknowledged. Reading `src/auth/` directory to understand the current session-based implementation.\n\nFiles to examine:\n- `src/auth/middleware.ts`\n- `src/auth/routes.ts`\n- `src/auth/session-store.ts`\n- `src/auth/types.ts`",
    "tags": ["status", "reading"],
    "context": {
      "project": "my-saas-app",
      "branch": "feat/jwt-auth"
    }
  }' | jq .

# Expected: 201 with sequence: 2, sender_name: "claude-worker-1"
```

### Test 5: Worker Sends file_read -- Current Auth Code

```bash
# Worker shares the current auth middleware for the director to review
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d '{
    "type": "file_read",
    "title": "Current auth middleware",
    "content": "```typescript\n// src/auth/middleware.ts\nimport { Request, Response, NextFunction } from \"express\";\nimport session from \"express-session\";\n\nexport function requireAuth(req: Request, res: Response, next: NextFunction) {\n  if (!req.session?.userId) {\n    return res.status(401).json({ error: \"Not authenticated\" });\n  }\n  next();\n}\n\nexport function requireRole(role: string) {\n  return (req: Request, res: Response, next: NextFunction) => {\n    if (!req.session?.userId) {\n      return res.status(401).json({ error: \"Not authenticated\" });\n    }\n    if (req.session.role !== role) {\n      return res.status(403).json({ error: \"Insufficient permissions\" });\n    }\n    next();\n  };\n}\n```",
    "tags": ["auth", "middleware", "current-state"],
    "references": [
      {
        "file": "src/auth/middleware.ts",
        "lines": "1-24",
        "note": "Session-based auth — to be replaced with JWT"
      }
    ],
    "context": {
      "project": "my-saas-app",
      "branch": "feat/jwt-auth"
    }
  }' | jq .

# Expected: 201 with sequence: 3
```

### Test 6: Worker Sends Insight -- Found the Issue

```bash
# Worker reports its analysis findings
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d '{
    "type": "insight",
    "title": "Session store tightly coupled to routes",
    "content": "## Analysis\n\nThe session store is directly imported in 7 route files, not just `auth/routes.ts`. This means the refactor scope is larger than expected.\n\n### Affected files\n| File | Usage |\n|------|-------|\n| `src/auth/routes.ts` | Login/logout, session create/destroy |\n| `src/auth/middleware.ts` | `req.session.userId` checks |\n| `src/api/users.ts` | Reads `req.session.role` for admin checks |\n| `src/api/billing.ts` | Reads `req.session.userId` for Stripe lookup |\n| `src/api/settings.ts` | Reads `req.session.userId` |\n| `src/api/webhooks.ts` | Skips auth but checks `req.session` existence |\n| `src/api/admin.ts` | Reads `req.session.role` |\n\n### Recommendation\nI suggest a 3-phase approach:\n1. **Phase 1:** Create `src/auth/jwt.ts` with sign/verify/refresh functions\n2. **Phase 2:** Update `middleware.ts` to decode JWT instead of reading session\n3. **Phase 3:** Update route files one by one (they only read from `req` — the middleware change covers most of them)\n\nShall I proceed with Phase 1?",
    "tags": ["insight", "coupling", "scope-increase"],
    "references": [
      { "file": "src/auth/routes.ts", "note": "Primary refactor target" },
      { "file": "src/auth/middleware.ts", "note": "Session reads — must change" },
      { "file": "src/api/users.ts", "lines": "14-22", "note": "Admin role check" },
      { "file": "src/api/billing.ts", "lines": "8-10", "note": "Stripe userId lookup" },
      { "file": "src/api/settings.ts", "note": "userId read" },
      { "file": "src/api/webhooks.ts", "lines": "3", "note": "Session existence guard" },
      { "file": "src/api/admin.ts", "note": "Role-based access" }
    ],
    "context": {
      "project": "my-saas-app",
      "branch": "feat/jwt-auth"
    }
  }' | jq .

# Expected: 201 with sequence: 4
```

### Test 7: Director Sends Approval -- Proceed with Phase 1

```bash
# Director approves the plan and tells worker to proceed
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -d '{
    "type": "answer",
    "title": "Approved: proceed with Phase 1",
    "content": "Good analysis. The 3-phase plan makes sense.\n\n**Go ahead with Phase 1** — create `src/auth/jwt.ts` with:\n- `signAccessToken(userId, role)` -> 15min expiry\n- `signRefreshToken(userId)` -> 7d expiry\n- `verifyAccessToken(token)` -> returns payload or throws\n- `rotateRefreshToken(oldToken)` -> invalidate old, issue new\n\nUse `jsonwebtoken` package. Secret should come from `process.env.JWT_SECRET`.\n\nDo NOT touch existing files yet. Just create the new module and report back.",
    "tags": ["approved", "phase-1"]
  }' | jq .

# Expected: 201 with sequence: 5, sender_name: "creator"
```

### Test 8: Worker Sends file_change -- The New JWT Module

```bash
# Worker reports the implementation
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d '{
    "type": "file_change",
    "title": "Created src/auth/jwt.ts",
    "content": "```typescript\n// src/auth/jwt.ts\nimport jwt from \"jsonwebtoken\";\n\nconst JWT_SECRET = process.env.JWT_SECRET;\nif (!JWT_SECRET) throw new Error(\"JWT_SECRET env var required\");\n\nconst ACCESS_TOKEN_EXPIRY = \"15m\";\nconst REFRESH_TOKEN_EXPIRY = \"7d\";\n\ninterface TokenPayload {\n  userId: string;\n  role: string;\n}\n\nexport function signAccessToken(userId: string, role: string): string {\n  return jwt.sign({ userId, role }, JWT_SECRET, {\n    expiresIn: ACCESS_TOKEN_EXPIRY,\n    issuer: \"my-saas-app\",\n  });\n}\n\nexport function signRefreshToken(userId: string): string {\n  return jwt.sign({ userId, type: \"refresh\" }, JWT_SECRET, {\n    expiresIn: REFRESH_TOKEN_EXPIRY,\n    issuer: \"my-saas-app\",\n  });\n}\n\nexport function verifyAccessToken(token: string): TokenPayload {\n  const payload = jwt.verify(token, JWT_SECRET, { issuer: \"my-saas-app\" });\n  if (typeof payload === \"string\") throw new Error(\"Invalid token payload\");\n  return { userId: payload.userId, role: payload.role };\n}\n\n// Invalidation set — in production, use Redis\nconst revokedTokens = new Set<string>();\n\nexport function rotateRefreshToken(oldToken: string): { accessToken: string; refreshToken: string } {\n  const payload = jwt.verify(oldToken, JWT_SECRET, { issuer: \"my-saas-app\" });\n  if (typeof payload === \"string\" || payload.type !== \"refresh\") {\n    throw new Error(\"Invalid refresh token\");\n  }\n  // Revoke old token\n  revokedTokens.add(oldToken);\n  // Issue new pair\n  return {\n    accessToken: signAccessToken(payload.userId, payload.role || \"user\"),\n    refreshToken: signRefreshToken(payload.userId),\n  };\n}\n\nexport function isRevoked(token: string): boolean {\n  return revokedTokens.has(token);\n}\n```\n\nAll 4 functions implemented per spec. Using in-memory revocation set with a comment noting Redis for production. No existing files modified.",
    "tags": ["implementation", "jwt", "phase-1"],
    "references": [
      {
        "file": "src/auth/jwt.ts",
        "lines": "1-58",
        "note": "New file — JWT sign/verify/rotate"
      }
    ],
    "context": {
      "project": "my-saas-app",
      "branch": "feat/jwt-auth"
    }
  }' | jq .

# Expected: 201 with sequence: 6, sender_name: "claude-worker-1"
```

### Test 9: Worker Sends Status Update -- Idle

```bash
# Worker signals it has completed the task and is waiting for next instruction
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d '{
    "type": "status_update",
    "title": "Phase 1 complete — idle",
    "content": "Phase 1 implementation complete. Created `src/auth/jwt.ts` with all 4 functions.\n\nReady for Phase 2 instructions (updating middleware.ts to use JWT verification).",
    "tags": ["status", "idle", "phase-1-done"]
  }' | jq .

# Expected: 201 with sequence: 7
```

### Test 10: Verify Full Conversation via Poll

```bash
# Poll all messages from the beginning (since=0) to verify the full conversation
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq '
  {
    cursor: .cursor,
    has_more: .has_more,
    message_count: (.messages | length),
    conversation: [
      .messages[] | {
        seq: .sequence,
        type: .type,
        sender: .sender_name,
        title: .title
      }
    ]
  }'

# Expected output:
# {
#   "cursor": 7,
#   "has_more": false,
#   "message_count": 7,
#   "conversation": [
#     { "seq": 1, "type": "context",       "sender": "creator",          "title": "Refactor auth module to use JWT" },
#     { "seq": 2, "type": "status_update",  "sender": "claude-worker-1",  "title": "Reading codebase" },
#     { "seq": 3, "type": "file_read",      "sender": "claude-worker-1",  "title": "Current auth middleware" },
#     { "seq": 4, "type": "insight",        "sender": "claude-worker-1",  "title": "Session store tightly coupled to routes" },
#     { "seq": 5, "type": "answer",         "sender": "creator",          "title": "Approved: proceed with Phase 1" },
#     { "seq": 6, "type": "file_change",    "sender": "claude-worker-1",  "title": "Created src/auth/jwt.ts" },
#     { "seq": 7, "type": "status_update",  "sender": "claude-worker-1",  "title": "Phase 1 complete — idle" }
#   ]
# }
```

### Test 11: Verify Session Info Shows Activity

```bash
# Check session metadata reflects the full conversation
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq '{
    name: .name,
    participants: .participants,
    message_count: .message_count,
    expires_at: .expires_at
  }'

# Expected:
# {
#   "name": "Auth Module Refactor",
#   "participants": ["creator", "claude-worker-1"],
#   "message_count": 7,
#   "expires_at": "...+2h from creation..."
# }
```

### Test 12: Sensitive Content Detection (Approval Queue Trigger)

This test demonstrates what happens when a worker tries to send content containing
sensitive patterns. Note: the approval queue only exists in the MCP layer, not in the
HTTP server. When using direct HTTP (as in these curl tests), messages are accepted
regardless of content. This test verifies the server-level behavior -- the sensitive
content scanner is an MCP-side concern.

```bash
# Simulate what the scanner would flag by sending content with sensitive patterns.
# The HTTP server accepts it (no approval queue at this layer), but in a real MCP
# workflow, relay_send would stage it and show warnings before relay_approve.
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d '{
    "type": "conventions",
    "title": "Environment configuration",
    "content": "The auth module reads from these env vars:\n- `JWT_SECRET` (required)\n- `REFRESH_TOKEN_SECRET` (optional, falls back to JWT_SECRET)\n\nNote: In the `.env` file I found:\n```\nJWT_SECRET=\"super-secret-value\"\nDATABASE_URL=\"postgres://user:pass@localhost:5432/mydb\"\n```\n\nAlso found a hardcoded key: sk-proj-abc123def456ghi789jkl012mno345pqr",
    "tags": ["env", "secrets"]
  }' | jq .

# Expected: 201 (HTTP server accepts it — no server-side content filtering)
#
# However, if this same payload were sent via the MCP relay_send tool, the scanner
# would flag:
#   - "Potential sensitive content detected: sk-pro...r" (OpenAI key pattern)
#   - "Potential sensitive content detected: secret..." (secret assignment pattern)
#
# The MCP approval queue would require the user to explicitly approve before sending.
```

---

## Edge Cases and Failure Modes

### Token Authorization Boundaries

```bash
# Worker cannot use the director's token
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid-token-here" \
  -d '{"type": "context", "content": "Should fail"}' | jq .

# Expected: 403 { "error": "Invalid token for this session" }
```

### Message Size Limit (100KB)

```bash
# Generate a message exceeding MAX_MESSAGE_SIZE (102,400 bytes)
LARGE_CONTENT=$(python3 -c "print('x' * 103000)")
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -d "{\"type\": \"file_read\", \"content\": \"${LARGE_CONTENT}\"}" | jq .

# Expected: 400 with Zod validation error (string length exceeds MAX_MESSAGE_SIZE)
```

### Polling with Cursor Advancement

```bash
# Poll only new messages (from sequence 5 onward)
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=5&limit=10" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" | jq '{
    cursor: .cursor,
    new_messages: [.messages[] | { seq: .sequence, type: .type, title: .title }]
  }'

# Expected: messages with sequence > 5 only (the file_change, status_update, and
# any test messages sent after sequence 5)
```

### Session Expiry

Sessions expire based on the `expiresAt` timestamp set at creation. The TTL sweep runs
every 60 seconds (`TTL_SWEEP_INTERVAL_MS`). After expiry:

```bash
# After session expires, all operations return 404
# (cannot test in real time without waiting, but the behavior is:)
# curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0" \
#   -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq .
# Expected: { "error": "Session not found" }
```

---

## Cleanup

```bash
# No explicit session delete endpoint exists.
# Sessions expire via TTL sweep (every 60s, checks expiresAt).
# For immediate cleanup, restart the server (in-memory store resets).
echo "Session $SESSION_ID will expire at its TTL. Restart server to clear immediately."
```
