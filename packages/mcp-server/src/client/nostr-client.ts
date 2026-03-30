import type { NostrEvent, NostrFilter, NostrKeypair } from "@claude-relay/shared";
import { createAuthEvent, verifySignedEvent, ALL_RELAY_KINDS, SESSION_TAG } from "@claude-relay/shared";

export type NostrClientStatus = "disconnected" | "connecting" | "authenticating" | "ready" | "error";

export class NostrClient {
  private ws: WebSocket | null = null;
  private _status: NostrClientStatus = "disconnected";
  private keypair: NostrKeypair;
  private relayUrl: string;
  private sessionId?: string;
  private subscriptions = new Map<string, (event: NostrEvent) => void>();
  private messageBuffer: NostrEvent[] = [];
  private connectPromise: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(options: { relayUrl: string; keypair: NostrKeypair; sessionId?: string }) {
    this.keypair = options.keypair;
    this.relayUrl = options.relayUrl;
    this.sessionId = options.sessionId;
  }

  get status(): NostrClientStatus {
    return this._status;
  }

  /** Connect and authenticate via NIP-42 */
  async connect(): Promise<void> {
    if (this._status === "ready") return;

    return new Promise<void>((resolve, reject) => {
      this.connectPromise = { resolve, reject };
      const timeout = setTimeout(() => {
        this.connectPromise = null;
        reject(new Error("Connection timeout (10s)"));
      }, 10_000);

      try {
        const ws = new WebSocket(this.relayUrl);
        this.ws = ws;
        this._status = "connecting";

        ws.addEventListener("open", () => {
          this._status = "authenticating";
        });

        ws.addEventListener("message", (ev) => {
          const raw = typeof ev.data === "string" ? ev.data : ev.data.toString();
          this.handleMessage(raw);
        });

        ws.addEventListener("close", () => {
          this._status = "disconnected";
          this.ws = null;
          clearTimeout(timeout);
          if (this.connectPromise) {
            this.connectPromise.reject(new Error("Connection closed"));
            this.connectPromise = null;
          }
        });

        ws.addEventListener("error", () => {
          this._status = "error";
          clearTimeout(timeout);
          if (this.connectPromise) {
            this.connectPromise.reject(new Error(`Failed to connect to ${this.relayUrl}`));
            this.connectPromise = null;
          }
        });
      } catch (err) {
        this._status = "error";
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length < 2) return;

    switch (msg[0]) {
      case "AUTH": {
        // NIP-42 challenge — respond with signed auth event
        const challenge = msg[1] as string;
        const authEvent = createAuthEvent(challenge, this.relayUrl, this.keypair.privateKey);
        this.ws?.send(JSON.stringify(["AUTH", authEvent]));
        break;
      }
      case "OK": {
        const [, , success] = msg;
        if (success && this._status === "authenticating") {
          this._status = "ready";
          if (this.connectPromise) {
            this.connectPromise.resolve();
            this.connectPromise = null;
          }
        }
        break;
      }
      case "EVENT": {
        const [, subId, event] = msg as [string, string, NostrEvent];
        if (event && verifySignedEvent(event)) {
          this.messageBuffer.push(event);
          const cb = this.subscriptions.get(subId);
          if (cb) cb(event);
        }
        break;
      }
      case "EOSE":
      case "NOTICE":
      case "CLOSED":
        break;
    }
  }

  /** Subscribe to events matching filters */
  subscribe(subId: string, filters: NostrFilter[], onEvent?: (event: NostrEvent) => void): void {
    if (!this.ws || this._status !== "ready") return;
    if (onEvent) this.subscriptions.set(subId, onEvent);
    this.ws.send(JSON.stringify(["REQ", subId, ...filters]));
  }

  /** Subscribe to session events (convenience) */
  subscribeToSession(sessionId?: string): void {
    const sid = sessionId || this.sessionId;
    if (!sid) return;
    const filter: NostrFilter = { kinds: [...ALL_RELAY_KINDS] };
    (filter as any)[`#${SESSION_TAG}`] = [sid];
    this.subscribe(`session-${sid}`, [filter]);
  }

  /** Unsubscribe */
  unsubscribe(subId: string): void {
    this.subscriptions.delete(subId);
    if (this.ws && this._status === "ready") {
      this.ws.send(JSON.stringify(["CLOSE", subId]));
    }
  }

  /** Publish a signed event */
  publish(event: NostrEvent): void {
    if (!this.ws || this._status !== "ready") return;
    this.ws.send(JSON.stringify(["EVENT", event]));
  }

  /** Get buffered events and clear buffer */
  drainBuffer(): NostrEvent[] {
    const events = [...this.messageBuffer];
    this.messageBuffer = [];
    return events;
  }

  /** Get buffer size */
  get bufferedCount(): number {
    return this.messageBuffer.length;
  }

  /** Disconnect */
  disconnect(): void {
    for (const subId of this.subscriptions.keys()) {
      try { this.ws?.send(JSON.stringify(["CLOSE", subId])); } catch {}
    }
    this.subscriptions.clear();
    this.messageBuffer = [];
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this._status = "disconnected";
  }
}
