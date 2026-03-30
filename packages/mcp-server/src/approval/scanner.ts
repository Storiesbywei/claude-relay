// Re-export scanner from shared package — single source of truth
export { scanContent, sanitizePaths, sanitizeUnicode, detectBidiOverrides } from "@claude-relay/shared";
export type { ScanResult } from "@claude-relay/shared";
