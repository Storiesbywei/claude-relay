import type { NostrEvent, NostrFilter } from "@claude-relay/shared";
import { ALL_RELAY_KINDS, SESSION_KIND, METADATA_KIND, AUTH_KIND } from "@claude-relay/shared";
import { matchesFilter } from "./subscriptions.js";

const MAX_EVENTS = 10_000; // Cap to prevent OOM

/**
 * In-memory Nostr event store.
 * Handles regular, replaceable, and addressable event semantics.
 */
export class EventStore {
  // All events indexed by id
  private events = new Map<string, NostrEvent>();
  // Replaceable events: `${kind}:${pubkey}` → event id
  private replaceableIndex = new Map<string, string>();
  // Addressable events: `${kind}:${pubkey}:${d}` → event id
  private addressableIndex = new Map<string, string>();

  /** Store an event, respecting NIP-01 kind semantics. Returns true if stored. */
  store(event: NostrEvent): { stored: boolean; reason?: string } {
    // Reject duplicates
    if (this.events.has(event.id)) {
      return { stored: false, reason: "duplicate:" };
    }

    // Ephemeral events (20000-29999) are never stored
    if (event.kind >= 20000 && event.kind < 30000) {
      return { stored: true }; // "stored" = accepted for relay, not persisted
    }

    // FIX: Reject if at capacity (evict oldest if needed)
    if (this.events.size >= MAX_EVENTS) {
      this.evictOldest();
    }

    // Replaceable events (0, 3, 10000-19999): keep only latest per pubkey+kind
    if (this.isReplaceable(event.kind)) {
      const key = `${event.kind}:${event.pubkey}`;
      const existingId = this.replaceableIndex.get(key);
      if (existingId) {
        const existing = this.events.get(existingId);
        // FIX: Tie-breaking — same timestamp → lowest id wins
        if (existing && (existing.created_at > event.created_at ||
            (existing.created_at === event.created_at && existing.id <= event.id))) {
          return { stored: false, reason: "duplicate: older replaceable event" };
        }
        this.events.delete(existingId);
      }
      this.replaceableIndex.set(key, event.id);
    }

    // Addressable events (30000-39999): keep only latest per pubkey+kind+d
    if (this.isAddressable(event.kind)) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
      const key = `${event.kind}:${event.pubkey}:${dTag}`;
      const existingId = this.addressableIndex.get(key);
      if (existingId) {
        const existing = this.events.get(existingId);
        // FIX: Tie-breaking — same timestamp → lowest id wins
        if (existing && (existing.created_at > event.created_at ||
            (existing.created_at === event.created_at && existing.id <= event.id))) {
          return { stored: false, reason: "duplicate: older addressable event" };
        }
        this.events.delete(existingId);
      }
      this.addressableIndex.set(key, event.id);
    }

    this.events.set(event.id, event);
    return { stored: true };
  }

  /** Query events matching filters (multiple filters are OR-ed) */
  query(filters: NostrFilter[]): NostrEvent[] {
    const results: NostrEvent[] = [];
    const seen = new Set<string>();

    for (const filter of filters) {
      // FIX: Collect ALL matching events first, sort, THEN apply limit
      const matches: NostrEvent[] = [];

      for (const event of this.events.values()) {
        if (seen.has(event.id)) continue;
        if (matchesFilter(event, filter)) {
          matches.push(event);
          seen.add(event.id);
        }
      }

      // Sort by created_at descending (newest first) BEFORE limit
      matches.sort((a, b) => b.created_at - a.created_at);

      // Apply limit after sort
      const limit = filter.limit ?? 500;
      results.push(...matches.slice(0, limit));
    }

    // Final sort (across all filters)
    results.sort((a, b) => b.created_at - a.created_at);
    return results;
  }

  /** Delete events by id (NIP-09). Only deletes if requester pubkey matches. */
  deleteByIds(ids: string[], requesterPubkey: string): number {
    let deleted = 0;
    for (const id of ids) {
      const event = this.events.get(id);
      if (event && event.pubkey === requesterPubkey) {
        this.events.delete(id);
        // FIX: Clean up indexes too
        if (this.isReplaceable(event.kind)) {
          const key = `${event.kind}:${event.pubkey}`;
          if (this.replaceableIndex.get(key) === id) {
            this.replaceableIndex.delete(key);
          }
        }
        if (this.isAddressable(event.kind)) {
          const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
          const key = `${event.kind}:${event.pubkey}:${dTag}`;
          if (this.addressableIndex.get(key) === id) {
            this.addressableIndex.delete(key);
          }
        }
        deleted++;
      }
    }
    return deleted;
  }

  /** Get a single event by id */
  get(id: string): NostrEvent | undefined {
    return this.events.get(id);
  }

  /** Total event count */
  count(): number {
    return this.events.size;
  }

  /** Evict the oldest event to make room */
  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, event] of this.events) {
      if (event.created_at < oldestTime) {
        oldestTime = event.created_at;
        oldestId = id;
      }
    }
    if (oldestId) {
      const event = this.events.get(oldestId)!;
      this.events.delete(oldestId);
      // Clean up indexes
      if (this.isReplaceable(event.kind)) {
        const key = `${event.kind}:${event.pubkey}`;
        if (this.replaceableIndex.get(key) === oldestId) {
          this.replaceableIndex.delete(key);
        }
      }
      if (this.isAddressable(event.kind)) {
        const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
        const key = `${event.kind}:${event.pubkey}:${dTag}`;
        if (this.addressableIndex.get(key) === oldestId) {
          this.addressableIndex.delete(key);
        }
      }
    }
  }

  /** Check if a kind is replaceable (0, 3, 10000-19999) */
  private isReplaceable(kind: number): boolean {
    return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
  }

  /** Check if a kind is addressable (30000-39999) */
  private isAddressable(kind: number): boolean {
    return kind >= 30000 && kind < 40000;
  }
}

// Singleton event store
export const eventStore = new EventStore();
