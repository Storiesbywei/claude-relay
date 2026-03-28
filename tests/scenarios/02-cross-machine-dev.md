# Scenario 02: Cross-Machine Development

Two machines sharing workspace context through the relay -- like Google Docs for a coding IDE. Both machines run Claude Code sessions that exchange file trees, edits, terminal output, and status updates in real time through a shared relay session.

## Technical Analysis

### What This Scenario Tests

Cross-machine development is the core "force multiplier" use case for claude-relay. A developer working on **Machine A** (e.g., MacBook Air) and **Machine B** (e.g., Mac mini) -- or two developers on different machines -- can share live workspace state without Git round-trips. Both Claude Code instances see each other's file trees, file edits, and terminal output through the relay's workspace message types.

This scenario validates:

- Session creation on one machine, joining from another over the network
- Bidirectional workspace message exchange (file_tree, file_change, file_read, terminal, status_update)
- Message sequence ordering across interleaved senders
- Cursor-based polling so each machine only receives messages it hasn't seen
- Bearer token isolation (each machine has its own token, sees the same messages)
- CORS behavior when the dashboard is accessed from a remote machine's browser
- Rate limiting under concurrent cross-machine traffic

### Network Topology

```
Machine A (relay host)                    Machine B (remote worker)
  +-----------------------+                +-----------------------+
  | Claude Code           |                | Claude Code           |
  |   + MCP Server        |                |   + MCP Server        |
  |   + relay-client      |                |   + relay-client      |
  +-----------+-----------+                +-----------+-----------+
              |                                        |
              |  POST/GET http://<host>:4190/relay/...  |
              +--------------------+-------------------+
                                   |
                          +--------+--------+
                          | Relay Server    |
                          | Hono + Bun      |
                          | 0.0.0.0:4190    |
                          | In-memory store |
                          +-----------------+
```

Three connectivity tiers:

| Tier | Path | Typical Latency | CORS Origin |
|------|------|-----------------|-------------|
| LAN | `192.168.x.x:4190` | <1ms | Must add to `RELAY_ORIGIN` env or allowedOrigins |
| Tailscale | `100.x.x.x:4190` | 2-10ms | Pre-configured: `100.99.9.76` and `100.71.141.45` already in allowedOrigins |
| ngrok | `https://xxx.ngrok-free.app` | 50-200ms | Auto-allowed: server matches `*.ngrok-free.app` and `*.ngrok.io` suffixes |

The server binds to `0.0.0.0` (not `127.0.0.1`), so it is network-accessible out of the box. No firewall changes needed for Tailscale; LAN may need port 4190 open.

### Data Flow

```
Machine A                          Relay Server                    Machine B
   |                                    |                              |
   |-- POST /sessions (create) -------->|                              |
   |<-- {session_id, creator_token,     |                              |
   |     invite_token} ----------------|                              |
   |                                    |                              |
   |--- share invite_token out-of-band (Slack, iMessage, etc.) ------>|
   |                                    |                              |
   |                                    |<-- POST /sessions/:id/join --|
   |                                    |    Bearer: invite_token      |
   |                                    |-- {participant_token} ------>|
   |                                    |                              |
   |-- POST /relay/:id (file_tree) ---->|                              |
   |                                    |<-- GET /relay/:id?since=0 ---|
   |                                    |-- [file_tree msg, seq=1] --->|
   |                                    |                              |
   |                                    |<-- POST /relay/:id ---------|
   |                                    |    (file_change, seq=2)      |
   |-- GET /relay/:id?since=0 -------->|                              |
   |<-- [file_tree seq=1,              |                              |
   |     file_change seq=2] -----------|                              |
```

Both machines use the same session ID but different Bearer tokens (creator_token vs. participant_token). The server assigns monotonically increasing sequence numbers (via `session.sequenceCounter++` in `addMessage`), so both machines can track their own cursor and never miss or double-receive a message.

### Workspace Message Types

The 5 workspace-aware message types (Phase 3) are purpose-built for this scenario:

| Type | Purpose | Typical Content |
|------|---------|-----------------|
| `file_tree` | Project structure snapshot | Recursive directory listing (markdown or JSON) |
| `file_change` | A file was edited | Diff, patch, or full file contents + path |
| `file_read` | Share file contents | Full file body + path + optional line range |
| `terminal` | Terminal output | Command + stdout/stderr |
| `status_update` | Worker status | "idle", "reading src/foo.ts", "running tests" |

Each message also carries optional `context` metadata (`project`, `stack`, `branch`) and `references` (relative file paths with line ranges), making workspace messages self-describing.

### Conflict Handling

**The relay does not resolve conflicts.** It is a message bus, not a CRDT or OT system. When both machines edit the same file:

1. Both `file_change` messages are stored with distinct sequence numbers.
2. The later sequence number wins in terms of ordering.
3. The receiving machine sees both edits in order and must decide how to reconcile.
4. In practice, the Claude Code session on the receiving end reads both diffs and applies/merges as appropriate.

This is acceptable because:
- The relay is designed for director/worker patterns where one machine leads and the other follows.
- Even in peer mode, the Claude sessions are intelligent enough to read the message history and resolve conflicts contextually.
- True concurrent edits to the same file are rare in the intended workflow.

### Message Ordering Guarantees

The relay provides **total order within a session**:

- `session.sequenceCounter` is a single integer, incremented atomically in `addMessage()`.
- Every message gets a unique, monotonically increasing `sequence` number.
- Polling with `?since=N` returns only messages with `sequence > N`, in order.
- SSE streams emit messages with `id: <sequence>` for resumption.

There is no per-sender ordering -- all messages share one sequence space. This means Machine A can always reconstruct the exact interleaving of its own messages with Machine B's messages.

### CORS Implications

The relay server's CORS policy affects dashboard access from remote browsers:

```typescript
const allowedOrigins = [
  "http://localhost:4190",
  "http://127.0.0.1:4190",
  "http://0.0.0.0:4190",
  "http://100.99.9.76:4190",   // MacBook Air Tailscale IP
  "http://100.71.141.45:4190", // Mac mini Tailscale IP
];
```

- **Tailscale**: Pre-configured. Dashboard on Machine B can fetch from Machine A's relay at `http://100.99.9.76:4190` without CORS errors.
- **LAN**: Must set `RELAY_ORIGIN=http://192.168.x.x:4190` env var before starting the server, or requests from the LAN IP origin will be silently downgraded to `http://localhost:4190` (which the browser will reject as a CORS mismatch).
- **ngrok**: Auto-allowed via suffix matching on `.ngrok-free.app` and `.ngrok.io`.
- **curl / MCP tools**: No `Origin` header is sent, so CORS is not enforced. All test cases below work regardless of CORS config.

### Latency Considerations

| Network | Send Latency | Poll Latency | SSE Delivery | Dashboard UX |
|---------|-------------|-------------|--------------|--------------|
| LAN | <1ms | <1ms | Near-instant | Smooth |
| Tailscale | 2-10ms | 2-10ms | <50ms | Smooth |
| ngrok | 50-200ms | 50-200ms | 100-400ms | Noticeable lag |

The relay's SSE heartbeat (every 15s) keeps connections alive across all tiers. For ngrok, the additional TLS termination and tunnel hop add latency but the protocol remains correct. The `?limit=` parameter on polling (max 50) prevents large payloads from compounding latency.

Rate limiting (600 req/min per token) is generous enough for any interactive cross-machine workflow.

---

## Test Cases

All tests run against `http://localhost:4190`. Machine A and Machine B are simulated using different Bearer tokens (creator_token vs. participant_token).

### Prerequisites

```bash
# Start the relay server (in another terminal or background)
cd /Users/weixiangzhang/Local_Dev/projects/claude-relay
bun run dev:server &

# Verify it's running
curl -s http://localhost:4190/health | jq .
```

---

### Test 1: Machine A Creates a Session

Machine A (the relay host) creates a shared workspace session.

```bash
# Machine A creates the session
RESPONSE=$(curl -s -X POST http://localhost:4190/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "cross-machine-dev: voxlight refactor", "ttl_minutes": 120}')

echo "$RESPONSE" | jq .

# Extract tokens for subsequent tests
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
MACHINE_A_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')

echo "SESSION_ID=$SESSION_ID"
echo "MACHINE_A_TOKEN=$MACHINE_A_TOKEN"
echo "INVITE_TOKEN=$INVITE_TOKEN"
```

**Expected:** 201 response with `session_id`, `creator_token`, `invite_token`, and `expires_at` (2 hours from now).

---

### Test 2: Machine B Joins via Invite Token

Machine B (remote worker on LAN/Tailscale) joins using the invite token shared out-of-band. In production, the URL would be `http://100.71.141.45:4190` or the machine's LAN IP.

```bash
# Machine B joins the session
JOIN_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"participant_name": "mac-mini-worker"}')

echo "$JOIN_RESPONSE" | jq .

MACHINE_B_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
echo "MACHINE_B_TOKEN=$MACHINE_B_TOKEN"

# Verify session now shows both participants
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" | jq '.participants'
```

**Expected:** Machine B receives its own `participant_token`. Session participants list shows `["creator", "mac-mini-worker"]`.

---

### Test 3: Machine A Shares Its File Tree

Machine A sends a `file_tree` message with the project structure snapshot.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_tree",
    "title": "voxlight iOS project structure",
    "content": "```\nsrc/\n  App/\n    VoxlightApp.swift\n    ContentView.swift\n  Reader/\n    ReaderView.swift\n    EPUBRenderer.swift\n  Audio/\n    AudioEngine.swift\n    PlaybackSyncService.swift\n  Data/\n    Book.swift\n    AudioChapter.swift\n    TextChapter.swift\n  Sync/\n    SyncEngine.swift\n    ManualSyncService.swift\ntests/\n  ReaderTests.swift\n  AudioTests.swift\n```",
    "tags": ["swift", "ios", "voxlight"],
    "context": {
      "project": "voxlight",
      "stack": "Swift 6, SwiftUI, AVAudioEngine",
      "branch": "dev"
    }
  }' | jq .
```

**Expected:** 201 with `sequence: 1`, confirming the file tree was stored.

---

### Test 4: Machine B Shares Its Own File Tree

Machine B sends its own workspace snapshot -- it's working on a related but different part of the codebase.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_tree",
    "title": "voxlight Mac Processor structure",
    "content": "```\nsrc/\n  VoxlightMacProcessorApp.swift\n  Pipeline/\n    SpeechAnalyzer.swift\n    NeedlemanWunsch.swift\n    AlignmentEngine.swift\n  Export/\n    JSONExporter.swift\n    AlignmentResult.swift\n  EPUB/\n    EPUBExtractor.swift\n    BookMetadata.swift\ntests/\n  AlignmentTests.swift\n  EPUBExtractorTests.swift\n```",
    "tags": ["swift", "macos", "voxlight-mac-processor"],
    "context": {
      "project": "voxlight-mac-processor",
      "stack": "Swift 6, SwiftUI, SpeechAnalyzer",
      "branch": "design-update"
    }
  }' | jq .
```

**Expected:** 201 with `sequence: 2`. Both file trees now coexist in the session.

---

### Test 5: Machine A Sends a File Change

Machine A edits `SyncEngine.swift` and shares the change with Machine B.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_change",
    "title": "Fix SyncEngine alignment import",
    "content": "Changed `importAlignment()` to handle missing chapter boundaries gracefully.\n\n```diff\n--- a/src/Sync/SyncEngine.swift\n+++ b/src/Sync/SyncEngine.swift\n@@ -42,7 +42,12 @@\n func importAlignment(_ data: AlignmentData) throws {\n-    guard let chapters = data.chapterResults else {\n-        throw SyncError.missingChapters\n-    }\n+    let chapters = data.chapterResults ?? []\n+    if chapters.isEmpty {\n+        logger.warning(\"No chapter results in alignment data, using word-level fallback\")\n+        try importWordLevelAlignment(data.words)\n+        return\n+    }\n     for chapter in chapters {\n```",
    "tags": ["bugfix", "sync-engine"],
    "references": [
      {"file": "src/Sync/SyncEngine.swift", "lines": "42-53", "note": "importAlignment method"},
      {"file": "src/Sync/ManualSyncService.swift", "note": "related - uses same data model"}
    ],
    "context": {
      "project": "voxlight",
      "stack": "Swift 6",
      "branch": "dev"
    }
  }' | jq .
```

**Expected:** 201 with `sequence: 3`. The diff, references, and context are all preserved.

---

### Test 6: Machine B Polls and Sees the Change

Machine B polls for all messages it hasn't seen yet (since sequence 0).

```bash
# Machine B polls from the beginning (first poll, cursor starts at 0)
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=10" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" | jq .
```

**Expected:** Returns 3 messages in order:
1. `sequence: 1` -- Machine A's file_tree (sender: "creator")
2. `sequence: 2` -- Machine B's own file_tree (sender: "mac-mini-worker")
3. `sequence: 3` -- Machine A's file_change (sender: "creator")

The `cursor` field should be `3`, and `has_more` should be `false`.

```bash
# Machine B polls again with cursor=3 (should get nothing new)
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=3&limit=10" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" | jq .
```

**Expected:** Empty messages array, `cursor: 3`, `has_more: false`.

---

### Test 7: Machine B Sends a File Read Request

Machine B wants to see the full contents of `AlignmentData` (referenced in Machine A's diff). It sends a question, and Machine A responds with the file contents.

```bash
# Machine B asks for a file
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "question",
    "title": "Need AlignmentData model definition",
    "content": "The SyncEngine diff references `AlignmentData` and `chapterResults`. Can you share the full model definition? I need to ensure the Mac Processor JSON export matches the expected shape.",
    "tags": ["question", "data-model"],
    "references": [
      {"file": "src/Sync/SyncEngine.swift", "lines": "42", "note": "uses AlignmentData"}
    ],
    "context": {
      "project": "voxlight",
      "branch": "dev"
    }
  }' | jq .
```

**Expected:** 201 with `sequence: 4`.

---

### Test 8: Machine A Responds with File Contents

Machine A shares the requested file using `file_read`.

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_read",
    "title": "AlignmentData.swift - full model",
    "content": "```swift\nimport Foundation\n\nstruct AlignmentData: Codable {\n    let metadata: BookMetadata?\n    let words: [AlignedWord]\n    let chapterResults: [ChapterResult]?\n    let overallQuality: Double\n    \n    struct AlignedWord: Codable {\n        let text: String\n        let startTime: Double\n        let endTime: Double\n        let confidence: Double\n        let chapterIndex: Int?\n    }\n    \n    struct ChapterResult: Codable {\n        let chapterIndex: Int\n        let title: String\n        let syncQuality: Double\n        let wordCount: Int\n        let alignedWordCount: Int\n    }\n}\n```",
    "tags": ["data-model", "answer"],
    "references": [
      {"file": "src/Data/AlignmentData.swift", "note": "full file contents"}
    ],
    "context": {
      "project": "voxlight",
      "stack": "Swift 6",
      "branch": "dev"
    }
  }' | jq .
```

**Expected:** 201 with `sequence: 5`.

---

### Test 9: Both Poll -- Verify Interleaved Messages with Correct Sequence Numbers

Both machines poll the full history and verify the complete, correctly ordered message stream.

```bash
# Machine A polls full history
echo "=== Machine A polling full history ==="
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" | jq '{
    cursor: .cursor,
    has_more: .has_more,
    message_count: (.messages | length),
    messages: [.messages[] | {
      seq: .sequence,
      type: .type,
      title: .title,
      sender: .sender_name
    }]
  }'

echo ""

# Machine B polls full history
echo "=== Machine B polling full history ==="
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" | jq '{
    cursor: .cursor,
    has_more: .has_more,
    message_count: (.messages | length),
    messages: [.messages[] | {
      seq: .sequence,
      type: .type,
      title: .title,
      sender: .sender_name
    }]
  }'
```

**Expected:** Both machines see identical output:

```json
{
  "cursor": 5,
  "has_more": false,
  "message_count": 5,
  "messages": [
    { "seq": 1, "type": "file_tree",   "title": "voxlight iOS project structure",       "sender": "creator" },
    { "seq": 2, "type": "file_tree",   "title": "voxlight Mac Processor structure",     "sender": "mac-mini-worker" },
    { "seq": 3, "type": "file_change", "title": "Fix SyncEngine alignment import",      "sender": "creator" },
    { "seq": 4, "type": "question",    "title": "Need AlignmentData model definition",  "sender": "mac-mini-worker" },
    { "seq": 5, "type": "file_read",   "title": "AlignmentData.swift - full model",     "sender": "creator" }
  ]
}
```

Key validations:
- Sequence numbers are `1, 2, 3, 4, 5` -- strictly monotonic, no gaps.
- Sender names alternate: `creator, mac-mini-worker, creator, mac-mini-worker, creator`.
- Message types reflect the workspace conversation flow: tree sharing, editing, requesting, responding.
- Both tokens return the exact same messages -- there is no per-sender filtering.
- `cursor: 5` and `has_more: false` confirm all messages were delivered.

---

### Bonus: Incremental Polling Simulation

Simulates the real-world pattern where each machine maintains its own cursor and only fetches new messages.

```bash
echo "=== Simulating incremental polling ==="

# Machine B's cursor was at 3 after Test 6. Poll for new messages since then.
echo "Machine B polls since=3:"
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=3&limit=10" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" | jq '{
    cursor: .cursor,
    new_messages: (.messages | length),
    messages: [.messages[] | {seq: .sequence, type: .type, sender: .sender_name}]
  }'

# Expected: 2 new messages (seq 4 and 5)
# Machine B sees its own question (seq 4) and Machine A's response (seq 5)

echo ""

# Machine A's cursor was at 1 (only saw its own file_tree). Poll since=1.
echo "Machine A polls since=1:"
curl -s "http://localhost:4190/relay/${SESSION_ID}?since=1&limit=10" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" | jq '{
    cursor: .cursor,
    new_messages: (.messages | length),
    messages: [.messages[] | {seq: .sequence, type: .type, sender: .sender_name}]
  }'

# Expected: 4 new messages (seq 2, 3, 4, 5)
```

---

## Full Executable Script

Copy-paste this entire block to run all tests end-to-end:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:4190"

echo "=== Test 1: Create session ==="
RESPONSE=$(curl -sf -X POST "$BASE/sessions" \
  -H "Content-Type: application/json" \
  -d '{"name": "cross-machine-dev: voxlight refactor", "ttl_minutes": 120}')
SESSION_ID=$(echo "$RESPONSE" | jq -r '.session_id')
MACHINE_A_TOKEN=$(echo "$RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$RESPONSE" | jq -r '.invite_token')
echo "Session: $SESSION_ID"

echo ""
echo "=== Test 2: Machine B joins ==="
JOIN_RESPONSE=$(curl -sf -X POST "$BASE/sessions/${SESSION_ID}/join" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"participant_name": "mac-mini-worker"}')
MACHINE_B_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
PARTICIPANTS=$(curl -sf "$BASE/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" | jq -r '.participants | join(", ")')
echo "Participants: $PARTICIPANTS"

echo ""
echo "=== Test 3: Machine A shares file_tree ==="
SEQ=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_tree","title":"voxlight iOS project structure","content":"src/\n  App/VoxlightApp.swift\n  Reader/ReaderView.swift\n  Audio/AudioEngine.swift","tags":["swift","ios"],"context":{"project":"voxlight","branch":"dev"}}' | jq -r '.sequence')
echo "Sequence: $SEQ"

echo ""
echo "=== Test 4: Machine B shares file_tree ==="
SEQ=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_tree","title":"voxlight Mac Processor structure","content":"src/\n  Pipeline/SpeechAnalyzer.swift\n  Export/JSONExporter.swift\n  EPUB/EPUBExtractor.swift","tags":["swift","macos"],"context":{"project":"voxlight-mac-processor","branch":"design-update"}}' | jq -r '.sequence')
echo "Sequence: $SEQ"

echo ""
echo "=== Test 5: Machine A sends file_change ==="
SEQ=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_change","title":"Fix SyncEngine alignment import","content":"```diff\n- guard let chapters = data.chapterResults else {\n+ let chapters = data.chapterResults ?? []\n```","tags":["bugfix"],"references":[{"file":"src/Sync/SyncEngine.swift","lines":"42-53"}],"context":{"project":"voxlight","branch":"dev"}}' | jq -r '.sequence')
echo "Sequence: $SEQ"

echo ""
echo "=== Test 6: Machine B polls (should see 3 messages) ==="
POLL=$(curl -sf "$BASE/relay/${SESSION_ID}?since=0&limit=10" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}")
MSG_COUNT=$(echo "$POLL" | jq '.messages | length')
CURSOR=$(echo "$POLL" | jq '.cursor')
echo "Messages: $MSG_COUNT, Cursor: $CURSOR"
echo "$POLL" | jq '[.messages[] | {seq: .sequence, type: .type, sender: .sender_name}]'

echo ""
echo "=== Test 7: Machine B sends question ==="
SEQ=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"question","title":"Need AlignmentData model definition","content":"Can you share the AlignmentData model? Need to match JSON export shape.","tags":["question"],"context":{"project":"voxlight","branch":"dev"}}' | jq -r '.sequence')
echo "Sequence: $SEQ"

echo ""
echo "=== Test 8: Machine A responds with file_read ==="
SEQ=$(curl -sf -X POST "$BASE/relay/${SESSION_ID}" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"file_read","title":"AlignmentData.swift - full model","content":"struct AlignmentData: Codable {\n    let words: [AlignedWord]\n    let chapterResults: [ChapterResult]?\n    let overallQuality: Double\n}","tags":["data-model","answer"],"references":[{"file":"src/Data/AlignmentData.swift"}],"context":{"project":"voxlight","branch":"dev"}}' | jq -r '.sequence')
echo "Sequence: $SEQ"

echo ""
echo "=== Test 9: Both poll full history ==="
echo "--- Machine A ---"
curl -sf "$BASE/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${MACHINE_A_TOKEN}" | jq '{
    cursor: .cursor,
    count: (.messages | length),
    messages: [.messages[] | {seq: .sequence, type: .type, sender: .sender_name}]
  }'

echo "--- Machine B ---"
curl -sf "$BASE/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${MACHINE_B_TOKEN}" | jq '{
    cursor: .cursor,
    count: (.messages | length),
    messages: [.messages[] | {seq: .sequence, type: .type, sender: .sender_name}]
  }'

echo ""
echo "=== All tests passed ==="
```

---

## Known Limitations

1. **No conflict resolution.** Two simultaneous `file_change` messages for the same file are both stored. The relay does not merge, rebase, or reject. Consumers must reconcile.
2. **No file persistence.** The relay stores message content (which may contain file diffs or full files), but it does not maintain a virtual filesystem. `file_tree` is a snapshot, not a live-updating structure.
3. **200-message cap per session.** A long cross-machine session with frequent `file_change` messages can hit `MAX_MESSAGES_PER_SESSION = 200`. Workaround: create a new session for each work unit.
4. **Sensitive content scanner.** The scanner in `constants.ts` flags absolute paths (`/Users/...`, `/home/...`). Cross-machine file trees will naturally contain these. When using MCP tools (which go through the approval queue), these will be flagged for approval. Direct HTTP calls (curl) bypass the scanner.
5. **In-memory store.** Server restart loses all sessions. For cross-machine dev spanning hours, the 24h TTL max is the real ceiling, not persistence.
6. **No auth on session creation.** Anyone who can reach port 4190 can create sessions. In a Tailscale network this is acceptable (all peers are authenticated). On open LAN or ngrok, consider adding a server-level API key.
