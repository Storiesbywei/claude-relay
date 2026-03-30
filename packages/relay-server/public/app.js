// === Claude Relay Dashboard v3 — Modern Vanilla JS Rewrite ===
// ES2022+, no frameworks, no build step.

"use strict";

// ---------------------------------------------------------------------------
// 1. State
// ---------------------------------------------------------------------------

const state = {
  session: null,      // { id, token, invite, name, role }
  messages: [],       // StoredMessage[]
  participants: [],   // { name, role, joined_at }[]
  cursor: 0,
  connected: false,
  sseAbort: null,     // AbortController for SSE fetch
  pollTimer: null,    // fallback polling interval
  healthTimer: null,
  timestampTimer: null,
  userScrolled: false,

  // Workspace (file tree, file viewer)
  workspace: {
    tree: [],         // { path, type, indent, changed }[]
    files: {},        // path -> content
    activeFile: null,
  },

  // Peer simulation
  simulating: false,
  simTokenA: null,
  simTokenB: null,
  peerCounts: { a: 0, b: 0, total: 0 },
};

// Participant color palette — 4-color rotation
const PARTICIPANT_COLORS = ["#5e9cff", "#ff6b8a", "#50d890", "#f5a623"];
const participantColorMap = new Map();

function getParticipantColor(name) {
  if (!participantColorMap.has(name)) {
    participantColorMap.set(name, PARTICIPANT_COLORS[participantColorMap.size % PARTICIPANT_COLORS.length]);
  }
  return participantColorMap.get(name);
}

// ---------------------------------------------------------------------------
// 2. Utilities
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(str) {
  return (str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Render markdown-ish content (escape first, then apply patterns). */
function renderContent(raw) {
  let s = escapeHtml(raw);

  // Code blocks: ```...```
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`);

  // Inline code: `...`
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);

  // Bold: **...**
  s = s.replace(/\*\*(.+?)\*\*/g, (_m, txt) => `<strong>${txt}</strong>`);

  // Headings: # at start of line
  s = s.replace(/^# (.+)$/gm, (_m, txt) => `<h3>${txt}</h3>`);

  // Auto-link URLs
  s = s.replace(/(https?:\/\/[^\s<&]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

  // Newlines -> <br> (but not inside <pre>)
  s = s.replace(/\n/g, "<br>");

  return s;
}

/** Relative timestamp. */
function relativeTime(iso) {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Absolute time for title attribute. */
function absoluteTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Copy text (secure context or fallback). */
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = Object.assign(document.createElement("textarea"), {
    value: text,
    style: "position:fixed;opacity:0",
  });
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Infer whether a sender is human or agent. */
function inferRole(name) {
  if (!name) return "human";
  const lower = name.toLowerCase();
  const agentWords = [
    "claude", "agent", "bot", "worker", "auditor", "analyst",
    "scout", "strategist", "architect", "reviewer",
    "mba-", "mcp-", "opus", "sonnet", "haiku",
  ];
  return agentWords.some((k) => lower.includes(k)) ? "agent" : "human";
}

// ---------------------------------------------------------------------------
// 3. Toast Notifications
// ---------------------------------------------------------------------------

function showToast(message, type = "info") {
  const container = $("#toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger slide-in
  requestAnimationFrame(() => toast.classList.add("show"));

  // Auto-dismiss after 4s
  setTimeout(() => {
    toast.classList.remove("show");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Safety cleanup
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// ---------------------------------------------------------------------------
// 4. API Client
// ---------------------------------------------------------------------------

const API_BASE = window.location.origin;

const api = {
  async _fetch(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    if (state.session?.token) {
      headers.Authorization ??= `Bearer ${state.session.token}`;
    }
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async createSession(name, ttl = 60) {
    return this._fetch("/sessions", {
      method: "POST",
      body: JSON.stringify({ name, ttl_minutes: ttl }),
    });
  },

  async joinSession(id, invite, participantName = "Participant") {
    return this._fetch(`/sessions/${id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${invite}` },
      body: JSON.stringify({ participant_name: participantName }),
    });
  },

  async sendMessage(type, title, content, extra = {}) {
    if (!state.session) throw new Error("No active session");
    return this._fetch(`/relay/${state.session.id}`, {
      method: "POST",
      body: JSON.stringify({ type, title, content, ...extra }),
    });
  },

  async pollMessages(since = 0, limit = 50) {
    if (!state.session) throw new Error("No active session");
    return this._fetch(`/relay/${state.session.id}?since=${since}&limit=${limit}`);
  },

  async getSessionInfo() {
    if (!state.session) throw new Error("No active session");
    return this._fetch(`/sessions/${state.session.id}`);
  },

  async exportSession(format = "json") {
    if (!state.session) throw new Error("No active session");
    // Build export from local message cache
    const data = {
      session: state.session,
      messages: state.messages,
      participants: state.participants,
      exported_at: new Date().toISOString(),
    };
    if (format === "markdown") {
      return exportAsMarkdown(data);
    }
    return data;
  },

  async getHealth() {
    return this._fetch("/health");
  },
};

// ---------------------------------------------------------------------------
// 5. SSE Connection (fetch-based for auth header support)
// ---------------------------------------------------------------------------

function connectSSE() {
  if (!state.session?.id || !state.session?.token) return;
  disconnectSSE();

  const controller = new AbortController();
  state.sseAbort = controller;

  const url = `${API_BASE}/relay/${state.session.id}/stream`;
  const lastId = state.cursor > 0 ? state.cursor : undefined;

  fetch(url, {
    headers: {
      Authorization: `Bearer ${state.session.token}`,
      Accept: "text/event-stream",
      ...(lastId != null ? { "Last-Event-ID": String(lastId) } : {}),
    },
    signal: controller.signal,
  })
    .then((res) => {
      if (!res.ok || !res.body) {
        throw new Error(`SSE response ${res.status}`);
      }
      state.connected = true;
      updateConnectionStatus(true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            handleSSEClose();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line

          let currentEvent = "";
          let currentData = "";
          let currentId = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              currentData += (currentData ? "\n" : "") + line.slice(5).trim();
            } else if (line.startsWith("id:")) {
              currentId = line.slice(3).trim();
            } else if (line === "") {
              // End of event block
              if (currentEvent === "message" && currentData) {
                try {
                  const msg = JSON.parse(currentData);
                  handleIncomingMessage(msg);
                  if (currentId) state.cursor = Number(currentId);
                } catch { /* invalid JSON */ }
              }
              currentEvent = "";
              currentData = "";
              currentId = "";
            }
          }
          pump();
        }).catch((err) => {
          if (err.name !== "AbortError") handleSSEClose();
        });
      }

      pump();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        console.warn("[sse] Connection failed, falling back to polling:", err.message);
        handleSSEClose();
      }
    });
}

function disconnectSSE() {
  if (state.sseAbort) {
    state.sseAbort.abort();
    state.sseAbort = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.connected = false;
  updateConnectionStatus(false);
}

function handleSSEClose() {
  state.connected = false;
  updateConnectionStatus(false);
  state.sseAbort = null;

  // Fall back to polling
  startPolling();

  // Attempt SSE reconnect after 5s
  setTimeout(() => {
    if (state.session?.id && !state.sseAbort) {
      connectSSE();
    }
  }, 5000);
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (!state.session) return;
    try {
      const data = await api.pollMessages(state.cursor, 20);
      for (const msg of data.messages) {
        handleIncomingMessage(msg);
      }
      if (data.messages.length > 0) {
        state.cursor = data.cursor;
        saveSession();
      }
    } catch { /* server down or session expired */ }
  }, 1500);
}

function handleIncomingMessage(msg) {
  // Deduplicate
  if (state.messages.some((m) => m.message_id === msg.message_id)) return;

  state.messages.push(msg);
  renderMessage(msg);
  updateMessageCount();
  saveSession();

  // Handle workspace message types
  if (msg.type === "file_tree") handleFileTree(msg);
  if (msg.type === "file_change") handleFileChange(msg);
  if (msg.type === "file_read") handleFileRead(msg);
  if (msg.type === "status_update") handleStatusUpdate(msg);
}

// ---------------------------------------------------------------------------
// 6. UI Rendering — Messages
// ---------------------------------------------------------------------------

function renderMessage(msg) {
  const feed = $("#message-feed");
  if (!feed) return;

  const card = document.createElement("div");
  card.className = "message-card";
  card.dataset.messageId = msg.message_id || "";
  card.dataset.sentAt = msg.sent_at || "";

  const senderName = msg.sender_name || msg.sender || "unknown";
  const role = inferRole(senderName);
  const color = getParticipantColor(senderName);
  const typeChip = msg.type || "context";

  // Build file-change-specific content
  let contentHtml;
  if (msg.type === "file_change" || msg.type === "file_read") {
    const lines = (msg.content || "").split("\n");
    const pathLine = lines[0] || "";
    const filePath = pathLine.replace(/^path:\s*/, "").trim();
    const body = lines.slice(2).join("\n");
    contentHtml = `<span class="file-path" data-path="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>`;
    if (msg.type === "file_change") {
      const preview = body.split("\n").slice(0, 10).join("\n");
      contentHtml += `<pre class="diff-preview"><code>${renderDiff(preview)}${body.split("\n").length > 10 ? "\n..." : ""}</code></pre>`;
    }
  } else {
    contentHtml = `<div class="message-content">${renderContent(msg.content || "")}</div>`;
  }

  card.innerHTML = `
    <div class="message-header">
      <span class="participant-badge" style="background:${color}">${escapeHtml(senderName.slice(0, 2).toUpperCase())}</span>
      <span class="participant-name">${escapeHtml(senderName)}</span>
      <span class="role-tag role-${role}">${role}</span>
      <span class="type-chip type-${typeChip}">${escapeHtml(typeChip)}</span>
      <time class="timestamp" title="${absoluteTime(msg.sent_at)}" data-ts="${msg.sent_at || ""}">${relativeTime(msg.sent_at)}</time>
    </div>
    ${contentHtml}
  `;

  // Click handler on file-path spans
  const filePathEl = card.querySelector(".file-path");
  if (filePathEl) {
    filePathEl.addEventListener("click", () => {
      const fp = filePathEl.dataset.path;
      if (fp && state.workspace.files[fp]) openFileViewer(fp);
    });
  }

  feed.appendChild(card);
  autoScroll(feed);
}

function renderDiff(text) {
  return text.split("\n").map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return `<span class="line-added">${escapeHtml(line)}</span>`;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return `<span class="line-removed">${escapeHtml(line)}</span>`;
    }
    return escapeHtml(line);
  }).join("\n");
}

function renderSystemMessage(text) {
  const feed = $("#message-feed");
  if (!feed) return;
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  feed.appendChild(div);
  autoScroll(feed);
}

function autoScroll(container) {
  if (!state.userScrolled) {
    container.scrollTop = container.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// 7. UI Rendering — Participants
// ---------------------------------------------------------------------------

function renderParticipants(list) {
  // Sidebar participant list
  const pl = $("#participant-list");
  if (pl) {
    pl.innerHTML = list.map((name) => {
      const color = getParticipantColor(name);
      const role = inferRole(name);
      return `<div class="participant-item">
        <span class="participant-badge" style="background:${color}">${escapeHtml(name.slice(0, 2).toUpperCase())}</span>
        <span>${escapeHtml(name)}</span>
        <span class="role-tag role-${role}">${role}</span>
      </div>`;
    }).join("");
  }

  // Navbar avatars
  const avatars = $("#participant-avatars");
  if (avatars) {
    avatars.innerHTML = list.slice(0, 5).map((name) => {
      const color = getParticipantColor(name);
      return `<span class="avatar-circle" style="background:${color}" title="${escapeHtml(name)}">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
    }).join("");
    if (list.length > 5) {
      avatars.innerHTML += `<span class="avatar-overflow">+${list.length - 5}</span>`;
    }
  }
}

function renderSessionInfo(info) {
  const el = $("#session-info");
  if (!el) return;
  el.innerHTML = `
    <div class="info-row"><span>Session</span><span title="${escapeHtml(info.id)}">${escapeHtml((info.id || "").slice(0, 8))}...</span></div>
    <div class="info-row"><span>Name</span><span>${escapeHtml(info.name || "")}</span></div>
    <div class="info-row"><span>Messages</span><span>${info.message_count ?? state.messages.length}</span></div>
    <div class="info-row"><span>Created</span><span>${absoluteTime(info.created_at)}</span></div>
    <div class="info-row"><span>Expires</span><span>${absoluteTime(info.expires_at)}</span></div>
  `;
}

// ---------------------------------------------------------------------------
// 8. UI Rendering — Connection & Status Bar
// ---------------------------------------------------------------------------

function updateConnectionStatus(connected) {
  const el = $("#connection-status");
  if (!el) return;
  el.className = `connection-status ${connected ? "connected" : "disconnected"}`;
  el.innerHTML = `<span class="status-dot ${connected ? "connected" : ""}"></span> ${connected ? "Live" : "Disconnected"}`;

  const sseStat = $("#sse-status");
  if (sseStat) sseStat.textContent = connected ? "SSE: connected" : (state.pollTimer ? "Polling" : "SSE: off");
}

function updateMessageCount() {
  const el = $("#msg-count");
  if (el) el.textContent = `${state.messages.length} msgs`;
}

function updateRateLimit(info) {
  const el = $("#rate-limit-status");
  if (el && info) el.textContent = `Rate: ${info}`;
}

async function pollHealth() {
  try {
    const data = await api.getHealth();
    updateConnectionStatus(state.connected);
    const nostrEl = $("#nostr-status");
    if (nostrEl && data.nostr) {
      nostrEl.textContent = `Nostr: ${data.nostr.connections} ws, ${data.nostr.events} events`;
    } else if (nostrEl) {
      nostrEl.textContent = "Nostr: off";
    }
  } catch {
    updateConnectionStatus(false);
  }
}

// ---------------------------------------------------------------------------
// 9. Session Lifecycle
// ---------------------------------------------------------------------------

async function createSession() {
  const nameInput = $("#session-name");
  const name = nameInput?.value.trim() || "Relay Session";

  try {
    const data = await api.createSession(name);
    state.session = {
      id: data.session_id,
      token: data.creator_token,
      invite: data.invite_token,
      name,
      role: "creator",
    };
    state.messages = [];
    state.participants = ["creator"];
    state.cursor = 0;
    participantColorMap.clear();

    saveSession();
    transitionToApp();
    renderSessionInfo({
      id: data.session_id,
      name,
      message_count: 0,
      created_at: new Date().toISOString(),
      expires_at: data.expires_at,
    });
    renderParticipants(state.participants);
    renderSystemMessage(`Session created. Invite token: ${data.invite_token}`);
    showToast("Session created", "success");
    connectSSE();
    startHealthPolling();
  } catch (err) {
    showToast(`Create failed: ${err.message}`, "error");
  }
}

async function joinSession() {
  const idInput = $("#join-session-id");
  const tokenInput = $("#join-invite-token");
  const sid = idInput?.value.trim();
  const invite = tokenInput?.value.trim();
  if (!sid || !invite) {
    showToast("Session ID and invite token required", "error");
    return;
  }

  try {
    const data = await api.joinSession(sid, invite, "Director");
    state.session = {
      id: sid,
      token: data.participant_token,
      invite: null,
      name: data.session?.name || "Joined Session",
      role: "participant",
    };
    state.messages = [];
    state.participants = data.session?.participants || [];
    state.cursor = 0;
    participantColorMap.clear();

    saveSession();
    transitionToApp();
    renderSessionInfo({
      id: sid,
      name: state.session.name,
      message_count: data.session?.message_count ?? 0,
      expires_at: data.session?.expires_at,
    });
    renderParticipants(state.participants);
    showToast("Joined session", "success");
    loadHistory();
    connectSSE();
    startHealthPolling();
  } catch (err) {
    showToast(`Join failed: ${err.message}`, "error");
  }
}

function endSession() {
  disconnectSSE();
  if (state.healthTimer) {
    clearInterval(state.healthTimer);
    state.healthTimer = null;
  }
  state.session = null;
  state.messages = [];
  state.participants = [];
  state.cursor = 0;
  state.workspace = { tree: [], files: {}, activeFile: null };
  participantColorMap.clear();
  localStorage.removeItem("relay-session");

  transitionToSetup();
  showToast("Session ended", "info");
}

function saveSession() {
  if (!state.session) return;
  localStorage.setItem("relay-session", JSON.stringify({
    id: state.session.id,
    token: state.session.token,
    invite: state.session.invite,
    name: state.session.name,
    role: state.session.role,
    cursor: state.cursor,
  }));
}

function loadSavedSession() {
  try {
    const saved = JSON.parse(localStorage.getItem("relay-session"));
    if (!saved?.id || !saved?.token) return false;

    state.session = {
      id: saved.id,
      token: saved.token,
      invite: saved.invite,
      name: saved.name || "Session",
      role: saved.role || "creator",
    };
    state.cursor = saved.cursor || 0;
    return true;
  } catch {
    return false;
  }
}

async function loadHistory() {
  if (!state.session) return;
  try {
    const data = await api.pollMessages(0, 50);
    for (const msg of data.messages) {
      if (!state.messages.some((m) => m.message_id === msg.message_id)) {
        state.messages.push(msg);
        renderMessage(msg);
        if (msg.type === "file_tree") handleFileTree(msg);
        if (msg.type === "file_change") handleFileChange(msg);
        if (msg.type === "file_read") handleFileRead(msg);
        if (msg.type === "status_update") handleStatusUpdate(msg);
      }
    }
    state.cursor = data.cursor;
    updateMessageCount();
    saveSession();
    refreshParticipants();
  } catch { /* session may have expired */ }
}

async function refreshParticipants() {
  if (!state.session) return;
  try {
    const data = await api.getSessionInfo();
    state.participants = data.participants || [];
    renderParticipants(state.participants);
    renderSessionInfo(data);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 10. View Transitions
// ---------------------------------------------------------------------------

function transitionToApp() {
  const setup = $("#session-setup");
  const main = $("#app-main");
  if (setup) setup.style.display = "none";
  if (main) main.style.display = "flex";
  updateSessionDisplay();
}

function transitionToSetup() {
  const setup = $("#session-setup");
  const main = $("#app-main");
  if (setup) setup.style.display = "";
  if (main) main.style.display = "none";

  // Clear feed
  const feed = $("#message-feed");
  if (feed) feed.innerHTML = "";
  const fileTree = $("#file-tree");
  if (fileTree) fileTree.innerHTML = "";
}

function updateSessionDisplay() {
  const nameDisp = $("#session-name-display");
  if (nameDisp && state.session) {
    nameDisp.textContent = state.session.name || state.session.id?.slice(0, 8);
    nameDisp.title = state.session.id || "";
  }
}

// ---------------------------------------------------------------------------
// 11. Send Message
// ---------------------------------------------------------------------------

async function sendMessage() {
  const textarea = $("#message-input");
  const typeSelect = $("#message-type-select");
  const content = textarea?.value.trim();
  if (!content || !state.session) return;

  const msgType = typeSelect?.value || "context";

  try {
    await api.sendMessage(msgType, null, content);
    textarea.value = "";
    textarea.style.height = "auto";
  } catch (err) {
    showToast(`Send failed: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// 12. Workspace — File Tree & File Viewer
// ---------------------------------------------------------------------------

function handleFileTree(msg) {
  const lines = (msg.content || "").split("\n").filter(Boolean);
  state.workspace.tree = lines.map((line) => {
    const trimmed = line.replace(/^[\s\u2502\u251c\u2514\u2500]+/, "");
    const indent = Math.floor((line.length - trimmed.length) / 2);
    const isDir = trimmed.endsWith("/");
    const name = isDir ? trimmed.slice(0, -1) : trimmed;
    return { path: name, type: isDir ? "folder" : "file", indent, changed: false };
  });
  renderFileTree();
}

function handleFileChange(msg) {
  const lines = (msg.content || "").split("\n");
  const filePath = (lines[0] || "").replace(/^path:\s*/, "").trim();
  const diffContent = lines.slice(2).join("\n");

  for (const item of state.workspace.tree) {
    if (item.path === filePath || filePath.endsWith(item.path)) {
      item.changed = true;
    }
  }
  state.workspace.files[filePath] = diffContent;
  renderFileTree();
}

function handleFileRead(msg) {
  const lines = (msg.content || "").split("\n");
  const filePath = (lines[0] || "").replace(/^path:\s*/, "").trim();
  const fileContent = lines.slice(2).join("\n");
  state.workspace.files[filePath] = fileContent;
  openFileViewer(filePath);
}

function handleStatusUpdate(_msg) {
  // Status updates are rendered as messages already; nothing extra needed now.
}

function renderFileTree() {
  const tree = $("#file-tree");
  if (!tree) return;

  if (state.workspace.tree.length === 0) {
    tree.innerHTML = '<div class="file-tree-empty">No workspace data yet.</div>';
    return;
  }

  tree.innerHTML = "";
  for (const item of state.workspace.tree) {
    const div = document.createElement("div");
    const isFolder = item.type === "folder";
    div.className = `ft-item ${isFolder ? "ft-folder" : "ft-file"}${item.changed ? " changed" : ""}${item.path === state.workspace.activeFile ? " active" : ""}`;

    let indentHtml = "";
    for (let i = 0; i < item.indent; i++) {
      indentHtml += '<span class="ft-indent"></span>';
    }

    div.innerHTML = `
      ${indentHtml}
      <span class="ft-icon">${isFolder ? "\u25bc" : "\u25cb"}</span>
      <span class="ft-name">${escapeHtml(item.path)}</span>
      ${item.changed ? '<span class="ft-badge">M</span>' : ""}
    `;

    if (!isFolder) {
      div.addEventListener("click", () => {
        if (state.workspace.files[item.path]) openFileViewer(item.path);
      });
    }

    tree.appendChild(div);
  }
}

function openFileViewer(path) {
  state.workspace.activeFile = path;
  const viewerPath = $("#file-viewer-path");
  const viewerContent = $("#file-viewer-content");
  const viewer = $("#file-viewer");

  if (viewerPath) viewerPath.textContent = path;
  if (viewerContent) {
    const content = state.workspace.files[path] || "File not yet shared.";
    viewerContent.innerHTML = renderDiff(content);
  }
  if (viewer) viewer.style.display = "flex";
  renderFileTree();
}

function closeFileViewer() {
  state.workspace.activeFile = null;
  const viewer = $("#file-viewer");
  if (viewer) viewer.style.display = "none";
  renderFileTree();
}

// ---------------------------------------------------------------------------
// 13. Export
// ---------------------------------------------------------------------------

function exportJSON() {
  if (!state.session) return;
  const data = {
    session: { id: state.session.id, name: state.session.name, role: state.session.role },
    messages: state.messages,
    participants: state.participants,
    exported_at: new Date().toISOString(),
  };
  downloadFile(`relay-${state.session.id.slice(0, 8)}.json`, JSON.stringify(data, null, 2), "application/json");
  showToast("Exported as JSON", "success");
}

function exportMarkdown() {
  if (!state.session) return;
  const lines = [
    `# Relay Session: ${state.session.name || state.session.id}`,
    `Exported: ${new Date().toISOString()}`,
    `Participants: ${state.participants.join(", ")}`,
    "",
    "---",
    "",
  ];
  for (const msg of state.messages) {
    const sender = msg.sender_name || msg.sender || "unknown";
    const time = absoluteTime(msg.sent_at);
    lines.push(`### ${sender} [${msg.type || "message"}] — ${time}`);
    lines.push("");
    lines.push(msg.content || "");
    lines.push("");
  }
  downloadFile(`relay-${state.session.id.slice(0, 8)}.md`, lines.join("\n"), "text/markdown");
  showToast("Exported as Markdown", "success");
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

// ---------------------------------------------------------------------------
// 14. Solid Pod Export Modal
// ---------------------------------------------------------------------------

function openSolidExportModal() {
  const modal = $("#solid-export-modal");
  if (!modal) return;
  modal.style.display = "flex";

  // Restore saved config from localStorage (minus secrets)
  const saved = JSON.parse(localStorage.getItem("relay-solid-config") || "{}");
  const podUrlInput = $("#solid-pod-url");
  const webIdInput = $("#solid-web-id");
  const containerInput = $("#solid-container-path");
  if (podUrlInput && saved.podUrl) podUrlInput.value = saved.podUrl;
  if (webIdInput && saved.webId) webIdInput.value = saved.webId;
  if (containerInput && saved.containerPath) containerInput.value = saved.containerPath;
}

function closeSolidExportModal() {
  const modal = $("#solid-export-modal");
  if (modal) modal.style.display = "none";
}

async function submitSolidExport() {
  const podUrl = $("#solid-pod-url")?.value.trim();
  const webId = $("#solid-web-id")?.value.trim();
  const containerPath = $("#solid-container-path")?.value.trim() || "/relay-exports/";
  const accessToken = $("#solid-access-token")?.value.trim();

  if (!podUrl || !accessToken) {
    showToast("Pod URL and access token required", "error");
    return;
  }

  // Save config (minus secrets)
  localStorage.setItem("relay-solid-config", JSON.stringify({ podUrl, webId, containerPath }));

  try {
    const data = {
      session: { id: state.session.id, name: state.session.name },
      messages: state.messages,
      participants: state.participants,
      exported_at: new Date().toISOString(),
    };

    const resourceUrl = `${podUrl.replace(/\/$/, "")}${containerPath}relay-${state.session.id.slice(0, 8)}.json`;
    const res = await fetch(resourceUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) throw new Error(`Pod returned ${res.status}`);

    showToast("Exported to Solid Pod", "success");
    closeSolidExportModal();
  } catch (err) {
    showToast(`Pod export failed: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// 15. Relative Timestamp Updater
// ---------------------------------------------------------------------------

function refreshTimestamps() {
  for (const el of $$("time.timestamp[data-ts]")) {
    const ts = el.dataset.ts;
    if (ts) el.textContent = relativeTime(ts);
  }
}

// ---------------------------------------------------------------------------
// 16. Peer Mode Simulations (preserved from v2)
// ---------------------------------------------------------------------------

const SIMULATIONS = {
  security: [
    { from: "A", type: "context", content: "I've been analyzing the authentication module. Found 3 critical patterns worth sharing.", delay: 800 },
    { from: "B", type: "question", content: "What did you find? I'm about to refactor the login flow and need to understand the current auth state.", delay: 2200 },
    { from: "A", type: "insight", content: "Pattern 1: The JWT refresh logic has a race condition. When two API calls fire simultaneously with an expired token, both trigger a refresh \u2014 but the second one invalidates the first's new token.", delay: 3500 },
    { from: "A", type: "insight", content: "Pattern 2: Session tokens are stored in localStorage (XSS-vulnerable). The httpOnly cookie path exists in the codebase but is commented out \u2014 looks intentional but risky.", delay: 2000 },
    { from: "B", type: "answer", content: "That race condition explains the intermittent 401s in the error logs. I'll add a token refresh mutex \u2014 queue concurrent refreshes behind a single promise.", delay: 3000 },
    { from: "A", type: "insight", content: "Pattern 3: The OAuth callback doesn't validate the `state` parameter. CSRF protection is essentially missing on the social login flow.", delay: 2500 },
    { from: "B", type: "task", content: "Got it. I'll prioritize these three fixes:\n1. Token refresh mutex\n2. Migrate to httpOnly cookies\n3. Add CSRF state validation to OAuth\nShould have a PR up within the hour.", delay: 3200 },
    { from: "A", type: "context", content: "One more thing \u2014 the rate limiter on /api/auth/login is set to 100 req/min. Industry standard for login endpoints is 5-10. Might want to tighten that too.", delay: 2800 },
    { from: "B", type: "answer", content: "Good catch. I'll drop it to 5/min with exponential backoff. Adding it to the PR scope. Thanks for the thorough audit \u2014 this kind of cross-session knowledge sharing is exactly what the relay is for.", delay: 3500 },
    { from: "A", type: "context", content: "Agreed. I'll move on to the database layer next. Will relay findings as I go. Happy building (o^_^o)", delay: 2000 },
  ],
  codereview: [
    { from: "A", type: "context", content: "Reviewing PR #247 \u2014 the new payment processing module. 412 lines across 6 files. Starting with the core PaymentService class.", delay: 1000 },
    { from: "A", type: "insight", content: "PaymentService.processCharge() catches all exceptions and returns { success: false } silently. This swallows Stripe webhook signature validation failures \u2014 a security hole.", delay: 3000 },
    { from: "B", type: "answer", content: "Good catch. I'll narrow the catch to only handle StripeCardError and StripeRateLimitError. Everything else should bubble up to the error boundary.", delay: 2500 },
    { from: "A", type: "insight", content: "The refund logic uses floating point arithmetic for currency. Line 187: `amount * 0.95` for partial refunds. This will produce rounding errors on real transactions.", delay: 3200 },
    { from: "B", type: "task", content: "Switching to integer cents throughout. Will use Math.round(amount * 100) at input boundaries and divide only for display. Classic money bug \u2014 glad we caught it pre-merge.", delay: 2800 },
    { from: "A", type: "question", content: "The idempotency key generation uses Date.now(). Two rapid requests from the same user could collide. Was this intentional as a rate limit mechanism, or should it use a proper UUID?", delay: 3000 },
    { from: "B", type: "answer", content: "Unintentional \u2014 it should be crypto.randomUUID(). The rate limiting should happen at the API gateway level, not through idempotency key collisions. Fixing now.", delay: 2500 },
    { from: "A", type: "context", content: "Overall assessment: strong architecture, clean separation of concerns. The 3 issues above are the only blockers. Once fixed, this is ready to merge. Nice work on the webhook retry queue.", delay: 2000 },
    { from: "B", type: "answer", content: "All 3 fixes pushed. Re-requesting your review. Thanks for the thorough pass \u2014 the floating point bug alone could have cost us real money in production.", delay: 2200 },
  ],
  bughunt: [
    { from: "A", type: "context", content: "Investigating: users report intermittent 500 errors on the /api/dashboard endpoint. Only happens during peak hours (2-4 PM EST). Error logs show 'connection pool exhausted'.", delay: 1200 },
    { from: "B", type: "question", content: "What's the pool config? And are there any long-running queries that might be holding connections during those hours?", delay: 2500 },
    { from: "A", type: "insight", content: "Found it. Pool max is 10 connections. But the analytics aggregation query (getMonthlyStats) takes 8-12 seconds and doesn't release its connection until the full result set is streamed. During peak hours, 3-4 users hit this simultaneously = pool starved.", delay: 4000 },
    { from: "B", type: "task", content: "Two-pronged fix:\n1. Immediate: bump pool to 25, add 5s query timeout\n2. Root cause: rewrite getMonthlyStats to use a materialized view that refreshes every 15 min instead of computing live", delay: 3000 },
    { from: "A", type: "insight", content: "Also found a connection leak in the error path of getUserPreferences(). If the JSON parse fails on line 94, the connection is never released back to the pool. This has been slowly eating connections since deploy v2.3.1.", delay: 3500 },
    { from: "B", type: "answer", content: "That's the smoking gun. The parse failure + no connection release means the pool shrinks permanently over time. By afternoon peak, we're running on 2-3 connections instead of 10. Adding a finally block to release in all paths.", delay: 3000 },
    { from: "A", type: "context", content: "Confirmed by graphing pool.activeCount over 24h \u2014 it ratchets up by 1-2 per hour and never recovers until the nightly restart. Mystery solved. The materialized view is still a good optimization but the leak was the real killer.", delay: 2800 },
    { from: "B", type: "answer", content: "Fix deployed to staging. Pool leak patched + timeout added + pool bumped to 25 as safety margin. Monitoring the activeCount graph. Should see it flatline now instead of climbing. (o^_^o)", delay: 2500 },
  ],
  workspace: [
    { from: "B", type: "status_update", content: "reading project structure", delay: 800 },
    { from: "B", type: "file_tree", content: "src/\n  components/\n    Header.tsx\n    Sidebar.tsx\n    Dashboard.tsx\n  api/\n    auth.ts\n    payments.ts\n    users.ts\n  utils/\n    helpers.ts\n    constants.ts\n  App.tsx\n  index.ts\npackage.json\ntsconfig.json", delay: 1500 },
    { from: "A", type: "context", content: "I need you to review the auth module and fix the token refresh race condition we discussed.", delay: 2000 },
    { from: "B", type: "status_update", content: "reading src/api/auth.ts", delay: 1000 },
    { from: "B", type: "file_read", content: "path: src/api/auth.ts\n---\nimport { jwtDecode } from 'jwt-decode';\n\nlet accessToken: string | null = null;\n\nexport async function refreshToken(): Promise<string> {\n  // BUG: No mutex \u2014 concurrent calls both refresh\n  const res = await fetch('/api/auth/refresh', {\n    method: 'POST',\n    credentials: 'include',\n  });\n  const data = await res.json();\n  accessToken = data.access_token;\n  return accessToken;\n}\n\nexport async function authFetch(url: string, opts?: RequestInit) {\n  if (!accessToken || isExpired(accessToken)) {\n    accessToken = await refreshToken();\n  }\n  return fetch(url, {\n    ...opts,\n    headers: { ...opts?.headers, Authorization: `Bearer ${accessToken}` },\n  });\n}\n\nfunction isExpired(token: string): boolean {\n  const { exp } = jwtDecode(token);\n  return Date.now() >= exp * 1000;\n}", delay: 3000 },
    { from: "B", type: "insight", content: "Found the race condition on line 7. Two concurrent authFetch() calls both see an expired token and both call refreshToken(). The second refresh invalidates the first's token. Need a mutex.", delay: 2500 },
    { from: "B", type: "status_update", content: "writing fix for auth.ts", delay: 800 },
    { from: "B", type: "file_change", content: "path: src/api/auth.ts\n---\n import { jwtDecode } from 'jwt-decode';\n \n let accessToken: string | null = null;\n+let refreshPromise: Promise<string> | null = null;\n \n export async function refreshToken(): Promise<string> {\n-  // BUG: No mutex \u2014 concurrent calls both refresh\n-  const res = await fetch('/api/auth/refresh', {\n-    method: 'POST',\n-    credentials: 'include',\n-  });\n-  const data = await res.json();\n-  accessToken = data.access_token;\n-  return accessToken;\n+  // Mutex: if a refresh is already in-flight, wait for it\n+  if (refreshPromise) return refreshPromise;\n+\n+  refreshPromise = (async () => {\n+    try {\n+      const res = await fetch('/api/auth/refresh', {\n+        method: 'POST',\n+        credentials: 'include',\n+      });\n+      const data = await res.json();\n+      accessToken = data.access_token;\n+      return accessToken;\n+    } finally {\n+      refreshPromise = null;\n+    }\n+  })();\n+\n+  return refreshPromise;\n }", delay: 3500 },
    { from: "A", type: "answer", content: "Perfect \u2014 the mutex pattern looks clean. The finally block ensures the lock is always released. Ship it.", delay: 2000 },
    { from: "B", type: "status_update", content: "running tests", delay: 1000 },
    { from: "B", type: "answer", content: "All 47 tests passing. The concurrent refresh test now correctly deduplicates \u2014 2 simultaneous authFetch() calls result in exactly 1 refresh call instead of 2.", delay: 2500 },
    { from: "B", type: "status_update", content: "idle", delay: 500 },
  ],
};

async function runSimulation(scriptKey) {
  if (state.simulating) return;
  state.simulating = true;

  const script = SIMULATIONS[scriptKey];
  if (!script) {
    showToast(`Unknown simulation: ${scriptKey}`, "error");
    state.simulating = false;
    return;
  }

  // The main feed serves as the simulation target
  const feed = $("#message-feed");

  try {
    // Create a real session for the simulation
    const createRes = await api._fetch("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: `sim-${scriptKey}` }),
    });
    const joinRes = await api._fetch(`/sessions/${createRes.session_id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${createRes.invite_token}` },
      body: JSON.stringify({ participant_name: "Claude Beta" }),
    });

    state.simTokenA = createRes.creator_token;
    state.simTokenB = joinRes.participant_token;

    renderSystemMessage(`Simulation: ${scriptKey}`);

    for (const step of script) {
      if (!state.simulating) break;
      const sender = step.from === "A" ? "Claude Alpha" : "Claude Beta";
      const token = step.from === "A" ? state.simTokenA : state.simTokenB;

      await sleep(step.delay);

      // Send to real server
      await api._fetch(`/relay/${createRes.session_id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: step.type, content: step.content, sender_name: sender }),
      });

      // Render locally
      const msg = {
        message_id: crypto.randomUUID(),
        type: step.type,
        content: step.content,
        sender_name: sender,
        sent_at: new Date().toISOString(),
      };
      renderMessage(msg);
      state.peerCounts.total++;
      updateMessageCount();
    }

    renderSystemMessage("Simulation complete.");
  } catch (err) {
    renderSystemMessage(`Simulation error: ${err.message}`);
  }

  state.simulating = false;
}

// ---------------------------------------------------------------------------
// 17. Plugin Support
// ---------------------------------------------------------------------------

async function loadPlugins() {
  try {
    const res = await fetch("/plugins/manifest.json");
    if (!res.ok) return;
    const manifest = await res.json();
    for (const plugin of manifest.plugins || []) {
      if (plugin.script) {
        const script = document.createElement("script");
        script.src = plugin.script;
        script.async = true;
        document.body.appendChild(script);
        console.log(`[plugin] Loaded: ${plugin.name || plugin.script}`);
      }
    }
  } catch {
    // No plugins available — that's fine
  }
}

// ---------------------------------------------------------------------------
// 18. Keyboard Shortcuts
// ---------------------------------------------------------------------------

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl + Enter to send
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      const textarea = $("#message-input");
      if (textarea && document.activeElement === textarea) {
        e.preventDefault();
        sendMessage();
      }
    }

    // Escape to close modals
    if (e.key === "Escape") {
      closeSolidExportModal();
      closeFileViewer();
    }
  });
}

// ---------------------------------------------------------------------------
// 19. Scroll Detection
// ---------------------------------------------------------------------------

function setupScrollDetection() {
  const feed = $("#message-feed");
  if (!feed) return;

  feed.addEventListener("scroll", () => {
    const threshold = 50;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < threshold;
    state.userScrolled = !atBottom;
  });
}

// ---------------------------------------------------------------------------
// 20. Health Polling
// ---------------------------------------------------------------------------

function startHealthPolling() {
  if (state.healthTimer) clearInterval(state.healthTimer);
  pollHealth();
  state.healthTimer = setInterval(pollHealth, 30_000);
}

// ---------------------------------------------------------------------------
// 21. Sidebar Toggle (Responsive)
// ---------------------------------------------------------------------------

function setupSidebarToggle() {
  const sidebar = $("#sidebar");
  const toggleBtn = $("#btn-toggle-sidebar");
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
    });
  }
  const expandBtn = $("#btn-expand-sidebar");
  if (expandBtn && sidebar) {
    expandBtn.addEventListener("click", () => {
      sidebar.classList.remove("collapsed");
    });
  }
}

// ---------------------------------------------------------------------------
// 22. Event Binding
// ---------------------------------------------------------------------------

function bindEvents() {
  // Session setup
  $("#btn-create")?.addEventListener("click", createSession);
  $("#btn-join")?.addEventListener("click", joinSession);

  // Navbar
  $("#btn-export")?.addEventListener("click", exportJSON);
  $("#btn-export-md")?.addEventListener("click", exportMarkdown);
  $("#btn-export-pod")?.addEventListener("click", openSolidExportModal);
  $("#btn-end-session")?.addEventListener("click", endSession);

  // Input
  $("#btn-send")?.addEventListener("click", sendMessage);
  const textarea = $("#message-input");
  if (textarea) {
    // Auto-resize
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
    });
  }

  // File viewer close
  $("#btn-close-viewer")?.addEventListener("click", closeFileViewer);

  // Solid Pod modal
  $("#btn-solid-export-submit")?.addEventListener("click", submitSolidExport);
  $("#btn-solid-export-cancel")?.addEventListener("click", closeSolidExportModal);

  // Session name display — click to copy session ID
  $("#session-name-display")?.addEventListener("click", () => {
    if (state.session?.id) {
      copyText(state.session.id);
      showToast("Session ID copied", "info");
    }
  });

  // Simulation buttons (if sim-picker exists)
  const simPicker = $("#sim-picker");
  const simBtn = $("#btn-simulate");
  if (simBtn) {
    simBtn.addEventListener("click", () => {
      const key = simPicker?.value || "security";
      runSimulation(key);
    });
  }
  const clearBtn = $("#btn-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      const feed = $("#message-feed");
      if (feed) feed.innerHTML = "";
      state.peerCounts = { a: 0, b: 0, total: 0 };
      state.simulating = false;
      updateMessageCount();
    });
  }

  // Copy invite token (if button exists)
  $("#btn-copy-invite")?.addEventListener("click", () => {
    if (state.session?.invite) {
      copyText(state.session.invite);
      showToast("Invite token copied", "info");
    }
  });
}

// ---------------------------------------------------------------------------
// 23. Initialization
// ---------------------------------------------------------------------------

function init() {
  bindEvents();
  setupKeyboardShortcuts();
  setupScrollDetection();
  setupSidebarToggle();

  // Timestamps refresh every 30s
  state.timestampTimer = setInterval(refreshTimestamps, 30_000);

  // Try to restore saved session
  const hasSession = loadSavedSession();
  if (hasSession) {
    transitionToApp();
    loadHistory();
    connectSSE();
    startHealthPolling();
    updateSessionDisplay();
    refreshParticipants();
  } else {
    transitionToSetup();
    // Still poll health for the status bar on the setup page
    pollHealth();
  }

  // Load plugins (non-blocking)
  loadPlugins();

  // URL parameter support: ?sim=workspace&autorun=1
  const params = new URLSearchParams(window.location.search);
  const urlSim = params.get("sim");
  if (urlSim) {
    const simPicker = $("#sim-picker");
    if (simPicker) simPicker.value = urlSim;
  }
  if (params.get("autorun") === "1") {
    setTimeout(() => {
      const simBtn = $("#btn-simulate");
      if (simBtn) simBtn.click();
    }, 500);
  }
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
