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
  enqueue,
  dequeueBatch,
  markCompleted,
  markFailed,
  requeueStale,
  getQueueDepth,
} from "./sync-queue.js";
import { writeMessageToPod } from "./pod-writer.js";
import {
  getSession,
  getSolidConfig,
  getSolidEnabledSessions,
  getPodSyncedSequence,
  setPodSyncedSequence,
  getMessageBySequence,
} from "../store/sqlite.js";

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
    // Re-queue entries stuck in_progress for >60s (crash recovery)
    requeueStale(60_000);

    // Dequeue up to BATCH_SIZE entries (marks them in_progress atomically)
    const entries = dequeueBatch(BATCH_SIZE);
    if (entries.length === 0) return;

    // Group entries by sessionId for efficient config lookup
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) {
      const group = grouped.get(entry.sessionId) ?? [];
      group.push(entry);
      grouped.set(entry.sessionId, group);
    }

    for (const [sessionId, sessionEntries] of grouped) {
      const config = getSolidConfig(sessionId);

      if (!config) {
        for (const entry of sessionEntries) {
          markFailed(entry.id, "No Solid export config for session");
        }
        continue;
      }

      // Process each entry: look up message by sequence (O(1) indexed query)
      for (const entry of sessionEntries) {
        const message = getMessageBySequence(sessionId, entry.messageSequence);

        if (!message) {
          markFailed(
            entry.id,
            `Message with sequence ${entry.messageSequence} not found in session`
          );
          continue;
        }

        try {
          await writeMessageToPod(sessionId, message, config);
          markCompleted(entry.id);
          setPodSyncedSequence(sessionId, entry.messageSequence);
        } catch (err: any) {
          markFailed(entry.id, err.message ?? "Unknown write error");
        }
      }
    }

    this.lastProcessedAt = new Date().toISOString();
  }

  /**
   * Catch-up: find sessions with unsynced messages and enqueue them.
   * Called on startup to ensure no messages are lost if the engine
   * was down while messages were being added.
   */
  catchUp(): void {
    const enabledSessions = getSolidEnabledSessions();
    let totalEnqueued = 0;

    for (const { sessionId, lastSynced } of enabledSessions) {
      const session = getSession(sessionId);
      if (!session) continue;

      const currentSeq = session.sequenceCounter;

      if (lastSynced < currentSeq) {
        for (let seq = lastSynced + 1; seq <= currentSeq; seq++) {
          enqueue(sessionId, seq);
          totalEnqueued++;
        }
      }
    }

    if (totalEnqueued > 0) {
      console.log(
        `[solid-sync] Catch-up: enqueued ${totalEnqueued} message(s) across ${enabledSessions.length} session(s)`
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
