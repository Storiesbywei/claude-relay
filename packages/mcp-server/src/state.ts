import type { ActiveSession } from "@claude-relay/shared";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

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

export function updateCursor(sessionId: string, cursor: number): void {
  const session = activeSessions.find(
    (s) => s.session_id === sessionId
  );
  if (session) {
    session.cursor = cursor;
  }
}
