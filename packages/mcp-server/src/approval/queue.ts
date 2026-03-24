import type { PendingMessage, RelayMessagePayload } from "@claude-relay/shared";
import { scanContent, sanitizePaths } from "./scanner.js";

const pendingQueue = new Map<string, PendingMessage>();

export function stageMessage(
  sessionId: string,
  payload: RelayMessagePayload
): PendingMessage {
  const id = crypto.randomUUID();

  // Scan for sensitive content
  const { warnings } = scanContent(payload.content);

  // Also scan title and tags
  const titleScan = scanContent(payload.title);
  warnings.push(...titleScan.warnings);

  if (payload.tags) {
    for (const tag of payload.tags) {
      const tagScan = scanContent(tag);
      warnings.push(...tagScan.warnings);
    }
  }

  // Sanitize absolute paths in references
  if (payload.references) {
    payload.references = payload.references.map((ref) => ({
      ...ref,
      file: sanitizePaths(ref.file),
      note: ref.note ? sanitizePaths(ref.note) : ref.note,
    }));
  }

  // Sanitize content
  payload.content = sanitizePaths(payload.content);

  const pending: PendingMessage = {
    id,
    sessionId,
    payload,
    warnings,
    createdAt: new Date(),
  };

  pendingQueue.set(id, pending);
  return pending;
}

export function getPending(id: string): PendingMessage | undefined {
  return pendingQueue.get(id);
}

export function removePending(id: string): boolean {
  return pendingQueue.delete(id);
}

export function listPending(): PendingMessage[] {
  return Array.from(pendingQueue.values());
}

export function getPendingCount(): number {
  return pendingQueue.size;
}

export function generatePreview(pending: PendingMessage): string {
  const { payload, warnings } = pending;
  const byteSize = new TextEncoder().encode(payload.content).length;
  const contentPreview =
    payload.content.length > 200
      ? payload.content.slice(0, 200) + "..."
      : payload.content;

  let preview = `Will share: [${payload.type}] "${payload.title}" (${byteSize} bytes)\n`;
  preview += `Session: ${pending.sessionId}\n`;
  preview += `\nContent preview:\n${contentPreview}\n`;

  if (payload.references?.length) {
    preview += `\nReferenced files:\n`;
    for (const ref of payload.references) {
      preview += `  - ${ref.file}${ref.lines ? `:${ref.lines}` : ""}${ref.note ? ` (${ref.note})` : ""}\n`;
    }
  }

  if (payload.tags?.length) {
    preview += `\nTags: ${payload.tags.join(", ")}\n`;
  }

  if (warnings.length > 0) {
    preview += `\n⚠ WARNINGS:\n`;
    for (const w of warnings) {
      preview += `  - ${w}\n`;
    }
  }

  return preview;
}
