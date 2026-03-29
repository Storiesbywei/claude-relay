# Fireplace Mode — Technical Design

## Overview

A **seeded ambient screensaver mode** for the pixel agents visualization. User clicks "Fireplace" → a deterministic multi-hour ambient experience unfolds, driven by seeded PRNG.

## Architecture

Two new files in `plugins/pixel-agents/`:

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `pixel-fireplace.js` | ~500 | Seeded PRNG, show scheduler, state machine, event dispatcher |
| `pixel-audio.js` | ~1,765 | Procedural lofi music via Web Audio API |

Both are IIFEs exposing `window.PixelFireplaceMode` and `window.PixelAudioEngine`.

## Seeded PRNG

**mulberry32** — deterministic, fast, 32-bit state:
```
function mulberry32(seed) -> () => float [0,1)
```

Default seed: `Math.floor(Date.now() / (3600000 * 4))` — same show per 4-hour block.
Custom seed: user input string → djb2 hash → uint32.

All random decisions during fireplace mode use `rng()` instead of `Math.random()`.

## Show Schedule

`generateSchedule(rng, durationMinutes = 120)` produces an array of "acts":

```js
{
  startMs: 0,
  durationMs: 180000,       // 2-5 minutes per act
  scene: 'winterLodge',
  weather: 'snow',
  tensionTarget: 0.1,       // never above 0.3
  dayPhase: 'evening',
  events: [
    { atMs: 30000, type: 'gatoSpawn', personality: 'lazy' },
    { atMs: 60000, type: 'taskSpawn', label: 'warming up' },
    { atMs: 90000, type: 'taskResolve' },
    { atMs: 120000, type: 'specialCreature', key: 'bunny' },
  ]
}
```

### Schedule Generation Rules

1. **Scene order**: Weighted shuffle of all 8 scenes. Winter Lodge weighted 2x (it has a fireplace).
2. **Compressed day/night**: One full cycle every 30 min. Map acts to phases.
3. **Tension sine wave**: `tensionTarget = 0.1 + 0.1 * sin(2PI * t / cycleLength)`. Never above 0.3.
4. **Ambient events**: 3-8 per act. Types: gatoSpawn, taskSpawn, taskResolve, specialCreature, weatherShift, agentStateChange.
5. **Weather patterns**: snow → clear → rain → sparkle → leaves. 1-4 min per phase.
6. **Golden hour events**: <5% probability per hour. Magical rare moments (see World Bible).

## State Machine

```
States: IDLE | RUNNING | EXITING
```

- **start(seed?)**: Generate schedule, spawn 2-3 ambient agents, save current state, begin.
- **stop()**: Fade out 800ms, restore original scene, despawn ambient agents.
- **isActive()**: Returns `state === RUNNING`.
- **update()**: Runs via `setInterval(fn, 1000)`. Reads schedule, dispatches commands at right times.

## Event Dispatch (drives existing systems)

| Event Type | API Call |
|---|---|
| sceneSwitch | `PixelAgents.switchScene(name)` |
| gatoSpawn | Ensures favorable conditions for auto-spawn |
| taskSpawn | `PixelAgents.spawnObstacle(fpId, agent, label)` |
| taskResolve | `PixelAgents.resolveObstacle(id)` |
| specialCreature | Triggers spawn via condition injection |
| tensionShift | `PixelAgents.tensionEngine.tension = target` |
| dayPhaseShift | `window.__pixelTimeOverride = { time, season }` |

## Minimal Core Engine Modification

2 lines added to `pixel-agents.js` season check block:
```js
currentTimeOfDay = (window.__pixelTimeOverride && window.__pixelTimeOverride.time) || getTimeOfDay();
currentSeason = (window.__pixelTimeOverride && window.__pixelTimeOverride.season) || getCurrentSeason();
```

## Exit Handling

- Click anywhere on canvas
- Press Escape
- Click "Exit Fireplace" button
- All call `stop()` for graceful transition back

## UI

Fireplace button in pixel sidebar actions:
```html
<button id="btn-fireplace" title="Ambient fireplace mode">🔥 Fireplace</button>
```

When active: button text → "Exit Fireplace", sidebar shows seed + elapsed time + current act.

## Script Load Order

```js
const scripts = [
  'pixel-scenes.js', 'pixel-creatures.js',
  'pixel-progression.js', 'pixel-collab.js',
  'pixel-agents.js',
  'pixel-fireplace.js', 'pixel-audio.js',  // NEW
  'pixel-integration.js'
];
```

## Build Order

### Phase 1: Fireplace Core (parallelizable with Phase 2)
1. mulberry32 PRNG + djb2Hash
2. generateSchedule()
3. State machine (start/stop/isActive/update)
4. Event dispatcher
5. 2-line hook in pixel-agents.js
6. UI toggle + exit handlers
7. Wire into app.js load order

### Phase 2: Audio Engine (parallelizable with Phase 1)
1. AudioContext + master bus + lofi chain
2. Karplus-Strong synthesis
3. FM synthesis
4. Wavetable pads
5. Markov melody generator
6. Chord progression system
7. Drum synthesis + L-system patterns
8. Scene-specific sound design (8 configs)
9. Tension/time-of-day reactivity
10. Event stingers

### Phase 3: Polish
1. Custom seed input UI
2. Sidebar indicators
3. Scene-specific ambient audio enhancements
4. Smooth tension interpolation
5. Determinism testing
