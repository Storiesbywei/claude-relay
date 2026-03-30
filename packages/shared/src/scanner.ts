import { SENSITIVE_PATTERNS } from "./constants.js";

export interface ScanResult {
  warnings: string[];
  hasSensitive: boolean;
}

// ---------------------------------------------------------------------------
// Unicode steganography detection
// ---------------------------------------------------------------------------

/** Dangerous Unicode ranges used for steganography */
const INVISIBLE_CHARS = [
  /[\u200B-\u200F]/g,           // Zero-width spaces, joiners, directional marks
  /[\u2028-\u2029]/g,           // Line/paragraph separators
  /[\u2060-\u2064]/g,           // Word joiner, invisible operators
  /[\uFEFF]/g,                  // BOM / zero-width no-break space
  /[\uE0000-\uE007F]/gu,       // Tags block (Unicode steganography)
  /[\u00AD]/g,                  // Soft hyphen
  /[\u034F]/g,                  // Combining grapheme joiner
  /[\u061C]/g,                  // Arabic letter mark
  /[\u115F-\u1160]/g,          // Hangul fillers
  /[\u17B4-\u17B5]/g,          // Khmer vowel inherent
  /[\u180E]/g,                  // Mongolian vowel separator
  /[\u3164]/g,                  // Hangul filler
  /[\uFFA0]/g,                  // Halfwidth Hangul filler
];

/**
 * Strip dangerous invisible Unicode characters from content.
 * Returns the cleaned string and a count of characters removed.
 */
export function sanitizeUnicode(content: string): { clean: string; strippedCount: number } {
  let strippedCount = 0;
  let clean = content;
  for (const pattern of INVISIBLE_CHARS) {
    const matches = clean.match(pattern);
    if (matches) strippedCount += matches.length;
    clean = clean.replace(pattern, '');
  }
  return { clean, strippedCount };
}

// ---------------------------------------------------------------------------
// Bidirectional text override detection
// ---------------------------------------------------------------------------

/** Bidi override characters that can make text display differently than stored */
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Detect bidirectional text override characters.
 * These can trick reviewers into seeing different content than what is actually stored.
 */
export function detectBidiOverrides(content: string): boolean {
  return BIDI_OVERRIDES.test(content);
}

// ---------------------------------------------------------------------------
// Normalization layer for pattern matching
// ---------------------------------------------------------------------------

/**
 * Normalize content for more robust pattern matching.
 * Converts fullwidth characters to ASCII and normalizes common leet speak.
 */
function normalizeForScanning(content: string): string {
  let normalized = content;
  // Normalize Unicode fullwidth chars (U+FF01–U+FF5E) → ASCII equivalents
  normalized = normalized.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
  // Normalize common leet speak substitutions
  normalized = normalized
    .replace(/[0Oo]/g, 'o')
    .replace(/[1lI|]/g, 'l')
    .replace(/[3]/g, 'e')
    .replace(/[@4]/g, 'a')
    .replace(/[5$]/g, 's');
  return normalized;
}

// ---------------------------------------------------------------------------
// Markdown exfiltration pattern
// ---------------------------------------------------------------------------

/** Detect Markdown image/link URLs with long base64-encoded query params (data exfil) */
const MD_IMAGE_EXFIL = /!\[[^\]]*\]\(https?:\/\/[^)]*[?&][A-Za-z0-9+/=]{20,}/;

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export function scanContent(content: string): ScanResult {
  const warnings: string[] = [];

  // Phase 1: Detect Unicode steganography
  const { clean, strippedCount } = sanitizeUnicode(content);
  if (strippedCount > 0) {
    warnings.push(
      `${strippedCount} invisible Unicode character(s) stripped — possible steganography`
    );
  }

  // Phase 2: Detect bidi overrides (check ORIGINAL content, before stripping)
  if (detectBidiOverrides(content)) {
    warnings.push(
      "Bidirectional text override characters detected — content may display differently than stored"
    );
  }

  // Phase 3: Normalize for broader pattern matching
  const normalized = normalizeForScanning(clean);

  // Phase 4: Run existing regex patterns against BOTH cleaned and normalized content
  for (const pattern of SENSITIVE_PATTERNS) {
    const match = clean.match(pattern) || normalized.match(pattern);
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

  // Phase 5: Check for large base64 blobs (>1KB of base64 chars)
  const base64Pattern = /[A-Za-z0-9+/=]{1024,}/;
  if (base64Pattern.test(clean)) {
    warnings.push(
      "Large base64-encoded blob detected — may contain binary data"
    );
  }

  // Phase 6: Markdown exfiltration detection
  if (MD_IMAGE_EXFIL.test(clean)) {
    warnings.push(
      "Potential data exfiltration via Markdown image URL"
    );
  }

  return {
    warnings,
    hasSensitive: warnings.length > 0,
  };
}

/**
 * Emit a structured JSON log for content scan events.
 * Enables monitoring/alerting on blocked content across all protocol bridges.
 */
export function logScanEvent(
  protocol: string,
  action: "allowed" | "blocked",
  details?: string
): void {
  const timestamp = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: "content_scan",
      timestamp,
      protocol,
      action,
      details,
    })
  );
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
