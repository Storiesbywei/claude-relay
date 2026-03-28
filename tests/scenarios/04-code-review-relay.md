# Scenario 04: Code Review Relay

**Analyzer Claude sends findings, Implementer Claude acts on them.**

Two specialized agents collaborate through the relay: a Reviewer agent that analyzes a codebase and distills findings, and an Implementer agent that receives those findings and applies fixes. Neither agent needs the other's full context window -- the relay is the narrow bridge between them.

---

## Technical Analysis

### What This Scenario Tests

This scenario validates **asymmetric context transfer between specialized agents**. The Reviewer agent loads a large codebase into its context window, performs static analysis, identifies patterns, and distills its findings into focused relay messages. The Implementer agent operates in a separate context window with its own copy of the codebase loaded for editing. It receives the Reviewer's distilled findings and applies targeted fixes.

The key behaviors under test:

1. **Multi-message review delivery** -- the Reviewer sends findings across multiple message types (`patterns`, `conventions`, `insight`) in sequence, and the Implementer receives them in the correct order.
2. **Bidirectional confirmation** -- after the Implementer applies fixes, it sends `file_change` and `answer` messages back so the Reviewer can verify the remediation.
3. **File references** -- each message carries structured `references` pointing to specific files and line ranges, allowing the receiving agent to locate relevant code without searching.
4. **Context metadata** -- project name, stack, and branch travel with every message so neither agent needs to ask "what project is this?"
5. **Cursor-based polling** -- the Implementer polls with `since=0` to get all findings, then uses the returned cursor for subsequent polls to avoid re-processing.

### Why Relay > Shared Context Window

In a shared context window, both agents would need the full codebase loaded simultaneously. For a non-trivial project this can easily exceed 100K tokens for the codebase alone, leaving little room for reasoning. The relay architecture offers concrete advantages:

- **Context specialization** -- the Reviewer loads source files + linting rules + style guides and reasons deeply about patterns. The Implementer loads source files + test suites + build config and reasons deeply about safe edits. Each agent uses its full context budget for its specialty.
- **Context compression** -- the Reviewer might analyze 100K tokens of source code but distills its findings into 3-5 relay messages totaling under 10K tokens. The relay acts as an information bottleneck that forces structured, actionable output.
- **Temporal decoupling** -- the Reviewer can finish its analysis and disconnect. The Implementer polls later, works at its own pace, and posts results. They do not need overlapping lifetimes.
- **Audit trail** -- every finding and every fix is a discrete message with a sequence number, timestamp, and sender identity. This is superior to interleaved conversation turns for post-hoc review.

### Message Type Mapping

| Agent | Message Types Used | Purpose |
|-------|-------------------|---------|
| Reviewer | `patterns` | Code patterns found (anti-patterns, repeated structures, refactoring opportunities) |
| Reviewer | `conventions` | Naming conventions, code style, project-specific rules |
| Reviewer | `insight` | Specific bugs, security issues, performance problems |
| Implementer | `file_change` | Diff or description of the fix applied |
| Implementer | `answer` | Confirmation that a specific finding has been addressed |
| Implementer | `status_update` | Progress updates (e.g., "applying fixes to auth module") |

This mapping is a convention, not enforced by the server. Both agents can send any of the 14 message types. The discipline comes from the prompt instructions given to each agent.

### Context Compression

A realistic code review generates far more internal reasoning than should be transmitted. The relay's 100KB per-message limit (`MAX_MESSAGE_SIZE: 102,400`) and 200 messages per session (`MAX_MESSAGES_PER_SESSION: 200`) create natural pressure to compress:

| Reviewer's Context | Relay Message | Implementer's Context |
|--------------------|--------------|-----------------------|
| 50 files analyzed (80K tokens) | 1 `patterns` message (~2K) listing 5 anti-patterns with file refs | Loads only the 5 referenced files |
| Style guide + 200 violations found | 1 `conventions` message (~1.5K) with top 10 violations | Applies fixes to 10 locations |
| Deep analysis of auth flow (15K tokens of reasoning) | 1 `insight` message (~1K) describing the SQL injection vector | Loads `auth.ts` lines 42-67, applies parameterized query |

The relay is not a pipe for raw context -- it is a **compression layer** that forces the Reviewer to produce structured, actionable findings.

### Chunking Large Reviews

If a single review finding exceeds 100KB (unlikely but possible for large diffs), the sender must chunk it:

1. Split content at logical boundaries (per-file, per-function).
2. Use a consistent `title` prefix with part numbers: `"SQL injection audit (1/3)"`.
3. Use the same `tags` array across chunks so the receiver can filter and reassemble.
4. The relay guarantees monotonically increasing `sequence` numbers (assigned server-side in `addMessage`), so chunks arrive in send order.

### Ordering Guarantees

The relay server assigns sequence numbers atomically in `addMessage()`:

```typescript
session.sequenceCounter++;
message.sequence = session.sequenceCounter;
```

This is single-threaded (Bun's event loop), so sequence numbers are strictly monotonic. The `getMessages` endpoint filters by `sequence > since` and returns messages in insertion order. For a code review workflow, this means:

- If the Reviewer sends `patterns` then `conventions` then `insight`, the Implementer always receives them in that order.
- The cursor returned from polling can be used as `since` for the next poll to get only new messages.
- `has_more: true` in the poll response indicates additional messages beyond the `limit` (default 10, max 50).

---

## Test Cases

All tests run against `http://localhost:4190`. The server must be running (`bun run dev:server` or `docker compose up -d`).

### Prerequisites

```bash
# Verify server is running
curl -s http://localhost:4190/health | jq .
```

---

### Test 1: Create Session, Both Agents Join

Creates a code review session. The creator token represents the Reviewer (analyzer). The Implementer joins via invite token.

```bash
# Create the review session
RESPONSE=$(curl -s -X POST http://localhost:4190/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "Code Review: auth module refactor", "ttl_minutes": 60}')

echo "$RESPONSE" | jq .

# Extract tokens
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
REVIEWER_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')

echo "SESSION_ID=$SESSION_ID"
echo "REVIEWER_TOKEN=$REVIEWER_TOKEN"
echo "INVITE_TOKEN=$INVITE_TOKEN"

# Implementer joins
JOIN_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{"participant_name": "implementer-claude"}')

echo "$JOIN_RESPONSE" | jq .

IMPLEMENTER_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
echo "IMPLEMENTER_TOKEN=$IMPLEMENTER_TOKEN"

# Verify session shows both participants
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" | jq .
```

**Expected:** Session created with 201. Join returns `participant_token`. Session info shows participants `["creator", "implementer-claude"]`.

---

### Test 2: Reviewer Sends `patterns` Message (Code Patterns Found)

The Reviewer has analyzed the codebase and found recurring anti-patterns.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" \
  -d '{
    "type": "patterns",
    "title": "Anti-patterns in authentication module",
    "content": "## Findings\n\n### 1. Raw SQL concatenation\nFound in 3 locations. User input is interpolated directly into SQL strings without parameterization.\n\n```typescript\nconst query = `SELECT * FROM users WHERE email = '\''${email}'\''`;\n```\n\n### 2. Synchronous password hashing\n`bcrypt.hashSync()` used instead of async `bcrypt.hash()`. Blocks the event loop during registration.\n\n### 3. Missing rate limiting on login endpoint\n`POST /auth/login` has no rate limiter — vulnerable to brute force.",
    "tags": ["security", "performance", "auth"],
    "references": [
      {"file": "src/auth/queries.ts", "lines": "15-22", "note": "Raw SQL concatenation"},
      {"file": "src/auth/queries.ts", "lines": "45-48", "note": "Second raw SQL instance"},
      {"file": "src/auth/register.ts", "lines": "31", "note": "Synchronous bcrypt.hashSync"},
      {"file": "src/auth/login.ts", "note": "No rate limiting middleware"}
    ],
    "context": {
      "project": "acme-api",
      "stack": "Node.js, Express, PostgreSQL",
      "branch": "feature/auth-refactor"
    }
  }' | jq .
```

**Expected:** 201 response with `message_id`, `sequence: 1`, and `received_at` timestamp.

---

### Test 3: Reviewer Sends `conventions` Message (Naming & Style)

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" \
  -d '{
    "type": "conventions",
    "title": "Naming and style conventions to adopt",
    "content": "## Conventions\n\n### Error handling\nThe codebase mixes `throw new Error()` with returning `{error: string}` objects. **Adopt:** throw errors, catch in middleware.\n\n### Async/await\nSome files use `.then()` chains, others use `async/await`. **Adopt:** `async/await` everywhere.\n\n### Naming\n- Database query functions: `findUserByEmail` not `getUserEmail`\n- Middleware: `requireAuth` not `checkAuth`\n- Constants: `MAX_LOGIN_ATTEMPTS` not `maxAttempts`",
    "tags": ["conventions", "style", "consistency"],
    "references": [
      {"file": "src/auth/login.ts", "lines": "10-25", "note": "Mixed error handling styles"},
      {"file": "src/auth/queries.ts", "lines": "1-60", "note": "Inconsistent async patterns"}
    ],
    "context": {
      "project": "acme-api",
      "stack": "Node.js, Express, PostgreSQL",
      "branch": "feature/auth-refactor"
    }
  }' | jq .
```

**Expected:** 201 response with `sequence: 2`.

---

### Test 4: Reviewer Sends `insight` Message (Potential Bug)

A critical finding -- a specific, exploitable bug.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" \
  -d '{
    "type": "insight",
    "title": "CRITICAL: SQL injection in password reset flow",
    "content": "## Bug Report\n\n**Severity:** Critical\n**Type:** SQL Injection\n\nThe `resetPassword` function in `src/auth/reset.ts` line 42 builds a query using string interpolation with the `token` parameter from the request body:\n\n```typescript\nconst result = await db.query(\n  `UPDATE users SET password = '\''${hashedPassword}'\'' WHERE reset_token = '\''${token}'\''`\n);\n```\n\nAn attacker can craft a `token` value like `'\'' OR 1=1; UPDATE users SET password='\''hacked'\'' WHERE email='\''admin@acme.com'\'' --` to overwrite any user password.\n\n**Fix:** Use parameterized queries:\n```typescript\nconst result = await db.query(\n  \"UPDATE users SET password = $1 WHERE reset_token = $2\",\n  [hashedPassword, token]\n);\n```",
    "tags": ["security", "critical", "sql-injection"],
    "references": [
      {"file": "src/auth/reset.ts", "lines": "38-50", "note": "SQL injection in resetPassword"}
    ],
    "context": {
      "project": "acme-api",
      "stack": "Node.js, Express, PostgreSQL",
      "branch": "feature/auth-refactor"
    }
  }' | jq .
```

**Expected:** 201 response with `sequence: 3`.

---

### Test 5: Implementer Polls and Receives All Findings

The Implementer polls from the beginning (`since=0`) to get all review findings.

```bash
# Poll all messages (limit high enough to get everything)
POLL_RESPONSE=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=10" \
  -H "Authorization: Bearer ${IMPLEMENTER_TOKEN}")

echo "$POLL_RESPONSE" | jq .

# Verify message count
echo "Message count: $(echo "$POLL_RESPONSE" | jq '.messages | length')"

# Verify ordering: sequence numbers should be 1, 2, 3
echo "Sequences: $(echo "$POLL_RESPONSE" | jq '[.messages[].sequence]')"

# Verify types match what was sent
echo "Types: $(echo "$POLL_RESPONSE" | jq '[.messages[].type]')"

# Save cursor for next poll
CURSOR=$(echo "$POLL_RESPONSE" | jq '.cursor')
echo "Cursor for next poll: $CURSOR"

# Verify has_more is false (only 3 messages, limit was 10)
echo "Has more: $(echo "$POLL_RESPONSE" | jq '.has_more')"
```

**Expected:**
- 3 messages returned
- Sequences: `[1, 2, 3]`
- Types: `["patterns", "conventions", "insight"]`
- `cursor: 3`
- `has_more: false`
- Each message includes `sender_name: "creator"` (the Reviewer)

---

### Test 6: Implementer Sends `file_change` (Fix Applied)

The Implementer has applied the SQL injection fix from the critical insight.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${IMPLEMENTER_TOKEN}" \
  -d '{
    "type": "file_change",
    "title": "Fix: parameterized queries in reset.ts",
    "content": "## Changes Applied\n\n**File:** `src/auth/reset.ts`\n\nReplaced raw SQL interpolation with parameterized queries in `resetPassword`.\n\n```diff\n- const result = await db.query(\n-   `UPDATE users SET password = '\''${hashedPassword}'\'' WHERE reset_token = '\''${token}'\''`\n- );\n+ const result = await db.query(\n+   \"UPDATE users SET password = $1 WHERE reset_token = $2\",\n+   [hashedPassword, token]\n+ );\n```\n\nAlso applied the same fix to `findByResetToken` (line 28) and `invalidateToken` (line 55).",
    "tags": ["fix", "security", "sql-injection"],
    "references": [
      {"file": "src/auth/reset.ts", "lines": "28", "note": "Parameterized findByResetToken"},
      {"file": "src/auth/reset.ts", "lines": "42-46", "note": "Parameterized resetPassword"},
      {"file": "src/auth/reset.ts", "lines": "55", "note": "Parameterized invalidateToken"}
    ],
    "context": {
      "project": "acme-api",
      "stack": "Node.js, Express, PostgreSQL",
      "branch": "feature/auth-refactor"
    }
  }' | jq .
```

**Expected:** 201 response with `sequence: 4`, `sender_name: "implementer-claude"`.

---

### Test 7: Implementer Sends `answer` (Confirming Fix Addresses Insight)

The Implementer confirms the critical finding has been fully addressed.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${IMPLEMENTER_TOKEN}" \
  -d '{
    "type": "answer",
    "title": "RE: CRITICAL SQL injection in password reset flow",
    "content": "## Resolution\n\nAll 3 SQL injection vectors in `src/auth/reset.ts` have been fixed with parameterized queries.\n\nAdditionally applied the same fix to `src/auth/queries.ts` (the 2 instances from the patterns finding).\n\n**Total changes:**\n- `src/auth/reset.ts`: 3 queries parameterized\n- `src/auth/queries.ts`: 2 queries parameterized\n- `src/auth/register.ts`: replaced `bcrypt.hashSync()` with `await bcrypt.hash()`\n\n**Not yet addressed:**\n- Rate limiting on login endpoint (needs decision on middleware choice: express-rate-limit vs custom)\n- Naming convention migration (lower priority, will do in follow-up PR)",
    "tags": ["resolution", "security", "status"],
    "references": [
      {"file": "src/auth/reset.ts", "note": "3 queries fixed"},
      {"file": "src/auth/queries.ts", "note": "2 queries fixed"},
      {"file": "src/auth/register.ts", "lines": "31", "note": "Async bcrypt.hash"}
    ],
    "context": {
      "project": "acme-api",
      "stack": "Node.js, Express, PostgreSQL",
      "branch": "feature/auth-refactor"
    }
  }' | jq .
```

**Expected:** 201 response with `sequence: 5`.

---

### Test 8: Reviewer Polls to Verify the Fix

The Reviewer polls using the cursor from where it left off (after sending its own messages, it knows the last sequence was 3).

```bash
# Reviewer polls from cursor 3 to see only the Implementer's responses
VERIFY_RESPONSE=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=3&limit=10" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}")

echo "$VERIFY_RESPONSE" | jq .

# Should see exactly 2 new messages from the implementer
echo "New message count: $(echo "$VERIFY_RESPONSE" | jq '.messages | length')"
echo "Sequences: $(echo "$VERIFY_RESPONSE" | jq '[.messages[].sequence]')"
echo "Types: $(echo "$VERIFY_RESPONSE" | jq '[.messages[].type]')"
echo "Senders: $(echo "$VERIFY_RESPONSE" | jq '[.messages[].sender_name]')"
```

**Expected:**
- 2 messages returned (sequences 4 and 5)
- Types: `["file_change", "answer"]`
- Both have `sender_name: "implementer-claude"`
- `cursor: 5`, `has_more: false`

---

### Test 9: Message Ordering Validation

Verify that the full message history has strictly monotonic sequence numbers matching send order.

```bash
# Fetch all messages from the beginning
ALL_MESSAGES=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}")

# Validate sequence numbers are 1,2,3,4,5
echo "All sequences: $(echo "$ALL_MESSAGES" | jq '[.messages[].sequence]')"

# Validate the full conversation flow
echo "--- Full conversation flow ---"
echo "$ALL_MESSAGES" | jq -r '.messages[] | "[\(.sequence)] \(.sender_name) → \(.type): \(.title)"'

# Verify cursor equals last sequence
echo "Final cursor: $(echo "$ALL_MESSAGES" | jq '.cursor')"

# Verify total message count via session info
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" | jq '{message_count, participants}'
```

**Expected output:**
```
All sequences: [1,2,3,4,5]
--- Full conversation flow ---
[1] creator -> patterns: Anti-patterns in authentication module
[2] creator -> conventions: Naming and style conventions to adopt
[3] creator -> insight: CRITICAL: SQL injection in password reset flow
[4] implementer-claude -> file_change: Fix: parameterized queries in reset.ts
[5] implementer-claude -> answer: RE: CRITICAL SQL injection in password reset flow
Final cursor: 5
{"message_count": 5, "participants": ["creator", "implementer-claude"]}
```

---

## Full Runnable Script

Copy-paste this entire block to run all tests sequentially:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:4190"

echo "=== Test 0: Health check ==="
curl -sf "$BASE/health" | jq . || { echo "FAIL: Server not running on $BASE"; exit 1; }

echo ""
echo "=== Test 1: Create session + join ==="
RESPONSE=$(curl -sf -X POST "$BASE/sessions" \
  -H "Content-Type: application/json" \
  -d '{"name": "Code Review: auth module refactor", "ttl_minutes": 60}')

SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
REVIEWER_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')
echo "Session: $SESSION_ID"

JOIN_RESPONSE=$(curl -sf -X POST "$BASE/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{"participant_name": "implementer-claude"}')

IMPLEMENTER_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
echo "Implementer joined. Participants: $(echo "$JOIN_RESPONSE" | jq -r '.session.participants')"

echo ""
echo "=== Test 2: Reviewer sends patterns ==="
SEQ1=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" \
  -d '{
    "type": "patterns",
    "title": "Anti-patterns in authentication module",
    "content": "Found 3 anti-patterns: raw SQL concatenation, synchronous bcrypt, missing rate limiting.",
    "tags": ["security", "performance", "auth"],
    "references": [{"file": "src/auth/queries.ts", "lines": "15-22", "note": "Raw SQL"}],
    "context": {"project": "acme-api", "stack": "Node.js, Express, PostgreSQL", "branch": "feature/auth-refactor"}
  }' | jq -r '.sequence')
echo "Sent patterns, sequence=$SEQ1"

echo ""
echo "=== Test 3: Reviewer sends conventions ==="
SEQ2=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" \
  -d '{
    "type": "conventions",
    "title": "Naming and style conventions to adopt",
    "content": "Adopt: throw errors (not return objects), async/await everywhere, descriptive function names.",
    "tags": ["conventions", "style"],
    "references": [{"file": "src/auth/login.ts", "lines": "10-25", "note": "Mixed error handling"}],
    "context": {"project": "acme-api", "stack": "Node.js, Express, PostgreSQL", "branch": "feature/auth-refactor"}
  }' | jq -r '.sequence')
echo "Sent conventions, sequence=$SEQ2"

echo ""
echo "=== Test 4: Reviewer sends insight (critical bug) ==="
SEQ3=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" \
  -d '{
    "type": "insight",
    "title": "CRITICAL: SQL injection in password reset flow",
    "content": "src/auth/reset.ts line 42 uses string interpolation for SQL. Fix: use parameterized queries ($1, $2).",
    "tags": ["security", "critical", "sql-injection"],
    "references": [{"file": "src/auth/reset.ts", "lines": "38-50", "note": "SQL injection"}],
    "context": {"project": "acme-api", "stack": "Node.js, Express, PostgreSQL", "branch": "feature/auth-refactor"}
  }' | jq -r '.sequence')
echo "Sent insight, sequence=$SEQ3"

echo ""
echo "=== Test 5: Implementer polls all findings ==="
POLL=$(curl -sf "$BASE/relay/${SESSION_ID}?since=0&limit=10" \
  -H "Authorization: Bearer ${IMPLEMENTER_TOKEN}")
MSG_COUNT=$(echo "$POLL" | jq '.messages | length')
SEQUENCES=$(echo "$POLL" | jq -c '[.messages[].sequence]')
TYPES=$(echo "$POLL" | jq -c '[.messages[].type]')
CURSOR=$(echo "$POLL" | jq '.cursor')
echo "Received $MSG_COUNT messages, sequences=$SEQUENCES, types=$TYPES, cursor=$CURSOR"
[[ "$SEQUENCES" == "[1,2,3]" ]] && echo "PASS: Ordering correct" || echo "FAIL: Unexpected order"

echo ""
echo "=== Test 6: Implementer sends file_change ==="
SEQ4=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${IMPLEMENTER_TOKEN}" \
  -d '{
    "type": "file_change",
    "title": "Fix: parameterized queries in reset.ts",
    "content": "Replaced raw SQL with parameterized queries in resetPassword, findByResetToken, invalidateToken.",
    "tags": ["fix", "security", "sql-injection"],
    "references": [{"file": "src/auth/reset.ts", "lines": "42-46", "note": "Parameterized query"}],
    "context": {"project": "acme-api", "stack": "Node.js, Express, PostgreSQL", "branch": "feature/auth-refactor"}
  }' | jq -r '.sequence')
echo "Sent file_change, sequence=$SEQ4"

echo ""
echo "=== Test 7: Implementer sends answer (fix confirmation) ==="
SEQ5=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${IMPLEMENTER_TOKEN}" \
  -d '{
    "type": "answer",
    "title": "RE: CRITICAL SQL injection in password reset flow",
    "content": "All 5 SQL injection vectors fixed. Also replaced bcrypt.hashSync with async bcrypt.hash. Rate limiting not yet addressed.",
    "tags": ["resolution", "security"],
    "references": [{"file": "src/auth/reset.ts", "note": "3 queries fixed"}, {"file": "src/auth/queries.ts", "note": "2 queries fixed"}],
    "context": {"project": "acme-api", "stack": "Node.js, Express, PostgreSQL", "branch": "feature/auth-refactor"}
  }' | jq -r '.sequence')
echo "Sent answer, sequence=$SEQ5"

echo ""
echo "=== Test 8: Reviewer polls for implementer responses ==="
VERIFY=$(curl -sf "$BASE/relay/${SESSION_ID}?since=3&limit=10" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}")
NEW_COUNT=$(echo "$VERIFY" | jq '.messages | length')
NEW_TYPES=$(echo "$VERIFY" | jq -c '[.messages[].type]')
NEW_SENDERS=$(echo "$VERIFY" | jq -c '[.messages[].sender_name]')
echo "Received $NEW_COUNT new messages, types=$NEW_TYPES, senders=$NEW_SENDERS"
[[ "$NEW_TYPES" == '["file_change","answer"]' ]] && echo "PASS: Correct response types" || echo "FAIL: Unexpected types"
[[ "$NEW_SENDERS" == '["implementer-claude","implementer-claude"]' ]] && echo "PASS: Correct senders" || echo "FAIL: Unexpected senders"

echo ""
echo "=== Test 9: Full ordering validation ==="
ALL=$(curl -sf "$BASE/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}")
ALL_SEQ=$(echo "$ALL" | jq -c '[.messages[].sequence]')
echo "All sequences: $ALL_SEQ"
[[ "$ALL_SEQ" == "[1,2,3,4,5]" ]] && echo "PASS: Monotonic ordering" || echo "FAIL: Ordering broken"
echo ""
echo "Conversation flow:"
echo "$ALL" | jq -r '.messages[] | "  [\(.sequence)] \(.sender_name) -> \(.type): \(.title)"'

SESSION_INFO=$(curl -sf "$BASE/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}")
echo ""
echo "Session summary: $(echo "$SESSION_INFO" | jq '{message_count, participants}')"

echo ""
echo "=== All tests complete ==="
```

---

## Edge Cases Worth Exploring

| Case | How to Test |
|------|-------------|
| Reviewer sends message exceeding 100KB | Set `content` to a 100KB+ string -- expect 400 from Zod validation |
| Implementer polls with `limit=1` repeatedly | Use `since=<cursor>` from each response to paginate one at a time |
| Both agents poll simultaneously | Two concurrent `curl` GETs -- both should succeed (no locking issues in-memory) |
| Session expires mid-review | Create with `ttl_minutes=1`, wait 70 seconds, poll -- expect 404 |
| Wrong token on poll | Use Reviewer's token with Implementer's session ID (if different) -- expect 403 |
| Sensitive content in review findings | Include a fake API key (`sk-abc123...`) in content -- server accepts it (scanning is MCP-side only) |
