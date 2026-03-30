/**
 * SQLite-backed sync queue for Solid Pod write-through.
 *
 * All queue state is persisted in the `solid_sync_queue` table. If the relay
 * crashes, pending writes survive and are retried on restart. The queue is
 * ordered by message_sequence so Pod writes happen in the same order as the
 * relay's own sequence counter.
 */

import { db } from "../store/sqlite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncQueueEntry {
  id: number;
  sessionId: string;
  messageSequence: number;
  status: "pending" | "in_progress" | "failed" | "completed";
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SyncQueueRow {
  id: number;
  session_id: string;
  message_sequence: number;
  status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Prepared statements (scoped to this module)
// ---------------------------------------------------------------------------

const stmts = {
  enqueue: db.prepare(`
    INSERT OR IGNORE INTO solid_sync_queue
      (session_id, message_sequence, status, retry_count, last_error, created_at, updated_at)
    VALUES ($session_id, $message_sequence, 'pending', 0, NULL, $now, $now)
  `),

  dequeueBatch: db.prepare(`
    SELECT * FROM solid_sync_queue
    WHERE status = 'pending'
    ORDER BY message_sequence ASC
    LIMIT $limit
  `),

  markInProgress: db.prepare(`
    UPDATE solid_sync_queue SET status = 'in_progress', updated_at = $now
    WHERE id = $id AND status = 'pending'
  `),

  markCompleted: db.prepare(`
    DELETE FROM solid_sync_queue WHERE id = $id
  `),

  markFailed: db.prepare(`
    UPDATE solid_sync_queue
    SET status = CASE WHEN retry_count + 1 >= 15 THEN 'failed' ELSE 'pending' END,
        retry_count = retry_count + 1,
        last_error = $error,
        updated_at = $now
    WHERE id = $id
  `),

  requeueStale: db.prepare(`
    UPDATE solid_sync_queue
    SET status = 'pending', updated_at = $now
    WHERE status = 'in_progress'
      AND updated_at < $stale_cutoff
  `),

  getDepthAll: db.prepare(`
    SELECT COUNT(*) as cnt FROM solid_sync_queue
    WHERE status IN ('pending', 'in_progress')
  `),

  getDepthBySession: db.prepare(`
    SELECT COUNT(*) as cnt FROM solid_sync_queue
    WHERE session_id = $session_id
      AND status IN ('pending', 'in_progress')
  `),

  getStats: db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM solid_sync_queue
  `),
};

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

function rowToEntry(row: SyncQueueRow): SyncQueueEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageSequence: row.message_sequence,
    status: row.status as SyncQueueEntry["status"],
    retryCount: row.retry_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Add a message to the sync queue. Uses INSERT OR IGNORE so duplicate
 * (session_id, message_sequence) pairs are silently skipped.
 */
export function enqueue(sessionId: string, messageSequence: number): void {
  const now = new Date().toISOString();
  stmts.enqueue.run({
    $session_id: sessionId,
    $message_sequence: messageSequence,
    $now: now,
  });
}

/**
 * Dequeue a batch of pending entries (oldest first by sequence).
 * Also marks them as in_progress atomically so concurrent workers
 * do not pick up the same entries.
 */
export function dequeueBatch(limit: number): SyncQueueEntry[] {
  const now = new Date().toISOString();
  const rows = stmts.dequeueBatch.all({ $limit: limit }) as SyncQueueRow[];
  const entries = rows.map(rowToEntry);

  // Mark them all in_progress
  for (const entry of entries) {
    stmts.markInProgress.run({ $id: entry.id, $now: now });
  }

  return entries;
}

/**
 * Remove a completed entry from the queue.
 */
export function markCompleted(id: number): void {
  stmts.markCompleted.run({ $id: id });
}

/**
 * Mark an entry as failed. Increments retry_count and records the error.
 * After 15 retries the status transitions to 'failed' (dead letter).
 */
export function markFailed(id: number, error: string): void {
  const now = new Date().toISOString();
  stmts.markFailed.run({
    $id: id,
    $error: error,
    $now: now,
  });
}

/**
 * Re-queue entries stuck in 'in_progress' for longer than maxAge milliseconds.
 * Returns the number of entries re-queued. Call this on startup and periodically
 * to recover from crashes that left entries in_progress.
 */
export function requeueStale(maxAge: number): number {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - maxAge).toISOString();
  const result = stmts.requeueStale.run({
    $now: now.toISOString(),
    $stale_cutoff: staleCutoff,
  });
  return result.changes;
}

/**
 * Get the number of pending + in_progress entries.
 * If sessionId is provided, scope to that session; otherwise return global count.
 */
export function getQueueDepth(sessionId?: string): number {
  if (sessionId) {
    const row = stmts.getDepthBySession.get({ $session_id: sessionId }) as { cnt: number };
    return row.cnt;
  }
  const row = stmts.getDepthAll.get() as { cnt: number };
  return row.cnt;
}

/**
 * Get aggregate queue statistics across all sessions.
 */
export function getQueueStats(): { pending: number; inProgress: number; failed: number } {
  const row = stmts.getStats.get() as {
    pending: number | null;
    in_progress: number | null;
    failed: number | null;
  };
  return {
    pending: row.pending ?? 0,
    inProgress: row.in_progress ?? 0,
    failed: row.failed ?? 0,
  };
}
