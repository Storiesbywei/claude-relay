# Scenario 06: Multi-Agent Orchestration

**What:** One director coordinates multiple Claude workers operating in parallel on different parts of a project.

**Why:** This is the highest-value use case for claude-relay. A $20-plan Claude (director) can coordinate multiple $200-plan Claude sessions (workers), each specializing in a different domain (frontend, backend, testing). The relay becomes the shared communication bus.

---

## Technical Analysis

### Participant Model

The relay supports `MAX_PARTICIPANTS = 10` per session. The creator (director) is stored separately via `creatorToken` and does not count against the participant limit. This means a single session can hold **1 director + 10 workers** (11 total actors). Each participant gets a unique bearer token on join, and the creator gets theirs at session creation time.

Key detail from `memory.ts`: the participant count check (`session.participants.size >= LIMITS.MAX_PARTICIPANTS`) only counts entries in the `participants` Map, which excludes the creator. The creator authenticates via `session.creatorToken` in `isValidToken()`.

### Message Addressing (Broadcast-Only)

There is **no direct messaging**. Every message sent to `POST /relay/:session_id` is appended to `session.messages[]` and broadcast to all SSE subscribers. All participants see all messages when they poll via `GET /relay/:session_id` or listen on `GET /relay/:session_id/stream`.

Workers must differentiate instructions meant for them using **conventions**, not protocol-level addressing:

- **`sender_name` field**: Set automatically from the participant's join name. The creator is always `"creator"`. Workers join with descriptive names like `"Worker-A-Frontend"`.
- **`title` field**: Directors can prefix task titles with the target worker name, e.g. `"@Worker-A: Implement login form"`.
- **`tags` field**: Use tags like `["for:worker-a", "frontend"]` to signal the intended recipient.
- **`content` field**: The markdown body can contain explicit addressing, e.g. `"Worker-B, please review the API endpoint..."`.

This broadcast model is intentional -- all workers gain ambient awareness of what others are doing, which reduces coordination overhead. But it means workers must implement discipline to only act on messages addressed to them.

### Parallel Work and Workspace Messages

Workers operating in parallel will naturally produce workspace-typed messages from different project areas:

- `file_tree` -- a worker shares the directory structure of their area (e.g., `src/components/` vs `src/api/`)
- `file_change` -- a worker shares a diff or file edit they made
- `status_update` -- a worker reports their current state (idle, reading, writing, testing)
- `terminal` -- a worker shares build output or test results

These arrive in the order the server receives them, not grouped by worker. The `sender_name` field is the only way to attribute a message to its source.

### Dashboard View

The dashboard renders all messages in chronological order (by `sequence` number). In a multi-worker session, the view will interleave messages from all workers:

```
seq 1: [creator]          task     → "@Worker-A: Build login form"
seq 2: [creator]          task     → "@Worker-B: Build auth API"
seq 3: [creator]          task     → "@Worker-C: Write integration tests"
seq 4: [Worker-A]         status   → "reading src/components/"
seq 5: [Worker-B]         status   → "reading src/api/"
seq 6: [Worker-C]         status   → "idle, waiting for A and B"
seq 7: [Worker-A]         file_tree → frontend structure
seq 8: [Worker-B]         file_change → new auth endpoint
seq 9: [Worker-A]         file_change → login component
seq 10: [Worker-C]        answer   → test results
```

There is no filtering by worker in the current dashboard. All messages are visible to all participants.

### Coordination Challenges

**Conflicting file changes.** Two workers could send `file_change` messages for the same file. The relay has no merge logic -- it stores both messages. The director (or a coordinating worker) must detect the conflict by reading both messages and resolving it manually. This is a fundamental limitation of the broadcast + in-memory model.

**Ordering ambiguity.** If Worker-A and Worker-B send messages at nearly the same instant, the sequence order depends on which HTTP request the server processes first. The `sequenceCounter` in `memory.ts` is incremented synchronously (`session.sequenceCounter++`), so there are no race conditions in single-threaded Bun, but the arrival order is still non-deterministic from the workers' perspective.

**Stale context.** A worker may base decisions on a poll snapshot that is already outdated by the time they act. Worker-A polls, sees no file changes to `shared/utils.ts`, and edits it. Meanwhile Worker-B already sent a `file_change` for `shared/utils.ts` that Worker-A's poll missed. SSE streaming mitigates this but does not eliminate it.

### Scaling Limits

**Message budget.** `MAX_MESSAGES_PER_SESSION = 200`. With N workers + 1 director, each sending status updates, file trees, file changes, and answers, the budget fills fast:

| Workers | Messages per worker (status + file_tree + ~3 file_changes + answer) | Director messages (N tasks + N follow-ups) | Total | Headroom |
|---------|-------------------------------------------------------------------|-------------------------------------------|-------|----------|
| 2       | ~6 each = 12                                                      | ~6                                        | ~18   | 182      |
| 3       | ~6 each = 18                                                      | ~9                                        | ~27   | 173      |
| 5       | ~6 each = 30                                                      | ~15                                       | ~45   | 155      |
| 9       | ~6 each = 54                                                      | ~27                                       | ~81   | 119      |

At 6 messages per worker per round, even 9 workers use only ~81 messages in one round. But multi-round conversations (director gives feedback, workers iterate) multiply this. With 3 rounds of back-and-forth, 5 workers would consume ~135 of 200 messages. **Practical limit: 3-5 workers with 2-3 rounds of iteration.**

**Rate limiting.** Each worker has its own bearer token, and rate limiting is per-token (`RATE_LIMIT_PER_MINUTE = 600`). Workers do not interfere with each other's rate limits. The director's rate limit is also independent. This is favorable for multi-agent scenarios.

**Poll limit.** `GET /relay/:session_id` returns at most 50 messages per poll (`Math.min(limit, 50)`). A worker joining late and polling `since=0` in a busy session may need multiple polls to catch up, paginating with the `cursor` value.

---

## Test Cases

All tests use `curl` against `http://localhost:4190`. Variables are captured with `jq` and reused across steps.

### Prerequisites

```bash
# Ensure the relay server is running
curl -sf http://localhost:4190/health | jq .
# Expected: {"status":"ok", ...}

# Requires: jq installed
which jq
```

---

### Test 1: Director creates a session

```bash
# Director creates a multi-agent orchestration session
CREATE_RESPONSE=$(curl -s -X POST http://localhost:4190/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "Multi-Agent Sprint: E-commerce Checkout", "ttl_minutes": 120}')

echo "$CREATE_RESPONSE" | jq .

# Extract tokens for subsequent commands
SESSION_ID=$(echo "$CREATE_RESPONSE" | jq -r '.session_id')
DIRECTOR_TOKEN=$(echo "$CREATE_RESPONSE" | jq -r '.creator_token')
INVITE_TOKEN=$(echo "$CREATE_RESPONSE" | jq -r '.invite_token')

echo "SESSION_ID=$SESSION_ID"
echo "DIRECTOR_TOKEN=$DIRECTOR_TOKEN"
echo "INVITE_TOKEN=$INVITE_TOKEN"

# Expected: 201 with session_id, creator_token, invite_token, expires_at
```

---

### Test 2: Worker-A joins (frontend specialist)

```bash
WORKER_A_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{"participant_name": "Worker-A-Frontend"}')

echo "$WORKER_A_RESPONSE" | jq .

WORKER_A_TOKEN=$(echo "$WORKER_A_RESPONSE" | jq -r '.participant_token')
echo "WORKER_A_TOKEN=$WORKER_A_TOKEN"

# Expected: participant_token, session.participants includes ["creator", "Worker-A-Frontend"]
```

---

### Test 3: Worker-B joins (backend specialist)

```bash
WORKER_B_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{"participant_name": "Worker-B-Backend"}')

echo "$WORKER_B_RESPONSE" | jq .

WORKER_B_TOKEN=$(echo "$WORKER_B_RESPONSE" | jq -r '.participant_token')
echo "WORKER_B_TOKEN=$WORKER_B_TOKEN"

# Expected: session.participants = ["creator", "Worker-A-Frontend", "Worker-B-Backend"]
```

---

### Test 4: Worker-C joins (testing specialist)

```bash
WORKER_C_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{"participant_name": "Worker-C-Testing"}')

echo "$WORKER_C_RESPONSE" | jq .

WORKER_C_TOKEN=$(echo "$WORKER_C_RESPONSE" | jq -r '.participant_token')
echo "WORKER_C_TOKEN=$WORKER_C_TOKEN"

# Expected: session.participants = ["creator", "Worker-A-Frontend", "Worker-B-Backend", "Worker-C-Testing"]
```

---

### Test 5: Director sends targeted task assignments

The director sends three `task` messages, one addressed to each worker by name in the title and content. Since there are no DMs, addressing is by convention.

```bash
# Task for Worker-A
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -d '{
    "type": "task",
    "title": "@Worker-A-Frontend: Build checkout form",
    "content": "## Assignment for Worker-A-Frontend\n\nBuild the checkout form component at `src/components/CheckoutForm.tsx`.\n\n### Requirements\n- Credit card input with Luhn validation\n- Billing address fields\n- Order summary sidebar\n- Submit button triggers `POST /api/checkout`\n\nCoordinate with Worker-B on the API contract.",
    "tags": ["for:worker-a", "frontend", "checkout"],
    "context": {"project": "ecommerce-app", "stack": "React + TypeScript", "branch": "feature/checkout"}
  }' | jq .

# Task for Worker-B
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -d '{
    "type": "task",
    "title": "@Worker-B-Backend: Build checkout API",
    "content": "## Assignment for Worker-B-Backend\n\nBuild the checkout API endpoint at `src/api/checkout.ts`.\n\n### Requirements\n- `POST /api/checkout` accepts order payload\n- Validate card number, expiry, CVV\n- Call Stripe `paymentIntents.create`\n- Return order confirmation with ID\n- Error handling for declined cards\n\nShare your API contract with Worker-A so the frontend can integrate.",
    "tags": ["for:worker-b", "backend", "checkout", "stripe"],
    "context": {"project": "ecommerce-app", "stack": "Node.js + Hono", "branch": "feature/checkout"}
  }' | jq .

# Task for Worker-C
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -d '{
    "type": "task",
    "title": "@Worker-C-Testing: Write checkout integration tests",
    "content": "## Assignment for Worker-C-Testing\n\nWrite integration tests for the checkout flow.\n\n### Requirements\n- Test happy path: valid card → order confirmation\n- Test validation: invalid card number → 400 error\n- Test Stripe failure: declined card → appropriate error message\n- Test form validation: missing fields → client-side errors\n\nWait for Worker-A and Worker-B to share their file changes before writing tests against their implementations.",
    "tags": ["for:worker-c", "testing", "checkout", "integration"],
    "context": {"project": "ecommerce-app", "stack": "Vitest + Testing Library", "branch": "feature/checkout"}
  }' | jq .

# Expected: Three 201 responses with sequential sequence numbers (1, 2, 3)
```

---

### Test 6: All three workers send status_updates simultaneously

Simulates parallel worker activity. Run these three curls in background subshells to approximate concurrency.

```bash
# Worker-A status
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_A_TOKEN}" \
  -d '{
    "type": "status_update",
    "title": "Worker-A status: reading",
    "content": "Reading existing components in `src/components/`. Found existing `AddressForm.tsx` that can be reused for billing address fields. Starting `CheckoutForm.tsx` scaffold now.",
    "tags": ["status", "frontend"]
  }' &

# Worker-B status
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_B_TOKEN}" \
  -d '{
    "type": "status_update",
    "title": "Worker-B status: reading",
    "content": "Reading existing API routes in `src/api/`. Found existing middleware for auth and validation. Will define the checkout request schema and share with Worker-A before implementing.",
    "tags": ["status", "backend"]
  }' &

# Worker-C status
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_C_TOKEN}" \
  -d '{
    "type": "status_update",
    "title": "Worker-C status: idle",
    "content": "Waiting for Worker-A and Worker-B to complete their implementations. Reviewing existing test patterns in `tests/` to align with project conventions.",
    "tags": ["status", "testing", "blocked"]
  }' &

wait
echo "All three status updates sent."

# Expected: Three 201 responses. Sequence numbers 4, 5, 6 (order may vary
# since requests are concurrent, but Bun processes them serially so they
# will get deterministic sequential IDs).
```

---

### Test 7: Worker-A sends file_tree for frontend area

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_A_TOKEN}" \
  -d '{
    "type": "file_tree",
    "title": "Frontend component structure",
    "content": "```\nsrc/components/\n  checkout/\n    CheckoutForm.tsx        (new — main form component)\n    OrderSummary.tsx         (new — sidebar order summary)\n    PaymentFields.tsx        (new — card input with Luhn validation)\n  AddressForm.tsx            (existing — reusing for billing)\n  Button.tsx                 (existing)\nsrc/hooks/\n  useCheckout.ts             (new — form state + submit handler)\nsrc/types/\n  checkout.ts                (new — CheckoutPayload, OrderConfirmation)\n```",
    "tags": ["file_tree", "frontend", "checkout"],
    "references": [
      {"file": "src/components/checkout/CheckoutForm.tsx", "note": "Main checkout form — new file"},
      {"file": "src/components/AddressForm.tsx", "note": "Existing address form being reused"},
      {"file": "src/types/checkout.ts", "note": "Shared types for API contract"}
    ],
    "context": {"project": "ecommerce-app", "branch": "feature/checkout"}
  }' | jq .

# Expected: 201, sender_name = "Worker-A-Frontend"
```

---

### Test 8: Worker-B sends file_change for backend API + shared contract

```bash
# Worker-B shares the API contract so Worker-A can integrate
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_B_TOKEN}" \
  -d '{
    "type": "api-docs",
    "title": "Checkout API contract for Worker-A",
    "content": "## POST /api/checkout\n\n### Request Body\n```typescript\ninterface CheckoutPayload {\n  card_number: string;    // 16 digits, Luhn-valid\n  expiry_month: number;   // 1-12\n  expiry_year: number;    // 4-digit year\n  cvv: string;            // 3-4 digits\n  billing_address: {\n    line1: string;\n    line2?: string;\n    city: string;\n    state: string;\n    zip: string;\n    country: string;      // ISO 3166-1 alpha-2\n  };\n  items: Array<{ sku: string; quantity: number }>;\n}\n```\n\n### Response (201)\n```typescript\ninterface OrderConfirmation {\n  order_id: string;\n  status: \"confirmed\" | \"pending\";\n  total_cents: number;\n  created_at: string;\n}\n```\n\n### Errors\n- `400` — Validation error (invalid card, missing fields)\n- `402` — Payment declined\n- `500` — Internal server error",
    "tags": ["api-docs", "backend", "checkout", "contract"],
    "context": {"project": "ecommerce-app", "stack": "Node.js + Hono", "branch": "feature/checkout"}
  }' | jq .

# Worker-B sends the actual file change
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_B_TOKEN}" \
  -d '{
    "type": "file_change",
    "title": "New file: src/api/checkout.ts",
    "content": "```typescript\n// src/api/checkout.ts\nimport { Hono } from \"hono\";\nimport { z } from \"zod\";\nimport Stripe from \"stripe\";\n\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\n\nconst CheckoutSchema = z.object({\n  card_number: z.string().regex(/^\\d{16}$/),\n  expiry_month: z.number().int().min(1).max(12),\n  expiry_year: z.number().int().min(2026),\n  cvv: z.string().regex(/^\\d{3,4}$/),\n  billing_address: z.object({\n    line1: z.string().min(1),\n    line2: z.string().optional(),\n    city: z.string().min(1),\n    state: z.string().min(1),\n    zip: z.string().min(1),\n    country: z.string().length(2),\n  }),\n  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),\n});\n\nexport const checkoutRoutes = new Hono();\n\ncheckoutRoutes.post(\"/\", async (c) => {\n  const body = await c.req.json();\n  const parsed = CheckoutSchema.safeParse(body);\n  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);\n  \n  try {\n    const intent = await stripe.paymentIntents.create({\n      amount: calculateTotal(parsed.data.items),\n      currency: \"usd\",\n    });\n    return c.json({ order_id: intent.id, status: \"confirmed\", total_cents: intent.amount, created_at: new Date().toISOString() }, 201);\n  } catch (err) {\n    return c.json({ error: \"Payment declined\" }, 402);\n  }\n});\n```",
    "tags": ["file_change", "backend", "checkout"],
    "references": [
      {"file": "src/api/checkout.ts", "note": "New checkout endpoint — complete implementation"}
    ],
    "context": {"project": "ecommerce-app", "stack": "Node.js + Hono + Stripe", "branch": "feature/checkout"}
  }' | jq .

# Expected: Two 201 responses with sender_name = "Worker-B-Backend"
```

---

### Test 9: Worker-C sends answer with test results

```bash
curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKER_C_TOKEN}" \
  -d '{
    "type": "answer",
    "title": "Integration test results: 3 pass, 1 fail",
    "content": "## Test Results\n\n```\n PASS  tests/checkout.test.ts\n  checkout flow\n    ✓ valid card → 201 order confirmation (142ms)\n    ✓ invalid card number → 400 validation error (38ms)\n    ✓ missing billing fields → 400 validation error (29ms)\n    ✗ declined card → 402 payment declined (211ms)\n      Expected: { error: \"Payment declined\" }\n      Received: { error: \"Internal server error\" }\n\nTests: 3 passed, 1 failed, 4 total\n```\n\n## Issue Found\n\n**@Worker-B-Backend**: The Stripe error handling in `src/api/checkout.ts` catches all errors as 402. When Stripe throws a non-decline error (e.g., network timeout), it should return 500 instead. The catch block needs to check `err.type === \"StripeCardError\"` before returning 402.\n\n## Suggested Fix\n```typescript\n} catch (err: any) {\n  if (err.type === \"StripeCardError\") {\n    return c.json({ error: \"Payment declined\" }, 402);\n  }\n  return c.json({ error: \"Internal server error\" }, 500);\n}\n```",
    "tags": ["answer", "testing", "checkout", "bug-report"],
    "references": [
      {"file": "tests/checkout.test.ts", "note": "Integration test suite"},
      {"file": "src/api/checkout.ts", "lines": "28-32", "note": "Bug: catch block does not differentiate error types"}
    ],
    "context": {"project": "ecommerce-app", "stack": "Vitest", "branch": "feature/checkout"}
  }' | jq .

# Expected: 201, sender_name = "Worker-C-Testing"
```

---

### Test 10: Director polls -- verify all messages interleaved correctly

```bash
# Poll all messages from the beginning (since=0), max 50 per page
POLL_RESPONSE=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}")

echo "$POLL_RESPONSE" | jq .

# Verify message count
MSG_COUNT=$(echo "$POLL_RESPONSE" | jq '.messages | length')
echo "Total messages: $MSG_COUNT"
# Expected: 10 messages (3 tasks + 3 status + 1 file_tree + 2 from Worker-B + 1 answer)

# Verify sender attribution
echo "=== Messages by sender ==="
echo "$POLL_RESPONSE" | jq -r '.messages[] | "\(.sequence)\t[\(.sender_name)]\t\(.type)\t\(.title)"'

# Expected output (sequence order):
# 1  [creator]           task           @Worker-A-Frontend: Build checkout form
# 2  [creator]           task           @Worker-B-Backend: Build checkout API
# 3  [creator]           task           @Worker-C-Testing: Write checkout integration tests
# 4  [Worker-A-Frontend] status_update  Worker-A status: reading
# 5  [Worker-B-Backend]  status_update  Worker-B status: reading
# 6  [Worker-C-Testing]  status_update  Worker-C status: idle
# 7  [Worker-A-Frontend] file_tree      Frontend component structure
# 8  [Worker-B-Backend]  api-docs       Checkout API contract for Worker-A
# 9  [Worker-B-Backend]  file_change    New file: src/api/checkout.ts
# 10 [Worker-C-Testing]  answer         Integration test results: 3 pass, 1 fail

# Verify cursor for pagination
CURSOR=$(echo "$POLL_RESPONSE" | jq '.cursor')
echo "Cursor: $CURSOR (should equal the last sequence number)"

# Verify no more messages
echo "$POLL_RESPONSE" | jq '.has_more'
# Expected: false
```

---

### Test 11: Verify session info shows all participants

```bash
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq .

# Expected:
# {
#   "id": "...",
#   "name": "Multi-Agent Sprint: E-commerce Checkout",
#   "participants": ["creator", "Worker-A-Frontend", "Worker-B-Backend", "Worker-C-Testing"],
#   "message_count": 10,
#   ...
# }
```

---

### Test 12: Test MAX_PARTICIPANTS limit (join 11th participant)

The creator does not count against `MAX_PARTICIPANTS`. The limit is 10 entries in the `participants` Map. We already have 3 participants (A, B, C). Join 7 more to reach 10, then verify the 11th is rejected.

```bash
# Join workers 4 through 10 (7 more, filling 10 participant slots)
for i in $(seq 4 10); do
  RESP=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${INVITE_TOKEN}" \
    -d "{\"participant_name\": \"Worker-${i}-Filler\"}")
  echo "Worker-${i}: $(echo "$RESP" | jq -r '.participant_token // .error')"
done

# Expected: Workers 4-10 all succeed (participants.size goes from 3 to 10)

# Now try the 11th participant (should fail)
REJECT_RESPONSE=$(curl -s -X POST "http://localhost:4190/sessions/${SESSION_ID}/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${INVITE_TOKEN}" \
  -d '{"participant_name": "Worker-11-Overflow"}')

echo "$REJECT_RESPONSE" | jq .

# Expected: 400 with error "Max participants (10) reached"

# Verify session still has exactly 11 names (creator + 10 participants)
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq '.participants | length'
# Expected: 11 (creator + 10 workers)
```

---

### Test 13: Message count approaching MAX_MESSAGES_PER_SESSION

Verify the 200-message limit is enforced. We have 10 messages so far. Send 190 more to fill the session, then verify the 201st is rejected.

```bash
# Send 190 filler messages to reach the 200 limit
for i in $(seq 11 200); do
  curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
    -d "{
      \"type\": \"status_update\",
      \"title\": \"Filler message ${i}\",
      \"content\": \"Filler message number ${i} to test capacity limit.\"
    }" > /dev/null
done

echo "Sent 190 filler messages."

# Verify we are at exactly 200
curl -s "http://localhost:4190/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" | jq '.message_count'
# Expected: 200

# Try to send message 201 (should fail)
OVERFLOW_RESPONSE=$(curl -s -X POST "http://localhost:4190/relay/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DIRECTOR_TOKEN}" \
  -d '{
    "type": "status_update",
    "title": "Message 201 — should be rejected",
    "content": "This message should exceed the MAX_MESSAGES_PER_SESSION limit."
  }')

echo "$OVERFLOW_RESPONSE" | jq .

# Expected: 400 with error "Max messages (200) reached"
```

---

### Test 14: Worker polls with pagination (late joiner catches up)

Simulates a worker that joins late and needs to page through all 200 messages.

```bash
# Poll page 1 (messages 1-50)
PAGE1=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=0&limit=50" \
  -H "Authorization: Bearer ${WORKER_A_TOKEN}")
CURSOR1=$(echo "$PAGE1" | jq '.cursor')
HAS_MORE1=$(echo "$PAGE1" | jq '.has_more')
COUNT1=$(echo "$PAGE1" | jq '.messages | length')
echo "Page 1: ${COUNT1} messages, cursor=${CURSOR1}, has_more=${HAS_MORE1}"
# Expected: 50 messages, cursor=50, has_more=true

# Poll page 2 (messages 51-100)
PAGE2=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=${CURSOR1}&limit=50" \
  -H "Authorization: Bearer ${WORKER_A_TOKEN}")
CURSOR2=$(echo "$PAGE2" | jq '.cursor')
HAS_MORE2=$(echo "$PAGE2" | jq '.has_more')
COUNT2=$(echo "$PAGE2" | jq '.messages | length')
echo "Page 2: ${COUNT2} messages, cursor=${CURSOR2}, has_more=${HAS_MORE2}"
# Expected: 50 messages, cursor=100, has_more=true

# Poll page 3 (messages 101-150)
PAGE3=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=${CURSOR2}&limit=50" \
  -H "Authorization: Bearer ${WORKER_A_TOKEN}")
CURSOR3=$(echo "$PAGE3" | jq '.cursor')
HAS_MORE3=$(echo "$PAGE3" | jq '.has_more')
COUNT3=$(echo "$PAGE3" | jq '.messages | length')
echo "Page 3: ${COUNT3} messages, cursor=${CURSOR3}, has_more=${HAS_MORE3}"
# Expected: 50 messages, cursor=150, has_more=true

# Poll page 4 (messages 151-200)
PAGE4=$(curl -s "http://localhost:4190/relay/${SESSION_ID}?since=${CURSOR3}&limit=50" \
  -H "Authorization: Bearer ${WORKER_A_TOKEN}")
CURSOR4=$(echo "$PAGE4" | jq '.cursor')
HAS_MORE4=$(echo "$PAGE4" | jq '.has_more')
COUNT4=$(echo "$PAGE4" | jq '.messages | length')
echo "Page 4: ${COUNT4} messages, cursor=${CURSOR4}, has_more=${HAS_MORE4}"
# Expected: 50 messages, cursor=200, has_more=false

TOTAL=$((COUNT1 + COUNT2 + COUNT3 + COUNT4))
echo "Total messages fetched across 4 pages: $TOTAL"
# Expected: 200
```

---

## Run All Tests

To execute the full scenario end-to-end, paste all test blocks sequentially into a shell session. Each test depends on variables set by previous tests (`SESSION_ID`, `DIRECTOR_TOKEN`, `INVITE_TOKEN`, worker tokens).

Alternatively, save this as an executable script:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Copy-paste all test blocks above in order.
# Tests 1-11 are the core multi-agent orchestration flow.
# Tests 12-14 are limit/stress tests that modify session state significantly.
```

---

## Identified Gaps

| Gap | Impact | Suggested Fix |
|-----|--------|---------------|
| No message addressing | Workers must parse titles/tags to find their tasks | Add optional `to` field in `RelayMessagePayloadSchema` for recipient filtering |
| No per-worker message filtering on poll | Workers receive all messages, including ones for other workers | Add `?sender=Worker-A` or `?tag=for:worker-a` query params to `GET /relay/:id` |
| No conflict detection for file_change | Two workers can edit the same file without warning | Server-side check: if two `file_change` messages reference the same file path, flag a warning |
| Broadcast SSE has no sender filter | SSE stream delivers all messages to all subscribers | Allow `?sender=` filter on SSE endpoint |
| 200-message limit fills fast with many workers | 5+ workers with iteration rounds can exhaust budget | Increase limit for multi-agent sessions, or add message archival/compaction |
| No worker-to-worker coordination primitive | Workers cannot signal "I am done, Worker-C can start" | Add `status_update` convention with structured `content` (e.g., `{"status": "done", "artifacts": [...]}`) |
| No message type for task completion | Director cannot distinguish "in progress" from "done" | Add `task_complete` message type or use tags like `["done", "task:checkout-form"]` |
