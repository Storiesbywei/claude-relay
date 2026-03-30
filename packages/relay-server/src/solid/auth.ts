/**
 * Solid-OIDC client credentials authentication with session caching.
 *
 * Uses @inrupt/solid-client-authn-node for Solid Pod authentication.
 * Sessions are cached by `podUrl:clientId` and auto-refreshed by the library.
 */

import { Session } from "@inrupt/solid-client-authn-node";
import type { SolidExportConfig } from "@claude-relay/shared";

/** Cache key: "podUrl:clientId" → authenticated Session */
const sessionCache = new Map<string, Session>();

function cacheKey(config: SolidExportConfig): string {
  return `${config.podUrl}:${config.clientId}`;
}

/**
 * Get an authenticated Solid session for the given config.
 * Returns a cached session if one exists, otherwise authenticates and caches.
 */
export async function getAuthenticatedSession(
  config: SolidExportConfig
): Promise<Session> {
  const key = cacheKey(config);

  // Return cached session if it's still logged in
  const cached = sessionCache.get(key);
  if (cached?.info.isLoggedIn) {
    return cached;
  }

  // Clean up stale cached session
  if (cached) {
    await cached.logout().catch(() => {});
    sessionCache.delete(key);
  }

  // Create and authenticate a new session
  const session = new Session();
  await session.login({
    oidcIssuer: config.oidcIssuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // Client credentials grant — no interactive redirect.
    // Use Bearer tokens instead of DPoP — Bun's crypto does not support
    // exporting non-extractable CryptoKeys as JWK, which DPoP requires.
    tokenType: "Bearer",
  });

  if (!session.info.isLoggedIn) {
    throw new Error(
      `Solid authentication failed for Pod ${config.podUrl} with OIDC issuer ${config.oidcIssuer}`
    );
  }

  sessionCache.set(key, session);
  return session;
}

/**
 * Clear all cached sessions. Call during server shutdown.
 */
export async function clearSessionCache(): Promise<void> {
  const logoutPromises: Promise<void>[] = [];
  for (const [key, session] of sessionCache) {
    logoutPromises.push(session.logout().catch(() => {}));
  }
  await Promise.all(logoutPromises);
  sessionCache.clear();
}
