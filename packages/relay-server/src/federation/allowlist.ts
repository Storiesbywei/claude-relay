/**
 * Federation Allowlist — deny-by-default for external Nostr relays and Solid Pods.
 *
 * Sources (in priority order):
 *   1. Runtime additions via HTTP API (stored in-memory, lost on restart)
 *   2. Environment variables (RELAY_NOSTR_ALLOWLIST, RELAY_SOLID_ALLOWLIST)
 *   3. FEDERATION_DEFAULTS from shared constants (empty = deny all)
 *
 * When RELAY_FEDERATION_ENABLED is false (default), ALL external federation
 * is blocked regardless of allowlist contents.
 */

import { FEDERATION_DEFAULTS } from "@claude-relay/shared";

// ---- Types ----

export type FederationProtocol = "nostr" | "solid";

export interface AllowlistEntry {
  protocol: FederationProtocol;
  url: string;
  added_at: string; // ISO-8601
}

export interface FederationStatus {
  enabled: boolean;
  nostr_allowlist: string[];
  solid_allowlist: string[];
  nostr_denied_count: number;
  solid_denied_count: number;
}

// ---- State ----

/** In-memory allowlist (runtime additions via API) */
const runtimeAllowlist: AllowlistEntry[] = [];

/** Denied request counters */
let nostrDeniedCount = 0;
let solidDeniedCount = 0;

// ---- Environment parsing ----

/** Parse a comma-separated env var into a trimmed, non-empty string array */
function parseEnvList(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Whether federation is globally enabled */
export function isFederationEnabled(): boolean {
  const envValue = process.env.RELAY_FEDERATION_ENABLED;
  if (envValue !== undefined) {
    return envValue === "true" || envValue === "1";
  }
  return FEDERATION_DEFAULTS.FEDERATION_ENABLED;
}

// ---- Allowlist accessors ----

/** Get the merged Nostr relay allowlist (env + defaults + runtime) */
export function getNostrAllowlist(): string[] {
  const envList = parseEnvList(process.env.RELAY_NOSTR_ALLOWLIST);
  const defaultList = [...FEDERATION_DEFAULTS.NOSTR_RELAY_ALLOWLIST];
  const runtimeList = runtimeAllowlist
    .filter((e) => e.protocol === "nostr")
    .map((e) => e.url);

  // Deduplicate
  return [...new Set([...defaultList, ...envList, ...runtimeList])];
}

/** Get the merged Solid Pod allowlist (env + defaults + runtime) */
export function getSolidAllowlist(): string[] {
  const envList = parseEnvList(process.env.RELAY_SOLID_ALLOWLIST);
  const defaultList = [...FEDERATION_DEFAULTS.SOLID_POD_ALLOWLIST];
  const runtimeList = runtimeAllowlist
    .filter((e) => e.protocol === "solid")
    .map((e) => e.url);

  // Deduplicate
  return [...new Set([...defaultList, ...envList, ...runtimeList])];
}

// ---- Guard functions ----

/**
 * Check if a Nostr relay URL is allowed for federation.
 *
 * Rules:
 * - If federation is disabled globally, always deny.
 * - If allowlist is non-empty, URL must match an entry (prefix match).
 * - If allowlist is empty and federation is enabled, allow all (open federation).
 */
export function isNostrRelayAllowed(url: string): boolean {
  if (!isFederationEnabled()) {
    nostrDeniedCount++;
    console.log(`[federation] DENIED nostr relay (federation disabled): ${url}`);
    return false;
  }

  const allowlist = getNostrAllowlist();

  // Empty allowlist + federation enabled = allow all (open federation)
  if (allowlist.length === 0) {
    console.log(`[federation] ALLOWED nostr relay (open federation): ${url}`);
    return true;
  }

  // Check prefix match against allowlist entries
  const allowed = allowlist.some((entry) => url.startsWith(entry));

  if (allowed) {
    console.log(`[federation] ALLOWED nostr relay: ${url}`);
  } else {
    nostrDeniedCount++;
    console.log(`[federation] DENIED nostr relay (not in allowlist): ${url}`);
  }

  return allowed;
}

/**
 * Check if a Solid Pod URL is allowed for federation.
 *
 * Same rules as isNostrRelayAllowed but for Solid Pods.
 */
export function isSolidPodAllowed(url: string): boolean {
  if (!isFederationEnabled()) {
    solidDeniedCount++;
    console.log(`[federation] DENIED solid pod (federation disabled): ${url}`);
    return false;
  }

  const allowlist = getSolidAllowlist();

  // Empty allowlist + federation enabled = allow all (open federation)
  if (allowlist.length === 0) {
    console.log(`[federation] ALLOWED solid pod (open federation): ${url}`);
    return true;
  }

  // Check prefix match against allowlist entries
  const allowed = allowlist.some((entry) => url.startsWith(entry));

  if (allowed) {
    console.log(`[federation] ALLOWED solid pod: ${url}`);
  } else {
    solidDeniedCount++;
    console.log(`[federation] DENIED solid pod (not in allowlist): ${url}`);
  }

  return allowed;
}

// ---- Runtime management ----

/** Add a URL to the runtime allowlist. Returns true if added, false if duplicate. */
export function addToAllowlist(protocol: FederationProtocol, url: string): boolean {
  // Validate URL format
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Protocol-specific URL scheme validation
  if (protocol === "nostr" && !url.startsWith("wss://") && !url.startsWith("ws://")) {
    throw new Error(`Nostr relay URL must start with wss:// or ws://`);
  }
  if (protocol === "solid" && !url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`Solid Pod URL must start with https:// or http://`);
  }

  // Check for duplicate (across all sources)
  const existing =
    protocol === "nostr" ? getNostrAllowlist() : getSolidAllowlist();
  if (existing.includes(url)) {
    return false; // Already present
  }

  runtimeAllowlist.push({
    protocol,
    url,
    added_at: new Date().toISOString(),
  });

  console.log(`[federation] Added ${protocol} allowlist entry: ${url}`);
  return true;
}

/** Remove a URL from the runtime allowlist. Returns true if removed. */
export function removeFromAllowlist(protocol: FederationProtocol, url: string): boolean {
  const index = runtimeAllowlist.findIndex(
    (e) => e.protocol === protocol && e.url === url
  );
  if (index === -1) return false;

  runtimeAllowlist.splice(index, 1);
  console.log(`[federation] Removed ${protocol} allowlist entry: ${url}`);
  return true;
}

/** Get all runtime allowlist entries */
export function getRuntimeEntries(): AllowlistEntry[] {
  return [...runtimeAllowlist];
}

// ---- Status ----

/** Get full federation status for health/status endpoints */
export function getFederationStatus(): FederationStatus {
  return {
    enabled: isFederationEnabled(),
    nostr_allowlist: getNostrAllowlist(),
    solid_allowlist: getSolidAllowlist(),
    nostr_denied_count: nostrDeniedCount,
    solid_denied_count: solidDeniedCount,
  };
}

/** Reset denied counters (for testing) */
export function resetDeniedCounters(): void {
  nostrDeniedCount = 0;
  solidDeniedCount = 0;
}
