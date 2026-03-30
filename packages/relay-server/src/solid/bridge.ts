/**
 * Bridge between HTTP relay sessions and Solid Pods.
 *
 * Bidirectional:
 * - HTTP POST /relay/:id -> writes message to Solid Pod (outbound)
 * - Solid notification (new resource) -> injects into HTTP session (inbound)
 *
 * Follows the same pattern as nostr/bridge.ts:
 * - bridgeMessageToSolid: outbound (HTTP -> Solid Pod)
 * - bridgeSolidToHttp: inbound (Solid Pod -> HTTP session)
 * - hasMessageFromSolid: dedup check
 */

import type { StoredMessage, SolidExportConfig } from "@claude-relay/shared";
import { RELAY_VOCAB, MESSAGE_TYPE_TO_RDF_CLASS, scanAndGateMessage } from "@claude-relay/shared";
import {
  addMessage,
  getSessionMode,
  hasMessageWithSolidUrl,
} from "../store/sqlite.js";
import { getAuthenticatedSession } from "./auth.js";
import { ensureTrailingSlash } from "./export.js";

// ---------------------------------------------------------------------------
// Per-session Solid federation config — set when federation is enabled
// ---------------------------------------------------------------------------

const federationConfigs = new Map<string, SolidExportConfig>();

/** Register a Solid federation config for a session */
export function setSolidFederationConfig(sessionId: string, config: SolidExportConfig): void {
  federationConfigs.set(sessionId, config);
  console.log(`[solid bridge] Federation enabled for session ${sessionId} -> ${config.podUrl}`);
}

/** Remove federation config for a session */
export function removeSolidFederationConfig(sessionId: string): void {
  federationConfigs.delete(sessionId);
}

/** Get federation config for a session */
export function getSolidFederationConfig(sessionId: string): SolidExportConfig | undefined {
  return federationConfigs.get(sessionId);
}

// ---------------------------------------------------------------------------
// Outbound: HTTP message -> Solid Pod
// ---------------------------------------------------------------------------

/** Build the container URL for a session's messages on a Pod */
function buildMessagesContainerUrl(config: SolidExportConfig, sessionId: string): string {
  const podBase = ensureTrailingSlash(config.podUrl);
  const containerPath = config.containerPath || "relay-sessions/";
  return `${podBase}${ensureTrailingSlash(containerPath)}${sessionId}/messages/`;
}

/**
 * Bridge an HTTP message to a Solid Pod (outbound).
 *
 * Writes the message as a JSON-LD resource in the session's message container.
 * No-ops if no federation config is set for this session.
 */
export async function bridgeMessageToSolid(
  message: StoredMessage,
  sessionId: string
): Promise<void> {
  const config = federationConfigs.get(sessionId);
  if (!config) return; // No Solid federation for this session

  // SECURITY: Signal mode sessions must not leak ciphertext to Solid Pods.
  // All message content in signal mode is E2E encrypted and must stay within
  // the HTTP channel where only participants with the key can decrypt.
  const mode = getSessionMode(sessionId);
  if (mode === 'signal') return;

  // Don't re-bridge messages that came from Solid (loop prevention)
  if (message.solid_resource_url) return;

  try {
    const authSession = await getAuthenticatedSession(config);
    const fetchFn = authSession.fetch.bind(authSession);

    const containerUrl = buildMessagesContainerUrl(config, sessionId);
    const resourceUrl = `${containerUrl}${message.sequence}`;

    // Build JSON-LD payload
    const rdfClass = MESSAGE_TYPE_TO_RDF_CLASS[message.type] || "GenericMessage";
    const jsonLd: Record<string, unknown> = {
      "@context": {
        "relay": RELAY_VOCAB,
        "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      },
      "@id": resourceUrl,
      "@type": `relay:${rdfClass}`,
      "relay:messageId": message.message_id,
      "relay:sequence": message.sequence,
      "relay:messageType": message.type,
      "relay:title": message.title,
      "relay:content": message.content,
      "relay:sentAt": message.sent_at,
      "relay:originProtocol": "http", // Loop prevention marker
    };

    if (message.sender_name) {
      jsonLd["relay:senderName"] = message.sender_name;
    }
    if (message.tags && message.tags.length > 0) {
      jsonLd["relay:tags"] = JSON.stringify(message.tags);
    }
    if (message.references && message.references.length > 0) {
      jsonLd["relay:references"] = JSON.stringify(message.references);
    }
    if (message.context) {
      jsonLd["relay:context"] = JSON.stringify(message.context);
    }
    if (message.nostr_event_id) {
      jsonLd["relay:nostrEventId"] = message.nostr_event_id;
    }

    // Write to Pod using PUT (overwrite if exists)
    const response = await fetchFn(resourceUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/ld+json",
      },
      body: JSON.stringify(jsonLd),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`PUT ${resourceUrl} returned ${response.status}: ${text}`);
    }

    console.log(`[solid bridge] Wrote message ${message.sequence} to ${resourceUrl}`);
  } catch (err: any) {
    // Log but don't throw — bridge failures are non-fatal
    console.error(`[solid bridge] Failed to write message ${message.sequence} to Pod: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Inbound: Solid Pod resource -> HTTP session
// ---------------------------------------------------------------------------

/**
 * Bridge a Solid Pod resource into an HTTP session (inbound).
 *
 * Fetches the resource, parses JSON-LD, converts to StoredMessage,
 * and injects into the session via addMessage().
 *
 * Returns true if the message was injected, false if skipped (dedup/parse error).
 */
export async function bridgeSolidToHttp(
  resourceUrl: string,
  sessionId: string
): Promise<boolean> {
  // SECURITY: Signal mode sessions must not accept bridged messages from Solid.
  // Signal mode guarantees E2E encryption — only the HTTP channel with the
  // encryption key can produce valid messages. Solid-bridged content would
  // bypass encryption enforcement entirely.
  const targetMode = getSessionMode(sessionId);
  if (targetMode === 'signal') {
    console.warn(
      `[solid bridge] Rejected inbound resource ${resourceUrl} — target session is in signal mode`
    );
    return false;
  }

  // Dedup check
  if (hasMessageFromSolid(sessionId, resourceUrl)) {
    return false;
  }

  const config = federationConfigs.get(sessionId);
  if (!config) return false;

  try {
    const authSession = await getAuthenticatedSession(config);
    const fetchFn = authSession.fetch.bind(authSession);

    const response = await fetchFn(resourceUrl, {
      headers: { "Accept": "application/ld+json" },
    });

    if (!response.ok) {
      console.error(`[solid bridge] GET ${resourceUrl} returned ${response.status}`);
      return false;
    }

    const jsonLd = await response.json();

    // Skip messages that originated from HTTP (loop prevention)
    if (jsonLd["relay:originProtocol"] === "http") {
      return false;
    }

    // Convert JSON-LD to StoredMessage
    const message = solidResourceToMessage(jsonLd, resourceUrl);
    if (!message) {
      console.error(`[solid bridge] Failed to parse resource at ${resourceUrl}`);
      return false;
    }

    // Tag protocol origin
    message.origin = "solid";

    // Security: scan bridged content before injecting into HTTP session
    const gate = scanAndGateMessage(message.content, message.title, "solid");
    if (!gate.allowed) return false;

    addMessage(sessionId, message);
    console.log(`[solid bridge] Injected message from ${resourceUrl} into session ${sessionId}`);
    return true;
  } catch (err: any) {
    console.error(`[solid bridge] Failed to bridge ${resourceUrl}: ${err.message}`);
    return false;
  }
}

/**
 * Check if a message was already bridged from Solid (dedup).
 */
export function hasMessageFromSolid(sessionId: string, resourceUrl: string): boolean {
  return hasMessageWithSolidUrl(sessionId, resourceUrl);
}

// ---------------------------------------------------------------------------
// Internal: JSON-LD -> StoredMessage conversion
// ---------------------------------------------------------------------------

/**
 * Parse a Solid Pod JSON-LD resource into a StoredMessage.
 * Returns null if the resource is not a valid relay message.
 */
function solidResourceToMessage(
  jsonLd: Record<string, unknown>,
  resourceUrl: string
): StoredMessage | null {
  try {
    // Extract fields from JSON-LD, handling both prefixed and full URI keys
    const messageId = extractField(jsonLd, "messageId") as string;
    const type = extractField(jsonLd, "messageType") as string;
    const title = extractField(jsonLd, "title") as string;
    const content = extractField(jsonLd, "content") as string;
    const sentAt = extractField(jsonLd, "sentAt") as string;
    const senderName = extractField(jsonLd, "senderName") as string | undefined;
    const tagsStr = extractField(jsonLd, "tags") as string | undefined;
    const referencesStr = extractField(jsonLd, "references") as string | undefined;
    const contextStr = extractField(jsonLd, "context") as string | undefined;
    const nostrEventId = extractField(jsonLd, "nostrEventId") as string | undefined;

    if (!type || !content) {
      return null;
    }

    const msg: StoredMessage = {
      message_id: messageId || crypto.randomUUID(),
      sequence: 0, // Will be assigned by addMessage
      type,
      title: title || "",
      content,
      sender_name: senderName || `solid:${new URL(resourceUrl).hostname}`,
      sent_at: sentAt || new Date().toISOString(),
      solid_resource_url: resourceUrl,
    };

    if (tagsStr) {
      try { msg.tags = JSON.parse(tagsStr); } catch { /* skip */ }
    }
    if (referencesStr) {
      try { msg.references = JSON.parse(referencesStr); } catch { /* skip */ }
    }
    if (contextStr) {
      try { msg.context = JSON.parse(contextStr); } catch { /* skip */ }
    }
    if (nostrEventId) {
      msg.nostr_event_id = nostrEventId;
    }

    return msg;
  } catch {
    return null;
  }
}

/**
 * Extract a field from JSON-LD, checking both prefixed (relay:field)
 * and full URI (https://vocab.claude-relay.dev/field) keys.
 */
function extractField(jsonLd: Record<string, unknown>, fieldName: string): unknown {
  // Check prefixed key first
  const prefixed = `relay:${fieldName}`;
  if (prefixed in jsonLd) return jsonLd[prefixed];

  // Check full URI
  const fullUri = `${RELAY_VOCAB}${fieldName}`;
  if (fullUri in jsonLd) return jsonLd[fullUri];

  return undefined;
}
