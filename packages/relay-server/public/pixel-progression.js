// === Pixel Progression — Progression Systems & Tension Engine for Claude Relay ===
// Defines 6 visual progression systems, a tension engine, and casino-inspired
// engagement mechanics for the pixel art idle visualization.
// Loaded BEFORE pixel-agents.js. Exposes window.PixelProgressionConfig.
// Asset credit: Pixel Plains by SnowHex (snowhex.itch.io/pixel-plains)

window.PixelProgressionConfig = (() => {
  'use strict';

  // ── Grid Constants (must match pixel-agents.js) ─────────────────────────
  const TILE_SIZE = 16;
  const SCALE = 3;
  const SCALED_TILE = TILE_SIZE * SCALE;

  // ── Sprite Sheet Definitions ────────────────────────────────────────────
  // Each rect is [srcX, srcY, srcW, srcH] in pixels on the source sheet.

  // sunflowers.png — 64x96 = 4 cols x 6 rows of 16x16
  // Pick 5 distinct growth stages across the sheet.
  const SUNFLOWER_STAGES = {
    seed:   { col: 0, row: 0 },  // bare soil / seed dot
    sprout: { col: 1, row: 0 },  // tiny green sprout
    stem:   { col: 2, row: 1 },  // tall stem, no flower
    bud:    { col: 0, row: 3 },  // closed bud on stem
    bloom:  { col: 1, row: 5 },  // full sunflower bloom
  };
  const SUNFLOWER_STAGE_NAMES = ['seed', 'sprout', 'stem', 'bud', 'bloom'];

  // fountain.png — 384x64 = 24 cols x 4 rows of 16x16
  // Row 0: off / idle frames, Row 1: trickle, Row 2: flowing, Row 3: full spray
  const FOUNTAIN_ROWS = { off: 0, trickle: 1, flowing: 2, fullSpray: 3 };
  const FOUNTAIN_COLS = 24;
  const FOUNTAIN_STATE_NAMES = ['off', 'trickle', 'flowing', 'fullSpray'];

  // pumpkins.png — 80x64 = 5 cols x 4 rows of 16x16
  const PUMPKIN_COLS = 5;
  const PUMPKIN_ROWS = 4;
  const PUMPKIN_TOTAL_VARIANTS = PUMPKIN_COLS * PUMPKIN_ROWS; // 20

  // rock-pillars.png — 256x64 = 16 cols x 4 rows of 16x16
  const ROCK_COLS = 16;
  const ROCK_ROWS = 4;

  // sword.png — 112x80 = 7 cols x 5 rows of 16x16
  const SWORD_COLS = 7;
  const SWORD_ROWS = 5;

  // ── Bookshelf Colors (message type → book spine color) ──────────────────
  const BOOK_SPINE_COLORS = {
    architecture: '#f85149',
    patterns:     '#58a6ff',
    conventions:  '#7c6aef',
    question:     '#d29922',
    answer:       '#3fb950',
    context:      '#f0883e',
    insight:      '#db61a2',
    task:         '#6e7681',
  };

  // ── Tool Rack Definitions ───────────────────────────────────────────────
  const TOOL_DEFS = {
    sword:  { label: 'typing',   color: '#f85149', useSpriteSheet: true },
    wand:   { label: 'reading',  color: '#58a6ff', useSpriteSheet: false },
    shield: { label: 'thinking', color: '#7c6aef', useSpriteSheet: false },
    hammer: { label: 'testing',  color: '#d29922', useSpriteSheet: false },
    potion: { label: 'waiting',  color: '#3fb950', useSpriteSheet: false },
  };
  const TOOL_NAMES = Object.keys(TOOL_DEFS);

  // ── Tension Engine Thresholds ───────────────────────────────────────────
  const TENSION_LEVELS = [
    { name: 'calm',   min: 0.0, max: 0.2 },
    { name: 'normal', min: 0.2, max: 0.5 },
    { name: 'tense',  min: 0.5, max: 0.7 },
    { name: 'crisis', min: 0.7, max: 0.9 },
    { name: 'siege',  min: 0.9, max: 1.0 },
  ];

  // Per-level environmental modifiers
  const ENV_MODIFIERS = {
    calm: {
      lightOverlay: { r: 255, g: 220, b: 150, a: 0.04 },
      maxGatos: 5,
      particleType: null,
      particleRate: 1.0,
      knightSpawnMultiplier: 0.7,
      vignetteAlpha: 0,
      rainIntensity: 0,
      plantTint: null,
    },
    normal: {
      lightOverlay: null,
      maxGatos: 3,
      particleType: null,
      particleRate: 1.0,
      knightSpawnMultiplier: 1.0,
      vignetteAlpha: 0,
      rainIntensity: 0,
      plantTint: null,
    },
    tense: {
      lightOverlay: { r: 20, g: 10, b: 40, a: 0.08 },
      maxGatos: 1,
      particleType: null,
      particleRate: 0.7,
      knightSpawnMultiplier: 1.4,
      vignetteAlpha: 0.05,
      rainIntensity: 0,
      plantTint: null,
    },
    crisis: {
      lightOverlay: { r: 10, g: 5, b: 20, a: 0.15 },
      maxGatos: 0,
      particleType: 'rain',
      particleRate: 1.5,
      knightSpawnMultiplier: 1.8,
      vignetteAlpha: 0.12,
      rainIntensity: 0.6,
      plantTint: { r: 80, g: 60, b: 40, a: 0.3 },
    },
    siege: {
      lightOverlay: { r: 5, g: 0, b: 10, a: 0.25 },
      maxGatos: 0,
      particleType: 'rain',
      particleRate: 2.0,
      knightSpawnMultiplier: 2.2,
      vignetteAlpha: 0.2,
      rainIntensity: 1.0,
      plantTint: { r: 60, g: 40, b: 30, a: 0.5 },
    },
  };


  // ═══════════════════════════════════════════════════════════════════════
  //  1. SUNFLOWER GROWTH (task lifecycle)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Maps knight HP percentage (0-100) inversely to sunflower growth stage.
   * Knight at 100% = seed, 0% = bloom.
   * @param {number} knightHpPercent - 0 to 100
   * @returns {number} stage index 0-4
   */
  function getSunflowerStage(knightHpPercent) {
    const hp = Math.max(0, Math.min(100, knightHpPercent));
    if (hp > 80) return 0; // seed
    if (hp > 60) return 1; // sprout
    if (hp > 40) return 2; // stem
    if (hp > 20) return 3; // bud
    return 4;              // bloom
  }

  /**
   * Draw a sunflower at the given tile position.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX - tile column
   * @param {number} tileY - tile row
   * @param {number} stage - 0-4 index into SUNFLOWER_STAGE_NAMES
   * @param {HTMLImageElement} img - sunflowers.png
   */
  function drawSunflower(ctx, SCALE, SCALED_TILE, tileX, tileY, stage, img) {
    const stageName = SUNFLOWER_STAGE_NAMES[Math.min(stage, 4)];
    const rect = SUNFLOWER_STAGES[stageName];
    const srcX = rect.col * 16;
    const srcY = rect.row * 16;
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;

    ctx.drawImage(img, srcX, srcY, 16, 16, destX, destY, SCALED_TILE, SCALED_TILE);

    // Bloom stage triggers sparkle burst (drawn as small white dots)
    if (stage === 4) {
      const t = performance.now();
      for (let i = 0; i < 5; i++) {
        const angle = (t / 800 + i * 1.256) % (Math.PI * 2);
        const radius = SCALE * (6 + 3 * Math.sin(t / 400 + i));
        const sx = destX + SCALED_TILE / 2 + Math.cos(angle) * radius;
        const sy = destY + SCALED_TILE * 0.3 + Math.sin(angle) * radius;
        const alpha = 0.4 + 0.4 * Math.sin(t / 300 + i * 0.8);
        ctx.fillStyle = `rgba(255, 255, 200, ${alpha})`;
        ctx.fillRect(sx, sy, SCALE, SCALE);
      }
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  2. FOUNTAIN (project velocity)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Map task completions in the last 5 minutes to fountain state index.
   * @param {number} recentCompletions
   * @returns {number} 0-3 state index
   */
  function getFountainState(recentCompletions) {
    if (recentCompletions <= 0) return 0; // off
    if (recentCompletions === 1) return 1; // trickle
    if (recentCompletions <= 3) return 2;  // flowing
    return 3;                               // fullSpray
  }

  /**
   * Draw the fountain at the given tile, animating through sprite frames.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} state - 0-3 (off/trickle/flowing/fullSpray)
   * @param {number} globalFrame - monotonically increasing frame counter
   * @param {HTMLImageElement} img - fountain.png
   */
  function drawFountain(ctx, SCALE, SCALED_TILE, tileX, tileY, state, globalFrame, img) {
    const stateName = FOUNTAIN_STATE_NAMES[Math.min(state, 3)];
    const row = FOUNTAIN_ROWS[stateName];

    // Animate across columns; off state holds frame 0
    let col;
    if (state === 0) {
      col = 0;
    } else {
      // Cycle through a subset of frames per state for variety
      const frameCols = state === 1 ? 6 : state === 2 ? 12 : 24;
      col = globalFrame % frameCols;
    }

    const srcX = col * 16;
    const srcY = row * 16;
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;

    ctx.drawImage(img, srcX, srcY, 16, 16, destX, destY, SCALED_TILE, SCALED_TILE);

    // Full spray gets water droplet particles above
    if (state === 3) {
      const t = performance.now();
      for (let i = 0; i < 4; i++) {
        const px = destX + SCALED_TILE * 0.3 + (i / 3) * SCALED_TILE * 0.4;
        const py = destY - SCALE * (2 + 6 * Math.abs(Math.sin(t / 250 + i)));
        const alpha = 0.3 + 0.3 * Math.sin(t / 200 + i * 1.5);
        ctx.fillStyle = `rgba(88, 166, 255, ${alpha})`;
        ctx.fillRect(px, py, SCALE * 1.5, SCALE * 1.5);
      }
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  3. PUMPKINS (completed milestones)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Draw a single pumpkin at the given tile using a face variant from pumpkins.png.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} variantIdx - 0-19, wraps through 5 cols x 4 rows
   * @param {HTMLImageElement} img - pumpkins.png
   */
  function drawPumpkin(ctx, SCALE, SCALED_TILE, tileX, tileY, variantIdx, img) {
    const idx = variantIdx % PUMPKIN_TOTAL_VARIANTS;
    const col = idx % PUMPKIN_COLS;
    const row = Math.floor(idx / PUMPKIN_COLS);
    const srcX = col * 16;
    const srcY = row * 16;
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;

    ctx.drawImage(img, srcX, srcY, 16, 16, destX, destY, SCALED_TILE, SCALED_TILE);
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  4. BOOKSHELF FILLING (knowledge accumulation)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Draw a bookshelf with procedurally rendered book spines.
   * Fill percentage determines how many book slots are occupied.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} fillPercent - 0 to 1
   * @param {string[]} bookColors - array of hex color strings for spines
   */
  function drawBookshelf(ctx, SCALE, SCALED_TILE, tileX, tileY, fillPercent, bookColors) {
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;
    const fill = Math.max(0, Math.min(1, fillPercent));

    // Shelf background — dark wood
    ctx.fillStyle = '#2d1f0e';
    ctx.fillRect(destX, destY, SCALED_TILE, SCALED_TILE);

    // Shelf divider line (horizontal plank at 60% height)
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(destX, destY + SCALED_TILE * 0.58, SCALED_TILE, SCALE);

    // Top border
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(destX, destY, SCALED_TILE, SCALE);

    // Bottom border
    ctx.fillRect(destX, destY + SCALED_TILE - SCALE, SCALED_TILE, SCALE);

    // Book spines — upper shelf (row at ~10-55% height)
    const spineW = SCALE * 2;
    const maxBooks = Math.floor((SCALED_TILE - SCALE * 2) / (spineW + 1));
    const filledBooks = Math.round(maxBooks * fill);
    const colors = bookColors.length > 0 ? bookColors : ['#6e7681'];

    // Upper row
    for (let i = 0; i < Math.min(filledBooks, Math.ceil(maxBooks / 2)); i++) {
      const bx = destX + SCALE + i * (spineW + 1);
      const by = destY + SCALE * 2;
      const bh = SCALED_TILE * 0.45;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(bx, by, spineW, bh);
      // Spine highlight
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(bx, by, 1, bh);
    }

    // Lower row
    const lowerStart = Math.ceil(maxBooks / 2);
    for (let i = lowerStart; i < filledBooks; i++) {
      const bx = destX + SCALE + (i - lowerStart) * (spineW + 1);
      const by = destY + SCALED_TILE * 0.62;
      const bh = SCALED_TILE * 0.32;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(bx, by, spineW, bh);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(bx, by, 1, bh);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  5. BARREL/CRATE STOCKPILE (deployable artifacts)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Draw a procedural barrel/crate at the given tile.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX
   * @param {number} tileY
   * @param {string} state - 'staging'|'ready'|'shipped'
   */
  function drawCrate(ctx, SCALE, SCALED_TILE, tileX, tileY, state) {
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;
    const pad = SCALE * 2;
    const w = SCALED_TILE - pad * 2;
    const h = SCALED_TILE - pad * 2;
    const cx = destX + pad;
    const cy = destY + pad;

    // State-based colors
    const palette = {
      staging: { body: '#4a3520', band: '#6e5530', mark: '#d29922' },
      ready:   { body: '#2d4a20', band: '#4a7530', mark: '#3fb950' },
      shipped: { body: '#1f3050', band: '#305a80', mark: '#58a6ff' },
    };
    const p = palette[state] || palette.staging;

    // Crate body
    ctx.fillStyle = p.body;
    ctx.fillRect(cx, cy, w, h);

    // Horizontal bands (barrel straps)
    ctx.fillStyle = p.band;
    ctx.fillRect(cx, cy + SCALE * 2, w, SCALE);
    ctx.fillRect(cx, cy + h - SCALE * 3, w, SCALE);

    // Cross planks
    ctx.fillStyle = p.band;
    ctx.fillRect(cx + w / 2 - 1, cy, SCALE, h);

    // State mark — small colored dot
    ctx.fillStyle = p.mark;
    const markSize = SCALE * 2;
    ctx.fillRect(
      cx + w / 2 - markSize / 2,
      cy + h / 2 - markSize / 2,
      markSize,
      markSize
    );

    // Shipped crates get a subtle check mark
    if (state === 'shipped') {
      ctx.strokeStyle = p.mark;
      ctx.lineWidth = SCALE * 0.8;
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.3, cy + h * 0.55);
      ctx.lineTo(cx + w * 0.45, cy + h * 0.7);
      ctx.lineTo(cx + w * 0.7, cy + h * 0.35);
      ctx.stroke();
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  6. TOOL RACK (agent capabilities)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Draw the tool rack showing active agent tools.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX
   * @param {number} tileY
   * @param {Set<string>|string[]} activeTools - set/array of active tool names
   * @param {HTMLImageElement|null} swordImg - sword.png (optional)
   */
  function drawToolRack(ctx, SCALE, SCALED_TILE, tileX, tileY, activeTools, swordImg) {
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;
    const activeSet = activeTools instanceof Set ? activeTools : new Set(activeTools);

    // Rack background — dark plank
    ctx.fillStyle = '#1c1410';
    ctx.fillRect(destX, destY, SCALED_TILE, SCALED_TILE);
    ctx.fillStyle = '#2d1f0e';
    ctx.fillRect(destX + SCALE, destY + SCALE, SCALED_TILE - SCALE * 2, SCALED_TILE - SCALE * 2);

    const slotW = Math.floor((SCALED_TILE - SCALE * 4) / TOOL_NAMES.length);
    const slotH = SCALED_TILE - SCALE * 6;

    TOOL_NAMES.forEach((name, i) => {
      const def = TOOL_DEFS[name];
      const isActive = activeSet.has(name);
      const sx = destX + SCALE * 2 + i * slotW;
      const sy = destY + SCALE * 3;

      // Active glow
      if (isActive) {
        ctx.fillStyle = def.color + '30';
        ctx.fillRect(sx - 1, sy - 1, slotW, slotH + 2);
      }

      // Sword uses sprite sheet
      if (name === 'sword' && swordImg) {
        const srcSize = 16;
        ctx.drawImage(swordImg, 0, 0, srcSize, srcSize, sx, sy, slotW - 2, slotH);
      } else {
        // Procedural tool shapes
        const midX = sx + slotW / 2;
        const toolW = SCALE * 1.5;

        ctx.fillStyle = isActive ? def.color : '#4a4a4a';

        switch (name) {
          case 'wand': {
            // Thin vertical rod with star tip
            ctx.fillRect(midX - 1, sy + slotH * 0.3, SCALE * 0.7, slotH * 0.7);
            ctx.fillRect(midX - SCALE, sy + slotH * 0.15, SCALE * 2, SCALE * 2);
            break;
          }
          case 'shield': {
            // Rounded shield shape (rectangle + bottom triangle)
            const sw = toolW * 2;
            ctx.fillRect(midX - sw / 2, sy + SCALE, sw, slotH * 0.5);
            ctx.beginPath();
            ctx.moveTo(midX - sw / 2, sy + SCALE + slotH * 0.5);
            ctx.lineTo(midX, sy + slotH * 0.85);
            ctx.lineTo(midX + sw / 2, sy + SCALE + slotH * 0.5);
            ctx.fill();
            break;
          }
          case 'hammer': {
            // Handle + head
            ctx.fillRect(midX - 1, sy + slotH * 0.3, SCALE * 0.7, slotH * 0.7);
            ctx.fillRect(midX - SCALE * 1.5, sy + slotH * 0.15, SCALE * 3, SCALE * 2);
            break;
          }
          case 'potion': {
            // Flask shape — narrow neck, wide body
            ctx.fillRect(midX - 1, sy + SCALE, SCALE * 0.7, slotH * 0.3);
            const bodyW = toolW * 1.8;
            ctx.fillRect(midX - bodyW / 2, sy + slotH * 0.4, bodyW, slotH * 0.5);
            // Liquid fill
            if (isActive) {
              ctx.fillStyle = def.color + '80';
              ctx.fillRect(midX - bodyW / 2 + 1, sy + slotH * 0.55, bodyW - 2, slotH * 0.33);
            }
            break;
          }
          default: {
            // Fallback rectangle
            ctx.fillRect(midX - toolW / 2, sy + SCALE, toolW, slotH - SCALE * 2);
          }
        }
      }

      // Active tools pulse brighter
      if (isActive) {
        const pulse = 0.2 + 0.15 * Math.sin(performance.now() / 400 + i);
        ctx.fillStyle = `rgba(255, 255, 255, ${pulse})`;
        ctx.fillRect(sx, sy, slotW - 2, slotH);
      }
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  DRAW HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Draw a vignette (radial gradient, darker edges) over the entire canvas.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} canvasW
   * @param {number} canvasH
   * @param {number} alpha - 0 to ~0.2, controls edge darkness
   */
  function drawVignette(ctx, canvasW, canvasH, alpha) {
    if (alpha <= 0) return;
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    const outerRadius = Math.sqrt(cx * cx + cy * cy);
    const gradient = ctx.createRadialGradient(cx, cy, outerRadius * 0.4, cx, cy, outerRadius);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, `rgba(0, 0, 0, ${Math.min(alpha, 0.5)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasW, canvasH);
  }

  /**
   * Draw a rock pillar from rock-pillars.png at the given tile.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} variantIdx - 0-63, wraps through 16 cols x 4 rows
   * @param {HTMLImageElement} img - rock-pillars.png
   */
  function drawRockPillar(ctx, SCALE, SCALED_TILE, tileX, tileY, variantIdx, img) {
    const totalVariants = ROCK_COLS * ROCK_ROWS;
    const idx = variantIdx % totalVariants;
    const col = idx % ROCK_COLS;
    const row = Math.floor(idx / ROCK_COLS);
    const srcX = col * 16;
    const srcY = row * 16;
    const destX = tileX * SCALED_TILE;
    const destY = tileY * SCALED_TILE;

    ctx.drawImage(img, srcX, srcY, 16, 16, destX, destY, SCALED_TILE, SCALED_TILE);
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  TENSION ENGINE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Stateful tension engine that drives environmental mood.
   * Tension rises from enemy presence and stagnation, drops from kills
   * and positive events.
   */
  class TensionEngine {
    constructor() {
      /** @type {number} Current tension 0.0 - 1.0 */
      this.tension = 0.1;

      /** @type {number[]} Timestamps of recent completions (kills/defeats) */
      this._completionTimestamps = [];

      /** @type {number} Time since last resolution event (ms) */
      this._timeSinceResolution = 0;
    }

    /**
     * Update tension each frame.
     * @param {number} dt - delta time in milliseconds
     * @param {Object} context
     * @param {number} context.knightCount - active knights on screen
     * @param {boolean} context.demonActive - boss demon present
     * @param {boolean} context.elementalActive - elemental present
     * @param {number} context.gatoCount - visible gatos
     */
    update(dt, context) {
      const dtMin = dt / 60000; // convert ms to minutes

      // ── Tension increases ──
      // +0.1 per knight per minute
      this.tension += 0.1 * (context.knightCount || 0) * dtMin;

      // +0.3 per minute while demon active
      if (context.demonActive) {
        this.tension += 0.3 * dtMin;
      }

      // +0.1 per minute while elemental active
      if (context.elementalActive) {
        this.tension += 0.1 * dtMin;
      }

      // +0.05 per minute of no resolution (stagnation)
      this._timeSinceResolution += dt;
      if (this._timeSinceResolution > 10000) {
        this.tension += 0.05 * dtMin;
      }

      // ── Passive decreases ──
      // -0.1 per minute per visible gato (soothing presence)
      const gatoRelief = 0.1 * (context.gatoCount || 0) * dtMin;
      this.tension -= gatoRelief;

      // ── Clamp ──
      this.tension = Math.max(0, Math.min(1, this.tension));

      // ── Prune old completion timestamps (older than 5 minutes) ──
      const now = performance.now();
      this._completionTimestamps = this._completionTimestamps.filter(
        ts => now - ts < 300000
      );
    }

    /** Knight killed — moderate tension relief. */
    onKnightKilled() {
      this.tension = Math.max(0, this.tension - 0.3);
      this._timeSinceResolution = 0;
      this._completionTimestamps.push(performance.now());
    }

    /** Demon defeated — major tension relief. */
    onDemonDefeated() {
      this.tension = Math.max(0, this.tension - 0.5);
      this._timeSinceResolution = 0;
      this._completionTimestamps.push(performance.now());
    }

    /** Gato appeared on screen — minor calm. */
    onGatoVisible() {
      this.tension = Math.max(0, this.tension - 0.1);
    }

    /** Sunflower reached bloom stage — minor calm. */
    onSunflowerBloom() {
      this.tension = Math.max(0, this.tension - 0.05);
    }

    /**
     * Get current tension level name.
     * @returns {'calm'|'normal'|'tense'|'crisis'|'siege'}
     */
    getLevel() {
      for (let i = TENSION_LEVELS.length - 1; i >= 0; i--) {
        if (this.tension >= TENSION_LEVELS[i].min) {
          return TENSION_LEVELS[i].name;
        }
      }
      return 'calm';
    }

    /**
     * Count of completions (kills/defeats) in the last 5 minutes.
     * Used to drive fountain velocity state.
     * @returns {number}
     */
    getRecentCompletions() {
      const now = performance.now();
      return this._completionTimestamps.filter(ts => now - ts < 300000).length;
    }

    /**
     * Get environmental modifiers for the current tension level.
     * @returns {Object} environmental modifier set
     */
    getEnvironment() {
      return ENV_MODIFIERS[this.getLevel()];
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  CASINO MECHANICS (pure functions)
  // ═══════════════════════════════════════════════════════════════════════

  const casinoMechanics = {
    /**
     * 15% chance a knight at <=20% HP gets a surprise heal of 30%.
     * Creates near-death reinforcement — player thinks the kill is certain,
     * then the knight recovers, raising tension and engagement.
     * @param {number} hp - current HP percentage (0-100)
     * @returns {boolean} true if knight should heal
     */
    shouldReinforceKnight(hp) {
      return hp <= 20 && hp > 0 && Math.random() < 0.15;
    },

    /**
     * Knight flees when HP drops below 10%.
     * @param {number} hp - current HP percentage (0-100)
     * @returns {boolean}
     */
    shouldKnightFlee(hp) {
      return hp < 10;
    },

    /**
     * Pulsing alpha for health bars at critical HP.
     * Intensifies as HP drops, creating urgency.
     * @param {number} hp - current HP percentage (0-100)
     * @param {number} time - performance.now()
     * @returns {number} alpha multiplier 0-1
     */
    getHealthBarPulse(hp, time) {
      if (hp >= 15) return 1.0;
      // Pulse faster at lower HP
      const speed = 200 + hp * 20; // 200ms at 0%, 500ms at 15%
      const pulse = 0.5 + 0.5 * Math.sin(time / speed * Math.PI * 2);
      return 0.4 + 0.6 * pulse;
    },

    /**
     * 15% chance the fountain stutters before reaching full spray.
     * Near-miss mechanic — teases the "full velocity" payoff.
     * @returns {boolean}
     */
    shouldFountainStutter() {
      return Math.random() < 0.15;
    },

    /**
     * Duration of gato departure warning (sad particles before leaving).
     * Fixed at 3 seconds — long enough to notice and feel loss.
     * @returns {number} milliseconds
     */
    getGatoDepartureWarningMs() {
      return 3000;
    },

    /**
     * Find nearby knights within range for celebration cascade.
     * When a knight is killed, nearby knights take sympathetic damage.
     * @param {number} x - origin tile x
     * @param {number} y - origin tile y
     * @param {Array<{x:number,y:number}>} obstacles - positions to avoid
     * @param {number} range - tile radius to search
     * @returns {Array<{x:number,y:number}>} valid celebration target tiles
     */
    getCelebrationTargets(x, y, obstacles, range) {
      const targets = [];
      const obstacleSet = new Set(obstacles.map(o => `${o.x},${o.y}`));

      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          if (dx === 0 && dy === 0) continue;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > range) continue;
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || tx >= 20 || ty < 0 || ty >= 14) continue;
          if (obstacleSet.has(`${tx},${ty}`)) continue;
          targets.push({ x: tx, y: ty });
        }
      }
      return targets;
    },

    /**
     * Weighted random selection from an array of { value, weight } entries.
     * Classic loot-table mechanic.
     * @param {Array<{value:*, weight:number}>} tiers
     * @returns {*} selected value
     */
    weightedRandom(tiers) {
      const totalWeight = tiers.reduce((sum, t) => sum + t.weight, 0);
      if (totalWeight <= 0) return tiers[0]?.value;
      let roll = Math.random() * totalWeight;
      for (const tier of tiers) {
        roll -= tier.weight;
        if (roll <= 0) return tier.value;
      }
      return tiers[tiers.length - 1].value;
    },
  };


  // ═══════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  return {
    // ── Constants ──
    SUNFLOWER_STAGE_NAMES,
    SUNFLOWER_STAGES,
    FOUNTAIN_STATE_NAMES,
    FOUNTAIN_ROWS,
    FOUNTAIN_COLS,
    PUMPKIN_TOTAL_VARIANTS,
    BOOK_SPINE_COLORS,
    TOOL_DEFS,
    TOOL_NAMES,
    TENSION_LEVELS,
    ENV_MODIFIERS,

    // ── Progression helpers ──
    getSunflowerStage,
    getFountainState,

    // ── Draw functions (all pure: ctx + params → void) ──
    drawSunflower,
    drawFountain,
    drawPumpkin,
    drawBookshelf,
    drawCrate,
    drawToolRack,
    drawVignette,
    drawRockPillar,

    // ── Tension engine (stateful, instantiatable) ──
    TensionEngine,

    // ── Casino mechanics (pure functions) ──
    casinoMechanics,
  };
})();
