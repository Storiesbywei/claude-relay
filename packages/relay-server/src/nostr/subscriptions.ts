import type { NostrEvent, NostrFilter, Subscription } from "@claude-relay/shared";

/** Per-WebSocket subscription manager */
export class SubscriptionManager {
  private subs = new Map<string, Subscription>();

  add(sub: Subscription): void {
    this.subs.set(sub.id, sub);
  }

  remove(subId: string): boolean {
    return this.subs.delete(subId);
  }

  has(subId: string): boolean {
    return this.subs.has(subId);
  }

  get(subId: string): Subscription | undefined {
    return this.subs.get(subId);
  }

  getAll(): Subscription[] {
    return [...this.subs.values()];
  }

  count(): number {
    return this.subs.size;
  }

  clear(): void {
    this.subs.clear();
  }
}

/** Check if an event matches a single filter */
export function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.some((id) => event.id.startsWith(id))) {
    return false;
  }
  if (filter.authors && !filter.authors.some((a) => event.pubkey.startsWith(a))) {
    return false;
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.since && event.created_at < filter.since) {
    return false;
  }
  if (filter.until && event.created_at > filter.until) {
    return false;
  }

  // Tag filters: #e, #p, #t, #d, etc.
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && values && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTagValues = event.tags
        .filter((t) => t[0] === tagName)
        .map((t) => t[1]);
      if (!values.some((v) => eventTagValues.includes(v))) {
        return false;
      }
    }
  }

  return true;
}

/** Check if an event matches any filter in a subscription (OR logic) */
export function matchesSubscription(event: NostrEvent, sub: Subscription): boolean {
  return sub.filters.some((filter) => matchesFilter(event, filter));
}
