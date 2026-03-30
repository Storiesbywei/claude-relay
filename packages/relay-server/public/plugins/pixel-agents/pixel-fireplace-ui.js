// === Pixel Fireplace UI — Fullscreen ambient screensaver overlay ===
// Creates an immersive overlay with vignette, film grain, corner info,
// narrative text, and a frosted-glass control pill.  Hides all dashboard
// chrome so it feels like a standalone ambient app (Endel meets After Dark).
// Depends on: PixelFireplaceMode, PixelAudioEngine, PixelMusicControls, PixelIcons
// Exposes: window.PixelFireplaceUI

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 1. Dependencies
  // ══════════════════════════════════════════════════════════════════

  var Fireplace = window.PixelFireplaceMode;
  var Audio     = window.PixelAudioEngine;
  var Music     = window.PixelMusicControls;
  var Icons     = window.PixelIcons;

  // ══════════════════════════════════════════════════════════════════
  // 2. State
  // ══════════════════════════════════════════════════════════════════

  var active          = false;
  var overlayEl       = null;
  var canvasOrigParent = null;
  var canvasEl        = null;
  var idleTimer       = null;
  var controlsVisible = true;
  var elapsedTimer    = null;
  var narrativeTimer  = null;
  var narrativeEl     = null;
  var scenePickerOpen = false;

  // Sleep timer state
  var sleepTimerMs       = 0;       // total duration in ms (0 = off)
  var sleepTimerStart    = 0;       // Date.now() when timer started
  var sleepTimerInterval = null;    // setInterval handle for display updates
  var sleepFading        = false;   // true during the 30s fade-out
  var sleepFadeInterval  = null;    // setInterval for volume fade
  var sleepOrigVolume    = 0.5;     // volume before fade started

  var SLEEP_STEPS = [0, 15, 30, 60, 120]; // minutes: OFF, 15m, 30m, 1h, 2h
  var sleepStepIndex = 0;

  /** Display-friendly scene names */
  var SCENE_LABELS = {
    workshop: 'Workshop',
    library: 'Library',
    garden: 'Garden',
    waterfront: 'Waterfront',
    cave: 'Cave',
    winterLodge: 'Winter Lodge',
    harvestField: 'Harvest Field',
    cliffOverlook: 'Cliff Overlook',
  };

  /** Representative color dot per scene (evokes the scene palette) */
  var SCENE_DOTS = {
    workshop: '#e6d5a8',
    library: '#a67c52',
    garden: '#3fb950',
    waterfront: '#58a6ff',
    cave: '#8b5cf6',
    winterLodge: '#f0f6fc',
    harvestField: '#d2a038',
    cliffOverlook: '#f97583',
  };

  /** Ordered list of scene keys (matches SCENE_POOL in pixel-fireplace.js) */
  var SCENE_KEYS = [
    'workshop', 'library', 'garden', 'waterfront',
    'cave', 'winterLodge', 'harvestField', 'cliffOverlook',
  ];

  var IDLE_TIMEOUT    = 3000;   // ms before cursor hides
  var CONTROLS_FADE_IN  = 300; // ms
  var CONTROLS_FADE_OUT = 500; // ms
  var NARRATIVE_FADE    = 800; // ms

  /** Paint volume slider filled portion via linear-gradient (webkit compat) */
  function paintVolFill(slider) {
    var pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = 'linear-gradient(to right, #e6d5a8 0%, #e6d5a8 ' + pct + '%, rgba(255,255,255,0.15) ' + pct + '%, rgba(255,255,255,0.15) 100%)';
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. CSS Injection
  // ══════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('fp-ui-styles')) return;

    var style = document.createElement('style');
    style.id = 'fp-ui-styles';
    style.textContent =

      // --- Overlay ---
      '#fireplace-overlay {' +
        'position: fixed; inset: 0; z-index: 9999;' +
        'background: #0a0e14;' +
        'display: flex; align-items: center; justify-content: center;' +
        'overflow: hidden;' +
      '}' +
      '#fireplace-overlay canvas {' +
        'display: block;' +
        'image-rendering: pixelated;' +
        'image-rendering: crisp-edges;' +
        'max-width: 100vw;' +
        'max-height: 100vh;' +
        'width: auto;' +
        'height: auto;' +
        'object-fit: contain;' +
      '}' +

      // --- Vignette ---
      '.fp-vignette {' +
        'position: absolute; inset: 0; pointer-events: none; z-index: 10;' +
        'background: radial-gradient(ellipse 70% 60% at 50% 50%, transparent 50%, rgba(0,0,0,0.45) 100%);' +
      '}' +

      // --- Film Grain ---
      '.fp-grain {' +
        'position: absolute; inset: 0; pointer-events: none; z-index: 11;' +
        'opacity: 0.03; mix-blend-mode: overlay;' +
        'background-image: url("data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
            '<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch"/></filter>' +
            '<rect width="100%" height="100%" filter="url(#g)"/></svg>'
          ) + '");' +
        'animation: fp-grain-shift 0.4s steps(2) infinite;' +
      '}' +
      '@keyframes fp-grain-shift {' +
        '0%   { transform: translate(0, 0); }' +
        '50%  { transform: translate(-2%, -2%); }' +
        '100% { transform: translate(2%, 1%); }' +
      '}' +

      // --- Corner info (top-left, top-right) ---
      '.fp-corner-tl, .fp-corner-tr {' +
        'position: absolute; top: 24px; z-index: 20;' +
        'color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
        'font-size: 12px; line-height: 1.5;' +
        'opacity: 0.4;' +
        'transition: opacity 0.8s ease;' +
        'pointer-events: none;' +
      '}' +
      '.fp-corner-tl { left: 28px; }' +
      '.fp-corner-tr { right: 28px; text-align: right; }' +
      '.fp-corner-tl.fp-hidden, .fp-corner-tr.fp-hidden { opacity: 0; }' +

      '.fp-corner-label {' +
        'font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; color: #8b949e;' +
      '}' +
      '.fp-corner-value {' +
        'font-size: 13px; color: #e6d5a8;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
      '}' +

      // --- Narrative text ---
      '.fp-narrative {' +
        'position: absolute; bottom: 100px; left: 50%; transform: translateX(-50%);' +
        'z-index: 20; pointer-events: none;' +
        'max-width: min(640px, 80vw); text-align: center;' +
        'font-family: Georgia, "Times New Roman", serif;' +
        'font-size: 14px; font-style: italic; line-height: 1.6;' +
        'color: #e6d5a8;' +
        'opacity: 0; transition: opacity ' + NARRATIVE_FADE + 'ms ease;' +
      '}' +
      '.fp-narrative.fp-visible { opacity: 1; }' +
      '.fp-narrative.fp-transition {' +
        'font-size: 16px; letter-spacing: 0.5px;' +
      '}' +

      // --- Controls pill ---
      '.fp-controls {' +
        'position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%) translateY(0);' +
        'z-index: 30;' +
        'display: flex; align-items: center; gap: 12px;' +
        'max-width: 640px; width: auto;' +
        'height: 48px; padding: 0 20px;' +
        'background: rgba(13, 17, 23, 0.6);' +
        'backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);' +
        'border: 1px solid rgba(240, 246, 252, 0.08);' +
        'border-radius: 24px;' +
        'color: #c9d1d9;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
        'font-size: 12px;' +
        'user-select: none;' +
        'opacity: 1;' +
        'transition: opacity ' + CONTROLS_FADE_IN + 'ms ease, transform ' + CONTROLS_FADE_IN + 'ms ease;' +
      '}' +
      '.fp-controls.fp-hidden {' +
        'opacity: 0; transform: translateX(-50%) translateY(8px);' +
        'pointer-events: none;' +
        'transition: opacity ' + CONTROLS_FADE_OUT + 'ms ease, transform ' + CONTROLS_FADE_OUT + 'ms ease;' +
      '}' +

      // Touch device: taller pill
      '@media (pointer: coarse) {' +
        '.fp-controls { height: 56px; padding: 0 24px; gap: 14px; }' +
      '}' +

      // --- Control elements ---
      '.fp-scene-name {' +
        'font-size: 11px; color: #e6d5a8; font-weight: 500;' +
        'white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis;' +
        'max-width: 100px;' +
      '}' +

      '.fp-ctrl-btn {' +
        'background: none; border: none; color: #c9d1d9; cursor: pointer;' +
        'padding: 4px; border-radius: 50%;' +
        'display: flex; align-items: center; justify-content: center;' +
        'transition: color 0.15s, background 0.15s;' +
        'flex-shrink: 0;' +
      '}' +
      '.fp-ctrl-btn:hover { color: #f0f6fc; background: rgba(240, 246, 252, 0.08); }' +
      '.fp-ctrl-btn.fp-playing { color: #3fb950; }' +

      '.fp-seed-display {' +
        'font-size: 10px; color: #8b949e;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
        'white-space: nowrap;' +
      '}' +

      '.fp-divider {' +
        'width: 1px; height: 20px; background: rgba(240, 246, 252, 0.1); flex-shrink: 0;' +
      '}' +

      // Volume slider
      '.fp-vol-group {' +
        'display: flex; align-items: center; gap: 6px; flex-shrink: 0;' +
      '}' +
      '.fp-vol-slider {' +
        '-webkit-appearance: none; appearance: none;' +
        'width: 64px; height: 4px;' +
        'background: rgba(255, 255, 255, 0.15); border-radius: 2px;' +
        'outline: none; cursor: pointer;' +
      '}' +
      '.fp-vol-slider::-webkit-slider-runnable-track {' +
        'height: 4px; border-radius: 2px;' +
        'background: rgba(255, 255, 255, 0.15);' +
      '}' +
      '.fp-vol-slider::-webkit-slider-thumb {' +
        '-webkit-appearance: none; appearance: none;' +
        'width: 14px; height: 14px; border-radius: 50%;' +
        'background: #ffffff; border: none; cursor: pointer;' +
        'margin-top: -5px;' +
        'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);' +
      '}' +
      '.fp-vol-slider::-moz-range-track {' +
        'height: 4px; border-radius: 2px;' +
        'background: rgba(255, 255, 255, 0.15); border: none;' +
      '}' +
      '.fp-vol-slider::-moz-range-thumb {' +
        'width: 14px; height: 14px; border-radius: 50%;' +
        'background: #ffffff; border: none; cursor: pointer;' +
        'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);' +
      '}' +
      '.fp-vol-slider::-moz-range-progress {' +
        'height: 4px; border-radius: 2px;' +
        'background: #e6d5a8;' +
      '}' +

      // Hiss cycle button
      '.fp-hiss-btn {' +
        'font-size: 10px; color: #e6d5a8; padding: 4px 6px;' +
        'min-width: 28px; text-align: center;' +
        'transition: color 0.15s, background 0.15s;' +
      '}' +
      '.fp-hiss-dots {' +
        'font-size: 8px; letter-spacing: 1px;' +
      '}' +

      // Sleep timer
      '.fp-sleep-btn {' +
        'display: flex; align-items: center; gap: 4px;' +
        'font-size: 10px; color: #484f58; padding: 4px 6px;' +
        'min-width: 20px; text-align: center;' +
        'transition: color 0.15s, background 0.15s;' +
      '}' +
      '.fp-sleep-btn.fp-sleep-active { color: #58a6ff; }' +
      '.fp-sleep-remaining {' +
        'font-size: 10px; color: #58a6ff;' +
        'font-family: "SF Mono", "Fira Code", monospace;' +
        'white-space: nowrap;' +
      '}' +

      // Share button + toast
      '.fp-share-btn {' +
        'font-size: 10px; color: #8b949e; padding: 4px 6px;' +
        'transition: color 0.15s, background 0.15s;' +
      '}' +
      '.fp-share-toast {' +
        'position: absolute; bottom: 90px; left: 50%; transform: translateX(-50%);' +
        'background: rgba(13, 17, 23, 0.85); color: #3fb950;' +
        'padding: 6px 16px; border-radius: 12px;' +
        'font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
        'pointer-events: none; opacity: 0; transition: opacity 0.3s ease;' +
        'z-index: 31; white-space: nowrap;' +
      '}' +
      '.fp-share-toast.fp-toast-show { opacity: 1; }' +

      // --- Scene picker dropdown ---
      '.fp-scene-name {' +
        'cursor: pointer; position: relative;' +
      '}' +
      '.fp-scene-name:hover { color: #f0f6fc; }' +

      '.fp-scene-lock {' +
        'font-size: 9px; margin-left: 3px; vertical-align: middle; opacity: 0.7;' +
      '}' +

      '.fp-scene-picker {' +
        'position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%);' +
        'z-index: 40;' +
        'min-width: 180px;' +
        'background: rgba(13, 17, 23, 0.85);' +
        'backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);' +
        'border: 1px solid rgba(240, 246, 252, 0.1);' +
        'border-radius: 12px;' +
        'padding: 6px 0;' +
        'opacity: 0; transform: translateX(-50%) translateY(8px);' +
        'transition: opacity 200ms ease, transform 200ms ease;' +
        'pointer-events: none;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
        'font-size: 12px;' +
        'user-select: none;' +
      '}' +
      '.fp-scene-picker.fp-picker-open {' +
        'opacity: 1; transform: translateX(-50%) translateY(0);' +
        'pointer-events: auto;' +
      '}' +

      '.fp-picker-item {' +
        'display: flex; align-items: center; gap: 8px;' +
        'padding: 8px 16px; cursor: pointer; color: #c9d1d9;' +
        'transition: background 0.12s, color 0.12s;' +
        'white-space: nowrap; min-height: 44px; box-sizing: border-box;' +
      '}' +
      '.fp-picker-item:hover { background: rgba(240, 246, 252, 0.06); color: #f0f6fc; }' +
      '.fp-picker-item.fp-picker-active { color: #e6d5a8; }' +
      '.fp-picker-item.fp-picker-locked { color: #e6d5a8; }' +

      '.fp-picker-dot {' +
        'width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;' +
      '}' +
      '.fp-picker-label { flex: 1; }' +
      '.fp-picker-lock-icon {' +
        'font-size: 10px; opacity: 0.6; flex-shrink: 0;' +
      '}' +

      '.fp-picker-sep {' +
        'height: 1px; margin: 4px 12px;' +
        'background: rgba(240, 246, 252, 0.08);' +
      '}' +

      // Touch: ensure 44px targets
      '@media (pointer: coarse) {' +
        '.fp-picker-item { min-height: 48px; padding: 10px 16px; }' +
      '}' +

      // --- Cursor hiding ---
      '#fireplace-overlay.fp-cursor-hidden { cursor: none; }' +

      // --- Responsive: small screens ---
      '@media (max-width: 600px) {' +
        '.fp-controls { gap: 8px; padding: 0 12px; max-width: 95vw; }' +
        '.fp-scene-name { max-width: 60px; font-size: 10px; }' +
        '.fp-seed-display { display: none; }' +
        '.fp-share-btn { display: none; }' +
        '.fp-vol-slider { width: 48px; }' +
        '.fp-corner-tl, .fp-corner-tr { font-size: 10px; top: 12px; }' +
        '.fp-corner-tl { left: 12px; }' +
        '.fp-corner-tr { right: 12px; }' +
        '.fp-narrative { font-size: 12px; bottom: 80px; max-width: 90vw; }' +
      '}' +

      // --- Responsive: landscape with short viewport (phones sideways) ---
      '@media (orientation: landscape) and (max-height: 500px) {' +
        '.fp-controls { height: 36px; padding: 0 14px; gap: 8px; bottom: 12px; font-size: 11px; }' +
        '.fp-corner-tl, .fp-corner-tr { font-size: 9px; top: 8px; }' +
        '.fp-corner-tl { left: 12px; }' +
        '.fp-corner-tr { right: 12px; }' +
        '.fp-corner-value { font-size: 11px; }' +
        '.fp-narrative { font-size: 11px; bottom: 56px; }' +
      '}' +

      '';

    document.head.appendChild(style);
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. Overlay Construction
  // ══════════════════════════════════════════════════════════════════

  function buildOverlay() {
    var el = document.createElement('div');
    el.id = 'fireplace-overlay';

    el.innerHTML =
      '<div class="fp-vignette"></div>' +
      '<div class="fp-grain"></div>' +

      // Top-left corner: day phase + season
      '<div class="fp-corner-tl">' +
        '<div class="fp-corner-label">phase</div>' +
        '<div class="fp-corner-value fp-phase-value">--</div>' +
        '<div class="fp-corner-label" style="margin-top:6px">season</div>' +
        '<div class="fp-corner-value fp-season-value">--</div>' +
      '</div>' +

      // Top-right corner: seed + elapsed
      '<div class="fp-corner-tr">' +
        '<div class="fp-corner-label">seed</div>' +
        '<div class="fp-corner-value fp-seed-corner">--</div>' +
        '<div class="fp-corner-label" style="margin-top:6px">elapsed</div>' +
        '<div class="fp-corner-value fp-elapsed-value">0:00</div>' +
      '</div>' +

      // Narrative text
      '<div class="fp-narrative"></div>' +

      // Scene picker dropdown (hidden by default, appears above controls)
      '<div class="fp-scene-picker"></div>' +

      // Share toast (positioned above controls)
      '<div class="fp-share-toast">Copied!</div>' +

      // Controls pill
      '<div class="fp-controls">' +
        '<span class="fp-scene-name" title="Click to choose scene">--</span>' +
        '<div class="fp-divider"></div>' +
        '<button class="fp-ctrl-btn fp-play-btn" title="Play / Pause">' + (Icons ? Icons.icon('play', 18) : '&#9654;') + '</button>' +
        '<span class="fp-seed-display">seed: --</span>' +
        '<button class="fp-ctrl-btn fp-share-btn" title="Copy shareable URL">' + (Icons ? Icons.icon('link', 14) : '&#128279;') + '</button>' +
        '<button class="fp-ctrl-btn fp-dice-btn" title="New random seed">' + (Icons ? Icons.icon('dice-5', 16) : '&#127922;') + '</button>' +
        '<div class="fp-divider"></div>' +
        '<div class="fp-vol-group">' +
          '<span class="fp-vol-icon">' + (Icons ? Icons.icon('volume-2', 14) : '&#128266;') + '</span>' +
          '<input type="range" class="fp-vol-slider" min="0" max="1" step="0.01" value="0.5" />' +
        '</div>' +
        '<button class="fp-ctrl-btn fp-hiss-btn" title="Vinyl hiss: medium">' +
          '<span class="fp-hiss-dots">&#9679;&#9679;</span>' +
        '</button>' +
        '<div class="fp-divider"></div>' +
        '<button class="fp-ctrl-btn fp-sleep-btn" title="Sleep timer: off">' +
          (Icons ? Icons.icon('clock', 14) : '&#128336;') +
          '<span class="fp-sleep-remaining"></span>' +
        '</button>' +
        '<div class="fp-divider"></div>' +
        '<button class="fp-ctrl-btn fp-close-btn" title="Exit fireplace">' + (Icons ? Icons.icon('x', 18) : '&#10005;') + '</button>' +
      '</div>';

    return el;
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. Activate / Deactivate
  // ══════════════════════════════════════════════════════════════════

  function activate() {
    if (active) return;
    active = true;

    injectStyles();

    // Build overlay
    overlayEl = buildOverlay();
    document.body.appendChild(overlayEl);

    // Hide dashboard chrome
    hideDashboardChrome();

    // Hide the music controls panel (it lives inside #pixel-canvas-container)
    if (Music && Music.hide) {
      Music.hide();
    }

    // Move the pixel canvas into the overlay
    moveCanvasToOverlay();

    // Wire controls
    wireControlEvents();

    // Start idle-cursor timer
    resetIdleTimer();
    overlayEl.addEventListener('mousemove', onMouseMove);
    overlayEl.addEventListener('touchstart', onTouchStart, { passive: true });

    // Listen for fireplace events
    document.addEventListener('fireplace:narrative', onNarrative);
    document.addEventListener('fireplace:goldenHour', onGoldenHour);

    // Start elapsed time updater
    elapsedTimer = setInterval(updateCornerInfo, 1000);
    updateCornerInfo();
    updateControlsState();

    // Restore volume and hiss level from saved state
    restoreVolume();
    restoreHissLevel();
  }

  function deactivate() {
    if (!active) return;
    active = false;

    // Cancel sleep timer on deactivate
    cancelSleepTimer();

    // Clear timers
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (narrativeTimer) { clearTimeout(narrativeTimer); narrativeTimer = null; }

    // Remove event listeners
    document.removeEventListener('fireplace:narrative', onNarrative);
    document.removeEventListener('fireplace:goldenHour', onGoldenHour);

    // Restore canvas to original position
    restoreCanvas();

    // Show dashboard chrome
    showDashboardChrome();

    // Show the music controls panel
    if (Music && Music.show) {
      Music.show();
    }

    // Remove overlay
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
    narrativeEl = null;
    controlsVisible = true;
  }

  function isActiveState() {
    return active;
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. Canvas Management
  // ══════════════════════════════════════════════════════════════════

  function moveCanvasToOverlay() {
    var container = document.getElementById('pixel-canvas-container');
    if (!container) return;

    canvasEl = container.querySelector('canvas');
    if (!canvasEl) return;

    canvasOrigParent = canvasEl.parentNode;

    // Insert canvas as the first child of overlay (behind vignette/grain)
    overlayEl.insertBefore(canvasEl, overlayEl.firstChild);
  }

  function restoreCanvas() {
    if (canvasEl && canvasOrigParent) {
      canvasOrigParent.appendChild(canvasEl);
    }
    canvasEl = null;
    canvasOrigParent = null;
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. Dashboard Chrome Hide/Show
  // ══════════════════════════════════════════════════════════════════

  var hiddenElements = [];

  function hideDashboardChrome() {
    var selectors = ['.topbar', '#session-bar', '.bottombar', '#pixel-sidebar'];
    hiddenElements = [];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        hiddenElements.push({ el: el, prev: el.style.display });
        el.style.display = 'none';
      }
    }
  }

  function showDashboardChrome() {
    for (var i = 0; i < hiddenElements.length; i++) {
      var item = hiddenElements[i];
      item.el.style.display = item.prev;
    }
    hiddenElements = [];
  }

  // ══════════════════════════════════════════════════════════════════
  // 8. Controls Wiring
  // ══════════════════════════════════════════════════════════════════

  function wireControlEvents() {
    if (!overlayEl) return;

    // Play/Pause
    var playBtn = overlayEl.querySelector('.fp-play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (Audio && Audio.isPlaying()) {
          Audio.stop();
        } else if (Audio && Fireplace) {
          Audio.start(Fireplace.getSeed());
        }
        updateControlsState();
      });
    }

    // Scene name click — toggle scene picker
    var sceneNameEl = overlayEl.querySelector('.fp-scene-name');
    if (sceneNameEl) {
      sceneNameEl.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleScenePicker();
      });
    }

    // Dice (randomize)
    var diceBtn = overlayEl.querySelector('.fp-dice-btn');
    if (diceBtn) {
      diceBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var newSeed = Math.floor(Math.random() * 2147483647);
        // Restart both fireplace + audio with new seed
        if (Fireplace && Fireplace.isActive()) {
          Fireplace.stop();
          setTimeout(function () {
            Fireplace.start(newSeed);
            setTimeout(function () {
              if (Audio) {
                try { Audio.start(newSeed); } catch (_) { /* skip */ }
              }
              updateControlsState();
              updateCornerInfo();
            }, 100);
          }, 900);
        }
      });
    }

    // Volume slider
    var volSlider = overlayEl.querySelector('.fp-vol-slider');
    if (volSlider) {
      paintVolFill(volSlider);

      volSlider.addEventListener('input', function (e) {
        e.stopPropagation();
        paintVolFill(this);
        if (Audio && Audio.setVolume) {
          Audio.setVolume(parseFloat(this.value));
        }
        // Persist to music controls storage
        try {
          var saved = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
          saved.volume = parseFloat(this.value);
          localStorage.setItem('pixelMusicControls', JSON.stringify(saved));
        } catch (_) { /* skip */ }
      });
      // Prevent events from propagating
      volSlider.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      volSlider.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
    }

    // Hiss cycle button — cycles off / low / med / high
    var hissBtn = overlayEl.querySelector('.fp-hiss-btn');
    if (hissBtn) {
      // Hiss level steps: off=0, low=0.33, med=0.5(default), high=1.0
      var hissSteps = [
        { level: 0,    dots: '\u25CB',             label: 'off' },
        { level: 0.33, dots: '\u25CF',             label: 'low' },
        { level: 0.66, dots: '\u25CF\u25CF',       label: 'med' },
        { level: 1.0,  dots: '\u25CF\u25CF\u25CF', label: 'high' },
      ];
      var hissIndex = 2; // start at med (0.66 ~ default 0.5 legacy)

      // Restore from saved state
      try {
        var savedHiss = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
        if (typeof savedHiss.hissLevel === 'number') {
          // Find closest step
          var closest = 0;
          var closestDist = 999;
          for (var hi = 0; hi < hissSteps.length; hi++) {
            var dist = Math.abs(hissSteps[hi].level - savedHiss.hissLevel);
            if (dist < closestDist) { closestDist = dist; closest = hi; }
          }
          hissIndex = closest;
        }
      } catch (_) { /* skip */ }

      function updateHissBtn() {
        var step = hissSteps[hissIndex];
        var dotsEl = hissBtn.querySelector('.fp-hiss-dots');
        if (dotsEl) dotsEl.textContent = step.dots;
        hissBtn.title = 'Vinyl hiss: ' + step.label;
        hissBtn.style.color = step.level === 0 ? '#484f58' : '#e6d5a8';
      }
      updateHissBtn();

      hissBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        hissIndex = (hissIndex + 1) % hissSteps.length;
        var step = hissSteps[hissIndex];
        if (Audio && Audio.setHissLevel) Audio.setHissLevel(step.level);
        // Persist
        try {
          var saved = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
          saved.hissLevel = step.level;
          localStorage.setItem('pixelMusicControls', JSON.stringify(saved));
        } catch (_) { /* skip */ }
        updateHissBtn();
      });
    }

    // Share button — copy shareable URL to clipboard
    var shareBtn = overlayEl.querySelector('.fp-share-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyShareableURL();
      });
    }

    // Also make seed display tappable to copy URL
    var seedDisplayEl = overlayEl.querySelector('.fp-seed-display');
    if (seedDisplayEl) {
      seedDisplayEl.style.cursor = 'pointer';
      seedDisplayEl.title = 'Click to copy shareable URL';
      seedDisplayEl.addEventListener('click', function (e) {
        e.stopPropagation();
        copyShareableURL();
      });
    }

    // Sleep timer button — cycles through OFF / 15m / 30m / 1h / 2h / OFF
    var sleepBtn = overlayEl.querySelector('.fp-sleep-btn');
    if (sleepBtn) {
      sleepBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        sleepStepIndex = (sleepStepIndex + 1) % SLEEP_STEPS.length;
        var minutes = SLEEP_STEPS[sleepStepIndex];

        if (minutes === 0) {
          cancelSleepTimer();
        } else {
          startSleepTimer(minutes);
        }

        updateSleepBtn();
      });
    }

    // Close button
    var closeBtn = overlayEl.querySelector('.fp-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (Fireplace && Fireplace.isActive()) {
          Fireplace.stop();
        }
      });
    }

    // Prevent all control clicks from propagating to overlay
    var controls = overlayEl.querySelector('.fp-controls');
    if (controls) {
      controls.addEventListener('click', function (e) { e.stopPropagation(); });
      controls.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    }

    // Keyboard: Escape closes picker first, then exits. Space toggles play.
    overlayEl._keyHandler = function (e) {
      if (!active) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (scenePickerOpen) {
          closeScenePicker();
          return;
        }
        if (Fireplace && Fireplace.isActive()) {
          Fireplace.stop();
        }
      } else if (e.key === ' ') {
        e.preventDefault();
        if (Audio && Audio.isPlaying()) {
          Audio.stop();
        } else if (Audio && Fireplace) {
          Audio.start(Fireplace.getSeed());
        }
        updateControlsState();
      }
    };
    document.addEventListener('keydown', overlayEl._keyHandler);
  }

  // ══════════════════════════════════════════════════════════════════
  // 9. Idle Cursor / Controls Fade
  // ══════════════════════════════════════════════════════════════════

  function onMouseMove() {
    showControls();
    resetIdleTimer();
  }

  function onTouchStart(e) {
    // If scene picker is open, close it on tap outside
    if (scenePickerOpen && overlayEl) {
      var picker = overlayEl.querySelector('.fp-scene-picker');
      var sceneNameBtn = overlayEl.querySelector('.fp-scene-name');
      if (picker && !picker.contains(e.target) && sceneNameBtn && !sceneNameBtn.contains(e.target)) {
        closeScenePicker();
        return;
      }
    }
    // Single tap toggles visibility
    if (controlsVisible) {
      hideControls();
    } else {
      showControls();
      resetIdleTimer();
    }
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      hideControls();
    }, IDLE_TIMEOUT);
  }

  function showControls() {
    if (!overlayEl) return;
    controlsVisible = true;

    overlayEl.classList.remove('fp-cursor-hidden');

    var controls = overlayEl.querySelector('.fp-controls');
    if (controls) controls.classList.remove('fp-hidden');

    var tl = overlayEl.querySelector('.fp-corner-tl');
    var tr = overlayEl.querySelector('.fp-corner-tr');
    if (tl) tl.classList.remove('fp-hidden');
    if (tr) tr.classList.remove('fp-hidden');
  }

  function hideControls() {
    if (!overlayEl) return;
    controlsVisible = false;

    // Close scene picker when controls hide
    if (scenePickerOpen) closeScenePicker();

    overlayEl.classList.add('fp-cursor-hidden');

    var controls = overlayEl.querySelector('.fp-controls');
    if (controls) controls.classList.add('fp-hidden');

    var tl = overlayEl.querySelector('.fp-corner-tl');
    var tr = overlayEl.querySelector('.fp-corner-tr');
    if (tl) tl.classList.add('fp-hidden');
    if (tr) tr.classList.add('fp-hidden');
  }

  // ══════════════════════════════════════════════════════════════════
  // 10. Corner Info Updates
  // ══════════════════════════════════════════════════════════════════

  function updateCornerInfo() {
    if (!overlayEl || !active) return;

    // Day phase + season
    var phaseEl = overlayEl.querySelector('.fp-phase-value');
    var seasonEl = overlayEl.querySelector('.fp-season-value');
    if (phaseEl && window.__pixelTimeOverride) {
      phaseEl.textContent = window.__pixelTimeOverride.time || '--';
    }
    if (seasonEl && window.__pixelTimeOverride) {
      seasonEl.textContent = window.__pixelTimeOverride.season || '--';
    }

    // Seed
    var seedCorner = overlayEl.querySelector('.fp-seed-corner');
    if (seedCorner && Fireplace) {
      seedCorner.textContent = Fireplace.getSeed() || '--';
    }

    // Elapsed
    var elapsedEl = overlayEl.querySelector('.fp-elapsed-value');
    if (elapsedEl && Fireplace) {
      var ms = Fireplace.getElapsed();
      var totalSec = Math.floor(ms / 1000);
      var min = Math.floor(totalSec / 60);
      var sec = totalSec % 60;
      elapsedEl.textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
    }

    // Scene name in controls — show display label + lock icon when locked
    var sceneEl = overlayEl.querySelector('.fp-scene-name');
    if (sceneEl && Fireplace) {
      var locked = Fireplace.getLockedScene ? Fireplace.getLockedScene() : null;
      var displayScene;
      if (locked) {
        displayScene = SCENE_LABELS[locked] || locked;
      } else {
        var act = Fireplace.getCurrentAct();
        displayScene = act ? (SCENE_LABELS[act.scene] || act.scene) : '--';
      }
      var lockHtml = locked ? '<span class="fp-scene-lock">\uD83D\uDD12</span>' : '';
      sceneEl.innerHTML = displayScene + lockHtml;
    }

    // Seed in controls
    var seedDisplay = overlayEl.querySelector('.fp-seed-display');
    if (seedDisplay && Fireplace) {
      seedDisplay.textContent = 'seed: ' + (Fireplace.getSeed() || '--');
    }
  }

  function updateControlsState() {
    if (!overlayEl) return;

    var playBtn = overlayEl.querySelector('.fp-play-btn');
    if (playBtn && Icons) {
      var playing = Audio && Audio.isPlaying();
      playBtn.innerHTML = playing ? Icons.icon('pause', 18) : Icons.icon('play', 18);
      playBtn.title = playing ? 'Pause audio' : 'Play audio';
      if (playing) {
        playBtn.classList.add('fp-playing');
      } else {
        playBtn.classList.remove('fp-playing');
      }
    }
  }

  function restoreVolume() {
    if (!overlayEl) return;
    var volSlider = overlayEl.querySelector('.fp-vol-slider');
    if (!volSlider) return;

    try {
      var saved = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
      if (typeof saved.volume === 'number') {
        volSlider.value = saved.volume;
        paintVolFill(volSlider);
        if (Audio && Audio.setVolume) {
          Audio.setVolume(saved.volume);
        }
      }
    } catch (_) { /* skip */ }
  }

  function restoreHissLevel() {
    if (!Audio || !Audio.setHissLevel) return;
    try {
      var saved = JSON.parse(localStorage.getItem('pixelMusicControls') || '{}');
      if (typeof saved.hissLevel === 'number') {
        Audio.setHissLevel(saved.hissLevel);
      }
    } catch (_) { /* skip */ }
  }

  // ══════════════════════════════════════════════════════════════════
  // 10b. Scene Picker
  // ══════════════════════════════════════════════════════════════════

  function toggleScenePicker() {
    if (scenePickerOpen) {
      closeScenePicker();
    } else {
      openScenePicker();
    }
  }

  function openScenePicker() {
    if (!overlayEl) return;
    var picker = overlayEl.querySelector('.fp-scene-picker');
    if (!picker) return;

    // Build the items each time (state may have changed)
    buildPickerItems(picker);

    scenePickerOpen = true;
    picker.classList.add('fp-picker-open');

    // Close on click outside (mouse)
    setTimeout(function () {
      overlayEl._pickerOutsideClick = function (e) {
        if (!picker.contains(e.target)) {
          var sceneNameBtn = overlayEl.querySelector('.fp-scene-name');
          if (sceneNameBtn && sceneNameBtn.contains(e.target)) return; // handled by toggle
          closeScenePicker();
        }
      };
      overlayEl.addEventListener('click', overlayEl._pickerOutsideClick);
    }, 0);
  }

  function closeScenePicker() {
    if (!overlayEl) return;
    var picker = overlayEl.querySelector('.fp-scene-picker');
    if (picker) picker.classList.remove('fp-picker-open');
    scenePickerOpen = false;

    if (overlayEl._pickerOutsideClick) {
      overlayEl.removeEventListener('click', overlayEl._pickerOutsideClick);
      overlayEl._pickerOutsideClick = null;
    }
  }

  function buildPickerItems(picker) {
    var locked = Fireplace && Fireplace.getLockedScene ? Fireplace.getLockedScene() : null;
    var currentSceneName = null;
    if (Fireplace) {
      var act = Fireplace.getCurrentAct();
      if (act) currentSceneName = act.scene;
    }

    var html = '';

    // "Auto" option at the top
    var autoActive = !locked;
    html += '<div class="fp-picker-item' + (autoActive ? ' fp-picker-active' : '') + '" data-scene="__auto">';
    html += '<span class="fp-picker-dot" style="background: #8b949e;"></span>';
    html += '<span class="fp-picker-label">Auto</span>';
    if (autoActive) {
      html += '<span class="fp-picker-lock-icon" style="opacity:0.4;">&#x21bb;</span>'; // rotation arrow
    }
    html += '</div>';

    // Separator
    html += '<div class="fp-picker-sep"></div>';

    // Scene items
    for (var i = 0; i < SCENE_KEYS.length; i++) {
      var key = SCENE_KEYS[i];
      var isLocked = locked === key;
      var isActive = currentSceneName === key && !locked;
      var cls = 'fp-picker-item';
      if (isLocked) cls += ' fp-picker-locked';
      else if (isActive) cls += ' fp-picker-active';

      html += '<div class="' + cls + '" data-scene="' + key + '">';
      html += '<span class="fp-picker-dot" style="background: ' + (SCENE_DOTS[key] || '#c9d1d9') + ';"></span>';
      html += '<span class="fp-picker-label">' + (SCENE_LABELS[key] || key) + '</span>';
      if (isLocked) {
        html += '<span class="fp-picker-lock-icon">\uD83D\uDD12</span>';
      }
      html += '</div>';
    }

    picker.innerHTML = html;

    // Wire click events on each item
    var items = picker.querySelectorAll('.fp-picker-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', onPickerSelect);
    }
  }

  function onPickerSelect(e) {
    e.stopPropagation();
    var item = e.currentTarget;
    var sceneName = item.getAttribute('data-scene');
    if (!sceneName || !Fireplace) return;

    if (sceneName === '__auto') {
      // Unlock — resume auto-rotation
      if (Fireplace.unlockScene) Fireplace.unlockScene();
    } else {
      // Lock to this scene
      if (Fireplace.lockScene) Fireplace.lockScene(sceneName);
    }

    closeScenePicker();
    updateCornerInfo();
  }

  // ══════════════════════════════════════════════════════════════════
  // 10c. Sleep Timer
  // ══════════════════════════════════════════════════════════════════

  function startSleepTimer(minutes) {
    cancelSleepTimer();
    sleepTimerMs = minutes * 60 * 1000;
    sleepTimerStart = Date.now();
    sleepFading = false;

    // Update display every 10 seconds
    sleepTimerInterval = setInterval(function () {
      updateSleepDisplay();
    }, 10000);

    // Initial display update
    updateSleepDisplay();
  }

  function cancelSleepTimer() {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    if (sleepFadeInterval) {
      clearInterval(sleepFadeInterval);
      sleepFadeInterval = null;
    }
    // If we were fading, restore original volume
    if (sleepFading && Audio && Audio.setVolume) {
      Audio.setVolume(sleepOrigVolume);
      if (overlayEl) {
        var volSlider = overlayEl.querySelector('.fp-vol-slider');
        if (volSlider) {
          volSlider.value = sleepOrigVolume;
          paintVolFill(volSlider);
        }
      }
    }
    sleepTimerMs = 0;
    sleepTimerStart = 0;
    sleepFading = false;
    sleepStepIndex = 0;
    updateSleepBtn();
  }

  function updateSleepDisplay() {
    if (!overlayEl || sleepTimerMs === 0) return;

    var elapsed = Date.now() - sleepTimerStart;
    var remaining = sleepTimerMs - elapsed;

    if (remaining <= 0) {
      onSleepTimerExpired();
      return;
    }

    // Start fade when < 30 seconds remain
    if (remaining <= 30000 && !sleepFading) {
      beginSleepFade();
    }

    // Update remaining display
    var remainEl = overlayEl.querySelector('.fp-sleep-remaining');
    if (remainEl) {
      var totalSec = Math.ceil(remaining / 1000);
      var min = Math.floor(totalSec / 60);
      var sec = totalSec % 60;
      if (min > 0) {
        remainEl.textContent = min + 'm';
      } else {
        remainEl.textContent = sec + 's';
      }
    }
  }

  function beginSleepFade() {
    if (sleepFading) return;
    sleepFading = true;

    // Capture current volume from the slider
    if (overlayEl) {
      var volSlider = overlayEl.querySelector('.fp-vol-slider');
      if (volSlider) {
        sleepOrigVolume = parseFloat(volSlider.value);
      }
    }

    var startVol = sleepOrigVolume;
    var fadeStartTime = Date.now();
    var fadeDuration = 30000; // 30 seconds

    sleepFadeInterval = setInterval(function () {
      var fadeElapsed = Date.now() - fadeStartTime;
      var progress = Math.min(fadeElapsed / fadeDuration, 1);
      var vol = startVol * (1 - progress);

      if (Audio && Audio.setVolume) {
        Audio.setVolume(Math.max(0, vol));
      }
      if (overlayEl) {
        var slider = overlayEl.querySelector('.fp-vol-slider');
        if (slider) {
          slider.value = Math.max(0, vol);
          paintVolFill(slider);
        }
      }

      if (progress >= 1) {
        clearInterval(sleepFadeInterval);
        sleepFadeInterval = null;
      }
    }, 500);
  }

  function onSleepTimerExpired() {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    if (sleepFadeInterval) {
      clearInterval(sleepFadeInterval);
      sleepFadeInterval = null;
    }

    // Ensure volume is zero
    if (Audio && Audio.setVolume) {
      Audio.setVolume(0);
    }

    // Stop audio then fireplace
    if (Audio && Audio.isPlaying()) {
      try { Audio.stop(); } catch (_) { /* skip */ }
    }
    if (Fireplace && Fireplace.isActive()) {
      Fireplace.stop();
    }

    // Reset state
    sleepTimerMs = 0;
    sleepTimerStart = 0;
    sleepFading = false;
    sleepStepIndex = 0;
  }

  function updateSleepBtn() {
    if (!overlayEl) return;
    var btn = overlayEl.querySelector('.fp-sleep-btn');
    if (!btn) return;

    var remainEl = btn.querySelector('.fp-sleep-remaining');
    var minutes = SLEEP_STEPS[sleepStepIndex];

    if (minutes === 0) {
      btn.classList.remove('fp-sleep-active');
      btn.title = 'Sleep timer: off';
      if (remainEl) remainEl.textContent = '';
    } else {
      btn.classList.add('fp-sleep-active');
      var label = minutes < 60 ? minutes + 'm' : (minutes / 60) + 'h';
      btn.title = 'Sleep timer: ' + label;
      if (remainEl) remainEl.textContent = label;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 10d. Share / Copy URL
  // ══════════════════════════════════════════════════════════════════

  function copyShareableURL() {
    var currentSeed = Fireplace ? Fireplace.getSeed() : 0;
    var url = window.location.origin + '/?mode=fireplace&seed=' + currentSeed;

    if (typeof window.copyText === 'function') {
      window.copyText(url);
    } else if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).catch(function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showShareToast('Copied!');
  }

  function showShareToast(text) {
    if (!overlayEl) return;
    var toast = overlayEl.querySelector('.fp-share-toast');
    if (!toast) return;

    toast.textContent = text;
    toast.classList.add('fp-toast-show');
    setTimeout(function () {
      toast.classList.remove('fp-toast-show');
    }, 1500);
  }

  // ══════════════════════════════════════════════════════════════════
  // 11. Narrative Display
  // ══════════════════════════════════════════════════════════════════

  function onNarrative(e) {
    if (!active || !overlayEl) return;
    var detail = e.detail || {};
    showNarrativeText(detail.text, detail.durationMs || 8000, detail.isTransition || false);
  }

  function onGoldenHour(e) {
    if (!active || !overlayEl) return;
    var detail = e.detail || {};
    showNarrativeText(detail.text || 'Something magical happens...', Math.min(detail.durationMs || 15000, 15000), false);
  }

  function showNarrativeText(text, durationMs, isTransition) {
    if (!text || !overlayEl) return;

    narrativeEl = overlayEl.querySelector('.fp-narrative');
    if (!narrativeEl) return;

    // Clear existing fade-out
    if (narrativeTimer) {
      clearTimeout(narrativeTimer);
      narrativeTimer = null;
    }

    // Set text and transition class
    narrativeEl.textContent = text;
    if (isTransition) {
      narrativeEl.classList.add('fp-transition');
    } else {
      narrativeEl.classList.remove('fp-transition');
    }

    // Fade in
    narrativeEl.classList.remove('fp-visible');
    // Force reflow so transition runs
    void narrativeEl.offsetWidth;
    narrativeEl.classList.add('fp-visible');

    // Schedule fade out
    narrativeTimer = setTimeout(function () {
      if (narrativeEl) {
        narrativeEl.classList.remove('fp-visible');
      }
      narrativeTimer = null;
    }, durationMs);
  }

  // ══════════════════════════════════════════════════════════════════
  // 12. Audio state sync (periodic)
  // ══════════════════════════════════════════════════════════════════

  // Listen for audio start/stop to update the play button
  document.addEventListener('fireplace:started', function () {
    setTimeout(updateControlsState, 200);
  });
  document.addEventListener('fireplace:stopped', function () {
    // The integration layer calls deactivate(), but update state just in case
    cancelSleepTimer();
    updateControlsState();
  });

  // ══════════════════════════════════════════════════════════════════
  // 13. Public API
  // ══════════════════════════════════════════════════════════════════

  window.PixelFireplaceUI = {
    activate: activate,
    deactivate: deactivate,
    isActive: isActiveState,
  };

})();
