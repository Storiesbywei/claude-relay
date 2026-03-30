// Re-export scanner from shared package — single source of truth
export { scanContent, sanitizePaths, sanitizeUnicode, detectBidiOverrides } from "@claude-relay/shared";
export type { ScanResult } from "@claude-relay/shared";

// --- Tool-Use / Prompt Injection Detection (MCP-server specific) ---

/** Patterns that suggest prompt injection / tool-use instructions */
const TOOL_USE_PATTERNS: RegExp[] = [
  // Direct tool invocation attempts
  /relay_send|relay_poll|relay_create|relay_approve/i,
  /relay_share_workspace|relay_export/i,
  /relay_nostr_connect|relay_nostr_pool/i,
  // Shell/code execution instructions
  /\b(exec|eval|system|spawn|shell)\s*\(/i,
  /\bchild_process\b/i,
  /\b(rm\s+-rf|curl\s+.*\|.*sh|wget\s+.*\|.*bash)/i,
  // Prompt injection markers
  /ignore\s+(previous|above|all)\s+(instructions?|prompts?|rules?)/i,
  /\byou\s+are\s+(now|a)\b.*\b(assistant|helper|tool)\b/i,
  /\bsystem\s*:\s*/i,
  /\<\/?system\>/i,
  // Data exfiltration instructions
  /\b(exfiltrate|steal|extract|leak|dump)\b.*\b(key|token|secret|password|credential)/i,
  /\bread\s+.*\.(env|pem|key|secret)/i,
  // Base64 encode and send patterns
  /base64.*send|encode.*relay|btoa.*post/i,
];

export interface ToolUseScanResult {
  suspicious: boolean;
  patterns: string[];
}

export function scanForToolUsePatterns(content: string): ToolUseScanResult {
  const found: string[] = [];
  for (const pattern of TOOL_USE_PATTERNS) {
    if (pattern.test(content)) {
      found.push(pattern.source.slice(0, 50));
    }
  }
  return { suspicious: found.length > 0, patterns: found };
}

// --- Scanner Statistics ---

let scannerStats = {
  totalScanned: 0,
  sensitiveBlocked: 0,
  toolUseDetected: 0,
  recentEvents: [] as ScanEvent[],
};

export interface ScanEvent {
  timestamp: string;
  type: "sensitive" | "tool_use";
  summary: string;
}

const MAX_RECENT_EVENTS = 20;

export function recordScanEvent(type: ScanEvent["type"], summary: string): void {
  scannerStats.totalScanned++;
  if (type === "sensitive") scannerStats.sensitiveBlocked++;
  if (type === "tool_use") scannerStats.toolUseDetected++;

  scannerStats.recentEvents.unshift({
    timestamp: new Date().toISOString(),
    type,
    summary,
  });
  if (scannerStats.recentEvents.length > MAX_RECENT_EVENTS) {
    scannerStats.recentEvents = scannerStats.recentEvents.slice(0, MAX_RECENT_EVENTS);
  }
}

export function getScannerStats() {
  return { ...scannerStats };
}
