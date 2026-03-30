/**
 * Solid Sync Engine — background worker that drains the sync queue
 * and writes relay messages to Solid Pods.
 *
 * Runs on a 2-second interval, processing up to 10 entries per batch.
 * Handles retries with exponential backoff (up to 60s, max 15 attempts).
 *
 * Lifecycle:
 *   syncEngine.start()   — begin the sync loop
 *   syncEngine.catchUp() — on startup, enqueue any gaps between synced and current sequence
 *   syncEngine.stop()    — halt the sync loop
 */

import type { SyncEngineStats } from "./types.js";
import {
  dequeueBatch,
  markCompleted,
  markFailed,
  requeueRetriable,
  pruneQueue,
  getSolidConfig,
  getAllSolidSessionIds,
  getSyncedSequence,
  updateSyncedSequence,
  getQueueDepth,
  enqueue,
} from "./solid-store.js";
import { writeMessageToPod } from "./pod-writer.js";
import { getSession } from "../store/sqlite.js";

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 2_000;
const MAX_RETRIES = 15;

export class SolidSyncEngine {
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastProcessedAt: string | null = null;

  /** Start the sync loop (checks queue every 2 seconds) */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("[solid-sync] Sync engine started");

    this.interval = setInterval(() => {
      this.processBatch().catch((err) => {
        console.error("[solid-sync] Batch processing error:", err);
      });
    }, POLL_INTERVAL_MS);
  }

  /** Stop the sync loop */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    console.log("[solid-sync] Sync engine stopped");
  }

  /** Process one batch of pending entries */
  private async processBatch(): Promise<void> {
    // Dequeue up to BATCH_SIZE entries that are ready (respecting backoff)
    const entries = dequeueBatch(BATCH_SIZE);
    if (entries.length === 0) {
      // Periodic maintenance: prune completed/permanently-failed entries
      pruneQueue(MAX_RETRIES);
      return;
    }

    // Group entries by sessionId for efficient config lookup
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) {
      const group = grouped.get(entry.sessionId) ?? [];
      group.push(entry);
      grouped.set(entry.sessionId, group);
    }

    for (const [sessionId, sessionEntries] of grouped) {
      const config = getSolidConfig(sessionId);
      const session = getSession(sessionId);

      if (!config) {
        // No Solid config for this session — mark all entries as failed
        for (const entry of sessionEntries) {
          markFailed(entry.id, "No Solid export config for session");
        }
        continue;
      }

      if (!session) {
        // Session no longer exists — mark as failed
        for (const entry of sessionEntries) {
          markFailed(entry.id, "Session not found");
        }
        continue;
      }

      // Process each entry: find the message and write to Pod
      for (const entry of sessionEntries) {
        const message = session.messages.find(
          (m) => m.sequence === entry.sequence
        );

        if (!message) {
          markFailed(
            entry.id,
            `Message with sequence ${entry.sequence} not found in session`
          );
          continue;
        }

        const result = await writeMessageToPod(message, sessionId, config);

        if (result.success) {
          markCompleted(entry.id);
          updateSyncedSequence(sessionId, entry.sequence);
        } else {
          markFailed(entry.id, result.error ?? "Unknown write error");
        }
      }
    }

    this.lastProcessedAt = new Date().toISOString();

    // Re-queue retriable failures (status back to 'pending', backoff on dequeue)
    requeueRetriable(MAX_RETRIES);

    // Prune completed entries to keep queue bounded
    pruneQueue(MAX_RETRIES);
  }

  /**
   * Catch-up: find sessions with unsynced messages and enqueue them.
   * Called on startup to ensure no messages are lost if the engine
   * was down while messages were being added.
   */
  catchUp(): void {
    const sessionIds = getAllSolidSessionIds();
    let totalEnqueued = 0;

    for (const sessionId of sessionIds) {
      const session = getSession(sessionId);
      if (!session) continue;

      const syncedSeq = getSyncedSequence(sessionId);
      const currentSeq = session.sequenceCounter;

      if (syncedSeq < currentSeq) {
        // Enqueue all missing sequence numbers
        for (let seq = syncedSeq + 1; seq <= currentSeq; seq++) {
          enqueue(sessionId, seq);
          totalEnqueued++;
        }
      }
    }

    if (totalEnqueued > 0) {
      console.log(
        `[solid-sync] Catch-up: enqueued ${totalEnqueued} message(s) across ${sessionIds.length} session(s)`
      );
    }
  }

  /** Get engine stats */
  getStats(): SyncEngineStats {
    return {
      running: this.running,
      queueDepth: getQueueDepth(),
      lastProcessedAt: this.lastProcessedAt,
    };
  }
}

// Singleton instance
export const syncEngine = new SolidSyncEngine();
