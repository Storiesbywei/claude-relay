/**
 * Session Isolation Security Tests
 *
 * Verifies that there are NO cross-session data leakage paths:
 * - Token from session A cannot access session B's messages
 * - Token from session A cannot send to session B
 * - SSE subscribers for session A do not receive session B's messages
 * - Session info for session A is not accessible with session B's token
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createSession,
  getSession,
  getSessionByToken,
  isValidToken,
  isInviteToken,
  addParticipant,
  addMessage,
  getMessages,
  subscribe,
  sweepExpiredSessions,
} from "../src/store/memory.js";
import type { StoredMessage } from "@claude-relay/shared";

// Helper: create a test message
function makeMessage(content: string, type = "context"): StoredMessage {
  return {
    message_id: crypto.randomUUID(),
    sequence: 0,
    type,
    title: `Test: ${content}`,
    content,
    sender_name: "test",
    sent_at: new Date().toISOString(),
  };
}

describe("Session Isolation", () => {
  // Note: the in-memory store is a module singleton.
  // We create unique sessions per test to avoid interference.

  describe("Token -> Session Mapping", () => {
    it("creator token for session A is NOT valid for session B", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      // Creator token A is valid for session A
      expect(isValidToken(sessionA.creatorToken, sessionA.id)).toBe(true);
      // Creator token A is NOT valid for session B
      expect(isValidToken(sessionA.creatorToken, sessionB.id)).toBe(false);
      // Creator token B is NOT valid for session A
      expect(isValidToken(sessionB.creatorToken, sessionA.id)).toBe(false);
      // Creator token B is valid for session B
      expect(isValidToken(sessionB.creatorToken, sessionB.id)).toBe(true);
    });

    it("participant token for session A is NOT valid for session B", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      const participantToken = crypto.randomUUID();
      addParticipant(sessionA.id, participantToken, "worker-a");

      // Participant token is valid for session A
      expect(isValidToken(participantToken, sessionA.id)).toBe(true);
      // Participant token is NOT valid for session B
      expect(isValidToken(participantToken, sessionB.id)).toBe(false);
    });

    it("getSessionByToken returns the correct session", () => {
      const tokenA = crypto.randomUUID();
      const tokenB = crypto.randomUUID();

      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        tokenA,
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        tokenB,
        crypto.randomUUID(),
        60
      );

      const resolvedA = getSessionByToken(tokenA);
      const resolvedB = getSessionByToken(tokenB);

      expect(resolvedA?.id).toBe(sessionA.id);
      expect(resolvedB?.id).toBe(sessionB.id);
      // They must NOT be the same session
      expect(resolvedA?.id).not.toBe(resolvedB?.id);
    });

    it("random token resolves to no session", () => {
      const fakeToken = crypto.randomUUID();
      expect(getSessionByToken(fakeToken)).toBeUndefined();
      expect(isValidToken(fakeToken, crypto.randomUUID())).toBe(false);
    });
  });

  describe("Invite Token Isolation", () => {
    it("invite token for session A cannot join session B", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      // Session A's invite token is valid for session A
      expect(isInviteToken(sessionA.inviteToken, sessionA.id)).toBe(true);
      // Session A's invite token is NOT valid for session B
      expect(isInviteToken(sessionA.inviteToken, sessionB.id)).toBe(false);
      // Session B's invite token is NOT valid for session A
      expect(isInviteToken(sessionB.inviteToken, sessionA.id)).toBe(false);
    });
  });

  describe("Message Isolation", () => {
    it("messages sent to session A are NOT visible in session B", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      // Send messages to session A
      addMessage(sessionA.id, makeMessage("secret-data-for-A"));
      addMessage(sessionA.id, makeMessage("more-secret-data-for-A"));

      // Send a message to session B
      addMessage(sessionB.id, makeMessage("data-for-B"));

      // Poll session A — should see 2 messages
      const resultA = getMessages(sessionA.id, 0, 50);
      expect(resultA.messages).toHaveLength(2);
      expect(resultA.messages[0].content).toBe("secret-data-for-A");
      expect(resultA.messages[1].content).toBe("more-secret-data-for-A");

      // Poll session B — should see only 1 message, not session A's
      const resultB = getMessages(sessionB.id, 0, 50);
      expect(resultB.messages).toHaveLength(1);
      expect(resultB.messages[0].content).toBe("data-for-B");

      // Verify no cross-contamination
      for (const msg of resultB.messages) {
        expect(msg.content).not.toContain("secret-data-for-A");
      }
    });

    it("cannot add a message to a nonexistent session", () => {
      expect(() => {
        addMessage("nonexistent-session-id", makeMessage("rogue-message"));
      }).toThrow("Session not found");
    });
  });

  describe("SSE Stream Isolation", () => {
    it("SSE subscriber for session A does NOT receive session B messages", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      const receivedByA: StoredMessage[] = [];
      const receivedByB: StoredMessage[] = [];

      // Subscribe to session A
      const unsubA = subscribe(sessionA.id, (msg) => {
        receivedByA.push(msg);
      });

      // Subscribe to session B
      const unsubB = subscribe(sessionB.id, (msg) => {
        receivedByB.push(msg);
      });

      // Send message to session A
      addMessage(sessionA.id, makeMessage("for-session-A-only"));

      // Send message to session B
      addMessage(sessionB.id, makeMessage("for-session-B-only"));

      // Session A subscriber got only session A's message
      expect(receivedByA).toHaveLength(1);
      expect(receivedByA[0].content).toBe("for-session-A-only");

      // Session B subscriber got only session B's message
      expect(receivedByB).toHaveLength(1);
      expect(receivedByB[0].content).toBe("for-session-B-only");

      unsubA();
      unsubB();
    });

    it("unsubscribing stops delivery", () => {
      const session = createSession(
        crypto.randomUUID(),
        "Session Unsub",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      const received: StoredMessage[] = [];
      const unsub = subscribe(session.id, (msg) => {
        received.push(msg);
      });

      addMessage(session.id, makeMessage("before-unsub"));
      unsub();
      addMessage(session.id, makeMessage("after-unsub"));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("before-unsub");
    });
  });

  describe("Session Info Isolation", () => {
    it("getSession returns the correct session and not another", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      const fetchedA = getSession(sessionA.id);
      const fetchedB = getSession(sessionB.id);

      expect(fetchedA?.id).toBe(sessionA.id);
      expect(fetchedA?.name).toBe("Session A");
      expect(fetchedB?.id).toBe(sessionB.id);
      expect(fetchedB?.name).toBe("Session B");

      // Tokens must not leak across sessions
      expect(fetchedA?.creatorToken).not.toBe(fetchedB?.creatorToken);
    });

    it("nonexistent session returns undefined", () => {
      expect(getSession("nonexistent-id")).toBeUndefined();
    });
  });

  describe("Sequence Counter Isolation", () => {
    it("sequence counters are independent per session", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      // Add 3 messages to A
      addMessage(sessionA.id, makeMessage("a1"));
      addMessage(sessionA.id, makeMessage("a2"));
      addMessage(sessionA.id, makeMessage("a3"));

      // Add 1 message to B
      addMessage(sessionB.id, makeMessage("b1"));

      // Session A's sequence counter should be at 3
      const resultA = getMessages(sessionA.id, 0, 50);
      expect(resultA.messages[2].sequence).toBe(3);

      // Session B's sequence counter should be at 1, independent of A
      const resultB = getMessages(sessionB.id, 0, 50);
      expect(resultB.messages[0].sequence).toBe(1);
    });
  });

  describe("TTL Sweep Isolation", () => {
    it("sweeping expired session A does not affect session B", () => {
      // Create session A with 0-minute TTL (already expired)
      const sessionA = createSession(
        crypto.randomUUID(),
        "Expired Session",
        crypto.randomUUID(),
        crypto.randomUUID(),
        0 // expires immediately
      );

      // Manually backdate the expiry
      sessionA.expiresAt = new Date(Date.now() - 1000);

      // Create session B with long TTL
      const sessionB = createSession(
        crypto.randomUUID(),
        "Active Session",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      addMessage(sessionB.id, makeMessage("important-data"));

      // Sweep expired sessions
      const swept = sweepExpiredSessions();
      expect(swept).toBeGreaterThanOrEqual(1);

      // Session A should be gone
      expect(getSession(sessionA.id)).toBeUndefined();
      expect(isValidToken(sessionA.creatorToken, sessionA.id)).toBe(false);

      // Session B should still exist with its data intact
      expect(getSession(sessionB.id)).toBeDefined();
      expect(isValidToken(sessionB.creatorToken, sessionB.id)).toBe(true);
      const resultB = getMessages(sessionB.id, 0, 50);
      expect(resultB.messages).toHaveLength(1);
      expect(resultB.messages[0].content).toBe("important-data");
    });
  });

  describe("Participant Isolation", () => {
    it("participants added to session A are not in session B", () => {
      const sessionA = createSession(
        crypto.randomUUID(),
        "Session A",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );
      const sessionB = createSession(
        crypto.randomUUID(),
        "Session B",
        crypto.randomUUID(),
        crypto.randomUUID(),
        60
      );

      const workerToken = crypto.randomUUID();
      addParticipant(sessionA.id, workerToken, "worker-1");

      // Session A has the participant
      const fetchedA = getSession(sessionA.id);
      expect(fetchedA?.participants.has(workerToken)).toBe(true);

      // Session B does NOT have the participant
      const fetchedB = getSession(sessionB.id);
      expect(fetchedB?.participants.has(workerToken)).toBe(false);
    });
  });
});
