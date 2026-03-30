// === Pixel Audio Viz — Spectrogram Renderer for Claude Relay ===
// Captures FFT data from PixelAudioEngine and renders spectrograms as PNG.
// Uses _createAnalyser / _destroyAnalyser from pixel-audio.js.
//
// Public API: window.PixelAudioViz
//   .renderSpectrogram(sec, cb)       — capture & render, returns data URL
//   .showSpectrogramOverlay(sec)      — capture & display overlay with download
//   .compareSeeds(seedA, seedB, sec)  — side-by-side (current + saved)
//   .isCapturing()                    — true while recording FFT data

(function () {
  'use strict';

  // ── CSS injection ──────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.pviz-overlay {',
    '  position: fixed; top: 0; left: 0; width: 100%; height: 100%;',
    '  background: rgba(0,0,0,0.85); z-index: 10000;',
    '  display: flex; flex-direction: column; align-items: center; justify-content: center;',
    '  font-family: "Berkeley Mono", monospace; color: #e0e0e0;',
    '}',
    '.pviz-container {',
    '  background: #1a1a2e; border: 2px solid #444; border-radius: 8px;',
    '  padding: 16px; max-width: 860px;',
    '}',
    '.pviz-title { font-size: 13px; margin: 0 0 8px 0; color: #aaa; text-align: center; }',
    '.pviz-canvas-wrap { position: relative; }',
    '.pviz-canvas-wrap canvas { display: block; border-radius: 4px; }',
    '.pviz-progress {',
    '  position: absolute; bottom: 4px; left: 4px; right: 4px; height: 3px;',
    '  background: #333; border-radius: 2px; overflow: hidden;',
    '}',
    '.pviz-progress-bar { height: 100%; background: #7c3aed; transition: width 0.1s linear; }',
    '.pviz-buttons { display: flex; gap: 8px; margin-top: 10px; justify-content: center; }',
    '.pviz-btn {',
    '  padding: 6px 14px; border: 1px solid #555; border-radius: 4px;',
    '  background: #2a2a3e; color: #ddd; cursor: pointer; font-size: 12px; font-family: inherit;',
    '}',
    '.pviz-btn:hover { background: #3a3a5e; }',
    '.pviz-meta { font-size: 11px; color: #888; text-align: center; margin-top: 6px; }',
    '.pviz-compare { display: flex; gap: 12px; align-items: flex-start; }',
    '.pviz-compare-panel { flex: 1; text-align: center; }',
    '.pviz-compare-panel canvas { width: 100%; height: auto; }',
    '.pviz-label { font-size: 11px; color: #aaa; margin-bottom: 4px; }',
  ].join('\n');
  document.head.appendChild(style);

  // ── Constants ──────────────────────────────────────────────────────
  var CANVAS_W = 800, CANVAS_H = 400;
  var FFT_SIZE = 2048;
  var SAMPLE_MS = 50;
  var MIN_FREQ = 20, MAX_FREQ = 16000;
  var _capturing = false;
  var _saved = {}; // keyed by seed

  // ── Color mapping (black -> blue -> purple -> red -> yellow) ───────
  function magColor(dB) {
    var t = Math.max(0, Math.min(1, (dB + 100) / 100));
    var r, g, b;
    if (t < 0.25) {
      r = 0; g = 0; b = Math.floor(153 * (t / 0.25));
    } else if (t < 0.5) {
      var p = (t - 0.25) / 0.25;
      r = Math.floor(140 * p); g = 0; b = Math.floor(153 + 50 * p);
    } else if (t < 0.75) {
      var p = (t - 0.5) / 0.25;
      r = Math.floor(140 + 115 * p); g = Math.floor(40 * p); b = Math.floor(203 * (1 - p));
    } else {
      var p = (t - 0.75) / 0.25;
      r = 255; g = Math.floor(40 + 215 * p); b = 0;
    }
    return [r, g, b];
  }

  // ── Log-scale frequency to Y ──────────────────────────────────────
  function freqToY(freq) {
    if (freq <= MIN_FREQ) return CANVAS_H - 1;
    if (freq >= MAX_FREQ) return 0;
    var n = (Math.log(freq) - Math.log(MIN_FREQ)) / (Math.log(MAX_FREQ) - Math.log(MIN_FREQ));
    return Math.floor((1 - n) * (CANVAS_H - 1));
  }

  // ── Axis labels ────────────────────────────────────────────────────
  function drawLabels(c, dur) {
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, 0, 50, CANVAS_H);
    c.fillRect(0, CANVAS_H - 18, CANVAS_W, 18);
    c.font = '10px monospace';
    var freqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    for (var i = 0; i < freqs.length; i++) {
      var y = freqToY(freqs[i]);
      var label = freqs[i] >= 1000 ? (freqs[i] / 1000) + 'k' : freqs[i] + '';
      c.fillStyle = '#666'; c.fillRect(48, y, CANVAS_W - 48, 1);
      c.fillStyle = '#aaa'; c.fillText(label, 4, y + 3);
    }
    var steps = Math.min(10, Math.floor(dur));
    for (var t = 0; t <= steps; t++) {
      var sec = (t / steps) * dur;
      var x = 50 + ((CANVAS_W - 50) * (t / steps));
      c.fillStyle = '#aaa'; c.fillText(sec.toFixed(1) + 's', x - 8, CANVAS_H - 4);
    }
    c.fillStyle = '#888'; c.save();
    c.translate(12, CANVAS_H / 2); c.rotate(-Math.PI / 2);
    c.fillText('Frequency (Hz)', -30, 0); c.restore();
  }

  // ── Core capture + render ──────────────────────────────────────────
  function renderSpectrogram(durationSec, onProgress) {
    durationSec = durationSec || 15;
    var engine = window.PixelAudioEngine;
    if (!engine || !engine.isPlaying())
      return Promise.resolve({ error: 'Audio engine not playing. Start audio first.' });
    if (_capturing)
      return Promise.resolve({ error: 'Already capturing.' });

    var state = engine.getState();
    var seed = state.seed;
    var sr = engine._getSampleRate();
    var analyser = engine._createAnalyser(FFT_SIZE);
    if (!analyser)
      return Promise.resolve({ error: 'Could not create analyser node.' });

    _capturing = true;
    var binCount = analyser.frequencyBinCount;
    var binHz = sr / FFT_SIZE;
    var snaps = [];
    var total = Math.floor((durationSec * 1000) / SAMPLE_MS);

    return new Promise(function (resolve) {
      var buf = new Float32Array(binCount);
      var count = 0;
      var timer = setInterval(function () {
        if (count >= total) {
          clearInterval(timer);
          engine._destroyAnalyser(analyser);
          _capturing = false;
          var result = paint(snaps, durationSec, sr, binHz, seed);
          _saved[seed] = result.dataUrl;
          resolve(result);
          return;
        }
        analyser.getFloatFrequencyData(buf);
        snaps.push(new Float32Array(buf));
        count++;
        if (onProgress) onProgress(count / total);
      }, SAMPLE_MS);
    });
  }

  // ── Paint snapshots onto canvas ────────────────────────────────────
  function paint(snaps, dur, sr, binHz, seed) {
    var cv = document.createElement('canvas');
    cv.width = CANVAS_W; cv.height = CANVAS_H;
    var c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, CANVAS_W, CANVAS_H);

    var dW = CANVAS_W - 50, dX0 = 50, dH = CANVAS_H - 18;
    var n = snaps.length;
    if (n === 0) { drawLabels(c, dur); return mk(cv, seed, dur, sr); }

    var bins = snaps[0].length;
    var img = c.getImageData(0, 0, CANVAS_W, CANVAS_H);
    var px = img.data;

    for (var col = 0; col < n; col++) {
      var snap = snaps[col];
      var x = Math.floor(dX0 + (col / n) * dW);
      if (x >= CANVAS_W) continue;
      for (var bin = 0; bin < bins; bin++) {
        var freq = bin * binHz;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
        var y = freqToY(freq);
        if (y < 0 || y >= dH) continue;
        var rgb = magColor(snap[bin]);
        var idx = (y * CANVAS_W + x) * 4;
        if (rgb[0] + rgb[1] + rgb[2] > px[idx] + px[idx + 1] + px[idx + 2]) {
          px[idx] = rgb[0]; px[idx + 1] = rgb[1]; px[idx + 2] = rgb[2]; px[idx + 3] = 255;
        }
      }
    }
    c.putImageData(img, 0, 0);
    drawLabels(c, dur);
    return mk(cv, seed, dur, sr);
  }

  function mk(cv, seed, dur, sr) {
    return { dataUrl: cv.toDataURL('image/png'), seed: seed, duration: dur, sampleRate: sr };
  }

  // ── Overlay UI ─────────────────────────────────────────────────────
  function showSpectrogramOverlay(durationSec) {
    durationSec = durationSec || 15;
    var engine = window.PixelAudioEngine;
    if (!engine || !engine.isPlaying()) {
      console.warn('[AudioViz] Audio not playing.'); return;
    }
    var overlay = el('div', 'pviz-overlay');
    var container = el('div', 'pviz-container');
    var title = el('div', 'pviz-title');
    var state = engine.getState();
    title.textContent = 'Spectrogram — Seed ' + state.seed + ' — Capturing ' + durationSec + 's...';

    var wrap = el('div', 'pviz-canvas-wrap');
    var preview = document.createElement('canvas');
    preview.width = CANVAS_W; preview.height = CANVAS_H;
    preview.style.cssText = 'width:800px;max-width:90vw;height:auto';
    var pc = preview.getContext('2d');
    pc.fillStyle = '#0a0a1a'; pc.fillRect(0, 0, CANVAS_W, CANVAS_H);
    pc.fillStyle = '#555'; pc.font = '14px monospace';
    pc.fillText('Recording...', CANVAS_W / 2 - 45, CANVAS_H / 2);
    wrap.appendChild(preview);

    var progWrap = el('div', 'pviz-progress');
    var progBar = el('div', 'pviz-progress-bar');
    progBar.style.width = '0%';
    progWrap.appendChild(progBar); wrap.appendChild(progWrap);

    var btns = el('div', 'pviz-buttons');
    var meta = el('div', 'pviz-meta');
    container.appendChild(title); container.appendChild(wrap);
    container.appendChild(btns); container.appendChild(meta);
    overlay.appendChild(container); document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    renderSpectrogram(durationSec, function (p) {
      progBar.style.width = Math.round(p * 100) + '%';
    }).then(function (r) {
      if (r.error) { title.textContent = 'Error: ' + r.error; addClose(btns, overlay); return; }
      title.textContent = 'Spectrogram — Seed ' + r.seed + ' — ' + r.duration + 's @ ' + r.sampleRate + ' Hz';
      progWrap.style.display = 'none';
      var img = new Image();
      img.src = r.dataUrl; img.style.cssText = 'width:800px;max-width:90vw;height:auto;border-radius:4px';
      wrap.replaceChild(img, preview);
      meta.textContent = 'FFT: ' + FFT_SIZE + ' | Interval: ' + SAMPLE_MS + 'ms | Range: ' + MIN_FREQ + '-' + MAX_FREQ + ' Hz (log)';
      var dl = el('button', 'pviz-btn'); dl.textContent = 'Download PNG';
      dl.addEventListener('click', function () { download(r.dataUrl, r.seed, r.duration); });
      btns.appendChild(dl);
      addClose(btns, overlay);
    });
  }

  function el(tag, cls) { var e = document.createElement(tag); e.className = cls; return e; }
  function addClose(parent, overlay) {
    var b = el('button', 'pviz-btn'); b.textContent = 'Close';
    b.addEventListener('click', function () { overlay.remove(); }); parent.appendChild(b);
  }
  function download(url, seed, dur) {
    var a = document.createElement('a'); a.href = url;
    a.download = 'spectrogram-seed' + seed + '-' + dur + 's.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // ── Compare seeds ──────────────────────────────────────────────────
  function compareSeeds(seedA, seedB, durationSec) {
    durationSec = durationSec || 10;
    var engine = window.PixelAudioEngine;
    if (!engine || !engine.isPlaying()) { console.warn('[AudioViz] Audio not playing.'); return; }

    var curSeed = engine.getState().seed;
    var overlay = el('div', 'pviz-overlay');
    var container = el('div', 'pviz-container'); container.style.maxWidth = '1200px';
    var title = el('div', 'pviz-title');
    title.textContent = 'Capturing seed ' + curSeed + '...';

    var cmp = el('div', 'pviz-compare');
    var panelA = el('div', 'pviz-compare-panel');
    var lblA = el('div', 'pviz-label'); lblA.textContent = 'Seed ' + curSeed + ' (current)';
    panelA.appendChild(lblA);
    var panelB = el('div', 'pviz-compare-panel');
    var lblB = el('div', 'pviz-label');
    cmp.appendChild(panelA); cmp.appendChild(panelB);

    var btns = el('div', 'pviz-buttons');
    container.appendChild(title); container.appendChild(cmp); container.appendChild(btns);
    overlay.appendChild(container); document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    renderSpectrogram(durationSec).then(function (r) {
      if (r.error) { title.textContent = 'Error: ' + r.error; addClose(btns, overlay); return; }
      var imgA = new Image(); imgA.src = r.dataUrl;
      imgA.style.cssText = 'width:100%;border-radius:4px'; panelA.appendChild(imgA);

      var other = (seedA === curSeed) ? seedB : seedA;
      lblB.textContent = 'Seed ' + other + ' (saved)';
      if (_saved[other]) {
        var imgB = new Image(); imgB.src = _saved[other];
        imgB.style.cssText = 'width:100%;border-radius:4px'; panelB.appendChild(imgB);
        title.textContent = 'Seed ' + curSeed + ' vs ' + other;
      } else {
        var nd = el('div', 'pviz-meta'); nd.style.padding = '80px 0';
        nd.textContent = 'No saved spectrogram for seed ' + other + '. Capture with that seed first.';
        panelB.appendChild(nd);
        title.textContent = 'Seed ' + curSeed + ' — no data for seed ' + other;
      }
      addClose(btns, overlay);
    });
  }

  // ── Keyboard: D to capture 15s spectrogram ─────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'd' && e.key !== 'D') return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var engine = window.PixelAudioEngine;
    if (!engine || !engine.isPlaying() || _capturing) return;
    e.preventDefault();
    showSpectrogramOverlay(15);
  });

  // ── Public API ─────────────────────────────────────────────────────
  window.PixelAudioViz = {
    renderSpectrogram: renderSpectrogram,
    showSpectrogramOverlay: showSpectrogramOverlay,
    compareSeeds: compareSeeds,
    isCapturing: function () { return _capturing; },
  };

  console.log('[AudioViz] Spectrogram renderer loaded. Press D to capture 15s spectrogram.');
})();
