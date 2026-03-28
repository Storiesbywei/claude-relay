# Scenario 07: Teaching/Pairing

**Use case:** A senior developer watches the relay dashboard while a junior developer's Claude Code session works on a task. The senior observes progress in real time and sends course corrections only when needed -- a "pair programming with guardrails" pattern.

---

## Technical Analysis

### What This Scenario Tests

This scenario validates the relay's ability to support **asymmetric observation and intervention** -- one party (the senior) mostly watches and occasionally sends targeted guidance, while the other party (junior's Claude) does the bulk of the work and broadcasts its progress. The relay acts as a one-way mirror with a two-way intercom.

The key distinction from a standard director/worker session is the **intervention ratio**. In a typical director session, the director sends frequent commands. In a teaching/pairing session, the senior may send only 2-3 messages across a 30-minute session, each one carefully timed to maximize learning impact.

### Observer Pattern: Watch First, Intervene Later

The senior dev opens the dashboard at `http://localhost:4190` and connects to the session. The dashboard's SSE stream (`GET /relay/:id/stream`) delivers every message from the junior's Claude in real time -- no polling, no refresh. The senior sees:

- **`status_update`** messages: "starting task", "reading codebase", "writing implementation", "running tests", "task complete"
- **`file_change`** messages: diffs of every file the junior's Claude edits, rendered in the dashboard's file viewer
- **`file_read`** messages: what files the junior's Claude is examining (reveals its reasoning path)
- **`terminal`** messages: test output, build errors, lint warnings

This gives the senior a live feed of the junior's Claude's entire workflow without interrupting it.

### Low-Touch vs High-Touch Intervention

The relay's message type system maps naturally to different intervention intensities:

| Intervention Style | Message Type | Example | Teaching Impact |
|---|---|---|---|
| **Socratic** | `question` | "Are you sure about that approach?" | Forces junior to re-examine |
| **Contextual** | `context` | "Consider using the repository pattern here" | Provides a hint without dictating |
| **Corrective** | `answer` | "That has an N+1 query issue. Use eager loading." | Direct fix when time is short |
| **Structural** | `patterns` | "We use the strategy pattern for this class of problem" | Teaches team conventions |
| **Positive** | `context` | "Good catch on the edge case. Next time also consider..." | Reinforcement + forward guidance |

The senior chooses the message type based on how much autonomy they want the junior's Claude to retain. A `question` preserves maximum autonomy; an `answer` with a code snippet is a direct override.

### The Dashboard as a Teaching Tool

The dashboard's file viewer is critical for this scenario. When the junior's Claude sends a `file_change` message with `references` pointing to specific files and line ranges, the senior can:

1. See the diff in context (what changed, which file, which lines)
2. Spot issues before they cascade (an incorrect SQL query, a missing null check, an anti-pattern)
3. Send a targeted response referencing the exact file and line range

The `references` field in the message schema (`FileReferenceSchema`) supports this:
```json
{
  "references": [
    { "file": "src/db/queries.ts", "lines": "42-67", "note": "N+1 query here" }
  ]
}
```

### When to Intervene

The senior's decision tree:

1. **Junior's Claude is on the right track** -- Do nothing. Let it work. The absence of intervention is itself a signal.
2. **Minor style issue** -- Wait until the task is done, then send a `context` message as a post-mortem note.
3. **Approaching a pitfall** -- Send a `question` to prompt re-evaluation. ("Have you considered what happens when `user` is null?")
4. **Active bug being introduced** -- Send an `answer` with the correction immediately. Time matters more than Socratic method.
5. **Architectural misunderstanding** -- Send a `patterns` or `conventions` message to reframe the approach before more code is written.

### SSE Keeps the Dashboard Live

The SSE endpoint (`GET /relay/:id/stream`) delivers messages as they arrive with no latency beyond network transit. The heartbeat (`ping` every 15 seconds) keeps the connection alive through proxies and NAT. The senior never needs to refresh the page or manually poll -- the dashboard updates itself.

This is important because the teaching scenario requires the senior to notice problems **as they happen**, not after the fact. A 10-second polling interval could mean the junior's Claude writes 50 more lines on top of a flawed foundation before the senior even sees the initial mistake.

### Session as a Learning Artifact

Every message in the session is stored with:
- `sequence` number (monotonically increasing, set by the server)
- `sent_at` timestamp
- `sender_name` ("creator" for senior, participant name for junior's Claude)
- `type` (distinguishes observation from intervention)

After the session ends, the full message history can be polled with `GET /relay/:id?since=0&limit=50` to reconstruct the entire pairing session. This serves as:

- **A review artifact** for the junior developer to study later
- **A pattern library** of the senior's interventions (what they caught, when, how they communicated the fix)
- **A training signal** for understanding where the junior's Claude tends to go wrong

The `cursor`-based pagination (`since` parameter, `has_more` flag) ensures the full history is retrievable even for long sessions, and the sequence numbers guarantee correct ordering for replay.

### Message Ordering Guarantees

The in-memory store assigns sequence numbers atomically via `session.sequenceCounter++` inside `addMessage()`. This means:

- Messages are always returned in the order they were received by the server
- Polling with `since=N` returns all messages after sequence N
- The SSE stream delivers messages in order via the `id` field (set to `String(msg.sequence)`)
- No two messages can share a sequence number within a session

This ordering is essential for the teaching scenario because the conversation must make sense as a chronological narrative: junior does X, senior responds with Y, junior adjusts with Z.

---

## Test Cases

All tests run against `http://localhost:4190`. The relay server must be running.

### Prerequisites

```bash
# Start the relay server (if not already running)
# cd /Users/weixiangzhang/Local_Dev/projects/claude-relay && bun run dev:server

# Verify server is up
curl -s http://localhost:4190/health | jq .
```

---

### Test 1: Senior creates a teaching session

The senior developer creates a pairing session with a descriptive name and a generous TTL (2 hours) so the session outlasts the task.

```bash
# Create session
RESPONSE=$(curl -s -X POST http://localhost:4190/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Teaching: Refactor user-service to repository pattern",
    "ttl_minutes": 120
  }')

echo "$RESPONSE" | jq .

# Extract tokens for subsequent requests
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
SENIOR_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')

echo "SESSION_ID=$SESSION_ID"
echo "SENIOR_TOKEN=$SENIOR_TOKEN"
echo "INVITE_TOKEN=$INVITE_TOKEN"

# Verify: response has all four fields
echo "$RESPONSE" | jq -e '.session_id and .creator_token and .invite_token and .expires_at' > /dev/null \
  && echo "PASS: Session created with all tokens" \
  || echo "FAIL: Missing fields in session response"
```

**Expected:** 201 response with `session_id`, `creator_token`, `invite_token`, and `expires_at` (2 hours from now).

---

### Test 2: Junior's Claude joins as worker

The senior shares the session ID and invite token with the junior. The junior's Claude joins with a descriptive participant name.

```bash
# Junior's Claude joins the session
JOIN_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "participant_name": "juniors-claude"
  }')

echo "$JOIN_RESPONSE" | jq .

JUNIOR_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
echo "JUNIOR_TOKEN=$JUNIOR_TOKEN"

# Verify: participant list now includes both parties
echo "$JOIN_RESPONSE" | jq -e '.session.participants | length == 2' > /dev/null \
  && echo "PASS: Both participants visible" \
  || echo "FAIL: Participant count incorrect"

# Verify: participant names are correct
echo "$JOIN_RESPONSE" | jq -e '.session.participants | index("creator") != null and index("juniors-claude") != null' > /dev/null \
  && echo "PASS: Participant names correct" \
  || echo "FAIL: Participant names incorrect"
```

**Expected:** 200 response with `participant_token` and session info showing both `creator` and `juniors-claude` as participants.

---

### Test 3: Junior's Claude announces it is starting

The junior's Claude sends a status update so the senior knows work has begun.

```bash
# Junior sends status_update: starting
MSG1_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "status_update",
    "title": "Starting task",
    "content": "Beginning refactor of user-service. Will read existing code first, then restructure into repository pattern.\n\nPlan:\n1. Read current user-service implementation\n2. Identify data access scattered across service methods\n3. Extract into UserRepository class\n4. Update service to use repository\n5. Run existing tests",
    "tags": ["status", "planning"],
    "context": {
      "project": "backend-api",
      "stack": "Node.js, TypeScript, PostgreSQL",
      "branch": "feature/user-repo-pattern"
    }
  }')

echo "$MSG1_RESPONSE" | jq .

# Verify: message accepted with sequence 1
echo "$MSG1_RESPONSE" | jq -e '.sequence == 1' > /dev/null \
  && echo "PASS: First message has sequence 1" \
  || echo "FAIL: Unexpected sequence number"
```

**Expected:** 201 with `sequence: 1`. The dashboard (if open) shows the status update in real time via SSE.

---

### Test 4: Junior's Claude sends first file change (contains a bug)

The junior's Claude writes a UserRepository class but introduces an N+1 query problem -- it fetches related data inside a loop instead of using a join or eager loading.

```bash
# Junior sends file_change with buggy implementation
MSG2_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_change",
    "title": "Created UserRepository with findAll method",
    "content": "```typescript\n// src/repositories/user-repository.ts\nimport { db } from \"../db\";\nimport type { User, UserWithOrders } from \"../types\";\n\nexport class UserRepository {\n  async findAll(): Promise<UserWithOrders[]> {\n    const users = await db.query(\"SELECT * FROM users\");\n\n    // Fetch orders for each user\n    const results: UserWithOrders[] = [];\n    for (const user of users.rows) {\n      const orders = await db.query(\n        \"SELECT * FROM orders WHERE user_id = $1\",\n        [user.id]\n      );\n      results.push({ ...user, orders: orders.rows });\n    }\n\n    return results;\n  }\n\n  async findById(id: string): Promise<User | null> {\n    const result = await db.query(\n      \"SELECT * FROM users WHERE id = $1\",\n      [id]\n    );\n    return result.rows[0] || null;\n  }\n}\n```",
    "tags": ["repository", "user-service", "implementation"],
    "references": [
      {
        "file": "src/repositories/user-repository.ts",
        "lines": "1-30",
        "note": "New file: UserRepository class"
      }
    ],
    "context": {
      "project": "backend-api",
      "stack": "Node.js, TypeScript, PostgreSQL",
      "branch": "feature/user-repo-pattern"
    }
  }')

echo "$MSG2_RESPONSE" | jq .

# Verify: message accepted with sequence 2
echo "$MSG2_RESPONSE" | jq -e '.sequence == 2' > /dev/null \
  && echo "PASS: file_change accepted as sequence 2" \
  || echo "FAIL: Unexpected sequence number"
```

**Expected:** 201 with `sequence: 2`. The senior sees this on the dashboard and spots the N+1 query in the `findAll` method (lines 8-16: a `SELECT` inside a `for` loop).

---

### Test 5: Senior sends a Socratic question (course correction)

The senior sees the N+1 query and sends a `question` to prompt the junior's Claude to reconsider, rather than just giving the answer. This is the teaching moment.

```bash
# Senior sends a question to prompt reconsideration
MSG3_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "question",
    "title": "Performance concern in findAll",
    "content": "Look at your `findAll` method -- if there are 1,000 users in the database, how many SQL queries will this execute?\n\nHint: count the queries inside the loop vs. outside it. There is a well-known name for this anti-pattern.\n\nWhat would a single-query approach look like?",
    "tags": ["performance", "n+1", "teaching"],
    "references": [
      {
        "file": "src/repositories/user-repository.ts",
        "lines": "8-16",
        "note": "The for-loop with a query inside it"
      }
    ]
  }')

echo "$MSG3_RESPONSE" | jq .

# Verify: message from creator has sequence 3
echo "$MSG3_RESPONSE" | jq -e '.sequence == 3' > /dev/null \
  && echo "PASS: Senior question accepted as sequence 3" \
  || echo "FAIL: Unexpected sequence number"
```

**Expected:** 201 with `sequence: 3`. The junior's Claude receives this on its next poll and recognizes the N+1 issue.

---

### Test 6: Junior's Claude acknowledges and sends the fix

The junior's Claude responds with an `answer` acknowledging the problem, then sends a corrected `file_change` with a JOIN-based implementation.

```bash
# Junior acknowledges the issue
MSG4_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "answer",
    "title": "N+1 query identified -- fixing now",
    "content": "You are right -- that is the N+1 query problem. With 1,000 users, `findAll` would execute 1,001 queries (1 for users + 1 per user for orders). Rewriting to use a LEFT JOIN so it executes a single query regardless of user count.",
    "tags": ["acknowledgment", "n+1", "fix"]
  }')

echo "$MSG4_RESPONSE" | jq .

# Junior sends the corrected implementation
MSG5_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_change",
    "title": "Fixed findAll with JOIN query",
    "content": "```typescript\n// src/repositories/user-repository.ts (updated)\nimport { db } from \"../db\";\nimport type { User, UserWithOrders } from \"../types\";\n\nexport class UserRepository {\n  async findAll(): Promise<UserWithOrders[]> {\n    const result = await db.query(`\n      SELECT\n        u.*,\n        COALESCE(\n          json_agg(o.*) FILTER (WHERE o.id IS NOT NULL),\n          '\''[]'\\''::json\n        ) AS orders\n      FROM users u\n      LEFT JOIN orders o ON o.user_id = u.id\n      GROUP BY u.id\n      ORDER BY u.created_at DESC\n    `);\n\n    return result.rows;\n  }\n\n  async findById(id: string): Promise<User | null> {\n    const result = await db.query(\n      \"SELECT * FROM users WHERE id = $1\",\n      [id]\n    );\n    return result.rows[0] || null;\n  }\n}\n```\n\nChanges:\n- Replaced N+1 loop with single LEFT JOIN + json_agg\n- Added COALESCE for users with no orders (returns empty array)\n- Added FILTER (WHERE o.id IS NOT NULL) to avoid null entries\n- Added ORDER BY for consistent results",
    "tags": ["repository", "user-service", "fix", "performance"],
    "references": [
      {
        "file": "src/repositories/user-repository.ts",
        "lines": "1-30",
        "note": "Rewritten findAll with JOIN"
      }
    ],
    "context": {
      "project": "backend-api",
      "stack": "Node.js, TypeScript, PostgreSQL",
      "branch": "feature/user-repo-pattern"
    }
  }')

echo "$MSG5_RESPONSE" | jq .

# Verify: both messages accepted in order
echo "$MSG4_RESPONSE" | jq -e '.sequence == 4' > /dev/null \
  && echo "PASS: Acknowledgment is sequence 4" \
  || echo "FAIL: Unexpected sequence for acknowledgment"

echo "$MSG5_RESPONSE" | jq -e '.sequence == 5' > /dev/null \
  && echo "PASS: Fixed file_change is sequence 5" \
  || echo "FAIL: Unexpected sequence for fix"
```

**Expected:** Two 201 responses with `sequence: 4` (acknowledgment) and `sequence: 5` (fix). The dashboard now shows the corrected implementation.

---

### Test 7: Senior sends positive reinforcement and a forward-looking tip

Good teaching includes reinforcement. The senior confirms the fix is correct and adds a pattern tip for future reference.

```bash
# Senior sends positive feedback + tip
MSG6_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "context",
    "title": "Good fix -- pattern note for future",
    "content": "That is exactly right. The JOIN approach is O(1) queries instead of O(n). A few notes for next time:\n\n1. **Default to JOINs** when fetching related data. Only use separate queries when the result sets are large enough that a JOIN would cause memory issues (rare).\n\n2. **The COALESCE + FILTER pattern** you used is the idiomatic PostgreSQL way to handle LEFT JOINs with json_agg. Good instinct.\n\n3. **Consider adding an index** on `orders.user_id` if one does not already exist -- the JOIN will need it for performance at scale.\n\n4. **For the repository pattern**, also consider adding a `findAllWithOrders` method separate from `findAll`, so callers who only need users do not pay the JOIN cost.",
    "tags": ["feedback", "patterns", "postgresql", "teaching"]
  }')

echo "$MSG6_RESPONSE" | jq .

# Verify: sequence 6
echo "$MSG6_RESPONSE" | jq -e '.sequence == 6' > /dev/null \
  && echo "PASS: Feedback accepted as sequence 6" \
  || echo "FAIL: Unexpected sequence number"
```

**Expected:** 201 with `sequence: 6`. This message serves double duty: immediate feedback for the current session and a reference the junior can review later.

---

### Test 8: Junior's Claude sends completion status

The junior's Claude finishes the task and sends a final status update summarizing what was done.

```bash
# Junior sends status_update: complete
MSG7_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "status_update",
    "title": "Task complete",
    "content": "Refactor finished. Summary of changes:\n\n- Created `src/repositories/user-repository.ts` with `UserRepository` class\n- Moved all data access out of `user-service.ts` into repository methods\n- Fixed N+1 query in `findAll` (caught by senior review)\n- Updated `user-service.ts` to inject `UserRepository` via constructor\n- All 14 existing tests pass\n- Added 3 new tests for repository layer\n\nLessons learned:\n- Always prefer JOINs over loops with queries\n- Consider separate methods for with/without related data\n- Add indexes for JOIN columns",
    "tags": ["status", "complete", "summary"],
    "context": {
      "project": "backend-api",
      "stack": "Node.js, TypeScript, PostgreSQL",
      "branch": "feature/user-repo-pattern"
    }
  }')

echo "$MSG7_RESPONSE" | jq .

# Verify: sequence 7
echo "$MSG7_RESPONSE" | jq -e '.sequence == 7' > /dev/null \
  && echo "PASS: Completion status is sequence 7" \
  || echo "FAIL: Unexpected sequence number"
```

**Expected:** 201 with `sequence: 7`. The session now contains a complete teaching narrative.

---

### Test 9: Poll full history -- verify the teaching conversation flow

Retrieve the entire message history and verify the teaching arc is intact: plan, attempt, correction, fix, feedback, completion.

```bash
# Poll all messages from the beginning (since=0, limit=50)
HISTORY=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}")

echo "$HISTORY" | jq .

# Verify: exactly 7 messages
MSG_COUNT=$(echo "$HISTORY" | jq '.messages | length')
echo "Message count: $MSG_COUNT"
[ "$MSG_COUNT" -eq 7 ] \
  && echo "PASS: All 7 messages present" \
  || echo "FAIL: Expected 7 messages, got $MSG_COUNT"

# Verify: no more messages beyond what we have
echo "$HISTORY" | jq -e '.has_more == false' > /dev/null \
  && echo "PASS: No additional messages pending" \
  || echo "FAIL: has_more should be false"

# Verify: cursor points to last message
echo "$HISTORY" | jq -e '.cursor == 7' > /dev/null \
  && echo "PASS: Cursor is at sequence 7" \
  || echo "FAIL: Cursor mismatch"

# Verify: message types follow the teaching arc
TYPES=$(echo "$HISTORY" | jq -r '[.messages[].type] | join(",")')
EXPECTED="status_update,file_change,question,answer,file_change,context,status_update"
echo "Message types: $TYPES"
[ "$TYPES" = "$EXPECTED" ] \
  && echo "PASS: Message types match teaching arc" \
  || echo "FAIL: Expected [$EXPECTED], got [$TYPES]"

# Verify: sender alternation (junior, junior, senior, junior, junior, senior, junior)
SENDERS=$(echo "$HISTORY" | jq -r '[.messages[].sender_name] | join(",")')
EXPECTED_SENDERS="juniors-claude,juniors-claude,creator,juniors-claude,juniors-claude,creator,juniors-claude"
echo "Senders: $SENDERS"
[ "$SENDERS" = "$EXPECTED_SENDERS" ] \
  && echo "PASS: Sender attribution correct" \
  || echo "FAIL: Expected [$EXPECTED_SENDERS], got [$SENDERS]"
```

**Expected:** 7 messages in exact order with correct types, correct sender attribution, `cursor: 7`, and `has_more: false`. The teaching arc is: plan -> attempt -> question -> acknowledgment -> fix -> feedback -> completion.

---

### Test 10: Verify message ordering and replay capability

Confirm that paginated polling returns messages in the correct order and that the cursor mechanism supports incremental replay (as a junior developer might do when reviewing the session later).

```bash
# Simulate incremental replay: fetch messages 2 at a time
echo "=== Replay pass 1: messages 1-2 ==="
PAGE1=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=2" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}")
echo "$PAGE1" | jq '{cursor, has_more, types: [.messages[].type]}'
CURSOR1=$(echo "$PAGE1" | jq -r '.cursor')

echo "$PAGE1" | jq -e '.has_more == true' > /dev/null \
  && echo "PASS: has_more is true (more messages exist)" \
  || echo "FAIL: has_more should be true"

echo "=== Replay pass 2: messages 3-4 ==="
PAGE2=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=${CURSOR1}&limit=2" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}")
echo "$PAGE2" | jq '{cursor, has_more, types: [.messages[].type]}'
CURSOR2=$(echo "$PAGE2" | jq -r '.cursor')

echo "$PAGE2" | jq -e '.has_more == true' > /dev/null \
  && echo "PASS: has_more is true (more messages exist)" \
  || echo "FAIL: has_more should be true"

echo "=== Replay pass 3: messages 5-6 ==="
PAGE3=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=${CURSOR2}&limit=2" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}")
echo "$PAGE3" | jq '{cursor, has_more, types: [.messages[].type]}'
CURSOR3=$(echo "$PAGE3" | jq -r '.cursor')

echo "$PAGE3" | jq -e '.has_more == true' > /dev/null \
  && echo "PASS: has_more is true (one more message)" \
  || echo "FAIL: has_more should be true"

echo "=== Replay pass 4: message 7 (final) ==="
PAGE4=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=${CURSOR3}&limit=2" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}")
echo "$PAGE4" | jq '{cursor, has_more, types: [.messages[].type]}'

echo "$PAGE4" | jq -e '.has_more == false' > /dev/null \
  && echo "PASS: has_more is false (end of history)" \
  || echo "FAIL: has_more should be false"

echo "$PAGE4" | jq -e '.messages | length == 1' > /dev/null \
  && echo "PASS: Final page has exactly 1 message" \
  || echo "FAIL: Expected 1 message on final page"

# Verify: concatenating all pages reconstructs full sequence
ALL_SEQS=$(echo "$PAGE1 $PAGE2 $PAGE3 $PAGE4" | jq -s '[.[].messages[].sequence] | join(",")')
echo "All sequences across pages: $ALL_SEQS"
[ "$ALL_SEQS" = "1,2,3,4,5,6,7" ] \
  && echo "PASS: Paginated replay reconstructs complete ordered history" \
  || echo "FAIL: Sequence mismatch across pages"
```

**Expected:** Four pages of results (2, 2, 2, 1 messages), each with correct `has_more` flags. Concatenating sequences across all pages yields `1,2,3,4,5,6,7` -- a complete, ordered replay of the teaching session.

---

## Full End-to-End Script

To run all tests as a single script:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:4190"

echo "================================================"
echo "Scenario 07: Teaching/Pairing — End-to-End Test"
echo "================================================"
echo ""

# Verify server is running
echo "--- Checking server health ---"
curl -sf "$BASE/health" > /dev/null || { echo "FAIL: Server not running at $BASE"; exit 1; }
echo "Server is up."
echo ""

# Test 1: Create session
echo "--- Test 1: Senior creates session ---"
RESPONSE=$(curl -s -X POST "$BASE/sessions" \
  -H "Content-Type: application/json" \
  -d '{"name": "Teaching: Refactor user-service to repository pattern", "ttl_minutes": 120}')
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
SENIOR_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')
echo "Session: $SESSION_ID"
echo ""

# Test 2: Junior joins
echo "--- Test 2: Junior's Claude joins ---"
JOIN_RESPONSE=$(curl -s -X POST "$BASE/sessions/${SESSION_ID}/join" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"participant_name": "juniors-claude"}')
JUNIOR_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
echo "Junior joined with token: ${JUNIOR_TOKEN:0:8}..."
echo ""

# Test 3: Junior starts
echo "--- Test 3: Junior sends status_update (starting) ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"status_update","title":"Starting task","content":"Beginning refactor of user-service into repository pattern.","tags":["status","planning"],"context":{"project":"backend-api","branch":"feature/user-repo-pattern"}}' | jq '{sequence, message_id}'
echo ""

# Test 4: Junior sends buggy code
echo "--- Test 4: Junior sends file_change (buggy N+1 query) ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_change","title":"Created UserRepository with findAll","content":"```typescript\nexport class UserRepository {\n  async findAll() {\n    const users = await db.query(\"SELECT * FROM users\");\n    for (const user of users.rows) {\n      const orders = await db.query(\"SELECT * FROM orders WHERE user_id = $1\", [user.id]);\n      user.orders = orders.rows;\n    }\n    return users.rows;\n  }\n}\n```","tags":["repository","implementation"],"references":[{"file":"src/repositories/user-repository.ts","lines":"1-12","note":"New UserRepository"}]}' | jq '{sequence, message_id}'
echo ""

# Test 5: Senior questions approach
echo "--- Test 5: Senior sends question (Socratic) ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"question","title":"Performance concern in findAll","content":"If there are 1,000 users, how many SQL queries will findAll execute? What is the name of this anti-pattern?","tags":["performance","n+1","teaching"],"references":[{"file":"src/repositories/user-repository.ts","lines":"4-8","note":"Query inside loop"}]}' | jq '{sequence, message_id}'
echo ""

# Test 6a: Junior acknowledges
echo "--- Test 6a: Junior acknowledges N+1 issue ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"answer","title":"N+1 query identified","content":"That is the N+1 query problem. 1,001 queries for 1,000 users. Rewriting with a JOIN.","tags":["acknowledgment","fix"]}' | jq '{sequence, message_id}'
echo ""

# Test 6b: Junior sends fix
echo "--- Test 6b: Junior sends corrected file_change ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_change","title":"Fixed findAll with LEFT JOIN","content":"```typescript\nexport class UserRepository {\n  async findAll() {\n    const result = await db.query(`\n      SELECT u.*, COALESCE(json_agg(o.*) FILTER (WHERE o.id IS NOT NULL), '"'"'[]'"'"'::json) AS orders\n      FROM users u LEFT JOIN orders o ON o.user_id = u.id\n      GROUP BY u.id ORDER BY u.created_at DESC\n    `);\n    return result.rows;\n  }\n}\n```","tags":["repository","fix","performance"],"references":[{"file":"src/repositories/user-repository.ts","lines":"1-12","note":"Rewritten with JOIN"}]}' | jq '{sequence, message_id}'
echo ""

# Test 7: Senior positive feedback
echo "--- Test 7: Senior sends positive reinforcement ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"context","title":"Good fix -- pattern notes","content":"Correct. JOINs over loops. Consider adding an index on orders.user_id and a separate findAllWithOrders method.","tags":["feedback","patterns","teaching"]}' | jq '{sequence, message_id}'
echo ""

# Test 8: Junior completes
echo "--- Test 8: Junior sends completion status ---"
curl -s -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${JUNIOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"status_update","title":"Task complete","content":"Refactor done. 14 existing tests pass, 3 new repository tests added. N+1 fixed per senior feedback.","tags":["status","complete"]}' | jq '{sequence, message_id}'
echo ""

# Test 9: Poll full history
echo "--- Test 9: Full history poll ---"
HISTORY=$(curl -s "$BASE/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${SENIOR_TOKEN}")

MSG_COUNT=$(echo "$HISTORY" | jq '.messages | length')
TYPES=$(echo "$HISTORY" | jq -r '[.messages[].type] | join(",")')
SENDERS=$(echo "$HISTORY" | jq -r '[.messages[].sender_name] | join(",")')

echo "Messages: $MSG_COUNT"
echo "Types:    $TYPES"
echo "Senders:  $SENDERS"
echo "Cursor:   $(echo "$HISTORY" | jq '.cursor')"
echo "Has more: $(echo "$HISTORY" | jq '.has_more')"

[ "$MSG_COUNT" -eq 7 ] && echo "PASS: message count" || echo "FAIL: message count"
[ "$TYPES" = "status_update,file_change,question,answer,file_change,context,status_update" ] \
  && echo "PASS: message types" || echo "FAIL: message types"
[ "$SENDERS" = "juniors-claude,juniors-claude,creator,juniors-claude,juniors-claude,creator,juniors-claude" ] \
  && echo "PASS: sender attribution" || echo "FAIL: sender attribution"
echo ""

# Test 10: Paginated replay
echo "--- Test 10: Paginated replay (2 at a time) ---"
CURSOR=0
PAGE=0
ALL_SEQS=""
while true; do
  PAGE=$((PAGE + 1))
  RESULT=$(curl -s "$BASE/relay/${SESSION_ID}?since=${CURSOR}&limit=2" \
    -H "Authorization: Bearer ${SENIOR_TOKEN}")
  COUNT=$(echo "$RESULT" | jq '.messages | length')
  CURSOR=$(echo "$RESULT" | jq '.cursor')
  HAS_MORE=$(echo "$RESULT" | jq '.has_more')
  SEQS=$(echo "$RESULT" | jq -r '[.messages[].sequence] | join(",")')
  [ -n "$ALL_SEQS" ] && ALL_SEQS="${ALL_SEQS},${SEQS}" || ALL_SEQS="$SEQS"
  echo "  Page $PAGE: $COUNT msgs, cursor=$CURSOR, has_more=$HAS_MORE, seqs=[$SEQS]"
  [ "$HAS_MORE" = "false" ] && break
done

echo "All sequences: [$ALL_SEQS]"
[ "$ALL_SEQS" = "1,2,3,4,5,6,7" ] \
  && echo "PASS: paginated replay complete and ordered" \
  || echo "FAIL: sequence mismatch"

echo ""
echo "================================================"
echo "Scenario 07 complete."
echo "================================================"
```

---

## Key Observations for This Scenario

1. **Intervention density matters.** The senior sent only 2 messages out of 7 (28% of traffic). In a real teaching session, this ratio might be even lower -- the senior watches 10 file changes and only intervenes on 1. The relay handles this asymmetry naturally since both parties use the same API.

2. **Message types encode pedagogical intent.** Using `question` vs `answer` vs `context` is not just metadata -- it tells the junior's Claude (and the junior reviewing later) whether the senior was prompting thought, correcting an error, or providing background knowledge.

3. **The `references` field is the teaching pointer.** When the senior sends a question with `references: [{ file: "...", lines: "8-16" }]`, they are pointing directly at the problem. This is the digital equivalent of pointing at a line on a shared screen.

4. **Session history is a reusable artifact.** Unlike a Zoom call or a Slack thread, the relay session preserves structured, typed, sequenced messages. A junior developer can replay the session later, see exactly where their Claude went wrong, read the senior's reasoning, and internalize the pattern.

5. **SSE vs polling tradeoff.** The senior uses SSE (dashboard) for real-time observation. The junior's Claude uses polling (MCP `relay_poll` tool) to check for new messages. This asymmetry is intentional -- the observer needs instant updates, the worker checks periodically between tasks.

6. **Rate limiting is not a concern.** At 600 requests/minute per token, a teaching session with its low message volume will never hit limits. Even aggressive polling every 2 seconds (30 req/min) is well within budget.
