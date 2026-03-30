/* Claude Relay Dashboard — vanilla JS */

// --------------- State ---------------
const state = {
  session: null,   // { id, token, invite, name, role, expires_at }
  messages: [],
  cursor: 0,
  pollTimer: null,
};

// --------------- Helpers ---------------

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function renderMarkdown(escaped) {
  // Code blocks: ```...```
  let html = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // URLs
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return html;
}

// --------------- API ---------------

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.session?.token) {
    headers['Authorization'] = 'Bearer ' + state.session.token;
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(location.origin + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// --------------- Session ---------------

async function createSession() {
  const name = document.getElementById('create-name').value.trim() || 'Untitled';
  const ttl = parseInt(document.getElementById('create-ttl').value, 10);
  try {
    const data = await api('POST', '/sessions', { name, ttl_minutes: ttl });
    startSession({
      id: data.session_id,
      token: data.creator_token,
      invite: data.invite_token,
      name,
      role: 'creator',
      expires_at: data.expires_at,
    });
  } catch (e) {
    alert('Create failed: ' + e.message);
  }
}

async function joinSession() {
  const id = document.getElementById('join-id').value.trim();
  const invite = document.getElementById('join-invite').value.trim();
  const name = document.getElementById('join-name').value.trim() || 'worker';
  if (!id || !invite) { alert('Session ID and invite token are required'); return; }
  try {
    // Use invite token as bearer for the join request
    const res = await fetch(location.origin + `/sessions/${id}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + invite },
      body: JSON.stringify({ invite_token: invite, name }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
    const data = await res.json();
    startSession({
      id,
      token: data.participant_token,
      invite: null,
      name: data.session.name,
      role: 'participant',
      expires_at: data.session.expires_at,
    });
  } catch (e) {
    alert('Join failed: ' + e.message);
  }
}

function startSession(sess) {
  state.session = sess;
  state.messages = [];
  state.cursor = 0;
  localStorage.setItem('relay_session', JSON.stringify(sess));

  // Switch screens
  document.getElementById('setup').style.display = 'none';
  document.getElementById('main').style.display = 'flex';

  // Populate UI
  document.getElementById('session-name').textContent = sess.name;
  document.getElementById('info-id').textContent = sess.id.slice(0, 8) + '...';
  document.getElementById('info-id').title = sess.id;
  document.getElementById('info-expires').textContent = new Date(sess.expires_at).toLocaleTimeString();
  document.getElementById('messages').innerHTML = '';
  document.getElementById('status-text').textContent = 'Connected';

  // Show invite bar for creator
  if (sess.invite) {
    document.getElementById('invite-bar').style.display = 'flex';
    document.getElementById('invite-token').textContent = sess.invite;
  } else {
    document.getElementById('invite-bar').style.display = 'none';
  }

  // Start polling
  if (state.pollTimer) clearInterval(state.pollTimer);
  poll();
  state.pollTimer = setInterval(poll, 2000);
  refreshStatus();
}

function endSession() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.session = null;
  state.messages = [];
  state.cursor = 0;
  localStorage.removeItem('relay_session');
  document.getElementById('main').style.display = 'none';
  document.getElementById('setup').style.display = 'flex';
  document.getElementById('status-text').textContent = 'Disconnected';
}

// --------------- Polling ---------------

async function poll() {
  if (!state.session) return;
  try {
    const data = await api('GET', `/relay/${state.session.id}?since=${state.cursor}&limit=50`);
    if (data.messages?.length) {
      state.cursor = data.cursor;
      for (const msg of data.messages) {
        if (!state.messages.find(m => m.message_id === msg.message_id)) {
          state.messages.push(msg);
          appendMessage(msg);
        }
      }
      updateCount();
      autoScroll();
    }
  } catch (e) {
    document.getElementById('status-text').textContent = 'Poll error: ' + e.message;
  }
}

async function refreshStatus() {
  if (!state.session) return;
  try {
    const data = await api('GET', `/sessions/${state.session.id}`);
    // Update participants
    const list = document.getElementById('participant-list');
    const nav = document.getElementById('participants');
    list.innerHTML = '';
    nav.innerHTML = '';
    const participants = data.participants || [];
    participants.forEach(p => {
      const color = getColor(p.name);
      // Sidebar list
      const li = document.createElement('li');
      li.innerHTML = `<span class="p-dot" style="background:${color}"></span>${escapeHtml(p.name)}`;
      list.appendChild(li);
      // Nav avatars
      const av = document.createElement('span');
      av.className = 'nav-avatar';
      av.style.background = color;
      av.textContent = p.name[0].toUpperCase();
      av.title = p.name;
      nav.appendChild(av);
    });
  } catch { /* ignore */ }
}

// --------------- Messages ---------------

const COLORS = ['#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#ff453a', '#5e5ce6'];
const colorMap = {};
function getColor(name) {
  if (!colorMap[name]) colorMap[name] = COLORS[Object.keys(colorMap).length % COLORS.length];
  return colorMap[name];
}

function appendMessage(msg) {
  const el = document.createElement('div');
  el.className = 'message';

  const color = getColor(msg.sender_name);
  const initial = msg.sender_name[0].toUpperCase();

  el.innerHTML = `
    <div class="msg-badge" style="background:${color}">${initial}</div>
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-sender" style="color:${color}">${escapeHtml(msg.sender_name)}</span>
        <span class="msg-type">${escapeHtml(msg.type)}</span>
        <span class="msg-time">${relativeTime(msg.sent_at)}</span>
      </div>
      <div class="msg-title">${msg.title ? escapeHtml(msg.title) : ''}</div>
      <div class="msg-content">${renderMarkdown(escapeHtml(msg.content))}</div>
    </div>`;

  document.getElementById('messages').appendChild(el);
}

function updateCount() {
  const n = state.messages.length;
  document.getElementById('info-count').textContent = n;
  document.getElementById('msg-total').textContent = n + ' message' + (n !== 1 ? 's' : '');
}

function autoScroll() {
  const el = document.getElementById('messages');
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
    el.scrollTop = el.scrollHeight;
  }
}

// --------------- Send ---------------

async function sendMessage() {
  const type = document.getElementById('msg-type').value;
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content) return;
  try {
    await api('POST', `/relay/${state.session.id}`, { type, title: '', content });
    input.value = '';
    input.style.height = 'auto';
    poll();
  } catch (e) {
    alert('Send failed: ' + e.message);
  }
}

// --------------- Export ---------------

async function exportSession(format) {
  if (!state.session) return;
  try {
    const res = await fetch(
      `${location.origin}/relay/${state.session.id}/export?format=${format}`,
      { headers: { 'Authorization': 'Bearer ' + state.session.token } }
    );
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `session-${state.session.id.slice(0, 8)}.${format === 'md' ? 'md' : 'json'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
}

// --------------- Textarea auto-resize ---------------

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// --------------- Init ---------------

function init() {
  // URL param injection: ?sid=...&token=...&name=...
  const params = new URLSearchParams(location.search);
  if (params.get('sid') && params.get('token')) {
    startSession({ id: params.get('sid'), token: params.get('token'), name: params.get('name') || 'Session' });
    history.replaceState(null, '', location.pathname);
  } else {
    // Restore saved session from localStorage
    const saved = localStorage.getItem('relay_session');
    if (saved) {
      try {
        const sess = JSON.parse(saved);
        if (sess.id && sess.token) startSession(sess);
      } catch { localStorage.removeItem('relay_session'); }
    }
  }

  // Bind events
  document.getElementById('btn-create').onclick = createSession;
  document.getElementById('btn-join').onclick = joinSession;
  document.getElementById('btn-send').onclick = sendMessage;
  document.getElementById('btn-end').onclick = endSession;
  document.getElementById('btn-export').onclick = () => exportSession('json');
  document.getElementById('btn-export-json').onclick = () => exportSession('json');
  document.getElementById('btn-export-md').onclick = () => exportSession('md');
  document.getElementById('btn-copy').onclick = () => {
    navigator.clipboard.writeText(document.getElementById('invite-token').textContent);
    const btn = document.getElementById('btn-copy');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };

  // Keyboard shortcut
  document.getElementById('msg-input').onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  };

  // Auto-resize textarea
  document.getElementById('msg-input').oninput = function () { autoResize(this); };

  // Periodically refresh participant list and relative times
  setInterval(() => {
    if (state.session) refreshStatus();
  }, 10000);
}

document.addEventListener('DOMContentLoaded', init);
