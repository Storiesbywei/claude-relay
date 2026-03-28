import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
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

/** Derive public key from private key */
export function pubkeyFromSecret(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
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

/** Hex-encode a Uint8Array */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode hex string to Uint8Array */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
