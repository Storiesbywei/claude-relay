// === Pixel Creatures — Creature Type Registry for Claude Relay Office ===
// Defines knight variants, special creatures, and gato personalities.
// Loaded BEFORE pixel-agents.js. Exposes window.PixelCreatureConfig.
// Asset credit: Pixel Plains by SnowHex (snowhex.itch.io/pixel-plains)

/**
 * @typedef {'lurk'|'patrol'|'aggressive'|'spawner'} KnightBehavior
 * @typedef {'chase'|'hover'|'courier'|'mediator'|'tease'} SpecialBehavior
 * @typedef {'ambient'|'productivity'|'curious'|'lazy'|'adventurous'} GatoPersonality
 */

window.PixelCreatureConfig = (() => {
  'use strict';

  // ── Knight Variant Configurations ─────────────────────────────────────
  // Each variant maps to a colored knight sprite and defines how it behaves
  // when spawned as a task obstacle in the office.

  /** @type {Record<string, Object>} */
  const knightVariants = {
    normal: {
      spriteFile: 'knight-01-v1.png',
      color: '#3fb950',
      label: 'task',
      speed: 1.5,
      scaleMultiplier: 1.0,
      healthMultiplier: 1.0,
      catScareRadius: 4,
      behavior: 'lurk',
      keywords: [],
      drawEffect: null,
    },

    review: {
      spriteFile: 'knight-02-v1.png',
      color: '#58a6ff',
      label: 'review',
      speed: 2.0,
      scaleMultiplier: 1.0,
      healthMultiplier: 0.8,
      catScareRadius: 3,
      behavior: 'patrol',
      keywords: ['review', 'pr', 'pull request', 'feedback', 'approve'],
      drawEffect: null,
    },

    critical: {
      spriteFile: 'knight-03-v1.png',
      color: '#f85149',
      label: 'BUG',
      speed: 1.0,
      scaleMultiplier: 1.5,
      healthMultiplier: 2.0,
      catScareRadius: 6,
      behavior: 'aggressive',
      keywords: ['bug', 'critical', 'crash', 'broken', 'emergency', 'hotfix', 'urgent'],

      /**
       * Pulsing red danger aura around critical bugs.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x - pixel x position (center)
       * @param {number} y - pixel y position (center)
       * @param {number} timestamp - performance.now()
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const pulse = 0.4 + 0.3 * Math.sin(timestamp / 300);
        const radius = 18 * SCALE * (0.9 + 0.15 * Math.sin(timestamp / 400));
        const gradient = ctx.createRadialGradient(x, y, 2 * SCALE, x, y, radius);
        gradient.addColorStop(0, `rgba(248, 81, 73, ${pulse * 0.35})`);
        gradient.addColorStop(0.6, `rgba(248, 81, 73, ${pulse * 0.12})`);
        gradient.addColorStop(1, 'rgba(248, 81, 73, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      },
    },

    techDebt: {
      spriteFile: 'knight-04-v1.png',
      color: '#7c6aef',
      label: 'debt',
      speed: 0.8,
      scaleMultiplier: 1.0,
      healthMultiplier: 1.5,
      catScareRadius: 4,
      behavior: 'spawner',
      spawnInterval: 60000,
      spawnKnightType: 'normal',
      spawnScaleMultiplier: 0.7,
      spawnHealthMultiplier: 0.5,
      keywords: ['refactor', 'tech debt', 'cleanup', 'legacy', 'deprecated', 'todo'],

      /**
       * Purple miasma dripping from tech debt knights.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x
       * @param {number} y
       * @param {number} timestamp
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const t = timestamp / 1000;
        ctx.save();
        ctx.globalAlpha = 0.2 + 0.1 * Math.sin(t * 2);
        for (let i = 0; i < 3; i++) {
          const offsetX = Math.sin(t + i * 2.1) * 6 * SCALE;
          const offsetY = (t * 8 + i * 5) % (12 * SCALE);
          ctx.fillStyle = '#7c6aef';
          ctx.beginPath();
          ctx.arc(x + offsetX, y + 8 * SCALE + offsetY, 2 * SCALE, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
    },
  };

  // ── Special Creature Configurations ───────────────────────────────────
  // Unique creatures that appear under specific gameplay conditions.

  /** @type {Record<string, Object>} */
  const specialCreatures = {
    redDemon: {
      name: 'Scope Creep',
      spriteFile: 'special-1-v1.png',
      trigger: { type: 'taskCount', threshold: 6 },
      speed: 2.5,
      scaleMultiplier: 1.3,
      behavior: 'chase',
      despawnCondition: { type: 'taskCount', below: 4 },

      /**
       * Menacing red smoke trail behind the Scope Creep demon.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x
       * @param {number} y
       * @param {number} timestamp
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const t = timestamp / 1000;
        ctx.save();
        // Pulsing inner glow
        const glowPulse = 0.3 + 0.15 * Math.sin(t * 3);
        const glowR = 14 * SCALE;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        glow.addColorStop(0, `rgba(200, 30, 20, ${glowPulse})`);
        glow.addColorStop(1, 'rgba(200, 30, 20, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - glowR, y - glowR, glowR * 2, glowR * 2);

        // Smoke particles rising
        for (let i = 0; i < 5; i++) {
          const phase = t * 1.5 + i * 1.26;
          const life = (phase % 2) / 2;  // 0..1 cycle
          const px = x + Math.sin(phase * 3) * 5 * SCALE;
          const py = y - life * 16 * SCALE;
          const size = (1 - life) * 3 * SCALE;
          const alpha = (1 - life) * 0.35;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#8b0000';
          ctx.beginPath();
          ctx.arc(px, py, size, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
    },

    iceElemental: {
      name: 'Blocker',
      spriteFile: 'special-2-v1.png',
      trigger: { type: 'agentWaiting', durationMs: 20000 },
      speed: 0.5,
      scaleMultiplier: 1.2,
      behavior: 'hover',
      despawnCondition: { type: 'agentActive' },

      /**
       * Crystalline ice particles and cold blue glow.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x
       * @param {number} y
       * @param {number} timestamp
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const t = timestamp / 1000;
        ctx.save();

        // Cold blue glow
        const glowR = 16 * SCALE;
        const pulse = 0.25 + 0.1 * Math.sin(t * 1.5);
        const glow = ctx.createRadialGradient(x, y, 2 * SCALE, x, y, glowR);
        glow.addColorStop(0, `rgba(88, 166, 255, ${pulse})`);
        glow.addColorStop(0.5, `rgba(130, 200, 255, ${pulse * 0.4})`);
        glow.addColorStop(1, 'rgba(88, 166, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - glowR, y - glowR, glowR * 2, glowR * 2);

        // Floating ice crystal particles — diamond shapes
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI * 2 / 6) * i + t * 0.4;
          const orbitR = (8 + 3 * Math.sin(t + i)) * SCALE;
          const cx = x + Math.cos(angle) * orbitR;
          const cy = y + Math.sin(angle) * orbitR * 0.6 - 4 * SCALE;
          const size = (1.5 + 0.5 * Math.sin(t * 2 + i)) * SCALE;
          ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 2 + i * 1.1);
          ctx.fillStyle = '#a8d8ff';
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle + t);
          ctx.beginPath();
          ctx.moveTo(0, -size);
          ctx.lineTo(size * 0.6, 0);
          ctx.lineTo(0, size);
          ctx.lineTo(-size * 0.6, 0);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        ctx.restore();
      },
    },

    blueCat: {
      name: 'CI/CD',
      spriteFile: 'special-3-v1.png',
      trigger: { type: 'messageType', types: ['terminal', 'status_update'] },
      speed: 4.0,
      scaleMultiplier: 0.9,
      behavior: 'courier',
      despawnCondition: { type: 'timer', durationMs: 15000 },

      /**
       * Speed lines trailing behind the fast CI/CD cat.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x
       * @param {number} y
       * @param {number} timestamp
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const t = timestamp / 1000;
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = SCALE;
        ctx.lineCap = 'round';

        for (let i = 0; i < 4; i++) {
          const offsetY = (i - 1.5) * 3 * SCALE;
          const lineLen = (12 + 4 * Math.sin(t * 6 + i)) * SCALE;
          const fadeStart = 0.4 - i * 0.08;
          ctx.globalAlpha = fadeStart;
          ctx.beginPath();
          ctx.moveTo(x + 6 * SCALE, y + offsetY);
          ctx.lineTo(x + 6 * SCALE + lineLen, y + offsetY);
          ctx.stroke();
        }

        // Small blue spark at front
        const sparkAlpha = 0.4 + 0.3 * Math.sin(t * 10);
        ctx.globalAlpha = sparkAlpha;
        ctx.fillStyle = '#82c8ff';
        ctx.beginPath();
        ctx.arc(x - 4 * SCALE, y - 2 * SCALE, 1.5 * SCALE, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      },
    },

    pinkPanda: {
      name: 'Pair Prog',
      spriteFile: 'special-4-v1.png',
      trigger: { type: 'agentProximity', minAgents: 2, durationMs: 60000 },
      speed: 1.0,
      scaleMultiplier: 1.0,
      behavior: 'mediator',
      effect: { damageBoost: 1.5 },
      despawnCondition: { type: 'agentSeparated' },

      /**
       * Floating hearts and a warm boost aura around the pair programmer.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x
       * @param {number} y
       * @param {number} timestamp
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const t = timestamp / 1000;
        ctx.save();

        // Warm pink boost aura
        const auraR = 20 * SCALE;
        const auraPulse = 0.12 + 0.06 * Math.sin(t * 2);
        const aura = ctx.createRadialGradient(x, y, 4 * SCALE, x, y, auraR);
        aura.addColorStop(0, `rgba(219, 97, 162, ${auraPulse})`);
        aura.addColorStop(1, 'rgba(219, 97, 162, 0)');
        ctx.fillStyle = aura;
        ctx.fillRect(x - auraR, y - auraR, auraR * 2, auraR * 2);

        // Floating heart particles
        for (let i = 0; i < 3; i++) {
          const phase = t * 0.8 + i * 2.1;
          const life = (phase % 3) / 3;
          const hx = x + Math.sin(phase * 2) * 6 * SCALE;
          const hy = y - life * 18 * SCALE;
          const size = (1 - life * 0.5) * 2 * SCALE;
          ctx.globalAlpha = (1 - life) * 0.6;
          ctx.fillStyle = '#ff6b9d';
          drawHeart(ctx, hx, hy, size);
        }

        ctx.restore();
      },
    },

    bunny: {
      name: 'Easter Egg',
      spriteFile: 'basic-bunny-character-v1.png',
      trigger: { type: 'random', minIntervalMs: 120000, maxIntervalMs: 300000 },
      speed: 3.0,
      scaleMultiplier: 0.8,
      behavior: 'tease',
      stayDurationMs: 8000,
      rewardTiers: [
        { weight: 60, particles: 3,  color: '#ffd700', label: 'Common' },
        { weight: 25, particles: 6,  color: '#58a6ff', label: 'Rare' },
        { weight: 10, particles: 12, color: '#7c6aef', label: 'Epic' },
        { weight: 5,  particles: 20, color: '#f0883e', label: 'Legendary' },
      ],

      /**
       * Sparkle trail and floating punctuation bubble above the bunny.
       * @param {CanvasRenderingContext2D} ctx
       * @param {number} SCALE
       * @param {number} x
       * @param {number} y
       * @param {number} timestamp
       */
      drawEffect(ctx, SCALE, x, y, timestamp) {
        const t = timestamp / 1000;
        ctx.save();

        // Sparkle trail
        for (let i = 0; i < 5; i++) {
          const age = (t * 2 + i * 0.7) % 2;
          const sparkX = x + Math.sin(t * 3 + i * 1.3) * 4 * SCALE;
          const sparkY = y + 2 * SCALE + age * 6 * SCALE;
          const sparkSize = (1 - age / 2) * 1.5 * SCALE;
          ctx.globalAlpha = (1 - age / 2) * 0.6;
          ctx.fillStyle = '#ffd700';
          drawStar(ctx, sparkX, sparkY, sparkSize, 4);
        }

        // Punctuation bubble — alternates between "?" and "!"
        const symbol = Math.floor(t / 2) % 2 === 0 ? '?' : '!';
        const bobY = Math.sin(t * 3) * 2 * SCALE;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${5 * SCALE}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(symbol, x, y - 12 * SCALE + bobY);

        ctx.restore();
      },
    },
  };

  // ── Gato Personality Configurations ───────────────────────────────────
  // Each personality defines how an office cat behaves, what triggers its
  // appearance, and how it interacts with agents and knights.

  /** @type {Record<string, Object>} */
  const gatoPersonalities = {
    office: {
      spriteFile: 'gato-v1.png',
      personality: 'ambient',
      fleeFromKnights: true,
      fleeRadius: 4,
      napDuration: { min: 8000, max: 20000 },
      wanderTargets: ['plant', 'lounge', 'watercooler'],
      trigger: null,
    },

    productivity: {
      spriteFile: 'gato-02-v1.png',
      personality: 'productivity',
      fleeFromKnights: true,
      fleeRadius: 3,
      trigger: { agentTypingDurationMs: 30000 },
      behavior: 'sitNearAgent',
      napDuration: { min: 15000, max: 30000 },
      wanderTargets: null,
    },

    curious: {
      spriteFile: 'gato-03-v1.png',
      personality: 'curious',
      fleeFromKnights: true,
      fleeRadius: 5,
      behavior: 'followAgent',
      followDistance: 2,
      napDuration: { min: 5000, max: 12000 },
      trigger: null,
      wanderTargets: null,
    },

    lazy: {
      spriteFile: 'gato-4-v1.png',
      personality: 'lazy',
      fleeFromKnights: true,
      fleeRadius: 6,
      trigger: { maxTension: 0.2 },
      napDuration: { min: 20000, max: 60000 },
      wanderTargets: ['lounge', 'rug'],
      behavior: null,
    },

    adventurous: {
      spriteFile: 'gato-5-v1.png',
      personality: 'adventurous',
      fleeFromKnights: false,
      fleeRadius: 0,
      behavior: 'approachKnight',
      approachRadius: 3,
      napDuration: { min: 6000, max: 15000 },
      trigger: null,
      wanderTargets: null,
    },
  };

  // ── Daily Special Creature Schedule ───────────────────────────────────
  // One featured special creature per day of the week. The daily special
  // has a lower trigger threshold, making it more likely to appear.

  /** @type {Record<number, string>} */
  const DAILY_SPECIALS = {
    0: 'bunny',         // Sunday — chill easter egg day
    1: 'blueCat',       // Monday — CI/CD kicks off the work week
    2: 'pinkPanda',     // Tuesday — collaboration day
    3: 'bunny',         // Wednesday — hump day treat
    4: 'redDemon',      // Thursday — scope creep before sprint end
    5: 'bunny',         // Friday — fun day
    6: 'iceElemental',  // Saturday — things freeze on weekends
  };

  // ── Drawing Helpers ───────────────────────────────────────────────────

  /**
   * Draw a small heart shape centered at (cx, cy).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx
   * @param {number} cy
   * @param {number} size - radius of each lobe
   */
  function drawHeart(ctx, cx, cy, size) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + size * 0.4);
    ctx.bezierCurveTo(cx - size, cy - size * 0.5, cx - size * 0.5, cy - size * 1.2, cx, cy - size * 0.5);
    ctx.bezierCurveTo(cx + size * 0.5, cy - size * 1.2, cx + size, cy - size * 0.5, cx, cy + size * 0.4);
    ctx.fill();
  }

  /**
   * Draw a small star/sparkle centered at (cx, cy).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx
   * @param {number} cy
   * @param {number} size - outer radius
   * @param {number} points - number of points
   */
  function drawStar(ctx, cx, cy, size, points) {
    const inner = size * 0.4;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? size : inner;
      const angle = (Math.PI * i) / points - Math.PI / 2;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  // ── Classification & Spawn Logic ──────────────────────────────────────

  /**
   * Classify a task into a knight variant based on label and message content.
   * Checks non-default variants' keyword lists; falls back to 'normal'.
   * @param {string} label - task label/title
   * @param {string} messageContent - full message body
   * @returns {string} knight variant key
   */
  function classifyKnight(label, messageContent) {
    const combined = ((label || '') + ' ' + (messageContent || '')).toLowerCase();

    // Check in priority order: critical first (most specific), then others
    const priorityOrder = ['critical', 'techDebt', 'review'];
    for (const type of priorityOrder) {
      const config = knightVariants[type];
      if (config.keywords.some(kw => combined.includes(kw))) {
        return type;
      }
    }
    return 'normal';
  }

  /**
   * Evaluate current game state and return an array of special creature
   * types that should spawn. Called every ~5 seconds from the game loop.
   *
   * @param {Object} context
   * @param {number}     context.activeTaskCount - live obstacles on the map
   * @param {Map}        context.agents          - agent id -> agent state
   * @param {Map}        context.obstacles       - obstacle id -> obstacle state
   * @param {number}     context.tension         - 0..1 tension level
   * @param {string|null} context.lastMessageType - most recent message type
   * @param {number}     context.now             - performance.now()
   * @param {Set}        context.activeSpecials  - set of currently spawned special keys
   * @returns {string[]} array of special creature keys to spawn
   */
  function checkSpecialSpawns(context) {
    const {
      activeTaskCount, agents, obstacles,
      lastMessageType, now, activeSpecials,
    } = context;
    const spawns = [];

    // Guard: don't double-spawn any creature already on the map
    const canSpawn = (key) => !activeSpecials || !activeSpecials.has(key);

    // Red Demon — scope creep when too many active tasks
    if (canSpawn('redDemon') && activeTaskCount >= specialCreatures.redDemon.trigger.threshold) {
      spawns.push('redDemon');
    }

    // Ice Elemental — appears near agents stuck in waiting state
    if (canSpawn('iceElemental') && agents) {
      for (const [, agent] of agents) {
        if (agent.state === 'waiting' && agent.waitingSince) {
          const waitDuration = now - agent.waitingSince;
          if (waitDuration >= specialCreatures.iceElemental.trigger.durationMs) {
            spawns.push('iceElemental');
            break; // one elemental is enough
          }
        }
      }
    }

    // Blue Cat — courier triggered by terminal/status messages
    if (canSpawn('blueCat') && lastMessageType) {
      const triggerTypes = specialCreatures.blueCat.trigger.types;
      if (triggerTypes.includes(lastMessageType)) {
        spawns.push('blueCat');
      }
    }

    // Pink Panda — pair programming when agents are close together
    if (canSpawn('pinkPanda') && agents && agents.size >= 2) {
      const agentList = [...agents.values()];
      for (let i = 0; i < agentList.length; i++) {
        for (let j = i + 1; j < agentList.length; j++) {
          const a = agentList[i];
          const b = agentList[j];
          const dist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          if (dist <= 3 && a.proximityStart && b.proximityStart) {
            const elapsed = Math.min(now - a.proximityStart, now - b.proximityStart);
            if (elapsed >= specialCreatures.pinkPanda.trigger.durationMs) {
              spawns.push('pinkPanda');
            }
          }
        }
        if (spawns.includes('pinkPanda')) break;
      }
    }

    // Bunny — random easter egg on a timer
    if (canSpawn('bunny')) {
      const cfg = specialCreatures.bunny;
      if (!_bunnyState.nextSpawnAt) {
        _bunnyState.nextSpawnAt = now + randBetween(cfg.trigger.minIntervalMs, cfg.trigger.maxIntervalMs);
      }
      if (now >= _bunnyState.nextSpawnAt) {
        spawns.push('bunny');
        _bunnyState.nextSpawnAt = now + randBetween(cfg.trigger.minIntervalMs, cfg.trigger.maxIntervalMs);
      }
    }

    // Daily special has a lower threshold — boost its spawn chance
    const today = new Date().getDay();
    const dailyKey = DAILY_SPECIALS[today];
    if (dailyKey && canSpawn(dailyKey) && !spawns.includes(dailyKey)) {
      if (dailyKey === 'redDemon' && activeTaskCount >= 4) {
        spawns.push('redDemon');
      } else if (dailyKey === 'iceElemental') {
        // Lower wait threshold on featured day (12s instead of 20s)
        if (agents) {
          for (const [, agent] of agents) {
            if (agent.state === 'waiting' && agent.waitingSince && now - agent.waitingSince >= 12000) {
              spawns.push('iceElemental');
              break;
            }
          }
        }
      }
      // Bunny/blueCat/pinkPanda don't get extra daily boosts
    }

    return spawns;
  }

  /** Internal bunny spawn timer state */
  const _bunnyState = { nextSpawnAt: null };

  /**
   * Check whether a special creature should despawn based on current context.
   * @param {string} creatureKey - key in specialCreatures
   * @param {Object} context - same shape as checkSpecialSpawns context
   * @param {number} spawnedAt - timestamp when creature was spawned
   * @returns {boolean} true if the creature should be removed
   */
  function shouldDespawn(creatureKey, context, spawnedAt) {
    const cfg = specialCreatures[creatureKey];
    if (!cfg || !cfg.despawnCondition) return false;

    const cond = cfg.despawnCondition;

    switch (cond.type) {
      case 'taskCount':
        return context.activeTaskCount < cond.below;

      case 'agentActive':
        // Despawn ice elemental when blocked agent resumes work
        if (context.agents) {
          let anyWaiting = false;
          for (const [, agent] of context.agents) {
            if (agent.state === 'waiting') { anyWaiting = true; break; }
          }
          return !anyWaiting;
        }
        return false;

      case 'timer':
        return (context.now - spawnedAt) >= cond.durationMs;

      case 'agentSeparated':
        // Despawn panda when paired agents separate
        if (!context.agents || context.agents.size < 2) return true;
        const agentList = [...context.agents.values()];
        for (let i = 0; i < agentList.length; i++) {
          for (let j = i + 1; j < agentList.length; j++) {
            const dist = Math.abs(agentList[i].x - agentList[j].x) +
                         Math.abs(agentList[i].y - agentList[j].y);
            if (dist <= 4) return false; // still paired
          }
        }
        return true;

      default:
        return false;
    }
  }

  /**
   * Select a gato personality for the next cat spawn based on game state.
   * Higher-tension environments suppress certain personalities; low tension
   * unlocks the lazy cat.
   *
   * @param {Object} context
   * @param {number}     context.tension        - 0..1
   * @param {Map}        context.agents         - agent map
   * @param {Set|null}   context.typingAgentIds - agents currently typing
   * @param {Set|null}   context.walkingAgentIds - agents currently walking
   * @returns {string} personality key from gatoPersonalities
   */
  function selectGatoPersonality(context) {
    const { tension, typingAgentIds, walkingAgentIds } = context;
    const candidates = [];

    // Office cat is always a candidate
    candidates.push({ key: 'office', weight: 30 });

    // Productivity cat — if any agent has been typing
    if (typingAgentIds && typingAgentIds.size > 0) {
      candidates.push({ key: 'productivity', weight: 25 });
    }

    // Curious cat — if any agent is walking around
    if (walkingAgentIds && walkingAgentIds.size > 0) {
      candidates.push({ key: 'curious', weight: 20 });
    }

    // Lazy cat — only in calm environments
    if (tension <= (gatoPersonalities.lazy.trigger.maxTension || 0.2)) {
      candidates.push({ key: 'lazy', weight: 15 });
    }

    // Adventurous cat — less likely but always possible
    candidates.push({ key: 'adventurous', weight: 10 });

    return weightedRandom(candidates);
  }

  /**
   * Roll the bunny's reward tier using weighted random selection.
   * @returns {{ particles: number, color: string, label: string }}
   */
  function rollBunnyReward() {
    const tiers = specialCreatures.bunny.rewardTiers;
    const totalWeight = tiers.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const tier of tiers) {
      roll -= tier.weight;
      if (roll <= 0) {
        return { particles: tier.particles, color: tier.color, label: tier.label };
      }
    }
    // Fallback to last tier
    const last = tiers[tiers.length - 1];
    return { particles: last.particles, color: last.color, label: last.label };
  }

  /**
   * Get the scare radius for a given knight variant, accounting for special
   * creatures that also scare cats (like the red demon).
   * @param {string} variantKey - knight variant or special creature key
   * @returns {number} scare radius in tiles
   */
  function getScareRadius(variantKey) {
    if (knightVariants[variantKey]) {
      return knightVariants[variantKey].catScareRadius;
    }
    // Special creatures that scare cats
    if (variantKey === 'redDemon') return 8;
    if (variantKey === 'iceElemental') return 5;
    return 0;
  }

  // ── Utility Functions ─────────────────────────────────────────────────

  /**
   * Random integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function randBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Pick from weighted candidates. Each candidate is { key, weight }.
   * @param {{ key: string, weight: number }[]} candidates
   * @returns {string} selected key
   */
  function weightedRandom(candidates) {
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * total;
    for (const c of candidates) {
      roll -= c.weight;
      if (roll <= 0) return c.key;
    }
    return candidates[candidates.length - 1].key;
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    knightVariants,
    specialCreatures,
    gatoPersonalities,
    DAILY_SPECIALS,
    classifyKnight,
    checkSpecialSpawns,
    shouldDespawn,
    selectGatoPersonality,
    rollBunnyReward,
    getScareRadius,
    drawHeart,
    drawStar,
  };
})();
