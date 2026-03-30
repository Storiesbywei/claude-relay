import { SENSITIVE_PATTERNS } from "@claude-relay/shared";

export interface ScanResult {
  warnings: string[];
  hasSensitive: boolean;
}

export function scanContent(content: string): ScanResult {
  const warnings: string[] = [];

  for (const pattern of SENSITIVE_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      // Redact the actual value in the warning
      const matched = match[0];
      const redacted =
        matched.length > 10
          ? matched.slice(0, 6) + "..." + matched.slice(-4)
          : matched;
      warnings.push(`Potential sensitive content detected: "${redacted}"`);
    }
  }

  // Check for large base64 blobs (>1KB of base64 chars)
  const base64Pattern = /[A-Za-z0-9+/=]{1024,}/;
  if (base64Pattern.test(content)) {
    warnings.push(
      "Large base64-encoded blob detected — may contain binary data"
    );
  }

  return {
    warnings,
    hasSensitive: warnings.length > 0,
  };
}

// --- Tool-Use / Prompt Injection Detection ---

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

/**
 * Strip absolute paths from content, replacing with relative paths
 */
export function sanitizePaths(content: string): string {
  // macOS paths
  let sanitized = content.replace(
    /\/Users\/[a-zA-Z0-9_-]+\/([^\s"'`,)}\]]+)/g,
    "$1"
  );
  // Linux paths
  sanitized = sanitized.replace(
    /\/home\/[a-zA-Z0-9_-]+\/([^\s"'`,)}\]]+)/g,
    "$1"
  );
  return sanitized;
}
