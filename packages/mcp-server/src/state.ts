// SECURITY WARNING: active-sessions.json contains Nostr nsec private keys
// in plaintext. The file is written with mode 0600 and the directory with
// mode 0700, but this is NOT equivalent to encrypted-at-rest storage.
// Do NOT back up this file to cloud storage or share it.
// TODO: Migrate to OS keychain (macOS Keychain / libsecret) for nsec storage.

import type { ActiveSession } from "@claude-relay/shared";
import { readFile, writeFile, mkdir, chmod, stat, open } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
<<<<<<< HEAD
import { NostrClient } from "./client/nostr-client.js";
=======
import { randomBytes } from "crypto";
>>>>>>> worktree-agent-a56a7edc

const STATE_DIR = join(homedir(), ".claude-relay");
const STATE_FILE = join(STATE_DIR, "active-sessions.json");

let activeSessions: ActiveSession[] = [];

export async function loadState(): Promise<void> {
  try {
    const data = await readFile(STATE_FILE, "utf-8");
    activeSessions = JSON.parse(data);
  } catch {
    activeSessions = [];
  }
}

export async function saveState(): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(STATE_FILE, JSON.stringify(activeSessions, null, 2), { mode: 0o600 });
    // Ensure restrictive permissions (contains nsec private keys)
    await chmod(STATE_FILE, 0o600);
    await chmod(STATE_DIR, 0o700);
  } catch (err: any) {
    console.error(`[relay-mcp] Failed to save state: ${err.message}`);
  }
}

export function getActiveSessions(): ActiveSession[] {
  return activeSessions;
}

export function getActiveSession(
  sessionId: string
): ActiveSession | undefined {
  return activeSessions.find((s) => s.session_id === sessionId);
}

export function addActiveSession(session: ActiveSession): void {
  // Replace if already exists
  activeSessions = activeSessions.filter(
    (s) => s.session_id !== session.session_id
  );
  activeSessions.push(session);
}

export function removeActiveSession(sessionId: string): void {
  activeSessions = activeSessions.filter(
    (s) => s.session_id !== sessionId
  );
}

// Active Nostr WebSocket clients (session ID → client)
const nostrClients = new Map<string, NostrClient>();

export function getNostrClient(sessionId: string): NostrClient | undefined {
  return nostrClients.get(sessionId);
}

export function setNostrClient(sessionId: string, client: NostrClient): void {
  // Disconnect any existing client for this session
  const existing = nostrClients.get(sessionId);
  if (existing) existing.disconnect();
  nostrClients.set(sessionId, client);
}

export function removeNostrClient(sessionId: string): void {
  const client = nostrClients.get(sessionId);
  if (client) {
    client.disconnect();
    nostrClients.delete(sessionId);
  }
}

export function updateCursor(sessionId: string, cursor: number): void {
  const session = activeSessions.find(
    (s) => s.session_id === sessionId
  );
  if (session) {
    session.cursor = cursor;
  }
}

/**
 * Securely delete the state file by overwriting its contents with random
 * bytes before unlinking. This prevents trivial recovery of nsec private
 * keys from disk. Not a substitute for full-disk encryption, but raises
 * the bar significantly against casual forensics.
 */
export async function secureDelete(): Promise<void> {
  try {
    const fileStat = await stat(STATE_FILE);
    const fileSize = fileStat.size;

    if (fileSize > 0) {
      // Overwrite with random bytes (3 passes)
      const fh = await open(STATE_FILE, "w");
      try {
        for (let pass = 0; pass < 3; pass++) {
          await fh.write(randomBytes(fileSize), 0, fileSize, 0);
          // Force flush to disk
          await fh.sync();
        }
      } finally {
        await fh.close();
      }
    }

    // Now unlink
    const { unlink } = await import("fs/promises");
    await unlink(STATE_FILE);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[relay-mcp] Failed to securely delete state: ${err.message}`);
    }
  }
}
