import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { npubEncode, nsecEncode, decode as nip19Decode } from "nostr-tools/nip19";
import type { NostrKeypair, NostrEvent, UnsignedEvent } from "./nostr-types.js";

/** Generate a fresh Nostr keypair */
export function generateKeypair(): NostrKeypair {
  const privateKey = generateSecretKey();
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    npub: npubEncode(publicKey),
    nsec: nsecEncode(privateKey),
  };
}

/** Sign an event template, producing a fully signed NostrEvent */
export function signEvent(template: UnsignedEvent, secretKey: Uint8Array): NostrEvent {
  return finalizeEvent(template, secretKey) as NostrEvent;
}

/** Verify a signed Nostr event (checks id hash + signature) */
export function verifySignedEvent(event: NostrEvent): boolean {
  return verifyEvent(event as any);
}

/** Create a NIP-42 auth response event */
export function createAuthEvent(
  challenge: string,
  relayUrl: string,
  secretKey: Uint8Array
): NostrEvent {
  const pubkey = getPublicKey(secretKey);
  return signEvent(
    {
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 22242,
      tags: [
        ["relay", relayUrl],
        ["challenge", challenge],
      ],
      content: "",
    },
    secretKey
  );
}

/** Validate a NIP-42 auth event against expected challenge and relay URL */
export function validateAuthEvent(
  event: NostrEvent,
  challenge: string,
  relayUrl: string
): { valid: boolean; reason?: string } {
  // Must be kind 22242
  if (event.kind !== 22242) {
    return { valid: false, reason: "Wrong kind (expected 22242)" };
  }

  // Verify signature
  if (!verifySignedEvent(event)) {
    return { valid: false, reason: "Invalid signature" };
  }

  // Check timestamp (within 10 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 600) {
    return { valid: false, reason: "Timestamp too far from current time" };
  }

  // Check challenge tag
  const challengeTag = event.tags.find((t) => t[0] === "challenge");
  if (!challengeTag || challengeTag[1] !== challenge) {
    return { valid: false, reason: "Challenge mismatch" };
  }

  // Check relay tag
  const relayTag = event.tags.find((t) => t[0] === "relay");
  if (!relayTag || relayTag[1] !== relayUrl) {
    return { valid: false, reason: "Relay URL mismatch" };
  }

  return { valid: true };
}

/** Reconstruct a full NostrKeypair from stored bech32 strings */
export function reconstructKeypair(stored: {
  pubkey: string;
  npub: string;
  nsec: string;
}): NostrKeypair {
  const decoded = nip19Decode(stored.nsec);
  if (decoded.type !== "nsec") {
    throw new Error("Invalid nsec encoding");
  }
  return {
    privateKey: decoded.data as Uint8Array,
    publicKey: stored.pubkey,
    npub: stored.npub,
    nsec: stored.nsec,
  };
}
