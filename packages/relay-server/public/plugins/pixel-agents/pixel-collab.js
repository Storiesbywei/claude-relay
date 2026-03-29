// === Pixel Collab — Multi-Agent Collaboration Visuals for Claude Relay ===
// Formations, focus beams, shared thought bubbles, celebration cascades,
// relay data lines, environmental storytelling, and damage multipliers.
// Loaded BEFORE pixel-agents.js. Exposes window.PixelCollabConfig.

window.PixelCollabConfig = (() => {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────
  // 1. Formation System
  // ────────────────────────────────────────────────────────────────────────
  // When multiple agents converge on the same knight, arrange them in a
  // geometric formation so they don't overlap.

  /**
   * Return tile positions for agentCount agents around a target tile.
   * Positions are clamped within map bounds.
   * @param {number} targetX - knight tile X
   * @param {number} targetY - knight tile Y
   * @param {number} agentCount - 1–4
   * @param {number} MAP_W
   * @param {number} MAP_H
   * @returns {{x:number, y:number}[]}
   */
  function getFormationPositions(targetX, targetY, agentCount, MAP_W, MAP_H) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const offsets = [];

    switch (Math.min(agentCount, 4)) {
      case 1:
        // Face from the left
        offsets.push({ x: -1, y: 0 });
        break;
      case 2:
        // Flank — one on each side
        offsets.push({ x: -1, y: 0 }, { x: 1, y: 0 });
        break;
      case 3:
        // Triangle — two flank, one behind
        offsets.push({ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
        break;
      case 4:
      default:
        // Cardinal (N S E W)
        offsets.push({ x: 0, y: -1 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: -1, y: 0 });
        break;
    }

    return offsets.map(o => ({
      x: clamp(targetX + o.x, 1, MAP_W - 2),
      y: clamp(targetY + o.y, 1, MAP_H - 2),
    }));
  }

  /**
   * Determine which agents should form around a given obstacle.
   * Criteria: assigned to the obstacle's task OR within 3 tiles and working.
   * @param {Map|Array} agents - agents collection (Map or iterable of agent objects)
   * @param {{id:string, renderX:number, renderY:number, assignedAgentId:string}} obstacle
   * @returns {string[]} array of agent IDs
   */
  function shouldFormation(agents, obstacle) {
    const ids = [];
    const agentList = agents instanceof Map ? [...agents.values()] : agents;

    for (const agent of agentList) {
      // Directly assigned to this obstacle's task
      if (agent.id === obstacle.assignedAgentId) {
        ids.push(agent.id);
        continue;
      }
      // Within 3 tiles and actively working (typing or reading)
      if (agent.state === 'typing' || agent.state === 'reading') {
        const dx = Math.abs(agent.renderX - obstacle.renderX);
        const dy = Math.abs(agent.renderY - obstacle.renderY);
        if (dx + dy <= 3) {
          ids.push(agent.id);
        }
      }
    }
    return ids;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 2. Focus Beams
  // ────────────────────────────────────────────────────────────────────────
  // Animated dashed lines from working agents to their targeted knight,
  // with a golden sparkle at the convergence midpoint.

  /**
   * Draw an animated dashed beam from agent to target.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {number} agentX - tile x (float)
   * @param {number} agentY - tile y (float)
   * @param {number} targetX - tile x (float)
   * @param {number} targetY - tile y (float)
   * @param {number} timestamp - performance.now()
   * @param {string} color - beam color
   */
  function drawFocusBeam(ctx, SCALE, SCALED_TILE, agentX, agentY, targetX, targetY, timestamp, color) {
    const halfTile = SCALED_TILE / 2;
    const ax = agentX * SCALED_TILE + halfTile;
    const ay = agentY * SCALED_TILE + halfTile;
    const tx = targetX * SCALED_TILE + halfTile;
    const ty = targetY * SCALED_TILE + halfTile;

    // Animated dashed line
    ctx.save();
    ctx.strokeStyle = color || '#ffd700';
    ctx.lineWidth = SCALE;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([SCALE * 3, SCALE * 2]);
    ctx.lineDashOffset = -(timestamp * 0.05) % 20;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    // Reset dash immediately
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Gold sparkle cross at midpoint
    const mx = (ax + tx) / 2;
    const my = (ay + ty) / 2;
    const sparkSize = SCALE * 2 + SCALE * Math.sin(timestamp * 0.008);
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = SCALE * 0.8;
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(timestamp * 0.006);

    ctx.beginPath();
    ctx.moveTo(mx - sparkSize, my);
    ctx.lineTo(mx + sparkSize, my);
    ctx.moveTo(mx, my - sparkSize);
    ctx.lineTo(mx, my + sparkSize);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw focus beams for all agents that are typing/reading and have an
   * assigned obstacle.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {Map|Array} agents
   * @param {Map|Array} obstacles
   * @param {number} timestamp
   */
  function drawAllFocusBeams(ctx, SCALE, SCALED_TILE, agents, obstacles, timestamp) {
    const agentList = agents instanceof Map ? [...agents.values()] : agents;
    const obsMap = obstacles instanceof Map ? obstacles : new Map(obstacles.map(o => [o.id, o]));
    const beamColors = ['#ffd700', '#58a6ff', '#3fb950', '#f0883e', '#db61a2', '#7c6aef'];

    for (let i = 0; i < agentList.length; i++) {
      const agent = agentList[i];
      if (agent.state !== 'typing' && agent.state !== 'reading') continue;

      // Find the obstacle this agent is assigned to
      for (const obs of obsMap.values()) {
        if (obs.assignedAgentId === agent.id && obs.state !== 'dying') {
          drawFocusBeam(
            ctx, SCALE, SCALED_TILE,
            agent.renderX, agent.renderY,
            obs.renderX, obs.renderY,
            timestamp,
            beamColors[i % beamColors.length]
          );
          break; // one beam per agent
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3. Shared Thought Bubbles
  // ────────────────────────────────────────────────────────────────────────
  // Large speech bubble spanning two adjacent working agents with gentle
  // bobbing animation and placeholder content lines inside.

  /**
   * Find pairs of working agents within 2 tiles of each other.
   * @param {Map|Array} agents
   * @returns {Array<[Object, Object]>}
   */
  function findAdjacentPairs(agents) {
    const list = agents instanceof Map ? [...agents.values()] : agents;
    const working = list.filter(a => a.state === 'typing' || a.state === 'reading');
    const pairs = [];
    const used = new Set();

    for (let i = 0; i < working.length; i++) {
      if (used.has(working[i].id)) continue;
      for (let j = i + 1; j < working.length; j++) {
        if (used.has(working[j].id)) continue;
        const dx = Math.abs(working[i].renderX - working[j].renderX);
        const dy = Math.abs(working[i].renderY - working[j].renderY);
        if (dx + dy <= 2) {
          pairs.push([working[i], working[j]]);
          used.add(working[i].id);
          used.add(working[j].id);
          break;
        }
      }
    }
    return pairs;
  }

  /**
   * Draw a shared thought bubble above two agents with rounded rect,
   * two tails, and content line placeholders.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} SCALE
   * @param {number} SCALED_TILE
   * @param {Object} agent1
   * @param {Object} agent2
   * @param {number} timestamp
   */
  function drawSharedThoughtBubble(ctx, SCALE, SCALED_TILE, agent1, agent2, timestamp) {
    const halfTile = SCALED_TILE / 2;
    // Pixel centers of both agents
    const x1 = agent1.renderX * SCALED_TILE + halfTile;
    const y1 = agent1.renderY * SCALED_TILE;
    const x2 = agent2.renderX * SCALED_TILE + halfTile;
    const y2 = agent2.renderY * SCALED_TILE;

    // Bubble dimensions
    const bw = Math.abs(x2 - x1) + SCALED_TILE * 2.5;
    const bh = SCALE * 18;
    const bx = Math.min(x1, x2) - SCALED_TILE * 0.75;
    // Gentle bobbing
    const bob = Math.sin(timestamp * 0.002) * SCALE * 1.5;
    const by = Math.min(y1, y2) - bh - SCALE * 10 + bob;
    const radius = SCALE * 4;

    ctx.save();
    ctx.globalAlpha = 0.85;

    // ── Rounded rectangle body ──
    ctx.fillStyle = '#1c2129';
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = SCALE;
    ctx.beginPath();
    ctx.moveTo(bx + radius, by);
    ctx.lineTo(bx + bw - radius, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + radius);
    ctx.lineTo(bx + bw, by + bh - radius);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - radius, by + bh);
    ctx.lineTo(bx + radius, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - radius);
    ctx.lineTo(bx, by + radius);
    ctx.quadraticCurveTo(bx, by, bx + radius, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // ── Tails pointing down toward each agent ──
    ctx.fillStyle = '#1c2129';
    for (const ax of [x1, x2]) {
      ctx.beginPath();
      ctx.moveTo(ax - SCALE * 2, by + bh);
      ctx.lineTo(ax + SCALE * 2, by + bh);
      ctx.lineTo(ax, by + bh + SCALE * 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // ── 3 placeholder content lines ──
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#6e7681';
    const lineY = by + SCALE * 4;
    const lineSpacing = SCALE * 4.5;
    const lineWidths = [bw * 0.7, bw * 0.55, bw * 0.45];

    for (let i = 0; i < 3; i++) {
      const lx = bx + (bw - lineWidths[i]) / 2;
      const ly = lineY + i * lineSpacing;
      ctx.fillRect(lx, ly, lineWidths[i], SCALE * 1.5);
    }

    ctx.restore();
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4. Celebration Cascade
  // ────────────────────────────────────────────────────────────────────────
  // When a knight dies, golden cross-sparkle particles arc from the kill
  // location toward nearby damaged knights.

  class CelebrationCascade {
    constructor() {
      /** @type {Array<Object>} */
      this.cascadeParticles = [];
    }

    /**
     * Spawn cascade particles from a kill location toward nearby targets.
     * @param {number} killX - pixel x of the dead knight
     * @param {number} killY - pixel y of the dead knight
     * @param {number} SCALED_TILE
     * @param {{x:number, y:number, id:string}[]} targets - nearby knights
     */
    trigger(killX, killY, SCALED_TILE, targets) {
      const halfTile = SCALED_TILE / 2;

      for (const target of targets) {
        const tx = target.x * SCALED_TILE + halfTile;
        const ty = target.y * SCALED_TILE + halfTile;
        const count = 3 + Math.floor(Math.random() * 3); // 3–5 per target

        for (let i = 0; i < count; i++) {
          this.cascadeParticles.push({
            x: killX,
            y: killY,
            targetX: tx,
            targetY: ty,
            targetId: target.id,
            progress: 0,          // 0 → 1
            delay: i * 80,        // stagger ms
            speed: 0.6 + Math.random() * 0.4,
            arcOffset: (Math.random() - 0.5) * 30, // sine amplitude for Y arc
            size: 2 + Math.random() * 2,
            alpha: 1,
          });
        }
      }
    }

    /**
     * Advance particles toward their targets.
     * @param {number} dt - delta time ms
     * @param {number} SCALE
     */
    update(dt, SCALE) {
      for (let i = this.cascadeParticles.length - 1; i >= 0; i--) {
        const p = this.cascadeParticles[i];

        // Handle stagger delay
        if (p.delay > 0) {
          p.delay -= dt;
          continue;
        }

        p.progress += p.speed * (dt / 1000);

        // Lerp position
        const t = Math.min(p.progress, 1);
        p.x = p.x + (p.targetX - p.x) * (dt / 400);
        p.y = p.y + (p.targetY - p.y) * (dt / 400);
        // Add gentle sine arc to Y
        p.y += Math.sin(t * Math.PI) * p.arcOffset * (dt / 1000);

        p.alpha = 1 - t * 0.4;

        // Remove when arrived or expired
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        if (Math.sqrt(dx * dx + dy * dy) < SCALE * 3 || p.progress >= 1) {
          this.cascadeParticles.splice(i, 1);
        }
      }
    }

    /**
     * Render cascade particles as golden cross-sparkles.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} SCALE
     * @param {number} timestamp
     */
    draw(ctx, SCALE, timestamp) {
      if (this.cascadeParticles.length === 0) return;

      ctx.save();
      for (const p of this.cascadeParticles) {
        if (p.delay > 0) continue;

        const sparkle = p.size * SCALE * (0.6 + 0.4 * Math.sin(timestamp * 0.01 + p.progress * 10));

        ctx.globalAlpha = p.alpha;
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = SCALE * 0.7;

        // Cross shape
        ctx.beginPath();
        ctx.moveTo(p.x - sparkle, p.y);
        ctx.lineTo(p.x + sparkle, p.y);
        ctx.moveTo(p.x, p.y - sparkle);
        ctx.lineTo(p.x, p.y + sparkle);
        ctx.stroke();

        // Diagonal cross for extra sparkle
        const diagSize = sparkle * 0.6;
        ctx.globalAlpha = p.alpha * 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x - diagSize, p.y - diagSize);
        ctx.lineTo(p.x + diagSize, p.y + diagSize);
        ctx.moveTo(p.x + diagSize, p.y - diagSize);
        ctx.lineTo(p.x - diagSize, p.y + diagSize);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5. Relay Data Lines
  // ────────────────────────────────────────────────────────────────────────
  // Animated dots that travel between agents during message exchange,
  // with trailing afterimages and a faint connection line.

  const MESSAGE_COLORS = {
    architecture: '#f85149',
    patterns:     '#58a6ff',
    question:     '#d29922',
    answer:       '#3fb950',
    context:      '#f0883e',
    task:         '#7c6aef',
    default:      '#e6edf3',
  };

  class RelayLineManager {
    constructor() {
      /** @type {Array<Object>} */
      this.activeLines = [];
    }

    /**
     * Spawn relay dots traveling from one agent to another.
     * @param {Object} fromAgent - {renderX, renderY}
     * @param {Object} toAgent   - {renderX, renderY}
     * @param {number} SCALED_TILE
     * @param {string} [messageType='default']
     */
    send(fromAgent, toAgent, SCALED_TILE, messageType) {
      const halfTile = SCALED_TILE / 2;
      const color = MESSAGE_COLORS[messageType] || MESSAGE_COLORS.default;
      const count = 3 + Math.floor(Math.random() * 3); // 3–5 dots

      const fx = fromAgent.renderX * SCALED_TILE + halfTile;
      const fy = fromAgent.renderY * SCALED_TILE + halfTile;
      const tx = toAgent.renderX * SCALED_TILE + halfTile;
      const ty = toAgent.renderY * SCALED_TILE + halfTile;

      for (let i = 0; i < count; i++) {
        this.activeLines.push({
          fromX: fx,
          fromY: fy,
          toX: tx,
          toY: ty,
          progress: 0,             // 0 → 1
          delay: i * 120,          // stagger ms
          speed: 0.8 + Math.random() * 0.4,
          color,
          trail: [],               // last 6 positions for afterimage
        });
      }
    }

    /**
     * Advance dot progress, store trail positions, remove completed.
     * @param {number} dt - delta time ms
     */
    update(dt) {
      for (let i = this.activeLines.length - 1; i >= 0; i--) {
        const dot = this.activeLines[i];

        // Handle stagger delay
        if (dot.delay > 0) {
          dot.delay -= dt;
          continue;
        }

        dot.progress += dot.speed * (dt / 1000);
        const t = Math.min(dot.progress, 1);

        // Current position via lerp
        const cx = dot.fromX + (dot.toX - dot.fromX) * t;
        const cy = dot.fromY + (dot.toY - dot.fromY) * t;

        // Store trail (last 6 positions)
        dot.trail.push({ x: cx, y: cy });
        if (dot.trail.length > 6) dot.trail.shift();

        // Remove when complete
        if (dot.progress >= 1) {
          this.activeLines.splice(i, 1);
        }
      }
    }

    /**
     * Render relay dots, trails, and connection lines.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} SCALE
     */
    draw(ctx, SCALE) {
      if (this.activeLines.length === 0) return;

      ctx.save();

      for (const dot of this.activeLines) {
        if (dot.delay > 0) continue;
        if (dot.trail.length === 0) continue;

        const head = dot.trail[dot.trail.length - 1];

        // Faint connection line between endpoints
        ctx.globalAlpha = 0.08;
        ctx.strokeStyle = dot.color;
        ctx.lineWidth = SCALE * 0.5;
        ctx.beginPath();
        ctx.moveTo(dot.fromX, dot.fromY);
        ctx.lineTo(dot.toX, dot.toY);
        ctx.stroke();

        // Trail with decreasing alpha
        for (let j = 0; j < dot.trail.length - 1; j++) {
          const tp = dot.trail[j];
          const trailAlpha = (j + 1) / dot.trail.length * 0.35;
          ctx.globalAlpha = trailAlpha;
          ctx.fillStyle = dot.color;
          ctx.beginPath();
          ctx.arc(tp.x, tp.y, SCALE * 1.2, 0, Math.PI * 2);
          ctx.fill();
        }

        // Main dot with glow halo
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = dot.color;
        ctx.beginPath();
        ctx.arc(head.x, head.y, SCALE * 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.9;
        ctx.fillStyle = dot.color;
        ctx.beginPath();
        ctx.arc(head.x, head.y, SCALE * 1.8, 0, Math.PI * 2);
        ctx.fill();

        // Bright core
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(head.x, head.y, SCALE * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6. Environmental Storytelling (data configs)
  // ────────────────────────────────────────────────────────────────────────
  // The office environment evolves based on relay activity — more messages
  // unlock richer furnishing, and seasonal/event states alter water & trees.

  const environmentalStates = {
    /**
     * Map message count to furnishing density tier.
     * @param {number} messageCount
     * @returns {'sparse'|'basic'|'furnished'|'full'}
     */
    getFurnishingDensity(messageCount) {
      if (messageCount < 5) return 'sparse';
      if (messageCount < 15) return 'basic';
      if (messageCount < 30) return 'furnished';
      return 'full';
    },

    /** Furniture layouts by density tier. */
    densityFurniture: {
      sparse: [],
      basic: [
        { type: 'plant', x: 2, y: 3 },
        { type: 'plant', x: 17, y: 3 },
      ],
      furnished: [
        { type: 'plant', x: 2, y: 3 },
        { type: 'plant', x: 17, y: 3 },
        { type: 'watercooler', x: 10, y: 1 },
        { type: 'rug', x: 8, y: 6, w: 4, h: 3 },
      ],
      full: [
        { type: 'plant', x: 2, y: 3 },
        { type: 'plant', x: 17, y: 3 },
        { type: 'plant', x: 10, y: 11 },
        { type: 'watercooler', x: 10, y: 1 },
        { type: 'rug', x: 8, y: 6, w: 4, h: 3 },
        { type: 'bookshelf', x: 1, y: 1 },
        { type: 'bookshelf', x: 18, y: 1 },
        { type: 'toolrack', x: 5, y: 1 },
      ],
    },

    /** Water tile visual state modifiers. */
    waterStates: {
      flowing:   { animSpeed: 1.0, tint: null },
      frozen:    { animSpeed: 0,   tint: { r: 150, g: 200, b: 255, a: 0.3 } },
      turbulent: { animSpeed: 2.0, tint: { r: 100, g: 150, b: 200, a: 0.1 } },
      dried:     { animSpeed: 0,   tint: { r: 120, g: 100, b: 60,  a: 0.4 } },
    },

    /** Tree canopy color by season / event. */
    treeStates: {
      blossom: { color: '#f0a0c0' },
      canopy:  { color: '#3fb950' },
      autumn:  { color: '#f0883e' },
      bare:    { color: '#6e4a2a' },
    },
  };

  // ────────────────────────────────────────────────────────────────────────
  // 7. Damage Multiplier
  // ────────────────────────────────────────────────────────────────────────
  // More agents on the same target deal proportionally more damage per
  // agent, and the panda companion amplifies further.

  /**
   * Calculate per-agent damage multiplier when collaborating.
   * @param {number} agentCount - agents attacking the same obstacle (1–4)
   * @param {boolean} hasPanda - panda companion active
   * @returns {number} multiplier applied to each agent's damage
   */
  function calculateDamageMultiplier(agentCount, hasPanda) {
    // 1 → 1.0x, 2 → 1.2x each, 3 → 1.4x each, 4 → 1.6x each
    const baseLookup = [1.0, 1.0, 1.2, 1.4, 1.6];
    const base = baseLookup[Math.min(agentCount, 4)] || 1.0;
    return hasPanda ? base * 1.5 : base;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────

  return {
    // Formation
    getFormationPositions,
    shouldFormation,

    // Focus beams
    drawFocusBeam,
    drawAllFocusBeams,

    // Shared thought bubbles
    drawSharedThoughtBubble,
    findAdjacentPairs,

    // Celebration cascade (class — instantiate with `new`)
    CelebrationCascade,

    // Relay data lines (class — instantiate with `new`)
    RelayLineManager,

    // Environmental storytelling
    environmentalStates,

    // Damage
    calculateDamageMultiplier,
  };
})();
