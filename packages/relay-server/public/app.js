// === Claude Relay Dashboard v2 ===

const API = window.location.origin; // works with localhost, ngrok, any host

const state = {
  mode: "director", // "director" | "peer"
  // Session state (director mode)
  sessionId: null,
  myToken: null,
  inviteToken: null,
  myName: "Director",
  cursor: 0,
  eventSource: null,
  // Peer simulation state
  simTokenA: null,
  simTokenB: null,
  simulating: false,
  // Counters
  directorCount: 0,
  countA: 0,
  countB: 0,
  totalRelayed: 0,
};

// --- DOM ---
const $ = (s) => document.querySelector(s);
const directorView = $("#director-view");
const peerView = $("#peer-view");
const modeToggle = $("#mode-toggle");
const toggleTrack = modeToggle.querySelector(".toggle-track");
const modeLabels = modeToggle.querySelectorAll(".mode-label");

// Session bar
const sessionControls = $("#session-controls");
const joinControls = $("#join-controls");
const peerControls = $("#peer-controls");
const sessionBadge = $("#session-badge");
const inviteTokenEl = $("#invite-token");
const statusDot = $("#status-dot");
const statusText = $("#status-text");
const msgTotal = $("#msg-total");
const relayInfo = $("#relay-info");

// Director
const directorMessages = $("#director-messages");
const directorTextarea = $("#director-textarea");
const directorTyping = $("#director-typing");
const directorCountEl = $("#director-count");
const workerName = $("#worker-name");
const workerStatus = $("#worker-status");

// Peer
const messagesA = $("#messages-a");
const messagesB = $("#messages-b");
const countAEl = $("#count-a");
const countBEl = $("#count-b");
const typingA = $("#typing-a");
const typingB = $("#typing-b");

// --- Clipboard (works over plain HTTP) ---
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function setupSessionBadge(sessionId) {
  sessionBadge.textContent = `session: ${sessionId.slice(0, 8)}...`;
  sessionBadge.title = sessionId;
  sessionBadge.style.cursor = "pointer";
  sessionBadge.onclick = () => {
    copyText(sessionId);
    sessionBadge.textContent = "copied!";
    setTimeout(() => { sessionBadge.textContent = `session: ${sessionId.slice(0, 8)}...`; }, 1500);
  };
  sessionBadge.classList.add("active");
}

// --- API ---
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token || state.myToken}` };
}

async function checkHealth() {
  try {
    const data = await api("/health");
    statusDot.classList.add("connected");
    statusText.textContent = "connected";
    const nostrStr = data.nostr ? ` | nostr: ${data.nostr.connections} ws, ${data.nostr.events} events` : "";
    relayInfo.textContent = `relay server: ${window.location.host} | v${data.version} | ${data.sessions} session(s)${nostrStr}`;
    return true;
  } catch {
    statusDot.classList.remove("connected");
    statusText.textContent = "disconnected";
    return false;
  }
}

// --- Mode Toggle ---
function setMode(mode) {
  state.mode = mode;
  if (mode === "director") {
    directorView.style.display = "flex";
    peerView.style.display = "none";
    toggleTrack.classList.remove("peer");
    peerControls.style.display = "none";
    // Show session controls if we have a session, else show new session button
    updateSessionBar();
  } else {
    directorView.style.display = "none";
    peerView.style.display = "flex";
    toggleTrack.classList.add("peer");
    sessionControls.style.display = "none";
    joinControls.style.display = "none";
    peerControls.style.display = "flex";
    $("#btn-new-session").style.display = "none";
  }
  modeLabels.forEach((l) => {
    l.classList.toggle("active", l.dataset.mode === mode);
  });
  localStorage.setItem("relay-mode", mode);
}

modeToggle.addEventListener("click", () => {
  setMode(state.mode === "director" ? "peer" : "director");
});

function updateSessionBar() {
  if (state.mode !== "director") return;
  if (state.sessionId) {
    $("#btn-new-session").style.display = "none";
    sessionControls.style.display = "flex";
    joinControls.style.display = "none";
  } else {
    $("#btn-new-session").style.display = "";
    sessionControls.style.display = "none";
    // Show join controls too
    joinControls.style.display = "flex";
  }
}

// --- Session Management (Director) ---
async function createSession() {
  try {
    const data = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "Director Session" }),
    });
    state.sessionId = data.session_id;
    state.myToken = data.creator_token;
    state.inviteToken = data.invite_token;
    state.cursor = 0;
    state.myName = "Director";

    setupSessionBadge(data.session_id);
    inviteTokenEl.textContent = data.invite_token;
    updateSessionBar();
    renderSystemMsg(directorMessages, "Session created. Share the invite token with the worker.");
    saveSession();
    startSSE();
  } catch (err) {
    renderSystemMsg(directorMessages, `Error: ${err.message}`);
  }
}

async function joinSession() {
  const sid = $("#join-session-id").value.trim();
  const invite = $("#join-invite-token").value.trim();
  if (!sid || !invite) return;

  try {
    const data = await api(`/sessions/${sid}/join`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${invite}` },
      body: JSON.stringify({ participant_name: "Director" }),
    });
    state.sessionId = sid;
    state.myToken = data.participant_token;
    state.inviteToken = null;
    state.cursor = 0;
    state.myName = "Director";

    setupSessionBadge(sid);
    updateSessionBar();
    renderSystemMsg(directorMessages, "Joined session as Director.");
    saveSession();
    startSSE();
  } catch (err) {
    renderSystemMsg(directorMessages, `Error: ${err.message}`);
  }
}

function endSession() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.sessionId = null;
  state.myToken = null;
  state.inviteToken = null;
  state.cursor = 0;
  state.directorCount = 0;
  sessionBadge.textContent = "no session";
  sessionBadge.classList.remove("active");
  directorMessages.innerHTML = "";
  directorCountEl.textContent = "0 msgs";
  workerName.textContent = "Waiting for worker...";
  workerStatus.textContent = "no one connected";
  updateSessionBar();
  localStorage.removeItem("relay-session");
}

function saveSession() {
  if (state.sessionId) {
    localStorage.setItem("relay-session", JSON.stringify({
      sessionId: state.sessionId,
      myToken: state.myToken,
      inviteToken: state.inviteToken,
      cursor: state.cursor,
    }));
  }
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem("relay-session"));
    if (saved?.sessionId) {
      state.sessionId = saved.sessionId;
      state.myToken = saved.myToken;
      state.inviteToken = saved.inviteToken;
      state.cursor = saved.cursor || 0;
      setupSessionBadge(saved.sessionId);
      if (saved.inviteToken) inviteTokenEl.textContent = saved.inviteToken;
      updateSessionBar();
      // Load existing messages
      loadHistory();
      startSSE();
    }
  } catch { /* no saved session */ }
}

async function loadHistory() {
  if (!state.sessionId || !state.myToken) return;
  try {
    const data = await api(`/relay/${state.sessionId}?since=0&limit=50`, {
      headers: authHeaders(),
    });
    for (const msg of data.messages) {
      renderDirectorMessage(msg);
      state.directorCount++;
    }
    state.cursor = data.cursor;
    directorCountEl.textContent = `${state.directorCount} msgs`;
    saveSession();
    // Check participants
    checkParticipants();
  } catch { /* session may have expired */ }
}

async function checkParticipants() {
  if (!state.sessionId || !state.myToken) return;
  try {
    const data = await api(`/sessions/${state.sessionId}`, {
      headers: authHeaders(),
    });
    const names = data.participants || [];
    const others = names.filter((n) => n !== "Director" && n !== "creator");
    if (others.length > 0) {
      workerName.textContent = others[0];
      workerStatus.textContent = `connected (${names.length} participants)`;
    }
  } catch { /* ignore */ }
}

// --- SSE Stream ---
function startSSE() {
  if (!state.sessionId || !state.myToken) return;
  if (state.eventSource) state.eventSource.close();

  // SSE needs auth — use polling fallback since EventSource doesn't support headers
  startPolling();
}

function startPolling() {
  if (state._pollTimer) clearInterval(state._pollTimer);
  state._pollTimer = setInterval(async () => {
    if (!state.sessionId || !state.myToken) return;
    try {
      const data = await api(`/relay/${state.sessionId}?since=${state.cursor}&limit=20`, {
        headers: authHeaders(),
      });
      for (const msg of data.messages) {
        renderDirectorMessage(msg);
        state.directorCount++;
        state.totalRelayed++;
      }
      if (data.messages.length > 0) {
        state.cursor = data.cursor;
        directorCountEl.textContent = `${state.directorCount} msgs`;
        msgTotal.textContent = `${state.totalRelayed} messages relayed`;
        saveSession();
        checkParticipants();
      }
    } catch { /* server down or session expired */ }
  }, 1500);
}

// --- Send Message (Director) ---
async function sendDirectorMessage() {
  const content = directorTextarea.value.trim();
  if (!content || !state.sessionId || !state.myToken) return;

  const msgType = $("#msg-type").value;

  try {
    await api(`/relay/${state.sessionId}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        type: msgType,
        content,
        sender: state.myName,
      }),
    });
    directorTextarea.value = "";
    directorTextarea.style.height = "auto";
  } catch (err) {
    renderSystemMsg(directorMessages, `Send failed: ${err.message}`);
  }
}

// --- Rendering ---
function renderDirectorMessage(msg) {
  // Handle workspace-aware message types
  if (msg.type === "file_tree") {
    handleFileTree(msg);
    return;
  }
  if (msg.type === "file_change") {
    handleFileChange(msg);
    return;
  }
  if (msg.type === "file_read") {
    handleFileRead(msg);
    return;
  }
  if (msg.type === "status_update") {
    handleStatusUpdate(msg);
    return;
  }

  const isMine = msg.sender_name === "Director" || msg.sender_name === "creator";
  const div = document.createElement("div");
  div.className = `message ${isMine ? "sent" : "received"}`;
  div.innerHTML = `
    <div class="sender">${escapeHtml(msg.sender_name)}</div>
    <div class="content">${escapeHtml(msg.content)}</div>
    <div class="meta">
      <span class="message-type ${msg.type || "context"}">${msg.type || "message"}</span>
      <span>${formatTime(msg.sent_at)}</span>
    </div>
  `;
  directorMessages.appendChild(div);
  directorMessages.scrollTop = directorMessages.scrollHeight;
}

function renderPeerMessage(container, msg, perspective) {
  const isSent = msg.sender === perspective;
  const div = document.createElement("div");
  div.className = `message ${isSent ? "sent" : "received"}`;
  div.innerHTML = `
    <div class="sender">${escapeHtml(msg.sender)}</div>
    <div class="content">${escapeHtml(msg.content)}</div>
    <div class="meta">
      <span class="message-type ${msg.type || "context"}">${msg.type || "message"}</span>
      <span>${formatTime(msg.timestamp)}</span>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderSystemMsg(container, text) {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function showToast(text) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

// ========== PEER MODE SIMULATIONS ==========

const SIMULATIONS = {
  security: [
    { from: "A", type: "context", content: "I've been analyzing the authentication module. Found 3 critical patterns worth sharing.", delay: 800 },
    { from: "B", type: "question", content: "What did you find? I'm about to refactor the login flow and need to understand the current auth state.", delay: 2200 },
    { from: "A", type: "insight", content: "Pattern 1: The JWT refresh logic has a race condition. When two API calls fire simultaneously with an expired token, both trigger a refresh — but the second one invalidates the first's new token.", delay: 3500 },
    { from: "A", type: "insight", content: "Pattern 2: Session tokens are stored in localStorage (XSS-vulnerable). The httpOnly cookie path exists in the codebase but is commented out — looks intentional but risky.", delay: 2000 },
    { from: "B", type: "answer", content: "That race condition explains the intermittent 401s in the error logs. I'll add a token refresh mutex — queue concurrent refreshes behind a single promise.", delay: 3000 },
    { from: "A", type: "insight", content: "Pattern 3: The OAuth callback doesn't validate the `state` parameter. CSRF protection is essentially missing on the social login flow.", delay: 2500 },
    { from: "B", type: "task", content: "Got it. I'll prioritize these three fixes:\n1. Token refresh mutex\n2. Migrate to httpOnly cookies\n3. Add CSRF state validation to OAuth\nShould have a PR up within the hour.", delay: 3200 },
    { from: "A", type: "context", content: "One more thing — the rate limiter on /api/auth/login is set to 100 req/min. Industry standard for login endpoints is 5-10. Might want to tighten that too.", delay: 2800 },
    { from: "B", type: "answer", content: "Good catch. I'll drop it to 5/min with exponential backoff. Adding it to the PR scope. Thanks for the thorough audit — this kind of cross-session knowledge sharing is exactly what the relay is for.", delay: 3500 },
    { from: "A", type: "context", content: "Agreed. I'll move on to the database layer next. Will relay findings as I go. Happy building (o^_^o)", delay: 2000 },
  ],

  codereview: [
    { from: "A", type: "context", content: "Reviewing PR #247 — the new payment processing module. 412 lines across 6 files. Starting with the core PaymentService class.", delay: 1000 },
    { from: "A", type: "insight", content: "PaymentService.processCharge() catches all exceptions and returns { success: false } silently. This swallows Stripe webhook signature validation failures — a security hole.", delay: 3000 },
    { from: "B", type: "answer", content: "Good catch. I'll narrow the catch to only handle StripeCardError and StripeRateLimitError. Everything else should bubble up to the error boundary.", delay: 2500 },
    { from: "A", type: "insight", content: "The refund logic uses floating point arithmetic for currency. Line 187: `amount * 0.95` for partial refunds. This will produce rounding errors on real transactions.", delay: 3200 },
    { from: "B", type: "task", content: "Switching to integer cents throughout. Will use Math.round(amount * 100) at input boundaries and divide only for display. Classic money bug — glad we caught it pre-merge.", delay: 2800 },
    { from: "A", type: "question", content: "The idempotency key generation uses Date.now(). Two rapid requests from the same user could collide. Was this intentional as a rate limit mechanism, or should it use a proper UUID?", delay: 3000 },
    { from: "B", type: "answer", content: "Unintentional — it should be crypto.randomUUID(). The rate limiting should happen at the API gateway level, not through idempotency key collisions. Fixing now.", delay: 2500 },
    { from: "A", type: "context", content: "Overall assessment: strong architecture, clean separation of concerns. The 3 issues above are the only blockers. Once fixed, this is ready to merge. Nice work on the webhook retry queue.", delay: 2000 },
    { from: "B", type: "answer", content: "All 3 fixes pushed. Re-requesting your review. Thanks for the thorough pass — the floating point bug alone could have cost us real money in production.", delay: 2200 },
  ],

  bughunt: [
    { from: "A", type: "context", content: "Investigating: users report intermittent 500 errors on the /api/dashboard endpoint. Only happens during peak hours (2-4 PM EST). Error logs show 'connection pool exhausted'.", delay: 1200 },
    { from: "B", type: "question", content: "What's the pool config? And are there any long-running queries that might be holding connections during those hours?", delay: 2500 },
    { from: "A", type: "insight", content: "Found it. Pool max is 10 connections. But the analytics aggregation query (getMonthlyStats) takes 8-12 seconds and doesn't release its connection until the full result set is streamed. During peak hours, 3-4 users hit this simultaneously = pool starved.", delay: 4000 },
    { from: "B", type: "task", content: "Two-pronged fix:\n1. Immediate: bump pool to 25, add 5s query timeout\n2. Root cause: rewrite getMonthlyStats to use a materialized view that refreshes every 15 min instead of computing live", delay: 3000 },
    { from: "A", type: "insight", content: "Also found a connection leak in the error path of getUserPreferences(). If the JSON parse fails on line 94, the connection is never released back to the pool. This has been slowly eating connections since deploy v2.3.1.", delay: 3500 },
    { from: "B", type: "answer", content: "That's the smoking gun. The parse failure + no connection release means the pool shrinks permanently over time. By afternoon peak, we're running on 2-3 connections instead of 10. Adding a finally block to release in all paths.", delay: 3000 },
    { from: "A", type: "context", content: "Confirmed by graphing pool.activeCount over 24h — it ratchets up by 1-2 per hour and never recovers until the nightly restart. Mystery solved. The materialized view is still a good optimization but the leak was the real killer.", delay: 2800 },
    { from: "B", type: "answer", content: "Fix deployed to staging. Pool leak patched + timeout added + pool bumped to 25 as safety margin. Monitoring the activeCount graph. Should see it flatline now instead of climbing. (o^_^o)", delay: 2500 },
  ],
};

async function runSimulation() {
  if (state.simulating) return;
  state.simulating = true;
  const btn = $("#btn-simulate");
  btn.disabled = true;
  btn.textContent = "● Simulating...";

  document.querySelectorAll(".spine-line").forEach((l) => l.classList.add("active"));

  const scriptKey = $("#sim-picker").value;
  const script = SIMULATIONS[scriptKey];

  try {
    const createRes = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: scriptKey }),
    });

    const joinRes = await api(`/sessions/${createRes.session_id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${createRes.invite_token}` },
      body: JSON.stringify({ participant_name: "Claude Beta" }),
    });

    state.simTokenA = createRes.creator_token;
    state.simTokenB = joinRes.participant_token;

    renderSystemMsg(messagesA, `Simulation: ${$("#sim-picker").selectedOptions[0].text}`);
    renderSystemMsg(messagesB, `Simulation: ${$("#sim-picker").selectedOptions[0].text}`);

    for (const step of script) {
      if (!state.simulating) break;
      const sender = step.from === "A" ? "Claude Alpha" : "Claude Beta";
      const token = step.from === "A" ? state.simTokenA : state.simTokenB;
      const panel = step.from;

      showTyping(panel);
      await sleep(step.delay);
      hideTyping(panel);

      await api(`/relay/${createRes.session_id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: step.type, content: step.content, sender }),
      });

      const msg = { type: step.type, content: step.content, sender, timestamp: new Date().toISOString() };
      renderPeerMessage(messagesA, msg, "Claude Alpha");
      renderPeerMessage(messagesB, msg, "Claude Beta");

      if (step.from === "A") state.countA++;
      else state.countB++;
      state.totalRelayed++;
      countAEl.textContent = `${state.countA} msgs`;
      countBEl.textContent = `${state.countB} msgs`;
      msgTotal.textContent = `${state.totalRelayed} messages relayed`;
    }

    renderSystemMsg(messagesA, "Simulation complete");
    renderSystemMsg(messagesB, "Simulation complete");
  } catch (err) {
    renderSystemMsg(messagesA, `Error: ${err.message}`);
  }

  state.simulating = false;
  btn.disabled = false;
  btn.textContent = "\u25b6 Simulate";
  document.querySelectorAll(".spine-line").forEach((l) => l.classList.remove("active"));
}

function clearPeer() {
  messagesA.innerHTML = "";
  messagesB.innerHTML = "";
  state.countA = 0;
  state.countB = 0;
  state.simulating = false;
  countAEl.textContent = "0 msgs";
  countBEl.textContent = "0 msgs";
}

function showTyping(panel) {
  (panel === "A" ? typingA : typingB).classList.add("active");
}
function hideTyping(panel) {
  (panel === "A" ? typingA : typingB).classList.remove("active");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ========== EVENT LISTENERS ==========

$("#btn-new-session").addEventListener("click", createSession);
$("#btn-join").addEventListener("click", joinSession);
$("#btn-end-session").addEventListener("click", endSession);
$("#btn-copy-invite").addEventListener("click", () => {
  copyText(state.inviteToken || "");
  showToast("Invite token copied!");
});
$("#btn-send").addEventListener("click", sendDirectorMessage);
$("#btn-simulate").addEventListener("click", runSimulation);
$("#btn-clear").addEventListener("click", clearPeer);

// Enter to send in director mode
directorTextarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendDirectorMessage();
  }
});

// Auto-resize textarea
directorTextarea.addEventListener("input", () => {
  directorTextarea.style.height = "auto";
  directorTextarea.style.height = Math.min(directorTextarea.scrollHeight, 120) + "px";
});

// ========== FILE TREE & WORKSPACE ==========

const fileTree = $("#file-tree");
const fileViewer = $("#file-viewer");
const fileViewerPath = $("#file-viewer-path");
const fileViewerContent = $("#file-viewer-content");
const sidebar = $("#sidebar");
const workerPill = $("#worker-pill");
const workerDot = $("#worker-dot");
const workerActivity = $("#worker-activity");

// Current workspace state
const workspace = {
  tree: [],       // flat list of { path, type, indent, changed }
  files: {},      // path → content cache
  activeFile: null,
};

function handleFileTree(msg) {
  // Parse file tree from content (one path per line, dirs end with /)
  const lines = (msg.content || "").split("\n").filter(Boolean);
  workspace.tree = lines.map((line) => {
    const trimmed = line.replace(/^[\s│├└─]+/, "");
    const indent = Math.floor((line.length - trimmed.length) / 2);
    const isDir = trimmed.endsWith("/");
    const name = isDir ? trimmed.slice(0, -1) : trimmed;
    return { path: name, type: isDir ? "folder" : "file", indent, changed: false };
  });
  renderFileTree();
  renderSystemMsg(directorMessages, `Worker shared project structure (${workspace.tree.length} items)`);
}

function handleFileChange(msg) {
  // msg.content format: "path: <filepath>\n---\n<diff content>"
  const lines = (msg.content || "").split("\n");
  const pathLine = lines[0] || "";
  const filePath = pathLine.replace(/^path:\s*/, "").trim();
  const diffContent = lines.slice(2).join("\n");

  // Mark file as changed in tree
  for (const item of workspace.tree) {
    if (item.path === filePath || filePath.endsWith(item.path)) {
      item.changed = true;
    }
  }
  renderFileTree();

  // Cache the diff
  workspace.files[filePath] = diffContent;

  // Render file change message in chat
  const div = document.createElement("div");
  div.className = "message file-change received";
  const preview = diffContent.split("\n").slice(0, 8).join("\n");
  div.innerHTML = `
    <div class="sender">${escapeHtml(msg.sender_name)}</div>
    <span class="file-path" data-path="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
    <div class="diff-preview">${escapeHtml(preview)}${diffContent.split("\n").length > 8 ? "\n..." : ""}</div>
    <div class="meta">
      <span class="message-type file_change">FILE CHANGE</span>
      <span>${formatTime(msg.sent_at)}</span>
    </div>
  `;
  // Click file path to open in viewer
  div.querySelector(".file-path").addEventListener("click", () => openFileViewer(filePath));
  directorMessages.appendChild(div);
  directorMessages.scrollTop = directorMessages.scrollHeight;
}

function handleFileRead(msg) {
  // msg.content format: "path: <filepath>\n---\n<file content>"
  const lines = (msg.content || "").split("\n");
  const pathLine = lines[0] || "";
  const filePath = pathLine.replace(/^path:\s*/, "").trim();
  const fileContent = lines.slice(2).join("\n");

  workspace.files[filePath] = fileContent;

  renderSystemMsg(directorMessages, `Worker shared: ${filePath}`);

  // Auto-open in viewer
  openFileViewer(filePath);
}

function handleStatusUpdate(msg) {
  const status = (msg.content || "").trim().toLowerCase();
  workerPill.style.display = "flex";

  workerDot.className = "worker-status-dot";
  if (status.includes("writing") || status.includes("editing")) {
    workerDot.classList.add("writing");
    workerActivity.textContent = "writing";
  } else if (status.includes("testing") || status.includes("running")) {
    workerDot.classList.add("testing");
    workerActivity.textContent = "testing";
  } else if (status.includes("reading") || status.includes("exploring")) {
    workerDot.classList.add("active");
    workerActivity.textContent = "reading";
  } else if (status.includes("idle") || status.includes("done")) {
    workerActivity.textContent = "idle";
  } else {
    workerDot.classList.add("active");
    workerActivity.textContent = status.slice(0, 20);
  }
}

function renderFileTree() {
  fileTree.innerHTML = "";
  if (workspace.tree.length === 0) {
    fileTree.innerHTML = '<div class="file-tree-empty">No workspace data yet.<br>Worker will share file structure when connected.</div>';
    return;
  }

  for (const item of workspace.tree) {
    const div = document.createElement("div");
    const isFolder = item.type === "folder";
    div.className = `ft-item ${isFolder ? "ft-folder" : "ft-file"}${item.changed ? " changed" : ""}${item.path === workspace.activeFile ? " active" : ""}`;

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
        if (workspace.files[item.path]) {
          openFileViewer(item.path);
        }
      });
    }

    fileTree.appendChild(div);
  }
}

function openFileViewer(path) {
  workspace.activeFile = path;
  fileViewerPath.textContent = path;

  const content = workspace.files[path] || "File not yet shared by worker.";

  // Render with diff highlighting
  const lines = content.split("\n");
  let html = "";
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      html += `<span class="line-added">${escapeHtml(line)}\n</span>`;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      html += `<span class="line-removed">${escapeHtml(line)}\n</span>`;
    } else {
      html += escapeHtml(line) + "\n";
    }
  }
  fileViewerContent.innerHTML = html;

  fileViewer.style.display = "flex";
  renderFileTree(); // refresh active state
}

function closeFileViewer() {
  workspace.activeFile = null;
  fileViewer.style.display = "none";
  renderFileTree();
}

// Sidebar toggle
$("#btn-toggle-sidebar").addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});
$("#btn-expand-sidebar").addEventListener("click", () => {
  sidebar.classList.remove("collapsed");
});

// Close file viewer
$("#btn-close-viewer").addEventListener("click", closeFileViewer);

// ========== WORKSPACE SIMULATION ==========

SIMULATIONS.workspace = [
  { from: "B", type: "status_update", content: "reading project structure", delay: 800 },
  { from: "B", type: "file_tree", content:
`src/
  components/
    Header.tsx
    Sidebar.tsx
    Dashboard.tsx
  api/
    auth.ts
    payments.ts
    users.ts
  utils/
    helpers.ts
    constants.ts
  App.tsx
  index.ts
package.json
tsconfig.json`, delay: 1500 },
  { from: "A", type: "context", content: "I need you to review the auth module and fix the token refresh race condition we discussed.", delay: 2000 },
  { from: "B", type: "status_update", content: "reading src/api/auth.ts", delay: 1000 },
  { from: "B", type: "file_read", content:
`path: src/api/auth.ts
---
import { jwtDecode } from 'jwt-decode';

let accessToken: string | null = null;

export async function refreshToken(): Promise<string> {
  // BUG: No mutex — concurrent calls both refresh
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json();
  accessToken = data.access_token;
  return accessToken;
}

export async function authFetch(url: string, opts?: RequestInit) {
  if (!accessToken || isExpired(accessToken)) {
    accessToken = await refreshToken();
  }
  return fetch(url, {
    ...opts,
    headers: { ...opts?.headers, Authorization: \`Bearer \${accessToken}\` },
  });
}

function isExpired(token: string): boolean {
  const { exp } = jwtDecode(token);
  return Date.now() >= exp * 1000;
}`, delay: 3000 },
  { from: "B", type: "insight", content: "Found the race condition on line 7. Two concurrent authFetch() calls both see an expired token and both call refreshToken(). The second refresh invalidates the first's token. Need a mutex.", delay: 2500 },
  { from: "B", type: "status_update", content: "writing fix for auth.ts", delay: 800 },
  { from: "B", type: "file_change", content:
`path: src/api/auth.ts
---
 import { jwtDecode } from 'jwt-decode';

 let accessToken: string | null = null;
+let refreshPromise: Promise<string> | null = null;

 export async function refreshToken(): Promise<string> {
-  // BUG: No mutex — concurrent calls both refresh
-  const res = await fetch('/api/auth/refresh', {
-    method: 'POST',
-    credentials: 'include',
-  });
-  const data = await res.json();
-  accessToken = data.access_token;
-  return accessToken;
+  // Mutex: if a refresh is already in-flight, wait for it
+  if (refreshPromise) return refreshPromise;
+
+  refreshPromise = (async () => {
+    try {
+      const res = await fetch('/api/auth/refresh', {
+        method: 'POST',
+        credentials: 'include',
+      });
+      const data = await res.json();
+      accessToken = data.access_token;
+      return accessToken;
+    } finally {
+      refreshPromise = null;
+    }
+  })();
+
+  return refreshPromise;
 }`, delay: 3500 },
  { from: "A", type: "answer", content: "Perfect — the mutex pattern looks clean. The finally block ensures the lock is always released. Ship it.", delay: 2000 },
  { from: "B", type: "status_update", content: "running tests", delay: 1000 },
  { from: "B", type: "answer", content: "All 47 tests passing. The concurrent refresh test now correctly deduplicates — 2 simultaneous authFetch() calls result in exactly 1 refresh call instead of 2.", delay: 2500 },
  { from: "B", type: "status_update", content: "idle", delay: 500 },
];

// ========== NOSTR WEBSOCKET ==========

const nostrBadge = $("#nostr-badge");
const nostrDot = $("#nostr-dot");
const nostrStatusEl = $("#nostr-status");
const nostrInfoEl = $("#nostr-info");

const nostrState = {
  ws: null,
  connected: false,
  authed: false,
  subscriptionId: null,
  eventCount: 0,
};

function getWsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

function connectNostr() {
  if (nostrState.ws) {
    nostrState.ws.close();
  }

  const wsUrl = getWsUrl();
  const ws = new WebSocket(wsUrl);
  nostrState.ws = ws;

  ws.onopen = () => {
    nostrState.connected = true;
    updateNostrUI();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg[0] === "AUTH") {
      // NIP-42: respond with a simple auth (no signing in browser — just mark as connected)
      // In production, we'd use nostr-tools in the browser to sign
      nostrState.authed = false; // No key to sign with (yet)
      nostrStatusEl.textContent = "nostr: ws";
      updateNostrUI();

      // Subscribe to all relay event kinds without auth
      nostrState.subscriptionId = "dashboard-" + Math.random().toString(36).slice(2, 8);
      ws.send(JSON.stringify(["REQ", nostrState.subscriptionId, {
        kinds: [4190,4191,4192,4193,4194,4195,4196,4197,4198,4200,4201,4202,4203,4204],
        limit: 50,
      }]));
    }

    if (msg[0] === "EOSE") {
      nostrState.authed = true;
      nostrStatusEl.textContent = "nostr: live";
      updateNostrUI();
    }

    if (msg[0] === "EVENT" && msg[1] === nostrState.subscriptionId) {
      nostrState.eventCount++;
      const event = msg[2];
      // Update footer
      if (nostrInfoEl) {
        nostrInfoEl.textContent = `nostr: ${nostrState.eventCount} events`;
      }
    }
  };

  ws.onclose = () => {
    nostrState.connected = false;
    nostrState.authed = false;
    nostrState.ws = null;
    updateNostrUI();
    // Reconnect after 5s
    setTimeout(connectNostr, 5000);
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function disconnectNostr() {
  if (nostrState.ws) {
    nostrState.ws.close();
    nostrState.ws = null;
  }
  nostrState.connected = false;
  nostrState.authed = false;
  updateNostrUI();
}

function updateNostrUI() {
  if (nostrState.connected) {
    nostrBadge.classList.add("active");
    nostrStatusEl.textContent = nostrState.authed ? "nostr: live" : "nostr: ws";
  } else {
    nostrBadge.classList.remove("active");
    nostrStatusEl.textContent = "nostr: off";
  }
}

// Toggle Nostr connection on badge click
nostrBadge.addEventListener("click", () => {
  if (nostrState.connected) {
    disconnectNostr();
  } else {
    connectNostr();
  }
});

// ========== EVENT LISTENERS (additions) ==========

// ========== INIT ==========

// Restore mode (supports ?mode=peer URL parameter)
const urlMode = new URLSearchParams(window.location.search).get("mode");
const savedMode = urlMode || localStorage.getItem("relay-mode");
setMode(savedMode || "director");

// Restore session
loadSession();

// Auto-connect Nostr WebSocket
connectNostr();

// Health check
checkHealth();
setInterval(checkHealth, 5000);

// URL parameter: ?sim=workspace to auto-select simulation
const urlSim = new URLSearchParams(window.location.search).get("sim");
if (urlSim) {
  const simPicker = document.getElementById("sim-picker");
  if (simPicker) simPicker.value = urlSim;
}

// URL parameter: ?autorun=1 to auto-start simulation
const autorun = new URLSearchParams(window.location.search).get("autorun");
if (autorun === "1") {
  setTimeout(() => {
    const simBtn = document.getElementById("btn-simulate");
    if (simBtn) simBtn.click();
  }, 500);
}
