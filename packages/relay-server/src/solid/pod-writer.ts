/**
 * Pod writer — writes relay messages to a Solid Pod as Turtle (RDF) resources.
 *
 * Each message becomes a resource in the Pod container at:
 *   {podUrl}/{sessionId}/message-{sequence}.ttl
 *
 * Uses HTTP PUT with Turtle content type to create resources
 * in the Solid Pod, authenticated via DPoP/Bearer tokens.
 */

import type { StoredMessage } from "@claude-relay/shared";
import type { SolidExportConfig, PodWriteResult } from "./types.js";

/**
 * Serialize a StoredMessage to Turtle (RDF) format.
 * Uses the Solid/Activity Streams vocabulary where applicable.
 */
function messageToTurtle(message: StoredMessage, sessionId: string): string {
  const escapeTtl = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  const lines: string[] = [
    `@prefix relay: <https://vocab.claude-relay.dev/ns#> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
    `@prefix dcterms: <http://purl.org/dc/terms/> .`,
    ``,
    `<> a relay:Message ;`,
    `  relay:messageId "${escapeTtl(message.message_id)}" ;`,
    `  relay:sessionId "${escapeTtl(sessionId)}" ;`,
    `  relay:sequence ${message.sequence} ;`,
    `  relay:messageType "${escapeTtl(message.type)}" ;`,
    `  dcterms:title "${escapeTtl(message.title || "")}" ;`,
    `  relay:content "${escapeTtl(message.content)}" ;`,
    `  dcterms:created "${message.sent_at}"^^xsd:dateTime ;`,
  ];

  if (message.sender_name) {
    lines.push(
      `  relay:senderName "${escapeTtl(message.sender_name)}" ;`
    );
  }

  if (message.tags && message.tags.length > 0) {
    const tagValues = message.tags
      .map((t) => `"${escapeTtl(t)}"`)
      .join(", ");
    lines.push(`  relay:tag ${tagValues} ;`);
  }

  if (message.context) {
    if (message.context.project) {
      lines.push(
        `  relay:project "${escapeTtl(message.context.project)}" ;`
      );
    }
    if (message.context.stack) {
      lines.push(
        `  relay:stack "${escapeTtl(message.context.stack)}" ;`
      );
    }
    if (message.context.branch) {
      lines.push(
        `  relay:branch "${escapeTtl(message.context.branch)}" ;`
      );
    }
  }

  // Replace trailing semicolon with period on the last triple
  const lastIdx = lines.length - 1;
  lines[lastIdx] = lines[lastIdx].replace(/ ;$/, " .");

  return lines.join("\n") + "\n";
}

/**
 * Build the resource URL for a message within a Pod container.
 */
function buildResourceUrl(
  podUrl: string,
  sessionId: string,
  sequence: number
): string {
  // Ensure podUrl ends with /
  const base = podUrl.endsWith("/") ? podUrl : podUrl + "/";
  return `${base}${sessionId}/message-${sequence}.ttl`;
}

/**
 * Write a single message to the Solid Pod.
 *
 * Creates a Turtle resource via HTTP PUT.
 * Returns success/failure with optional resource URL or error.
 */
export async function writeMessageToPod(
  message: StoredMessage,
  sessionId: string,
  config: SolidExportConfig
): Promise<PodWriteResult> {
  const resourceUrl = buildResourceUrl(config.podUrl, sessionId, message.sequence);
  const turtle = messageToTurtle(message, sessionId);

  try {
    const response = await fetch(resourceUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "text/turtle",
        Authorization: `Bearer ${config.accessToken}`,
      },
      body: turtle,
    });

    if (response.ok || response.status === 201) {
      return { success: true, resourceUrl };
    }

    const body = await response.text().catch(() => "");
    return {
      success: false,
      error: `Pod write failed: HTTP ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Pod write error: ${err.message || String(err)}`,
    };
  }
}

/**
 * Validate that we can authenticate against a Pod URL.
 * Attempts a HEAD request on the container.
 */
export async function validatePodAccess(
  config: SolidExportConfig
): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch(config.podUrl, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
      },
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        error: `Authentication failed: HTTP ${response.status}`,
      };
    }

    // Other status codes might be fine (e.g. 404 means container doesn't exist yet)
    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: `Cannot reach Pod: ${err.message || String(err)}`,
    };
  }
}
