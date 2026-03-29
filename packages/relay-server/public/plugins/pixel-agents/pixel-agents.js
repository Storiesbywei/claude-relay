// === Pixel Agents — Visualization Layer for Claude Relay ===
// Renders animated pixel art characters (Pixel Plains sprites by SnowHex)
// in a tile-based environment. Each relay participant spawns as a sprite;
// status_update messages drive animations.
// Asset credit: Pixel Plains by SnowHex (snowhex.itch.io/pixel-plains)

const PixelAgents = (() => {
  // ── Config ──
  const TILE_SIZE = 16;
  const CHAR_SIZE = 24;   // character sprite frame size
  const SCALE = 3;        // integer zoom for crisp pixels
  const SCALED_TILE = TILE_SIZE * SCALE;
  const SCALED_CHAR = CHAR_SIZE * SCALE;
  const FPS = 10;         // pixel art looks best at low frame rates
  const FRAME_MS = 1000 / FPS;

  // Grid dimensions (tiles)
  const MAP_W = 20;
  const MAP_H = 14;

  // ── Colors (matches relay dashboard dark theme) ──
  const COLORS = {
    bg:         '#0d1117',
    floor:      '#161b22',
    floorAlt:   '#1c2129',
    wall:       '#30363d',
    wallTop:    '#3d444d',
    desk:       '#2d333b',
    deskTop:    '#3d444d',
    monitor:    '#58a6ff',
    monitorOff: '#21262d',
    chair:      '#1f2937',
    plant:      '#3fb950',
    plantPot:   '#6e4a2a',
    rug:        '#7c6aef15',
    shadow:     '#00000040',
    gridLine:   '#ffffff08',
  };

  // ── Sprite Sheet Layout (Pixel Plains 24x24 characters) ──
  // Each sheet is 216×120 px = 9 cols × 5 rows of 24×24 frames
  // Row 0: walk down (6 frames)   cols 0-5, idle hints in 6-8
  // Row 1: walk down alt / idle   cols 0-2
  // Row 2: walk side (8 frames)   cols 0-7
  // Row 3: single poses           col 0 (sit/hurt)
  // Row 4: sit / death            cols 0-1
  const SHEET = {
    cols: 9,
    rows: 5,
    frameW: 24,
    frameH: 24,
    // Animation definitions: [row, startCol, frameCount]
    walkDown:  [0, 0, 6],
    idleDown:  [0, 0, 2],  // first 2 frames of walk = idle bob
    walkSide:  [2, 0, 8],
    idleSide:  [2, 0, 2],
    sit:       [4, 0, 2],  // sitting at desk
    single:    [3, 0, 1],  // single pose
  };

  // Character sprite files (assigned to agents in order)
  const CHAR_SPRITES = [
    'main-v1.png',
    'char-01-v1.png',
    'char-03-v1.png',
    'char-05-v1.png',
    'char-07-v1.png',
    'char-10-v1.png',
    'gato-v1.png',
    'bunny-v1.png',
    'spring-01-v1.png',
    'autumn-01-v1.png',
    'winter-01-v1.png',
  ];

  // Label colors for name tags
  const LABEL_COLORS = [
    '#58a6ff', '#7c6aef', '#f0883e', '#3fb950', '#f85149', '#db61a2',
    '#58a6ff', '#7c6aef', '#f0883e', '#3fb950', '#f85149',
  ];

  // ── Season & Time-of-Day ──

  function getCurrentSeason() {
    const month = new Date().getMonth(); // 0-11
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'autumn';
    return 'winter';
  }

  function getTimeOfDay() {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 8)   return 'sunrise';
    if (hour >= 8 && hour < 17)  return 'day';
    if (hour >= 17 && hour < 19) return 'sunset';
    if (hour >= 19 && hour < 22) return 'evening';
    return 'night';
  }

  let currentSeason = getCurrentSeason();
  let currentTimeOfDay = getTimeOfDay();
  let seasonCheckTimer = 0;
  const SEASON_CHECK_INTERVAL = 60000; // re-check every 60s

  // ── Day/Night Overlay ──

  const TIME_TINTS = {
    sunrise: { r: 255, g: 200, b: 100, a: 0.08 },
    day:     null, // no tint
    sunset:  { r: 255, g: 150, b: 50,  a: 0.1 },
    evening: { r: 30,  g: 40,  b: 80,  a: 0.15 },
    night:   { r: 10,  g: 15,  b: 40,  a: 0.25 },
  };

  // Pre-generated star positions (stable across frames)
  const STARS = [];
  for (let i = 0; i < 30; i++) {
    STARS.push({
      x: Math.random(),
      y: Math.random() * 0.4, // upper 40% of canvas
      size: 0.5 + Math.random() * 1.0,
      twinkleSpeed: 0.001 + Math.random() * 0.003,
      twinkleOffset: Math.random() * Math.PI * 2,
    });
  }

  function drawTimeOverlay(timestamp) {
    const tint = TIME_TINTS[currentTimeOfDay];
    if (!tint) return; // daytime — no overlay

    ctx.fillStyle = `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${tint.a})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Stars only at night
    if (currentTimeOfDay === 'night') {
      for (const star of STARS) {
        const brightness = 0.4 + 0.6 * Math.abs(Math.sin(timestamp * star.twinkleSpeed + star.twinkleOffset));
        const px = star.x * canvas.width;
        const py = star.y * canvas.height;
        ctx.fillStyle = `rgba(255, 255, 255, ${(brightness * 0.7).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(px, py, star.size * SCALE * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ── Particle System ──

  const MAX_PARTICLES = 50;
  const particles = [];
  let particleSpawnTimer = 0;
  const PARTICLE_SPAWN_INTERVAL = 2500; // ms between ambient spawns

  // Season → particle type and palette
  const SEASON_PARTICLES = {
    spring: { type: 'leaves',  colors: ['#3fb950', '#56d364', '#8bd58b'], count: 2 },
    summer: { type: 'sparkle', colors: ['#ffd700', '#ffe066', '#fffacd'], count: 1 },
    autumn: { type: 'leaves',  colors: ['#f0883e', '#da3633', '#d29922', '#8b6914'], count: 2 },
    winter: { type: 'snow',    colors: ['#e6edf3', '#d1d9e0', '#ffffff'], count: 2 },
  };

  function spawnParticles(type, count) {
    const cfg = SEASON_PARTICLES[currentSeason];
    const colors = cfg ? cfg.colors : ['#ffffff'];

    for (let i = 0; i < count; i++) {
      if (particles.length >= MAX_PARTICLES) break;

      const color = colors[Math.floor(Math.random() * colors.length)];

      switch (type) {
        case 'leaves':
          particles.push({
            x: Math.random() * canvas.width,
            y: -SCALE * 2,
            vx: (Math.random() - 0.5) * 0.4 * SCALE,
            vy: (0.3 + Math.random() * 0.4) * SCALE,
            life: 0,
            maxLife: 4000 + Math.random() * 3000,
            size: (2 + Math.random() * 2) * SCALE * 0.4,
            color,
            type: 'leaves',
            swayOffset: Math.random() * Math.PI * 2,
            swaySpeed: 0.002 + Math.random() * 0.002,
          });
          break;
        case 'rain':
          particles.push({
            x: Math.random() * canvas.width,
            y: -SCALE * 2,
            vx: -0.2 * SCALE,
            vy: (2.5 + Math.random() * 1.5) * SCALE,
            life: 0,
            maxLife: 1500 + Math.random() * 1000,
            size: 1 * SCALE * 0.3,
            color: 'rgba(150, 200, 255, 0.5)',
            type: 'rain',
          });
          break;
        case 'sparkle':
          particles.push({
            x: SCALE * 10 + Math.random() * (canvas.width - SCALE * 20),
            y: SCALE * 10 + Math.random() * (canvas.height - SCALE * 20),
            vx: 0,
            vy: -0.1 * SCALE,
            life: 0,
            maxLife: 1000 + Math.random() * 1500,
            size: (1 + Math.random() * 1.5) * SCALE * 0.4,
            color,
            type: 'sparkle',
          });
          break;
        case 'snow':
          particles.push({
            x: Math.random() * canvas.width,
            y: -SCALE * 2,
            vx: (Math.random() - 0.5) * 0.2 * SCALE,
            vy: (0.15 + Math.random() * 0.25) * SCALE,
            life: 0,
            maxLife: 6000 + Math.random() * 4000,
            size: (1 + Math.random() * 2) * SCALE * 0.4,
            color,
            type: 'snow',
            swayOffset: Math.random() * Math.PI * 2,
            swaySpeed: 0.001 + Math.random() * 0.002,
          });
          break;
      }
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;

      if (p.life >= p.maxLife || p.y > canvas.height + SCALE * 4) {
        particles.splice(i, 1);
        continue;
      }

      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);

      // Sway for leaves and snow
      if (p.type === 'leaves' || p.type === 'snow') {
        p.x += Math.sin(p.life * p.swaySpeed + p.swayOffset) * 0.3 * SCALE * (dt / 16);
      }
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const fadeIn = Math.min(1, p.life / 500);
      const fadeOut = Math.min(1, (p.maxLife - p.life) / 500);
      const alpha = fadeIn * fadeOut;

      ctx.globalAlpha = alpha;

      switch (p.type) {
        case 'leaves': {
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.life * 0.002);
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
          break;
        }
        case 'rain': {
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x, p.y, p.size * 0.3, p.size * 3);
          break;
        }
        case 'sparkle': {
          ctx.fillStyle = p.color;
          const s = p.size * (0.5 + 0.5 * Math.sin(p.life * 0.008));
          ctx.fillRect(p.x - s / 2, p.y, s, SCALE * 0.3);
          ctx.fillRect(p.x, p.y - s / 2, SCALE * 0.3, s);
          break;
        }
        case 'snow': {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }

      ctx.globalAlpha = 1;
    }
  }

  // ── Idle Behavior Config ──
  const IDLE_MIN_MS = 8000;   // minimum idle before wandering (8s)
  const IDLE_MAX_MS = 15000;  // maximum idle before wandering (15s)
  const DESK_ACTIVITY_MIN_MS = 10000;  // min time before switching typing/reading (10s)
  const DESK_ACTIVITY_MAX_MS = 20000;  // max time before switching typing/reading (20s)
  const THINK_PAUSE_MS = 3000;         // thinking pause duration
  const CHAT_BUBBLE_MS = 3000;         // how long chat bubble lingers
  const WANDER_LINGER_MS = 3000;       // how long to stand at interest point

  // Points of interest agents can wander to (adjacent to furniture, not on top)
  const INTEREST_POINTS = [
    { x: 9,  y: 12, label: 'watercooler' },   // water cooler — stand beside it
    { x: 11, y: 12, label: 'watercooler' },   // water cooler — other side
    { x: 3,  y: 3,  label: 'plant' },          // beside plant at (2,3)
    { x: 16, y: 3,  label: 'plant' },          // beside plant at (17,3)
    { x: 3,  y: 8,  label: 'plant' },          // beside plant at (2,8)
    { x: 16, y: 8,  label: 'plant' },          // beside plant at (17,8)
    { x: 15, y: 12, label: 'plant' },          // beside plant at (16,12)
    { x: 10, y: 7,  label: 'lounge' },         // rug center
    { x: 8,  y: 7,  label: 'lounge' },         // rug left
  ];

  function randBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  // ── Scene-aware interest points ──
  function getInterestPoints() {
    if (SceneConfig && SceneConfig.scenes[currentScene]?.interestPoints) {
      return SceneConfig.scenes[currentScene].interestPoints;
    }
    return INTEREST_POINTS; // fallback to hardcoded
  }

  // ── State ──
  let canvas = null;
  let ctx = null;
  let animFrame = null;
  let lastTime = 0;
  let visible = false;
  let globalFrame = 0;  // animation frame counter

  // ── Scene System ──
  let currentScene = 'workshop';
  let SceneConfig = null; // set from window.PixelSceneConfig if available

  // ── Creature Config (from pixel-creatures.js) ──
  let CreatureConfig = null;
  const specialCreatures = new Map(); // id → creature state
  let specialSpawnTimer = 0;
  const SPECIAL_SPAWN_CHECK_INTERVAL = 5000; // check every 5s

  // ── Progression & Collaboration Systems ──
  let ProgressionConfig = null;
  let CollabConfig = null;
  let tensionEngine = null;
  let celebrationCascade = null;
  let relayLineManager = null;
  let progressionInitialized = false;

  // Prop sprite images for progression visuals
  const propImages = new Map(); // 'sunflowers' → Image, etc.

  // Loaded sprite images
  const spriteImages = new Map(); // filename → Image
  let shadowImg = null;
  let spritesLoaded = false;

  // Agents: Map<participantId, AgentState>
  const agents = new Map();
  let nextCharIdx = 0;

  // Environment
  let tilemap = [];
  let furniture = [];

  // ── Tile Types ──
  const TILE = {
    FLOOR: 0,
    WALL: 1,
    DESK: 2,
    CHAIR: 3,
    PLANT: 4,
    RUG: 5,
  };

  // ── Sprite Loading ──

  const SPECIAL_SPRITES = [
    'special-1-v1.png', 'special-2-v1.png', 'special-3-v1.png',
    'special-4-v1.png', 'basic-bunny-character-v1.png',
  ];
  const EXTRA_GATO_SPRITES = ['gato-4-v1.png', 'gato-5-v1.png'];

  function loadSprites() {
    let loaded = 0;
    let total = CHAR_SPRITES.length + 1 + SPECIAL_SPRITES.length; // +1 for shadow

    function onLoad() {
      loaded++;
      if (loaded >= total) spritesLoaded = true;
    }

    // Load shadow
    shadowImg = new Image();
    shadowImg.onload = onLoad;
    shadowImg.onerror = onLoad; // continue even if missing
    shadowImg.src = '/plugins/pixel-agents/assets/sprites/characters/shadow.png';

    // Load character sheets
    for (const file of CHAR_SPRITES) {
      const img = new Image();
      img.onload = onLoad;
      img.onerror = onLoad;
      img.src = `/plugins/pixel-agents/assets/sprites/characters/${file}`;
      spriteImages.set(file, img);
    }

    // Load special creature sprites
    for (const file of SPECIAL_SPRITES) {
      const img = new Image();
      img.onload = onLoad;
      img.onerror = onLoad;
      img.src = `/plugins/pixel-agents/assets/sprites/characters/${file}`;
      spriteImages.set(file, img);
    }

    // Load extra gato sprites (non-blocking — not counted in total)
    for (const file of EXTRA_GATO_SPRITES) {
      const img = new Image();
      img.src = `/plugins/pixel-agents/assets/sprites/characters/${file}`;
      gatoImages.set(file, img);
    }
  }

  // ── Scene-Aware Map Builder ──
  function buildSceneMap(sceneName) {
    SceneConfig = typeof PixelSceneConfig !== 'undefined' ? PixelSceneConfig : null;

    if (SceneConfig && SceneConfig.scenes[sceneName]) {
      const scene = SceneConfig.scenes[sceneName];
      currentScene = sceneName;

      // Use scene tilemap (deep copy)
      tilemap = scene.tilemap.map(row => [...row]);

      // Use scene furniture (shallow copy each item)
      furniture = scene.furniture.map(f => ({...f}));

      // Update COLORS.bg if scene has one
      if (scene.ambient && scene.ambient.bgColor) {
        COLORS.bg = scene.ambient.bgColor;
      }
    } else {
      // Fallback to original hardcoded Workshop
      buildDefaultWorkshop();
      currentScene = 'workshop';
    }
  }

  function buildDefaultWorkshop() {
    tilemap = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(TILE.FLOOR));

    // Walls
    for (let x = 0; x < MAP_W; x++) {
      tilemap[0][x] = TILE.WALL;
      tilemap[1][x] = TILE.WALL;
    }
    for (let y = 0; y < MAP_H; y++) {
      tilemap[y][0] = TILE.WALL;
      tilemap[y][MAP_W - 1] = TILE.WALL;
    }

    // Desk stations (up to 6)
    furniture = [];
    const deskPositions = [
      { x: 4, y: 4 },
      { x: 8, y: 4 },
      { x: 12, y: 4 },
      { x: 4, y: 9 },
      { x: 8, y: 9 },
      { x: 12, y: 9 },
    ];

    deskPositions.forEach((pos, i) => {
      furniture.push({ type: 'desk', x: pos.x, y: pos.y, id: `desk-${i}` });
      furniture.push({ type: 'chair', x: pos.x, y: pos.y + 1, id: `chair-${i}`, deskId: `desk-${i}` });
      furniture.push({ type: 'monitor', x: pos.x, y: pos.y, id: `monitor-${i}`, active: false });
    });

    // Plants
    furniture.push({ type: 'plant', x: 2, y: 3 });
    furniture.push({ type: 'plant', x: MAP_W - 3, y: 3 });
    furniture.push({ type: 'plant', x: 2, y: 8 });
    furniture.push({ type: 'plant', x: MAP_W - 3, y: 8 });
    furniture.push({ type: 'plant', x: 16, y: 12 });

    // Water cooler
    furniture.push({ type: 'watercooler', x: 10, y: 12 });

    // Rug in center
    for (let y = 6; y <= 7; y++) {
      for (let x = 6; x <= 14; x++) {
        tilemap[y][x] = TILE.RUG;
      }
    }
  }

  // ── BFS Pathfinding ──
  function findPath(sx, sy, ex, ey) {
    if (sx === ex && sy === ey) return [];
    const visited = new Set();
    const queue = [{ x: sx, y: sy, path: [] }];
    visited.add(`${sx},${sy}`);

    while (queue.length > 0) {
      const { x, y, path } = queue.shift();
      for (const { dx, dy } of [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }]) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;
        if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
        if (visited.has(key)) continue;
        const tileVal = tilemap[ny][nx];
        if (tileVal === TILE.WALL || tileVal === 6 /* WATER */ || tileVal === 7 /* BOOKSHELF */ || tileVal === 11 /* CLIFF */) continue;
        if (furniture.some(f => (f.type === 'desk' || f.type === 'plant' || f.type === 'watercooler') && f.x === nx && f.y === ny)) continue;

        const newPath = [...path, { x: nx, y: ny }];
        if (nx === ex && ny === ey) return newPath;
        visited.add(key);
        queue.push({ x: nx, y: ny, path: newPath });
      }
    }
    return [];
  }

  // ── Rendering: Tilemap & Furniture ──

  function drawTilemap(timestamp) {
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const tile = tilemap[y][x];
        const px = x * SCALED_TILE;
        const py = y * SCALED_TILE;

        switch (tile) {
          case TILE.FLOOR:
            ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.floor : COLORS.floorAlt;
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            break;
          case TILE.WALL:
            ctx.fillStyle = COLORS.wall;
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            if (y === 0 || tilemap[y - 1]?.[x] !== TILE.WALL) {
              ctx.fillStyle = COLORS.wallTop;
              ctx.fillRect(px, py, SCALED_TILE, SCALE * 3);
            }
            break;
          case TILE.RUG:
            ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.floor : COLORS.floorAlt;
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            ctx.fillStyle = COLORS.rug;
            ctx.fillRect(px + SCALE, py + SCALE, SCALED_TILE - SCALE * 2, SCALED_TILE - SCALE * 2);
            break;
          case 6: // WATER
            ctx.fillStyle = '#1a3a5c';
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            // Animated shimmer
            const shimmer = Math.sin(timestamp * 0.002 + x * 0.5 + y * 0.3) * 0.05;
            ctx.fillStyle = `rgba(88, 166, 255, ${0.15 + shimmer})`;
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            break;
          case 7: // BOOKSHELF
            ctx.fillStyle = '#3d2b1f';
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            ctx.fillStyle = '#6e4a2a';
            ctx.fillRect(px + SCALE, py + SCALE, SCALED_TILE - SCALE*2, SCALED_TILE - SCALE*2);
            break;
          case 8: // CAVE_FLOOR
            ctx.fillStyle = '#1a1a2e';
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            if ((x + y) % 3 === 0) {
              ctx.fillStyle = '#16213e';
              ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            }
            break;
          case 9: // SNOW
            ctx.fillStyle = '#e8edf2';
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            if ((x + y) % 2 === 0) {
              ctx.fillStyle = '#f0f4f8';
              ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            }
            break;
          case 10: // GRASS
            ctx.fillStyle = '#2d5016';
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            if ((x + y) % 2 === 0) {
              ctx.fillStyle = '#3a6b1e';
              ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            }
            break;
          case 11: // CLIFF
            ctx.fillStyle = '#4a3728';
            ctx.fillRect(px, py, SCALED_TILE, SCALED_TILE);
            ctx.fillStyle = '#5c4a3a';
            ctx.fillRect(px, py, SCALED_TILE, SCALE * 3);
            break;
        }
        // Grid lines
        ctx.fillStyle = COLORS.gridLine;
        ctx.fillRect(px, py, SCALED_TILE, 1);
        ctx.fillRect(px, py, 1, SCALED_TILE);
      }
    }
  }

  function drawFurniture() {
    for (const item of furniture) {
      const px = item.x * SCALED_TILE;
      const py = item.y * SCALED_TILE;

      switch (item.type) {
        case 'desk':
          ctx.fillStyle = COLORS.shadow;
          ctx.fillRect(px + SCALE * 2, py + SCALED_TILE - SCALE * 2, SCALED_TILE - SCALE * 2, SCALE * 4);
          ctx.fillStyle = COLORS.desk;
          ctx.fillRect(px + SCALE, py + SCALE * 2, SCALED_TILE - SCALE * 2, SCALED_TILE - SCALE * 4);
          ctx.fillStyle = COLORS.deskTop;
          ctx.fillRect(px + SCALE, py + SCALE * 2, SCALED_TILE - SCALE * 2, SCALE * 3);
          break;
        case 'monitor': {
          const active = item.active;
          ctx.fillStyle = '#21262d';
          ctx.fillRect(px + SCALE * 5, py + SCALE * 4, SCALE * 6, SCALE * 5);
          ctx.fillStyle = active ? COLORS.monitor : COLORS.monitorOff;
          ctx.fillRect(px + SCALE * 6, py + SCALE * 5, SCALE * 4, SCALE * 3);
          if (active) {
            ctx.fillStyle = 'rgba(88, 166, 255, 0.15)';
            ctx.fillRect(px + SCALE * 3, py + SCALE * 2, SCALE * 10, SCALE * 9);
            ctx.fillStyle = 'rgba(230, 237, 243, 0.6)';
            for (let i = 0; i < 2; i++) {
              ctx.fillRect(px + SCALE * 7, py + SCALE * (6 + i), SCALE * 2, SCALE * 0.5);
            }
          }
          ctx.fillStyle = '#21262d';
          ctx.fillRect(px + SCALE * 7, py + SCALE * 9, SCALE * 2, SCALE * 2);
          break;
        }
        case 'chair':
          ctx.fillStyle = COLORS.chair;
          ctx.fillRect(px + SCALE * 3, py + SCALE * 2, SCALED_TILE - SCALE * 6, SCALED_TILE - SCALE * 4);
          ctx.fillStyle = '#2d333b';
          ctx.fillRect(px + SCALE * 3, py + SCALE * 2, SCALED_TILE - SCALE * 6, SCALE * 3);
          break;
        case 'plant':
          ctx.fillStyle = COLORS.plantPot;
          ctx.fillRect(px + SCALE * 5, py + SCALE * 8, SCALE * 6, SCALE * 5);
          ctx.fillRect(px + SCALE * 4, py + SCALE * 7, SCALE * 8, SCALE * 2);
          ctx.fillStyle = COLORS.plant;
          ctx.fillRect(px + SCALE * 5, py + SCALE * 2, SCALE * 6, SCALE * 6);
          ctx.fillRect(px + SCALE * 2, py + SCALE * 3, SCALE * 5, SCALE * 4);
          ctx.fillRect(px + SCALE * 9, py + SCALE * 3, SCALE * 5, SCALE * 4);
          ctx.fillStyle = '#2ea043';
          ctx.fillRect(px + SCALE * 6, py + SCALE * 4, SCALE * 4, SCALE * 3);
          break;
        case 'watercooler':
          // Base/body
          ctx.fillStyle = '#c9d1d9';
          ctx.fillRect(px + SCALE * 5, py + SCALE * 4, SCALE * 6, SCALE * 8);
          // Top jug (blue tint)
          ctx.fillStyle = '#79c0ff';
          ctx.fillRect(px + SCALE * 5.5, py + SCALE * 1, SCALE * 5, SCALE * 4);
          ctx.fillStyle = '#58a6ff';
          ctx.fillRect(px + SCALE * 6, py + SCALE * 1.5, SCALE * 4, SCALE * 3);
          // Spout
          ctx.fillStyle = '#e6edf3';
          ctx.fillRect(px + SCALE * 4, py + SCALE * 7, SCALE * 2, SCALE * 2);
          // Legs
          ctx.fillStyle = '#6e7681';
          ctx.fillRect(px + SCALE * 5, py + SCALE * 12, SCALE * 2, SCALE * 2);
          ctx.fillRect(px + SCALE * 9, py + SCALE * 12, SCALE * 2, SCALE * 2);
          break;
      }
    }
  }

  // ── Rendering: Sprite-based Agents ──

  function getAnimDef(agent) {
    // Pick animation row/frames based on agent state
    switch (agent.state) {
      case 'walking': {
        // Use walk side if moving horizontally, walk down otherwise
        if (agent.path && agent.path.length > 0) {
          const target = agent.path[0];
          const dx = Math.abs(target.x - agent.renderX);
          const dy = Math.abs(target.y - agent.renderY);
          if (dx > dy) return SHEET.walkSide;
        }
        return SHEET.walkDown;
      }
      case 'typing':
      case 'reading':
        return SHEET.sit;       // sitting at desk
      case 'thinking':
        return SHEET.idleDown;  // subtle idle bob
      case 'waiting':
        return SHEET.idleDown;
      case 'idle':
      default:
        return SHEET.idleDown;
    }
  }

  function shouldFlip(agent) {
    // Flip sprite horizontally if walking left
    if (agent.state === 'walking' && agent.path && agent.path.length > 0) {
      const target = agent.path[0];
      return target.x < agent.renderX;
    }
    return false;
  }

  function drawAgent(agent, time) {
    const spriteFile = CHAR_SPRITES[agent.charIdx % CHAR_SPRITES.length];
    const img = spriteImages.get(spriteFile);

    // Character position: center 24px char on 16px tile
    const charOffset = (SCALED_CHAR - SCALED_TILE) / 2;
    const px = agent.renderX * SCALED_TILE - charOffset;
    const py = agent.renderY * SCALED_TILE - charOffset;

    // Shadow
    if (shadowImg && shadowImg.complete && shadowImg.naturalWidth > 0) {
      ctx.drawImage(shadowImg,
        0, 0, shadowImg.naturalWidth, shadowImg.naturalHeight,
        px + SCALE * 2, py + SCALED_CHAR - SCALE * 4, SCALE * 17, SCALE * 6
      );
    } else {
      ctx.fillStyle = COLORS.shadow;
      ctx.beginPath();
      ctx.ellipse(
        agent.renderX * SCALED_TILE + SCALED_TILE / 2,
        agent.renderY * SCALED_TILE + SCALED_TILE - SCALE,
        SCALE * 5, SCALE * 2, 0, 0, Math.PI * 2
      );
      ctx.fill();
    }

    // Draw sprite from sheet
    if (img && img.complete && img.naturalWidth > 0) {
      const anim = getAnimDef(agent);
      const [row, startCol, frameCount] = anim;
      const frameIdx = Math.floor(globalFrame / 2) % frameCount; // slower animation
      const col = startCol + frameIdx;

      const sx = col * SHEET.frameW;
      const sy = row * SHEET.frameH;
      const flip = shouldFlip(agent);

      ctx.save();
      if (flip) {
        ctx.translate(px + SCALED_CHAR, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, sx, sy, SHEET.frameW, SHEET.frameH, 0, py, SCALED_CHAR, SCALED_CHAR);
      } else {
        ctx.drawImage(img, sx, sy, SHEET.frameW, SHEET.frameH, px, py, SCALED_CHAR, SCALED_CHAR);
      }
      ctx.restore();
    } else {
      // Fallback: colored rectangle if sprite not loaded
      ctx.fillStyle = LABEL_COLORS[agent.charIdx % LABEL_COLORS.length];
      ctx.fillRect(
        agent.renderX * SCALED_TILE + SCALE * 4,
        agent.renderY * SCALED_TILE + SCALE * 2,
        SCALE * 8, SCALE * 12
      );
    }

    // State-specific overlays
    drawStateOverlay(agent, time);

    // Name label
    const labelColor = LABEL_COLORS[agent.charIdx % LABEL_COLORS.length];
    const labelX = agent.renderX * SCALED_TILE + SCALED_TILE / 2;
    const labelY = agent.renderY * SCALED_TILE - SCALE * 3;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    const nameWidth = ctx.measureText(agent.name).width || SCALE * 20;
    ctx.fillRect(labelX - nameWidth / 2 - SCALE * 2, labelY - SCALE * 3, nameWidth + SCALE * 4, SCALE * 4.5);

    ctx.fillStyle = labelColor;
    ctx.font = `bold ${SCALE * 3}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.fillText(agent.name, labelX, labelY);
    ctx.textAlign = 'left';

    // Status dot
    const statusColors = {
      idle: '#7d8590', walking: '#3fb950', typing: '#f0883e',
      reading: '#58a6ff', thinking: '#7c6aef', waiting: '#7d8590',
    };
    ctx.fillStyle = statusColors[agent.state] || '#7d8590';
    ctx.beginPath();
    ctx.arc(labelX + nameWidth / 2 + SCALE * 3, labelY - SCALE * 1, SCALE * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawStateOverlay(agent, time) {
    const px = agent.renderX * SCALED_TILE;
    const py = agent.renderY * SCALED_TILE;

    switch (agent.state) {
      case 'thinking': {
        // Thought bubble
        const phase = Math.sin(time * 0.003);
        ctx.fillStyle = 'rgba(230, 237, 243, 0.85)';
        ctx.beginPath();
        ctx.arc(px + SCALED_TILE + SCALE * 6, py - SCALE * 4 + phase * SCALE, SCALE * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px + SCALED_TILE + SCALE * 3, py - SCALE, SCALE * 1.5, 0, Math.PI * 2);
        ctx.fill();
        // Dots
        ctx.fillStyle = '#0d1117';
        for (let d = 0; d < 3; d++) {
          ctx.fillRect(px + SCALED_TILE + SCALE * (5 + d * 1.2), py - SCALE * 4.5, SCALE * 0.6, SCALE * 0.6);
        }
        break;
      }
      case 'waiting': {
        const z = Math.sin(time * 0.002) * SCALE;
        ctx.fillStyle = 'rgba(125, 133, 144, 0.6)';
        ctx.font = `${SCALE * 4}px monospace`;
        ctx.fillText('z', px + SCALED_TILE + SCALE * 2, py - SCALE * 2 + z);
        ctx.font = `${SCALE * 3}px monospace`;
        ctx.fillText('z', px + SCALED_TILE + SCALE * 5, py - SCALE * 5 + z);
        break;
      }
      case 'typing': {
        // Tiny code particles floating up from desk
        const sparkPhase = Math.floor(time / 400) % 3;
        ctx.fillStyle = 'rgba(88, 166, 255, 0.5)';
        ctx.fillRect(px + SCALE * (6 + sparkPhase * 2), py - SCALE * (1 + sparkPhase), SCALE, SCALE);
        ctx.fillRect(px + SCALE * (10 - sparkPhase), py - SCALE * (2 + sparkPhase), SCALE, SCALE);
        break;
      }
      case 'reading': {
        // Subtle page glow
        ctx.fillStyle = 'rgba(88, 166, 255, 0.12)';
        ctx.fillRect(px - SCALE, py + SCALE * 2, SCALED_TILE + SCALE * 2, SCALED_TILE - SCALE * 2);
        break;
      }
    }

    // Chat bubble (when agents are near each other)
    if (agent.chatBubbleTimer > 0) {
      const bubbleAlpha = Math.min(1, agent.chatBubbleTimer / 500); // fade out in last 500ms
      const bobPhase = Math.sin(time * 0.004) * SCALE * 0.5;

      // Bubble background
      const bx = px + SCALED_TILE + SCALE * 2;
      const by = py - SCALE * 6 + bobPhase;
      ctx.fillStyle = `rgba(230, 237, 243, ${0.9 * bubbleAlpha})`;
      ctx.beginPath();
      ctx.arc(bx + SCALE * 4, by + SCALE * 2, SCALE * 5, 0, Math.PI * 2);
      ctx.fill();

      // Bubble tail
      ctx.beginPath();
      ctx.moveTo(bx + SCALE * 1, by + SCALE * 5);
      ctx.lineTo(bx - SCALE * 1, by + SCALE * 8);
      ctx.lineTo(bx + SCALE * 3, by + SCALE * 5);
      ctx.fillStyle = `rgba(230, 237, 243, ${0.9 * bubbleAlpha})`;
      ctx.fill();

      // Speech lines (three horizontal lines)
      ctx.fillStyle = `rgba(13, 17, 23, ${0.7 * bubbleAlpha})`;
      for (let i = 0; i < 3; i++) {
        const lineW = SCALE * (3 - i * 0.5);
        ctx.fillRect(bx + SCALE * 2.5, by + SCALE * (1 + i * 1.2), lineW, SCALE * 0.6);
      }
    }
  }

  // ── Idle Behavior System ──

  function getAgentDeskChair(agent) {
    const chairs = furniture.filter(f => f.type === 'chair');
    return chairs[agent.deskIdx] || null;
  }

  function pickIdleBehavior(agent) {
    const roll = Math.random();
    const allAgents = [...agents.values()];

    if (roll < 0.35) {
      // Walk to water cooler
      const points = getInterestPoints();
      const spot = points.filter(p => p.label === 'watercooler');
      if (spot.length > 0) {
        const target = spot[Math.floor(Math.random() * spot.length)];
        return { type: 'wander', target, lingerMs: WANDER_LINGER_MS + randBetween(0, 2000) };
      }
    }

    if (roll < 0.60) {
      // Walk to a plant or scene-specific point
      const points = getInterestPoints();
      const plants = points.filter(p => p.label === 'plant' || p.label === 'flowers' || p.label === 'crystal' || p.label === 'tree');
      if (plants.length === 0) {
        // Fallback: pick any non-lounge point
        const any = points.filter(p => p.label !== 'lounge');
        if (any.length > 0) {
          const target = any[Math.floor(Math.random() * any.length)];
          return { type: 'wander', target, lingerMs: WANDER_LINGER_MS + randBetween(0, 1500) };
        }
      }
      const target = plants[Math.floor(Math.random() * plants.length)];
      return { type: 'wander', target, lingerMs: WANDER_LINGER_MS + randBetween(0, 1500) };
    }

    if (roll < 0.85 && allAgents.length > 1) {
      // Visit another agent's desk
      const others = allAgents.filter(a => a.id !== agent.id);
      const target = others[Math.floor(Math.random() * others.length)];
      const chair = getAgentDeskChair(target);
      if (chair) {
        // Stand next to the other agent's chair (one tile to the side)
        const visitX = Math.min(MAP_W - 2, Math.max(1, chair.x + (Math.random() < 0.5 ? -1 : 1)));
        const visitY = chair.y;
        return { type: 'visit', target: { x: visitX, y: visitY }, visitAgentId: target.id, lingerMs: WANDER_LINGER_MS + randBetween(0, 2000) };
      }
    }

    // Fallback: lounge area or any interest point
    const points = getInterestPoints();
    const lounge = points.filter(p => p.label === 'lounge');
    if (lounge.length > 0) {
      const target = lounge[Math.floor(Math.random() * lounge.length)];
      return { type: 'wander', target, lingerMs: WANDER_LINGER_MS + randBetween(0, 2000) };
    }
    // Ultimate fallback: any interest point
    const anyPoint = points[Math.floor(Math.random() * points.length)];
    return { type: 'wander', target: anyPoint, lingerMs: WANDER_LINGER_MS + randBetween(0, 2000) };
  }

  function startIdleBehavior(agent) {
    const behavior = pickIdleBehavior(agent);
    const path = findPath(agent.x, agent.y, behavior.target.x, behavior.target.y);

    if (path.length === 0) {
      // Can't reach destination, reset idle timer and try again later
      agent.idleTimer = randBetween(IDLE_MIN_MS, IDLE_MAX_MS);
      return;
    }

    agent.idleBehavior = behavior;
    agent.path = path;
    agent.state = 'walking';
    agent.pendingState = null; // will be handled by behavior system
  }

  function returnToDesk(agent) {
    const chair = getAgentDeskChair(agent);
    if (!chair) return;

    const path = findPath(agent.x, agent.y, chair.x, chair.y);
    if (path.length === 0) {
      // Already at desk or can't reach
      agent.state = 'typing';
      agent.idleBehavior = null;
      agent.idleTimer = randBetween(IDLE_MIN_MS, IDLE_MAX_MS);
      return;
    }

    agent.path = path;
    agent.state = 'walking';
    agent.idleBehavior = { type: 'returning' };
  }

  function checkAgentProximity() {
    const allAgents = [...agents.values()];
    for (let i = 0; i < allAgents.length; i++) {
      for (let j = i + 1; j < allAgents.length; j++) {
        const a = allAgents[i];
        const b = allAgents[j];
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        if (dx <= 1 && dy <= 1 && dx + dy <= 2) {
          // Adjacent agents — trigger chat bubbles
          if (!a.chatBubbleTimer || a.chatBubbleTimer <= 0) {
            a.chatBubbleTimer = CHAT_BUBBLE_MS;
          }
          if (!b.chatBubbleTimer || b.chatBubbleTimer <= 0) {
            b.chatBubbleTimer = CHAT_BUBBLE_MS;
          }
        }
      }
    }
  }

  // ── Agent Movement & State Machine ──

  function updateAgent(agent, dt) {
    // ── Movement along path ──
    if (agent.path && agent.path.length > 0) {
      agent.state = 'walking';
      const target = agent.path[0];
      const dx = target.x - agent.renderX;
      const dy = target.y - agent.renderY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = 3 * (dt / 1000);

      if (dist < speed) {
        agent.renderX = target.x;
        agent.renderY = target.y;
        agent.x = target.x;
        agent.y = target.y;
        agent.path.shift();

        if (agent.path.length === 0) {
          // Path complete — check if we're in an idle behavior
          if (agent.idleBehavior) {
            const beh = agent.idleBehavior;
            if (beh.type === 'returning') {
              // Returned to desk — resume work
              agent.state = Math.random() < 0.5 ? 'typing' : 'reading';
              agent.idleBehavior = null;
              agent.idleTimer = randBetween(IDLE_MIN_MS, IDLE_MAX_MS);
              agent.deskActivityTimer = randBetween(DESK_ACTIVITY_MIN_MS, DESK_ACTIVITY_MAX_MS);
              // Re-activate monitor
              const monitor = furniture.find(f => f.id === `monitor-${agent.deskIdx}`);
              if (monitor) monitor.active = true;
            } else if (beh.type === 'wander' || beh.type === 'visit') {
              // Arrived at interest point — linger
              agent.state = 'idle';
              agent.lingerTimer = beh.lingerMs || WANDER_LINGER_MS;
            }
          } else {
            agent.state = agent.pendingState || 'idle';
            agent.pendingState = null;
            // First arrival at desk — start desk activity cycle
            if (agent.state === 'idle') {
              agent.state = Math.random() < 0.5 ? 'typing' : 'reading';
            }
            agent.idleTimer = randBetween(IDLE_MIN_MS, IDLE_MAX_MS);
            agent.deskActivityTimer = randBetween(DESK_ACTIVITY_MIN_MS, DESK_ACTIVITY_MAX_MS);
          }
        }
      } else {
        agent.renderX += (dx / dist) * speed;
        agent.renderY += (dy / dist) * speed;
      }
      return; // Don't process idle timers while walking
    }

    // ── Linger timer (standing at an interest point) ──
    if (agent.lingerTimer > 0) {
      agent.lingerTimer -= dt;
      if (agent.lingerTimer <= 0) {
        agent.lingerTimer = 0;
        // Done lingering — walk back to desk
        // Dim monitor while away (it was already off since we left)
        returnToDesk(agent);
      }
      return;
    }

    // ── Thinking pause (micro-animation at desk) ──
    if (agent.thinkPauseTimer > 0) {
      agent.state = 'thinking';
      agent.thinkPauseTimer -= dt;
      if (agent.thinkPauseTimer <= 0) {
        agent.thinkPauseTimer = 0;
        agent.state = 'typing';
        agent.deskActivityTimer = randBetween(DESK_ACTIVITY_MIN_MS, DESK_ACTIVITY_MAX_MS);
      }
      return;
    }

    // ── State timer (from external setAgentState calls) ──
    if (agent.stateTimer > 0) {
      agent.stateTimer -= dt;
      if (agent.stateTimer <= 0) {
        agent.state = 'idle';
        agent.stateTimer = 0;
      }
      return;
    }

    // ── Desk activity cycling (typing ↔ reading ↔ thinking) ──
    if ((agent.state === 'typing' || agent.state === 'reading') && !agent.idleBehavior) {
      if (agent.deskActivityTimer > 0) {
        agent.deskActivityTimer -= dt;
        if (agent.deskActivityTimer <= 0) {
          const roll = Math.random();
          if (roll < 0.25) {
            // Brief thinking pause
            agent.thinkPauseTimer = THINK_PAUSE_MS;
          } else if (agent.state === 'typing') {
            agent.state = 'reading';
            agent.deskActivityTimer = randBetween(DESK_ACTIVITY_MIN_MS, DESK_ACTIVITY_MAX_MS);
          } else {
            agent.state = 'typing';
            agent.deskActivityTimer = randBetween(DESK_ACTIVITY_MIN_MS, DESK_ACTIVITY_MAX_MS);
          }
        }
      }
    }

    // ── Idle wandering trigger ──
    if ((agent.state === 'typing' || agent.state === 'reading' || agent.state === 'idle') && !agent.idleBehavior) {
      if (agent.idleTimer > 0) {
        agent.idleTimer -= dt;
        if (agent.idleTimer <= 0) {
          // Time to wander!
          // Dim monitor while agent is away
          const monitor = furniture.find(f => f.id === `monitor-${agent.deskIdx}`);
          if (monitor) monitor.active = false;
          startIdleBehavior(agent);
        }
      }
    }

    // ── Chat bubble decay ──
    if (agent.chatBubbleTimer > 0) {
      agent.chatBubbleTimer -= dt;
      if (agent.chatBubbleTimer <= 0) {
        agent.chatBubbleTimer = 0;
      }
    }
  }

  // ── Game Loop ──

  function gameLoop(timestamp) {
    if (!visible) return;
    animFrame = requestAnimationFrame(gameLoop);

    const dt = timestamp - lastTime;
    if (dt < FRAME_MS) return;
    lastTime = timestamp;
    globalFrame++;

    // Lazy-init progression & collaboration systems on first frame
    if (!progressionInitialized) initProgressionSystems();

    // Periodically re-check season and time of day
    seasonCheckTimer += dt;
    if (seasonCheckTimer >= SEASON_CHECK_INTERVAL) {
      seasonCheckTimer = 0;
      currentSeason = getCurrentSeason();
      currentTimeOfDay = getTimeOfDay();
    }

    // Ambient particle spawning
    particleSpawnTimer += dt;
    if (particleSpawnTimer >= PARTICLE_SPAWN_INTERVAL) {
      particleSpawnTimer = 0;
      const cfg = SEASON_PARTICLES[currentSeason];
      if (cfg) {
        spawnParticles(cfg.type, cfg.count);
      }
    }

    // Update particles
    updateParticles(dt);

    // Tension engine update
    if (tensionEngine) {
      tensionEngine.update(dt, {
        knightCount: obstacles.size,
        demonActive: [...specialCreatures.values()].some(c => c.type === 'demon' && c.state !== 'dying'),
        elementalActive: [...specialCreatures.values()].some(c => c.type === 'elemental' && c.state !== 'dying'),
        gatoCount: gatos.size,
      });
    }

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawTilemap(timestamp);

    // Scene background hook (drawn after tilemap, before furniture)
    if (SceneConfig && SceneConfig.scenes[currentScene]?.drawBackground) {
      SceneConfig.scenes[currentScene].drawBackground(ctx, SCALE, SCALED_TILE, timestamp, canvas.width, canvas.height);
    }

    drawFurniture();

    // Agents sorted by Y for depth
    const sortedAgents = [...agents.values()].sort((a, b) => a.renderY - b.renderY);
    for (const agent of sortedAgents) {
      updateAgent(agent, dt);
      drawAgent(agent, timestamp);
    }

    // Collaboration: Focus beams from working agents to their obstacles
    if (CollabConfig) {
      CollabConfig.drawAllFocusBeams(ctx, SCALE, SCALED_TILE, agents, obstacles, timestamp);
    }

    // Check for agent proximity interactions (every 10 frames to save CPU)
    if (globalFrame % 10 === 0) {
      checkAgentProximity();
    }

    // Special creature spawn check (every 5s)
    specialSpawnTimer += dt;
    if (specialSpawnTimer >= SPECIAL_SPAWN_CHECK_INTERVAL && CreatureConfig) {
      specialSpawnTimer = 0;
      const context = {
        activeTaskCount: obstacles.size,
        agents: agents,
        obstacles: obstacles,
        tension: 0.3,
        lastMessageType: null,
        now: Date.now(),
        activeSpecials: new Set([...specialCreatures.keys()]),
      };
      const spawns = CreatureConfig.checkSpecialSpawns(context);
      for (const creatureKey of spawns) {
        if (!specialCreatures.has(creatureKey)) {
          spawnSpecialCreature(creatureKey);
        }
      }
    }

    // Obstacles (knights/tasks)
    for (const obs of [...obstacles.values()]) {
      updateObstacle(obs, dt);
    }
    for (const obs of [...obstacles.values()].sort((a, b) => a.renderY - b.renderY)) {
      drawObstacle(obs, timestamp);
    }

    // Celebration cascade particles
    if (celebrationCascade) {
      celebrationCascade.update(dt, SCALE);
      celebrationCascade.draw(ctx, SCALE, timestamp);
    }

    // Office pets (gatos)
    gatoSpawnTimer -= dt;
    if (gatoSpawnTimer <= 0) {
      gatoSpawnTimer = GATO_SPAWN_INTERVAL;
      trySpawnGato();
    }
    for (const gato of [...gatos.values()]) {
      updateGato(gato, dt);
    }
    for (const gato of [...gatos.values()].sort((a, b) => a.renderY - b.renderY)) {
      drawGato(gato, timestamp);
    }

    // Special creatures
    for (const [key, creature] of [...specialCreatures]) {
      updateSpecialCreature(creature, dt);
    }
    for (const creature of [...specialCreatures.values()].sort((a, b) => a.renderY - b.renderY)) {
      drawSpecialCreature(creature, timestamp);
    }

    // Relay data lines
    if (relayLineManager) {
      relayLineManager.update(dt);
      relayLineManager.draw(ctx, SCALE);
    }

    // Scene foreground hook (drawn after agents/obstacles/gatos, before particles)
    if (SceneConfig && SceneConfig.scenes[currentScene]?.drawForeground) {
      SceneConfig.scenes[currentScene].drawForeground(ctx, SCALE, SCALED_TILE, timestamp, canvas.width, canvas.height);
    }

    // Particles drawn above agents, below UI
    drawParticles();

    // Day/night tint overlay (drawn above everything except UI)
    drawTimeOverlay(timestamp);

    // Tension vignette overlay
    if (ProgressionConfig && tensionEngine) {
      const env = tensionEngine.getEnvironment();
      if (env && env.vignetteAlpha > 0) {
        ProgressionConfig.drawVignette(ctx, canvas.width, canvas.height, env.vignetteAlpha);
      }
      // Tension light overlay
      if (env && env.lightOverlay) {
        const lo = env.lightOverlay;
        ctx.fillStyle = `rgba(${lo.r}, ${lo.g}, ${lo.b}, ${lo.a})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    // Scene overlay hook (drawn after time overlay)
    if (SceneConfig && SceneConfig.scenes[currentScene]?.drawOverlay) {
      SceneConfig.scenes[currentScene].drawOverlay(ctx, SCALE, SCALED_TILE, timestamp, canvas.width, canvas.height);
    }

    // Bottom overlay
    const seasonLabel = currentSeason.charAt(0).toUpperCase() + currentSeason.slice(1);
    const timeLabel = currentTimeOfDay.charAt(0).toUpperCase() + currentTimeOfDay.slice(1);
    const tensionLabel = tensionEngine ? tensionEngine.getLevel().charAt(0).toUpperCase() + tensionEngine.getLevel().slice(1) : '';
    const obstacleCount = obstacles.size;
    const gatoCount = gatos.size;
    const statusText = `${agents.size} agent${agents.size !== 1 ? 's' : ''}  ·  ${obstacleCount > 0 ? obstacleCount + ' task' + (obstacleCount !== 1 ? 's' : '') + '  ·  ' : ''}${gatoCount > 0 ? gatoCount + ' cat' + (gatoCount !== 1 ? 's' : '') + '  ·  ' : ''}${tensionLabel ? tensionLabel + '  ·  ' : ''}${seasonLabel} ${timeLabel}  ·  Sprites by SnowHex`;
    const statusWidth = Math.max(SCALE * 50, ctx.measureText(statusText).width + SCALE * 8);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(SCALE * 2, canvas.height - SCALE * 7, statusWidth, SCALE * 5);
    ctx.fillStyle = '#7d8590';
    ctx.font = `${SCALE * 3}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(statusText, SCALE * 4, canvas.height - SCALE * 3.5);

    // Scene transition overlay (fade to/from black)
    if (SceneConfig && SceneConfig.transition.isActive()) {
      const alpha = SceneConfig.transition.getTransitionState();
      if (alpha !== null) {
        ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  // ── Scene Switching ──

  function switchScene(sceneName) {
    if (!SceneConfig || !SceneConfig.scenes[sceneName]) return;
    if (currentScene === sceneName) return;

    const oldScene = currentScene;
    SceneConfig.transition.start(oldScene, sceneName);

    // Rebuild map after short delay for transition
    setTimeout(() => {
      buildSceneMap(sceneName);
      // Re-seat agents at new desk positions
      const chairs = furniture.filter(f => f.type === 'chair');
      for (const [id, agent] of agents) {
        const chair = chairs[agent.deskIdx];
        if (chair) {
          agent.path = findPath(agent.x, agent.y, chair.x, chair.y);
          agent.state = 'walking';
        }
      }
    }, 400); // halfway through transition
  }

  // ── Public API ──

  function init(containerEl) {
    canvas = document.createElement('canvas');
    canvas.width = MAP_W * SCALED_TILE;
    canvas.height = MAP_H * SCALED_TILE;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.background = COLORS.bg;
    canvas.style.borderRadius = '8px';
    containerEl.appendChild(canvas);
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    buildSceneMap('workshop'); // default scene, uses PixelSceneConfig if available
    loadSprites();
    loadKnightSprites();
    loadGatoSprites();
    loadPropSprites();
  }

  function show() {
    visible = true;
    lastTime = performance.now();
    animFrame = requestAnimationFrame(gameLoop);
  }

  function hide() {
    visible = false;
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
  }

  function spawnAgent(id, name) {
    if (agents.has(id)) return agents.get(id);

    const charIdx = nextCharIdx++;
    const deskFurniture = furniture.filter(f => f.type === 'chair');
    const usedDesks = new Set([...agents.values()].map(a => a.deskIdx));
    let deskIdx = 0;
    for (let i = 0; i < deskFurniture.length; i++) {
      if (!usedDesks.has(i)) { deskIdx = i; break; }
    }

    const chair = deskFurniture[deskIdx];
    const spawnX = Math.floor(MAP_W / 2);
    const spawnY = MAP_H - 2;

    const agent = {
      id,
      name: name || `Agent ${charIdx + 1}`,
      charIdx,
      x: spawnX,
      y: spawnY,
      renderX: spawnX,
      renderY: spawnY,
      state: 'walking',
      pendingState: 'idle',
      frame: 0,
      stateTimer: 0,
      deskIdx,
      path: null,
      // Idle behavior state
      idleTimer: randBetween(IDLE_MIN_MS, IDLE_MAX_MS),
      idleBehavior: null,
      lingerTimer: 0,
      deskActivityTimer: randBetween(DESK_ACTIVITY_MIN_MS, DESK_ACTIVITY_MAX_MS),
      thinkPauseTimer: 0,
      chatBubbleTimer: 0,
    };

    if (chair) {
      agent.path = findPath(spawnX, spawnY, chair.x, chair.y);
      const monitor = furniture.find(f => f.id === `monitor-${deskIdx}`);
      if (monitor) monitor.active = true;
    }

    agents.set(id, agent);
    return agent;
  }

  function despawnAgent(id) {
    const agent = agents.get(id);
    if (!agent) return;
    const monitor = furniture.find(f => f.id === `monitor-${agent.deskIdx}`);
    if (monitor) monitor.active = false;
    agents.delete(id);
  }

  function setAgentState(id, newState, durationMs = 0) {
    const agent = agents.get(id);
    if (!agent) return;

    const stateMap = {
      'idle': 'idle', 'reading': 'reading', 'writing': 'typing',
      'typing': 'typing', 'testing': 'thinking', 'thinking': 'thinking',
      'waiting': 'waiting', 'active': 'typing',
    };

    // If agent is wandering, bring them back to desk first
    if (agent.idleBehavior && agent.idleBehavior.type !== 'returning') {
      agent.idleBehavior = null;
      agent.lingerTimer = 0;
      returnToDesk(agent);
    }

    agent.state = stateMap[newState] || newState;
    agent.stateTimer = durationMs || 5000;
    // Reset idle timer so agent doesn't wander immediately after external state
    agent.idleTimer = randBetween(IDLE_MIN_MS, IDLE_MAX_MS);
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Obstacle System (Knights = Tasks/Bugs) ──
  // ═══════════════════════════════════════════════════════════════

  const KNIGHT_SPRITES = [
    'knight-01-v1.png', 'knight-02-v1.png',
    'knight-03-v1.png', 'knight-04-v1.png',
  ];
  const knightImages = new Map();
  let knightsLoaded = false;

  // obstacles: Map<taskId, ObstacleState>
  const obstacles = new Map();
  let nextKnightIdx = 0;

  function loadKnightSprites() {
    let loaded = 0;
    const total = KNIGHT_SPRITES.length;
    function onLoad() { loaded++; if (loaded >= total) knightsLoaded = true; }
    for (const file of KNIGHT_SPRITES) {
      const img = new Image();
      img.onload = onLoad;
      img.onerror = onLoad;
      img.src = `/plugins/pixel-agents/assets/sprites/characters/${file}`;
      knightImages.set(file, img);
    }
  }

  function spawnObstacle(taskId, assignedAgentId, label, messageContent) {
    if (obstacles.has(taskId)) return obstacles.get(taskId);

    CreatureConfig = typeof PixelCreatureConfig !== 'undefined' ? PixelCreatureConfig : null;

    // Classify knight type
    let knightType = 'normal';
    let knightConfig = null;
    if (CreatureConfig) {
      knightType = CreatureConfig.classifyKnight(label, messageContent);
      knightConfig = CreatureConfig.knightVariants[knightType];
    }

    // Select knight sprite based on type
    let knightIdx;
    if (knightConfig) {
      knightIdx = KNIGHT_SPRITES.indexOf(knightConfig.spriteFile);
      if (knightIdx < 0) knightIdx = nextKnightIdx++ % KNIGHT_SPRITES.length;
    } else {
      knightIdx = nextKnightIdx++ % KNIGHT_SPRITES.length;
    }

    const spawnX = Math.random() < 0.5 ? 1 : MAP_W - 2;
    const spawnY = MAP_H - 2;

    const obstacle = {
      id: taskId,
      label: label || (knightConfig ? knightConfig.label : 'task'),
      knightIdx,
      knightType,
      assignedAgentId,
      x: spawnX,
      y: spawnY,
      renderX: spawnX,
      renderY: spawnY,
      state: 'approaching', // approaching → lurking → dying → gone
      path: null,
      health: knightConfig ? knightConfig.healthMultiplier : 1.0,
      scaleMultiplier: knightConfig ? knightConfig.scaleMultiplier : 1.0,
      speed: knightConfig ? knightConfig.speed : 1.5,
      catScareRadius: knightConfig ? knightConfig.catScareRadius : 4,
      behavior: knightConfig ? knightConfig.behavior : 'lurk',
      spawnTimer: 0, // for tech debt spawner behavior
      damageTimer: 0,
      flashTimer: 0,
      deathTimer: 0,
      wanderTimer: randBetween(3000, 6000),
    };

    // Find target position near the assigned agent's desk
    const agent = agents.get(assignedAgentId);
    if (agent) {
      const chair = furniture.filter(f => f.type === 'chair')[agent.deskIdx];
      if (chair) {
        // Stand a couple tiles away from the desk
        const tx = Math.min(MAP_W - 2, Math.max(1, chair.x + (Math.random() < 0.5 ? -2 : 2)));
        const ty = Math.min(MAP_H - 2, Math.max(2, chair.y + 1));
        obstacle.path = findPath(spawnX, spawnY, tx, ty);
        obstacle.homeX = tx;
        obstacle.homeY = ty;
      }
    }

    obstacles.set(taskId, obstacle);
    return obstacle;
  }

  function resolveObstacle(taskId) {
    const obs = obstacles.get(taskId);
    if (!obs) return;
    obs.state = 'dying';
    obs.deathTimer = 1200; // 1.2s death animation

    // Spark burst at death location
    for (let i = 0; i < 8; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      particles.push({
        x: obs.renderX * SCALED_TILE + SCALED_TILE / 2,
        y: obs.renderY * SCALED_TILE + SCALED_TILE / 2,
        vx: (Math.random() - 0.5) * 2 * SCALE,
        vy: (Math.random() - 0.5) * 2 * SCALE - SCALE,
        life: 0,
        maxLife: 800 + Math.random() * 600,
        size: (2 + Math.random() * 2) * SCALE * 0.5,
        color: ['#ffd700', '#ff6b35', '#58a6ff', '#3fb950'][Math.floor(Math.random() * 4)],
        type: 'sparkle',
      });
    }

    // Trigger celebration cascade toward nearby knights
    if (celebrationCascade && ProgressionConfig?.casinoMechanics) {
      const obstaclePositions = [...obstacles.values()]
        .filter(o => o.id !== taskId && o.state !== 'dying')
        .map(o => ({ x: o.x, y: o.y, id: o.id }));
      const targets = ProgressionConfig.casinoMechanics.getCelebrationTargets(
        obs.x, obs.y, obstaclePositions, 6
      );
      if (targets.length > 0) {
        celebrationCascade.trigger(
          obs.renderX * SCALED_TILE + SCALED_TILE / 2,
          obs.renderY * SCALED_TILE + SCALED_TILE / 2,
          SCALED_TILE,
          targets
        );
      }
    }

    // Notify tension engine
    if (tensionEngine) {
      tensionEngine.onKnightKilled();
    }
  }

  function damageObstacle(taskId, amount) {
    const obs = obstacles.get(taskId);
    if (!obs || obs.state === 'dying') return;

    // Collaboration damage multiplier
    if (CollabConfig) {
      const workingOnThis = [...agents.values()].filter(a =>
        a.state === 'typing' || a.state === 'reading'
      ).length;
      const multiplier = CollabConfig.calculateDamageMultiplier(workingOnThis, false);
      amount *= multiplier;
    }

    obs.health = Math.max(0, obs.health - amount);
    obs.flashTimer = 200;

    // Casino: near-miss reinforcement
    if (ProgressionConfig?.casinoMechanics?.shouldReinforceKnight(obs.health)) {
      obs.health = Math.min(1, obs.health + 0.3); // heal 30%
      obs.flashTimer = 500; // longer flash to show reinforcement
    }

    // Casino: knight tries to flee at low HP
    if (ProgressionConfig?.casinoMechanics?.shouldKnightFlee(obs.health)) {
      // Make knight run toward map edge
      const fleeX = obs.x < MAP_W / 2 ? 1 : MAP_W - 2;
      obs.path = findPath(obs.x, obs.y, fleeX, MAP_H - 2);
    }

    if (obs.health <= 0) {
      resolveObstacle(taskId);
    }
  }

  function updateObstacle(obs, dt) {
    if (obs.state === 'dying') {
      obs.deathTimer -= dt;
      if (obs.deathTimer <= 0) {
        obstacles.delete(obs.id);
      }
      return;
    }

    // Flash timer
    if (obs.flashTimer > 0) obs.flashTimer -= dt;

    // Movement
    if (obs.path && obs.path.length > 0) {
      const target = obs.path[0];
      const dx = target.x - obs.renderX;
      const dy = target.y - obs.renderY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = (obs.speed || 1.5) * (dt / 1000); // use knight-type speed

      if (dist < speed) {
        obs.renderX = target.x;
        obs.renderY = target.y;
        obs.x = target.x;
        obs.y = target.y;
        obs.path.shift();
        if (obs.path.length === 0) {
          obs.state = 'lurking';
        }
      } else {
        obs.renderX += (dx / dist) * speed;
        obs.renderY += (dy / dist) * speed;
      }
      return;
    }

    // Lurking: small random wanders near assigned desk
    if (obs.state === 'lurking') {
      obs.wanderTimer -= dt;
      if (obs.wanderTimer <= 0) {
        obs.wanderTimer = randBetween(4000, 8000);
        const wx = Math.min(MAP_W - 2, Math.max(1, (obs.homeX || obs.x) + Math.floor(Math.random() * 3) - 1));
        const wy = Math.min(MAP_H - 2, Math.max(2, (obs.homeY || obs.y) + Math.floor(Math.random() * 3) - 1));
        obs.path = findPath(obs.x, obs.y, wx, wy);
      }
    }

    // Tech debt spawner behavior: periodically spawn mini-knights
    if (obs.behavior === 'spawner') {
      obs.spawnTimer = (obs.spawnTimer || 0) + dt;
      const interval = (CreatureConfig?.knightVariants?.techDebt?.spawnInterval) || 60000;
      if (obs.spawnTimer >= interval) {
        obs.spawnTimer = 0;
        // Spawn a mini-knight nearby
        const miniId = `${obs.id}-mini-${Date.now()}`;
        const mini = spawnObstacle(miniId, obs.assignedAgentId, 'mini-task');
        if (mini) {
          mini.health = 0.5;
          mini.scaleMultiplier = 0.7;
        }
      }
    }

    // Passive damage from assigned agent working
    const agent = agents.get(obs.assignedAgentId);
    if (agent && (agent.state === 'typing' || agent.state === 'reading')) {
      obs.damageTimer += dt;
      if (obs.damageTimer >= 3000) { // every 3s of work = 10% damage
        obs.damageTimer = 0;
        damageObstacle(obs.id, 0.1);
      }
    }
  }

  function drawObstacle(obs, timestamp) {
    const spriteFile = KNIGHT_SPRITES[obs.knightIdx % KNIGHT_SPRITES.length];
    const img = knightImages.get(spriteFile);

    const charOffset = (SCALED_CHAR - SCALED_TILE) / 2;
    let px = obs.renderX * SCALED_TILE - charOffset;
    let py = obs.renderY * SCALED_TILE - charOffset;

    // Death animation: shrink + fade
    if (obs.state === 'dying') {
      const progress = 1 - (obs.deathTimer / 1200);
      const scale = 1 - progress * 0.8;
      ctx.globalAlpha = 1 - progress;
      ctx.save();
      ctx.translate(px + SCALED_CHAR / 2, py + SCALED_CHAR / 2);
      ctx.scale(scale, scale);
      ctx.translate(-SCALED_CHAR / 2, -SCALED_CHAR / 2);
      px = 0; py = 0;
    }

    // Flash white on damage
    if (obs.flashTimer > 0) {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(obs.flashTimer * 0.05);
    }

    // Shadow
    ctx.fillStyle = COLORS.shadow;
    ctx.beginPath();
    ctx.ellipse(
      obs.renderX * SCALED_TILE + SCALED_TILE / 2,
      obs.renderY * SCALED_TILE + SCALED_TILE - SCALE,
      SCALE * 5 * obs.health, SCALE * 2, 0, 0, Math.PI * 2
    );
    ctx.fill();

    // Draw knight sprite
    if (img && img.complete && img.naturalWidth > 0) {
      const anim = SHEET.walkDown;
      const [row, startCol, frameCount] = anim;
      const frameIdx = Math.floor(globalFrame / 3) % frameCount;
      const col = startCol + frameIdx;
      const sx = col * SHEET.frameW;
      const sy = row * SHEET.frameH;

      // Scale by health (shrinks as it takes damage), apply type scale multiplier
      const baseDrawSize = SCALED_CHAR * (0.5 + 0.5 * obs.health);
      const drawSize = baseDrawSize * (obs.scaleMultiplier || 1.0);
      const offset = (SCALED_CHAR - drawSize) / 2;
      ctx.drawImage(img, sx, sy, SHEET.frameW, SHEET.frameH,
        px + offset, py + offset, drawSize, drawSize);
    } else {
      // Fallback colored rectangle
      ctx.fillStyle = '#f85149';
      ctx.fillRect(
        obs.renderX * SCALED_TILE + SCALE * 4,
        obs.renderY * SCALED_TILE + SCALE * 2,
        SCALE * 8, SCALE * 12
      );
    }

    if (obs.state === 'dying') {
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Draw knight variant effects
    if (CreatureConfig && obs.knightType && CreatureConfig.knightVariants[obs.knightType]?.drawEffect) {
      CreatureConfig.knightVariants[obs.knightType].drawEffect(
        ctx, SCALE, obs.renderX * SCALED_TILE, obs.renderY * SCALED_TILE, timestamp
      );
    }

    // Health bar (only when lurking and damaged)
    if (obs.state === 'lurking' && obs.health < 1) {
      const bx = obs.renderX * SCALED_TILE;
      const by = obs.renderY * SCALED_TILE - SCALE * 5;
      const bw = SCALED_TILE;

      // Casino: pulsing at low HP
      let barAlpha = 1;
      if (ProgressionConfig?.casinoMechanics) {
        barAlpha = ProgressionConfig.casinoMechanics.getHealthBarPulse(obs.health, timestamp);
      }

      ctx.globalAlpha = barAlpha;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, bw, SCALE * 2);
      ctx.fillStyle = obs.health > 0.3 ? '#f0883e' : '#f85149';
      ctx.fillRect(bx, by, bw * obs.health, SCALE * 2);
      ctx.globalAlpha = 1;
    }

    // Task label
    if (obs.state !== 'dying') {
      const labelX = obs.renderX * SCALED_TILE + SCALED_TILE / 2;
      const labelY = obs.renderY * SCALED_TILE - SCALE * 7;
      ctx.fillStyle = 'rgba(248, 81, 73, 0.8)';
      ctx.font = `bold ${SCALE * 2.5}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.fillText(obs.label, labelX, labelY);
      ctx.textAlign = 'left';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Office Pet System (Gatos) ──
  // ═══════════════════════════════════════════════════════════════

  const GATO_SPRITES = ['gato-v1.png', 'gato-02-v1.png', 'gato-03-v1.png'];
  const gatoImages = new Map();
  const gatos = new Map();
  let nextGatoId = 0;
  let gatoSpawnTimer = 0;
  const GATO_SPAWN_INTERVAL = 30000; // check every 30s if we can spawn a cat
  const MAX_GATOS = 2;

  function loadGatoSprites() {
    for (const file of GATO_SPRITES) {
      const img = new Image();
      img.src = `/plugins/pixel-agents/assets/sprites/characters/${file}`;
      gatoImages.set(file, img);
    }
  }

  function loadPropSprites() {
    const props = ['sunflowers', 'pumpkins', 'rock-pillars', 'sword', 'fountain'];
    for (const name of props) {
      const img = new Image();
      img.src = `/plugins/pixel-agents/assets/props/${name}.png`;
      propImages.set(name, img);
    }
  }

  function initProgressionSystems() {
    if (progressionInitialized) return;
    progressionInitialized = true;

    ProgressionConfig = typeof PixelProgressionConfig !== 'undefined' ? PixelProgressionConfig : null;
    CollabConfig = typeof PixelCollabConfig !== 'undefined' ? PixelCollabConfig : null;

    if (ProgressionConfig?.TensionEngine) {
      tensionEngine = new ProgressionConfig.TensionEngine();
    }
    if (CollabConfig?.CelebrationCascade) {
      celebrationCascade = new CollabConfig.CelebrationCascade();
    }
    if (CollabConfig?.RelayLineManager) {
      relayLineManager = new CollabConfig.RelayLineManager();
    }
  }

  function trySpawnGato() {
    if (gatos.size >= MAX_GATOS) return;
    if (obstacles.size > agents.size) return; // too many bugs — cats hide!

    CreatureConfig = typeof PixelCreatureConfig !== 'undefined' ? PixelCreatureConfig : null;

    const id = `gato-${nextGatoId++}`;
    let spriteIdx, personality;

    if (CreatureConfig) {
      const context = {
        tension: 0.3, // TODO: get from tension engine when integrated
        typingAgentIds: new Set([...agents.values()].filter(a => a.state === 'typing').map(a => a.id)),
        walkingAgentIds: new Set([...agents.values()].filter(a => a.state === 'walking').map(a => a.id)),
      };
      personality = CreatureConfig.selectGatoPersonality(context);
      const config = CreatureConfig.gatoPersonalities[personality];
      if (config) {
        // Find sprite index — check both base and extra gato sprites
        const allGatoSprites = [...GATO_SPRITES, ...EXTRA_GATO_SPRITES];
        spriteIdx = allGatoSprites.indexOf(config.spriteFile);
        if (spriteIdx < 0) spriteIdx = Math.floor(Math.random() * GATO_SPRITES.length);
      } else {
        spriteIdx = Math.floor(Math.random() * GATO_SPRITES.length);
      }
    } else {
      spriteIdx = Math.floor(Math.random() * GATO_SPRITES.length);
      personality = 'office';
    }

    const spawnX = Math.random() < 0.5 ? 1 : MAP_W - 2;
    const spawnY = MAP_H - 2;

    // Pick a cozy spot (near a plant or rug)
    const cozySpots = getInterestPoints().filter(p => p.label === 'plant' || p.label === 'lounge' || p.label === 'flowers' || p.label === 'tree' || p.label === 'meadow');
    const dest = cozySpots[Math.floor(Math.random() * cozySpots.length)];

    const gato = {
      id,
      spriteIdx,
      personality,
      x: spawnX, y: spawnY,
      renderX: spawnX, renderY: spawnY,
      state: 'walking',
      path: findPath(spawnX, spawnY, dest.x, dest.y),
      napTimer: 0,
      wanderTimer: 0,
      fleeing: false,
    };

    gatos.set(id, gato);
  }

  function updateGato(gato, dt) {
    // Flee if a knight gets close
    if (!gato.fleeing) {
      for (const obs of obstacles.values()) {
        if (obs.state === 'dying') continue;
        const dx = Math.abs(obs.x - gato.x);
        const dy = Math.abs(obs.y - gato.y);
        const scareRadius = (CreatureConfig && obs.knightType)
          ? (CreatureConfig.getScareRadius?.(obs.knightType) || 4)
          : 4;
        if (dx + dy <= scareRadius) {
          gato.fleeing = true;
          // Run to opposite side
          const fleeX = gato.x < MAP_W / 2 ? MAP_W - 3 : 2;
          const fleeY = MAP_H - 2;
          gato.path = findPath(gato.x, gato.y, fleeX, fleeY);
          gato.state = 'walking';
          gato.napTimer = 0;
          break;
        }
      }
    }

    // Movement
    if (gato.path && gato.path.length > 0) {
      gato.state = 'walking';
      const target = gato.path[0];
      const dx = target.x - gato.renderX;
      const dy = target.y - gato.renderY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = (gato.fleeing ? 4 : 1.5) * (dt / 1000);

      if (dist < speed) {
        gato.renderX = target.x;
        gato.renderY = target.y;
        gato.x = target.x;
        gato.y = target.y;
        gato.path.shift();
        if (gato.path.length === 0) {
          if (gato.fleeing) {
            // Fled off-map basically, despawn
            gatos.delete(gato.id);
            return;
          }
          gato.state = 'idle';
          gato.napTimer = randBetween(8000, 20000); // nap for 8-20s
        }
      } else {
        gato.renderX += (dx / dist) * speed;
        gato.renderY += (dy / dist) * speed;
      }
      return;
    }

    // Napping
    if (gato.napTimer > 0) {
      gato.state = 'idle';
      gato.napTimer -= dt;
      if (gato.napTimer <= 0) {
        // Wander to a new cozy spot
        const spots = getInterestPoints().filter(p => p.label === 'plant' || p.label === 'lounge' || p.label === 'flowers' || p.label === 'tree' || p.label === 'meadow');
        const dest = spots[Math.floor(Math.random() * spots.length)];
        gato.path = findPath(gato.x, gato.y, dest.x, dest.y);
        if (gato.path.length === 0) {
          gato.napTimer = randBetween(5000, 10000);
        }
      }
    }
  }

  function drawGato(gato, timestamp) {
    const allGatoSprites = [...GATO_SPRITES, ...EXTRA_GATO_SPRITES];
    const spriteFile = allGatoSprites[gato.spriteIdx % allGatoSprites.length];
    const img = gatoImages.get(spriteFile);

    const charOffset = (SCALED_CHAR - SCALED_TILE) / 2;
    const px = gato.renderX * SCALED_TILE - charOffset;
    const py = gato.renderY * SCALED_TILE - charOffset;

    if (img && img.complete && img.naturalWidth > 0) {
      let anim;
      if (gato.state === 'walking') {
        anim = SHEET.walkDown;
      } else {
        anim = SHEET.idleDown;
      }
      const [row, startCol, frameCount] = anim;
      const frameIdx = Math.floor(globalFrame / 3) % frameCount;
      const col = startCol + frameIdx;
      ctx.drawImage(img, col * SHEET.frameW, row * SHEET.frameH, SHEET.frameW, SHEET.frameH,
        px, py, SCALED_CHAR, SCALED_CHAR);
    }

    // Sleeping "z" when napping
    if (gato.state === 'idle' && gato.napTimer > 0) {
      const z = Math.sin(timestamp * 0.002) * SCALE;
      ctx.fillStyle = 'rgba(125, 133, 144, 0.5)';
      ctx.font = `${SCALE * 2.5}px monospace`;
      ctx.fillText('z', gato.renderX * SCALED_TILE + SCALED_TILE + SCALE, gato.renderY * SCALED_TILE - SCALE + z);
    }
  }

  function getAgentCount() { return agents.size; }
  function getCanvas() { return canvas; }
  function isVisible() { return visible; }

  function resize(width, height) {
    if (!canvas) return;
    canvas.style.maxWidth = width + 'px';
    canvas.style.maxHeight = height + 'px';
  }

  function sendRelayLine(fromAgentId, toAgentId, messageType) {
    if (!relayLineManager) return;
    const from = agents.get(fromAgentId);
    const to = agents.get(toAgentId);
    if (from && to) {
      relayLineManager.send(from, to, SCALED_TILE, messageType);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Special Creature System ──
  // ═══════════════════════════════════════════════════════════════

  function spawnSpecialCreature(key) {
    if (!CreatureConfig || !CreatureConfig.specialCreatures[key]) return;
    const config = CreatureConfig.specialCreatures[key];

    const spawnX = Math.random() < 0.5 ? 1 : MAP_W - 2;
    const spawnY = MAP_H - 2;

    const creature = {
      key,
      name: config.name,
      spriteFile: config.spriteFile,
      x: spawnX, y: spawnY,
      renderX: spawnX, renderY: spawnY,
      speed: config.speed || 2,
      scaleMultiplier: config.scaleMultiplier || 1.0,
      state: 'walking',
      path: [],
      spawnedAt: Date.now(),
      wanderTimer: 0,
    };

    // Walk to a random interior position
    const tx = 3 + Math.floor(Math.random() * (MAP_W - 6));
    const ty = 3 + Math.floor(Math.random() * (MAP_H - 5));
    creature.path = findPath(spawnX, spawnY, tx, ty);

    specialCreatures.set(key, creature);
  }

  function updateSpecialCreature(creature, dt) {
    // Movement
    if (creature.path && creature.path.length > 0) {
      const target = creature.path[0];
      const dx = target.x - creature.renderX;
      const dy = target.y - creature.renderY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = creature.speed * (dt / 1000);

      if (dist < speed) {
        creature.renderX = target.x;
        creature.renderY = target.y;
        creature.x = target.x;
        creature.y = target.y;
        creature.path.shift();
        if (creature.path.length === 0) {
          creature.state = 'idle';
          creature.wanderTimer = randBetween(3000, 6000);
        }
      } else {
        creature.renderX += (dx / dist) * speed;
        creature.renderY += (dy / dist) * speed;
      }
    } else if (creature.wanderTimer > 0) {
      creature.wanderTimer -= dt;
      if (creature.wanderTimer <= 0) {
        const wx = 3 + Math.floor(Math.random() * (MAP_W - 6));
        const wy = 3 + Math.floor(Math.random() * (MAP_H - 5));
        creature.path = findPath(creature.x, creature.y, wx, wy);
        creature.state = 'walking';
      }
    }

    // Check despawn
    if (CreatureConfig && CreatureConfig.shouldDespawn) {
      const context = { activeTaskCount: obstacles.size, agents, obstacles, tension: 0.3, now: Date.now() };
      if (CreatureConfig.shouldDespawn(creature.key, context, creature.spawnedAt)) {
        specialCreatures.delete(creature.key);
      }
    }
  }

  function drawSpecialCreature(creature, timestamp) {
    const img = spriteImages.get(creature.spriteFile);
    const charOffset = (SCALED_CHAR - SCALED_TILE) / 2;
    const px = creature.renderX * SCALED_TILE - charOffset;
    const py = creature.renderY * SCALED_TILE - charOffset;
    const size = SCALED_CHAR * (creature.scaleMultiplier || 1.0);
    const offset = (SCALED_CHAR - size) / 2;

    if (img && img.complete && img.naturalWidth > 0) {
      const anim = creature.state === 'walking' ? SHEET.walkDown : SHEET.idleDown;
      const [row, startCol, frameCount] = anim;
      const frameIdx = Math.floor(globalFrame / 3) % frameCount;
      const col = startCol + frameIdx;
      ctx.drawImage(img, col * SHEET.frameW, row * SHEET.frameH, SHEET.frameW, SHEET.frameH,
        px + offset, py + offset, size, size);
    }

    // Name label
    const labelX = creature.renderX * SCALED_TILE + SCALED_TILE / 2;
    const labelY = creature.renderY * SCALED_TILE - SCALE * 3;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.font = `bold ${SCALE * 3}px ${getComputedStyle(document.body).fontFamily}`;
    const nameWidth = ctx.measureText(creature.name).width || SCALE * 15;
    ctx.fillRect(labelX - nameWidth/2 - SCALE*2, labelY - SCALE*3, nameWidth + SCALE*4, SCALE*4.5);
    ctx.fillStyle = '#f85149';
    ctx.textAlign = 'center';
    ctx.fillText(creature.name, labelX, labelY);
    ctx.textAlign = 'left';

    // Draw creature-specific effect
    if (CreatureConfig?.specialCreatures[creature.key]?.drawEffect) {
      CreatureConfig.specialCreatures[creature.key].drawEffect(
        ctx, SCALE, creature.renderX * SCALED_TILE, creature.renderY * SCALED_TILE, timestamp
      );
    }
  }

  return {
    init, show, hide,
    spawnAgent, despawnAgent, setAgentState,
    spawnObstacle, resolveObstacle, damageObstacle,
    getAgentCount, getCanvas, isVisible, resize,
    switchScene, currentScene: () => currentScene,
    sendRelayLine,
    tensionEngine: () => tensionEngine,
    celebrationCascade: () => celebrationCascade,
    relayLineManager: () => relayLineManager,
    specialCreatures,
    TILE_SIZE, SCALE, SCALED_TILE, MAP_W, MAP_H,
    agents, obstacles, gatos, furniture,
    CHAR_SPRITES, LABEL_COLORS,
  };
})();
