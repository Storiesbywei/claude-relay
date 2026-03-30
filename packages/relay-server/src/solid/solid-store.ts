/**
 * In-memory store for Solid sync state.
 *
 * Tracks per-session export configs, sync queue entries, and
 * synced-sequence watermarks. This mirrors the existing relay
 * pattern of in-memory Maps with O(1) lookups.
 */

import type {
  SolidExportConfig,
  SyncQueueEntry,
  SyncQueueStatus,
} from "./types.js";

// Session ID → Solid export config
const solidConfigs = new Map<string, SolidExportConfig>();

// Sync queue: ordered list of entries waiting to be written to Pods
const syncQueue: SyncQueueEntry[] = [];

// Session ID → highest sequence number successfully synced
const syncedSequences = new Map<string, number>();

// Session ID → last error encountered
const lastErrors = new Map<string, string>();

// ---------- Config management ----------

export function setSolidConfig(
  sessionId: string,
  config: SolidExportConfig
): void {
  solidConfigs.set(sessionId, config);
  // Initialize synced sequence if not already tracked
  if (!syncedSequences.has(sessionId)) {
    syncedSequences.set(sessionId, 0);
  }
}

export function getSolidConfig(
  sessionId: string
): SolidExportConfig | undefined {
  return solidConfigs.get(sessionId);
}

export function hasSolidConfig(sessionId: string): boolean {
  return solidConfigs.has(sessionId);
}

export function removeSolidConfig(sessionId: string): void {
  solidConfigs.delete(sessionId);
  // Don't delete synced sequence — preserve for status queries
}

export function getAllSolidSessionIds(): string[] {
  return Array.from(solidConfigs.keys());
}

export function getEnabledSessionCount(): number {
  return solidConfigs.size;
}

// ---------- Sync queue management ----------

export function enqueue(sessionId: string, sequence: number): void {
  const now = new Date().toISOString();
  const entry: SyncQueueEntry = {
    id: crypto.randomUUID(),
    sessionId,
    sequence,
    status: "pending",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  syncQueue.push(entry);
}

/**
 * Dequeue up to `limit` entries that are pending and ready for processing.
 * Respects backoff: entries whose updatedAt is too recent (based on retryCount)
 * are skipped.
 */
export function dequeueBatch(limit: number): SyncQueueEntry[] {
  const now = Date.now();
  const ready: SyncQueueEntry[] = [];

  for (const entry of syncQueue) {
    if (ready.length >= limit) break;
    if (entry.status !== "pending") continue;

    // Check backoff delay for retried entries
    if (entry.retryCount > 0) {
      const backoffMs = Math.min(
        60_000,
        1000 * Math.pow(2, entry.retryCount)
      );
      const updatedAt = new Date(entry.updatedAt).getTime();
      if (now - updatedAt < backoffMs) continue;
    }

    ready.push(entry);
  }

  return ready;
}

export function markCompleted(entryId: string): void {
  const entry = syncQueue.find((e) => e.id === entryId);
  if (entry) {
    entry.status = "completed";
    entry.updatedAt = new Date().toISOString();
  }
}

export function markFailed(entryId: string, error: string): void {
  const entry = syncQueue.find((e) => e.id === entryId);
  if (entry) {
    entry.status = "failed";
    entry.error = error;
    entry.retryCount++;
    entry.updatedAt = new Date().toISOString();
    lastErrors.set(entry.sessionId, error);
  }
}

/**
 * Re-queue failed entries that haven't exceeded max retries.
 * Resets their status to 'pending' (backoff enforced on dequeue).
 */
export function requeueRetriable(maxRetries: number = 15): number {
  let requeued = 0;
  for (const entry of syncQueue) {
    if (entry.status === "failed" && entry.retryCount < maxRetries) {
      entry.status = "pending";
      // updatedAt stays as-is so backoff delay is respected
      requeued++;
    }
  }
  return requeued;
}

/**
 * Remove completed and permanently-failed entries from the queue.
 * Called periodically to prevent unbounded growth.
 */
export function pruneQueue(maxRetries: number = 15): number {
  const before = syncQueue.length;
  let i = 0;
  while (i < syncQueue.length) {
    const entry = syncQueue[i];
    if (
      entry.status === "completed" ||
      (entry.status === "failed" && entry.retryCount >= maxRetries)
    ) {
      syncQueue.splice(i, 1);
    } else {
      i++;
    }
  }
  return before - syncQueue.length;
}

// ---------- Sequence tracking ----------

export function getSyncedSequence(sessionId: string): number {
  return syncedSequences.get(sessionId) ?? 0;
}

export function updateSyncedSequence(
  sessionId: string,
  sequence: number
): void {
  const current = syncedSequences.get(sessionId) ?? 0;
  if (sequence > current) {
    syncedSequences.set(sessionId, sequence);
  }
}

// ---------- Stats ----------

export function getQueueDepth(): number {
  return syncQueue.filter((e) => e.status === "pending").length;
}

export function getSessionQueueDepth(sessionId: string): number {
  return syncQueue.filter(
    (e) => e.sessionId === sessionId && e.status === "pending"
  ).length;
}

export function getLastError(sessionId: string): string | null {
  return lastErrors.get(sessionId) ?? null;
}
