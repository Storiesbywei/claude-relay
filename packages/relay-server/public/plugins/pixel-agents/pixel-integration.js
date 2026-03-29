// === Pixel Integration — Bridge between Relay Dashboard and Pixel Agents ===
// Self-initializing IIFE. Listens to custom DOM events from app.js and
// drives the PixelAgents visualization engine. Graceful no-op if
// PixelAgents is not loaded.

window.PixelIntegration = (() => {
  'use strict';

  // ── Guard: bail if the visualization engine is absent ──
  if (typeof PixelAgents === 'undefined') {
    console.warn('[pixel-integration] PixelAgents not found — skipping integration.');
    return { ready: false };
  }

  // ── DOM refs ──
  const $ = (s) => document.querySelector(s);
  const pixelView       = $('#pixel-view');
  const pixelToggle     = $('#btn-pixel-toggle');
  const pixelAgentList  = $('#pixel-agent-list');
  const directorView    = $('#director-view');
  const peerView        = $('#peer-view');

  // ── Internal state ──
  let initialized   = false;
  let testCounter   = 0;
  let taskCounter   = 0;
  const activeTaskIds = [];
  const taskNames = [
    'Fix login bug', 'Update API', 'Write tests',
    'Refactor DB', 'Deploy v2', 'Code review',
  ];

  // ── Optional config modules (graceful fallback) ──
  const Creatures   = window.PixelCreatureConfig   || null;
  const Progression = window.PixelProgressionConfig || null;
  const Collab      = window.PixelCollabConfig      || null;

  let tensionEngine    = null;
  let celebrationCascade = null;
  let relayLineManager   = null;

  if (Progression) {
    try { tensionEngine = new Progression.TensionEngine(); } catch (_) { /* skip */ }
  }
  if (Collab) {
    try { celebrationCascade = new Collab.CelebrationCascade(); } catch (_) { /* skip */ }
    try { relayLineManager   = new Collab.RelayLineManager();   } catch (_) { /* skip */ }
  }

  // ── Utility ──

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ── Initialization ──

  function ensureInit() {
    if (initialized) return;
    const container = $('#pixel-canvas-container');
    if (!container) return;
    PixelAgents.init(container);
    initialized = true;
  }

  // ── View Toggle ──

  function togglePixelView() {
    ensureInit();

    const isShowing = pixelView && pixelView.style.display !== 'none';
    if (isShowing) {
      // Hide pixel view, restore whichever relay mode was active
      pixelView.style.display = 'none';
      PixelAgents.hide();
      if (pixelToggle) pixelToggle.classList.remove('active');
      // Let app.js decide which view to restore via its own state
      document.dispatchEvent(new CustomEvent('pixel:hidden'));
    } else {
      // Show pixel view, hide director/peer
      if (directorView) directorView.style.display = 'none';
      if (peerView)     peerView.style.display     = 'none';
      if (pixelView)    pixelView.style.display     = 'flex';
      PixelAgents.show();
      if (pixelToggle) pixelToggle.classList.add('active');
      refreshSidebar();
      document.dispatchEvent(new CustomEvent('pixel:shown'));
    }
  }

  // ── Participant Sync (relay:participants) ──

  function handleParticipants(e) {
    if (!initialized) return;
    const names = (e.detail && e.detail.names) || [];
    const existingIds = new Set();

    for (const name of names) {
      const agentId = 'relay-' + name;
      existingIds.add(agentId);
      if (!PixelAgents.agents.has(agentId)) {
        PixelAgents.spawnAgent(agentId, name);
      }
    }

    // Despawn agents that left the session
    for (const id of PixelAgents.agents.keys()) {
      if (id.startsWith('relay-') && !existingIds.has(id)) {
        PixelAgents.despawnAgent(id);
      }
    }

    refreshSidebar();
  }

  // ── Message Handling (relay:message) ──

  function handleMessage(e) {
    if (!initialized) return;
    const msg = (e.detail && e.detail.msg) || {};

    // Task messages spawn obstacles
    if (msg.type === 'task') {
      spawnTaskObstacle(msg);
    }

    // Answer messages with completion keywords resolve the oldest task
    if (msg.type === 'answer' && activeTaskIds.length > 0) {
      const content = (msg.content || '').toLowerCase();
      const completionKeywords = ['done', 'complete', 'fixed', 'resolved', 'shipped', 'passing'];
      if (completionKeywords.some(kw => content.includes(kw))) {
        resolveOldestTask();
      }
    }

    // Optional: relay lines between agents on any message
    if (relayLineManager && msg.sender) {
      const agents = [...PixelAgents.agents.values()];
      if (agents.length >= 2) {
        const from = agents.find(a => a.name === msg.sender) || agents[0];
        const to   = agents.find(a => a.name !== msg.sender) || agents[1];
        try {
          relayLineManager.spawn
            ? relayLineManager.spawn(from, to, PixelAgents.SCALED_TILE)
            : null;
        } catch (_) { /* skip */ }
      }
    }
  }

  function spawnTaskObstacle(msg) {
    const agentIds = [...PixelAgents.agents.keys()];
    if (agentIds.length === 0) return;

    const taskId  = 'relay-task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const label   = (msg.content || 'task').slice(0, 20);
    const assignee = agentIds[Math.floor(Math.random() * agentIds.length)];

    // Classify knight variant if creature config is available (future use)
    if (Creatures && Creatures.classifyKnight) {
      try { Creatures.classifyKnight(label, msg.content); } catch (_) { /* skip */ }
    }

    PixelAgents.spawnObstacle(taskId, assignee, label);
    activeTaskIds.push(taskId);

    if (tensionEngine) {
      try { tensionEngine.update && tensionEngine.update(); } catch (_) { /* skip */ }
    }

    refreshSidebar();
  }

  function resolveOldestTask() {
    const taskId = activeTaskIds.shift();
    if (!taskId) return;

    // Grab obstacle position before it dies (for celebration cascade)
    const obs = PixelAgents.obstacles.get(taskId);
    PixelAgents.resolveObstacle(taskId);

    if (tensionEngine) {
      try { tensionEngine.onKnightKilled(); } catch (_) { /* skip */ }
    }

    if (celebrationCascade && obs) {
      try {
        const nearby = [...PixelAgents.obstacles.values()]
          .filter(o => o.id !== taskId)
          .map(o => ({ x: o.tileX || o.renderX, y: o.tileY || o.renderY, id: o.id }));
        const killX = (obs.tileX || obs.renderX) * PixelAgents.SCALED_TILE + PixelAgents.SCALED_TILE / 2;
        const killY = (obs.tileY || obs.renderY) * PixelAgents.SCALED_TILE + PixelAgents.SCALED_TILE / 2;
        celebrationCascade.trigger(killX, killY, PixelAgents.SCALED_TILE, nearby);
      } catch (_) { /* skip */ }
    }

    refreshSidebar();
  }

  // ── Status Updates (relay:status) ──

  function handleStatus(e) {
    if (!initialized) return;
    const msg = (e.detail && e.detail.msg) || {};
    const status = (msg.content || '').trim().toLowerCase();
    const senderName = msg.sender_name || msg.sender || 'Worker';
    const agentId = 'relay-' + senderName;

    const stateMap = {
      writing: 'typing', editing: 'typing',
      reading: 'reading', exploring: 'reading',
      testing: 'thinking', running: 'thinking', thinking: 'thinking',
      waiting: 'waiting',
      idle: 'idle', done: 'idle',
    };

    let pixelState = 'typing'; // default for unknown activity
    for (const [keyword, mapped] of Object.entries(stateMap)) {
      if (status.includes(keyword)) {
        pixelState = mapped;
        break;
      }
    }

    if (PixelAgents.agents.has(agentId)) {
      PixelAgents.setAgentState(agentId, pixelState, 8000);
      refreshSidebar();
    }
  }

  // ── Sidebar Refresh ──

  function refreshSidebar() {
    if (!pixelAgentList) return;
    pixelAgentList.innerHTML = '';

    const agents    = PixelAgents.agents;
    const obstacles = PixelAgents.obstacles;
    const gatos     = PixelAgents.gatos;

    // — AGENTS section —
    if (agents.size > 0) {
      appendSectionHeader('AGENTS', 'var(--text-muted)');
      const colors = PixelAgents.LABEL_COLORS;
      for (const [, agent] of agents) {
        appendItem(
          colors[agent.charIdx % colors.length],
          agent.name,
          agent.state
        );
      }
    }

    // — TASKS section —
    if (obstacles.size > 0) {
      appendSectionHeader('TASKS', 'var(--red)');
      for (const [, obs] of obstacles) {
        const healthPct = Math.round(obs.health * 100);
        const color = obs.health > 0.3 ? '#f0883e' : '#f85149';
        const status = obs.state === 'dying' ? 'DONE' : healthPct + '%';
        appendItem(color, obs.label, status);
      }
    }

    // — OFFICE CATS section —
    if (gatos.size > 0) {
      appendSectionHeader('OFFICE CATS', 'var(--green)');
      for (const [, gato] of gatos) {
        const status = gato.state === 'idle' ? 'napping' : gato.fleeing ? 'fleeing!' : 'roaming';
        appendItem('#3fb950', 'Gato', status);
      }
    }

    // Empty state
    if (agents.size === 0 && obstacles.size === 0) {
      pixelAgentList.innerHTML =
        '<div class="file-tree-empty">No agents yet.<br>Start a session to see agents appear.</div>';
    }
  }

  function appendSectionHeader(text, color) {
    const div = document.createElement('div');
    div.className = 'pixel-agent-item';
    div.innerHTML =
      '<span class="pixel-agent-name" style="color: ' + color +
      '; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 1px">' +
      text + '</span>';
    pixelAgentList.appendChild(div);
  }

  function appendItem(dotColor, name, state) {
    const div = document.createElement('div');
    div.className = 'pixel-agent-item';
    div.innerHTML =
      '<span class="pixel-agent-dot" style="background: ' + dotColor + '"></span>' +
      '<span class="pixel-agent-name">' + escapeHtml(name) + '</span>' +
      '<span class="pixel-agent-state">' + escapeHtml(state) + '</span>';
    pixelAgentList.appendChild(div);
  }

  // ── Periodic sidebar refresh ──
  let refreshInterval = null;

  function startRefreshLoop() {
    if (refreshInterval) return;
    refreshInterval = setInterval(() => {
      if (initialized && pixelView && pixelView.style.display !== 'none') {
        refreshSidebar();
      }
    }, 2000);
  }

  function stopRefreshLoop() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  // ── Special creature spawns (optional, driven by PixelCreatureConfig) ──
  let specialSpawnInterval = null;

  function startSpecialSpawnLoop() {
    if (!Creatures || !Creatures.checkSpecialSpawns) return;
    if (specialSpawnInterval) return;
    const activeSpecials = new Set();

    specialSpawnInterval = setInterval(() => {
      if (!initialized) return;
      try {
        const context = {
          activeTaskCount: PixelAgents.obstacles.size,
          agents: PixelAgents.agents.size,
          obstacles: PixelAgents.obstacles,
          lastMessageType: null,
          now: Date.now(),
          activeSpecials,
        };
        const spawns = Creatures.checkSpecialSpawns(context);
        if (spawns && spawns.length > 0) {
          for (const spawn of spawns) {
            activeSpecials.add(spawn.key || spawn.type);
          }
        }
      } catch (_) { /* skip */ }
    }, 5000);
  }

  // ── Test Button Wiring ──

  function wireTestButtons() {
    const btnSpawnTest = $('#btn-spawn-test');
    const btnSpawnTask = $('#btn-spawn-task');
    const btnResolve   = $('#btn-resolve-task');

    if (btnSpawnTest) {
      btnSpawnTest.addEventListener('click', () => {
        if (!initialized) return;
        const names = ['Alice', 'Bob', 'Claude', 'Diana', 'Eve', 'Frank'];
        const name  = names[testCounter % names.length];
        const id    = 'test-' + Date.now() + '-' + testCounter;
        PixelAgents.spawnAgent(id, name);
        testCounter++;
        refreshSidebar();

        // Cycle through states for demo
        const states = ['typing', 'reading', 'thinking', 'waiting', 'idle'];
        let stateIdx = 0;
        const interval = setInterval(() => {
          if (!PixelAgents.agents.has(id)) { clearInterval(interval); return; }
          PixelAgents.setAgentState(id, states[stateIdx % states.length], 4000);
          stateIdx++;
          refreshSidebar();
        }, 5000);
      });
    }

    if (btnSpawnTask) {
      btnSpawnTask.addEventListener('click', () => {
        if (!initialized) return;
        const agentIds = [...PixelAgents.agents.keys()];
        if (agentIds.length === 0) return;

        const taskId   = 'task-' + Date.now();
        const label    = taskNames[taskCounter % taskNames.length];
        const assignee = agentIds[taskCounter % agentIds.length];
        taskCounter++;

        PixelAgents.spawnObstacle(taskId, assignee, label);
        activeTaskIds.push(taskId);
        refreshSidebar();
      });
    }

    if (btnResolve) {
      btnResolve.addEventListener('click', () => {
        if (!initialized) return;
        resolveOldestTask();
      });
    }
  }

  // ── Toggle Button Wiring ──

  function wireToggle() {
    if (pixelToggle) {
      pixelToggle.addEventListener('click', togglePixelView);
    }
  }

  // ── URL Parameter: ?mode=pixel auto-open ──

  function checkAutoOpen() {
    const urlMode = new URLSearchParams(window.location.search).get('mode');
    if (urlMode === 'pixel') {
      // Small delay to let app.js finish its own init
      requestAnimationFrame(() => {
        togglePixelView();
      });
    }
  }

  // ── Event Subscriptions ──

  function subscribe() {
    document.addEventListener('relay:participants', handleParticipants);
    document.addEventListener('relay:message',      handleMessage);
    document.addEventListener('relay:status',        handleStatus);
  }

  // ── Boot ──

  function boot() {
    subscribe();
    wireToggle();
    wireTestButtons();
    startRefreshLoop();
    startSpecialSpawnLoop();
    checkAutoOpen();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ── Public API ──
  return {
    ready: true,
    toggle: togglePixelView,
    refresh: refreshSidebar,
    ensureInit,
    get initialized() { return initialized; },
    get activeTaskCount() { return activeTaskIds.length; },
  };
})();
