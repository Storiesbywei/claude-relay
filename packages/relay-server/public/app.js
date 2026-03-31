/* Protocol Chronicle — app.js
   Real API integration for the Claude Relay dashboard */

// --------------- State ---------------

const state = {
  session: null,   // { id, token, invite, name, role, expires_at, mode, participantName }
  messages: [],
  cursor: 0,
  pollTimer: null,
  healthTimer: null,
  activeType: 'Question',
  folioCount: 0,
  userScrolled: false,
  selectedMode: 'relay', // Mode selected on setup screen before session creation
  disappearingTTL: 0,   // Disappearing messages TTL in seconds (0 = off)
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

// --------------- DOM Cache ---------------
// Cache frequently accessed elements to avoid repeated getElementById calls
var dom = {};

function cacheDom() {
  dom.chronicle = document.getElementById('chronicle');
  dom.msgInput = document.getElementById('msg-input');
  dom.connectionPill = document.getElementById('connection-pill');
  dom.connectionLabel = document.getElementById('connection-label');
  dom.folioCounter = document.getElementById('folio-counter');
  dom.infoCount = document.getElementById('info-count');
  dom.infoId = document.getElementById('info-id');
  dom.infoExpires = document.getElementById('info-expires');
  dom.infoUptime = document.getElementById('info-uptime');
  dom.sessionName = document.getElementById('session-name');
  dom.inviteBar = document.getElementById('invite-bar');
  dom.inviteToken = document.getElementById('invite-token');
  dom.participantList = document.getElementById('participant-list');
  dom.setup = document.getElementById('setup');
  dom.main = document.getElementById('main');
  dom.httpDot = document.getElementById('http-dot');
  dom.httpStat = document.getElementById('http-stat');
  dom.dotHttp = document.getElementById('dot-http');
  dom.nostrDot = document.getElementById('nostr-dot');
  dom.nostrStat = document.getElementById('nostr-stat');
  dom.dotNostr = document.getElementById('dot-nostr');
  dom.solidDot = document.getElementById('solid-dot');
  dom.solidStat = document.getElementById('solid-stat');
  dom.dotSolid = document.getElementById('dot-solid');
  dom.idNpub = document.getElementById('id-npub');
  dom.srLive = document.getElementById('sr-live');
  dom.ariaAnnouncer = document.getElementById('aria-announcer');
  dom.encryptionPill = document.getElementById('encryption-pill');
  dom.encryptionLabel = document.getElementById('encryption-label');
  dom.keyFingerprint = document.getElementById('key-fingerprint');
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
  const mode = state.selectedMode || 'relay';
  const errEl = document.getElementById('create-error');
  errEl.style.display = 'none';

  // Signal mode requires encryption — check if WebCrypto is available
  if (mode === 'signal' && (!window.crypto || !window.crypto.subtle)) {
    errEl.textContent = 'Signal mode requires WebCrypto (HTTPS or localhost)';
    errEl.style.display = 'block';
    return;
  }

  try {
    const data = await api('POST', '/sessions', { name: name, ttl_minutes: ttl, mode: mode });

    // Generate E2E encryption secret and derive session key
    var secretB64 = await relayCrypto.initForCreator(data.session_id);

    // Signal mode: verify encryption initialized successfully
    if (mode === 'signal' && !relayCrypto.enabled) {
      errEl.textContent = 'Signal mode requires encryption — key generation failed';
      errEl.style.display = 'block';
      return;
    }

    startSession({
      id: data.session_id,
      token: data.creator_token,
      invite: data.invite_token,
      name: name,
      role: 'creator',
      expires_at: data.expires_at,
      mode: data.mode || mode,
      participantName: 'creator',
      _cryptoSecret: secretB64, // Passed to startSession for URL fragment
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
      mode: data.session.mode || 'relay',
      participantName: name,
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

  // Persist session (WITHOUT the crypto secret — that stays in memory only)
  var sessToStore = {
    id: sess.id, token: sess.token, invite: sess.invite,
    name: sess.name, role: sess.role, expires_at: sess.expires_at,
    mode: sess.mode || 'relay', participantName: sess.participantName,
  };
  localStorage.setItem('relay_session', JSON.stringify(sessToStore));

  // Apply signal mode to the document
  var isSignal = sess.mode === 'signal';
  if (isSignal) {
    document.documentElement.setAttribute('data-mode', 'signal');
  } else {
    document.documentElement.removeAttribute('data-mode');
  }

  // Inject URL params for sharing — secrets go in fragment (never sent to server).
  // Only non-secret identifiers (sid, name) stay in query params.
  // Token and encryption key are in the URL fragment to avoid leaking to
  // server logs, browser history referrer headers, or proxy logs.
  const url = new URL(location.href);
  url.searchParams.set('sid', sess.id);
  url.searchParams.set('name', sess.name);
  // Remove token from query params if present (migration from old URLs)
  url.searchParams.delete('token');
  if (sess.mode === 'signal') {
    url.searchParams.set('mode', 'signal');
  }
  // Build fragment: token is always present, key is added for encrypted sessions
  var fragmentParts = ['token=' + encodeURIComponent(sess.token)];
  if (sess._cryptoSecret) {
    fragmentParts.push('key=' + sess._cryptoSecret);
  } else if (relayCrypto.enabled && location.hash) {
    // Preserve existing key= from fragment if crypto already initialized
    var existingHash = location.hash.slice(1).split('&');
    for (var ei = 0; ei < existingHash.length; ei++) {
      var ep = existingHash[ei].split('=');
      if (ep[0] === 'key' && ep[1]) {
        fragmentParts.push('key=' + ep[1]);
        break;
      }
    }
  }
  url.hash = fragmentParts.join('&');
  history.replaceState(null, '', url.toString());

  // Update encryption UI indicator
  updateEncryptionUI();

  // Signal mode: show banner, update brand subtitle
  var signalBanner = document.getElementById('signal-banner');
  if (isSignal) {
    if (signalBanner) {
      signalBanner.style.display = 'flex';
      var sfp = document.getElementById('signal-fingerprint');
      if (sfp && relayCrypto.enabled) {
        sfp.textContent = relayCrypto.getFingerprint() || '';
      }

      // Disappearing messages indicator
      var disappearingIndicator = document.getElementById('signal-disappearing-indicator');
      var disappearingDuration = document.getElementById('signal-disappearing-duration');
      if (disappearingIndicator && state.disappearingTTL > 0) {
        disappearingIndicator.style.display = 'inline-flex';
        if (disappearingDuration) {
          disappearingDuration.textContent = formatDisappearingTTL(state.disappearingTTL);
        }
      } else if (disappearingIndicator) {
        disappearingIndicator.style.display = 'none';
      }
    }
  } else {
    if (signalBanner) signalBanner.style.display = 'none';
  }

  // Update settings security section
  updateSettingsSecurity();

  // Switch screens
  dom.setup.style.display = 'none';
  dom.main.style.display = 'flex';

  // Populate UI
  dom.sessionName.textContent = isSignal ? (sess.name + ' (Signal)') : sess.name;
  dom.infoId.textContent = sess.id.slice(0, 8) + '...';
  dom.infoId.title = sess.id;
  dom.infoExpires.textContent = new Date(sess.expires_at).toLocaleTimeString();

  // Clear chronicle
  var chronicle = dom.chronicle;
  chronicle.innerHTML = '<div class="chronicle-empty" id="empty-state"><div class="empty-diamond"></div><div class="empty-title">The chronicle awaits</div><div class="empty-sub">Send the first message to begin</div></div>';

  // Show invite bar for creator
  if (sess.invite) {
    dom.inviteBar.style.display = 'flex';
    dom.inviteToken.textContent = sess.invite;
  } else {
    dom.inviteBar.style.display = 'none';
  }

  // Update connection pill
  updateConnectionPill(true);

  // Update folio counter
  updateFolioCounter();

  // Start polling (setTimeout-based — schedules next after completion, no stacking)
  if (state.pollTimer) clearTimeout(state.pollTimer);
  poll(); // first poll fires immediately; schedulePoll() called in finally{}

  // Start health check
  if (state.healthTimer) clearInterval(state.healthTimer);
  getHealth();
  state.healthTimer = setInterval(getHealth, 10000);

  // Refresh session info
  refreshStatus();

  // Focus management: move focus to composer for immediate typing
  var composerInput = dom.msgInput;
  if (composerInput) {
    setTimeout(function() { composerInput.focus(); }, 100);
  }

  // Capability Lattice: show trust UI for signal mode creators
  showTrustUI();
  initTrustModal();

  // Announce session start to screen readers
  announceToSR('Session started: ' + sess.name + '. You can now send messages.');
}

function endSession() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  if (state.healthTimer) clearInterval(state.healthTimer);
  state.session = null;
  state.messages = [];
  state.cursor = 0;
  state.folioCount = 0;
  _seenMessageIds.clear();
  localStorage.removeItem('relay_session');

  // Clear encryption state (key lives in memory only)
  relayCrypto.clear();
  updateEncryptionUI();

  // Clear signal mode
  document.documentElement.removeAttribute('data-mode');
  var signalBanner = document.getElementById('signal-banner');
  if (signalBanner) signalBanner.style.display = 'none';

  // Clear trust state
  trustState.grants = [];
  trustState.keyVersion = 1;
  state.disappearingTTL = 0;
  hideTrustUI();

  // Reset security settings panel
  updateSettingsSecurity();
  closeKeyVerification();

  // Clear URL params AND fragment (which contains the encryption key)
  history.replaceState(null, '', location.pathname);

  dom.main.style.display = 'none';
  dom.setup.style.display = 'flex';
  updateConnectionPill(false);

  // Return focus to the create session button
  var createBtn = document.getElementById('btn-create');
  if (createBtn) {
    setTimeout(function() { createBtn.focus(); }, 100);
  }

  announceToSR('Session ended. Returned to setup screen.');
}

// --------------- Connection Status ---------------

var _lastConnectionState = null;

function updateConnectionPill(connected) {
  const pill = dom.connectionPill;
  const label = dom.connectionLabel;
  if (connected) {
    pill.className = 'connection-pill';
    label.textContent = 'Connected';
  } else {
    pill.className = 'connection-pill disconnected';
    label.textContent = 'Disconnected';
  }

  // Announce connection state changes to screen readers
  if (_lastConnectionState !== null && _lastConnectionState !== connected) {
    announceToSR(connected ? 'Connection restored' : 'Connection lost');
  }
  _lastConnectionState = connected;
}

// --------------- Folio Counter ---------------

function updateFolioCounter() {
  const el = dom.folioCounter;
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
    dom.httpDot.className = 'protocol-dot live';
    dom.httpDot.setAttribute('aria-label', 'HTTP: active');
    dom.httpStat.textContent = 'v' + (data.version || '?') + ' — ' + (data.sessions || 0) + ' sessions';
    dom.dotHttp.className = 'bridge-dot active';
    dom.dotHttp.setAttribute('aria-label', 'HTTP: active');

    // Nostr status
    if (data.nostr) {
      var nostrConnections = data.nostr.connections || 0;
      var nostrEvents = data.nostr.events_received || 0;
      if (nostrConnections > 0) {
        dom.nostrDot.className = 'protocol-dot live';
        dom.nostrDot.setAttribute('aria-label', 'Nostr: active');
        dom.dotNostr.className = 'bridge-dot active';
        dom.dotNostr.setAttribute('aria-label', 'Nostr: active');
        dom.nostrStat.textContent = nostrConnections + ' ws, ' + nostrEvents + ' events';
      } else {
        dom.nostrDot.className = 'protocol-dot off';
        dom.nostrDot.setAttribute('aria-label', 'Nostr: inactive');
        dom.dotNostr.className = 'bridge-dot inactive';
        dom.dotNostr.setAttribute('aria-label', 'Nostr: inactive');
        dom.nostrStat.textContent = nostrEvents + ' events';
      }

      // Update npub
      if (data.nostr.server_pubkey) {
        dom.idNpub.textContent = data.nostr.server_pubkey;
        dom.idNpub.title = data.nostr.server_pubkey;
      }
    }

    // Solid status
    if (data.solid) {
      if (data.solid.sync_engine === 'running') {
        dom.solidDot.className = 'protocol-dot live';
        dom.solidDot.setAttribute('aria-label', 'Solid: active');
        dom.dotSolid.className = 'bridge-dot active';
        dom.dotSolid.setAttribute('aria-label', 'Solid: active');
        dom.solidStat.textContent = 'Sync running, q:' + (data.solid.queue_depth || 0);
      } else {
        dom.solidDot.className = 'protocol-dot off';
        dom.solidDot.setAttribute('aria-label', 'Solid: inactive');
        dom.dotSolid.className = 'bridge-dot inactive';
        dom.dotSolid.setAttribute('aria-label', 'Solid: inactive');
        dom.solidStat.textContent = 'Stopped';
      }
    }

    // Uptime
    if (data.uptime_seconds) {
      dom.infoUptime.textContent = formatUptime(data.uptime_seconds);
    }

    updateConnectionPill(true);
  } catch (e) {
    updateConnectionPill(false);
    dom.httpDot.className = 'protocol-dot off';
    dom.httpDot.setAttribute('aria-label', 'HTTP: inactive');
    dom.dotHttp.className = 'bridge-dot inactive';
    dom.dotHttp.setAttribute('aria-label', 'HTTP: inactive');
  }
}

// --------------- Polling ---------------

// Use a Set for O(1) duplicate detection instead of Array.find
var _seenMessageIds = new Set();

async function poll() {
  if (!state.session) return;
  try {
    const data = await api('GET', '/relay/' + state.session.id + '?since=' + state.cursor + '&limit=50');
    if (data.messages && data.messages.length) {
      state.cursor = data.cursor;
      var newMessages = [];
      for (var i = 0; i < data.messages.length; i++) {
        var msg = data.messages[i];
        if (!_seenMessageIds.has(msg.message_id)) {
          _seenMessageIds.add(msg.message_id);
          state.messages.push(msg);
          newMessages.push(msg);
        }
      }
      if (newMessages.length > 0) {
        // Remove empty state if present
        var emptyState = document.getElementById('empty-state');
        if (emptyState) emptyState.remove();

        // Decrypt messages if E2E encryption is active, then render
        for (var j = 0; j < newMessages.length; j++) {
          await renderMessageWithDecrypt(newMessages[j]);
          announceMessage(newMessages[j]);
        }
        updateCount();
        autoScroll();
      }
    }
    updateConnectionPill(true);
  } catch (e) {
    updateConnectionPill(false);
  } finally {
    // Schedule next poll AFTER current completes — prevents stacking
    schedulePoll();
  }
}

function schedulePoll() {
  if (!state.session) return;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, settings.pollInterval || 2000);
}

async function refreshStatus() {
  if (!state.session) return;
  try {
    const data = await api('GET', '/sessions/' + state.session.id);

    // Sync mode from server (in case joiner didn't have it)
    if (data.mode && data.mode !== state.session.mode) {
      state.session.mode = data.mode;
      if (data.mode === 'signal') {
        document.documentElement.setAttribute('data-mode', 'signal');
        var signalBanner = document.getElementById('signal-banner');
        if (signalBanner) signalBanner.style.display = 'flex';
      }
    }

    var list = dom.participantList;
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

// --------------- Encryption UI ---------------

function updateEncryptionUI() {
  if (!dom.encryptionPill) return;
  if (relayCrypto.enabled) {
    dom.encryptionPill.style.display = 'flex';
    dom.encryptionLabel.textContent = 'E2E';
    var fp = relayCrypto.getFingerprint();
    if (fp) {
      dom.keyFingerprint.textContent = fp;
      dom.encryptionPill.title = 'E2E encrypted — key fingerprint: ' + fp;
    }
  } else {
    dom.encryptionPill.style.display = 'none';
  }
  // Also sync settings security section
  updateSettingsSecurity();
}

// --------------- Message Rendering (with decryption) ---------------

async function renderMessageWithDecrypt(msg) {
  // Detect key_rotation system events and render as boundary markers
  if (msg.type === 'status_update' && msg.sender_name === 'system') {
    try {
      var rotEvent = JSON.parse(msg.content);
      if (rotEvent && rotEvent.type === 'key_rotation') {
        var agentId = rotEvent.trigger_agent_id || 'unknown';
        var reason = rotEvent.reason || 'manual';
        var version = rotEvent.version || '?';
        insertKeyRotationBoundary(agentId, reason === 'agent_invite' ? 'invite' : 'revoke', version);
        // Also refresh the trust grants list
        fetchTrustGrants();
        return; // Don't render as a normal message
      }
    } catch (e) {
      // Not a key rotation event — render normally
    }
  }

  // Attempt decryption if the message is flagged as encrypted
  if (msg.encrypted && relayCrypto.enabled) {
    var result = await relayCrypto.unseal(msg.content, true);
    // Create a shallow copy with decrypted content for rendering
    var decryptedMsg = {};
    for (var k in msg) {
      if (msg.hasOwnProperty(k)) decryptedMsg[k] = msg[k];
    }
    decryptedMsg.content = result.text;
    decryptedMsg._wasEncrypted = true;
    decryptedMsg._decryptError = result.error;
    renderMessage(decryptedMsg);
  } else if (msg.encrypted && !relayCrypto.enabled) {
    // No key available — show ciphertext indicator
    var lockedMsg = {};
    for (var k2 in msg) {
      if (msg.hasOwnProperty(k2)) lockedMsg[k2] = msg[k2];
    }
    lockedMsg.content = '[Encrypted message — no decryption key available]';
    lockedMsg._wasEncrypted = true;
    lockedMsg._decryptError = 'No key';
    renderMessage(lockedMsg);
  } else {
    renderMessage(msg);
  }
}

// --------------- Message Rendering ---------------

function renderMessage(msg) {
  var typeInfo = API_TYPE_MAP[msg.type] || API_TYPE_MAP['context'];
  var senderName = msg.sender_name || 'unknown';
  var isAgent = senderName.startsWith('agent:');
  var displayName = isAgent ? senderName.slice(6) : senderName;
  var color = getAvatarColor(senderName);
  var initial = isAgent ? '\u2699' : senderName[0].toUpperCase();
  var time = formatTime(msg.sent_at);

  state.folioCount++;
  updateFolioCounter();

  // Build folio entry
  var entry = document.createElement('div');
  entry.className = 'folio-entry new ' + typeInfo.ec;

  // Signal mode: detect self-messages for chat bubble alignment
  if (state.session && state.session.mode === 'signal') {
    var currentName = state.session.participantName || state.session.role || '';
    if (senderName === currentName || (state.session.role === 'creator' && senderName === 'creator')) {
      entry.className += ' self-message';
    }
  }

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
  var originDisplay = settings.showOriginTags ? '' : 'display:none';

  // Encryption badge for E2E encrypted messages
  var encBadge = '';
  if (msg._wasEncrypted) {
    if (msg._decryptError) {
      encBadge = '<span class="ec-encrypted-badge ec-decrypt-error"><span class="lock-sm">&#x1F513;</span>decrypt failed</span>';
    } else {
      encBadge = '<span class="ec-encrypted-badge"><span class="lock-sm">&#x1F512;</span>e2e</span>';
    }
  }

  // Signal Mode specific indicators
  var signalIndicators = '';
  if (state.session && state.session.mode === 'signal') {
    // Lock icon on every signal message
    if (msg._wasEncrypted && !msg._decryptError) {
      signalIndicators += '<span class="signal-msg-lock" title="End-to-end encrypted">&#x1F512;</span>';
    }

    // Disappearing timer indicator
    if (state.disappearingTTL > 0) {
      signalIndicators += '<span class="signal-msg-timer" title="Disappearing message">&#x23F1; ' + formatDisappearingTTL(state.disappearingTTL) + '</span>';
    }

    // Sealed sender verified badge
    if (msg._sealedSender || msg.sealed_sender) {
      signalIndicators += '<span class="signal-verified-badge" title="Sender verified via sealed sender">&#x2713; verified</span>';
    }
  }

  entry.innerHTML =
    '<div class="entry-time-col">' +
      '<span class="entry-time">' + time.hhmm + '</span>' +
      '<span class="entry-time-sec">' + time.ss + '</span>' +
      '<span class="spine-dot"></span>' +
    '</div>' +
    '<div class="entry-card">' +
      '<div class="ec-header">' +
        '<div class="ec-avatar' + (isAgent ? ' ec-avatar-agent' : '') + '" style="background:' + color + '">' + initial + '</div>' +
        '<span class="ec-author">' + escapeHtml(displayName) + '</span>' +
        (isAgent ? '<span class="ec-agent-badge">agent</span>' : '') +
        signalIndicators +
        '<span class="ec-pill ' + typeInfo.pill + '">' + typeInfo.label + '</span>' +
        '<span class="ec-relative">' + relativeTime(msg.sent_at) + '</span>' +
      '</div>' +
      titleHtml +
      pullQuote +
      '<div class="ec-body">' + renderedContent + '</div>' +
      '<div class="ec-footer">' +
        '<span class="origin-tag" style="' + originDisplay + '">' + escapeHtml(origin) + '</span>' +
        encBadge +
        '<span class="event-hash">#' + hash + '</span>' +
      '</div>' +
    '</div>';

  dom.chronicle.appendChild(entry);

  // Remove the "new" animation class after it plays
  setTimeout(function() { entry.classList.remove('new'); }, 400);

  // Announce to screen reader
  announceToSR('New ' + typeInfo.label + ' message from ' + senderName);
}

function updateCount() {
  var n = state.messages.length;
  dom.infoCount.textContent = n;
}

function autoScroll() {
  if (state.userScrolled) return;
  var el = dom.chronicle;
  el.scrollTop = el.scrollHeight;
}

// --------------- Send ---------------

async function sendMessage() {
  if (!state.session) return;
  var isSignal = state.session.mode === 'signal';

  var input = dom.msgInput;
  var content = input.value.trim();
  if (!content) return;

  // Signal mode: require encryption
  if (isSignal && !relayCrypto.enabled) {
    var errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#ff6b6b;font-family:var(--mono);font-size:11px;padding:4px 0;';
    errDiv.textContent = 'Cannot send: encryption key required in Signal mode';
    input.parentNode.appendChild(errDiv);
    setTimeout(function() { errDiv.remove(); }, 4000);
    return;
  }

  // In signal mode, always use 'context' type (generic message); in relay mode, use selected tab
  var apiType;
  if (isSignal) {
    apiType = 'context';
  } else {
    var typeKey = state.activeType;
    var typeInfo = TYPES[typeKey];
    if (!typeInfo) return;
    apiType = typeInfo.api;
  }

  try {
    // Scan-then-Seal: encrypt if E2E encryption is active
    var sealed = await relayCrypto.seal(content);

    // Check client-side scan results (runs BEFORE encryption) — skip in signal mode
    if (!isSignal && sealed.scanResult && sealed.scanResult.hasSensitive) {
      var errDiv = document.createElement('div');
      errDiv.style.cssText = 'color:#ff6b6b;font-family:var(--mono);font-size:11px;padding:4px 0;';
      errDiv.textContent = 'Blocked: ' + sealed.scanResult.warnings.join('; ');
      input.parentNode.appendChild(errDiv);
      setTimeout(function() { errDiv.remove(); }, 5000);
      return;
    }

    var payload = {
      type: apiType,
      title: '',
      content: sealed.content,
    };
    if (sealed.encrypted) {
      payload.encrypted = true;
    }

    await api('POST', '/relay/' + state.session.id, payload);
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
  var tabsArray = Array.prototype.slice.call(tabs);

  function activateTab(tab) {
    tabs.forEach(function(t) {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
      t.setAttribute('tabindex', '-1');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');
    tab.focus();
    state.activeType = tab.getAttribute('data-type');
  }

  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      activateTab(tab);
    });
  });

  // Keyboard navigation: Arrow keys, Home, End
  var tablist = document.getElementById('composer-tabs');
  if (tablist) {
    tablist.addEventListener('keydown', function(e) {
      var currentIdx = tabsArray.indexOf(document.activeElement);
      if (currentIdx < 0) return;

      var newIdx = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        newIdx = (currentIdx + 1) % tabsArray.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        newIdx = (currentIdx - 1 + tabsArray.length) % tabsArray.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        newIdx = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        newIdx = tabsArray.length - 1;
      }

      if (newIdx >= 0) {
        activateTab(tabsArray[newIdx]);
      }
    });
  }
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
  var particleCount = 28; // Reduced from 35 — ambient, not arcade
  var connectionDist = 180;
  var connectionDistSq = connectionDist * connectionDist; // Avoid sqrt in hot loop

  // Cache theme colors — update on theme change instead of every frame
  var meshColor = '139,92,246';
  var meshAlpha = 0.04;
  var dotAlpha = 0.1;

  function updateMeshColors() {
    var style = getComputedStyle(document.documentElement);
    meshColor = style.getPropertyValue('--mesh-color').trim() || '139,92,246';
    meshAlpha = parseFloat(style.getPropertyValue('--mesh-alpha')) || 0.04;
    dotAlpha = parseFloat(style.getPropertyValue('--mesh-dot-alpha')) || 0.1;
  }
  updateMeshColors();
  // Re-read colors when theme changes (MutationObserver on data-theme attribute)
  var _meshObserver = new MutationObserver(updateMeshColors);
  _meshObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-high-contrast'] });

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
    // Skip rendering when tab is hidden — saves CPU/battery
    if (document.hidden) {
      requestAnimationFrame(draw);
      return;
    }

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
    // Use squared distance to avoid sqrt per pair
    for (var i = 0; i < particles.length; i++) {
      for (var j = i + 1; j < particles.length; j++) {
        var dx = particles[i].x - particles[j].x;
        var dy = particles[i].y - particles[j].y;
        var distSq = dx * dx + dy * dy;
        if (distSq < connectionDistSq) {
          var dist = Math.sqrt(distSq);
          var alpha = (1 - dist / connectionDist) * meshAlpha;
          ctx.strokeStyle = 'rgba(' + meshColor + ',' + alpha + ')';
          ctx.lineWidth = 0.3;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }

    // Dots — quiet presence, color follows theme
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + meshColor + ',' + dotAlpha + ')';
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }

  draw();
}

// --------------- Scroll Detection ---------------

function initScrollDetection() {
  var chronicle = dom.chronicle;
  var _scrollTicking = false;
  chronicle.addEventListener('scroll', function() {
    if (!_scrollTicking) {
      _scrollTicking = true;
      requestAnimationFrame(function() {
        var atBottom = chronicle.scrollHeight - chronicle.scrollTop - chronicle.clientHeight < 80;
        state.userScrolled = !atBottom;
        _scrollTicking = false;
      });
    }
  }, { passive: true });
}

// --------------- Init ---------------

function init() {
  // Cache DOM elements for performance (avoid repeated getElementById)
  cacheDom();

  // Start mesh canvas
  initMeshCanvas();

  // URL param injection: ?sid=...&name=... + #token=...&key=... (secrets in fragment)
  // The URL fragment is NEVER sent to the server by browsers, preventing token
  // leakage to server logs, browser history referrer headers, and proxy logs.
  var params = new URLSearchParams(location.search);
  // Parse fragment parameters (token + encryption key)
  var fragmentToken = null;
  var cryptoSecret = null;
  if (location.hash) {
    var hashParams = location.hash.slice(1).split('&');
    for (var hi = 0; hi < hashParams.length; hi++) {
      var pair = hashParams[hi].split('=');
      if (pair[0] === 'token' && pair[1]) {
        fragmentToken = decodeURIComponent(pair[1]);
      }
      if (pair[0] === 'key' && pair[1]) {
        cryptoSecret = pair[1];
      }
    }
  }
  // Support legacy URLs that had token in query params (migration)
  var urlToken = fragmentToken || params.get('token');

  if (params.get('sid') && urlToken) {
    // Initialize encryption if key is present
    var sessionId = params.get('sid');
    var urlMode = params.get('mode') || 'relay';
    if (cryptoSecret) {
      relayCrypto.initForJoiner(cryptoSecret, sessionId).then(function() {
        startSession({
          id: sessionId,
          token: urlToken,
          invite: null,
          name: params.get('name') || 'Session',
          role: 'participant',
          expires_at: null,
          mode: urlMode,
          participantName: 'participant',
        });
      }).catch(function(e) {
        console.error('Encryption init failed:', e);
        // Signal mode: cannot start without encryption
        if (urlMode === 'signal') {
          console.error('Signal mode requires encryption — cannot start session');
          return;
        }
        // Start session without encryption as fallback
        startSession({
          id: sessionId,
          token: urlToken,
          invite: null,
          name: params.get('name') || 'Session',
          role: 'participant',
          expires_at: null,
          mode: urlMode,
          participantName: 'participant',
        });
      });
    } else {
      // Signal mode without encryption key in URL: cannot proceed
      if (urlMode === 'signal') {
        console.error('Signal mode requires encryption key in URL fragment');
      } else {
        startSession({
          id: sessionId,
          token: urlToken,
          invite: null,
          name: params.get('name') || 'Session',
          role: 'participant',
          expires_at: null,
          mode: urlMode,
          participantName: 'participant',
        });
      }
    }
  } else {
    // Restore saved session from localStorage
    var saved = localStorage.getItem('relay_session');
    if (saved) {
      try {
        var sess = JSON.parse(saved);
        if (sess.id && sess.token) {
          // Check if URL fragment has an encryption key for this restored session
          var restoreSecret = null;
          if (location.hash) {
            var rhParams = location.hash.slice(1).split('&');
            for (var ri = 0; ri < rhParams.length; ri++) {
              var rp = rhParams[ri].split('=');
              if (rp[0] === 'key' && rp[1]) {
                restoreSecret = rp[1];
              }
            }
          }

          if (restoreSecret) {
            relayCrypto.initForJoiner(restoreSecret, sess.id).then(function() {
              startSession(sess);
            }).catch(function() {
              startSession(sess);
            });
          } else {
            startSession(sess);
          }
        }
      } catch (e) {
        localStorage.removeItem('relay_session');
      }
    }
  }

  // Run initial health check even before session
  getHealth();

  // Mode selector buttons
  var modeBtns = document.querySelectorAll('.mode-btn');
  var signalExplainer = document.getElementById('signal-explainer');
  var disappearingSelector = document.getElementById('disappearing-selector');

  function updateModeUI(mode) {
    modeBtns.forEach(function(b) { b.classList.remove('active'); });
    var activeBtn = document.querySelector('.mode-btn[data-mode="' + mode + '"]');
    if (activeBtn) activeBtn.classList.add('active');
    state.selectedMode = mode;

    if (mode === 'signal') {
      if (signalExplainer) signalExplainer.style.display = 'flex';
      if (disappearingSelector) disappearingSelector.style.display = '';
    } else {
      if (signalExplainer) signalExplainer.style.display = 'none';
      if (disappearingSelector) disappearingSelector.style.display = 'none';
    }
  }

  modeBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      updateModeUI(btn.getAttribute('data-mode') || 'relay');
    });
  });

  // Disappearing messages timer buttons
  var timerBtns = document.querySelectorAll('.timer-btn');
  timerBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      timerBtns.forEach(function(b) {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      state.disappearingTTL = parseInt(btn.getAttribute('data-ttl'), 10) || 0;
    });
  });

  // Bind session events
  document.getElementById('btn-create').addEventListener('click', createSession);
  document.getElementById('btn-join').addEventListener('click', joinSession);
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('btn-end').addEventListener('click', endSession);
  document.getElementById('btn-export-json').addEventListener('click', function() { exportSession('json'); });
  document.getElementById('btn-export-md').addEventListener('click', function() { exportSession('md'); });

  document.getElementById('btn-copy').addEventListener('click', function() {
    var tokenText = dom.inviteToken.textContent;
    navigator.clipboard.writeText(tokenText);
    var btn = document.getElementById('btn-copy');
    btn.textContent = 'Copied';
    btn.setAttribute('aria-label', 'Invite token copied');
    announceToSR('Invite token copied to clipboard');
    setTimeout(function() {
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy invite token');
    }, 1500);
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

  dom.msgInput.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  dom.msgInput.addEventListener('input', function() {
    autoResize(this);
  });

  // Scroll detection for auto-scroll
  initScrollDetection();

  // iOS keyboard handling — keep composer visible
  initKeyboardHandler();

  // Settings panel (replaces old theme switcher)
  initSettings();

  // Security UI (verify keys, signal fingerprint button)
  initSecurityUI();

  // Periodically refresh participant list
  setInterval(function() {
    if (state.session) refreshStatus();
  }, 10000);
}

// --------------- iOS Keyboard Handler ---------------
// On iOS/iPadOS, the virtual keyboard doesn't resize the viewport in some browsers.
// Use visualViewport API to shrink the app shell when the keyboard is open.

function initKeyboardHandler() {
  if (!window.visualViewport) return;

  function onViewportResize() {
    var shell = document.querySelector('.app-shell');
    if (!shell) return;
    // visualViewport.height is the visible area minus the keyboard
    var keyboardHeight = window.innerHeight - window.visualViewport.height;
    if (keyboardHeight > 100) {
      // Keyboard is open — shrink the app
      shell.style.height = window.visualViewport.height + 'px';
      // Scroll composer into view
      var composer = document.querySelector('.composer');
      if (composer) composer.scrollIntoView({ block: 'end' });
    } else {
      // Keyboard closed — restore
      shell.style.height = '';
    }
  }

  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
}

// --------------- Settings Management ---------------

var SETTINGS_DEFAULTS = {
  theme: 'auto',
  font: 'default',
  fontSize: 'default',
  meshEnabled: true,
  reducedMotion: false,
  highContrast: false,
  screenReaderAnnounce: true,
  simpleLanguage: false,
  pollInterval: 2000,
  showOriginTags: true,
  advancedMode: false,
};

var FONT_SIZE_STEPS = ['small', 'default', 'large', 'xlarge'];
var FONT_SIZE_LABELS = { small: 'Small', 'default': 'Default', large: 'Large', xlarge: 'Extra Large' };

var settings = {};

function loadSettings() {
  var saved = {};
  try {
    var raw = localStorage.getItem('relay_settings');
    if (raw) saved = JSON.parse(raw);
  } catch (e) { /* ignore */ }

  // Merge with defaults
  settings = {};
  for (var key in SETTINGS_DEFAULTS) {
    settings[key] = saved.hasOwnProperty(key) ? saved[key] : SETTINGS_DEFAULTS[key];
  }

  // Migrate old relay_theme if present
  var oldTheme = localStorage.getItem('relay_theme');
  if (oldTheme && !saved.hasOwnProperty('theme')) {
    settings.theme = oldTheme;
    localStorage.removeItem('relay_theme');
  }

  applyAllSettings();
  syncSettingsUI();
}

function saveSetting(key, value) {
  settings[key] = value;
  localStorage.setItem('relay_settings', JSON.stringify(settings));
  applySetting(key, value);
}

function applyAllSettings() {
  for (var key in settings) {
    applySetting(key, settings[key]);
  }
}

function applySetting(key, value) {
  var root = document.documentElement;

  switch (key) {
    case 'theme':
      if (value === 'auto') {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', value);
      }
      // Update color-scheme meta for browser chrome
      var colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
      if (colorSchemeMeta) {
        colorSchemeMeta.setAttribute('content', value === 'light' ? 'light' : 'dark');
      }
      break;

    case 'font':
      if (value === 'default') {
        root.removeAttribute('data-font');
      } else {
        root.setAttribute('data-font', value);
      }
      break;

    case 'fontSize':
      if (value === 'default') {
        root.removeAttribute('data-font-size');
      } else {
        root.setAttribute('data-font-size', value);
      }
      break;

    case 'meshEnabled':
      var canvas = document.getElementById('mesh-canvas');
      if (canvas) canvas.style.display = value ? '' : 'none';
      break;

    case 'reducedMotion':
      if (value) {
        root.setAttribute('data-reduced-motion', '');
      } else {
        root.removeAttribute('data-reduced-motion');
      }
      break;

    case 'highContrast':
      if (value) {
        root.setAttribute('data-high-contrast', '');
      } else {
        root.removeAttribute('data-high-contrast');
      }
      break;

    case 'screenReaderAnnounce':
      // Handled at announcement time — no DOM change needed
      break;

    case 'simpleLanguage':
      // Applied contextually when rendering text — no DOM change needed
      break;

    case 'pollInterval':
      // Restart poll timer if session is active (setTimeout-based)
      if (state.session && state.pollTimer) {
        clearTimeout(state.pollTimer);
        schedulePoll();
      }
      break;

    case 'showOriginTags':
      var tags = document.querySelectorAll('.origin-tag');
      for (var i = 0; i < tags.length; i++) {
        tags[i].style.display = value ? '' : 'none';
      }
      break;

    case 'advancedMode':
      var panel = document.getElementById('settings-panel');
      if (panel) {
        if (value) {
          panel.classList.add('advanced');
        } else {
          panel.classList.remove('advanced');
        }
      }
      break;
  }
}

function syncSettingsUI() {
  // Theme dropdown
  var themeEl = document.getElementById('setting-theme');
  if (themeEl) themeEl.value = settings.theme;

  // Font dropdown
  var fontEl = document.getElementById('setting-font');
  if (fontEl) fontEl.value = settings.font;

  // Font size slider
  var fontSizeEl = document.getElementById('setting-font-size');
  var fontSizeLabel = document.getElementById('font-size-label');
  if (fontSizeEl) {
    var idx = FONT_SIZE_STEPS.indexOf(settings.fontSize);
    fontSizeEl.value = idx >= 0 ? idx : 1;
  }
  var fontSizeLabelText = FONT_SIZE_LABELS[settings.fontSize] || 'Default';
  if (fontSizeLabel) fontSizeLabel.textContent = fontSizeLabelText;
  if (fontSizeEl) fontSizeEl.setAttribute('aria-valuetext', fontSizeLabelText);

  // Mesh toggle
  var meshEl = document.getElementById('setting-mesh');
  if (meshEl) meshEl.checked = settings.meshEnabled;

  // Reduced motion
  var rmEl = document.getElementById('setting-reduced-motion');
  if (rmEl) rmEl.checked = settings.reducedMotion;

  // High contrast
  var hcEl = document.getElementById('setting-high-contrast');
  if (hcEl) hcEl.checked = settings.highContrast;

  // Screen reader
  var srEl = document.getElementById('setting-sr-announce');
  if (srEl) srEl.checked = settings.screenReaderAnnounce;

  // Simple language
  var slEl = document.getElementById('setting-simple-lang');
  if (slEl) slEl.checked = settings.simpleLanguage;

  // Poll interval
  var piEl = document.getElementById('setting-poll-interval');
  if (piEl) piEl.value = String(settings.pollInterval);

  // Origin tags
  var otEl = document.getElementById('setting-origin-tags');
  if (otEl) otEl.checked = settings.showOriginTags;

  // Advanced mode — sync checkbox + segmented control
  var advEl = document.getElementById('toggle-advanced');
  if (advEl) advEl.checked = settings.advancedMode;
  var panel = document.getElementById('settings-panel');
  if (panel) {
    if (settings.advancedMode) {
      panel.classList.add('advanced');
    } else {
      panel.classList.remove('advanced');
    }
  }
  var segSimple = document.getElementById('seg-simple');
  var segAdvanced = document.getElementById('seg-advanced');
  if (segSimple && segAdvanced) {
    segSimple.classList.toggle('active', !settings.advancedMode);
    segSimple.setAttribute('aria-checked', String(!settings.advancedMode));
    segAdvanced.classList.toggle('active', settings.advancedMode);
    segAdvanced.setAttribute('aria-checked', String(settings.advancedMode));
  }

  // Theme cards
  syncThemeCards(settings.theme);
}

// --------------- Theme Card Sync ---------------

function syncThemeCards(currentTheme) {
  var cards = document.querySelectorAll('.theme-card[data-theme]');
  var anyActive = false;
  cards.forEach(function(card) {
    var cardTheme = card.getAttribute('data-theme');
    var isActive = (cardTheme === currentTheme);
    card.classList.toggle('active', isActive);
    card.setAttribute('aria-checked', String(isActive));
    card.setAttribute('tabindex', isActive ? '0' : '-1');
    if (isActive) anyActive = true;
  });
  // Ensure at least one card is keyboard-reachable
  if (!anyActive && cards.length > 0) {
    cards[0].setAttribute('tabindex', '0');
  }
}

// --------------- Settings Panel Open / Close ---------------

var _settingsTrigger = null; // element that opened the panel, for focus return

function openSettings() {
  var panel = document.getElementById('settings-panel');
  var backdrop = document.getElementById('settings-backdrop');
  if (!panel || !backdrop) return;

  _settingsTrigger = document.activeElement;

  panel.classList.add('open');
  backdrop.classList.add('open');
  document.body.classList.add('settings-open');

  // Focus close button
  var closeBtn = document.getElementById('settings-close');
  if (closeBtn) closeBtn.focus();

  // Add escape listener
  document.addEventListener('keydown', _settingsKeyHandler);
}

function closeSettings() {
  var panel = document.getElementById('settings-panel');
  var backdrop = document.getElementById('settings-backdrop');
  if (!panel || !backdrop) return;

  panel.classList.remove('open');
  backdrop.classList.remove('open');
  document.body.classList.remove('settings-open');

  document.removeEventListener('keydown', _settingsKeyHandler);

  // Return focus
  if (_settingsTrigger && typeof _settingsTrigger.focus === 'function') {
    _settingsTrigger.focus();
  }
  _settingsTrigger = null;
}

function _settingsKeyHandler(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return;
  }

  // Focus trap
  if (e.key === 'Tab') {
    var panel = document.getElementById('settings-panel');
    if (!panel) return;
    var focusable = Array.from(panel.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function(el) { return el.offsetParent !== null; });
    if (focusable.length === 0) return;

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
}

// --------------- Screen Reader Announcements ---------------

function announceToSR(text) {
  if (!settings.screenReaderAnnounce) return;
  var liveRegion = dom.srLive;
  if (!liveRegion) return;
  liveRegion.textContent = text;
  // Clear after a bit so repeated identical messages are re-announced
  setTimeout(function() { liveRegion.textContent = ''; }, 1000);
}

function announceMessage(msg) {
  if (!settings.screenReaderAnnounce) return;
  var announcer = dom.ariaAnnouncer;
  if (!announcer) return;
  var sender = msg.sender_name || 'unknown';
  if (sender.startsWith('agent:')) sender = 'agent ' + sender.slice(6);
  var type = msg.type || 'message';
  announcer.textContent = sender + ' sent a ' + type + ': ' + (msg.content || '').slice(0, 100);
  // Clear after delay so repeated messages are re-announced
  setTimeout(function() { announcer.textContent = ''; }, 2000);
}

// --------------- Settings Event Wiring ---------------

function initSettings() {
  loadSettings();

  // Open / close
  var gearBtn = document.getElementById('btn-settings');
  if (gearBtn) gearBtn.addEventListener('click', openSettings);

  var closeBtn = document.getElementById('settings-close');
  if (closeBtn) closeBtn.addEventListener('click', closeSettings);

  var backdrop = document.getElementById('settings-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeSettings);

  // Segmented control (Simple / Advanced)
  var segSimple = document.getElementById('seg-simple');
  var segAdvanced = document.getElementById('seg-advanced');
  var advToggle = document.getElementById('toggle-advanced');

  function setAdvancedMode(isAdvanced) {
    if (advToggle) advToggle.checked = isAdvanced;
    saveSetting('advancedMode', isAdvanced);
    if (segSimple && segAdvanced) {
      segSimple.classList.toggle('active', !isAdvanced);
      segSimple.setAttribute('aria-checked', String(!isAdvanced));
      segAdvanced.classList.toggle('active', isAdvanced);
      segAdvanced.setAttribute('aria-checked', String(isAdvanced));
    }
  }

  if (segSimple) {
    segSimple.addEventListener('click', function() { setAdvancedMode(false); });
  }
  if (segAdvanced) {
    segAdvanced.addEventListener('click', function() { setAdvancedMode(true); });
  }
  // Keep hidden checkbox change wired for backward compat
  if (advToggle) {
    advToggle.addEventListener('change', function() {
      setAdvancedMode(this.checked);
    });
  }

  // Theme dropdown
  var themeEl = document.getElementById('setting-theme');
  if (themeEl) {
    themeEl.addEventListener('change', function() {
      saveSetting('theme', this.value);
      syncThemeCards(this.value);
    });
  }

  // Theme preview cards
  var themeCards = document.querySelectorAll('.theme-card[data-theme]');
  themeCards.forEach(function(card) {
    card.addEventListener('click', function() {
      var theme = this.getAttribute('data-theme');
      saveSetting('theme', theme);
      if (themeEl) themeEl.value = theme;
      syncThemeCards(theme);
    });
  });

  // Theme card arrow key navigation (WAI-ARIA radiogroup pattern)
  var themeCardContainer = document.querySelector('.theme-preview-row');
  if (themeCardContainer) {
    themeCardContainer.addEventListener('keydown', function(e) {
      var cards = Array.from(document.querySelectorAll('.theme-card[data-theme]'));
      var currentIndex = cards.indexOf(document.activeElement);
      if (currentIndex < 0) return;
      var nextIndex = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % cards.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + cards.length) % cards.length;
      }
      if (nextIndex >= 0) {
        e.preventDefault();
        cards[nextIndex].focus();
        cards[nextIndex].click();
      }
    });
  }

  // Segmented control arrow key navigation (WAI-ARIA radiogroup pattern)
  var segTrack = document.querySelector('.settings-segmented');
  if (segTrack) {
    segTrack.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (segAdvanced) { segAdvanced.focus(); segAdvanced.click(); }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (segSimple) { segSimple.focus(); segSimple.click(); }
      }
    });
  }

  // Font dropdown
  var fontEl = document.getElementById('setting-font');
  if (fontEl) {
    fontEl.addEventListener('change', function() {
      saveSetting('font', this.value);
    });
  }

  // Reset to defaults button
  var resetBtn = document.getElementById('settings-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', function() {
      for (var key in SETTINGS_DEFAULTS) {
        settings[key] = SETTINGS_DEFAULTS[key];
      }
      localStorage.setItem('relay_settings', JSON.stringify(settings));
      applyAllSettings();
      syncSettingsUI();
      syncThemeCards(settings.theme);
      // Reset segmented control to match
      setAdvancedMode(settings.advancedMode);
    });
  }

  // Font size slider
  var fontSizeEl = document.getElementById('setting-font-size');
  if (fontSizeEl) {
    fontSizeEl.addEventListener('input', function() {
      var step = FONT_SIZE_STEPS[parseInt(this.value, 10)] || 'default';
      saveSetting('fontSize', step);
      var labelText = FONT_SIZE_LABELS[step] || 'Default';
      var label = document.getElementById('font-size-label');
      if (label) label.textContent = labelText;
      this.setAttribute('aria-valuetext', labelText);
    });
  }

  // Mesh toggle
  var meshEl = document.getElementById('setting-mesh');
  if (meshEl) {
    meshEl.addEventListener('change', function() {
      saveSetting('meshEnabled', this.checked);
    });
  }

  // Reduced motion
  var rmEl = document.getElementById('setting-reduced-motion');
  if (rmEl) {
    rmEl.addEventListener('change', function() {
      saveSetting('reducedMotion', this.checked);
    });
  }

  // High contrast
  var hcEl = document.getElementById('setting-high-contrast');
  if (hcEl) {
    hcEl.addEventListener('change', function() {
      saveSetting('highContrast', this.checked);
    });
  }

  // Screen reader
  var srEl = document.getElementById('setting-sr-announce');
  if (srEl) {
    srEl.addEventListener('change', function() {
      saveSetting('screenReaderAnnounce', this.checked);
    });
  }

  // Simple language
  var slEl = document.getElementById('setting-simple-lang');
  if (slEl) {
    slEl.addEventListener('change', function() {
      saveSetting('simpleLanguage', this.checked);
    });
  }

  // Poll interval
  var piEl = document.getElementById('setting-poll-interval');
  if (piEl) {
    piEl.addEventListener('change', function() {
      saveSetting('pollInterval', parseInt(this.value, 10));
    });
  }

  // Origin tags
  var otEl = document.getElementById('setting-origin-tags');
  if (otEl) {
    otEl.addEventListener('change', function() {
      saveSetting('showOriginTags', this.checked);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Capability Lattice — Trust Agent Management
// ═══════════════════════════════════════════════════════════════════════════════

var trustState = {
  grants: [],      // Active trust grants for this session
  keyVersion: 1,   // Current key version
};

/**
 * Show the trust UI elements when in signal mode as session creator.
 */
function showTrustUI() {
  if (!state.session) return;
  // Only show trust UI for signal mode, and only for the session creator
  if (state.session.mode !== 'signal') return;
  if (state.session.role !== 'creator') return;

  var label = document.getElementById('trust-section-label');
  var list = document.getElementById('trust-agents-list');
  var btn = document.getElementById('btn-trust-agent');
  if (label) label.style.display = '';
  if (list) list.style.display = '';
  if (btn) btn.style.display = '';

  // Load existing grants
  fetchTrustGrants();
}

/**
 * Hide the trust UI elements.
 */
function hideTrustUI() {
  var label = document.getElementById('trust-section-label');
  var list = document.getElementById('trust-agents-list');
  var btn = document.getElementById('btn-trust-agent');
  if (label) label.style.display = 'none';
  if (list) list.style.display = 'none';
  if (btn) btn.style.display = 'none';
}

/**
 * Fetch active trust grants from the server.
 */
async function fetchTrustGrants() {
  if (!state.session) return;
  try {
    var res = await fetch('/sessions/' + state.session.id + '/trust', {
      headers: { 'Authorization': 'Bearer ' + state.session.token }
    });
    if (!res.ok) return;
    var data = await res.json();
    trustState.grants = data.grants || [];
    trustState.keyVersion = data.key_version || 1;
    renderTrustAgents();
    updateKeyVersionBadge();
  } catch (e) {
    console.error('[trust] Failed to fetch grants:', e);
  }
}

/**
 * Render the trust agents list in the left rail.
 */
function renderTrustAgents() {
  var list = document.getElementById('trust-agents-list');
  if (!list) return;
  list.innerHTML = '';

  if (trustState.grants.length === 0) {
    list.innerHTML = '<div style="font-size:10px;color:var(--text-dim);padding:4px 8px">No trusted agents</div>';
    return;
  }

  for (var i = 0; i < trustState.grants.length; i++) {
    var g = trustState.grants[i];
    var row = document.createElement('div');
    row.className = 'trust-agent-row';

    var isActive = g.active !== false;
    var caps = (g.capabilities || []).join(', ');
    var badgeClass = isActive ? 'level-2' : 'revoked';
    var badgeLabel = isActive ? 'L2' : 'REVOKED';

    row.innerHTML =
      '<span class="trust-agent-shield" title="Trusted agent">' +
        (isActive ? '&#x1F6E1;' : '&#x1F6AB;') +
      '</span>' +
      '<span class="trust-agent-name">' + escapeHtml(g.agent_id) + '</span>' +
      '<span class="trust-agent-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
      (isActive ? '<button class="trust-revoke-btn" data-agent="' + escapeHtml(g.agent_id) + '" title="Revoke trust">&#x2716;</button>' : '');

    list.appendChild(row);
  }

  // Bind revoke buttons
  var revokeBtns = list.querySelectorAll('.trust-revoke-btn');
  for (var j = 0; j < revokeBtns.length; j++) {
    revokeBtns[j].addEventListener('click', function() {
      var agentId = this.getAttribute('data-agent');
      revokeAgentTrust(agentId);
    });
  }
}

/**
 * Update the key version badge in the encryption pill.
 */
function updateKeyVersionBadge() {
  var badge = document.getElementById('key-version-badge');
  if (!badge) return;
  if (relayCrypto.enabled && trustState.keyVersion > 1) {
    badge.textContent = 'v' + trustState.keyVersion;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

var _trustTrigger = null;

/**
 * Open the trust modal for granting trust to a new agent.
 */
function openTrustModal() {
  _trustTrigger = document.activeElement;
  var backdrop = document.getElementById('trust-modal-backdrop');
  var modal = document.getElementById('trust-modal');
  var error = document.getElementById('trust-modal-error');
  if (backdrop) backdrop.style.display = '';
  if (modal) modal.style.display = '';
  if (error) error.textContent = '';
  // Clear and focus first input
  var agentInput = document.getElementById('trust-agent-id');
  var pskInput = document.getElementById('trust-agent-psk');
  if (agentInput) { agentInput.value = ''; agentInput.focus(); }
  if (pskInput) pskInput.value = '';
  document.addEventListener('keydown', _trustKeyHandler);
}

/**
 * Close the trust modal.
 */
function closeTrustModal() {
  var backdrop = document.getElementById('trust-modal-backdrop');
  var modal = document.getElementById('trust-modal');
  if (backdrop) backdrop.style.display = 'none';
  if (modal) modal.style.display = 'none';
  document.removeEventListener('keydown', _trustKeyHandler);
  if (_trustTrigger && typeof _trustTrigger.focus === 'function') {
    _trustTrigger.focus();
  }
  _trustTrigger = null;
}

function _trustKeyHandler(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeTrustModal(); return; }
  if (e.key === 'Tab') {
    var modal = document.getElementById('trust-modal');
    if (!modal) return;
    var focusable = Array.from(modal.querySelectorAll(
      'button, input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function(el) { return el.offsetParent !== null; });
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
}

/**
 * Grant trust to an agent. Performs key rotation, creates encrypted key grant,
 * and sends the trust grant to the server.
 */
async function grantAgentTrust() {
  var agentId = (document.getElementById('trust-agent-id') || {}).value || '';
  var psk = (document.getElementById('trust-agent-psk') || {}).value || '';
  var errorEl = document.getElementById('trust-modal-error');

  if (!agentId.trim()) {
    if (errorEl) errorEl.textContent = 'Agent name/ID is required.';
    return;
  }
  if (!psk.trim()) {
    if (errorEl) errorEl.textContent = 'Pre-shared key is required.';
    return;
  }
  if (!state.session || !relayCrypto.enabled) {
    if (errorEl) errorEl.textContent = 'No active encrypted session.';
    return;
  }

  // Gather capabilities
  var caps = ['read']; // always
  if ((document.getElementById('trust-cap-write') || {}).checked) caps.push('write');
  if ((document.getElementById('trust-cap-auto-approve') || {}).checked) caps.push('auto_approve');
  if ((document.getElementById('trust-cap-bridge-nostr') || {}).checked) caps.push('bridge_nostr');
  if ((document.getElementById('trust-cap-bridge-solid') || {}).checked) caps.push('bridge_solid');

  try {
    // 1. Rotate the key (forward secrecy at invite boundary)
    var rotation = await relayCrypto.rotateKey(state.session.id, 'agent_invite');

    // 2. Create encrypted key grant for the agent
    var encryptedKey = await relayCrypto.createKeyGrant(psk, agentId);

    // 3. Send to server
    var res = await fetch('/sessions/' + state.session.id + '/trust', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + state.session.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentId,
        capabilities: caps,
        encrypted_key: encryptedKey,
        key_version: rotation.version,
        rotation_nonce: rotation.nonce,
      }),
    });

    if (!res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      throw new Error(errData.error || 'Server error ' + res.status);
    }

    var result = await res.json();

    // Update local state
    trustState.keyVersion = rotation.version;
    updateKeyVersionBadge();

    // Update fingerprint display
    var fpEl = document.getElementById('key-fingerprint');
    if (fpEl) fpEl.textContent = rotation.fingerprint;

    closeTrustModal();
    fetchTrustGrants();

    // Insert a local key rotation boundary in the timeline
    insertKeyRotationBoundary(agentId, 'invite', rotation.version);

  } catch (e) {
    if (errorEl) errorEl.textContent = e.message || 'Failed to grant trust.';
    console.error('[trust] Grant failed:', e);
  }
}

/**
 * Revoke trust from an agent.
 */
async function revokeAgentTrust(agentId) {
  if (!state.session || !relayCrypto.enabled) return;
  if (!confirm('Revoke trust for agent "' + agentId + '"? A key rotation will occur and the agent will lose access to future messages.')) {
    return;
  }

  try {
    // Rotate key first
    var rotation = await relayCrypto.rotateKey(state.session.id, 'agent_revoke');

    // Send revocation to server
    var res = await fetch('/sessions/' + state.session.id + '/trust/' + encodeURIComponent(agentId), {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer ' + state.session.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rotation_nonce: rotation.nonce,
      }),
    });

    if (!res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      throw new Error(errData.error || 'Server error ' + res.status);
    }

    trustState.keyVersion = rotation.version;
    updateKeyVersionBadge();

    var fpEl = document.getElementById('key-fingerprint');
    if (fpEl) fpEl.textContent = rotation.fingerprint;

    fetchTrustGrants();

    // Insert a local key rotation boundary in the timeline
    insertKeyRotationBoundary(agentId, 'revoke', rotation.version);

  } catch (e) {
    console.error('[trust] Revoke failed:', e);
    alert('Failed to revoke trust: ' + (e.message || 'Unknown error'));
  }
}

/**
 * Insert a key rotation boundary marker in the timeline.
 */
function insertKeyRotationBoundary(agentId, reason, version) {
  var chronicle = document.getElementById('chronicle');
  if (!chronicle) return;

  var boundary = document.createElement('div');
  boundary.className = 'key-rotation-boundary';

  var label = reason === 'invite'
    ? 'Agent "' + escapeHtml(agentId) + '" invited — key rotated to v' + version
    : 'Agent "' + escapeHtml(agentId) + '" revoked — key rotated to v' + version;

  boundary.innerHTML =
    '<span class="rotation-icon">&#x1F511;</span>' +
    '<span class="rotation-label">' + label + '</span>';

  chronicle.appendChild(boundary);

  // Auto-scroll if not manually scrolled up
  if (!state.userScrolled) {
    chronicle.scrollTop = chronicle.scrollHeight;
  }
}

/**
 * Initialize trust modal event listeners.
 */
function initTrustModal() {
  var btnOpen = document.getElementById('btn-trust-agent');
  var btnClose = document.getElementById('trust-modal-close');
  var btnCancel = document.getElementById('trust-modal-cancel');
  var btnGrant = document.getElementById('trust-modal-grant');
  var backdrop = document.getElementById('trust-modal-backdrop');

  if (btnOpen) btnOpen.addEventListener('click', openTrustModal);
  if (btnClose) btnClose.addEventListener('click', closeTrustModal);
  if (btnCancel) btnCancel.addEventListener('click', closeTrustModal);
  if (btnGrant) btnGrant.addEventListener('click', grantAgentTrust);
  if (backdrop) backdrop.addEventListener('click', closeTrustModal);
}

// --------------- Disappearing Messages Helper ---------------

function formatDisappearingTTL(seconds) {
  if (seconds <= 0) return 'Off';
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  return '24h';
}

// --------------- Settings Security Section ---------------

function updateSettingsSecurity() {
  var statusEl = document.getElementById('setting-encryption-status');
  var fpRow = document.getElementById('setting-fingerprint-row');
  var fpEl = document.getElementById('setting-fingerprint');
  var disappRow = document.getElementById('setting-disappearing-row');
  var disappStatus = document.getElementById('setting-disappearing-status');
  var verifyRow = document.getElementById('setting-verify-row');

  if (!state.session) {
    if (statusEl) {
      statusEl.textContent = 'Not in session';
      statusEl.className = 'encryption-status';
    }
    if (fpRow) fpRow.style.display = 'none';
    if (disappRow) disappRow.style.display = 'none';
    if (verifyRow) verifyRow.style.display = 'none';
    return;
  }

  var isSignal = state.session.mode === 'signal';

  if (relayCrypto.enabled) {
    if (statusEl) {
      statusEl.textContent = 'End-to-end encrypted';
      statusEl.className = 'encryption-status active';
    }
    if (fpRow) {
      fpRow.style.display = 'flex';
      var fp = relayCrypto.getFingerprint ? relayCrypto.getFingerprint() : '';
      if (fpEl) fpEl.textContent = fp || '---';
    }
    if (verifyRow) verifyRow.style.display = 'flex';
  } else {
    if (statusEl) {
      statusEl.textContent = isSignal ? 'Key required' : 'Not encrypted';
      statusEl.className = 'encryption-status';
    }
    if (fpRow) fpRow.style.display = 'none';
    if (verifyRow) verifyRow.style.display = 'none';
  }

  // Disappearing messages
  if (isSignal && state.disappearingTTL > 0) {
    if (disappRow) disappRow.style.display = 'flex';
    if (disappStatus) disappStatus.textContent = formatDisappearingTTL(state.disappearingTTL);
  } else {
    if (disappRow) disappRow.style.display = 'none';
  }
}

// --------------- Key Verification Panel ---------------

function openKeyVerification() {
  var panel = document.getElementById('key-verification-panel');
  var fullFp = document.getElementById('verify-fingerprint-full');
  var qrText = document.getElementById('verify-qr-text');

  if (!panel) return;
  panel.style.display = '';

  // Get full fingerprint
  var fp = '';
  if (relayCrypto.enabled && relayCrypto.getFingerprint) {
    fp = relayCrypto.getFingerprint() || '';
  }

  // Show the full fingerprint (extend it if possible, or show what we have)
  if (fullFp) {
    // Display fingerprint in groups of 4 for readability
    var formatted = fp.replace(/(.{4})/g, '$1 ').trim();
    fullFp.textContent = formatted || '(no key available)';
  }

  // Simple text "QR" representation — a visual grid of the fingerprint
  if (qrText && fp) {
    var qrGrid = generateTextQR(fp);
    qrText.textContent = qrGrid;
  } else if (qrText) {
    qrText.textContent = '(no key to display)';
  }

  // Focus the close button so keyboard/SR users know the panel appeared
  var closeBtn = document.getElementById('btn-close-verify');
  if (closeBtn) closeBtn.focus();
}

function closeKeyVerification() {
  var panel = document.getElementById('key-verification-panel');
  if (panel) panel.style.display = 'none';
}

/**
 * Generate a simple text-based visual representation of a fingerprint.
 * Uses block characters to create a visual pattern that can be compared visually.
 */
function generateTextQR(fp) {
  var chars = fp.replace(/[^a-fA-F0-9]/g, '');
  if (chars.length < 8) return '(fingerprint too short)';

  var blocks = [' ', '\u2591', '\u2592', '\u2593', '\u2588'];
  var lines = [];
  var width = 12;
  var height = 6;

  for (var y = 0; y < height; y++) {
    var line = '';
    for (var x = 0; x < width; x++) {
      var idx = (y * width + x) % chars.length;
      var val = parseInt(chars[idx], 16);
      var blockIdx = Math.floor(val / 4); // 0-3 mapped to block chars
      if (blockIdx > 4) blockIdx = 4;
      line += blocks[blockIdx] + blocks[blockIdx];
    }
    lines.push(line);
  }

  return lines.join('\n');
}

// --------------- Wire Verify Keys & Signal Fingerprint Button ---------------

function initSecurityUI() {
  var verifyBtn = document.getElementById('btn-verify-keys');
  if (verifyBtn) verifyBtn.addEventListener('click', openKeyVerification);

  var closeVerifyBtn = document.getElementById('btn-close-verify');
  if (closeVerifyBtn) closeVerifyBtn.addEventListener('click', closeKeyVerification);

  // Signal banner fingerprint button — show full fingerprint on click
  var fpBtn = document.getElementById('signal-fingerprint-btn');
  if (fpBtn) {
    fpBtn.addEventListener('click', function() {
      openSettings();
      // Scroll to security section after panel opens
      setTimeout(function() {
        var secSection = document.getElementById('settings-security-section');
        if (secSection) secSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        openKeyVerification();
      }, 350);
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
