/* Protocol Chronicle — app.js
   Real API integration for the Claude Relay dashboard */

// --------------- State ---------------

const state = {
  session: null,   // { id, token, invite, name, role, expires_at }
  messages: [],
  cursor: 0,
  pollTimer: null,
  healthTimer: null,
  activeType: 'Question',
  folioCount: 0,
  userScrolled: false,
};

// Type mapping: tab label -> API type + CSS classes
const TYPES = {
  'Arch':     { api: 'architecture', ec: 'ec-arch',     pill: 'pill-arch' },
  'Question': { api: 'question',     ec: 'ec-question',  pill: 'pill-question' },
  'Answer':   { api: 'answer',       ec: 'ec-answer',    pill: 'pill-answer' },
  'Insight':  { api: 'insight',      ec: 'ec-insight',   pill: 'pill-insight' },
  'Event':    { api: 'context',      ec: 'ec-event',     pill: 'pill-event' },
};

// Reverse lookup: API type -> display info
const API_TYPE_MAP = {
  'architecture': { ec: 'ec-arch',     pill: 'pill-arch',     label: 'Arch',     color: '#E8A020' },
  'question':     { ec: 'ec-question',  pill: 'pill-question', label: 'Question', color: '#8B5CF6' },
  'answer':       { ec: 'ec-answer',    pill: 'pill-answer',   label: 'Answer',   color: '#0ED2B8' },
  'insight':      { ec: 'ec-insight',   pill: 'pill-insight',  label: 'Insight',  color: '#C084FC' },
  'context':      { ec: 'ec-event',     pill: 'pill-event',    label: 'Event',    color: '#6EE7B7' },
  // Fallbacks for other types
  'api-docs':     { ec: 'ec-arch',     pill: 'pill-arch',     label: 'API',      color: '#E8A020' },
  'patterns':     { ec: 'ec-arch',     pill: 'pill-arch',     label: 'Pattern',  color: '#E8A020' },
  'conventions':  { ec: 'ec-arch',     pill: 'pill-arch',     label: 'Conv',     color: '#E8A020' },
  'task':         { ec: 'ec-event',    pill: 'pill-event',    label: 'Task',     color: '#6EE7B7' },
  'file_tree':    { ec: 'ec-event',    pill: 'pill-event',    label: 'Files',    color: '#6EE7B7' },
  'file_change':  { ec: 'ec-event',    pill: 'pill-event',    label: 'Change',   color: '#6EE7B7' },
  'file_read':    { ec: 'ec-event',    pill: 'pill-event',    label: 'Read',     color: '#6EE7B7' },
  'terminal':     { ec: 'ec-event',    pill: 'pill-event',    label: 'Term',     color: '#6EE7B7' },
  'status_update':{ ec: 'ec-event',    pill: 'pill-event',    label: 'Status',   color: '#6EE7B7' },
};

// Avatar color palette
const AVATAR_COLORS = ['#E8A020', '#8B5CF6', '#0ED2B8', '#C084FC', '#6EE7B7', '#F472B6'];
const avatarColorMap = {};
function getAvatarColor(name) {
  if (!avatarColorMap[name]) {
    avatarColorMap[name] = AVATAR_COLORS[Object.keys(avatarColorMap).length % AVATAR_COLORS.length];
  }
  return avatarColorMap[name];
}

// --------------- Helpers ---------------

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return 'now';
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function formatTime(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return { hhmm: hh + ':' + mm, ss: ':' + ss };
}

function toRoman(num) {
  if (num <= 0 || num > 3999) return String(num);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['m', 'cm', 'd', 'cd', 'c', 'xc', 'l', 'xl', 'x', 'ix', 'v', 'iv', 'i'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (num >= vals[i]) {
      result += syms[i];
      num -= vals[i];
    }
  }
  return result;
}

function formatUptime(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
}

// --------------- Markdown Rendering ---------------

function renderMarkdown(escaped) {
  // Code blocks: ```...```
  let html = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    return '<div class="ec-code">' + code.trim() + '</div>';
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // URLs
  html = html.replace(/(https?:\/\/[^\s<&]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  // Numbered lists: lines starting with digits followed by period
  // Collect consecutive numbered lines into a group
  html = html.replace(/((?:^|\n)\d+\.\s+.+(?:\n\d+\.\s+.+)*)/g, function(match) {
    const lines = match.trim().split('\n');
    const romanNumerals = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
      'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];
    let items = '';
    lines.forEach(function(line, idx) {
      const text = line.replace(/^\d+\.\s+/, '');
      const numeral = romanNumerals[idx] || String(idx + 1);
      items += '<div class="ec-numbered-item"><span class="numeral">' + numeral + '.</span><span>' + text + '</span></div>';
    });
    return '<div class="ec-numbered">' + items + '</div>';
  });

  return html;
}

// --------------- API ---------------

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.session && state.session.token) {
    headers['Authorization'] = 'Bearer ' + state.session.token;
  }
  const opts = { method: method, headers: headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(location.origin + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(function() { return { error: res.statusText }; });
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// --------------- Session Management ---------------

async function createSession() {
  const name = document.getElementById('create-name').value.trim() || 'Untitled';
  const ttl = parseInt(document.getElementById('create-ttl').value, 10);
  const errEl = document.getElementById('create-error');
  errEl.style.display = 'none';

  try {
    const data = await api('POST', '/sessions', { name: name, ttl_minutes: ttl });
    startSession({
      id: data.session_id,
      token: data.creator_token,
      invite: data.invite_token,
      name: name,
      role: 'creator',
      expires_at: data.expires_at,
    });
  } catch (e) {
    errEl.textContent = 'Failed: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function joinSession() {
  const id = document.getElementById('join-id').value.trim();
  const invite = document.getElementById('join-invite').value.trim();
  const name = document.getElementById('join-name').value.trim() || 'worker';
  const errEl = document.getElementById('join-error');
  errEl.style.display = 'none';

  if (!id || !invite) {
    errEl.textContent = 'Session ID and invite token are required';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(location.origin + '/sessions/' + id + '/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + invite },
      body: JSON.stringify({ participant_name: name }),
    });
    if (!res.ok) {
      const e = await res.json().catch(function() { return {}; });
      throw new Error(e.error || res.statusText);
    }
    const data = await res.json();
    startSession({
      id: id,
      token: data.participant_token,
      invite: null,
      name: data.session.name,
      role: 'participant',
      expires_at: data.session.expires_at,
    });
  } catch (e) {
    errEl.textContent = 'Failed: ' + e.message;
    errEl.style.display = 'block';
  }
}

function startSession(sess) {
  state.session = sess;
  state.messages = [];
  state.cursor = 0;
  state.folioCount = 0;
  state.userScrolled = false;
  localStorage.setItem('relay_session', JSON.stringify(sess));

  // Inject URL params for sharing
  const url = new URL(location.href);
  url.searchParams.set('sid', sess.id);
  url.searchParams.set('token', sess.token);
  url.searchParams.set('name', sess.name);
  history.replaceState(null, '', url.toString());

  // Switch screens
  document.getElementById('setup').style.display = 'none';
  document.getElementById('main').style.display = 'flex';

  // Populate UI
  document.getElementById('session-name').textContent = sess.name;
  document.getElementById('info-id').textContent = sess.id.slice(0, 8) + '...';
  document.getElementById('info-id').title = sess.id;
  document.getElementById('info-expires').textContent = new Date(sess.expires_at).toLocaleTimeString();

  // Clear chronicle
  var chronicle = document.getElementById('chronicle');
  chronicle.innerHTML = '<div class="chronicle-empty" id="empty-state"><div class="empty-diamond"></div><div class="empty-title">The chronicle awaits</div><div class="empty-sub">Send the first message to begin</div></div>';

  // Show invite bar for creator
  if (sess.invite) {
    document.getElementById('invite-bar').style.display = 'flex';
    document.getElementById('invite-token').textContent = sess.invite;
  } else {
    document.getElementById('invite-bar').style.display = 'none';
  }

  // Update connection pill
  updateConnectionPill(true);

  // Update folio counter
  updateFolioCounter();

  // Start polling
  if (state.pollTimer) clearInterval(state.pollTimer);
  poll();
  state.pollTimer = setInterval(poll, 2000);

  // Start health check
  if (state.healthTimer) clearInterval(state.healthTimer);
  getHealth();
  state.healthTimer = setInterval(getHealth, 10000);

  // Refresh session info
  refreshStatus();
}

function endSession() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.healthTimer) clearInterval(state.healthTimer);
  state.session = null;
  state.messages = [];
  state.cursor = 0;
  state.folioCount = 0;
  localStorage.removeItem('relay_session');

  // Clear URL params
  history.replaceState(null, '', location.pathname);

  document.getElementById('main').style.display = 'none';
  document.getElementById('setup').style.display = 'flex';
  updateConnectionPill(false);
}

// --------------- Connection Status ---------------

function updateConnectionPill(connected) {
  const pill = document.getElementById('connection-pill');
  const label = document.getElementById('connection-label');
  if (connected) {
    pill.className = 'connection-pill';
    label.textContent = 'Connected';
  } else {
    pill.className = 'connection-pill disconnected';
    label.textContent = 'Disconnected';
  }
}

// --------------- Folio Counter ---------------

function updateFolioCounter() {
  const el = document.getElementById('folio-counter');
  if (state.folioCount === 0) {
    el.textContent = 'Folio i';
  } else {
    el.textContent = 'Folio ' + toRoman(state.folioCount);
  }
}

// --------------- Health Check ---------------

async function getHealth() {
  try {
    const data = await fetch(location.origin + '/health').then(function(r) { return r.json(); });

    // HTTP status — always active if health responds
    document.getElementById('http-dot').className = 'protocol-dot live';
    document.getElementById('http-stat').textContent = 'v' + (data.version || '?') + ' — ' + (data.sessions || 0) + ' sessions';
    document.getElementById('dot-http').className = 'bridge-dot active';

    // Nostr status
    if (data.nostr) {
      var nostrConnections = data.nostr.connections || 0;
      var nostrEvents = data.nostr.events_received || 0;
      if (nostrConnections > 0) {
        document.getElementById('nostr-dot').className = 'protocol-dot live';
        document.getElementById('dot-nostr').className = 'bridge-dot active';
        document.getElementById('nostr-stat').textContent = nostrConnections + ' ws, ' + nostrEvents + ' events';
      } else {
        document.getElementById('nostr-dot').className = 'protocol-dot off';
        document.getElementById('dot-nostr').className = 'bridge-dot inactive';
        document.getElementById('nostr-stat').textContent = nostrEvents + ' events';
      }

      // Update npub
      if (data.nostr.server_pubkey) {
        document.getElementById('id-npub').textContent = data.nostr.server_pubkey;
        document.getElementById('id-npub').title = data.nostr.server_pubkey;
      }
    }

    // Solid status
    if (data.solid) {
      if (data.solid.sync_engine === 'running') {
        document.getElementById('solid-dot').className = 'protocol-dot live';
        document.getElementById('dot-solid').className = 'bridge-dot active';
        document.getElementById('solid-stat').textContent = 'Sync running, q:' + (data.solid.queue_depth || 0);
      } else {
        document.getElementById('solid-dot').className = 'protocol-dot off';
        document.getElementById('dot-solid').className = 'bridge-dot inactive';
        document.getElementById('solid-stat').textContent = 'Stopped';
      }
    }

    // Uptime
    if (data.uptime_seconds) {
      document.getElementById('info-uptime').textContent = formatUptime(data.uptime_seconds);
    }

    updateConnectionPill(true);
  } catch (e) {
    updateConnectionPill(false);
    document.getElementById('http-dot').className = 'protocol-dot off';
    document.getElementById('dot-http').className = 'bridge-dot inactive';
  }
}

// --------------- Polling ---------------

async function poll() {
  if (!state.session) return;
  try {
    const data = await api('GET', '/relay/' + state.session.id + '?since=' + state.cursor + '&limit=50');
    if (data.messages && data.messages.length) {
      state.cursor = data.cursor;
      var newMessages = [];
      for (var i = 0; i < data.messages.length; i++) {
        var msg = data.messages[i];
        if (!state.messages.find(function(m) { return m.message_id === msg.message_id; })) {
          state.messages.push(msg);
          newMessages.push(msg);
        }
      }
      if (newMessages.length > 0) {
        // Remove empty state if present
        var emptyState = document.getElementById('empty-state');
        if (emptyState) emptyState.remove();

        for (var j = 0; j < newMessages.length; j++) {
          renderMessage(newMessages[j]);
        }
        updateCount();
        autoScroll();
      }
    }
    updateConnectionPill(true);
  } catch (e) {
    updateConnectionPill(false);
  }
}

async function refreshStatus() {
  if (!state.session) return;
  try {
    const data = await api('GET', '/sessions/' + state.session.id);
    var list = document.getElementById('participant-list');
    list.innerHTML = '';
    var participants = data.participants || [];
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      var color = getAvatarColor(p.name);
      var li = document.createElement('li');
      li.innerHTML = '<span class="participant-dot" style="background:' + color + '"></span>' + escapeHtml(p.name);
      list.appendChild(li);
    }
  } catch (e) { /* ignore */ }
}

// --------------- Message Rendering ---------------

function renderMessage(msg) {
  var typeInfo = API_TYPE_MAP[msg.type] || API_TYPE_MAP['context'];
  var senderName = msg.sender_name || 'unknown';
  var color = getAvatarColor(senderName);
  var initial = senderName[0].toUpperCase();
  var time = formatTime(msg.sent_at);

  state.folioCount++;
  updateFolioCounter();

  // Build folio entry
  var entry = document.createElement('div');
  entry.className = 'folio-entry new ' + typeInfo.ec;

  // Content processing
  var escapedContent = escapeHtml(msg.content || '');
  var renderedContent = renderMarkdown(escapedContent);

  // For insight type, extract first sentence as pull quote
  var pullQuote = '';
  if (msg.type === 'insight' && msg.content) {
    var firstSentence = msg.content.split(/[.!?]\s/)[0];
    if (firstSentence && firstSentence.length > 10 && firstSentence.length < 200) {
      pullQuote = '<div class="ec-pull">' + escapeHtml(firstSentence) + '</div>';
    }
  }

  // Title
  var titleHtml = '';
  if (msg.title) {
    titleHtml = '<div class="ec-title">' + escapeHtml(msg.title) + '</div>';
  }

  // Footer
  var origin = msg.origin || 'http';
  var hash = (msg.message_id || '').slice(0, 8);

  entry.innerHTML =
    '<div class="entry-time-col">' +
      '<span class="entry-time">' + time.hhmm + '</span>' +
      '<span class="entry-time-sec">' + time.ss + '</span>' +
      '<span class="spine-dot"></span>' +
    '</div>' +
    '<div class="entry-card">' +
      '<div class="ec-header">' +
        '<div class="ec-avatar" style="background:' + color + '">' + initial + '</div>' +
        '<span class="ec-author">' + escapeHtml(senderName) + '</span>' +
        '<span class="ec-pill ' + typeInfo.pill + '">' + typeInfo.label + '</span>' +
        '<span class="ec-relative">' + relativeTime(msg.sent_at) + '</span>' +
      '</div>' +
      titleHtml +
      pullQuote +
      '<div class="ec-body">' + renderedContent + '</div>' +
      '<div class="ec-footer">' +
        '<span class="origin-tag">' + escapeHtml(origin) + '</span>' +
        '<span class="event-hash">#' + hash + '</span>' +
      '</div>' +
    '</div>';

  document.getElementById('chronicle').appendChild(entry);

  // Remove the "new" animation class after it plays
  setTimeout(function() { entry.classList.remove('new'); }, 400);
}

function updateCount() {
  var n = state.messages.length;
  document.getElementById('info-count').textContent = n;
}

function autoScroll() {
  if (state.userScrolled) return;
  var el = document.getElementById('chronicle');
  el.scrollTop = el.scrollHeight;
}

// --------------- Send ---------------

async function sendMessage() {
  if (!state.session) return;
  var typeKey = state.activeType;
  var typeInfo = TYPES[typeKey];
  if (!typeInfo) return;

  var input = document.getElementById('msg-input');
  var content = input.value.trim();
  if (!content) return;

  try {
    await api('POST', '/relay/' + state.session.id, {
      type: typeInfo.api,
      title: '',
      content: content,
    });
    input.value = '';
    input.style.height = 'auto';
    // Immediate poll to show the message fast
    poll();
  } catch (e) {
    // Show error inline — no alert()
    var errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#ff6b6b;font-family:var(--mono);font-size:11px;padding:4px 0;';
    errDiv.textContent = 'Send failed: ' + e.message;
    input.parentNode.appendChild(errDiv);
    setTimeout(function() { errDiv.remove(); }, 4000);
  }
}

// --------------- Export ---------------

async function exportSession(format) {
  if (!state.session) return;
  try {
    var res = await fetch(
      location.origin + '/relay/' + state.session.id + '/export?format=' + format,
      { headers: { 'Authorization': 'Bearer ' + state.session.token } }
    );
    var blob = await res.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'session-' + state.session.id.slice(0, 8) + '.' + (format === 'md' ? 'md' : 'json');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    console.error('Export failed:', e);
  }
}

// --------------- Composer Tabs ---------------

function initComposerTabs() {
  var tabs = document.querySelectorAll('.composer-tab');
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      state.activeType = tab.getAttribute('data-type');
    });
  });
}

// --------------- Textarea Auto-resize ---------------

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// --------------- Mesh Canvas Background ---------------

function initMeshCanvas() {
  var canvas = document.getElementById('mesh-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var particles = [];
  var particleCount = 35; // Fewer — ambient, not arcade
  var connectionDist = 180;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (var i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.15, // Very slow drift
      vy: (Math.random() - 0.5) * 0.15,
      r: Math.random() * 1.0 + 0.3,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
    }

    // Faint connections — barely visible
    for (var i = 0; i < particles.length; i++) {
      for (var j = i + 1; j < particles.length; j++) {
        var dx = particles[i].x - particles[j].x;
        var dy = particles[i].y - particles[j].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < connectionDist) {
          var alpha = (1 - dist / connectionDist) * 0.04; // Very faint
          ctx.strokeStyle = 'rgba(139,92,246,' + alpha + ')';
          ctx.lineWidth = 0.3;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }

    // Dots — no glow, no mouse interaction, just quiet presence
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(139,92,246,0.1)';
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }

  draw();
}

// --------------- Scroll Detection ---------------

function initScrollDetection() {
  var chronicle = document.getElementById('chronicle');
  chronicle.addEventListener('scroll', function() {
    var atBottom = chronicle.scrollHeight - chronicle.scrollTop - chronicle.clientHeight < 80;
    state.userScrolled = !atBottom;
  });
}

// --------------- Init ---------------

function init() {
  // Start mesh canvas
  initMeshCanvas();

  // URL param injection: ?sid=...&token=...&name=...
  var params = new URLSearchParams(location.search);
  if (params.get('sid') && params.get('token')) {
    startSession({
      id: params.get('sid'),
      token: params.get('token'),
      invite: null,
      name: params.get('name') || 'Session',
      role: 'participant',
      expires_at: null,
    });
  } else {
    // Restore saved session from localStorage
    var saved = localStorage.getItem('relay_session');
    if (saved) {
      try {
        var sess = JSON.parse(saved);
        if (sess.id && sess.token) startSession(sess);
      } catch (e) {
        localStorage.removeItem('relay_session');
      }
    }
  }

  // Run initial health check even before session
  getHealth();

  // Bind session events
  document.getElementById('btn-create').addEventListener('click', createSession);
  document.getElementById('btn-join').addEventListener('click', joinSession);
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('btn-end').addEventListener('click', endSession);
  document.getElementById('btn-export').addEventListener('click', function() { exportSession('json'); });
  document.getElementById('btn-export-json').addEventListener('click', function() { exportSession('json'); });
  document.getElementById('btn-export-md').addEventListener('click', function() { exportSession('md'); });

  document.getElementById('btn-copy').addEventListener('click', function() {
    var tokenText = document.getElementById('invite-token').textContent;
    navigator.clipboard.writeText(tokenText);
    var btn = document.getElementById('btn-copy');
    btn.textContent = 'Copied';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });

  // Enter key on setup inputs
  document.getElementById('create-name').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') createSession();
  });
  document.getElementById('join-name').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') joinSession();
  });

  // Composer
  initComposerTabs();

  document.getElementById('msg-input').addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  document.getElementById('msg-input').addEventListener('input', function() {
    autoResize(this);
  });

  // Scroll detection for auto-scroll
  initScrollDetection();

  // Periodically refresh participant list
  setInterval(function() {
    if (state.session) refreshStatus();
  }, 10000);
}

document.addEventListener('DOMContentLoaded', init);
