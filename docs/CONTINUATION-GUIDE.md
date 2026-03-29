# Pixel Agents — Continuation Guide for Next Claude Session

## What This Is

An idle pixel art visualization for the Claude Relay dashboard. AI agents work at desks, fight knight-shaped tasks, and pet cats. It has grown into a full ambient screensaver system with procedural lofi music.

**Total: 8,990 lines of JS across 8 modules, 163 sprite assets, 8 scenes, 3 design docs.**

## Current State (Mar 29, 2026)

### Branch: `feature/fireplace-mode` (pushed to GitHub)

```
b9ffceb Fix 4 medium security issues from review
8773bfb Add fireplace mode — seeded ambient screensaver with procedural lofi audio
5c52abe Fix gato personality tension — read from engine instead of hardcoded 0.3
482640f Integrate all 4 config modules into pixel-agents.js game engine
226359f Restructure pixel agents as optional plugin with lazy loading
a8c2adf Add pixel agents module system — scenes, creatures, progression, collaboration
5019a2c Add pixel agents game design doc — 8 scenes, creature taxonomy, casino mechanics
2801bb1 Add pixel agents visualization — cozy idle office with Pixel Plains sprites
```

Parent branch: `feature/pixel-agents` (same commits minus the top 2).
Base: `master` (the Claude Relay server).

### What Has Been Built (DONE)

Everything below is **built and committed**. Do not rebuild these.

#### Core Engine — `pixel-agents.js` (2,163 lines)
- Canvas 2D renderer at 10 FPS, `imageRendering: pixelated`
- 20x14 tilemap (16x16 tiles scaled 3x = 48px), extended tile types (WATER, BOOKSHELF, CAVE_FLOOR, SNOW, GRASS, CLIFF)
- BFS pathfinding with walkable mask
- Agent state machine: idle → walking → typing → reading → thinking
- Obstacle (knight) system with health bars, passive damage from agent work
- Gato system: wander, nap, flee from knights
- Day/night cycle with TIME_TINTS (sunrise/day/sunset/evening/night) + star rendering
- Seasonal particle system: leaves, rain, sparkle, snow (MAX_PARTICLES = 50)
- Scene switching with fade-to-black transitions
- Focus beams, celebration cascade, relay data lines (via Collab module)
- Tension engine integration driving lighting, weather, knight spawn rate
- Casino mechanics: near-miss at 20% HP, health bar pulse, knight flee, celebration cascade
- **Time override hook**: reads `window.__pixelTimeOverride` for fireplace mode control of season/time

#### 4 Config Modules (all integrated into core)
| File | Lines | What |
|------|-------|------|
| pixel-scenes.js | 982 | 8 scene configs with 20x14 tilemaps, furniture, interest points, draw hooks |
| pixel-creatures.js | 790 | 4 knight variants, 5 special creatures, 5 gato personalities, keyword classifier |
| pixel-progression.js | 830 | TensionEngine class, sunflower/fountain/pumpkin/bookshelf draw funcs, casino mechanics |
| pixel-collab.js | 668 | Formation system, focus beams, CelebrationCascade, RelayLineManager, damage multiplier |

#### Fireplace Mode — `pixel-fireplace.js` (818 lines)
- mulberry32 seeded PRNG + djb2 string hash
- `generateSchedule(rng, 120)` → array of 24-40 acts, each 2-5 minutes
- Weighted scene rotation (winterLodge 3x, cliffOverlook 2x), no repeats
- Compressed day/night cycle (30 min per full cycle)
- Gentle tension sine wave (0.05 to 0.2, never above normal)
- 7 event types per act: gatoSpawn, taskSpawn, taskResolve, specialCreature, agentStateChange, narrative, goldenHour
- Full narrative database: 64 scene-specific narratives (8 per scene), 8 transition texts, 5 golden hour events
- State machine: IDLE → RUNNING → EXITING
- Spawns 3 ambient agents (Alice, Bob, Claude) on start
- 1-second update loop via setInterval, tab-backgrounding resilient
- `window.__pixelTimeOverride` drives compressed time in the core engine
- Exit via Escape, canvas click, or button

#### Audio Engine — `pixel-audio.js` (1,988 lines)
- Pure Web Audio API synthesis, zero audio files
- **Instruments**: Karplus-Strong (plucked strings, 6-voice pool), FM synthesis (4-voice pool), wavetable pads (2 crossfade voices), procedural drums (kick/snare/hat)
- **Lofi chain**: WaveShaperNode bitcrusher → tape wow (DelayNode + 0.3Hz LFO) → lowpass 9kHz → ConvolverNode reverb (synthetic 1.5s IR) → dry/wet mix
- **Composition**: Markov melody on pentatonic/modal scales, curated chord progression pools, L-system rhythm patterns, swing timing
- **8 scene configs**: distinct root key, scale, tempo, instrument palette, ambient texture per scene
- **Tension reactivity**: 5 levels affecting tempo, rest probability, filter cutoff, reverb wet, drum patterns
- **Event stingers**: task resolve chime, gato purr, golden hour pad swell
- Vinyl hiss ambient layer, scene-specific textures (fire crackle, water, wind, drips)
- Scheduler uses Web Audio timing (ctx.currentTime), not setTimeout
- AudioContext properly closed on stop (not just suspended)
- KS buffer cache capped at 100 entries

#### Integration — `pixel-integration.js` (632 lines)
- Bridge between relay DOM events and pixel visualization
- Fireplace button wiring + narrative text overlay (Georgia serif, fade in/out)
- `?mode=pixel` and `?mode=fireplace` URL parameter support
- Sidebar: agents, tasks, cats, fireplace status sections
- Test buttons: +Agent (capped at 6), +Task, Resolve
- DOM API for sidebar rendering (no innerHTML — security fix)

#### Plugin Architecture
- All files in `plugins/pixel-agents/` subdirectory
- Lazy-loaded from `app.js` on "Office" button click
- Script load order: scenes → creatures → progression → collab → agents → fireplace → audio → integration
- Custom DOM events for decoupling: `relay:participants`, `relay:message`, `relay:status`, `fireplace:started`, `fireplace:stopped`, `fireplace:narrative`, `fireplace:goldenHour`
- Zero coupling — delete the folder, zero residue. Docker image excludes it via .dockerignore.

### Design Docs (read these for context)

| Doc | Location | What |
|-----|----------|------|
| Game Design Doc | `docs/pixel-agents-design-doc.md` | Original 93-line spec: 8 scenes, creature taxonomy, casino mechanics |
| World Bible | `docs/pixel-agents-world-bible.md` | Lore for all 8 scenes, ambient narratives, golden hour events, Gato appendix |
| Fireplace Design | `docs/fireplace-mode-design.md` | Technical architecture for fireplace mode + build phases |
| Audio Design | `docs/pixel-audio-design.md` | Full synthesis/composition spec: instruments, scales, Markov chains, scene configs |

### Sprite Assets

163 PNG files in `plugins/pixel-agents/assets/sprites/`:
- `characters/`: 24x24 on 216x120 sheets (9 cols × 5 rows), 6 frames per animation
- `tilesets/`: 16x16 tiles for spring, trees, ice, winter
- `props/`: furniture, plants, signs
- `fx/`: effects sprites
- All from Pixel Plains by SnowHex (MIT-like license, $6)

**Asset utilization: ~23%** — Only 38 of 163 files are currently referenced in code. Many character variants, prop sheets, and FX sprites are available but unused. The design doc targets 94%.

---

## What Has NOT Been Done (TODO)

### Priority 1: Visual Testing
**Nobody has opened a browser and looked at it yet.** The entire visualization was built code-first.

```bash
cd /Users/weixiangzhang/Local_Dev/projects/claude-relay
bun run dev:server
# Open http://localhost:4190?mode=pixel
# Click "+ Agent" a few times, "+ Task", "Resolve"
# Click "🔥 Fireplace" to test fireplace mode
# Open http://localhost:4190?mode=fireplace for auto-start
```

Things to look for:
- Do agents render and walk to desks?
- Do knights spawn and take damage?
- Does the fireplace mode start and cycle through scenes?
- Does the narrative text overlay appear and fade?
- Does audio play? (requires user click to start AudioContext)
- Do scene transitions fade smoothly?
- Are tiles rendering correctly for all 8 scenes?
- Do gatos appear and wander?

### Priority 2: Browser Testing & Bug Fixes
The audio engine is 1,988 lines of Web Audio API code that has never run in a browser. Expect:
- Timing issues (scheduler may need tuning)
- FM synthesis parameter values may sound bad (mod index too high/low)
- Karplus-Strong buffers may clip or be too quiet
- Lofi chain may be too aggressive or too subtle
- Scene transitions may have audio gaps or pops
- Markov melody may produce awkward intervals

### Priority 3: Merge Strategy
Two feature branches exist:
- `feature/pixel-agents` — base pixel visualization (6 commits)
- `feature/fireplace-mode` — adds fireplace + audio (2 more commits on top)

Options:
1. Merge `feature/fireplace-mode` directly to `master` (includes everything)
2. Merge `feature/pixel-agents` first, then `feature/fireplace-mode` on top
3. Squash-merge to keep master history clean

### Priority 4: Known Issues from QA (not fixed, low priority)
- Bunny creature uses `stayDurationMs` instead of `despawnCondition`
- `checkSpecialSpawns(null)` crashes (missing null guard)
- pinkPanda proximity detection hardcoded at 3 tiles
- CelebrationCascade `speed` property doesn't affect actual movement rate
- 1 unreachable interest point on water tile in cliffOverlook scene
- `refreshInterval` and `specialSpawnInterval` in integration.js never stop (run for page lifetime)

### Priority 5: Future Features
- **Custom seed input UI**: long-press or right-click the Fireplace button to enter a custom seed
- **Fireplace sidebar**: show current act details, time remaining, next scene preview
- **More sprite utilization**: use the other 125 unused sprite files for variety
- **Ambient sound enhancements**: scene-specific one-shot audio events (bird calls for garden, drips for cave)
- **Phase variation**: L-system rhythm evolution, Markov matrix drift over time so music evolves
- **Performance profiling**: check Canvas + Web Audio CPU usage on low-power devices

---

## File Map

```
packages/relay-server/public/
├── app.js                          (970 lines — dashboard app + plugin loader)
├── index.html                      (176 lines — dashboard HTML)
├── style.css                       (dashboard styles)
└── plugins/pixel-agents/
    ├── pixel-agents.js             (2,163 — core engine, game loop, rendering)
    ├── pixel-audio.js              (1,988 — procedural lofi music)
    ├── pixel-scenes.js             (982 — 8 scene tilemaps + configs)
    ├── pixel-progression.js        (830 — tension engine, casino, draw funcs)
    ├── pixel-fireplace.js          (818 — seeded screensaver controller)
    ├── pixel-creatures.js          (790 — knights, specials, gatos)
    ├── pixel-collab.js             (668 — beams, cascade, relay lines)
    ├── pixel-integration.js        (632 — bridge + UI wiring)
    ├── pixel-agents.css            (101 — extracted styles)
    ├── pixel-agents.html           (18 — HTML fragment)
    └── assets/sprites/             (163 PNG files)
        └── characters/             (agent + creature sprite sheets)

docs/
├── pixel-agents-design-doc.md      (93 — original game design spec)
├── pixel-agents-world-bible.md     (world lore + narratives)
├── pixel-audio-design.md           (synthesis + composition spec)
├── fireplace-mode-design.md        (technical architecture)
└── technical-architecture.md       (relay server architecture)
```

## Module Dependency Graph

```
pixel-scenes.js          ─┐
pixel-creatures.js        ─┤
pixel-progression.js      ─┼─→ pixel-agents.js ─→ pixel-fireplace.js ─┐
pixel-collab.js           ─┘         ↑             pixel-audio.js    ─┤
                                     │                                 ↓
                              pixel-integration.js ←───────────────────┘
                                     ↑
                                  app.js (plugin loader)
```

All cross-module references use `typeof !== 'undefined'` guards. Every module works independently — remove any file and the rest degrades gracefully.

## Public APIs

### PixelAgents (pixel-agents.js)
```js
init(container), show(), hide()
spawnAgent(id, name), despawnAgent(id), setAgentState(id, state, durationMs)
spawnObstacle(id, agentId, label), resolveObstacle(id), damageObstacle(id, amount)
switchScene(name), currentScene
sendRelayLine(from, to)
tensionEngine, celebrationCascade, relayLineManager
agents (Map), obstacles (Map), gatos (Map), furniture (Array)
SCALED_TILE (48), LABEL_COLORS
```

### PixelFireplaceMode (pixel-fireplace.js)
```js
start(seed?), stop(), isActive()
getSeed(), getElapsed(), getCurrentAct(), getSchedule()
SCENE_NARRATIVES, TRANSITION_TEXT, GOLDEN_HOUR_EVENTS
```

### PixelAudioEngine (pixel-audio.js)
```js
start(seed), stop(), isPlaying()
setVolume(0-1), setScene(name), setTension(0-4), setTimeOfDay(phase)
onEvent(name, data), mute(), unmute(), getState()
```

### PixelIntegration (pixel-integration.js)
```js
toggle(), refresh(), ensureInit()
ready (bool), initialized (bool), activeTaskCount (number)
```

## How to Run

```bash
cd /Users/weixiangzhang/Local_Dev/projects/claude-relay
git checkout feature/fireplace-mode
bun install
bun run dev:server
# Dashboard: http://localhost:4190
# Pixel view: http://localhost:4190?mode=pixel
# Fireplace: http://localhost:4190?mode=fireplace
```

## Security Review Status

Reviewed and fixed (commit b9ffceb). 0 critical, 0 high, 0 medium remaining. Low-severity items documented in the commit history.
