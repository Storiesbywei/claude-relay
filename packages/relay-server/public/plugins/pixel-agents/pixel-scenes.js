// === Pixel Scenes — Scene Configuration for Claude Relay Visualization ===
// Defines 8 switchable scenes for the pixel art idle visualization.
// Loaded BEFORE pixel-agents.js. Exposes window.PixelSceneConfig.
// Asset credit: Pixel Plains by SnowHex (snowhex.itch.io/pixel-plains)

window.PixelSceneConfig = (() => {
  // ── Tile Type Constants ──
  // Base types 0-5 are shared with pixel-agents.js TILE enum.
  // Extended types 6+ are scene-specific.
  const T = {
    FLOOR: 0, WALL: 1, DESK: 2, CHAIR: 3, PLANT: 4, RUG: 5,
    WATER: 6, BOOKSHELF: 7, CAVE_FLOOR: 8, SNOW: 9, GRASS: 10, CLIFF: 11,
  };

  // Grid dimensions (must match pixel-agents.js MAP_W / MAP_H)
  const MAP_W = 20;
  const MAP_H = 14;

  // ── Transition Rules ──
  const TRANSITION_RULES = {
    manual: true,
    activityBased: true,
    temporal: true,
    idleTimeout: 600000, // 10 min no activity -> Cliff Overlook
  };

  // ── Helper: generate a row of identical tiles ──
  function row(tile, width) {
    return Array(width || MAP_W).fill(tile);
  }

  // ── Helper: fill a rectangular region in a tilemap ──
  function fillRect(map, x1, y1, x2, y2, tile) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (y >= 0 && y < MAP_H && x >= 0 && x < MAP_W) {
          map[y][x] = tile;
        }
      }
    }
  }

  // ── Helper: create a blank map filled with a tile ──
  function makeMap(fillTile) {
    return Array.from({ length: MAP_H }, () => Array(MAP_W).fill(fillTile));
  }

  // ── Helper: add standard wall border (rows 0-1 top, col 0 + 19 sides) ──
  function addWalls(map) {
    for (let x = 0; x < MAP_W; x++) {
      map[0][x] = T.WALL;
      map[1][x] = T.WALL;
    }
    for (let y = 0; y < MAP_H; y++) {
      map[y][0] = T.WALL;
      map[y][MAP_W - 1] = T.WALL;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SCENE 1: The Workshop (default active coding office)
  // ══════════════════════════════════════════════════════════════════
  const workshop = (() => {
    const map = makeMap(T.FLOOR);
    addWalls(map);
    // Central rug
    fillRect(map, 6, 6, 14, 7, T.RUG);

    return {
      name: 'The Workshop',
      description: 'Active coding headquarters',
      tilemap: map,
      furniture: [
        // 6 desk stations
        { type: 'desk',    x: 4,  y: 4,  id: 'desk-0' },
        { type: 'chair',   x: 4,  y: 5,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'monitor', x: 4,  y: 4,  id: 'monitor-0', active: false },
        { type: 'desk',    x: 8,  y: 4,  id: 'desk-1' },
        { type: 'chair',   x: 8,  y: 5,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'monitor', x: 8,  y: 4,  id: 'monitor-1', active: false },
        { type: 'desk',    x: 12, y: 4,  id: 'desk-2' },
        { type: 'chair',   x: 12, y: 5,  id: 'chair-2', deskId: 'desk-2' },
        { type: 'monitor', x: 12, y: 4,  id: 'monitor-2', active: false },
        { type: 'desk',    x: 4,  y: 9,  id: 'desk-3' },
        { type: 'chair',   x: 4,  y: 10, id: 'chair-3', deskId: 'desk-3' },
        { type: 'monitor', x: 4,  y: 9,  id: 'monitor-3', active: false },
        { type: 'desk',    x: 8,  y: 9,  id: 'desk-4' },
        { type: 'chair',   x: 8,  y: 10, id: 'chair-4', deskId: 'desk-4' },
        { type: 'monitor', x: 8,  y: 9,  id: 'monitor-4', active: false },
        { type: 'desk',    x: 12, y: 9,  id: 'desk-5' },
        { type: 'chair',   x: 12, y: 10, id: 'chair-5', deskId: 'desk-5' },
        { type: 'monitor', x: 12, y: 9,  id: 'monitor-5', active: false },
        // Decor
        { type: 'plant', x: 2,  y: 3 },
        { type: 'plant', x: 17, y: 3 },
        { type: 'plant', x: 2,  y: 8 },
        { type: 'plant', x: 17, y: 8 },
        { type: 'plant', x: 16, y: 12 },
        { type: 'watercooler', x: 10, y: 12 },
      ],
      interestPoints: [
        { x: 9,  y: 12, label: 'watercooler' },
        { x: 11, y: 12, label: 'watercooler' },
        { x: 3,  y: 3,  label: 'plant' },
        { x: 16, y: 3,  label: 'plant' },
        { x: 3,  y: 8,  label: 'plant' },
        { x: 16, y: 8,  label: 'plant' },
        { x: 15, y: 12, label: 'plant' },
        { x: 10, y: 7,  label: 'lounge' },
        { x: 8,  y: 7,  label: 'lounge' },
      ],
      deskPositions: [
        { x: 4, y: 4 }, { x: 8, y: 4 }, { x: 12, y: 4 },
        { x: 4, y: 9 }, { x: 8, y: 9 }, { x: 12, y: 9 },
      ],
      ambient: {
        particleType: 'sparkle',
        bgColor: '#0d1117',
        tilesheet: 'tiles-1-spring',
        propsSheet: 'props-spring',
      },
      drawBackground: null,
      drawForeground: null,
      drawOverlay: null,
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 2: The Library (research / planning)
  // ══════════════════════════════════════════════════════════════════
  const library = (() => {
    const map = makeMap(T.FLOOR);
    addWalls(map);
    // Bookshelves along top wall interior (row 2)
    fillRect(map, 1, 2, 18, 2, T.BOOKSHELF);
    // Side bookshelves
    for (let y = 3; y <= 10; y++) {
      map[y][1] = T.BOOKSHELF;
      map[y][18] = T.BOOKSHELF;
    }
    // Reading rug in center
    fillRect(map, 7, 7, 12, 9, T.RUG);

    return {
      name: 'The Library',
      description: 'Quiet research and planning',
      tilemap: map,
      furniture: [
        // 4 reading desks (quieter, fewer stations)
        { type: 'desk',    x: 5,  y: 5,  id: 'desk-0' },
        { type: 'chair',   x: 5,  y: 6,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'monitor', x: 5,  y: 5,  id: 'monitor-0', active: false },
        { type: 'desk',    x: 14, y: 5,  id: 'desk-1' },
        { type: 'chair',   x: 14, y: 6,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'monitor', x: 14, y: 5,  id: 'monitor-1', active: false },
        { type: 'desk',    x: 5,  y: 10, id: 'desk-2' },
        { type: 'chair',   x: 5,  y: 11, id: 'chair-2', deskId: 'desk-2' },
        { type: 'monitor', x: 5,  y: 10, id: 'monitor-2', active: false },
        { type: 'desk',    x: 14, y: 10, id: 'desk-3' },
        { type: 'chair',   x: 14, y: 11, id: 'chair-3', deskId: 'desk-3' },
        { type: 'monitor', x: 14, y: 10, id: 'monitor-3', active: false },
        // Central reading lamp (decorative plant stand)
        { type: 'plant', x: 9,  y: 4 },
        { type: 'plant', x: 10, y: 4 },
      ],
      interestPoints: [
        { x: 3,  y: 3,  label: 'bookshelf' },
        { x: 7,  y: 3,  label: 'bookshelf' },
        { x: 12, y: 3,  label: 'bookshelf' },
        { x: 16, y: 3,  label: 'bookshelf' },
        { x: 2,  y: 6,  label: 'bookshelf' },
        { x: 17, y: 6,  label: 'bookshelf' },
        { x: 9,  y: 8,  label: 'lounge' },
        { x: 11, y: 8,  label: 'lounge' },
        { x: 10, y: 12, label: 'aisle' },
      ],
      deskPositions: [
        { x: 5, y: 5 }, { x: 14, y: 5 },
        { x: 5, y: 10 }, { x: 14, y: 10 },
      ],
      ambient: {
        particleType: 'sparkle',
        bgColor: '#0e1218',
        tilesheet: 'tiles-2-spring',
        propsSheet: 'props-spring',
      },
      // Warm reading-lamp glow pools on the rug
      drawBackground: null,
      drawForeground: null,
      drawOverlay: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        // Soft amber glow from overhead lamps above each desk
        const lampPositions = [
          { x: 5, y: 5 }, { x: 14, y: 5 },
          { x: 5, y: 10 }, { x: 14, y: 10 },
        ];
        for (const lamp of lampPositions) {
          const px = lamp.x * SCALED_TILE + SCALED_TILE / 2;
          const py = lamp.y * SCALED_TILE + SCALED_TILE / 2;
          const pulse = 0.03 + 0.015 * Math.sin(timestamp * 0.001);
          const grad = ctx.createRadialGradient(px, py, 0, px, py, SCALED_TILE * 2.5);
          grad.addColorStop(0, `rgba(255, 220, 140, ${pulse})`);
          grad.addColorStop(1, 'rgba(255, 220, 140, 0)');
          ctx.fillStyle = grad;
          ctx.fillRect(px - SCALED_TILE * 3, py - SCALED_TILE * 3, SCALED_TILE * 6, SCALED_TILE * 6);
        }
      },
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 3: The Garden (healthy project / milestone celebration)
  // ══════════════════════════════════════════════════════════════════
  const garden = (() => {
    const map = makeMap(T.GRASS);
    // Stone path down center
    for (let y = 0; y < MAP_H; y++) {
      map[y][9] = T.FLOOR;
      map[y][10] = T.FLOOR;
    }
    // Hedge walls along top
    fillRect(map, 0, 0, 19, 1, T.WALL);
    map[0][9] = T.WALL; map[0][10] = T.WALL;
    map[1][9] = T.FLOOR; map[1][10] = T.FLOOR; // gate opening
    // Side hedges
    for (let y = 0; y < MAP_H; y++) {
      map[y][0] = T.WALL;
      map[y][MAP_W - 1] = T.WALL;
    }
    // Flower beds (rendered as RUG variant)
    fillRect(map, 2, 4, 4, 6, T.RUG);
    fillRect(map, 15, 4, 17, 6, T.RUG);
    // Fountain area in center
    fillRect(map, 8, 8, 11, 10, T.WATER);

    return {
      name: 'The Garden',
      description: 'Blooming with progress',
      tilemap: map,
      furniture: [
        // Workbenches (outdoor desks) along the path
        { type: 'desk',  x: 6,  y: 4,  id: 'desk-0' },
        { type: 'chair', x: 6,  y: 5,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'desk',  x: 13, y: 4,  id: 'desk-1' },
        { type: 'chair', x: 13, y: 5,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'desk',  x: 6,  y: 9,  id: 'desk-2' },
        { type: 'chair', x: 6,  y: 10, id: 'chair-2', deskId: 'desk-2' },
        { type: 'desk',  x: 13, y: 9,  id: 'desk-3' },
        { type: 'chair', x: 13, y: 10, id: 'chair-3', deskId: 'desk-3' },
        // Sunflower patches (decorative plants)
        { type: 'plant', x: 3,  y: 4, spritesheet: 'sunflowers', spriteRect: { sx: 0, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 3,  y: 6, spritesheet: 'sunflowers', spriteRect: { sx: 16, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 16, y: 4, spritesheet: 'sunflowers', spriteRect: { sx: 32, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 16, y: 6, spritesheet: 'sunflowers', spriteRect: { sx: 48, sy: 0, sw: 16, sh: 16 } },
        // Additional garden plants
        { type: 'plant', x: 2,  y: 12 },
        { type: 'plant', x: 17, y: 12 },
      ],
      interestPoints: [
        { x: 3,  y: 5,  label: 'flowers' },
        { x: 16, y: 5,  label: 'flowers' },
        { x: 7,  y: 8,  label: 'fountain' },
        { x: 12, y: 8,  label: 'fountain' },
        { x: 9,  y: 12, label: 'path' },
        { x: 10, y: 12, label: 'path' },
        { x: 5,  y: 2,  label: 'garden' },
        { x: 14, y: 2,  label: 'garden' },
      ],
      deskPositions: [
        { x: 6, y: 4 }, { x: 13, y: 4 },
        { x: 6, y: 9 }, { x: 13, y: 9 },
      ],
      ambient: {
        particleType: 'leaves',
        bgColor: '#0b1a0e',
        tilesheet: 'tiles-4-trees',
        propsSheet: 'props-spring',
      },
      drawBackground: null,
      // Fountain animation in the center water area
      drawForeground: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        // Fountain spray — animated water droplets rising from center
        const cx = 9.5 * SCALED_TILE;
        const cy = 9 * SCALED_TILE;
        const time = timestamp * 0.003;
        ctx.save();
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2 + time;
          const radius = SCALED_TILE * 0.6;
          const rise = (Math.sin(timestamp * 0.005 + i) * 0.5 + 0.5) * SCALED_TILE * 0.8;
          const dx = Math.cos(angle) * radius;
          const alpha = 0.3 + 0.3 * Math.sin(timestamp * 0.004 + i * 0.7);
          ctx.fillStyle = `rgba(120, 200, 255, ${alpha.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(cx + dx, cy - rise, SCALE * 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
      drawOverlay: null,
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 4: The Waterfront (integration / deployment)
  // ══════════════════════════════════════════════════════════════════
  const waterfront = (() => {
    const map = makeMap(T.FLOOR);
    // Top walls (warehouse back wall)
    fillRect(map, 0, 0, 19, 1, T.WALL);
    map[0][0] = T.WALL; map[0][19] = T.WALL;
    // Side walls
    for (let y = 0; y < MAP_H; y++) {
      map[y][0] = T.WALL;
    }
    // Dock floor (left 2/3)
    fillRect(map, 1, 2, 13, 13, T.FLOOR);
    // Water (right 1/3 — the harbor)
    fillRect(map, 14, 2, 19, 13, T.WATER);
    // Pier extending into water
    fillRect(map, 14, 6, 17, 7, T.FLOOR);
    // Crate staging area
    fillRect(map, 2, 10, 5, 12, T.RUG);

    return {
      name: 'The Waterfront',
      description: 'Shipping code to production',
      tilemap: map,
      furniture: [
        // Dock workstations
        { type: 'desk',  x: 3,  y: 4,  id: 'desk-0' },
        { type: 'chair', x: 3,  y: 5,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'desk',  x: 7,  y: 4,  id: 'desk-1' },
        { type: 'chair', x: 7,  y: 5,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'desk',  x: 11, y: 4,  id: 'desk-2' },
        { type: 'chair', x: 11, y: 5,  id: 'chair-2', deskId: 'desk-2' },
        { type: 'desk',  x: 7,  y: 8,  id: 'desk-3' },
        { type: 'chair', x: 7,  y: 9,  id: 'chair-3', deskId: 'desk-3' },
        // Pier bollards (decorative)
        { type: 'plant', x: 14, y: 5 },
        { type: 'plant', x: 17, y: 5 },
      ],
      interestPoints: [
        { x: 15, y: 6,  label: 'pier' },
        { x: 16, y: 7,  label: 'pier' },
        { x: 3,  y: 11, label: 'crates' },
        { x: 5,  y: 11, label: 'crates' },
        { x: 10, y: 12, label: 'dock' },
        { x: 6,  y: 7,  label: 'dock' },
        { x: 13, y: 9,  label: 'waterside' },
      ],
      deskPositions: [
        { x: 3, y: 4 }, { x: 7, y: 4 },
        { x: 11, y: 4 }, { x: 7, y: 8 },
      ],
      ambient: {
        particleType: 'sparkle',
        bgColor: '#0a1220',
        tilesheet: 'tiles-3-water',
        propsSheet: 'props-spring',
      },
      drawBackground: null,
      // Animated water shimmer on the harbor tiles
      drawForeground: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        ctx.save();
        for (let y = 2; y < MAP_H; y++) {
          for (let x = 14; x < MAP_W; x++) {
            // Skip pier tiles
            if (x >= 14 && x <= 17 && y >= 6 && y <= 7) continue;
            if (x === 0) continue; // wall column
            const px = x * SCALED_TILE;
            const py = y * SCALED_TILE;
            // Wave shimmer
            const wave = Math.sin(timestamp * 0.002 + x * 0.8 + y * 0.5) * 0.5 + 0.5;
            const alpha = 0.04 + wave * 0.06;
            ctx.fillStyle = `rgba(100, 180, 255, ${alpha.toFixed(3)})`;
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            // Horizontal wave lines
            const lineY = py + SCALED_TILE * 0.5 + Math.sin(timestamp * 0.003 + x) * SCALE * 2;
            ctx.fillStyle = `rgba(150, 210, 255, ${(alpha * 0.6).toFixed(3)})`;
            ctx.fillRect(px + SCALE * 2, lineY, SCALED_TILE - SCALE * 4, SCALE * 0.5);
          }
        }
        ctx.restore();
      },
      drawOverlay: null,
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 5: The Cave (debugging / deep investigation)
  // ══════════════════════════════════════════════════════════════════
  const cave = (() => {
    const map = makeMap(T.CAVE_FLOOR);
    // Irregular rocky walls — top 2 rows plus jagged edges
    fillRect(map, 0, 0, 19, 1, T.WALL);
    for (let y = 0; y < MAP_H; y++) {
      map[y][0] = T.WALL;
      map[y][MAP_W - 1] = T.WALL;
    }
    // Extra wall juts for cave feel
    map[2][1] = T.WALL; map[2][18] = T.WALL;
    map[3][1] = T.WALL;
    map[5][18] = T.WALL;
    map[10][1] = T.WALL; map[11][1] = T.WALL;
    map[9][18] = T.WALL; map[10][18] = T.WALL;
    // Bottom wall (cave back)
    fillRect(map, 0, 13, 19, 13, T.WALL);
    // Lava / mineral vein (decorative floor variant)
    map[7][5] = T.RUG; map[7][6] = T.RUG;
    map[8][14] = T.RUG; map[8][15] = T.RUG;

    return {
      name: 'The Cave',
      description: 'Deep in the debugging mines',
      tilemap: map,
      furniture: [
        // Mining workstations (crude desks)
        { type: 'desk',  x: 4,  y: 4,  id: 'desk-0' },
        { type: 'chair', x: 4,  y: 5,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'desk',  x: 10, y: 4,  id: 'desk-1' },
        { type: 'chair', x: 10, y: 5,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'desk',  x: 15, y: 4,  id: 'desk-2' },
        { type: 'chair', x: 15, y: 5,  id: 'chair-2', deskId: 'desk-2' },
        { type: 'desk',  x: 8,  y: 9,  id: 'desk-3' },
        { type: 'chair', x: 8,  y: 10, id: 'chair-3', deskId: 'desk-3' },
        { type: 'desk',  x: 14, y: 9,  id: 'desk-4' },
        { type: 'chair', x: 14, y: 10, id: 'chair-4', deskId: 'desk-4' },
        // Crystal pillars (use rock-pillars spritesheet)
        { type: 'plant', x: 3,  y: 7,  spritesheet: 'rock-pillars', spriteRect: { sx: 0, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 16, y: 7,  spritesheet: 'rock-pillars', spriteRect: { sx: 32, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 9,  y: 11, spritesheet: 'rock-pillars', spriteRect: { sx: 64, sy: 0, sw: 16, sh: 16 } },
      ],
      interestPoints: [
        { x: 5,  y: 7,  label: 'mineral' },
        { x: 7,  y: 7,  label: 'mineral' },
        { x: 13, y: 8,  label: 'mineral' },
        { x: 16, y: 8,  label: 'crystal' },
        { x: 3,  y: 6,  label: 'crystal' },
        { x: 10, y: 11, label: 'passage' },
        { x: 6,  y: 12, label: 'passage' },
      ],
      deskPositions: [
        { x: 4, y: 4 }, { x: 10, y: 4 }, { x: 15, y: 4 },
        { x: 8, y: 9 }, { x: 14, y: 9 },
      ],
      ambient: {
        particleType: 'sparkle',
        bgColor: '#0a0a0f',
        tilesheet: 'tiles-1-spring',
        propsSheet: 'props-spring',
      },
      drawBackground: null,
      drawForeground: null,
      // Dark overlay with torch light circles
      drawOverlay: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        // Full dark wash
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, cw, ch);

        // Torch positions — near desks and crystals
        const torches = [
          { x: 3,  y: 3 },
          { x: 11, y: 3 },
          { x: 16, y: 3 },
          { x: 3,  y: 8 },
          { x: 9,  y: 8 },
          { x: 15, y: 8 },
          { x: 7,  y: 12 },
        ];

        // Cut light circles out of the darkness
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        for (const torch of torches) {
          const tx = torch.x * SCALED_TILE + SCALED_TILE / 2;
          const ty = torch.y * SCALED_TILE + SCALED_TILE / 2;
          const flicker = 1.0 + 0.08 * Math.sin(timestamp * 0.006 + torch.x * 2 + torch.y);
          const radius = SCALED_TILE * 2.5 * flicker;
          const grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, radius);
          grad.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
          grad.addColorStop(0.6, 'rgba(0, 0, 0, 0.25)');
          grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(tx, ty, radius, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // Warm torchlight color overlay
        ctx.save();
        for (const torch of torches) {
          const tx = torch.x * SCALED_TILE + SCALED_TILE / 2;
          const ty = torch.y * SCALED_TILE + SCALED_TILE / 2;
          const flicker = 1.0 + 0.08 * Math.sin(timestamp * 0.006 + torch.x * 2 + torch.y);
          const radius = SCALED_TILE * 2 * flicker;
          const grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, radius);
          grad.addColorStop(0, 'rgba(255, 160, 60, 0.12)');
          grad.addColorStop(0.5, 'rgba(255, 120, 30, 0.05)');
          grad.addColorStop(1, 'rgba(255, 100, 20, 0)');
          ctx.fillStyle = grad;
          ctx.fillRect(tx - radius, ty - radius, radius * 2, radius * 2);
        }
        ctx.restore();
      },
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 6: The Winter Lodge (night / off-hours / low activity)
  // ══════════════════════════════════════════════════════════════════
  const winterLodge = (() => {
    const map = makeMap(T.FLOOR);
    addWalls(map);
    // Snow piles along bottom (outside visible through windows concept)
    fillRect(map, 1, 12, 18, 13, T.SNOW);
    // Fireplace alcove in top-center wall
    fillRect(map, 8, 2, 11, 2, T.RUG); // hearth
    // Cozy rug around fireplace
    fillRect(map, 7, 3, 12, 5, T.RUG);
    // Side corridors of snow-dusted floor
    fillRect(map, 1, 2, 3, 4, T.SNOW);
    fillRect(map, 16, 2, 18, 4, T.SNOW);

    return {
      name: 'The Winter Lodge',
      description: 'Cozy warmth on a cold night',
      tilemap: map,
      furniture: [
        // Fireside desks
        { type: 'desk',  x: 4,  y: 6,  id: 'desk-0' },
        { type: 'chair', x: 4,  y: 7,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'monitor', x: 4,  y: 6,  id: 'monitor-0', active: false },
        { type: 'desk',  x: 15, y: 6,  id: 'desk-1' },
        { type: 'chair', x: 15, y: 7,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'monitor', x: 15, y: 6,  id: 'monitor-1', active: false },
        { type: 'desk',  x: 4,  y: 9,  id: 'desk-2' },
        { type: 'chair', x: 4,  y: 10, id: 'chair-2', deskId: 'desk-2' },
        { type: 'monitor', x: 4,  y: 9,  id: 'monitor-2', active: false },
        { type: 'desk',  x: 15, y: 9,  id: 'desk-3' },
        { type: 'chair', x: 15, y: 10, id: 'chair-3', deskId: 'desk-3' },
        { type: 'monitor', x: 15, y: 9,  id: 'monitor-3', active: false },
        // Fireplace (custom furniture)
        { type: 'fireplace', x: 9, y: 2, id: 'fireplace' },
        // Indoor plants
        { type: 'plant', x: 2,  y: 6 },
        { type: 'plant', x: 17, y: 6 },
      ],
      interestPoints: [
        { x: 8,  y: 4,  label: 'fireplace' },
        { x: 11, y: 4,  label: 'fireplace' },
        { x: 9,  y: 5,  label: 'fireplace' },
        { x: 3,  y: 6,  label: 'plant' },
        { x: 16, y: 6,  label: 'plant' },
        { x: 10, y: 8,  label: 'lounge' },
        { x: 10, y: 11, label: 'window' },
      ],
      deskPositions: [
        { x: 4, y: 6 }, { x: 15, y: 6 },
        { x: 4, y: 9 }, { x: 15, y: 9 },
      ],
      ambient: {
        particleType: 'snow',
        bgColor: '#0c1019',
        tilesheet: 'tiles-5-ice',
        propsSheet: 'props-winter',
      },
      drawBackground: null,
      // Fireplace glow and embers
      drawForeground: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        // Fireplace flame
        const fx = 9.5 * SCALED_TILE;
        const fy = 2 * SCALED_TILE + SCALED_TILE * 0.5;
        // Flickering fire base
        for (let i = 0; i < 5; i++) {
          const flicker = Math.sin(timestamp * 0.008 + i * 1.5) * SCALE * 2;
          const height = SCALE * (6 + Math.sin(timestamp * 0.01 + i * 2) * 3);
          const width = SCALE * (2 + Math.sin(timestamp * 0.006 + i) * 1);
          const ox = (i - 2) * SCALE * 3;
          ctx.fillStyle = i % 2 === 0
            ? `rgba(255, 140, 30, ${0.6 + Math.sin(timestamp * 0.007 + i) * 0.2})`
            : `rgba(255, 200, 60, ${0.5 + Math.sin(timestamp * 0.009 + i) * 0.2})`;
          ctx.beginPath();
          ctx.ellipse(fx + ox, fy - flicker, width, height, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // Ember particles
        for (let i = 0; i < 3; i++) {
          const age = (timestamp * 0.002 + i * 2.1) % 3.0;
          const ex = fx + Math.sin(timestamp * 0.003 + i * 4) * SCALE * 6;
          const ey = fy - age * SCALED_TILE * 0.5;
          const alpha = Math.max(0, 1 - age / 3.0);
          ctx.fillStyle = `rgba(255, 100, 20, ${(alpha * 0.7).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(ex, ey, SCALE * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
      },
      // Warm glow wash from fireplace
      drawOverlay: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        const fx = 9.5 * SCALED_TILE;
        const fy = 3 * SCALED_TILE;
        const pulse = 1.0 + 0.05 * Math.sin(timestamp * 0.004);
        const radius = SCALED_TILE * 6 * pulse;
        const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
        grad.addColorStop(0, 'rgba(255, 150, 50, 0.06)');
        grad.addColorStop(0.4, 'rgba(255, 120, 30, 0.03)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cw, ch);
      },
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 7: The Harvest Field (sprint completion / review)
  // ══════════════════════════════════════════════════════════════════
  const harvestField = (() => {
    const map = makeMap(T.GRASS);
    // Fence walls top and sides
    fillRect(map, 0, 0, 19, 1, T.WALL);
    for (let y = 0; y < MAP_H; y++) {
      map[y][0] = T.WALL;
      map[y][MAP_W - 1] = T.WALL;
    }
    // Dirt path
    for (let y = 2; y < MAP_H; y++) {
      map[y][9] = T.FLOOR;
      map[y][10] = T.FLOOR;
    }
    // Pumpkin patch areas (rendered as rug — warm dirt)
    fillRect(map, 2, 3, 5, 5, T.RUG);
    fillRect(map, 14, 3, 17, 5, T.RUG);
    fillRect(map, 2, 9, 5, 11, T.RUG);
    fillRect(map, 14, 9, 17, 11, T.RUG);

    return {
      name: 'The Harvest Field',
      description: 'Reaping the sprint rewards',
      tilemap: map,
      furniture: [
        // Harvest workstations along the central path
        { type: 'desk',  x: 7,  y: 4,  id: 'desk-0' },
        { type: 'chair', x: 7,  y: 5,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'desk',  x: 12, y: 4,  id: 'desk-1' },
        { type: 'chair', x: 12, y: 5,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'desk',  x: 7,  y: 9,  id: 'desk-2' },
        { type: 'chair', x: 7,  y: 10, id: 'chair-2', deskId: 'desk-2' },
        { type: 'desk',  x: 12, y: 9,  id: 'desk-3' },
        { type: 'chair', x: 12, y: 10, id: 'chair-3', deskId: 'desk-3' },
        // Pumpkins (decorative plant items referencing pumpkins.png)
        { type: 'plant', x: 3,  y: 4,  spritesheet: 'pumpkins', spriteRect: { sx: 0,  sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 4,  y: 3,  spritesheet: 'pumpkins', spriteRect: { sx: 16, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 15, y: 4,  spritesheet: 'pumpkins', spriteRect: { sx: 32, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 16, y: 3,  spritesheet: 'pumpkins', spriteRect: { sx: 48, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 3,  y: 10, spritesheet: 'pumpkins', spriteRect: { sx: 64, sy: 0, sw: 16, sh: 16 } },
        { type: 'plant', x: 15, y: 10, spritesheet: 'pumpkins', spriteRect: { sx: 0,  sy: 16, sw: 16, sh: 16 } },
        // Trees at edges
        { type: 'plant', x: 2,  y: 7 },
        { type: 'plant', x: 17, y: 7 },
      ],
      interestPoints: [
        { x: 3,  y: 5,  label: 'pumpkin' },
        { x: 5,  y: 4,  label: 'pumpkin' },
        { x: 14, y: 4,  label: 'pumpkin' },
        { x: 16, y: 5,  label: 'pumpkin' },
        { x: 4,  y: 11, label: 'pumpkin' },
        { x: 15, y: 11, label: 'pumpkin' },
        { x: 9,  y: 7,  label: 'path' },
        { x: 10, y: 12, label: 'path' },
      ],
      deskPositions: [
        { x: 7, y: 4 }, { x: 12, y: 4 },
        { x: 7, y: 9 }, { x: 12, y: 9 },
      ],
      ambient: {
        particleType: 'leaves',
        bgColor: '#15100a',
        tilesheet: 'tiles-4-trees',
        propsSheet: 'props-autumn',
      },
      drawBackground: null,
      drawForeground: null,
      // Warm golden-hour wash
      drawOverlay: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        const grad = ctx.createLinearGradient(0, 0, 0, ch);
        grad.addColorStop(0, 'rgba(255, 180, 60, 0.06)');
        grad.addColorStop(0.5, 'rgba(255, 140, 40, 0.03)');
        grad.addColorStop(1, 'rgba(200, 100, 20, 0.05)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cw, ch);
      },
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // SCENE 8: The Cliff Overlook (idle / AFK / screensaver)
  // ══════════════════════════════════════════════════════════════════
  const cliffOverlook = (() => {
    const map = makeMap(T.GRASS);
    // Sky/void at top (just wall for boundary)
    fillRect(map, 0, 0, 19, 1, T.WALL);
    // Cliff face on the right edge
    fillRect(map, 16, 0, 19, 13, T.CLIFF);
    // Waterfall channel
    map[2][17] = T.WATER; map[3][17] = T.WATER;
    map[4][17] = T.WATER; map[5][17] = T.WATER;
    map[6][17] = T.WATER; map[7][17] = T.WATER;
    map[8][17] = T.WATER; map[9][17] = T.WATER;
    map[10][17] = T.WATER; map[11][17] = T.WATER;
    map[12][17] = T.WATER; map[13][17] = T.WATER;
    // Pool at the base
    fillRect(map, 13, 11, 16, 13, T.WATER);
    // Walkable cliff side path
    for (let y = 2; y < MAP_H; y++) {
      map[y][15] = T.GRASS;
    }
    // Left wall (cliff edge / boundary)
    for (let y = 0; y < MAP_H; y++) {
      map[y][0] = T.WALL;
    }
    // Stone seating area
    fillRect(map, 4, 7, 7, 8, T.FLOOR);

    return {
      name: 'The Cliff Overlook',
      description: 'Contemplation and rest',
      tilemap: map,
      furniture: [
        // Minimal — just 4 meditation spots (benches)
        { type: 'desk',  x: 4,  y: 7,  id: 'desk-0' },
        { type: 'chair', x: 4,  y: 8,  id: 'chair-0', deskId: 'desk-0' },
        { type: 'desk',  x: 7,  y: 7,  id: 'desk-1' },
        { type: 'chair', x: 7,  y: 8,  id: 'chair-1', deskId: 'desk-1' },
        { type: 'desk',  x: 4,  y: 4,  id: 'desk-2' },
        { type: 'chair', x: 4,  y: 5,  id: 'chair-2', deskId: 'desk-2' },
        { type: 'desk',  x: 10, y: 5,  id: 'desk-3' },
        { type: 'chair', x: 10, y: 6,  id: 'chair-3', deskId: 'desk-3' },
        // Trees
        { type: 'plant', x: 2,  y: 3 },
        { type: 'plant', x: 8,  y: 3 },
        { type: 'plant', x: 2,  y: 10 },
        { type: 'plant', x: 11, y: 10 },
      ],
      interestPoints: [
        { x: 14, y: 10, label: 'pool' },
        { x: 14, y: 12, label: 'pool' },
        { x: 15, y: 5,  label: 'waterfall' },
        { x: 15, y: 8,  label: 'waterfall' },
        { x: 6,  y: 4,  label: 'overlook' },
        { x: 3,  y: 10, label: 'tree' },
        { x: 9,  y: 10, label: 'tree' },
        { x: 7,  y: 12, label: 'meadow' },
      ],
      deskPositions: [
        { x: 4, y: 7 }, { x: 7, y: 7 },
        { x: 4, y: 4 }, { x: 10, y: 5 },
      ],
      ambient: {
        particleType: 'sparkle',
        bgColor: '#0d1520',
        tilesheet: 'tiles-4-trees',
        propsSheet: 'props-spring',
      },
      // Distant sky gradient behind the cliff
      drawBackground: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        const grad = ctx.createLinearGradient(0, 0, 0, ch);
        grad.addColorStop(0, '#1a2744');
        grad.addColorStop(0.3, '#1e3050');
        grad.addColorStop(0.7, '#152030');
        grad.addColorStop(1, '#0d1520');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cw, ch);
      },
      // Waterfall animation and mist
      drawForeground: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        ctx.save();
        // Waterfall column — animated white streaks falling
        const wfX = 17 * SCALED_TILE;
        for (let y = 2; y <= 13; y++) {
          const py = y * SCALED_TILE;
          // Multiple falling streaks per tile
          for (let s = 0; s < 3; s++) {
            const offset = ((timestamp * 0.15 + s * 80 + y * 30) % (SCALED_TILE * 2));
            const sx = wfX + SCALE * (3 + s * 4);
            const sy = py + offset - SCALED_TILE;
            const alpha = 0.2 + 0.15 * Math.sin(timestamp * 0.005 + s + y);
            ctx.fillStyle = `rgba(200, 230, 255, ${alpha.toFixed(2)})`;
            ctx.fillRect(sx, sy, SCALE * 2, SCALE * 6);
          }
        }

        // Mist at the pool base
        for (let i = 0; i < 6; i++) {
          const mx = (13 + Math.sin(timestamp * 0.001 + i * 1.5) * 2) * SCALED_TILE;
          const my = 11.5 * SCALED_TILE + Math.sin(timestamp * 0.002 + i) * SCALE * 4;
          const radius = SCALED_TILE * (1.2 + 0.3 * Math.sin(timestamp * 0.003 + i));
          const alpha = 0.06 + 0.04 * Math.sin(timestamp * 0.002 + i * 0.8);
          const grad = ctx.createRadialGradient(mx, my, 0, mx, my, radius);
          grad.addColorStop(0, `rgba(200, 220, 255, ${alpha.toFixed(3)})`);
          grad.addColorStop(1, 'rgba(200, 220, 255, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(mx, my, radius, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
      // Subtle cloud shadows drifting across
      drawOverlay: function(ctx, SCALE, SCALED_TILE, timestamp, cw, ch) {
        ctx.save();
        const cloudX = ((timestamp * 0.01) % (cw + SCALED_TILE * 8)) - SCALED_TILE * 4;
        const grad = ctx.createRadialGradient(cloudX, ch * 0.3, 0, cloudX, ch * 0.3, SCALED_TILE * 5);
        grad.addColorStop(0, 'rgba(0, 0, 20, 0.06)');
        grad.addColorStop(1, 'rgba(0, 0, 20, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cw, ch);

        const cloudX2 = ((timestamp * 0.007 + cw * 0.5) % (cw + SCALED_TILE * 8)) - SCALED_TILE * 4;
        const grad2 = ctx.createRadialGradient(cloudX2, ch * 0.5, 0, cloudX2, ch * 0.5, SCALED_TILE * 4);
        grad2.addColorStop(0, 'rgba(0, 0, 20, 0.04)');
        grad2.addColorStop(1, 'rgba(0, 0, 20, 0)');
        ctx.fillStyle = grad2;
        ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
      },
    };
  })();

  // ══════════════════════════════════════════════════════════════════
  // Scene Registry
  // ══════════════════════════════════════════════════════════════════
  const scenes = {
    workshop,
    library,
    garden,
    waterfront,
    cave,
    winterLodge,
    harvestField,
    cliffOverlook,
  };

  // ══════════════════════════════════════════════════════════════════
  // Scene Transition System
  // ══════════════════════════════════════════════════════════════════
  const transition = {
    type: 'fade',
    durationMs: 800,
    _active: false,
    _startTime: 0,
    _from: null,
    _to: null,

    // Returns current transition alpha (0 = old scene, 1 = new scene)
    // Returns null if no transition is in progress.
    getTransitionState: function() {
      if (!this._active) return null;
      const elapsed = performance.now() - this._startTime;
      if (elapsed >= this.durationMs) {
        this._active = false;
        return null; // transition complete
      }
      // Smooth ease-in-out
      const t = elapsed / this.durationMs;
      return t * t * (3 - 2 * t); // smoothstep
    },

    // Begin a transition between two scenes.
    // fromScene / toScene are scene key strings (e.g. 'workshop').
    start: function(fromScene, toScene) {
      if (this._active) return; // don't interrupt a running transition
      this._active = true;
      this._startTime = performance.now();
      this._from = fromScene;
      this._to = toScene;
    },

    // Check if a transition is currently running.
    isActive: function() {
      if (!this._active) return false;
      if (performance.now() - this._startTime >= this.durationMs) {
        this._active = false;
        return false;
      }
      return true;
    },

    // The scene that should be rendered underneath (fading out).
    getFromScene: function() { return this._from; },

    // The scene that should be rendered on top (fading in).
    getToScene: function() { return this._to; },
  };

  // ══════════════════════════════════════════════════════════════════
  // Auto-Scene Suggestion Logic
  // ══════════════════════════════════════════════════════════════════

  function suggestScene(context) {
    // context: {
    //   knightCount, agentCount, lastActivityMs, timeOfDay,
    //   season, messageTypes (array of recent message type strings)
    // }
    const {
      knightCount = 0,
      agentCount = 0,
      lastActivityMs = Date.now(),
      timeOfDay = 'day',
      season = 'spring',
      messageTypes = [],
    } = context || {};

    const now = Date.now();
    const idleMs = now - lastActivityMs;

    // 1) AFK for 10+ minutes -> Cliff Overlook (screensaver)
    if (idleMs >= TRANSITION_RULES.idleTimeout) {
      return 'cliffOverlook';
    }

    // 2) Night hours with low activity -> Winter Lodge
    if ((timeOfDay === 'night' || timeOfDay === 'evening') && agentCount <= 1) {
      return 'winterLodge';
    }

    // 3) Autumn season and sprint-review messages -> Harvest Field
    if (season === 'autumn' || messageTypes.includes('task') || messageTypes.includes('status_update')) {
      const taskCount = messageTypes.filter(t => t === 'task' || t === 'status_update').length;
      if (taskCount >= 3) return 'harvestField';
    }

    // 4) Debugging / investigation messages -> Cave
    const debugTypes = ['question', 'answer', 'insight'];
    const debugCount = messageTypes.filter(t => debugTypes.includes(t)).length;
    if (debugCount >= 4 || knightCount >= 3) {
      return 'cave';
    }

    // 5) Deployment / integration context -> Waterfront
    if (messageTypes.includes('api-docs') || messageTypes.includes('architecture')) {
      return 'waterfront';
    }

    // 6) Research / planning phase -> Library
    if (messageTypes.includes('patterns') || messageTypes.includes('conventions')) {
      return 'library';
    }

    // 7) Healthy activity with completions -> Garden
    if (agentCount >= 2 && idleMs < 120000) {
      return 'garden';
    }

    // 8) Default -> Workshop
    return 'workshop';
  }

  // ══════════════════════════════════════════════════════════════════
  // Extended Tile Colors (for pixel-agents.js drawTilemap to consume)
  // ══════════════════════════════════════════════════════════════════
  const TILE_COLORS = {
    [T.WATER]:      { base: '#1a3a5c', alt: '#1e4470' },
    [T.BOOKSHELF]:  { base: '#3d2b1a', alt: '#4a3420' },
    [T.CAVE_FLOOR]: { base: '#1a1a22', alt: '#1e1e28' },
    [T.SNOW]:       { base: '#c8d6e5', alt: '#d5e0ed' },
    [T.GRASS]:      { base: '#1a3320', alt: '#1e3825' },
    [T.CLIFF]:      { base: '#2a2530', alt: '#322e38' },
  };

  // ══════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════
  return {
    scenes,
    transition,
    suggestScene,
    TRANSITION_RULES,
    TILE_TYPES: T,
    TILE_COLORS,
  };
})();
