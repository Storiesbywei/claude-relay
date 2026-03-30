/**
 * Export a relay session to a Solid Pod as JSON-LD resources.
 *
 * Container structure:
 *   <pod>/relay-sessions/<sessionId>/
 *     metadata.jsonld   — session metadata with participant info
 *     messages/
 *       <sequence>.jsonld — one resource per message
 */

import {
  createContainerAt,
  saveSolidDatasetAt,
  createSolidDataset,
  createThing,
  setThing,
  setStringNoLocale,
  setDatetime,
  setInteger,
  setUrl,
} from "@inrupt/solid-client";
import type { SolidDataset } from "@inrupt/solid-client";
import {
  RELAY_VOCAB,
  MESSAGE_TYPE_TO_RDF_CLASS,
  type SolidExportConfig,
  type SolidExportResult,
  type StoredMessage,
  type Session,
} from "@claude-relay/shared";
import { getSession, getMessages, getParticipantNames } from "../store/sqlite.js";
import { getAuthenticatedSession } from "./auth.js";

/** Ensure a URL ends with "/" */
function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/** Build the container URL for a session export */
function buildContainerUrl(config: SolidExportConfig, sessionId: string): string {
  const podBase = ensureTrailingSlash(config.podUrl);
  const containerPath = config.containerPath || "relay-sessions/";
  return `${podBase}${ensureTrailingSlash(containerPath)}${sessionId}/`;
}

/** Serialize a StoredMessage to a Solid Thing within a Dataset */
function messageToDataset(
  message: StoredMessage,
  resourceUrl: string
): SolidDataset {
  const rdfClass =
    MESSAGE_TYPE_TO_RDF_CLASS[message.type] || "GenericMessage";

  let thing = createThing({ url: resourceUrl });

  // RDF type
  thing = setUrl(thing, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", `${RELAY_VOCAB}${rdfClass}`);

  // Core properties
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}messageId`, message.message_id);
  thing = setInteger(thing, `${RELAY_VOCAB}sequence`, message.sequence);
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}messageType`, message.type);
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}title`, message.title);
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}content`, message.content);
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}sentAt`, message.sent_at);

  // Optional sender
  if (message.sender_name) {
    thing = setStringNoLocale(thing, `${RELAY_VOCAB}senderName`, message.sender_name);
  }

  // Tags — stored as JSON array string (Solid doesn't natively support arrays well)
  if (message.tags && message.tags.length > 0) {
    thing = setStringNoLocale(thing, `${RELAY_VOCAB}tags`, JSON.stringify(message.tags));
  }

  // References — stored as JSON
  if (message.references && message.references.length > 0) {
    thing = setStringNoLocale(
      thing,
      `${RELAY_VOCAB}references`,
      JSON.stringify(message.references)
    );
  }

  // Context — stored as JSON
  if (message.context) {
    thing = setStringNoLocale(
      thing,
      `${RELAY_VOCAB}context`,
      JSON.stringify(message.context)
    );
  }

  let dataset = createSolidDataset();
  dataset = setThing(dataset, thing);
  return dataset;
}

/** Serialize session metadata to a Solid Dataset */
function sessionMetadataToDataset(
  session: Session,
  metadataUrl: string
): SolidDataset {
  let thing = createThing({ url: metadataUrl });

  thing = setUrl(thing, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", `${RELAY_VOCAB}RelaySession`);
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}sessionId`, session.id);
  thing = setStringNoLocale(thing, `${RELAY_VOCAB}sessionName`, session.name);
  thing = setInteger(thing, `${RELAY_VOCAB}messageCount`, session.messages.length);
  thing = setInteger(thing, `${RELAY_VOCAB}sequenceCounter`, session.sequenceCounter);
  thing = setDatetime(thing, `${RELAY_VOCAB}createdAt`, session.createdAt);
  thing = setDatetime(thing, `${RELAY_VOCAB}expiresAt`, session.expiresAt);
  thing = setDatetime(thing, `${RELAY_VOCAB}lastActivityAt`, session.lastActivityAt);
  thing = setDatetime(thing, `${RELAY_VOCAB}exportedAt`, new Date());

  // Participants as JSON array of names (not tokens — never export auth tokens)
  const participantNames = getParticipantNames(session);
  thing = setStringNoLocale(
    thing,
    `${RELAY_VOCAB}participants`,
    JSON.stringify(participantNames)
  );

  // Participant count
  thing = setInteger(
    thing,
    `${RELAY_VOCAB}participantCount`,
    participantNames.length
  );

  let dataset = createSolidDataset();
  dataset = setThing(dataset, thing);
  return dataset;
}

/**
 * Export a relay session to a Solid Pod.
 *
 * Creates container hierarchy and writes each message as a separate resource.
 */
export async function exportSessionToPod(
  sessionId: string,
  config: SolidExportConfig
): Promise<SolidExportResult> {
  // Fetch session from the in-memory store
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Authenticate with the Solid Pod
  const authSession = await getAuthenticatedSession(config);
  const fetchFn = authSession.fetch.bind(authSession);

  // Build container URLs
  const containerUrl = buildContainerUrl(config, sessionId);
  const messagesContainerUrl = `${containerUrl}messages/`;
  const metadataUrl = `${containerUrl}metadata`;

  // Create containers
  await createContainerAt(containerUrl, { fetch: fetchFn });
  await createContainerAt(messagesContainerUrl, { fetch: fetchFn });

  // Write session metadata
  const metadataDataset = sessionMetadataToDataset(session, metadataUrl);
  await saveSolidDatasetAt(metadataUrl, metadataDataset, { fetch: fetchFn });

  // Write each message as a separate resource
  for (const message of session.messages) {
    const messageUrl = `${messagesContainerUrl}${message.sequence}`;
    const messageDataset = messageToDataset(message, messageUrl);
    await saveSolidDatasetAt(messageUrl, messageDataset, { fetch: fetchFn });
  }

  const exportedAt = new Date().toISOString();

  return {
    containerUrl,
    messageCount: session.messages.length,
    metadataUrl,
    exportedAt,
  };
}
