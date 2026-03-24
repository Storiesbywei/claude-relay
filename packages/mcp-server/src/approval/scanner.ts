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
