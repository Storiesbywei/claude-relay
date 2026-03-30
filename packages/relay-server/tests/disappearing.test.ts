import { describe, it, expect } from "bun:test";
import {
  createSession,
  getSession,
  addMessage,
  getMessages,
  sweepDisappearingMessages,
} from "../src/store/sqlite.js";
import type { StoredMessage } from "@claude-relay/shared";

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    message_id: crypto.randomUUID(),
    sequence: 0,
    type: "context",
    title: "",
    content: JSON.stringify({
      ciphertext: "dGVzdGNpcGhlcnRleHRkYXRhYWFhYWFhYQ==",
      iv: "dGVzdGl2MTIzNDU2",
      encrypted: true,
    }),
    sender_name: "sealed",
    sent_at: new Date().toISOString(),
    encrypted: true,
    ...overrides,
  };
}

describe("Disappearing Messages", () => {
  it("creates a session with disappearing TTL", () => {
    const id = crypto.randomUUID();
    const session = createSession(
      id,
      "disappearing-test",
      crypto.randomUUID(),
      crypto.randomUUID(),
      60,
      "signal",
      30 // 30 seconds TTL
    );

    expect(session.disappearing).toBeDefined();
    expect(session.disappearing!.enabled).toBe(true);
    expect(session.disappearing!.ttl_seconds).toBe(30);
  });

  it("stores disappear_after when inserting messages in a disappearing session", () => {
    const id = crypto.randomUUID();
    createSession(
      id,
      "disappearing-insert-test",
      crypto.randomUUID(),
      crypto.randomUUID(),
      60,
      "signal",
      60 // 60 seconds TTL
    );

    const msg = makeMessage();
    addMessage(id, msg);

    // Retrieve the message and verify it exists
    const result = getMessages(id, 0, 10);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].content).toBe(msg.content);
  });

  it("does not set disappear_after for non-disappearing sessions", () => {
    const id = crypto.randomUUID();
    createSession(
      id,
      "non-disappearing-test",
      crypto.randomUUID(),
      crypto.randomUUID(),
      60,
      "signal"
      // no disappearing TTL
    );

    const msg = makeMessage();
    addMessage(id, msg);

    // Message should be retrievable and sweep should not delete it
    const swept = sweepDisappearingMessages();
    const result = getMessages(id, 0, 10);
    expect(result.messages.length).toBe(1);
  });

  it("sweeps messages that have expired their disappear_after", () => {
    const id = crypto.randomUUID();
    createSession(
      id,
      "sweep-test",
      crypto.randomUUID(),
      crypto.randomUUID(),
      60,
      "signal",
      1 // 1 second TTL
    );

    // Insert a message with sent_at = 2 seconds ago
    const pastTime = new Date(Date.now() - 2000).toISOString();
    const msg = makeMessage({ sent_at: pastTime });
    addMessage(id, msg);

    // Verify message exists
    let result = getMessages(id, 0, 10);
    expect(result.messages.length).toBe(1);

    // Sweep — the message's disappear_after = pastTime + 1s = 1s ago, should be deleted
    const swept = sweepDisappearingMessages();
    expect(swept).toBeGreaterThanOrEqual(1);

    // Verify message is gone
    result = getMessages(id, 0, 10);
    expect(result.messages.length).toBe(0);
  });

  it("does not sweep messages that have not yet expired", () => {
    const id = crypto.randomUUID();
    createSession(
      id,
      "not-yet-expired-test",
      crypto.randomUUID(),
      crypto.randomUUID(),
      60,
      "signal",
      3600 // 1 hour TTL — message won't expire during this test
    );

    const msg = makeMessage();
    addMessage(id, msg);

    // Sweep should not delete this message
    const swept = sweepDisappearingMessages();

    const result = getMessages(id, 0, 10);
    expect(result.messages.length).toBe(1);
  });

  it("relay mode sessions do not have disappearing config", () => {
    const id = crypto.randomUUID();
    const session = createSession(
      id,
      "relay-mode-test",
      crypto.randomUUID(),
      crypto.randomUUID(),
      60,
      "relay"
    );

    expect(session.disappearing).toBeUndefined();
  });
});
