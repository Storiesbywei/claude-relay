# Solid Protocol Level 2: Pod as Persistent Storage -- Architecture

> Detailed architecture for real-time write-through from the relay to Solid Pods.
> Builds on Level 1 (export-only) which is already implemented in `packages/relay-server/src/solid/`.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Write-Through Architecture](#2-write-through-architecture)
3. [Sync Engine Design](#3-sync-engine-design)
4. [Pod Container Management](#4-pod-container-management)
5. [Schema Changes](#5-schema-changes)
6. [API Changes](#6-api-changes)
7. [Failure Modes](#7-failure-modes)
8. [Code Structure](#8-code-structure)
9. [Implementation Sprint Plan](#9-implementation-sprint-plan)

---

## 1. Design Principles

### 1.1 Core Invariant

**SQLite is always the source of truth for the hot path.** The Solid Pod is a durable, user-owned mirror that receives writes asynchronously. If the Pod is unreachable, the relay continues to function exactly as it does today. If the relay crashes, it catches up from the last known synced sequence on restart.

### 1.2 Why Not Replace SQLite?

The latency numbers from the research doc (Section 7.1) make this clear:

| Operation | SQLite (Bun `bun:sqlite`) | Solid Pod (local CSS) | Solid Pod (remote) |
|-----------|---------------------------|----------------------|---------------------|
| Write 1 message | <1ms | 30-80ms | 100-300ms |
| Read 10 messages | <1ms | 50-150ms | 200-500ms |
| Create session container | <1ms | 100-200ms | 300-600ms |

The relay handles real-time SSE streaming and MCP tool polling. Adding 100-300ms of latency per write would break the interactive feel. The write-through model preserves sub-millisecond reads while gaining Pod durability.

### 1.3 Per-Session Opt-In

Not every session needs Pod sync. Solid sync is configured per-session -- only sessions with a `solid_config` get a background sync worker. This means:

- Zero overhead for sessions without Pod config
- Different users can point to different Pods
- Pod sync can be enabled mid-session (not just at creation time)

---

## 2. Write-Through Architecture

### 2.1 Write Path

```
POST /relay/:session_id (message arrives)
  |
  v
[1] SQLite transaction (synchronous, <1ms)
    - Increment sequence_counter
    - INSERT INTO messages
    - UPDATE sessions.last_activity_at
  |
  v
[2] SSE broadcast (in-memory, <1ms)
    - Notify all sseSubscribers for this session
  |
  v
[3] Nostr bridge (async, fire-and-forget)
    - bridgeMessageToNostr(message, sessionId)
  |
  v
[4] Solid sync queue enqueue (async, fire-and-forget)     <-- NEW
    - INSERT INTO solid_sync_queue (session_id, sequence, payload)
    - Signal the background sync worker
```

Step [4] is the only new addition to the hot path. It is a single SQLite INSERT into a local queue table -- sub-millisecond, no network I/O. The actual Pod write happens in a background worker.

### 2.2 Read Path

**Reads always come from SQLite.** The Pod is never consulted for read operations during normal relay use. This means:

- `GET /relay/:session_id` -- reads from `messages` table (unchanged)
- `GET /relay/:session_id/stream` -- SSE from in-memory subscribers (unchanged)
- `GET /sessions/:id` -- reads from `sessions` table (unchanged)

The Pod serves two purposes: (a) durable offsite backup, and (b) data portability (other Solid apps can read from it directly).

### 2.3 Data Flow Diagram

```
                                        +-----------+
                                        | Solid Pod |
                                        |  (L2)     |
                                        +-----^-----+
                                              |
                                        async writes
                                        (background)
                                              |
+-------------+     +--------+     +---+-----+-----+---+     +-----------+
| Claude Code | --> | MCP    | --> |   Hono Server     | --> | Dashboard |
| (client)    |     | Tools  |     |                   |     | (SSE)     |
+-------------+     +--------+     +---+-----+---------+     +-----------+
                                       |     |
                                  sync |     | async
                                  write|     | broadcast
                                       v     v
                                   +----------+     +--------+
                                   | SQLite   |     | Nostr  |
                                   | (L1)     |     | Bridge |
                                   +----------+     +--------+
```

---

## 3. Sync Engine Design

### 3.1 Architecture Overview

The sync engine is a background worker that drains a persistent write queue. It runs as a long-lived async loop inside the relay server process (not a separate process). One sync worker instance handles all sessions; per-session concurrency is managed via the queue.

```
                 +-----------------------+
                 |    SyncEngine         |
                 |                       |
                 |  start() / stop()     |
                 |  onMessageAdded()     |
                 |  getStatus()          |
                 |                       |
                 |  +------------------+ |
                 |  |  SyncQueue       | |
                 |  |  (SQLite table)  | |
                 |  +--------+---------+ |
                 |           |           |
                 |  +--------v---------+ |
                 |  |  PodWriter       | |
                 |  |  (HTTP to Pod)   | |
                 |  +------------------+ |
                 +-----------------------+
```

### 3.2 SyncQueue (SQLite-backed)

The sync queue is a durable, ordered list of pending Pod writes stored in the same SQLite database as the relay data. This ensures that if the relay crashes mid-sync, no writes are lost -- they remain in the queue and are retried on restart.

**Queue operations:**

| Operation | Description | SQL |
|-----------|-------------|-----|
| `enqueue(entry)` | Add a pending write | `INSERT INTO solid_sync_queue` |
| `peek(sessionId, limit)` | Get oldest N unsynced entries for a session | `SELECT ... WHERE status = 'pending' ORDER BY sequence ASC LIMIT N` |
| `markSynced(id)` | Remove a successfully synced entry | `DELETE FROM solid_sync_queue WHERE id = ?` |
| `markFailed(id, error)` | Increment retry count, set next attempt time | `UPDATE ... SET retries = retries + 1, next_attempt_at = ?, last_error = ?` |
| `getDepth(sessionId)` | Count pending entries | `SELECT COUNT(*) WHERE session_id = ? AND status = 'pending'` |

**Queue entry lifecycle:**

```
pending --> in_flight --> synced (deleted)
                |
                +--> failed --> pending (retry after backoff)
                        |
                        +--> dead_letter (after max retries)
```

### 3.3 Background Worker Loop

The sync engine runs a single async loop that processes the queue:

```typescript
class SyncEngine {
  private running = false;
  private wakeSignal: (() => void) | null = null;

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const batch = this.queue.peekAll(BATCH_SIZE); // across all sessions

      if (batch.length === 0) {
        // Nothing to sync -- sleep until signaled
        await this.waitForWork();
        continue;
      }

      // Group by session to batch Pod writes
      const bySession = groupBy(batch, 'session_id');

      for (const [sessionId, entries] of bySession) {
        await this.syncSession(sessionId, entries);
      }
    }
  }

  /** Called by addMessage hook -- wakes the worker if sleeping */
  signal(): void {
    this.wakeSignal?.();
  }

  private async waitForWork(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wakeSignal = resolve;
      // Also wake periodically to check for retries
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
    this.wakeSignal = null;
  }
}
```

### 3.4 Retry with Exponential Backoff

When a Pod write fails, the queue entry is marked as failed with an increasing backoff delay:

```
Attempt 1: immediate
Attempt 2: 1 second
Attempt 3: 2 seconds
Attempt 4: 4 seconds
Attempt 5: 8 seconds
Attempt 6: 16 seconds
Attempt 7: 32 seconds
Attempt 8: 64 seconds (cap)
...
Attempt 15: dead letter (stop retrying)
```

Formula: `min(1000 * 2^(retries - 1), 64000)` milliseconds.

The `next_attempt_at` column in the queue table tracks when an entry becomes eligible for retry. The worker skips entries whose `next_attempt_at` is in the future.

### 3.5 Sequence Tracking

Each session with Pod sync tracks the highest sequence number that has been successfully written to the Pod:

```
sessions.pod_synced_sequence = 42
```

This means sequences 1 through 42 are confirmed on the Pod. On relay startup, the sync engine compares:

```
pod_synced_sequence (42) vs. sequence_counter (47) → 5 messages to catch up
```

The catch-up query:

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence > ?
ORDER BY sequence ASC
```

These are re-enqueued into `solid_sync_queue` and processed normally.

### 3.6 Startup Catch-Up Flow

```
[Server starts]
  |
  v
For each session WHERE solid_config IS NOT NULL:
  |
  v
  Compare pod_synced_sequence with sequence_counter
  |
  +-- If equal: nothing to do
  |
  +-- If behind:
        |
        v
        SELECT messages WHERE sequence > pod_synced_sequence
        |
        v
        Enqueue into solid_sync_queue (skip if already queued)
        |
        v
        Signal sync worker
```

---

## 4. Pod Container Management

### 4.1 Container Structure

Each session with Pod sync gets a container hierarchy on the Pod:

```
<pod_url>/<container_path>/<session_id>/
  metadata              -- session metadata (updated periodically)
  messages/
    <sequence>          -- one resource per message (e.g., "1", "2", "3")
```

This reuses the same structure as the Level 1 export (`export.ts`), with one difference: messages are written incrementally (one at a time as they arrive) instead of all at once.

### 4.2 Lazy Pod Connection

The relay does not connect to a Solid Pod at startup. Connections are established lazily:

1. Session is created without `solid_config` -- no Pod connection
2. Session is created with `solid_config` -- auth session obtained on first enqueue
3. `POST /sessions/:id/solid/enable` -- auth session obtained immediately
4. Auth sessions are cached by `podUrl:clientId` (reuse existing `auth.ts` cache)

This means the relay starts instantly with zero Pod overhead. Pod connections are only established when a session actually needs them.

### 4.3 Auto-Create Session Container

On the first message enqueued for a session with Pod sync, the PodWriter checks whether the session container exists:

```typescript
async ensureSessionContainer(sessionId: string, config: SolidExportConfig): Promise<string> {
  const containerUrl = buildContainerUrl(config, sessionId);

  if (this.knownContainers.has(containerUrl)) {
    return containerUrl;
  }

  // Try to create -- if it already exists, the Pod returns 409 or 200 (both OK)
  try {
    await createContainerAt(containerUrl, { fetch: authFetch });
    await createContainerAt(`${containerUrl}messages/`, { fetch: authFetch });
    this.knownContainers.add(containerUrl);
  } catch (err) {
    // Container might already exist from a previous run or Level 1 export
    if (isConflictOrAlreadyExists(err)) {
      this.knownContainers.add(containerUrl);
    } else {
      throw err;
    }
  }

  return containerUrl;
}
```

The `knownContainers` set is an in-memory cache to avoid checking on every write. It is populated on startup by querying sessions that have `pod_url` set.

### 4.4 Per-Session Solid Config

Different sessions can target different Pods. The `solid_config` is stored per-session in SQLite:

```
Session A: pod_url=https://pod.example/alice/ (Alice's Pod)
Session B: pod_url=https://pod.example/bob/   (Bob's Pod)
Session C: solid_config=NULL                   (no Pod sync)
```

The auth session cache in `auth.ts` already keys by `podUrl:clientId`, so multiple Pod targets share cached connections efficiently.

---

## 5. Schema Changes

### 5.1 Sessions Table -- New Columns

```sql
ALTER TABLE sessions ADD COLUMN pod_url TEXT;
ALTER TABLE sessions ADD COLUMN pod_synced_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN solid_config TEXT;  -- JSON, encrypted at rest
```

| Column | Type | Purpose |
|--------|------|---------|
| `pod_url` | TEXT, nullable | The Pod URL for this session (NULL = no Pod sync) |
| `pod_synced_sequence` | INTEGER | Highest message sequence confirmed written to Pod |
| `solid_config` | TEXT, nullable | JSON blob: `{ podUrl, oidcIssuer, clientId, clientSecret, containerPath }` |

The `solid_config` column stores the full `SolidExportConfig` as JSON. In a future iteration, the `clientSecret` should be encrypted at rest using a server-side key derived from an environment variable. For the initial implementation, it is stored in plaintext in the SQLite database (which is a local file not exposed over the network).

### 5.2 New Table: `solid_sync_queue`

```sql
CREATE TABLE IF NOT EXISTS solid_sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  operation       TEXT NOT NULL DEFAULT 'write_message',
  payload         TEXT NOT NULL,       -- JSON: the StoredMessage or metadata
  status          TEXT NOT NULL DEFAULT 'pending',
  retries         INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 15,
  next_attempt_at TEXT NOT NULL,       -- ISO 8601 timestamp
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_pending
  ON solid_sync_queue(status, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_sync_queue_session
  ON solid_sync_queue(session_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_queue_dedup
  ON solid_sync_queue(session_id, sequence, operation)
  WHERE status != 'dead_letter';
```

**Column reference:**

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Auto-increment queue entry ID |
| `session_id` | TEXT FK | Which session this write belongs to |
| `sequence` | INTEGER | Message sequence number (for ordering and dedup) |
| `operation` | TEXT | `write_message`, `write_metadata`, `create_container` |
| `payload` | TEXT | JSON-serialized message or metadata |
| `status` | TEXT | `pending`, `in_flight`, `dead_letter` |
| `retries` | INTEGER | Number of failed attempts |
| `max_retries` | INTEGER | Configurable per entry (default 15) |
| `next_attempt_at` | TEXT | ISO 8601; entries with future timestamps are skipped |
| `last_error` | TEXT | Error message from most recent failed attempt |
| `created_at` | TEXT | When the entry was enqueued |
| `updated_at` | TEXT | Last status change |

### 5.3 New Prepared Statements

Add to `sqlite.ts`:

```typescript
// Solid sync queue statements
enqueueSync: db.prepare(`
  INSERT OR IGNORE INTO solid_sync_queue
    (session_id, sequence, operation, payload, status, retries, max_retries,
     next_attempt_at, last_error, created_at, updated_at)
  VALUES ($session_id, $sequence, $operation, $payload, 'pending', 0, 15,
          $now, NULL, $now, $now)
`),

peekSyncQueue: db.prepare(`
  SELECT * FROM solid_sync_queue
  WHERE status = 'pending' AND next_attempt_at <= $now
  ORDER BY sequence ASC
  LIMIT $limit
`),

markSyncInFlight: db.prepare(`
  UPDATE solid_sync_queue SET status = 'in_flight', updated_at = $now
  WHERE id = $id AND status = 'pending'
`),

markSyncComplete: db.prepare(`
  DELETE FROM solid_sync_queue WHERE id = $id
`),

markSyncFailed: db.prepare(`
  UPDATE solid_sync_queue
  SET status = 'pending',
      retries = retries + 1,
      next_attempt_at = $next_attempt_at,
      last_error = $error,
      updated_at = $now
  WHERE id = $id
`),

markSyncDeadLetter: db.prepare(`
  UPDATE solid_sync_queue
  SET status = 'dead_letter', updated_at = $now
  WHERE id = $id
`),

getSyncQueueDepth: db.prepare(`
  SELECT COUNT(*) as cnt FROM solid_sync_queue
  WHERE session_id = $session_id AND status IN ('pending', 'in_flight')
`),

getSyncQueueStats: db.prepare(`
  SELECT
    session_id,
    COUNT(*) FILTER (WHERE status = 'pending') as pending,
    COUNT(*) FILTER (WHERE status = 'in_flight') as in_flight,
    COUNT(*) FILTER (WHERE status = 'dead_letter') as dead_letter,
    MAX(last_error) as last_error
  FROM solid_sync_queue
  WHERE session_id = $session_id
  GROUP BY session_id
`),

updatePodSyncedSequence: db.prepare(`
  UPDATE sessions SET pod_synced_sequence = $sequence
  WHERE id = $session_id AND pod_synced_sequence < $sequence
`),

getSessionsWithSolidConfig: db.prepare(`
  SELECT id, sequence_counter, pod_synced_sequence, solid_config
  FROM sessions
  WHERE solid_config IS NOT NULL
`),

updateSessionSolidConfig: db.prepare(`
  UPDATE sessions
  SET solid_config = $config, pod_url = $pod_url
  WHERE id = $session_id
`),
```

### 5.4 Migration Strategy

Since the relay uses `CREATE TABLE IF NOT EXISTS` (no migration framework), the new columns and table are added via `ALTER TABLE` with existence checks:

```typescript
// Run at startup, after the main schema creation
function migrateSolidSync(db: Database): void {
  // Add columns to sessions (ALTER TABLE ADD COLUMN is safe to re-run if wrapped in try/catch)
  try { db.exec("ALTER TABLE sessions ADD COLUMN pod_url TEXT"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN pod_synced_sequence INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN solid_config TEXT"); } catch {}

  // Create sync queue table
  db.exec(`
    CREATE TABLE IF NOT EXISTS solid_sync_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      sequence        INTEGER NOT NULL,
      operation       TEXT NOT NULL DEFAULT 'write_message',
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      retries         INTEGER NOT NULL DEFAULT 0,
      max_retries     INTEGER NOT NULL DEFAULT 15,
      next_attempt_at TEXT NOT NULL,
      last_error      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sync_queue_pending
      ON solid_sync_queue(status, next_attempt_at)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_sync_queue_session
      ON solid_sync_queue(session_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_queue_dedup
      ON solid_sync_queue(session_id, sequence, operation)
      WHERE status != 'dead_letter';
  `);
}
```

---

## 6. API Changes

### 6.1 Modified Endpoints

#### `POST /sessions` -- Optional `solid_config` Field

The `CreateSessionRequestSchema` gains an optional `solid_config` object:

```typescript
const SolidConfigSchema = z.object({
  pod_url: z.string().url(),
  oidc_issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  container_path: z.string().optional().default("relay-sessions/"),
}).optional();

// Extended CreateSessionRequestSchema
export const CreateSessionRequestSchema = z.object({
  name: z.string().min(1).max(100),
  ttl_minutes: z.number().int().min(1).max(LIMITS.MAX_TTL_MINUTES).default(60).optional(),
  nostr_pubkey: NostrPubkeySchema,
  solid_config: SolidConfigSchema,   // NEW
});
```

**Request example:**

```json
POST /sessions
{
  "name": "my-session",
  "ttl_minutes": 120,
  "solid_config": {
    "pod_url": "https://pod.example/alice/",
    "oidc_issuer": "https://pod.example/",
    "client_id": "relay-app-id",
    "client_secret": "secret",
    "container_path": "relay-sessions/"
  }
}
```

**Response (existing fields unchanged, new field added):**

```json
{
  "session_id": "uuid",
  "creator_token": "uuid",
  "invite_token": "uuid",
  "expires_at": "2026-03-30T02:00:00Z",
  "pod_sync_enabled": true   // NEW: indicates Pod sync is active
}
```

#### `GET /sessions/:id` -- Shows `pod_sync_status`

The session info response gains a `pod_sync` field when Solid is configured:

```json
{
  "id": "uuid",
  "name": "my-session",
  "participants": [...],
  "message_count": 47,
  "created_at": "...",
  "expires_at": "...",
  "last_activity_at": "...",
  "pod_sync": {                         // NEW: only present when solid_config is set
    "enabled": true,
    "pod_url": "https://pod.example/alice/",
    "synced_sequence": 42,
    "current_sequence": 47,
    "queue_depth": 5,
    "last_error": null,
    "status": "syncing"                 // "syncing" | "synced" | "paused" | "error"
  }
}
```

The `status` field is computed:
- `"synced"` -- `synced_sequence == current_sequence` and queue_depth == 0
- `"syncing"` -- queue_depth > 0 and no persistent errors
- `"paused"` -- sync manually paused or all entries are dead-lettered
- `"error"` -- last_error is non-null and recent (within 60s)

### 6.2 New Endpoints

#### `POST /sessions/:id/solid/enable` -- Enable Pod Sync Mid-Session

Enables Pod sync on an existing session. Only the session creator can do this.

**Request:**

```json
POST /sessions/:id/solid/enable
Authorization: Bearer <creator_token>
{
  "pod_url": "https://pod.example/alice/",
  "oidc_issuer": "https://pod.example/",
  "client_id": "relay-app-id",
  "client_secret": "secret",
  "container_path": "relay-sessions/"
}
```

**Behavior:**

1. Validate the Solid config (Zod schema)
2. Test authentication against the Pod (call `getAuthenticatedSession`)
3. Store `solid_config` and `pod_url` on the session
4. Enqueue all existing messages (sequence 1 through current) into the sync queue
5. Signal the sync worker

**Response:**

```json
{
  "enabled": true,
  "pod_url": "https://pod.example/alice/",
  "messages_queued": 47,
  "container_url": "https://pod.example/alice/relay-sessions/<session-id>/"
}
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid Solid config |
| 401 | Missing auth header |
| 403 | Not the session creator |
| 404 | Session not found |
| 409 | Pod sync already enabled for this session |
| 502 | Pod authentication failed (bad credentials or Pod unreachable) |

#### `GET /sessions/:id/solid/status` -- Sync Status

Returns detailed sync status. Available to any session participant.

**Response:**

```json
{
  "enabled": true,
  "pod_url": "https://pod.example/alice/",
  "container_url": "https://pod.example/alice/relay-sessions/<session-id>/",
  "synced_sequence": 42,
  "current_sequence": 47,
  "sync_lag": 5,
  "queue": {
    "pending": 3,
    "in_flight": 2,
    "dead_letter": 0
  },
  "last_error": null,
  "last_synced_at": "2026-03-30T00:45:12Z",
  "status": "syncing"
}
```

When Solid is not enabled:

```json
{
  "enabled": false
}
```

### 6.3 Route Registration

New routes are added to `packages/relay-server/src/routes/solid.ts`:

```typescript
// Existing route (Level 1)
solidRoutes.post("/:session_id/export", ...);

// New routes (Level 2)
solidRoutes.post("/:session_id/solid/enable", ...);
solidRoutes.get("/:session_id/solid/status", ...);
```

These routes are already protected by `authMiddleware` via the existing mount in `index.ts`:

```typescript
app.use("/solid/:session_id/*", authMiddleware);
app.route("/solid", solidRoutes);
```

---

## 7. Failure Modes

### 7.1 Pod Unreachable (Network Error, DNS Failure, Timeout)

**Symptom:** HTTP requests to the Pod fail with connection errors or timeouts.

**Behavior:**
- Queue entries remain in `pending` status
- Retry with exponential backoff (1s, 2s, 4s, ..., 64s cap)
- Queue depth grows (visible via `GET /sessions/:id/solid/status`)
- Relay continues to function normally (SQLite is primary)
- No data loss -- all messages are in SQLite and the sync queue

**Resolution:** When the Pod becomes reachable, the backlog drains automatically. The sync engine processes entries in sequence order, so the Pod ends up consistent.

**Monitoring:** The `/health` endpoint should report `solid_queue_depth` when non-zero. If queue depth exceeds a threshold (e.g., 100 entries), the health check returns a `degraded` status.

### 7.2 Pod Returns 403 Forbidden

**Symptom:** The Pod rejects writes with HTTP 403.

**Possible causes:**
- OIDC token expired and could not refresh
- WAC/ACP rules changed (relay lost write access)
- Client registration revoked

**Behavior:**
- Queue entries fail and retry
- After 3 consecutive 403s for the same session, sync is **paused** for that session
- `last_error` is set to the 403 response body
- Status becomes `"paused"`

**Resolution:** Requires user intervention -- re-authenticate or fix Pod permissions. The `POST /sessions/:id/solid/enable` endpoint can be called again with updated credentials to resume sync.

### 7.3 Pod Disk Full (507 Insufficient Storage)

**Symptom:** Pod returns HTTP 507.

**Behavior:** Same as "Pod Unreachable" -- retry with backoff. The Pod might free space or the user might upgrade storage.

**Note:** The sync engine does NOT delete old data from the Pod. If the Pod is full, it is the user's responsibility to manage Pod storage.

### 7.4 Relay Crash / Restart

**Symptom:** The relay process terminates unexpectedly.

**Behavior on restart:**
1. SQLite database is intact (WAL mode, atomic transactions)
2. `solid_sync_queue` entries with `status = 'in_flight'` are reset to `pending` (they may have been partially written)
3. For each session with `solid_config`, compare `pod_synced_sequence` to `sequence_counter`
4. Any messages with sequence > `pod_synced_sequence` that are not already in the queue are re-enqueued
5. Sync worker starts processing

**Potential duplicate writes:** If the relay crashed after writing to the Pod but before deleting the queue entry, the same message may be written to the Pod twice. This is idempotent because Pod resources are addressed by sequence number (`messages/<sequence>`). Writing the same data to the same URL is a no-op (PUT is idempotent).

### 7.5 Invalid Solid Config (Wrong URL, Bad Credentials)

**Symptom:** Authentication fails immediately when Pod sync is enabled.

**Behavior:**
- `POST /sessions/:id/solid/enable` returns 502 with error details
- Config is NOT stored -- the session remains without Pod sync
- No queue entries are created

**This is caught early** because `enable` tests authentication before storing the config.

### 7.6 Queue Overflow (Sustained Pod Outage)

**Symptom:** Queue grows unbounded during a long Pod outage.

**Mitigation:**
- Queue entries are lightweight (JSON payload, ~1-5KB each)
- Max 200 messages per session * 50 sessions = 10,000 queue entries max (the existing relay limits)
- At 5KB average, that is ~50MB of queue data -- well within SQLite comfort zone
- Dead-lettered entries stop retrying (after 15 attempts over ~18 hours of backoff)

### 7.7 Failure Mode Summary

| Failure | Relay Impact | Data Loss | Auto-Recovery |
|---------|-------------|-----------|---------------|
| Pod unreachable | None | None (SQLite + queue) | Yes (backoff retry) |
| Pod 403 | None | None | No (manual re-auth) |
| Pod 507 | None | None | Yes (if space freed) |
| Relay crash | Brief downtime | None (SQLite WAL) | Yes (catch-up on restart) |
| Bad credentials | Sync not enabled | None | No (user fixes creds) |
| Queue overflow | None | None | Yes (dead-letter after 15 retries) |

---

## 8. Code Structure

### 8.1 File Layout

```
packages/relay-server/src/solid/
  auth.ts             -- EXISTING: Solid-OIDC session caching (reuse as-is)
  export.ts           -- EXISTING: Level 1 one-shot export (keep for backward compat)
  sync-engine.ts      -- NEW: background worker, startup catch-up, lifecycle
  sync-queue.ts       -- NEW: SQLite-backed write queue CRUD
  pod-writer.ts       -- NEW: writes individual messages/metadata to Pod

packages/relay-server/src/routes/
  solid.ts            -- EXISTING: Level 1 export route + NEW: enable/status routes

packages/relay-server/src/store/
  sqlite.ts           -- MODIFIED: new prepared statements, migration function

packages/shared/src/
  solid-types.ts      -- MODIFIED: new types for sync status and config
  schema.ts           -- MODIFIED: SolidConfigSchema added to CreateSessionRequestSchema
```

### 8.2 Module Responsibilities

#### `sync-engine.ts` -- Orchestrator

```typescript
export class SolidSyncEngine {
  constructor(queue: SyncQueue, writer: PodWriter);

  /** Start the background worker loop */
  start(): void;

  /** Graceful shutdown -- finish in-flight writes, then stop */
  stop(): Promise<void>;

  /** Called by addMessage() in sqlite.ts -- enqueue + signal */
  onMessageAdded(sessionId: string, message: StoredMessage): void;

  /** Called on startup -- find and re-enqueue missing messages */
  catchUp(): void;

  /** Get sync status for a session */
  getSessionStatus(sessionId: string): SolidSyncStatus;

  /** Enable Pod sync for a session (stores config, enqueues backlog) */
  enableForSession(sessionId: string, config: SolidExportConfig): Promise<EnableResult>;

  /** Health check data */
  getHealthStats(): { totalPending: number; totalDeadLetter: number; activeSessions: number };
}
```

#### `sync-queue.ts` -- Persistent Queue

```typescript
export class SyncQueue {
  constructor(db: Database);

  enqueue(entry: SyncQueueEntry): void;
  peekAll(limit: number): SyncQueueRow[];
  peekForSession(sessionId: string, limit: number): SyncQueueRow[];
  markInFlight(id: number): void;
  markComplete(id: number): void;
  markFailed(id: number, error: string): void;
  markDeadLetter(id: number): void;
  resetInFlight(): number;  // On startup: in_flight -> pending
  getDepth(sessionId: string): number;
  getStats(sessionId: string): QueueStats;
}
```

#### `pod-writer.ts` -- Pod HTTP Operations

```typescript
export class PodWriter {
  constructor(authProvider: typeof getAuthenticatedSession);

  /** Ensure the session container + messages/ sub-container exist */
  ensureContainer(sessionId: string, config: SolidExportConfig): Promise<string>;

  /** Write a single message to the Pod */
  writeMessage(message: StoredMessage, containerUrl: string, config: SolidExportConfig): Promise<void>;

  /** Write/update session metadata on the Pod */
  writeMetadata(session: Session, containerUrl: string, config: SolidExportConfig): Promise<void>;
}
```

The `PodWriter` reuses the serialization logic from `export.ts` (`messageToDataset`, `sessionMetadataToDataset`) but operates on individual messages instead of bulk export.

### 8.3 Integration Points

#### Hook into `addMessage()` (sqlite.ts)

The existing `addMessage` function is the single point where messages enter the store. Level 2 adds a hook:

```typescript
// In sqlite.ts addMessage():
export function addMessage(sessionId: string, message: StoredMessage): void {
  addMessageTx(sessionId, message);

  // Notify SSE subscribers (in-memory) -- existing
  const subs = sseSubscribers.get(sessionId);
  if (subs) {
    for (const cb of subs) cb(message);
  }

  // NEW: Notify Solid sync engine (if session has Pod config)
  if (solidSyncEngine) {
    solidSyncEngine.onMessageAdded(sessionId, message);
  }
}
```

The `solidSyncEngine` reference is set during server startup. If it is null (Solid sync disabled via env var), the hook is a no-op.

#### Hook into server startup (index.ts)

```typescript
// In index.ts, after DB initialization:
import { SolidSyncEngine } from "./solid/sync-engine.js";
import { SyncQueue } from "./solid/sync-queue.js";
import { PodWriter } from "./solid/pod-writer.js";
import { getAuthenticatedSession } from "./solid/auth.js";

let solidSyncEngine: SolidSyncEngine | null = null;

if (process.env.DISABLE_SOLID_SYNC !== "true") {
  const queue = new SyncQueue(db);
  const writer = new PodWriter(getAuthenticatedSession);
  solidSyncEngine = new SolidSyncEngine(queue, writer);
  solidSyncEngine.catchUp();
  solidSyncEngine.start();
  console.log("[solid] Sync engine started");
}

// Export for sqlite.ts hook
export { solidSyncEngine };
```

#### Hook into graceful shutdown (index.ts)

```typescript
const shutdown = async () => {
  clearInterval(sweepInterval);
  disconnectRelayPool();
  shutdownPool();

  // NEW: stop sync engine gracefully
  if (solidSyncEngine) {
    await solidSyncEngine.stop();
  }

  clearSessionCache();
  console.log("\n[relay] Shutting down...");
  process.exit(0);
};
```

---

## 9. Implementation Sprint Plan

### Overview

**Total effort estimate:** 8-10 working days, split into 4 phases.

**Prerequisites:**
- Level 1 is implemented and working (already done -- `auth.ts` + `export.ts` exist)
- A local Community Solid Server is running for development/testing
- Familiarity with `bun:sqlite` prepared statements

### Phase 1: Schema + Queue (Days 1-2)

**Goal:** SQLite schema changes and the sync queue module. No Pod writes yet.

| Task | File | Effort | Depends On |
|------|------|--------|------------|
| 1.1 Add migration function for new columns + table | `store/sqlite.ts` | 2h | -- |
| 1.2 Add new prepared statements for sync queue | `store/sqlite.ts` | 2h | 1.1 |
| 1.3 Implement `SyncQueue` class | `solid/sync-queue.ts` | 3h | 1.2 |
| 1.4 Unit tests for SyncQueue (enqueue, peek, retry, dead-letter) | `solid/sync-queue.test.ts` | 3h | 1.3 |
| 1.5 Add `SolidConfigSchema` to shared schemas | `shared/src/schema.ts` | 1h | -- |
| 1.6 Add sync status types to `solid-types.ts` | `shared/src/solid-types.ts` | 1h | -- |

**Deliverable:** The sync queue works in isolation. Messages can be enqueued, peeked, retried, and dead-lettered. No integration with the server yet.

### Phase 2: Pod Writer + Sync Engine (Days 3-5)

**Goal:** The background worker that drains the queue and writes to the Pod.

| Task | File | Effort | Depends On |
|------|------|--------|------------|
| 2.1 Extract `messageToDataset` from `export.ts` into shared helper | `solid/export.ts` | 1h | -- |
| 2.2 Implement `PodWriter` class | `solid/pod-writer.ts` | 4h | 2.1 |
| 2.3 Implement `SolidSyncEngine` (worker loop, signal, backoff) | `solid/sync-engine.ts` | 6h | Phase 1, 2.2 |
| 2.4 Implement startup catch-up logic | `solid/sync-engine.ts` | 2h | 2.3 |
| 2.5 Hook `onMessageAdded` into `sqlite.ts addMessage()` | `store/sqlite.ts` | 1h | 2.3 |
| 2.6 Hook startup/shutdown into `index.ts` | `index.ts` | 1h | 2.3 |
| 2.7 Integration test: send messages, verify Pod receives them | -- | 3h | 2.6 |

**Deliverable:** Messages sent via `POST /relay/:id` are automatically written to a Solid Pod when the session has `solid_config`. The sync engine runs in the background, retries on failure, and catches up on restart.

### Phase 3: API Routes (Days 6-7)

**Goal:** The HTTP endpoints for enabling/monitoring Pod sync.

| Task | File | Effort | Depends On |
|------|------|--------|------------|
| 3.1 Modify `POST /sessions` to accept `solid_config` | `routes/sessions.ts` | 2h | Phase 1 |
| 3.2 Modify `GET /sessions/:id` to include `pod_sync` status | `routes/sessions.ts` | 1h | Phase 2 |
| 3.3 Implement `POST /sessions/:id/solid/enable` | `routes/solid.ts` | 3h | Phase 2 |
| 3.4 Implement `GET /sessions/:id/solid/status` | `routes/solid.ts` | 2h | Phase 2 |
| 3.5 Add Solid sync stats to `/health` endpoint | `routes/health.ts` | 1h | Phase 2 |
| 3.6 End-to-end test: create session with config, send messages, check status | -- | 2h | 3.1-3.5 |

**Deliverable:** Full API surface for Level 2. Sessions can be created with Pod sync, sync can be enabled mid-session, and sync status is observable.

### Phase 4: Hardening + Observability (Days 8-10)

**Goal:** Production-readiness, edge cases, monitoring.

| Task | File | Effort | Depends On |
|------|------|--------|------------|
| 4.1 Crash recovery test: kill relay mid-sync, verify catch-up | -- | 2h | Phase 2 |
| 4.2 403 handling: pause sync after 3 consecutive auth failures | `solid/sync-engine.ts` | 2h | Phase 2 |
| 4.3 Dead-letter alerting: log warning when entries hit max retries | `solid/sync-engine.ts` | 1h | Phase 2 |
| 4.4 `DISABLE_SOLID_SYNC` env var for zero-overhead opt-out | `index.ts` | 30min | Phase 2 |
| 4.5 Solid config encryption at rest (derive key from env) | `store/sqlite.ts` | 3h | Phase 1 |
| 4.6 Add `solid-pod` service to `docker-compose.yml` (CSS) | `docker-compose.yml` | 2h | -- |
| 4.7 Update CLAUDE.md with new endpoints and architecture | `CLAUDE.md` | 1h | Phase 3 |
| 4.8 Update `solid-protocol-integration.md` Level 2 section | `docs/` | 1h | Phase 3 |
| 4.9 Dashboard "Pod Sync" status indicator | `public/` | 3h | Phase 3 |

**Deliverable:** Level 2 is production-ready with proper failure handling, observability, and documentation.

### Dependency Graph

```
Phase 1 (Schema + Queue)
  |
  +---> Phase 2 (Writer + Engine)
  |       |
  |       +---> Phase 3 (API Routes)
  |       |       |
  |       |       +---> Phase 4 (Hardening)
  |       |
  |       +---> Phase 4 (Hardening)
  |
  +---> Phase 3.1 (POST /sessions can start in parallel with Phase 2)
```

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `@inrupt/solid-client` incompatible with Bun | Low (Level 1 already works) | High | Test early in Phase 2; fallback to raw `fetch` |
| Pod write latency >300ms (remote) slows queue drain | Medium | Low | Batch writes per session; increase worker concurrency |
| SQLite WAL contention from sync queue writes | Low | Medium | Queue writes are small INSERTs; benchmark at 200 msg/session |
| Solid-OIDC token refresh fails silently | Medium | Medium | Check `session.info.isLoggedIn` before each write batch |
| Container creation race condition (two workers) | Low | Low | `createContainerAt` is idempotent; 409 is handled |

---

## Appendix A: Type Definitions

### New Types for `packages/shared/src/solid-types.ts`

```typescript
/** Existing -- unchanged */
export interface SolidExportConfig { ... }
export interface SolidExportResult { ... }

/** NEW: Sync status returned by GET /sessions/:id/solid/status */
export interface SolidSyncStatus {
  enabled: boolean;
  pod_url?: string;
  container_url?: string;
  synced_sequence?: number;
  current_sequence?: number;
  sync_lag?: number;
  queue?: {
    pending: number;
    in_flight: number;
    dead_letter: number;
  };
  last_error?: string | null;
  last_synced_at?: string | null;
  status?: "syncing" | "synced" | "paused" | "error";
}

/** NEW: Result of enabling Pod sync */
export interface SolidEnableResult {
  enabled: boolean;
  pod_url: string;
  messages_queued: number;
  container_url: string;
}

/** NEW: Sync queue entry */
export interface SyncQueueEntry {
  session_id: string;
  sequence: number;
  operation: "write_message" | "write_metadata" | "create_container";
  payload: string;  // JSON-serialized StoredMessage or session metadata
}
```

### New Constants

```typescript
// In constants.ts or sync-engine.ts
export const SOLID_SYNC = {
  BATCH_SIZE: 10,                    // Max entries to process per loop iteration
  POLL_INTERVAL_MS: 5_000,          // How often to check for retryable entries
  MAX_RETRIES: 15,                   // After this many failures, dead-letter
  BACKOFF_BASE_MS: 1_000,           // Starting backoff delay
  BACKOFF_CAP_MS: 64_000,           // Maximum backoff delay
  PAUSE_AFTER_AUTH_FAILURES: 3,     // Consecutive 403s before pausing session sync
  CONTAINER_CACHE_TTL_MS: 300_000,  // 5 minutes -- how long to cache "container exists"
} as const;
```

---

## Appendix B: Sequence Diagrams

### B.1 Normal Message Write (Happy Path)

```
Client          Hono Server       SQLite          SyncEngine       Pod
  |                  |               |                |              |
  |  POST /relay/:id |               |                |              |
  |----------------->|               |                |              |
  |                  | INSERT msg    |                |              |
  |                  |-------------->|                |              |
  |                  |   OK (seq=5)  |                |              |
  |                  |<--------------|                |              |
  |                  | SSE broadcast |                |              |
  |                  |-----...       |                |              |
  |                  | enqueue       |                |              |
  |                  |-------------->|                |              |
  |                  | signal        |                |              |
  |                  |------------------------------>|              |
  |  201 Created     |               |                |              |
  |<-----------------|               |                |              |
  |                  |               |                | peek queue   |
  |                  |               |                |<-------------|
  |                  |               |                | PUT message  |
  |                  |               |                |------------->|
  |                  |               |                |   201 OK     |
  |                  |               |                |<-------------|
  |                  |               | mark complete  |              |
  |                  |               |<---------------|              |
  |                  |               | update synced_seq              |
  |                  |               |<---------------|              |
```

### B.2 Pod Failure + Retry

```
SyncEngine            SyncQueue (SQLite)         Pod
  |                         |                      |
  | peek                    |                      |
  |------------------------>|                      |
  | entry (seq=5)           |                      |
  |<------------------------|                      |
  | mark in_flight          |                      |
  |------------------------>|                      |
  | PUT message             |                      |
  |----------------------------------------------->|
  |                         |            TIMEOUT   |
  |<-----------------------------------------------|
  | mark failed (retry=1, next=+1s)                |
  |------------------------>|                      |
  |                         |                      |
  | [sleep 1s]              |                      |
  |                         |                      |
  | peek (next_attempt <= now)                     |
  |------------------------>|                      |
  | entry (seq=5, retry=1)  |                      |
  |<------------------------|                      |
  | PUT message             |                      |
  |----------------------------------------------->|
  |                         |            201 OK    |
  |<-----------------------------------------------|
  | mark complete           |                      |
  |------------------------>|                      |
```

### B.3 Startup Catch-Up

```
Server Start       SQLite                    SyncQueue              SyncEngine
  |                  |                          |                      |
  | init engine      |                          |                      |
  |----------------->|                          |                      |
  |                  | reset in_flight->pending |                      |
  |                  |<-------------------------|                      |
  |                  |                          |                      |
  |                  | SELECT sessions WHERE solid_config IS NOT NULL  |
  |                  |<--------------------------------------------- |
  |                  | session A: synced=42, current=47               |
  |                  |--------------------------------------------->|
  |                  |                          |                      |
  |                  |                          | SELECT msgs 43-47   |
  |                  |<-------------------------|                      |
  |                  |                          | enqueue 5 entries    |
  |                  |<-------------------------|                      |
  |                  |                          |                      |
  |                  |                          |  start worker loop   |
  |                  |                          |--------------------->|
```
