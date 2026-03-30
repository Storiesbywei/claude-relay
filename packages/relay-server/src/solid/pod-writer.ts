/**
 * Write individual messages to a Solid Pod.
 *
 * Used by the Level 2 sync engine to incrementally push messages as they
 * arrive, rather than exporting the entire session at once (Level 1).
 *
 * Reuses the serialization logic from export.ts (messageToDataset) and
 * the auth cache from auth.ts.
 */

import {
  createContainerAt,
  saveSolidDatasetAt,
} from "@inrupt/solid-client";
import type { StoredMessage, SolidExportConfig } from "@claude-relay/shared";
import { getAuthenticatedSession } from "./auth.js";
import { messageToDataset, buildContainerUrl, ensureTrailingSlash } from "./export.js";

// ---------------------------------------------------------------------------
// In-memory cache: tracks which session containers are known to exist on the
// Pod. Avoids redundant createContainerAt calls on every message write.
// ---------------------------------------------------------------------------

const knownContainers = new Set<string>();

/**
 * Check whether a Pod HTTP error indicates "already exists" (409 Conflict)
 * or is otherwise safe to ignore when creating containers.
 */
function isConflictOrAlreadyExists(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("409") || msg.includes("conflict") || msg.includes("already exists");
  }
  return false;
}

/**
 * Ensure the session container hierarchy exists on the Pod.
 *
 * Creates:
 *   <pod>/<containerPath>/<sessionId>/
 *   <pod>/<containerPath>/<sessionId>/messages/
 *
 * Returns the session container URL (with trailing slash).
 * Uses an in-memory cache so the Pod is only contacted once per session
 * per server lifetime.
 */
export async function ensureSessionContainer(
  sessionId: string,
  config: SolidExportConfig,
): Promise<string> {
  const containerUrl = buildContainerUrl(config, sessionId);

  if (knownContainers.has(containerUrl)) {
    return containerUrl;
  }

  const authSession = await getAuthenticatedSession(config);
  const fetchFn = authSession.fetch.bind(authSession);
  const messagesUrl = `${containerUrl}messages/`;

  try {
    await createContainerAt(containerUrl, { fetch: fetchFn });
  } catch (err) {
    if (!isConflictOrAlreadyExists(err)) throw err;
  }

  try {
    await createContainerAt(messagesUrl, { fetch: fetchFn });
  } catch (err) {
    if (!isConflictOrAlreadyExists(err)) throw err;
  }

  knownContainers.add(containerUrl);
  return containerUrl;
}

/**
 * Write a single message to a Solid Pod.
 *
 * 1. Ensures the session container exists (cached after first call).
 * 2. Serializes the message to an RDF dataset using the shared serializer.
 * 3. Writes the dataset to `<container>/messages/<sequence>`.
 *
 * Throws on network or auth errors — the caller (sync engine) is responsible
 * for retry logic.
 */
export async function writeMessageToPod(
  sessionId: string,
  message: StoredMessage,
  config: SolidExportConfig,
): Promise<void> {
  const containerUrl = await ensureSessionContainer(sessionId, config);

  const authSession = await getAuthenticatedSession(config);
  const fetchFn = authSession.fetch.bind(authSession);

  const messageUrl = `${containerUrl}messages/${message.sequence}`;
  const dataset = messageToDataset(message, messageUrl);

  await saveSolidDatasetAt(messageUrl, dataset, { fetch: fetchFn });
}
