# Scenario 01: Compute Asymmetry -- $20 Plan Directs $200 Plan

## Overview

This scenario validates the core value proposition of claude-relay: a human on a
cheap Claude plan (the "director") creates a relay session and uses it to
orchestrate a Claude Code instance running on an expensive Max plan (the
"worker"). The director contributes intent, context, and review; the worker
contributes raw compute -- file changes, terminal output, status updates.

The relay server acts as a neutral broker. It does not know or care which
participant is cheap and which is expensive. The asymmetry is purely economic:
the director sends fewer, smaller messages (instructions, questions), while the
worker sends more, larger messages (diffs, file trees, status updates).

---

## Technical Analysis

### What This Scenario Tests

1. **Role separation via token model** -- The creator token (director) and
   participant token (worker) have identical relay capabilities. Role
   distinction is purely conventional, enforced by the humans/agents using the
   system rather than by the server.

2. **Asymmetric message flow** -- Director sends `context` and `question` types.
   Worker sends `status_update`, `file_change`, `answer`, and `file_read` types.
   The server treats all message types equally; this test validates that the
   full spectrum works end-to-end.

3. **Rate limiting under asymmetry** -- The worker sends more messages per
   minute than the director. With `RATE_LIMIT_PER_MINUTE = 600`, this is
   unlikely to be hit in normal use, but the test verifies both roles stay
   within bounds.

4. **Session lifecycle** -- Create, join, exchange messages, poll history.
   The full lifecycle a real director/worker pair would follow.

### Data Flow Diagram

```
 Director ($20 plan)                  Relay Server (:4190)                Worker ($200 plan)
 ==================                   ==================                  ==================

 1. POST /sessions
    {name: "refactor"}
    -------------------------------->
                                      Creates session
                                      Returns:
                                        session_id
                                        creator_token
                                        invite_token
    <--------------------------------

 2. Share session_id + invite_token out-of-band (paste into worker terminal)

                                                                          3. POST /sessions/:id/join
                                                                             Authorization: Bearer <invite_token>
                                                                             {participant_name: "worker-claude"}
                                      <--------------------------------------
                                      Returns participant_token
                                      -------------------------------------->

 4. POST /relay/:id
    Authorization: Bearer <creator_token>
    {type: "context", content: "..."}
    -------------------------------->
                                      Stores message (seq 1)
    <--------------------------------

                                                                          5. GET /relay/:id?since=0
                                                                             Authorization: Bearer <participant_token>
                                      <--------------------------------------
                                      Returns [{seq:1, type:"context"}]
                                      -------------------------------------->

                                                                          6. POST /relay/:id
                                                                             {type: "status_update", ...}
                                      <--------------------------------------
                                                                             Stores message (seq 2)
                                      -------------------------------------->

                                                                          7. POST /relay/:id
                                                                             {type: "file_change", ...}
                                      <--------------------------------------
                                                                             Stores message (seq 3)
                                      -------------------------------------->

 8. GET /relay/:id?since=0
    -------------------------------->
                                      Returns [seq 1, 2, 3]
    <--------------------------------

 9. POST /relay/:id
    {type: "question", ...}
    -------------------------------->
                                      Stores message (seq 4)
    <--------------------------------

                                                                          10. GET /relay/:id?since=3
                                                                              Returns [{seq:4, type:"question"}]

                                                                          11. POST /relay/:id
                                                                              {type: "answer", ...}
                                                                              Stores message (seq 5)

 12. GET /relay/:id?since=3
     Returns [seq 4, 5]
```

### Auth Model

| Role     | Token Type         | How Obtained                          | Capabilities                     |
|----------|--------------------|---------------------------------------|----------------------------------|
| Director | `creator_token`    | Returned from `POST /sessions`        | Send messages, poll, view info   |
| Director | `invite_token`     | Returned from `POST /sessions`        | Only used to join (one purpose)  |
| Worker   | `participant_token`| Returned from `POST /sessions/:id/join`| Send messages, poll, view info  |

- Tokens are UUIDv4 strings, stored in an in-memory `tokenIndex` map.
- `isValidToken(token, sessionId)` returns true for creator_token OR any
  participant token registered to that session.
- The invite_token is NOT a valid auth token for relay routes -- it can only be
  used to join. After joining, the worker uses their participant_token.
- There is no role-based access control on message types. Either role can send
  any of the 14 message types.

### Message Types Used in This Scenario

| Type             | Sender   | Purpose                                           |
|------------------|----------|---------------------------------------------------|
| `context`        | Director | Initial instructions, project context, constraints |
| `question`       | Director | Follow-up questions about worker's output          |
| `status_update`  | Worker   | Progress reports ("reading codebase", "writing tests") |
| `file_change`    | Worker   | Diffs, new file contents, refactored code          |
| `answer`         | Worker   | Responses to director questions                    |
| `file_read`      | Worker   | Sharing file contents for director review          |

### Rate Limiting Implications

The rate limiter is a sliding-window counter keyed by bearer token. Each token
gets an independent window of `RATE_LIMIT_PER_MINUTE = 600` requests per 60
seconds.

- **Director**: Sends ~2-5 messages per session. Well within limits.
- **Worker**: Sends ~10-50 messages per session (file changes, status updates,
  answers). Still well within limits.
- **Polling**: GET requests to `/relay/:id` also count toward the limit. A
  worker polling every 2 seconds would hit 30 req/min -- well under 600.
- **SSE alternative**: The `/relay/:id/stream` endpoint uses a single long-lived
  connection with server-sent events, consuming only 1 request regardless of
  message volume. Preferred for high-frequency scenarios.

### Edge Cases

1. **Worker disconnects mid-task**
   - Messages already sent remain in the session store.
   - Director can poll and see the last status_update to understand where the
     worker stopped.
   - Worker can reconnect (their participant_token remains valid until session
     expires) and resume sending from where they left off.
   - No "presence" mechanism exists -- director cannot distinguish between
     "worker is thinking" and "worker crashed." Future work: heartbeat messages.

2. **Director sends conflicting instructions**
   - The relay is append-only. If the director sends two `context` messages with
     contradictory instructions, both exist in the message log.
   - The worker sees messages in sequence order and must resolve conflicts by
     asking (sending a `question` type) or using the latest instruction.
   - No mechanism to delete or edit messages. The director must send a new
     `context` message explicitly superseding the old one.

3. **Session expires during work**
   - Default TTL is 60 minutes, max is 1440 (24 hours).
   - The TTL sweep runs every 60 seconds. If a session expires, all messages
     are lost (in-memory store).
   - Mitigation: set `ttl_minutes: 1440` for long tasks. The `lastActivityAt`
     field is updated on every message, but TTL is absolute from creation --
     activity does NOT extend the session.

4. **Message size limits**
   - `MAX_MESSAGE_SIZE = 102,400` bytes (100KB) for the `content` field.
   - Large diffs that exceed 100KB must be split across multiple `file_change`
     messages.
   - The worker should chunk large outputs and use the `title` field to indicate
     ordering (e.g., "Diff 1/3 -- src/auth.ts").

5. **Invite token reuse**
   - The invite token can be used multiple times to add up to
     `MAX_PARTICIPANTS = 10` participants.
   - In this scenario only one worker joins, but the token could be shared with
     additional reviewers.

---

## Test Cases

### Prerequisites

```bash
# Ensure the relay server is running
curl -sf http://localhost:4190/health || echo "ERROR: Start the relay server first (bun run dev:server)"
```

All test cases use bash variables set progressively. Run them in order within
a single shell session.

---

### Test 1: Director Creates a Session

**Name**: Session creation by director (cheap plan)

**Steps**:
```bash
# 1. Create a new session as the director
RESPONSE=$(curl -s -X POST http://localhost:4190/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "refactor-auth-module", "ttl_minutes": 120}')

echo "$RESPONSE" | jq .

# 2. Extract tokens for subsequent tests
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
DIRECTOR_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')

echo "SESSION_ID=$SESSION_ID"
echo "DIRECTOR_TOKEN=$DIRECTOR_TOKEN"
echo "INVITE_TOKEN=$INVITE_TOKEN"
```

**Expected**:
```json
{
  "session_id": "<uuid>",
  "creator_token": "<uuid>",
  "invite_token": "<uuid>",
  "expires_at": "<ISO 8601 timestamp ~2 hours from now>"
}
```
- HTTP status: `201 Created`
- All three token fields are present and are valid UUIDs.
- `expires_at` is approximately 120 minutes in the future.

**Validates**: Directors on any plan can create sessions. The response provides
all three tokens needed for the full workflow (creator auth, invite sharing,
session identification).

---

### Test 2: Worker Joins with Invite Token

**Name**: Worker joins session using invite token

**Steps**:
```bash
# 1. Worker joins the session using the invite token
JOIN_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"participant_name": "worker-claude-max"}')

echo "$JOIN_RESPONSE" | jq .

# 2. Extract the worker's participant token
WORKER_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')

echo "WORKER_TOKEN=$WORKER_TOKEN"
```

**Expected**:
```json
{
  "participant_token": "<uuid>",
  "session": {
    "id": "<session_id>",
    "name": "refactor-auth-module",
    "participants": ["creator", "worker-claude-max"],
    "message_count": 0,
    "expires_at": "<ISO 8601>"
  }
}
```
- HTTP status: `200 OK`
- `participant_token` is a new UUID (different from creator_token and invite_token).
- `participants` array includes both "creator" and "worker-claude-max".
- `message_count` is 0 (no messages yet).

**Validates**: The invite token grants join access but is itself not a relay
auth token. The worker receives a unique participant_token for all subsequent
operations. The participant_name appears in the session metadata.

---

### Test 3: Director Sends Initial Instructions

**Name**: Director sends context-type instruction message

**Steps**:
```bash
# 1. Director sends project context and instructions
SEND_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "context",
    "title": "Refactor auth module to use JWT",
    "content": "## Task\n\nRefactor `src/auth/session.ts` to replace cookie-based sessions with JWT tokens.\n\n## Constraints\n- Keep backward compatibility with existing `/login` endpoint\n- Use `jose` library (already in package.json)\n- Add token refresh endpoint at `POST /auth/refresh`\n- Write tests for token expiry edge cases\n\n## Priority\nHigh -- blocking the API gateway rollout.",
    "tags": ["auth", "jwt", "refactor"],
    "references": [
      {"file": "src/auth/session.ts", "note": "Current session implementation to replace"},
      {"file": "src/routes/login.ts", "lines": "42-67", "note": "Login handler that creates sessions"}
    ],
    "context": {
      "project": "api-gateway",
      "stack": "Node.js, Express, TypeScript",
      "branch": "feature/jwt-auth"
    }
  }')

echo "$SEND_RESPONSE" | jq .
```

**Expected**:
```json
{
  "message_id": "<uuid>",
  "sequence": 1,
  "received_at": "<ISO 8601>"
}
```
- HTTP status: `201 Created`
- `sequence` is 1 (first message in session).
- `message_id` is a valid UUID.

**Validates**: Director can send structured context with metadata (tags,
file references, project context). The Zod schema validates the full payload
including nested objects. This is the typical "kickoff" message in the compute
asymmetry pattern.

---

### Test 4: Worker Polls and Receives Instructions

**Name**: Worker polls for new messages and receives director's context

**Steps**:
```bash
# 1. Worker polls for all messages since sequence 0
POLL_RESPONSE=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=10" \
  -H "Authorization: Bearer ${WORKER_TOKEN}")

echo "$POLL_RESPONSE" | jq .

# 2. Verify the director's message is present
echo "$POLL_RESPONSE" | jq '.messages[0].type'
echo "$POLL_RESPONSE" | jq '.messages[0].sender_name'
echo "$POLL_RESPONSE" | jq '.messages[0].title'
```

**Expected**:
```json
{
  "messages": [
    {
      "message_id": "<uuid>",
      "sequence": 1,
      "type": "context",
      "title": "Refactor auth module to use JWT",
      "content": "## Task\n\nRefactor `src/auth/session.ts`...",
      "tags": ["auth", "jwt", "refactor"],
      "references": [...],
      "context": {"project": "api-gateway", ...},
      "sender_name": "creator",
      "sent_at": "<ISO 8601>"
    }
  ],
  "cursor": 1,
  "has_more": false
}
```
- `messages` array has exactly 1 entry.
- `sender_name` is `"creator"` (the director).
- `cursor` is 1, `has_more` is false.
- All fields from the original POST are preserved (tags, references, context).

**Validates**: Workers can poll and receive messages sent by the director.
The cursor-based pagination works correctly. The `sender_name` identifies
messages as coming from the creator role.

---

### Test 5: Worker Sends Status Update

**Name**: Worker sends status_update acknowledging the task

**Steps**:
```bash
# 1. Worker sends a status update
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "status_update",
    "title": "Starting work",
    "content": "Reading `src/auth/session.ts` and `src/routes/login.ts`. Will analyze current cookie implementation before writing JWT replacement.",
    "tags": ["status", "in-progress"]
  }' | jq .
```

**Expected**:
```json
{
  "message_id": "<uuid>",
  "sequence": 2,
  "received_at": "<ISO 8601>"
}
```
- HTTP status: `201 Created`
- `sequence` is 2.

**Validates**: Worker can send workspace-type messages (`status_update`) using
their participant token. The director can track progress by polling for these
lightweight status messages without waiting for the full file_change output.

---

### Test 6: Worker Sends File Change (Diff)

**Name**: Worker sends file_change with a code diff

**Steps**:
```bash
# 1. Worker sends a file change with a diff
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_change",
    "title": "Replace cookie sessions with JWT in auth module",
    "content": "```diff\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,15 +1,42 @@\n-import { serialize, parse } from \"cookie\";\n-import { v4 as uuid } from \"uuid\";\n+import { SignJWT, jwtVerify } from \"jose\";\n+import { createSecretKey } from \"crypto\";\n \n-const sessions = new Map<string, SessionData>();\n+const JWT_SECRET = createSecretKey(\n+  Buffer.from(process.env.JWT_SECRET || \"dev-secret-change-me\")\n+);\n+const ACCESS_TOKEN_TTL = \"15m\";\n+const REFRESH_TOKEN_TTL = \"7d\";\n \n-export function createSession(userId: string): string {\n-  const sid = uuid();\n-  sessions.set(sid, { userId, createdAt: Date.now() });\n-  return serialize(\"sid\", sid, { httpOnly: true, path: \"/\" });\n+export async function createAccessToken(userId: string): Promise<string> {\n+  return new SignJWT({ sub: userId, type: \"access\" })\n+    .setProtectedHeader({ alg: \"HS256\" })\n+    .setIssuedAt()\n+    .setExpirationTime(ACCESS_TOKEN_TTL)\n+    .sign(JWT_SECRET);\n }\n \n-export function getSession(cookieHeader: string): SessionData | null {\n-  const cookies = parse(cookieHeader);\n-  return sessions.get(cookies.sid) || null;\n+export async function createRefreshToken(userId: string): Promise<string> {\n+  return new SignJWT({ sub: userId, type: \"refresh\" })\n+    .setProtectedHeader({ alg: \"HS256\" })\n+    .setIssuedAt()\n+    .setExpirationTime(REFRESH_TOKEN_TTL)\n+    .sign(JWT_SECRET);\n+}\n+\n+export async function verifyToken(token: string): Promise<{ sub: string; type: string }> {\n+  const { payload } = await jwtVerify(token, JWT_SECRET);\n+  return { sub: payload.sub as string, type: payload.type as string };\n }\n```",
    "tags": ["auth", "jwt", "diff"],
    "references": [
      {"file": "src/auth/session.ts", "note": "Replaced cookie sessions with JWT sign/verify"}
    ],
    "context": {
      "project": "api-gateway",
      "branch": "feature/jwt-auth"
    }
  }' | jq .
```

**Expected**:
```json
{
  "message_id": "<uuid>",
  "sequence": 3,
  "received_at": "<ISO 8601>"
}
```
- HTTP status: `201 Created`
- `sequence` is 3.
- The large content payload (diff) is accepted within the 100KB limit.

**Validates**: The relay correctly handles large structured content (code diffs
in markdown). File references link the change to specific files. This is the
primary value delivery mechanism: the expensive worker produces code, the relay
transmits it to the cheap director for review.

---

### Test 7: Director Sends Follow-Up Question

**Name**: Director asks a question about the worker's output

**Steps**:
```bash
# 1. Director sends a follow-up question
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "question",
    "title": "JWT secret rotation strategy?",
    "content": "The diff uses a single `JWT_SECRET` from env. What happens when we need to rotate the secret? Will existing tokens immediately become invalid?\n\nAlso -- should `dev-secret-change-me` fallback be removed for production? Seems like a security risk if `JWT_SECRET` env is missing.",
    "tags": ["auth", "security", "question"]
  }' | jq .
```

**Expected**:
```json
{
  "message_id": "<uuid>",
  "sequence": 4,
  "received_at": "<ISO 8601>"
}
```
- HTTP status: `201 Created`
- `sequence` is 4.

**Validates**: The director can interleave review feedback with the worker's
output stream. The `question` type signals that the worker should respond
before proceeding. This back-and-forth is the core interaction loop of the
compute asymmetry pattern.

---

### Test 8: Worker Sends Answer

**Name**: Worker answers the director's question

**Steps**:
```bash
# 1. Worker polls for new messages since last known cursor
WORKER_POLL=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=2&limit=10" \
  -H "Authorization: Bearer ${WORKER_TOKEN}")

echo "--- Worker sees new messages ---"
echo "$WORKER_POLL" | jq '.messages[] | {seq: .sequence, type: .type, title: .title}'

# 2. Worker sends an answer
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "answer",
    "title": "JWT rotation: JWKS + fallback removal",
    "content": "Good catches. Two changes:\n\n### 1. Secret Rotation\nI will switch to JWKS (JSON Web Key Sets) with key ID (`kid`) in the header. During rotation, both old and new keys are valid. Implementation:\n\n```typescript\nconst keys = new Map<string, KeyLike>();\n// Verify tries all keys matching the kid\n```\n\n### 2. Dev Fallback Removal\nAgreed -- the fallback is dangerous. I will add a startup check:\n\n```typescript\nif (!process.env.JWT_SECRET) {\n  throw new Error(\"JWT_SECRET environment variable is required\");\n}\n```\n\nShall I proceed with both changes?",
    "tags": ["auth", "security", "answer"]
  }' | jq .
```

**Expected**:

Worker poll response:
```json
{
  "messages": [
    {"sequence": 3, "type": "file_change", ...},
    {"sequence": 4, "type": "question", ...}
  ],
  "cursor": 4,
  "has_more": false
}
```

Answer send response:
```json
{
  "message_id": "<uuid>",
  "sequence": 5,
  "received_at": "<ISO 8601>"
}
```

**Validates**: The cursor-based polling correctly returns only messages newer
than the worker's last checkpoint (`since=2` skips seq 1 and 2). The worker
can answer questions with structured markdown. The conversation naturally
alternates between director questions and worker answers.

---

### Test 9: Verify Full Message History

**Name**: Director polls full session history to verify complete exchange

**Steps**:
```bash
# 1. Director polls all messages from the beginning
FULL_HISTORY=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}")

echo "--- Full message history ---"
echo "$FULL_HISTORY" | jq '.messages[] | {seq: .sequence, type: .type, sender: .sender_name, title: .title}'

echo ""
echo "--- Summary ---"
echo "$FULL_HISTORY" | jq '{
  total_messages: (.messages | length),
  cursor: .cursor,
  has_more: .has_more,
  message_types: [.messages[].type],
  senders: [.messages[].sender_name]
}'

# 2. Verify session info shows correct participant count and message count
SESSION_INFO=$(curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}")

echo ""
echo "--- Session info ---"
echo "$SESSION_INFO" | jq .
```

**Expected**:

Message history summary:
```json
{
  "total_messages": 5,
  "cursor": 5,
  "has_more": false,
  "message_types": ["context", "status_update", "file_change", "question", "answer"],
  "senders": ["creator", "worker-claude-max", "worker-claude-max", "creator", "worker-claude-max"]
}
```

Detailed sequence:
```
seq 1 | context       | creator          | Refactor auth module to use JWT
seq 2 | status_update | worker-claude-max | Starting work
seq 3 | file_change   | worker-claude-max | Replace cookie sessions with JWT...
seq 4 | question      | creator          | JWT secret rotation strategy?
seq 5 | answer        | worker-claude-max | JWT rotation: JWKS + fallback removal
```

Session info:
```json
{
  "id": "<session_id>",
  "name": "refactor-auth-module",
  "participants": ["creator", "worker-claude-max"],
  "message_count": 5,
  "created_at": "<ISO 8601>",
  "expires_at": "<ISO 8601>",
  "last_activity_at": "<ISO 8601 -- updated to last message time>"
}
```

**Validates**: The complete message history is retrievable via a single poll.
All 5 message types used in the scenario are correctly stored and returned.
Sender names correctly distinguish director ("creator") from worker
("worker-claude-max"). The session info endpoint reflects the current state
including participant list and message count. The cursor-based system returns
all messages when `since=0` and `limit` is high enough.

---

## Running the Full Test Suite

Copy and paste this self-contained script to run all tests in sequence:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:4190"

echo "=== Compute Asymmetry Test Suite ==="
echo ""

# Preflight
echo "[preflight] Checking server health..."
curl -sf "${BASE}/health" > /dev/null || { echo "FAIL: Server not running"; exit 1; }
echo "[preflight] Server is healthy."
echo ""

# Test 1: Create session
echo "[test 1] Director creates session..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/sessions" \
  -H "Content-Type: application/json" \
  -d '{"name": "refactor-auth-module", "ttl_minutes": 120}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
[ "$HTTP_CODE" = "201" ] && echo "  PASS (201)" || echo "  FAIL (got $HTTP_CODE)"

SESSION_ID=$(echo "$BODY" | jq -r '.session_id')
DIRECTOR_TOKEN=$(echo "$BODY" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$BODY" | jq -r '.invite_token')
echo "  session_id: ${SESSION_ID:0:8}..."
echo ""

# Test 2: Worker joins
echo "[test 2] Worker joins with invite token..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/sessions/${SESSION_ID}/join" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"participant_name": "worker-claude-max"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
[ "$HTTP_CODE" = "200" ] && echo "  PASS (200)" || echo "  FAIL (got $HTTP_CODE)"

WORKER_TOKEN=$(echo "$BODY" | jq -r '.participant_token')
PARTICIPANTS=$(echo "$BODY" | jq -r '.session.participants | join(", ")')
echo "  participants: $PARTICIPANTS"
echo ""

# Test 3: Director sends context
echo "[test 3] Director sends context message..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"context","title":"Refactor auth module to use JWT","content":"Refactor src/auth/session.ts to replace cookie-based sessions with JWT tokens.","tags":["auth","jwt"]}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
SEQ=$(echo "$BODY" | jq -r '.sequence')
[ "$HTTP_CODE" = "201" ] && [ "$SEQ" = "1" ] && echo "  PASS (201, seq=$SEQ)" || echo "  FAIL (got $HTTP_CODE, seq=$SEQ)"
echo ""

# Test 4: Worker polls
echo "[test 4] Worker polls for director's message..."
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE}/relay/${SESSION_ID}?since=0&limit=10" \
  -H "Authorization: Bearer ${WORKER_TOKEN}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
MSG_COUNT=$(echo "$BODY" | jq '.messages | length')
SENDER=$(echo "$BODY" | jq -r '.messages[0].sender_name')
[ "$HTTP_CODE" = "200" ] && [ "$MSG_COUNT" = "1" ] && [ "$SENDER" = "creator" ] \
  && echo "  PASS (1 message from creator)" || echo "  FAIL (count=$MSG_COUNT, sender=$SENDER)"
echo ""

# Test 5: Worker sends status_update
echo "[test 5] Worker sends status_update..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"status_update","title":"Starting work","content":"Reading codebase. Will analyze current cookie implementation.","tags":["status"]}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
SEQ=$(echo "$BODY" | jq -r '.sequence')
[ "$HTTP_CODE" = "201" ] && [ "$SEQ" = "2" ] && echo "  PASS (201, seq=$SEQ)" || echo "  FAIL (got $HTTP_CODE, seq=$SEQ)"
echo ""

# Test 6: Worker sends file_change
echo "[test 6] Worker sends file_change with diff..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_change","title":"Replace cookie sessions with JWT","content":"```diff\n-import { serialize } from \"cookie\";\n+import { SignJWT, jwtVerify } from \"jose\";\n```","tags":["auth","diff"],"references":[{"file":"src/auth/session.ts","note":"Replaced cookies with JWT"}]}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
SEQ=$(echo "$BODY" | jq -r '.sequence')
[ "$HTTP_CODE" = "201" ] && [ "$SEQ" = "3" ] && echo "  PASS (201, seq=$SEQ)" || echo "  FAIL (got $HTTP_CODE, seq=$SEQ)"
echo ""

# Test 7: Director sends question
echo "[test 7] Director sends follow-up question..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"question","title":"JWT secret rotation?","content":"What happens when we rotate the JWT secret? Will existing tokens break?","tags":["security"]}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
SEQ=$(echo "$BODY" | jq -r '.sequence')
[ "$HTTP_CODE" = "201" ] && [ "$SEQ" = "4" ] && echo "  PASS (201, seq=$SEQ)" || echo "  FAIL (got $HTTP_CODE, seq=$SEQ)"
echo ""

# Test 8: Worker sends answer
echo "[test 8] Worker sends answer..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE}/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"answer","title":"JWKS rotation + startup check","content":"Will use JWKS with kid headers for rotation. Adding startup check to throw if JWT_SECRET is unset.","tags":["security","answer"]}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
SEQ=$(echo "$BODY" | jq -r '.sequence')
[ "$HTTP_CODE" = "201" ] && [ "$SEQ" = "5" ] && echo "  PASS (201, seq=$SEQ)" || echo "  FAIL (got $HTTP_CODE, seq=$SEQ)"
echo ""

# Test 9: Full history verification
echo "[test 9] Verify full message history..."
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE}/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
TOTAL=$(echo "$BODY" | jq '.messages | length')
TYPES=$(echo "$BODY" | jq -r '[.messages[].type] | join(",")')
SENDERS=$(echo "$BODY" | jq -r '[.messages[].sender_name] | join(",")')
EXPECTED_TYPES="context,status_update,file_change,question,answer"
EXPECTED_SENDERS="creator,worker-claude-max,worker-claude-max,creator,worker-claude-max"

if [ "$TOTAL" = "5" ] && [ "$TYPES" = "$EXPECTED_TYPES" ] && [ "$SENDERS" = "$EXPECTED_SENDERS" ]; then
  echo "  PASS (5 messages, types and senders match)"
else
  echo "  FAIL (total=$TOTAL, types=$TYPES, senders=$SENDERS)"
fi

echo ""
echo "=== Full sequence ==="
echo "$BODY" | jq -r '.messages[] | "  seq \(.sequence) | \(.type | . + " " * (14 - length)) | \(.sender_name | . + " " * (18 - length)) | \(.title)"'

echo ""
echo "=== Test suite complete ==="
```

---

## Key Observations

1. **No role enforcement in the protocol.** The server cannot distinguish
   director from worker. Both use bearer tokens with identical permissions.
   The asymmetry is purely in how the tokens are used: the creator_token holder
   sends instructions, the participant_token holder executes them.

2. **Cursor-based polling is stateless.** Each poll specifies `since=N` and the
   server filters in-memory. There is no server-side cursor tracking per client.
   This means a disconnected worker can resume from any sequence number without
   re-registering.

3. **The 100KB content limit is generous but finite.** A typical file diff is
   2-10KB. A full file dump of a large module might hit 50KB. Workers should
   prefer diffs over full file contents when possible.

4. **SSE streaming eliminates polling overhead.** For long-running tasks, the
   worker should use `GET /relay/:id/stream` to receive director instructions
   instantly rather than polling on an interval.

5. **The sensitive content scanner (SENSITIVE_PATTERNS in constants.ts) will
   flag macOS absolute paths.** Workers sending file_read or file_change
   messages with absolute paths (e.g., `/Users/wei/project/src/auth.ts`) will
   trigger the scanner when going through the MCP approval queue. When using
   curl directly (as in these tests), the scanner is bypassed since it lives
   in the MCP layer, not the HTTP layer.
