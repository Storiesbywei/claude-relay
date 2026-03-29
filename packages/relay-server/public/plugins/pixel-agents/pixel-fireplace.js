// === Pixel Fireplace — Seeded Ambient Screensaver Controller ===
// Generates a deterministic "show" from a seed, scheduling scene changes,
// narrative events, ambient agent activity, and a compressed day/night
// cycle.  Same seed = same show.  Changes every 4 hours by default.
// Exposes window.PixelFireplaceMode.

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 1. Seeded PRNG
  // ══════════════════════════════════════════════════════════════════

  /**
   * Mulberry32 — fast 32-bit seeded PRNG.
   * @param {number} seed
   * @returns {() => number} Returns values in [0, 1).
   */
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * DJB2 string hash — deterministic 32-bit hash for string seeds.
   * @param {string} str
   * @returns {number}
   */
  function djb2Hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return hash >>> 0;
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. Narrative Data
  // ══════════════════════════════════════════════════════════════════

  var SCENE_NARRATIVES = {
    workshop: [
      'Gato walks across a keyboard. A function is renamed to asdffffffjkl.',
      "A sticky note drifts to the floor: 'TODO: remember what this TODO was for.'",
      'The office plant has grown a new leaf pointing at a line with a bug.',
      'Someone left a mass of cables behind the monitor. They pulse faintly.',
      'A monitor flickers. For a moment the code is in a language nobody recognizes.',
      'The water cooler bubbles once, unprompted. Nobody is near it.',
      'A cursor blinks patiently in an empty terminal. It has been waiting all day.',
      'Two chairs have rolled together in the night. A conspiracy of ergonomics.',
    ],
    library: [
      'A book on the top shelf slides out half an inch. It wants to be read.',
      'The card catalogue opens a drawer on its own. The card inside reads: "See also: yourself."',
      'Dust motes in the lamplight spell a variable name, then scatter.',
      'Someone has bookmarked every third page of The Pragmatic Programmer with candy wrappers.',
      'A quiet hum rises from the reference section. The manuals are dreaming.',
      'The reading lamp flickers twice — morse code for "refactor."',
      'A small spider has spun a web between two O\'Reilly books. It is load-bearing.',
      'The returns cart holds a single book: "Distributed Systems, Volume 2 of 2." Volume 1 is missing.',
    ],
    garden: [
      'A sunflower turns to face the nearest monitor. It compiles by photosynthesis.',
      'The fountain water runs upward for three seconds, then pretends nothing happened.',
      'A butterfly lands on a semicolon and stays.',
      'Somewhere in the flower bed, a test is growing. It will bloom green.',
      'The garden path rearranges itself slightly. The shortest route has changed.',
      'A vine wraps around the trellis in the exact shape of a recursive function.',
      'Petals fall in the pattern of a binary search. Left. Right. Left. Found.',
      'The compost pile is warm. Someone planted a promise here. It resolved.',
    ],
    waterfront: [
      'A paper boat drifts past. Written on its hull: "v2.1.0-rc.1".',
      'The harbor bell rings. The tide carries a message in a bottle: "LGTM."',
      'A fish jumps. For a split second it is perfectly silhouetted against the deploy log.',
      'Rope coils on the dock form a perfect O(n) notation.',
      'The lighthouse sweeps the water. Each pass reveals a different staging environment.',
      'A crab sidewalks across the pier, refactoring its path with each step.',
      'Seagulls argue overhead. They sound like a code review.',
      'The anchor chain clinks in the wind — a reminder that some dependencies are heavy.',
    ],
    cave: [
      'A stalactite drips. Each drop echoes like a failing assertion.',
      'Bioluminescent moss spells "null" on the cave wall, then goes dark.',
      'The torch flickers. Shadows dance in the shape of a stack trace.',
      'Deep in the cave, a crystal hums at the frequency of a segfault.',
      'You find scratches on the wall: tally marks counting retries.',
      'A bat hangs upside down, perfectly still. It is thinking about inversion of control.',
      'The cave floor is littered with burned-out torches. Others have debugged here before.',
      'Water drips into a pool. The ripples form concentric error codes.',
    ],
    winterLodge: [
      'The fire crackles and a log shifts. The embers spell a commit hash.',
      'Hot chocolate cools on the mantle. Steam rises in the shape of a merge arrow.',
      'A knitted blanket draped over the chair has a pattern — it is a binary knit-purl cipher.',
      'Outside the frost window, snowflakes fall in an insertion sort.',
      'The cabin clock ticks slower than real time. Time is different here.',
      'A cat curls tighter by the fire. The warmth is a runtime optimization.',
      'Firewood stacked by the wall: each log labeled with a sprint number.',
      'The rocking chair moves on its own, gently. The ghost of a maintainer past.',
    ],
    harvestField: [
      'Golden wheat sways. Each stalk is a completed ticket.',
      'A scarecrow stands guard. It is dressed in a hoodie with a conference lanyard.',
      'The harvest cart is full. Someone has gathered all the acceptance criteria.',
      'A field mouse scurries through the stubble, carrying a seed of an idea.',
      'The sunset gilds the field. Every row is a shipped feature.',
      'Wind ripples the grain in waves. Each wave is a successful deployment.',
      'An apple falls from the lone tree. Newton had dependencies too.',
      'The barn door creaks open. Inside, neatly stacked: the backlog, complete.',
    ],
    cliffOverlook: [
      'The wind carries fragments of a conversation from far below. Someone is pair programming.',
      'An eagle circles above. From up here, the architecture makes sense.',
      'Clouds part for a moment. You can see the whole dependency graph, coast to coast.',
      'A cairn of balanced stones marks the trail. Each stone is a resolved PR.',
      'The horizon line is perfectly horizontal. The CSS finally works.',
      'Lichen grows on the cliff face in the pattern of a Gantt chart.',
      'A distant train sounds its horn. It is on schedule, for once.',
      'Wildflowers cling to the rock. They bloom where the coverage gaps were.',
    ],
  };

  var TRANSITION_TEXT = {
    workshop: 'The monitors are already on. They were waiting for you.',
    library: 'The library is always warm. The library is always open.',
    garden: 'Something is always growing here, even when no one is looking.',
    waterfront: 'You can hear the harbor bell from anywhere in the office, if you listen.',
    cave: 'Bring a torch. Bring patience. The bug is down here somewhere.',
    winterLodge: 'The fire has been waiting. Come sit.',
    harvestField: 'Look at what you grew.',
    cliffOverlook: 'The view from here makes everything make sense.',
  };

  var GOLDEN_HOUR_EVENTS = [
    { key: 'constellation', text: 'Sparks rise and form a constellation... the first dependency graph.', durationMs: 30000 },
    { key: 'gatoSpeaks', text: 'Gato opens one eye and whispers a variable name. It is the bug.', durationMs: 10000 },
    { key: 'ghostCommit', text: 'A commit by ghost@localhost: "You will understand this in three sprints."', durationMs: 20000 },
    { key: 'midnightBloom', text: 'Every flower in the Garden blooms at once. The fountain runs upward.', durationMs: 60000 },
    { key: 'allTheCats', text: 'Cats emerge from everywhere. They purr in unison. "Everything is going to compile."', durationMs: 300000 },
  ];

  var TASK_LABELS = [
    'warming up', 'dreaming of tests', 'remembering', 'untangling',
    'organizing thoughts', 'refactoring memories', 'compiling feelings',
    'debugging dreams', 'merging timelines', 'resolving conflicts',
    'optimizing rest', 'caching warmth', 'syncing heartbeats',
    'deploying comfort', 'building bridges', 'planting seeds',
  ];

  // ══════════════════════════════════════════════════════════════════
  // 3. Scene Weights (for schedule generation)
  // ══════════════════════════════════════════════════════════════════

  var SCENE_POOL = [
    { name: 'workshop',      weight: 1 },
    { name: 'library',       weight: 1 },
    { name: 'garden',        weight: 1 },
    { name: 'waterfront',    weight: 1 },
    { name: 'cave',          weight: 1 },
    { name: 'winterLodge',   weight: 3 },
    { name: 'harvestField',  weight: 1 },
    { name: 'cliffOverlook', weight: 2 },
  ];

  // ══════════════════════════════════════════════════════════════════
  // 4. Schedule Generator
  // ══════════════════════════════════════════════════════════════════

  /**
   * Pick a scene from the weighted pool, avoiding `lastScene`.
   * @param {() => number} rng
   * @param {string|null} lastScene
   * @returns {string}
   */
  function pickScene(rng, lastScene) {
    var candidates = [];
    for (var i = 0; i < SCENE_POOL.length; i++) {
      if (SCENE_POOL[i].name !== lastScene) {
        for (var w = 0; w < SCENE_POOL[i].weight; w++) {
          candidates.push(SCENE_POOL[i].name);
        }
      }
    }
    return candidates[Math.floor(rng() * candidates.length)];
  }

  /**
   * Map a millisecond position within a 30-minute cycle to a day phase.
   * @param {number} posMs  Position in the 30-minute cycle (0 .. 1,800,000).
   * @returns {string}
   */
  function getDayPhaseFromCyclePos(posMs) {
    var min = posMs / 60000;
    if (min < 5) return 'night';
    if (min < 8) return 'sunrise';
    if (min < 20) return 'day';
    if (min < 23) return 'sunset';
    if (min < 28) return 'evening';
    return 'night';
  }

  /**
   * Deterministic season from a numeric seed.
   * @param {number} seed
   * @returns {string}
   */
  function getSeasonFromSeed(seed) {
    var seasons = ['spring', 'summer', 'autumn', 'winter'];
    return seasons[((seed % 4) + 4) % 4]; // handle negative seeds
  }

  /**
   * Pick a random agent id from the running PixelAgents instance.
   * Falls back to 'ambient-alice'.
   * @param {() => number} rng
   * @returns {string}
   */
  function getRandomAgent(rng) {
    if (typeof PixelAgents !== 'undefined' && PixelAgents.agents && PixelAgents.agents.size > 0) {
      var keys = Array.from(PixelAgents.agents.keys());
      return keys[Math.floor(rng() * keys.length)];
    }
    return 'ambient-alice';
  }

  /**
   * Generate a complete show schedule.
   * @param {() => number} rng        Seeded PRNG.
   * @param {number}       durationMin Total duration in minutes (default 120).
   * @returns {Array<Object>}          Array of act objects.
   */
  function generateSchedule(rng, durationMin) {
    durationMin = durationMin || 120;
    var totalMs = durationMin * 60000;
    var acts = [];
    var elapsedMs = 0;
    var lastScene = null;

    while (elapsedMs < totalMs) {
      // Act duration: 2-5 minutes
      var actDurationMs = Math.floor((2 + rng() * 3) * 60000);
      if (elapsedMs + actDurationMs > totalMs) {
        actDurationMs = totalMs - elapsedMs;
      }
      if (actDurationMs < 30000) break; // skip if < 30s remaining

      var scene = pickScene(rng, lastScene);
      lastScene = scene;

      // Day phase from compressed cycle
      var cyclePosMs = elapsedMs % (30 * 60000);
      var dayPhase = getDayPhaseFromCyclePos(cyclePosMs);

      // Tension target: gentle sine, never above 0.2
      var tensionTarget = 0.05 + 0.15 * Math.sin(2 * Math.PI * elapsedMs / (30 * 60000));

      // Generate events for this act
      var events = generateActEvents(rng, actDurationMs, scene);

      // Golden hour: 1.5% chance per act
      if (rng() < 0.015) {
        var goldenEvent = GOLDEN_HOUR_EVENTS[Math.floor(rng() * GOLDEN_HOUR_EVENTS.length)];
        events.push({
          atMs: Math.floor(rng() * (actDurationMs - goldenEvent.durationMs)),
          type: 'goldenHour',
          key: goldenEvent.key,
          text: goldenEvent.text,
          durationMs: goldenEvent.durationMs,
          fired: false,
        });
      }

      // Sort events by time
      events.sort(function (a, b) { return a.atMs - b.atMs; });

      acts.push({
        startMs: elapsedMs,
        durationMs: actDurationMs,
        scene: scene,
        weather: pickWeather(rng, scene, dayPhase),
        tensionTarget: tensionTarget,
        dayPhase: dayPhase,
        events: events,
      });

      elapsedMs += actDurationMs;
    }

    return acts;
  }

  /**
   * Pick a weather / particle type appropriate for the scene and time.
   * @param {() => number} rng
   * @param {string}       scene
   * @param {string}       dayPhase
   * @returns {string}
   */
  function pickWeather(rng, scene, dayPhase) {
    if (scene === 'winterLodge') return 'snow';
    if (scene === 'cave') return 'none';
    if (scene === 'waterfront') return rng() < 0.3 ? 'rain' : 'clear';
    if (scene === 'garden') return rng() < 0.2 ? 'petals' : 'clear';
    if (scene === 'harvestField') return rng() < 0.4 ? 'leaves' : 'clear';
    if (scene === 'cliffOverlook') return rng() < 0.5 ? 'wind' : 'clear';
    if (dayPhase === 'night' || dayPhase === 'evening') return rng() < 0.3 ? 'stars' : 'clear';
    return 'clear';
  }

  /**
   * Generate 3-8 events spread across an act.
   * @param {() => number} rng
   * @param {number}       actDurationMs
   * @param {string}       scene
   * @returns {Array<Object>}
   */
  function generateActEvents(rng, actDurationMs, scene) {
    var count = 3 + Math.floor(rng() * 6); // 3-8
    var events = [];
    var hasOpenTask = false;

    for (var i = 0; i < count; i++) {
      var atMs = Math.floor((rng() * 0.9 + 0.05) * actDurationMs); // 5%-95% of act
      var roll = rng();

      if (roll < 0.30) {
        // gatoSpawn (30%)
        var personalities = ['lazy', 'curious', 'skittish', 'bold'];
        events.push({
          atMs: atMs,
          type: 'gatoSpawn',
          personality: personalities[Math.floor(rng() * personalities.length)],
          fired: false,
        });
      } else if (roll < 0.50) {
        // taskSpawn (20%)
        var label = TASK_LABELS[Math.floor(rng() * TASK_LABELS.length)];
        events.push({
          atMs: atMs,
          type: 'taskSpawn',
          label: label,
          fired: false,
        });
        hasOpenTask = true;
      } else if (roll < 0.65 && hasOpenTask) {
        // taskResolve (15%, only if task spawned)
        events.push({
          atMs: atMs,
          type: 'taskResolve',
          fired: false,
        });
        hasOpenTask = false;
      } else if (roll < 0.75) {
        // specialCreature (10%)
        var creatures = ['bunny', 'bunny', 'bunny', 'pinkPanda', 'blueCat'];
        events.push({
          atMs: atMs,
          type: 'specialCreature',
          key: creatures[Math.floor(rng() * creatures.length)],
          fired: false,
        });
      } else if (roll < 0.90) {
        // agentStateChange (15%)
        events.push({
          atMs: atMs,
          type: 'agentStateChange',
          fired: false,
        });
      } else {
        // narrative (10%)
        var pool = SCENE_NARRATIVES[scene] || SCENE_NARRATIVES.workshop;
        events.push({
          atMs: atMs,
          type: 'narrative',
          text: pool[Math.floor(rng() * pool.length)],
          durationMs: 6000 + Math.floor(rng() * 4000), // 6-10s
          fired: false,
        });
      }
    }

    return events;
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. State Machine
  // ══════════════════════════════════════════════════════════════════

  var STATE_IDLE = 'IDLE';
  var STATE_RUNNING = 'RUNNING';
  var STATE_EXITING = 'EXITING';

  var state = STATE_IDLE;
  var rng = null;
  var seed = 0;
  var schedule = [];
  var startTime = 0;
  var updateInterval = null;
  var lastAct = null;
  var fpTaskCounter = 0;
  var fpTasks = [];
  var ambientAgentIds = [];
  var savedScene = null;

  var AMBIENT_NAMES = ['Alice', 'Bob', 'Claude'];

  /**
   * Start the fireplace screensaver.
   * @param {number|string} [userSeed] Optional seed. String seeds are hashed.
   */
  function start(userSeed) {
    if (state === STATE_RUNNING) return;

    // Resolve seed
    if (userSeed !== undefined && userSeed !== null) {
      if (typeof userSeed === 'string') {
        seed = djb2Hash(userSeed);
      } else {
        seed = Math.floor(userSeed);
      }
    } else {
      seed = Math.floor(Date.now() / (3600000 * 4));
    }

    rng = mulberry32(seed);

    // Generate the show
    schedule = generateSchedule(rng, 120);

    // Save current scene so we can restore on stop
    if (typeof PixelAgents !== 'undefined' && typeof PixelAgents.currentScene === 'function') {
      savedScene = PixelAgents.currentScene();
    }

    // Spawn ambient agents if none exist
    ambientAgentIds = [];
    if (typeof PixelAgents !== 'undefined') {
      var hasAgents = PixelAgents.agents && PixelAgents.agents.size > 0;
      if (!hasAgents) {
        for (var i = 0; i < AMBIENT_NAMES.length; i++) {
          var agentId = 'ambient-' + AMBIENT_NAMES[i].toLowerCase();
          PixelAgents.spawnAgent(agentId, AMBIENT_NAMES[i]);
          ambientAgentIds.push(agentId);
        }
      }
    }

    state = STATE_RUNNING;
    startTime = Date.now();
    lastAct = null;
    fpTaskCounter = 0;
    fpTasks = [];

    // Start the 1-second update loop
    updateInterval = setInterval(update, 1000);

    // Fire first update immediately
    update();

    // Dispatch started event
    document.dispatchEvent(new CustomEvent('fireplace:started', { detail: { seed: seed } }));
  }

  /**
   * Stop the fireplace screensaver.
   */
  function stop() {
    if (state === STATE_IDLE) return;

    state = STATE_EXITING;

    // Clear interval
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }

    // Clear time override
    if (typeof window !== 'undefined') {
      window.__pixelTimeOverride = undefined;
    }

    // Resolve any remaining fireplace tasks
    while (fpTasks.length > 0) {
      var taskId = fpTasks.shift();
      if (typeof PixelAgents !== 'undefined' && PixelAgents.resolveObstacle) {
        PixelAgents.resolveObstacle(taskId);
      }
    }

    // Despawn ambient agents we spawned
    if (typeof PixelAgents !== 'undefined') {
      for (var i = 0; i < ambientAgentIds.length; i++) {
        PixelAgents.despawnAgent(ambientAgentIds[i]);
      }
    }
    ambientAgentIds = [];

    // Transition back to saved scene (or workshop)
    var restoreScene = savedScene || 'workshop';
    if (typeof PixelAgents !== 'undefined' && PixelAgents.switchScene) {
      PixelAgents.switchScene(restoreScene);
    }

    // After transition completes, go to IDLE
    setTimeout(function () {
      state = STATE_IDLE;
      schedule = [];
      lastAct = null;
      document.dispatchEvent(new CustomEvent('fireplace:stopped'));
    }, 800);
  }

  /**
   * @returns {boolean} True if the fireplace is actively running.
   */
  function isActive() {
    return state === STATE_RUNNING;
  }

  /**
   * @returns {number} The current seed.
   */
  function getSeed() {
    return seed;
  }

  /**
   * @returns {number} Elapsed milliseconds since the show started.
   */
  function getElapsed() {
    if (state !== STATE_RUNNING) return 0;
    return Date.now() - startTime;
  }

  /**
   * @returns {Object|null} The currently active act, or null.
   */
  function getCurrentAct() {
    if (state !== STATE_RUNNING) return null;
    return findCurrentAct(Date.now() - startTime);
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. Update Loop
  // ══════════════════════════════════════════════════════════════════

  /**
   * Find the act that covers the given elapsed time.
   * @param {number} elapsed
   * @returns {Object|null}
   */
  function findCurrentAct(elapsed) {
    for (var i = schedule.length - 1; i >= 0; i--) {
      var act = schedule[i];
      if (elapsed >= act.startMs && elapsed < act.startMs + act.durationMs) {
        return act;
      }
    }
    // Past the end of schedule
    return null;
  }

  /**
   * Core update tick — called every 1000ms.
   */
  function update() {
    if (state !== STATE_RUNNING) return;

    var elapsed = Date.now() - startTime;

    // Find current act (handles backgrounded tabs with big time jumps)
    var act = findCurrentAct(elapsed);
    if (!act) {
      // Schedule ended — loop by resetting start time
      if (schedule.length > 0) {
        var totalDuration = 0;
        for (var s = 0; s < schedule.length; s++) {
          totalDuration += schedule[s].durationMs;
        }
        startTime = Date.now() - (elapsed % totalDuration);
        // Reset all event fired flags for the loop
        for (var r = 0; r < schedule.length; r++) {
          for (var e = 0; e < schedule[r].events.length; e++) {
            schedule[r].events[e].fired = false;
          }
        }
        lastAct = null;
        elapsed = Date.now() - startTime;
        act = findCurrentAct(elapsed);
      }
      if (!act) { stop(); return; }
    }

    // Act transition
    if (act !== lastAct) {
      onActChange(act);
      // When backgrounded, we may have skipped acts — mark skipped events as fired
      if (lastAct) {
        markSkippedEvents(elapsed);
      }
      lastAct = act;
    }

    // Process events in current act
    var actElapsed = elapsed - act.startMs;
    for (var i = 0; i < act.events.length; i++) {
      var event = act.events[i];
      if (!event.fired && actElapsed >= event.atMs) {
        fireEvent(event);
        event.fired = true;
      }
    }

    // Update compressed day/night time override
    var cyclePosMs = elapsed % (30 * 60000);
    window.__pixelTimeOverride = {
      time: getDayPhaseFromCyclePos(cyclePosMs),
      season: getSeasonFromSeed(seed),
    };

    // Lerp tension toward the act's target
    if (typeof PixelAgents !== 'undefined' && typeof PixelAgents.tensionEngine === 'function') {
      var te = PixelAgents.tensionEngine();
      if (te && typeof te.tension === 'number') {
        te.tension += (act.tensionTarget - te.tension) * 0.05;
      }
    }
  }

  /**
   * Mark all events in acts before the current elapsed time as fired,
   * so we do not replay old events after a tab-backgrounding jump.
   * @param {number} elapsed
   */
  function markSkippedEvents(elapsed) {
    for (var i = 0; i < schedule.length; i++) {
      var act = schedule[i];
      if (act.startMs + act.durationMs <= elapsed) {
        // Entire act is in the past
        for (var j = 0; j < act.events.length; j++) {
          act.events[j].fired = true;
        }
      } else if (act.startMs <= elapsed) {
        // Current act — mark events before current position
        var actElapsed = elapsed - act.startMs;
        for (var k = 0; k < act.events.length; k++) {
          if (act.events[k].atMs < actElapsed - 2000) {
            act.events[k].fired = true;
          }
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. Event Dispatcher
  // ══════════════════════════════════════════════════════════════════

  /**
   * Fire a scheduled event, dispatching to PixelAgents and custom events.
   * @param {Object} event
   */
  function fireEvent(event) {
    switch (event.type) {
      case 'gatoSpawn':
        // We do not force-spawn gatos — we just let natural spawning happen.
        // The low tension during fireplace mode already increases gato odds.
        break;

      case 'taskSpawn':
        if (typeof PixelAgents !== 'undefined' && PixelAgents.spawnObstacle) {
          var taskId = 'fp-' + (++fpTaskCounter);
          fpTasks.push(taskId);
          PixelAgents.spawnObstacle(taskId, getRandomAgent(rng), event.label || 'dreaming');
        }
        break;

      case 'taskResolve':
        if (fpTasks.length > 0) {
          var resolveId = fpTasks.shift();
          if (typeof PixelAgents !== 'undefined' && PixelAgents.resolveObstacle) {
            PixelAgents.resolveObstacle(resolveId);
          }
        }
        break;

      case 'specialCreature':
        document.dispatchEvent(new CustomEvent('fireplace:spawnCreature', {
          detail: { key: event.key },
        }));
        break;

      case 'agentStateChange':
        if (typeof PixelAgents !== 'undefined' && PixelAgents.agents && PixelAgents.agents.size > 0 && rng) {
          var agentKeys = Array.from(PixelAgents.agents.keys());
          var agentId = agentKeys[Math.floor(rng() * agentKeys.length)];
          var states = ['typing', 'reading', 'thinking', 'idle'];
          var newState = states[Math.floor(rng() * states.length)];
          if (PixelAgents.setAgentState) {
            PixelAgents.setAgentState(agentId, newState, 8000);
          }
        }
        break;

      case 'narrative':
        document.dispatchEvent(new CustomEvent('fireplace:narrative', {
          detail: {
            text: event.text,
            durationMs: event.durationMs || 8000,
            isTransition: false,
          },
        }));
        break;

      case 'goldenHour':
        document.dispatchEvent(new CustomEvent('fireplace:goldenHour', {
          detail: {
            key: event.key,
            text: event.text,
            durationMs: event.durationMs,
          },
        }));
        // Also dispatch as a narrative so it shows in the overlay
        document.dispatchEvent(new CustomEvent('fireplace:narrative', {
          detail: {
            text: event.text,
            durationMs: Math.min(event.durationMs, 15000),
            isTransition: false,
          },
        }));
        break;
    }

    // Notify audio engine if present
    if (typeof PixelAudioEngine !== 'undefined' && PixelAudioEngine.onEvent) {
      try {
        PixelAudioEngine.onEvent(event.type, event);
      } catch (_) { /* skip */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 8. Act Change Handler
  // ══════════════════════════════════════════════════════════════════

  /**
   * Called when the show transitions to a new act (new scene).
   * @param {Object} act
   */
  function onActChange(act) {
    // Switch scene
    if (typeof PixelAgents !== 'undefined' && PixelAgents.switchScene) {
      PixelAgents.switchScene(act.scene);
    }

    // Notify audio engine
    if (typeof PixelAudioEngine !== 'undefined' && PixelAudioEngine.setScene) {
      try {
        PixelAudioEngine.setScene(act.scene);
      } catch (_) { /* skip */ }
    }

    // Dispatch transition narrative
    var text = TRANSITION_TEXT[act.scene];
    if (text) {
      document.dispatchEvent(new CustomEvent('fireplace:narrative', {
        detail: {
          text: text,
          durationMs: 5000,
          isTransition: true,
        },
      }));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 9. Public API
  // ══════════════════════════════════════════════════════════════════

  /**
   * @namespace PixelFireplaceMode
   * @description Seeded ambient screensaver for the pixel agents visualization.
   *   Same seed produces the same show — scene order, events, narratives.
   *   Default seed rotates every 4 hours.
   *
   * @property {function(number|string=): void} start   Start the screensaver. Optional seed.
   * @property {function(): void}               stop    Stop and restore previous scene.
   * @property {function(): boolean}             isActive  True while running.
   * @property {function(): number}              getSeed   Current seed value.
   * @property {function(): number}              getElapsed  Ms since start.
   * @property {function(): Object|null}         getCurrentAct  The active act object.
   * @property {function(): Array}               getSchedule  Full act schedule.
   * @property {Object}  SCENE_NARRATIVES   Per-scene narrative text arrays.
   * @property {Object}  TRANSITION_TEXT     Per-scene transition flavor text.
   * @property {Array}   GOLDEN_HOUR_EVENTS Rare special events.
   */
  window.PixelFireplaceMode = {
    start: start,
    stop: stop,
    isActive: isActive,
    getSeed: getSeed,
    getElapsed: getElapsed,
    getCurrentAct: getCurrentAct,
    getSchedule: function () { return schedule; },
    SCENE_NARRATIVES: SCENE_NARRATIVES,
    TRANSITION_TEXT: TRANSITION_TEXT,
    GOLDEN_HOUR_EVENTS: GOLDEN_HOUR_EVENTS,
  };

})();
