/**
 * Solid Protocol types for Pod sync integration.
 *
 * These types define the config, queue entries, and status
 * structures used by the sync engine and API routes.
 */

/** Token-based configuration for syncing a session to a Solid Pod */
export interface SolidTokenConfig {
  /** URL of the target Solid Pod container (e.g. https://pod.example.org/relay/) */
  podUrl: string;
  /** WebID of the Pod owner */
  webId: string;
  /** Access token for authenticating writes to the Pod */
  accessToken: string;
  /** Optional: refresh token for token rotation */
  refreshToken?: string;
  /** When this config was enabled */
  enabledAt: string;
}

/** Status of a single sync queue entry */
export type SyncQueueStatus = "pending" | "completed" | "failed";

/** A queued item representing a message to be synced to a Pod */
export interface SyncQueueEntry {
  /** Unique queue entry ID */
  id: string;
  /** Session this message belongs to */
  sessionId: string;
  /** Message sequence number within the session */
  sequence: number;
  /** Current sync status */
  status: SyncQueueStatus;
  /** Number of retry attempts */
  retryCount: number;
  /** Error message if status is 'failed' */
  error?: string;
  /** When this entry was created */
  createdAt: string;
  /** When this entry was last updated */
  updatedAt: string;
}

/** Stats returned by the sync engine */
export interface SyncEngineStats {
  running: boolean;
  queueDepth: number;
  lastProcessedAt: string | null;
}

/** Status of Solid sync for a specific session */
export interface SolidSyncStatus {
  enabled: boolean;
  podUrl: string | null;
  syncedSequence: number;
  currentSequence: number;
  queueDepth: number;
  lastError: string | null;
}

/** Result of writing a message to a Pod */
export interface PodWriteResult {
  success: boolean;
  resourceUrl?: string;
  error?: string;
}
