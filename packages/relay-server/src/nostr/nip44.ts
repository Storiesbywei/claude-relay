/**
 * NIP-44 Encrypted Direct Messages + NIP-59 Gift Wrap support.
 *
 * NIP-44: secp256k1 ECDH -> HKDF -> ChaCha20 + HMAC-SHA256
 * NIP-59: Gift-wrapped events (kind 1059) — two layers of encryption
 *
 * The relay's server keypair can decrypt DMs addressed to it.
 * Signal mode sessions pass gift wraps through without decryption.
 */

import { v2 as nip44v2 } from "nostr-tools/nip44";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip59";
import type { NostrEvent, UnsignedEvent } from "@claude-relay/shared";

// ---- Conversation key cache ----
// ECDH is expensive (~1ms per op). Cache derived conversation keys
// keyed by the remote pubkey (assumes our server privkey is constant).

const conversationKeyCache = new Map<string, Uint8Array>();

/**
 * Get or compute a NIP-44 conversation key between our server privkey
 * and a peer's pubkey. Cached for performance.
 */
export function getConversationKey(
  ourPrivkey: Uint8Array,
  theirPubkey: string
): Uint8Array {
  const cacheKey = theirPubkey;
  let key = conversationKeyCache.get(cacheKey);
  if (!key) {
    key = nip44v2.utils.getConversationKey(ourPrivkey, theirPubkey);
    conversationKeyCache.set(cacheKey, key);
  }
  return key;
}

/**
 * Encrypt a plaintext message for a specific Nostr pubkey using NIP-44 v2.
 */
export function encryptNip44(
  plaintext: string,
  conversationKey: Uint8Array
): string {
  return nip44v2.encrypt(plaintext, conversationKey);
}

/**
 * Decrypt a NIP-44 v2 encrypted message.
 */
export function decryptNip44(
  ciphertext: string,
  conversationKey: Uint8Array
): string {
  return nip44v2.decrypt(ciphertext, conversationKey);
}

/**
 * Clear the conversation key cache (for key rotation or shutdown).
 */
export function clearConversationKeyCache(): void {
  conversationKeyCache.clear();
}

// ---- NIP-59 Gift Wrap ----

/** Kind constants per NIP-59 */
export const GIFT_WRAP_KIND = 1059;
export const SEAL_KIND = 13;

/**
 * Create a NIP-59 gift-wrapped event.
 *
 * Layers:
 *   1. Rumor — the actual event content (unsigned)
 *   2. Seal  — rumor encrypted to recipient, signed by sender (kind 13)
 *   3. Wrap  — seal encrypted to recipient, signed by random one-time key (kind 1059)
 *
 * The outer wrap uses a random keypair so the sender's identity is hidden
 * from relay operators (only the recipient can unwrap).
 *
 * @param innerEvent  The event to wrap (kind, content, tags — no id/sig needed)
 * @param senderPrivkey  Sender's private key (used to sign the seal)
 * @param recipientPubkey  Recipient's hex public key
 * @returns A signed kind 1059 gift-wrapped event
 */
export function createGiftWrap(
  innerEvent: Omit<UnsignedEvent, "pubkey" | "created_at"> & {
    created_at?: number;
  },
  senderPrivkey: Uint8Array,
  recipientPubkey: string
): NostrEvent {
  const event = {
    kind: innerEvent.kind,
    content: innerEvent.content,
    tags: innerEvent.tags,
    created_at: innerEvent.created_at ?? Math.floor(Date.now() / 1000),
  };

  return wrapEvent(event, senderPrivkey, recipientPubkey) as unknown as NostrEvent;
}

/**
 * Unwrap a NIP-59 gift-wrapped event (kind 1059).
 *
 * Decrypts both layers:
 *   1. Outer wrap -> seal (using recipient's privkey)
 *   2. Seal -> rumor (using recipient's privkey + seal's pubkey for ECDH)
 *
 * @param wrappedEvent  The kind 1059 event to unwrap
 * @param recipientPrivkey  Recipient's private key
 * @returns The inner rumor event (the actual message), or null if decryption fails
 */
export function unwrapGiftWrap(
  wrappedEvent: NostrEvent,
  recipientPrivkey: Uint8Array
): (NostrEvent & { id: string }) | null {
  if (wrappedEvent.kind !== GIFT_WRAP_KIND) {
    return null;
  }

  try {
    const rumor = unwrapEvent(
      wrappedEvent as any,
      recipientPrivkey
    );
    return rumor as unknown as NostrEvent & { id: string };
  } catch {
    // Decryption failed — event wasn't addressed to us, or corrupted
    return null;
  }
}

/**
 * Check if an event is a gift-wrapped event (kind 1059).
 */
export function isGiftWrap(event: NostrEvent): boolean {
  return event.kind === GIFT_WRAP_KIND;
}

/**
 * Check if a gift wrap is addressed to a specific pubkey.
 * Per NIP-59, the recipient is indicated by a "p" tag.
 */
export function isAddressedTo(event: NostrEvent, pubkey: string): boolean {
  return event.tags.some((t) => t[0] === "p" && t[1] === pubkey);
}
