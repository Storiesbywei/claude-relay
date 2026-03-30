// === Pixel Music Controls — Floating mini-player for procedural lofi audio ===
// Provides seed display, randomize, seed history, seed input, volume slider,
// and play/pause toggle. Attaches to #pixel-canvas-container as a floating panel.
// Depends on: PixelAudioEngine, PixelFireplaceMode (optional)
// Exposes: window.PixelMusicControls

(function () {
  'use strict';

  var Audio = window.PixelAudioEngine;
  var Fireplace = window.PixelFireplaceMode;

  if (!Audio) {
    window.PixelMusicControls = { ready: false };
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  // State
  // ══════════════════════════════════════════════════════════════════

  var currentSeed = 0;
  var seedHistory = [];       // Array of { seed: number, timestamp: number }
  var MAX_HISTORY = 20;
  var panelEl = null;
  var collapsed = false;
  var mixerCollapsed = true;  // mixer section collapsed by default
  var updateTimer = null;

  // Mixer levels (0..1 each, synced with Audio engine)
  var mixerLevels = {
    melody: 1.0,
    harmony: 1.0,
    bass: 1.0,
    ambient: 0.7,
    hiss: 0.5,
  };

  // Try to load state from localStorage
  try {
    var saved = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
    if (saved.seedHistory) seedHistory = saved.seedHistory.slice(0, MAX_HISTORY);
    if (typeof saved.volume === 'number') Audio.setVolume(saved.volume);
    if (typeof saved.hissLevel === 'number' && Audio.setHissLevel) Audio.setHissLevel(saved.hissLevel);
    if (typeof saved.collapsed === 'boolean') collapsed = saved.collapsed;
    if (typeof saved.mixerCollapsed === 'boolean') mixerCollapsed = saved.mixerCollapsed;
    if (saved.mixerLevels) {
      var ml = saved.mixerLevels;
      if (typeof ml.melody === 'number') { mixerLevels.melody = ml.melody; if (Audio.setMelodyLevel) Audio.setMelodyLevel(ml.melody); }
      if (typeof ml.harmony === 'number') { mixerLevels.harmony = ml.harmony; if (Audio.setHarmonyLevel) Audio.setHarmonyLevel(ml.harmony); }
      if (typeof ml.bass === 'number') { mixerLevels.bass = ml.bass; if (Audio.setBassLevel) Audio.setBassLevel(ml.bass); }
      if (typeof ml.ambient === 'number') { mixerLevels.ambient = ml.ambient; if (Audio.setAmbientLevel) Audio.setAmbientLevel(ml.ambient); }
      if (typeof ml.hiss === 'number') { mixerLevels.hiss = ml.hiss; }
    }
  } catch (_) { /* skip */ }

  // ══════════════════════════════════════════════════════════════════
  // Persistence
  // ══════════════════════════════════════════════════════════════════

  function saveState() {
    try {
      localStorage.setItem('pixelMusicControls', JSON.stringify({
        seedHistory: seedHistory.slice(0, MAX_HISTORY),
        volume: getVolume(),
        hissLevel: getHissLevel(),
        collapsed: collapsed,
        mixerCollapsed: mixerCollapsed,
        mixerLevels: mixerLevels,
      }));
    } catch (_) { /* skip */ }
  }

  function getVolume() {
    var state = Audio.getState();
    // Audio engine doesn't expose volume directly in getState,
    // so we'll track it ourselves via the slider
    var slider = panelEl && panelEl.querySelector('.pmc-volume-slider');
    if (slider) return parseFloat(slider.value);
    return 0.5;
  }

  function getHissLevel() {
    var slider = panelEl && panelEl.querySelector('.pmc-hiss-slider');
    if (slider) return parseFloat(slider.value) / 100;
    if (Audio.getHissLevel) return Audio.getHissLevel();
    return 0.5;
  }

  /** Paint volume slider filled portion via linear-gradient (webkit compat) */
  function paintPmcVolFill(slider) {
    var pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = 'linear-gradient(to right, #34d058 0%, #34d058 ' + pct + '%, rgba(255,255,255,0.15) ' + pct + '%, rgba(255,255,255,0.15) 100%)';
  }

  /** Paint hiss slider filled portion via linear-gradient (amber tint) */
  function paintPmcHissFill(slider) {
    var pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = 'linear-gradient(to right, #e6d5a8 0%, #e6d5a8 ' + pct + '%, rgba(255,255,255,0.15) ' + pct + '%, rgba(255,255,255,0.15) 100%)';
  }

  /** Paint a mixer slider with a given color */
  function paintMixerFill(slider, color) {
    var pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = 'linear-gradient(to right, ' + color + ' 0%, ' + color + ' ' + pct + '%, rgba(255,255,255,0.10) ' + pct + '%, rgba(255,255,255,0.10) 100%)';
  }

  // ══════════════════════════════════════════════════════════════════
  // Seed Management
  // ══════════════════════════════════════════════════════════════════

  function generateRandomSeed() {
    return Math.floor(Math.random() * 2147483647);
  }

  function addToHistory(seed) {
    // Don't add duplicates back-to-back
    if (seedHistory.length > 0 && seedHistory[0].seed === seed) return;
    seedHistory.unshift({
      seed: seed,
      timestamp: Date.now(),
    });
    if (seedHistory.length > MAX_HISTORY) {
      seedHistory = seedHistory.slice(0, MAX_HISTORY);
    }
    saveState();
  }

  function startWithSeed(seed) {
    seed = Math.floor(seed);
    currentSeed = seed;
    addToHistory(seed);

    // Stop current playback first
    if (Audio.isPlaying()) {
      Audio.stop();
    }

    // If fireplace is active, restart it with the new seed too
    if (Fireplace && Fireplace.isActive()) {
      Fireplace.stop();
      // Small delay so stop completes, then restart both
      setTimeout(function () {
        Fireplace.start(seed);
        setTimeout(function () {
          Audio.start(seed);
          updateDisplay();
        }, 100);
      }, 900);
    } else {
      // Just restart audio
      setTimeout(function () {
        Audio.start(seed);
        updateDisplay();
      }, 50);
    }
  }

  function togglePlayback() {
    if (Audio.isPlaying()) {
      Audio.stop();
      if (Fireplace && Fireplace.isActive()) {
        Fireplace.stop();
      }
    } else {
      // Always generate a fresh seed on play — never reuse the old one.
      // If the user wants a specific seed, they use the seed input or history.
      var seed = generateRandomSeed();
      currentSeed = seed;
      addToHistory(seed);

      // Start fireplace if available
      if (Fireplace) {
        Fireplace.start(seed);
      }
      Audio.start(seed);
    }
    updateDisplay();
  }

  // ══════════════════════════════════════════════════════════════════
  // UI Construction
  // ══════════════════════════════════════════════════════════════════

  function createPanel() {
    var container = document.getElementById('pixel-canvas-container');
    if (!container || panelEl) return;

    panelEl = document.createElement('div');
    panelEl.className = 'pmc-panel';
    panelEl.setAttribute('data-collapsed', collapsed ? 'true' : 'false');

    // Prevent clicks from bubbling to canvas (which would exit fireplace)
    panelEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    panelEl.innerHTML = buildPanelHTML();
    container.style.position = 'relative';
    container.appendChild(panelEl);

    wireEvents();
    updateDisplay();

    // Start periodic state refresh
    updateTimer = setInterval(updateDisplay, 1000);
  }

  function buildPanelHTML() {
    return '' +
      '<div class="pmc-header">' +
        '<span class="pmc-title">lofi</span>' +
        '<button class="pmc-btn pmc-collapse-btn" title="Collapse/expand">' + PixelIcons.icon('chevron-down', 14) + '</button>' +
      '</div>' +
      '<div class="pmc-body">' +
        // Play/pause + seed display row
        '<div class="pmc-row pmc-transport-row">' +
          '<button class="pmc-btn pmc-play-btn" title="Play / Pause">' + PixelIcons.icon('play', 16) + '</button>' +
          '<div class="pmc-seed-display">' +
            '<span class="pmc-seed-label">seed</span>' +
            '<span class="pmc-seed-value">--</span>' +
          '</div>' +
          '<button class="pmc-btn pmc-randomize-btn" title="New random seed">' + PixelIcons.icon('dice-5', 16) + '</button>' +
        '</div>' +
        // Volume row
        '<div class="pmc-row pmc-volume-row">' +
          '<span class="pmc-vol-icon" title="Volume">' + PixelIcons.icon('volume-2', 14) + '</span>' +
          '<input type="range" class="pmc-volume-slider" min="0" max="1" step="0.01" value="0.5" />' +
          '<span class="pmc-vol-value">50</span>' +
        '</div>' +
        // Mixer section (collapsible)
        '<div class="pmc-mixer">' +
          '<div class="pmc-mixer-header">' +
            '<span class="pmc-mixer-toggle">mixer</span>' +
            '<span class="pmc-mixer-arrow">' + (mixerCollapsed ? '>' : 'v') + '</span>' +
          '</div>' +
          '<div class="pmc-mixer-body"' + (mixerCollapsed ? ' style="display:none"' : '') + '>' +
            '<div class="pmc-mixer-row" data-bus="melody">' +
              '<span class="pmc-mixer-label">melody</span>' +
              '<input type="range" class="pmc-mixer-slider" min="0" max="100" step="1" value="' + Math.round(mixerLevels.melody * 100) + '" />' +
              '<span class="pmc-mixer-val">' + Math.round(mixerLevels.melody * 100) + '</span>' +
            '</div>' +
            '<div class="pmc-mixer-row" data-bus="harmony">' +
              '<span class="pmc-mixer-label">harm</span>' +
              '<input type="range" class="pmc-mixer-slider" min="0" max="100" step="1" value="' + Math.round(mixerLevels.harmony * 100) + '" />' +
              '<span class="pmc-mixer-val">' + Math.round(mixerLevels.harmony * 100) + '</span>' +
            '</div>' +
            '<div class="pmc-mixer-row" data-bus="bass">' +
              '<span class="pmc-mixer-label">bass</span>' +
              '<input type="range" class="pmc-mixer-slider" min="0" max="100" step="1" value="' + Math.round(mixerLevels.bass * 100) + '" />' +
              '<span class="pmc-mixer-val">' + Math.round(mixerLevels.bass * 100) + '</span>' +
            '</div>' +
            '<div class="pmc-mixer-row" data-bus="ambient">' +
              '<span class="pmc-mixer-label">amb</span>' +
              '<input type="range" class="pmc-mixer-slider" min="0" max="100" step="1" value="' + Math.round(mixerLevels.ambient * 100) + '" />' +
              '<span class="pmc-mixer-val">' + Math.round(mixerLevels.ambient * 100) + '</span>' +
            '</div>' +
            '<div class="pmc-mixer-row" data-bus="hiss">' +
              '<span class="pmc-mixer-label">hiss</span>' +
              '<input type="range" class="pmc-mixer-slider pmc-hiss-slider" min="0" max="100" step="1" value="' + Math.round(mixerLevels.hiss * 100) + '" />' +
              '<span class="pmc-mixer-val pmc-hiss-value">' + Math.round(mixerLevels.hiss * 100) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Seed input row
        '<div class="pmc-row pmc-input-row">' +
          '<input type="text" class="pmc-seed-input" placeholder="enter seed..." maxlength="12" />' +
          '<button class="pmc-btn pmc-go-btn" title="Play this seed">Go</button>' +
        '</div>' +
        // Seed history
        '<div class="pmc-history">' +
          '<div class="pmc-history-label">history</div>' +
          '<div class="pmc-history-list"></div>' +
        '</div>' +
        // Now playing info
        '<div class="pmc-now-playing">' +
          '<span class="pmc-np-scene">--</span>' +
          '<span class="pmc-np-detail">--</span>' +
        '</div>' +
      '</div>';
  }

  // ══════════════════════════════════════════════════════════════════
  // Event Wiring
  // ══════════════════════════════════════════════════════════════════

  function wireEvents() {
    if (!panelEl) return;

    // Collapse toggle
    var collapseBtn = panelEl.querySelector('.pmc-collapse-btn');
    collapseBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      panelEl.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
      collapseBtn.innerHTML = collapsed ? PixelIcons.icon('chevron-up', 14) : PixelIcons.icon('chevron-down', 14);
      saveState();
    });

    // Play/pause
    var playBtn = panelEl.querySelector('.pmc-play-btn');
    playBtn.addEventListener('click', togglePlayback);

    // Randomize
    var randomBtn = panelEl.querySelector('.pmc-randomize-btn');
    randomBtn.addEventListener('click', function () {
      var newSeed = generateRandomSeed();
      startWithSeed(newSeed);
    });

    // Seed display — click to copy shareable fireplace URL
    var seedDisplayDiv = panelEl.querySelector('.pmc-seed-display');
    if (seedDisplayDiv) {
      seedDisplayDiv.style.cursor = 'pointer';
      seedDisplayDiv.title = 'Click to copy shareable URL';
      seedDisplayDiv.addEventListener('click', function () {
        var displaySeed = currentSeed;
        if (Fireplace && Fireplace.isActive()) {
          displaySeed = Fireplace.getSeed();
        }
        var url = window.location.origin + '/?mode=fireplace&seed=' + displaySeed;
        if (typeof window.copyText === 'function') {
          window.copyText(url);
        } else if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(url).catch(function () {});
        }
        // Brief visual feedback
        var seedValEl = seedDisplayDiv.querySelector('.pmc-seed-value');
        if (seedValEl) {
          var orig = seedValEl.textContent;
          seedValEl.textContent = 'copied!';
          seedValEl.style.color = '#3fb950';
          setTimeout(function () {
            seedValEl.textContent = orig;
            seedValEl.style.color = '';
          }, 1200);
        }
      });
    }

    // Volume slider
    var volumeSlider = panelEl.querySelector('.pmc-volume-slider');
    var volValue = panelEl.querySelector('.pmc-vol-value');

    // Restore saved volume
    try {
      var saved = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
      if (typeof saved.volume === 'number') {
        volumeSlider.value = saved.volume;
        volValue.textContent = Math.round(saved.volume * 100);
      }
    } catch (_) { /* skip */ }
    paintPmcVolFill(volumeSlider);

    volumeSlider.addEventListener('input', function () {
      var v = parseFloat(this.value);
      Audio.setVolume(v);
      volValue.textContent = Math.round(v * 100);
      paintPmcVolFill(this);
      saveState();
    });

    // Mixer section
    wireMixer();

    // Seed input + Go button
    var seedInput = panelEl.querySelector('.pmc-seed-input');
    var goBtn = panelEl.querySelector('.pmc-go-btn');

    function submitSeed() {
      var val = seedInput.value.trim();
      if (!val) return;
      var seed = parseInt(val, 10);
      if (isNaN(seed)) {
        // Hash string seeds
        seed = djb2Hash(val);
      }
      startWithSeed(seed);
      seedInput.value = '';
    }

    goBtn.addEventListener('click', submitSeed);
    seedInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitSeed();
      }
      // Prevent space/escape from propagating to fireplace controls
      e.stopPropagation();
    });
    // Prevent all keyboard events from propagating out of the input
    seedInput.addEventListener('keyup', function (e) { e.stopPropagation(); });
    seedInput.addEventListener('keypress', function (e) { e.stopPropagation(); });
  }

  // ══════════════════════════════════════════════════════════════════
  // Mixer Wiring
  // ══════════════════════════════════════════════════════════════════

  var MIXER_COLORS = {
    melody:  '#7cb3ff',
    harmony: '#a78bfa',
    bass:    '#f97583',
    ambient: '#56d364',
    hiss:    '#e6d5a8',
  };

  var MIXER_API = {
    melody:  function (v) { if (Audio.setMelodyLevel) Audio.setMelodyLevel(v); },
    harmony: function (v) { if (Audio.setHarmonyLevel) Audio.setHarmonyLevel(v); },
    bass:    function (v) { if (Audio.setBassLevel) Audio.setBassLevel(v); },
    ambient: function (v) { if (Audio.setAmbientLevel) Audio.setAmbientLevel(v); },
    hiss:    function (v) { if (Audio.setHissLevel) Audio.setHissLevel(v); },
  };

  function wireMixer() {
    if (!panelEl) return;

    // Toggle collapse
    var header = panelEl.querySelector('.pmc-mixer-header');
    var body = panelEl.querySelector('.pmc-mixer-body');
    var arrow = panelEl.querySelector('.pmc-mixer-arrow');

    if (header) {
      header.addEventListener('click', function () {
        mixerCollapsed = !mixerCollapsed;
        body.style.display = mixerCollapsed ? 'none' : '';
        arrow.textContent = mixerCollapsed ? '>' : 'v';
        saveState();
      });
    }

    // Wire each mixer slider
    var rows = panelEl.querySelectorAll('.pmc-mixer-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var bus = row.getAttribute('data-bus');
        var slider = row.querySelector('.pmc-mixer-slider');
        var valSpan = row.querySelector('.pmc-mixer-val');
        var color = MIXER_COLORS[bus] || '#8b949e';

        // Paint initial fill
        paintMixerFill(slider, color);

        slider.addEventListener('input', function () {
          var v = parseInt(this.value, 10);
          var normalized = v / 100;
          valSpan.textContent = v;
          mixerLevels[bus] = normalized;
          paintMixerFill(this, color);

          // Call the audio API
          if (MIXER_API[bus]) MIXER_API[bus](normalized);
          saveState();
        });
      })(rows[i]);
    }

    // Listen for engine-initiated mixer updates (e.g., presets)
    document.addEventListener('audio:mixer-update', function (e) {
      if (!e.detail || !panelEl) return;
      var d = e.detail;
      var buses = ['melody', 'harmony', 'bass', 'ambient', 'hiss'];
      for (var j = 0; j < buses.length; j++) {
        var busName = buses[j];
        if (typeof d[busName] === 'number') {
          mixerLevels[busName] = d[busName];
          var row = panelEl.querySelector('.pmc-mixer-row[data-bus="' + busName + '"]');
          if (row) {
            var sl = row.querySelector('.pmc-mixer-slider');
            var vs = row.querySelector('.pmc-mixer-val');
            if (sl) {
              sl.value = Math.round(d[busName] * 100);
              paintMixerFill(sl, MIXER_COLORS[busName] || '#8b949e');
            }
            if (vs) vs.textContent = Math.round(d[busName] * 100);
          }
        }
      }
      saveState();
    });
  }

  /** DJB2 string hash for non-numeric seed input */
  function djb2Hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return hash >>> 0;
  }

  // ══════════════════════════════════════════════════════════════════
  // Display Updates
  // ══════════════════════════════════════════════════════════════════

  function updateDisplay() {
    if (!panelEl) return;

    var playing = Audio.isPlaying();
    var state = playing ? Audio.getState() : null;

    // Play button
    var playBtn = panelEl.querySelector('.pmc-play-btn');
    if (playBtn) {
      playBtn.innerHTML = playing ? PixelIcons.icon('pause', 16) : PixelIcons.icon('play', 16);
      playBtn.title = playing ? 'Pause' : 'Play';
      playBtn.classList.toggle('pmc-playing', playing);
    }

    // Seed display
    var seedVal = panelEl.querySelector('.pmc-seed-value');
    if (seedVal) {
      var displaySeed = currentSeed;
      if (Fireplace && Fireplace.isActive()) {
        displaySeed = Fireplace.getSeed();
        currentSeed = displaySeed;
      }
      seedVal.textContent = displaySeed || '--';
      seedVal.title = 'Seed: ' + displaySeed;
    }

    // Now playing info
    var npScene = panelEl.querySelector('.pmc-np-scene');
    var npDetail = panelEl.querySelector('.pmc-np-detail');
    if (state && playing) {
      npScene.textContent = state.scene || '--';
      npDetail.textContent = state.tempo + ' bpm / ' + state.scale;
    } else {
      npScene.textContent = '--';
      npDetail.textContent = 'stopped';
    }

    // History list
    renderHistory();
  }

  function renderHistory() {
    if (!panelEl) return;
    var list = panelEl.querySelector('.pmc-history-list');
    if (!list) return;

    // Only re-render if content changed
    var key = seedHistory.map(function (h) { return h.seed; }).join(',');
    if (list.getAttribute('data-key') === key) return;
    list.setAttribute('data-key', key);

    list.innerHTML = '';

    if (seedHistory.length === 0) {
      list.innerHTML = '<div class="pmc-history-empty">no seeds yet</div>';
      return;
    }

    // Show last 8 entries
    var display = seedHistory.slice(0, 8);
    for (var i = 0; i < display.length; i++) {
      var item = display[i];
      var el = document.createElement('div');
      el.className = 'pmc-history-item';
      if (item.seed === currentSeed) {
        el.classList.add('pmc-history-active');
      }

      var seedSpan = document.createElement('span');
      seedSpan.className = 'pmc-history-seed';
      seedSpan.textContent = item.seed;

      var timeSpan = document.createElement('span');
      timeSpan.className = 'pmc-history-time';
      timeSpan.textContent = formatTimeAgo(item.timestamp);

      el.appendChild(seedSpan);
      el.appendChild(timeSpan);

      // Click to replay this seed
      (function (seed) {
        el.addEventListener('click', function () {
          startWithSeed(seed);
        });
      })(item.seed);

      list.appendChild(el);
    }
  }

  function formatTimeAgo(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
  }

  // ══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════

  // Listen for fireplace start to sync our seed display
  document.addEventListener('fireplace:started', function (e) {
    if (e.detail && e.detail.seed) {
      currentSeed = e.detail.seed;
      addToHistory(currentSeed);
    }
    updateDisplay();
  });

  document.addEventListener('fireplace:stopped', function () {
    updateDisplay();
  });

  function destroy() {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
    if (panelEl && panelEl.parentNode) {
      panelEl.parentNode.removeChild(panelEl);
    }
    panelEl = null;
  }

  // ══════════════════════════════════════════════════════════════════
  // CSS Injection
  // ══════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('pmc-styles')) return;

    var style = document.createElement('style');
    style.id = 'pmc-styles';
    style.textContent =
      /* Panel container */
      '.pmc-panel {' +
        'position: absolute;' +
        'bottom: 16px;' +
        'right: 16px;' +
        'width: 220px;' +
        'background: rgba(13, 17, 23, 0.88);' +
        'border: 1px solid rgba(240, 246, 252, 0.1);' +
        'border-radius: 8px;' +
        'backdrop-filter: blur(12px);' +
        '-webkit-backdrop-filter: blur(12px);' +
        'color: #c9d1d9;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
        'font-size: 11px;' +
        'z-index: 200;' +
        'overflow: hidden;' +
        'user-select: none;' +
        'transition: height 0.2s ease, opacity 0.2s ease;' +
      '}' +

      /* Header */
      '.pmc-header {' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: space-between;' +
        'padding: 6px 10px;' +
        'border-bottom: 1px solid rgba(240, 246, 252, 0.06);' +
      '}' +
      '.pmc-title {' +
        'font-size: 10px;' +
        'font-weight: 600;' +
        'text-transform: uppercase;' +
        'letter-spacing: 1.5px;' +
        'color: #8b949e;' +
      '}' +

      /* Collapse */
      '.pmc-panel[data-collapsed="true"] .pmc-body {' +
        'display: none;' +
      '}' +

      /* Body */
      '.pmc-body {' +
        'padding: 8px 10px 10px;' +
      '}' +

      /* Rows */
      '.pmc-row {' +
        'display: flex;' +
        'align-items: center;' +
        'gap: 6px;' +
        'margin-bottom: 8px;' +
      '}' +

      /* Buttons */
      '.pmc-btn {' +
        'background: rgba(240, 246, 252, 0.06);' +
        'border: 1px solid rgba(240, 246, 252, 0.1);' +
        'border-radius: 4px;' +
        'color: #c9d1d9;' +
        'cursor: pointer;' +
        'padding: 3px 6px;' +
        'font-size: 12px;' +
        'line-height: 1;' +
        'transition: background 0.15s, border-color 0.15s;' +
      '}' +
      '.pmc-btn:hover {' +
        'background: rgba(240, 246, 252, 0.12);' +
        'border-color: rgba(240, 246, 252, 0.2);' +
      '}' +

      /* Collapse button */
      '.pmc-collapse-btn {' +
        'border: none;' +
        'background: none;' +
        'padding: 2px 4px;' +
        'font-size: 10px;' +
        'color: #8b949e;' +
      '}' +
      '.pmc-collapse-btn:hover {' +
        'background: none;' +
        'color: #c9d1d9;' +
      '}' +

      /* Play button */
      '.pmc-play-btn {' +
        'width: 28px;' +
        'height: 28px;' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: center;' +
        'border-radius: 50%;' +
        'font-size: 11px;' +
        'flex-shrink: 0;' +
      '}' +
      '.pmc-play-btn.pmc-playing {' +
        'background: rgba(63, 185, 80, 0.15);' +
        'border-color: rgba(63, 185, 80, 0.3);' +
        'color: #3fb950;' +
      '}' +

      /* Seed display */
      '.pmc-seed-display {' +
        'flex: 1;' +
        'display: flex;' +
        'flex-direction: column;' +
        'min-width: 0;' +
        'overflow: hidden;' +
      '}' +
      '.pmc-seed-label {' +
        'font-size: 9px;' +
        'color: #8b949e;' +
        'text-transform: uppercase;' +
        'letter-spacing: 1px;' +
        'line-height: 1;' +
      '}' +
      '.pmc-seed-value {' +
        'font-size: 13px;' +
        'font-weight: 500;' +
        'color: #e6d5a8;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
        'white-space: nowrap;' +
        'overflow: hidden;' +
        'text-overflow: ellipsis;' +
        'line-height: 1.3;' +
      '}' +

      /* Randomize button */
      '.pmc-randomize-btn {' +
        'font-size: 14px;' +
        'padding: 4px 6px;' +
        'flex-shrink: 0;' +
      '}' +

      /* Volume row */
      '.pmc-volume-row {' +
        'gap: 4px;' +
      '}' +
      '.pmc-vol-icon {' +
        'font-size: 12px;' +
        'flex-shrink: 0;' +
        'width: 16px;' +
        'text-align: center;' +
      '}' +
      '.pmc-volume-slider {' +
        'flex: 1;' +
        '-webkit-appearance: none;' +
        'appearance: none;' +
        'height: 4px;' +
        'background: rgba(255, 255, 255, 0.15);' +
        'border-radius: 2px;' +
        'outline: none;' +
        'cursor: pointer;' +
      '}' +
      '.pmc-volume-slider::-webkit-slider-runnable-track {' +
        'height: 4px; border-radius: 2px;' +
        'background: rgba(255, 255, 255, 0.15);' +
      '}' +
      '.pmc-volume-slider::-webkit-slider-thumb {' +
        '-webkit-appearance: none;' +
        'appearance: none;' +
        'width: 14px;' +
        'height: 14px;' +
        'border-radius: 50%;' +
        'background: #ffffff;' +
        'border: none;' +
        'cursor: pointer;' +
        'margin-top: -5px;' +
        'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);' +
      '}' +
      '.pmc-volume-slider::-moz-range-track {' +
        'height: 4px; border-radius: 2px;' +
        'background: rgba(255, 255, 255, 0.15); border: none;' +
      '}' +
      '.pmc-volume-slider::-moz-range-thumb {' +
        'width: 14px;' +
        'height: 14px;' +
        'border-radius: 50%;' +
        'background: #ffffff;' +
        'border: none;' +
        'cursor: pointer;' +
        'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);' +
      '}' +
      '.pmc-volume-slider::-moz-range-progress {' +
        'height: 4px; border-radius: 2px;' +
        'background: #34d058;' +
      '}' +
      '.pmc-vol-value {' +
        'font-size: 10px;' +
        'color: #8b949e;' +
        'width: 22px;' +
        'text-align: right;' +
        'flex-shrink: 0;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
      '}' +

      /* Mixer section */
      '.pmc-mixer {' +
        'margin-bottom: 8px;' +
        'border: 1px solid rgba(240, 246, 252, 0.06);' +
        'border-radius: 4px;' +
        'overflow: hidden;' +
      '}' +
      '.pmc-mixer-header {' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: space-between;' +
        'padding: 4px 8px;' +
        'cursor: pointer;' +
        'background: rgba(240, 246, 252, 0.03);' +
        'transition: background 0.15s;' +
      '}' +
      '.pmc-mixer-header:hover {' +
        'background: rgba(240, 246, 252, 0.06);' +
      '}' +
      '.pmc-mixer-toggle {' +
        'font-size: 9px;' +
        'text-transform: uppercase;' +
        'letter-spacing: 1px;' +
        'color: #8b949e;' +
      '}' +
      '.pmc-mixer-arrow {' +
        'font-size: 9px;' +
        'color: #484f58;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
      '}' +
      '.pmc-mixer-body {' +
        'padding: 4px 6px 2px;' +
      '}' +
      '.pmc-mixer-row {' +
        'display: flex;' +
        'align-items: center;' +
        'gap: 4px;' +
        'margin-bottom: 4px;' +
      '}' +
      '.pmc-mixer-label {' +
        'font-size: 9px;' +
        'text-transform: uppercase;' +
        'letter-spacing: 0.5px;' +
        'color: #8b949e;' +
        'flex-shrink: 0;' +
        'width: 32px;' +
        'text-align: right;' +
      '}' +
      '.pmc-mixer-slider {' +
        'flex: 1;' +
        '-webkit-appearance: none;' +
        'appearance: none;' +
        'height: 3px;' +
        'background: rgba(255, 255, 255, 0.10);' +
        'border-radius: 2px;' +
        'outline: none;' +
        'cursor: pointer;' +
      '}' +
      '.pmc-mixer-slider::-webkit-slider-runnable-track {' +
        'height: 3px; border-radius: 2px;' +
        'background: transparent;' +
      '}' +
      '.pmc-mixer-slider::-webkit-slider-thumb {' +
        '-webkit-appearance: none;' +
        'appearance: none;' +
        'width: 10px;' +
        'height: 10px;' +
        'border-radius: 50%;' +
        'background: #c9d1d9;' +
        'border: none;' +
        'cursor: pointer;' +
        'margin-top: -3.5px;' +
        'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);' +
      '}' +
      '.pmc-mixer-slider::-moz-range-track {' +
        'height: 3px; border-radius: 2px;' +
        'background: rgba(255, 255, 255, 0.10); border: none;' +
      '}' +
      '.pmc-mixer-slider::-moz-range-thumb {' +
        'width: 10px;' +
        'height: 10px;' +
        'border-radius: 50%;' +
        'background: #c9d1d9;' +
        'border: none;' +
        'cursor: pointer;' +
        'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);' +
      '}' +
      '.pmc-mixer-val {' +
        'font-size: 9px;' +
        'color: #484f58;' +
        'width: 20px;' +
        'text-align: right;' +
        'flex-shrink: 0;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
      '}' +

      /* Seed input row */
      '.pmc-input-row {' +
        'gap: 4px;' +
      '}' +
      '.pmc-seed-input {' +
        'flex: 1;' +
        'background: rgba(240, 246, 252, 0.04);' +
        'border: 1px solid rgba(240, 246, 252, 0.1);' +
        'border-radius: 4px;' +
        'color: #c9d1d9;' +
        'font-size: 11px;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
        'padding: 4px 6px;' +
        'outline: none;' +
        'min-width: 0;' +
      '}' +
      '.pmc-seed-input::placeholder {' +
        'color: #484f58;' +
      '}' +
      '.pmc-seed-input:focus {' +
        'border-color: rgba(88, 166, 255, 0.4);' +
      '}' +
      '.pmc-go-btn {' +
        'font-size: 10px;' +
        'padding: 4px 8px;' +
        'flex-shrink: 0;' +
      '}' +

      /* History */
      '.pmc-history {' +
        'margin-bottom: 6px;' +
      '}' +
      '.pmc-history-label {' +
        'font-size: 9px;' +
        'text-transform: uppercase;' +
        'letter-spacing: 1px;' +
        'color: #8b949e;' +
        'margin-bottom: 4px;' +
      '}' +
      '.pmc-history-list {' +
        'max-height: 120px;' +
        'overflow-y: auto;' +
        'scrollbar-width: thin;' +
        'scrollbar-color: rgba(240, 246, 252, 0.08) transparent;' +
      '}' +
      '.pmc-history-list::-webkit-scrollbar {' +
        'width: 4px;' +
      '}' +
      '.pmc-history-list::-webkit-scrollbar-thumb {' +
        'background: rgba(240, 246, 252, 0.08);' +
        'border-radius: 2px;' +
      '}' +
      '.pmc-history-item {' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: space-between;' +
        'padding: 3px 6px;' +
        'border-radius: 3px;' +
        'cursor: pointer;' +
        'transition: background 0.1s;' +
      '}' +
      '.pmc-history-item:hover {' +
        'background: rgba(240, 246, 252, 0.06);' +
      '}' +
      '.pmc-history-active {' +
        'background: rgba(230, 213, 168, 0.08);' +
      '}' +
      '.pmc-history-active .pmc-history-seed {' +
        'color: #e6d5a8;' +
      '}' +
      '.pmc-history-seed {' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
        'font-size: 11px;' +
        'color: #c9d1d9;' +
      '}' +
      '.pmc-history-time {' +
        'font-size: 9px;' +
        'color: #484f58;' +
      '}' +
      '.pmc-history-empty {' +
        'color: #484f58;' +
        'font-style: italic;' +
        'padding: 2px 6px;' +
        'font-size: 10px;' +
      '}' +

      /* Now playing */
      '.pmc-now-playing {' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: space-between;' +
        'padding-top: 6px;' +
        'border-top: 1px solid rgba(240, 246, 252, 0.06);' +
      '}' +
      '.pmc-np-scene {' +
        'font-size: 10px;' +
        'color: #e6d5a8;' +
        'font-weight: 500;' +
      '}' +
      '.pmc-np-detail {' +
        'font-size: 9px;' +
        'color: #8b949e;' +
      '}';

    document.head.appendChild(style);
  }

  // ══════════════════════════════════════════════════════════════════
  // Initialization
  // ══════════════════════════════════════════════════════════════════

  function init() {
    injectStyles();
    createPanel();
  }

  // Auto-init when the pixel view becomes visible
  // The container may not exist yet at script load, so observe
  function waitForContainer() {
    var container = document.getElementById('pixel-canvas-container');
    if (container) {
      init();
      return;
    }
    // Poll briefly — the container is created by pixel-agents.html
    // which is loaded before this script
    var attempts = 0;
    var poller = setInterval(function () {
      container = document.getElementById('pixel-canvas-container');
      if (container || attempts > 20) {
        clearInterval(poller);
        if (container) init();
      }
      attempts++;
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForContainer);
  } else {
    waitForContainer();
  }

  // ══════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════

  function hide() {
    if (panelEl) panelEl.style.display = 'none';
  }

  function show() {
    if (panelEl) panelEl.style.display = '';
  }

  window.PixelMusicControls = {
    ready: true,
    getCurrentSeed: function () { return currentSeed; },
    getHistory: function () { return seedHistory.slice(); },
    playSeed: function (seed) { startWithSeed(seed); },
    destroy: destroy,
    hide: hide,
    show: show,
  };

})();
