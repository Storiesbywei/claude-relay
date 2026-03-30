import type { NostrEvent } from "./nostr-types.js";
import type { StoredMessage } from "./types.js";
import { KIND_TO_MESSAGE_TYPE } from "./nostr-constants.js";

/** Convert a Nostr event to a StoredMessage (for display in MCP tools) */
export function eventToMessage(event: NostrEvent): StoredMessage {
  const type = KIND_TO_MESSAGE_TYPE[event.kind] ?? "context";

  const titleTag = event.tags.find((t) => t[0] === "title");
  const senderTag = event.tags.find((t) => t[0] === "sender");

  // Extract searchable tags — only "t" tags, excluding the message type value
  const tags = event.tags
    .filter((t) => t[0] === "t")
    .map((t) => t[1])
    .filter((t) => t !== type);

  // Extract file references
  const references = event.tags
    .filter((t) => t[0] === "r")
    .map((t) => ({
      file: t[1],
      lines: t[2] || undefined,
      note: t[3] || undefined,
    }));

  // Extract context
  const projectTag = event.tags.find((t) => t[0] === "project");
  const stackTag = event.tags.find((t) => t[0] === "stack");
  const branchTag = event.tags.find((t) => t[0] === "branch");
  const context =
    projectTag || stackTag || branchTag
      ? {
          project: projectTag?.[1],
          stack: stackTag?.[1],
          branch: branchTag?.[1],
        }
      : undefined;

  return {
    message_id: event.id,
    sequence: 0, // Assigned by session store, not applicable for Nostr events
    type,
    title: titleTag?.[1] ?? "",
    content: event.content,
    tags: tags.length > 0 ? tags : undefined,
    references: references.length > 0 ? references : undefined,
    context,
    sender_name: senderTag?.[1] ?? `nostr:${event.pubkey.slice(0, 8)}`,
    sent_at: new Date(event.created_at * 1000).toISOString(),
  };
}
