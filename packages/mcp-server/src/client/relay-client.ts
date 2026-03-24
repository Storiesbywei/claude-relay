import { RELAY_URL_DEFAULT } from "@claude-relay/shared";
import type {
  CreateSessionResponse,
  JoinSessionResponse,
  PollResponse,
  SessionInfo,
  RelayMessagePayload,
} from "@claude-relay/shared";

const RELAY_URL = process.env.RELAY_URL || RELAY_URL_DEFAULT;

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${RELAY_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return body as T;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function createSession(
  name: string,
  ttlMinutes?: number
): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>("/sessions", {
    method: "POST",
    body: JSON.stringify({ name, ttl_minutes: ttlMinutes }),
  });
}

export async function joinSession(
  sessionId: string,
  inviteToken: string,
  participantName?: string
): Promise<JoinSessionResponse> {
  return request<JoinSessionResponse>(`/sessions/${sessionId}/join`, {
    method: "POST",
    headers: authHeaders(inviteToken),
    body: JSON.stringify({ participant_name: participantName }),
  });
}

export async function getSessionInfo(
  sessionId: string,
  token: string
): Promise<SessionInfo> {
  return request<SessionInfo>(`/sessions/${sessionId}`, {
    headers: authHeaders(token),
  });
}

export async function sendMessage(
  sessionId: string,
  token: string,
  payload: RelayMessagePayload
): Promise<{ message_id: string; sequence: number; received_at: string }> {
  return request(`/relay/${sessionId}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
}

export async function pollMessages(
  sessionId: string,
  token: string,
  since = 0,
  limit = 10
): Promise<PollResponse> {
  return request<PollResponse>(
    `/relay/${sessionId}?since=${since}&limit=${limit}`,
    { headers: authHeaders(token) }
  );
}

export async function healthCheck(): Promise<{
  status: string;
  sessions: number;
}> {
  return request("/health");
}
