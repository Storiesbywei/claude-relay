// === Pixel Audio Engine — Procedural Lofi Music for Claude Relay ===
// Generates infinite lofi music using Web Audio API synthesis.
// Zero audio files. All instruments are synthesized in real time.
// Integrates with PixelSceneConfig for scene-reactive music.
//
// Public API: window.PixelAudioEngine
//   .start(seed)     — init AudioContext and begin playback
//   .stop()          — fade out and suspend
//   .isPlaying()     — transport state
//   .setVolume(v)    — master volume 0..1
//   .setScene(name)  — crossfade to scene music config
//   .setTension(lvl) — reactivity level 0..4
//   .setTimeOfDay(p) — adjust brightness / register ('dawn'|'day'|'dusk'|'night')
//   .onEvent(name,d) — trigger stingers (taskResolve, gatoSpawn, goldenHour, etc.)
//   .setMelodyLevel(v)  — melody submix 0..1 (user mixer control)
//   .setHarmonyLevel(v) — harmony submix 0..1 (user mixer control)
//   .setBassLevel(v)    — bass submix 0..1 (user mixer control)
//   .getMixerLevels()   — returns { melody, harmony, bass, ambient, hiss }
//   .setAmbientLevel(v) — ambient volume 0..1 (default 0.7), independent of master
//   .mute() / .unmute()
//   .setHissLevel(v) — user hiss level 0..1 (0.5 = legacy default)
//   .getHissLevel()  — current user hiss level
//   .getState()      — snapshot of current engine state
//   .setPreset(name)  — mood preset ('warmLofi'|'rainFocus'|'deepNight'|'gardenMorning')
//   .getPreset()      — current preset name or null
//   .setRoomSize(sz)  — reverb room size ('small'|'medium'|'large')
//   .getRoomSize()    — current room size
//   .diagnose(sec,cb) — run audio diagnostics for sec seconds, return report
//   .compareSeed(a,b) — compare two PRNG seeds (proves different sequences)

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  // §0  GRACEFUL DEGRADATION
  // ════════════════════════════════════════════════════════════════════

  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    // No Web Audio support — expose silent no-op API
    window.PixelAudioEngine = {
      start: function () {},
      stop: function () {},
      isPlaying: function () { return false; },
      setVolume: function () {},
      setScene: function () {},
      setTension: function () {},
      setTimeOfDay: function () {},
      onEvent: function () {},
      mute: function () {},
      unmute: function () {},
      setAmbientLevel: function () {},
      getAmbientLevel: function () { return 0.7; },
      setHissLevel: function () {},
      getHissLevel: function () { return 0.5; },
      setMelodyLevel: function () {},
      setHarmonyLevel: function () {},
      setBassLevel: function () {},
      getMixerLevels: function () { return { melody: 1, harmony: 1, bass: 1, ambient: 0.7, hiss: 0.5 }; },
      getState: function () { return { playing: false, hissLevel: 0.5, ambientLevel: 0.7, preset: null, roomSize: 'medium', mixerLevels: { melody: 1, harmony: 1, bass: 1, ambient: 0.7, hiss: 0.5 } }; },
      _createAnalyser: function () { return null; },
      _destroyAnalyser: function () {},
      _getSampleRate: function () { return 0; },
      setPreset: function () {},
      getPreset: function () { return null; },
      setRoomSize: function () {},
      getRoomSize: function () { return 'medium'; },
      diagnose: function () { return Promise.resolve({ error: 'No Web Audio support' }); },
      compareSeed: function () { return { error: 'No Web Audio support' }; },
    };
    return;
  }

  // ════════════════════════════════════════════════════════════════════
  // §0b  DEBUG LOGGING
  // ════════════════════════════════════════════════════════════════════

  var DEBUG_AUDIO = true;

  // ════════════════════════════════════════════════════════════════════
  // §1  SEEDED PRNG — mulberry32
  // ════════════════════════════════════════════════════════════════════

  var _rngState = 0;
  var _currentSeed = 0; // track what seed we were initialized with

  function mulberry32(seed) {
    _rngState = seed | 0;
  }

  /** Returns a float in [0, 1). All musical randomness flows through this. */
  function rng() {
    _rngState |= 0;
    _rngState = (_rngState + 0x6d2b79f5) | 0;
    var t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Seeded integer in [min, max] inclusive. */
  function rngInt(min, max) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  /** Pick a random element from an array. */
  function rngPick(arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  // ════════════════════════════════════════════════════════════════════
  // §2  STATE
  // ════════════════════════════════════════════════════════════════════

  var ctx = null;
  var masterGain = null;
  var volume = 0.5;

  // Submix buses
  var melodySub = null;
  var harmSub = null;
  var bassSub = null;
  var ambientSub = null;

  // Lofi chain nodes
  var lofiInput = null;   // GainNode — all submixes route here
  var bitcrusher = null;  // WaveShaperNode
  var tapeWowDelay = null;
  var tapeWowLFO = null;
  var tapeWowDepth = null;
  var lowpassRolloff = null;
  var reverbConvolver = null;
  var dryGain = null;
  var wetGain = null;
  var safetyLimiter = null; // DynamicsCompressorNode between lofiMerge and master
  var lofiMerge = null;   // GainNode merging dry + wet before master
  var diagnosticAnalyser = null; // AnalyserNode tapped between lofiMerge and safetyLimiter

  // Instruments
  var ksVoicePool = [];   // Karplus-Strong buffer source pool
  var ksVoiceIndex = 0;
  var fmVoices = [];      // FM synthesis persistent voices
  var padVoices = [];     // Wavetable pad crossfade voices
  var padActiveIndex = 0;

  // Vinyl hiss
  var vinylSource = null;
  var vinylGain = null;
  var vinylFilter = null;
  var vinylLFO = null;
  var vinylLFOGain = null;

  // Ambient texture
  var ambientTextureSource = null;
  var ambientTextureGain = null;
  var ambientTextureFilter = null;
  var ambientDCBlocker = null;
  var ambientCrackleTimer = null;
  var currentAmbientScene = null;
  var ambientNodes = [];          // All scene-specific Web Audio nodes for cleanup
  var ambientScheduledIds = [];   // setTimeout IDs for ambient event scheduling
  var ambientLevel = 0.7;         // Master ambient volume 0..1, independent of master volume

  // Music state
  var currentRoot = 62;       // MIDI note (D4)
  var currentScale = 'minorPentatonic';
  var currentSceneName = 'workshop';
  var currentTension = 1;     // 0-4
  var currentTimeOfDay = 'day';
  var currentInstrument = 'ks';
  var currentFilterFreq = 4500;

  // Melody state
  var melodyState = 0;
  var lastTwoNotes = [0, 0];
  var restProbability = 0.20;

  // Markov temperature — higher = more uniform/adventurous, lower = more conservative
  var markovTemperature = 1.0;

  // L-system rhythm pattern — evolves over time to create rhythmic variation
  var lSystem = {
    axiom: 'A',
    rules: { A: 'AB', B: 'BA' },
    current: 'A',
    generation: 0,
    position: 0,
  };

  // Submix fadeout state — tracks which submix (if any) is currently faded
  var fadedSubmixName = null;       // 'melody' | 'harm' | 'bass' | null
  var fadedSubmixOrigGain = 0;      // original gain value before fade
  var fadedSubmixRestoreTime = 0;   // AudioContext time when restore is scheduled

  // Chord progression variation — tracks used progressions to encourage variety
  var usedProgressionKeys = {};     // key -> true; tracks which progressions have been played
  var phrasesSinceProgressionReset = 0; // counts phrases since last used-set reset

  // Chord state
  var currentChordPool = null;
  var currentProgression = null;
  var currentChordIndex = 0;
  var currentChordNotes = null;

  // Tension params (will be lerped)
  var tensionTempoOffset = 0;
  var tensionFilterMult = 1.0;
  var tensionReverbWet = 0.25;
  var tensionVinylGain = 0.03;
  var tensionDrumLevel = 1;
  var hissUserLevel = 0.5;       // 0..1 user hiss control (0.5 = legacy default)

  // Preset state
  var currentPreset = null;        // name of active preset or null
  var currentRoomSize = 'medium';  // 'small' | 'medium' | 'large'
  var presetLerpTimer = null;      // interval ID for smooth preset transitions

  // User mixer levels — multipliers applied on top of base submix gains
  var userMelodyLevel = 1.0;     // 0..1 user melody multiplier
  var userHarmonyLevel = 1.0;    // 0..1 user harmony multiplier
  var userBassLevel = 1.0;       // 0..1 user bass multiplier

  // Base submix gain constants (match §7 defaults)
  var SUBMIX_BASE_GAINS = {
    melody: 0.30,
    harmony: 0.25,
    bass: 0.20,
    ambient: 0.18,
  };

  // Transition state
  var transitioning = false;
  var transitionTarget = null;
  var transitionBarsRemaining = 0;
  var transitionPhase = 0; // 0=fadeOut, 1=silence, 2=fadeIn

  // Scheduler
  var schedulerTimer = null;

  // ════════════════════════════════════════════════════════════════════
  // §3  SCALES & KEY SYSTEM
  // ════════════════════════════════════════════════════════════════════

  var SCALES = {
    majorPentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
    dorian:          [0, 2, 3, 5, 7, 9, 10],
    mixolydian:      [0, 2, 4, 5, 7, 9, 10],
    aeolian:         [0, 2, 3, 5, 7, 8, 10],
    lydian:          [0, 2, 4, 6, 7, 9, 11],
    minorBlues:      [0, 3, 5, 6, 7, 10],
  };

  var SCENE_MUSIC = {
    workshop:      { root: 62, scale: 'minorPentatonic', tempo: 75, instrument: 'ks',  filter: 4500 },
    library:       { root: 64, scale: 'minorPentatonic', tempo: 67, instrument: 'fm',  filter: 3500 },
    garden:        { root: 67, scale: 'majorPentatonic', tempo: 73, instrument: 'ks',  filter: 5000 },
    waterfront:    { root: 69, scale: 'dorian',          tempo: 76, instrument: 'ks',  filter: 4000 },
    cave:          { root: 60, scale: 'aeolian',         tempo: 63, instrument: 'fm',  filter: 3000 },
    winterLodge:   { root: 65, scale: 'mixolydian',      tempo: 71, instrument: 'fm',  filter: 3500 },
    harvestField:  { root: 67, scale: 'majorPentatonic', tempo: 80, instrument: 'ks',  filter: 5000 },
    cliffOverlook: { root: 69, scale: 'dorian',          tempo: 65, instrument: 'pad', filter: 2500 },
  };

  // ── Mood Presets ──────────────────────────────────────────────────────────

  var PRESETS = {
    warmLofi: {
      label: 'Warm Lofi',
      melodySub: 0.30, harmSub: 0.25, bassSub: 0.20,
      hissLevel: 0.5, reverbWet: 0.25, ambientLevel: 0.7,
      filterMult: 1.0,
    },
    rainFocus: {
      label: 'Rain Focus',
      melodySub: 0.12, harmSub: 0.10, bassSub: 0.15,
      hissLevel: 0.8, reverbWet: 0.40, ambientLevel: 1.0,
      filterMult: 0.6,
    },
    deepNight: {
      label: 'Deep Night',
      melodySub: 0.15, harmSub: 0.20, bassSub: 0.30,
      hissLevel: 0.3, reverbWet: 0.35, ambientLevel: 0.5,
      filterMult: 0.5,
    },
    gardenMorning: {
      label: 'Garden Morning',
      melodySub: 0.35, harmSub: 0.25, bassSub: 0.15,
      hissLevel: 0.2, reverbWet: 0.20, ambientLevel: 0.9,
      filterMult: 1.4,
    },
  };

  // ── Room Size Configs ──────────────────────────────────────────────────────────

  var ROOM_CONFIGS = {
    small: {
      duration: 0.8, decay: 0.4, lpCoeff: 0.85,
      reflections: [
        { delay: 0.010, gain: 0.7 },
        { delay: 0.018, gain: 0.55 },
        { delay: 0.025, gain: 0.4 },
        { delay: 0.030, gain: 0.25 },
      ],
    },
    medium: {
      duration: 1.5, decay: 0.6, lpCoeff: 0.7,
      reflections: [
        { delay: 0.012, gain: 0.7 },
        { delay: 0.024, gain: 0.5 },
        { delay: 0.038, gain: 0.3 },
        { delay: 0.055, gain: 0.2 },
      ],
    },
    large: {
      duration: 3.0, decay: 0.9, lpCoeff: 0.5,
      reflections: [
        { delay: 0.030, gain: 0.6 },
        { delay: 0.048, gain: 0.45 },
        { delay: 0.062, gain: 0.3 },
        { delay: 0.075, gain: 0.2 },
        { delay: 0.080, gain: 0.12 },
      ],
    },
  };

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function getScaleNote(degree, octaveOffset) {
    var scale = SCALES[currentScale];
    if (!scale) scale = SCALES.minorPentatonic;
    var len = scale.length;
    var idx = ((degree % len) + len) % len;
    var oct = Math.floor(degree / len);
    return currentRoot + scale[idx] + (oct + (octaveOffset || 0)) * 12;
  }

  /** Build a triad from scale degrees. Returns array of MIDI notes. */
  function buildChordFromDegree(rootDegree) {
    var scale = SCALES[currentScale];
    if (!scale) scale = SCALES.minorPentatonic;
    var len = scale.length;

    var r = ((rootDegree % len) + len) % len;
    var t = (((rootDegree + 2) % len) + len) % len;
    var f = (((rootDegree + 4) % len) + len) % len;

    var rootNote = currentRoot + scale[r];
    var third = currentRoot + scale[t];
    var fifth = currentRoot + scale[f];

    // Ensure third and fifth are above root
    if (third <= rootNote) third += 12;
    if (fifth <= rootNote) fifth += 12;
    if (fifth <= third) fifth += 12;

    return [rootNote - 12, rootNote, third, fifth]; // bass + triad
  }

  // ════════════════════════════════════════════════════════════════════
  // §4  CHORD PROGRESSION SYSTEM
  // ════════════════════════════════════════════════════════════════════

  var CHORD_POOLS = {
    majorCalm: [
      [0, 3, 4, 0],   // I-IV-V-I
      [0, 5, 3, 4],   // I-vi-IV-V
      [0, 2, 3, 0],   // I-iii-IV-I
      [0, 3, 1, 4],   // I-IV-ii-V
    ],
    minorCalm: [
      [0, 3, 4, 0],   // i-iv-v-i
      [0, 5, 2, 6],   // i-VI-III-VII
      [0, 3, 6, 2],   // i-iv-VII-III
      [0, 5, 3, 4],   // i-VI-iv-v
    ],
  };

  function pickNewProgression() {
    var isMinor = currentScale === 'minorPentatonic' || currentScale === 'aeolian'
      || currentScale === 'dorian' || currentScale === 'minorBlues';
    var poolName = isMinor ? 'minorCalm' : 'majorCalm';
    var pool = CHORD_POOLS[poolName];

    // Bias toward untried progressions for variety
    var untried = [];
    var tried = [];
    for (var pi = 0; pi < pool.length; pi++) {
      var key = poolName + ':' + pool[pi].join(',');
      if (!usedProgressionKeys[key]) {
        untried.push(pi);
      } else {
        tried.push(pi);
      }
    }

    var chosenIdx;
    if (untried.length > 0) {
      // Strongly prefer untried: 85% chance to pick an untried progression
      if (rng() < 0.85 || tried.length === 0) {
        chosenIdx = untried[Math.floor(rng() * untried.length)];
      } else {
        chosenIdx = tried[Math.floor(rng() * tried.length)];
      }
    } else {
      // All tried — pick randomly
      chosenIdx = Math.floor(rng() * pool.length);
    }

    currentProgression = pool[chosenIdx];
    currentChordIndex = 0;

    // Track this progression as used
    var usedKey = poolName + ':' + currentProgression.join(',');
    usedProgressionKeys[usedKey] = true;
  }

  function advanceChord() {
    if (!currentProgression) pickNewProgression();
    var degree = currentProgression[currentChordIndex];
    currentChordNotes = buildChordFromDegree(degree);
    currentChordIndex = (currentChordIndex + 1) % currentProgression.length;
    // Chance to pick a new progression at end of cycle
    if (currentChordIndex === 0 && rng() < 0.35) {
      pickNewProgression();
    }
    return currentChordNotes;
  }

  // ════════════════════════════════════════════════════════════════════
  // §4b  L-SYSTEM RHYTHM EVOLUTION
  // ════════════════════════════════════════════════════════════════════

  /**
   * Evolve the L-system by one generation: apply rewrite rules to current string.
   * Called every ~16 phrases (~5 minutes at 75bpm with 4 bars/phrase).
   * Caps string length at 256 characters to prevent unbounded growth.
   */
  function evolveLSystem() {
    var next = '';
    for (var i = 0; i < lSystem.current.length && next.length < 256; i++) {
      var ch = lSystem.current[i];
      next += lSystem.rules[ch] || ch;
    }
    if (next.length > 256) next = next.substring(0, 256);
    lSystem.current = next;
    lSystem.generation++;
    lSystem.position = 0; // reset position on new generation
  }

  /**
   * Read current L-system character and return a rest probability multiplier.
   * 'A' = standard density (1.0x), 'B' = sparse (1.8x, capped so effective rest <= 0.5).
   * Advances the L-system position after each call.
   */
  function getLSystemRestMultiplier() {
    var str = lSystem.current;
    if (!str || str.length === 0) return 1.0;
    var ch = str[lSystem.position % str.length];
    lSystem.position++;
    return ch === 'B' ? 1.8 : 1.0;
  }

  // ════════════════════════════════════════════════════════════════════
  // §5  MARKOV MELODY GENERATOR
  // ════════════════════════════════════════════════════════════════════

  var MARKOV_PENTA = [
    [0.05, 0.35, 0.20, 0.10, 0.30],
    [0.30, 0.05, 0.35, 0.15, 0.15],
    [0.15, 0.25, 0.05, 0.35, 0.20],
    [0.10, 0.15, 0.30, 0.05, 0.40],
    [0.40, 0.15, 0.15, 0.25, 0.05],
  ];

  // Extended 7-note Markov matrix for dorian / mixolydian / aeolian / lydian
  var MARKOV_SEVEN = [
    [0.02, 0.22, 0.12, 0.08, 0.20, 0.18, 0.18],
    [0.25, 0.02, 0.25, 0.10, 0.10, 0.15, 0.13],
    [0.12, 0.20, 0.02, 0.28, 0.12, 0.13, 0.13],
    [0.10, 0.08, 0.22, 0.02, 0.30, 0.15, 0.13],
    [0.20, 0.10, 0.10, 0.22, 0.02, 0.20, 0.16],
    [0.18, 0.15, 0.10, 0.12, 0.18, 0.02, 0.25],
    [0.30, 0.12, 0.10, 0.10, 0.12, 0.22, 0.04],
  ];

  // 6-note Markov matrix for minorBlues
  var MARKOV_BLUES = [
    [0.02, 0.30, 0.20, 0.15, 0.18, 0.15],
    [0.25, 0.02, 0.30, 0.13, 0.15, 0.15],
    [0.15, 0.20, 0.02, 0.30, 0.18, 0.15],
    [0.12, 0.12, 0.25, 0.02, 0.30, 0.19],
    [0.20, 0.15, 0.12, 0.20, 0.02, 0.31],
    [0.35, 0.15, 0.12, 0.15, 0.20, 0.03],
  ];

  function getMarkovMatrix() {
    var scale = SCALES[currentScale];
    if (!scale) return MARKOV_PENTA;
    if (scale.length === 5) return MARKOV_PENTA;
    if (scale.length === 6) return MARKOV_BLUES;
    return MARKOV_SEVEN;
  }

  function nextMelodyNote() {
    // Rest check — modulated by L-system rhythm pattern
    var lSystemMult = getLSystemRestMultiplier();
    var effectiveRest = Math.min(restProbability * lSystemMult, 0.5);
    if (rng() < effectiveRest) return null;

    var matrix = getMarkovMatrix();
    var scaleLen = matrix.length;

    // Clamp state to matrix size
    if (melodyState >= scaleLen) melodyState = 0;

    // Apply Markov temperature to weights then renormalize
    var rawWeights = matrix[melodyState];
    var tempWeights = new Array(rawWeights.length);
    var tempSum = 0;
    for (var tw = 0; tw < rawWeights.length; tw++) {
      // Avoid Math.pow(0, ...) edge case
      tempWeights[tw] = rawWeights[tw] > 0
        ? Math.pow(rawWeights[tw], 1.0 / markovTemperature)
        : 0;
      tempSum += tempWeights[tw];
    }
    // Renormalize
    if (tempSum > 0) {
      for (var tn = 0; tn < tempWeights.length; tn++) {
        tempWeights[tn] /= tempSum;
      }
    }

    var r = rng();
    var next = 0;
    for (var i = 0; i < tempWeights.length; i++) {
      r -= tempWeights[i];
      if (r <= 0) { next = i; break; }
    }

    // Phrase resolution: every 8 beats, 40% chance resolve to root
    if (transport.currentBeat % 8 === 7 && rng() < 0.4) {
      next = 0;
    }

    melodyState = next;

    // Compute MIDI note
    var scale = SCALES[currentScale];
    if (!scale) scale = SCALES.minorPentatonic;
    var midi = currentRoot + scale[next % scale.length];

    // Octave bias — keep melody in a comfortable range
    var avgRecent = (lastTwoNotes[0] + lastTwoNotes[1]) / 2;
    if (avgRecent > currentRoot + 6 && rng() < 0.6) {
      // stay in current octave
    } else if (avgRecent < currentRoot + 6 && rng() < 0.6) {
      midi += 12;
    }

    // Clamp to a reasonable range (MIDI 48 .. 84)
    if (midi < 48) midi += 12;
    if (midi > 84) midi -= 12;

    // Random detune +/- 3 cents for lofi character
    var detuneCents = (rng() - 0.5) * 6;

    lastTwoNotes[0] = lastTwoNotes[1];
    lastTwoNotes[1] = midi;

    return { midi: midi, detuneCents: detuneCents };
  }

  // ════════════════════════════════════════════════════════════════════
  // §6  TRANSPORT & SCHEDULER
  // ════════════════════════════════════════════════════════════════════

  var transport = {
    currentBeat: 0,
    currentBar: 0,
    currentPhrase: 0,
    beatsPerBar: 4,
    barsPerPhrase: 4,
    tempo: 75,
    get secondsPerBeat() { return 60 / this.tempo; },
    nextBeatTime: 0,
    isPlaying: false,
  };

  function scheduleAhead() {
    if (!transport.isPlaying) return;
    if (!ctx) return;

    var lookAhead = 0.12; // seconds
    var now = ctx.currentTime;

    while (transport.nextBeatTime < now + lookAhead) {
      scheduleBeat(transport.nextBeatTime);
      advanceTransport();
    }

    schedulerTimer = setTimeout(scheduleAhead, 50);
  }

  function scheduleBeat(time) {
    var beat = transport.currentBeat;
    var bar = transport.currentBar;

    // Handle scene transition fading
    if (transitioning) {
      handleTransitionBeat(time, beat, bar);
    }

    // ── Melody (every beat, possibly rested) ──
    if (!transitioning || transitionPhase === 2) {
      var melodyVol = transitioning ? Math.min(1, (4 - transitionBarsRemaining) / 2) : 1.0;
      var note = nextMelodyNote();
      if (note) {
        playMelodyNote(note.midi, note.detuneCents, time, transport.secondsPerBeat * 0.8, melodyVol);
      }
    }

    // ── Chord changes (first beat of each bar) ──
    if (beat === 0) {
      var chord = advanceChord();
      scheduleChord(chord, time);
    }

    // ── Drums (16-step pattern within the bar) ──
    scheduleDrums(time, beat);

    // ── Bass (beats 0 and 2) ──
    if (beat === 0 || beat === 2) {
      scheduleBass(time);
    }
  }

  function advanceTransport() {
    transport.nextBeatTime += transport.secondsPerBeat;
    transport.currentBeat++;

    if (transport.currentBeat >= transport.beatsPerBar) {
      transport.currentBeat = 0;
      transport.currentBar++;

      if (transitioning) {
        transitionBarsRemaining--;
        if (transitionBarsRemaining <= 0) {
          finishTransition();
        }
      }

      if (transport.currentBar >= transport.barsPerPhrase) {
        transport.currentBar = 0;
        transport.currentPhrase++;
        onNewPhrase();
      }
    }
  }

  function onNewPhrase() {
    if (DEBUG_AUDIO) {
      var progStr = currentProgression ? currentProgression.join('-') : '?';
      console.log('[Audio] Phrase', transport.currentPhrase, 'chord:', progStr, 'tempo:', Math.round(transport.tempo), 'scale:', currentScale, 'seed:', _currentSeed);
    }

    // Occasionally pick a new chord progression
    if (rng() < 0.25) {
      pickNewProgression();
    }

    // ── Chord progression variety reset (~every 20 phrases) ──
    phrasesSinceProgressionReset++;
    if (phrasesSinceProgressionReset >= 20) {
      usedProgressionKeys = {};
      phrasesSinceProgressionReset = 0;
    }

    // ── Markov temperature drift ──
    markovTemperature += (rng() - 0.5) * 0.05;
    markovTemperature = Math.max(0.6, Math.min(1.8, markovTemperature));
    // Mean-revert toward 1.0
    markovTemperature += (1.0 - markovTemperature) * 0.02;

    // ── L-system rhythm evolution (every ~16 phrases ≈ 5 min at 75bpm) ──
    if (transport.currentPhrase > 0 && transport.currentPhrase % 16 === 0) {
      evolveLSystem();
    }

    // ── Submix fadeout/restore for breathing room ──
    // Check if a faded submix needs restoring (time-based via AudioContext clock)
    if (fadedSubmixName && ctx && ctx.currentTime >= fadedSubmixRestoreTime) {
      // Restore has already been scheduled via linearRampToValueAtTime — just clear tracking
      fadedSubmixName = null;
      fadedSubmixOrigGain = 0;
      fadedSubmixRestoreTime = 0;
    }

    // 5% chance per phrase to fade a random submix (if none currently faded)
    if (!fadedSubmixName && ctx && rng() < 0.05 && !transitioning) {
      var submixCandidates = [
        { name: 'melody', node: melodySub },
        { name: 'harm',   node: harmSub },
        { name: 'bass',   node: bassSub },
      ];
      // Never fade ambientSub
      var pick = submixCandidates[Math.floor(rng() * submixCandidates.length)];
      if (pick.node) {
        var now = ctx.currentTime;
        var fadeOutDur = 4; // fade to 0 over 4 seconds
        var silenceBars = 8 + Math.floor(rng() * 9); // 8-16 bars of silence
        var silenceDur = silenceBars * transport.beatsPerBar * transport.secondsPerBeat;
        var restoreTime = now + fadeOutDur + silenceDur;

        fadedSubmixName = pick.name;
        fadedSubmixOrigGain = pick.node.gain.value;
        fadedSubmixRestoreTime = restoreTime + fadeOutDur; // after restore ramp completes

        // Fade out
        pick.node.gain.setValueAtTime(pick.node.gain.value, now);
        pick.node.gain.linearRampToValueAtTime(0.0, now + fadeOutDur);

        // Schedule restore
        pick.node.gain.setValueAtTime(0.0, restoreTime);
        pick.node.gain.linearRampToValueAtTime(fadedSubmixOrigGain, restoreTime + fadeOutDur);
      }
    }

    // Slight tempo drift for organic feel (+/- 1 BPM)
    var drift = (rng() - 0.5) * 2;
    var sceneTempo = SCENE_MUSIC[currentSceneName] ? SCENE_MUSIC[currentSceneName].tempo : 75;
    transport.tempo = Math.max(55, Math.min(100, sceneTempo + tensionTempoOffset + drift));
  }

  // ════════════════════════════════════════════════════════════════════
  // §7  AUDIO CONTEXT & MASTER BUS
  // ════════════════════════════════════════════════════════════════════

  function ensureContext() {
    if (ctx) return;

    ctx = new AudioCtx({ sampleRate: 44100 });

    // ── Master gain ──
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(ctx.destination);

    // ── Safety limiter (DynamicsCompressor between lofi merge and master) ──
    safetyLimiter = ctx.createDynamicsCompressor();
    safetyLimiter.threshold.value = -6;
    safetyLimiter.knee.value = 6;
    safetyLimiter.ratio.value = 12;
    safetyLimiter.attack.value = 0.003;
    safetyLimiter.release.value = 0.25;
    safetyLimiter.connect(masterGain);

    // ── Lofi chain output merge (dry + wet -> limiter -> master) ──
    lofiMerge = ctx.createGain();
    lofiMerge.gain.value = 1.0;
    lofiMerge.connect(safetyLimiter);

    // ── Build lofi processing chain ──
    buildLofiChain();

    // ── Submix buses -> lofi input ──
    melodySub = ctx.createGain();
    melodySub.gain.value = SUBMIX_BASE_GAINS.melody * userMelodyLevel;
    melodySub.connect(lofiInput);

    harmSub = ctx.createGain();
    harmSub.gain.value = SUBMIX_BASE_GAINS.harmony * userHarmonyLevel;
    harmSub.connect(lofiInput);

    bassSub = ctx.createGain();
    bassSub.gain.value = SUBMIX_BASE_GAINS.bass * userBassLevel;
    bassSub.connect(lofiInput);

    ambientSub = ctx.createGain();
    ambientSub.gain.value = SUBMIX_BASE_GAINS.ambient * (ambientLevel / 0.7);
    ambientSub.connect(lofiInput);
  }

  // ════════════════════════════════════════════════════════════════════
  // §8  LOFI PROCESSING CHAIN
  // ════════════════════════════════════════════════════════════════════

  function createSoftClipCurve(drive) {
    drive = drive || 1.5;
    var len = 8192;
    var curve = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      var x = (i / len) * 2 - 1;
      curve[i] = Math.tanh(drive * x);
    }
    return curve;
  }

  function createReverbIR(roomSize) {
    var config = ROOM_CONFIGS[roomSize] || ROOM_CONFIGS.medium;
    var duration = config.duration;
    var decay = config.decay;
    var lpCoeff = config.lpCoeff;
    var reflections = config.reflections;
    var sr = ctx.sampleRate;
    var length = Math.ceil(sr * duration);
    var buffer = ctx.createBuffer(2, length, sr);
    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      var decayRate = sr * decay;
      // 1. Early reflections — discrete taps that create room-size perception
      for (var r = 0; r < reflections.length; r++) {
        var ref = reflections[r];
        var sampleIdx = Math.round(ref.delay * sr);
        if (sampleIdx < length) {
          // Stereo spread: slight offset between L/R channels
          var offset = ch === 0 ? 0 : Math.round(0.003 * sr * (r % 2 === 0 ? 1 : -1));
          var idx = Math.max(0, Math.min(length - 1, sampleIdx + offset));
          // Short burst (3-sample impulse for smoother click)
          for (var s = 0; s < 3 && idx + s < length; s++) {
            data[idx + s] += ref.gain * (1.0 - s * 0.3);
          }
        }
      }
      // 2. Diffuse tail — filtered decaying noise (starts after last reflection)
      var tailStart = reflections.length > 0
        ? Math.round(reflections[reflections.length - 1].delay * sr) + Math.round(0.005 * sr)
        : 0;
      var prev = 0;
      for (var i = tailStart; i < length; i++) {
        var noise = Math.random() * 2 - 1; // true random OK for IR
        var envelope = Math.exp(-(i - tailStart) / decayRate);
        // One-pole lowpass — lpCoeff controls brightness (lower = darker)
        var filtered = lpCoeff * noise + (1 - lpCoeff) * prev;
        prev = filtered;
        data[i] += filtered * envelope;
      }
    }
    return buffer;
  }

  function buildLofiChain() {
    // Input node
    lofiInput = ctx.createGain();
    lofiInput.gain.value = 1.0;

    // 1. Soft-clip saturation (tanh waveshaper, drive=1.5)
    bitcrusher = ctx.createWaveShaper();
    bitcrusher.curve = createSoftClipCurve(1.5);
    bitcrusher.oversample = '2x';

    // 2. Tape wow: DelayNode modulated by slow LFO
    tapeWowDelay = ctx.createDelay(0.05);
    tapeWowDelay.delayTime.value = 0.005; // 5ms base

    tapeWowLFO = ctx.createOscillator();
    tapeWowLFO.type = 'sine';
    tapeWowLFO.frequency.value = 0.3; // Hz

    tapeWowDepth = ctx.createGain();
    tapeWowDepth.gain.value = 0.002; // modulation depth in seconds

    tapeWowLFO.connect(tapeWowDepth);
    tapeWowDepth.connect(tapeWowDelay.delayTime);
    tapeWowLFO.start();

    // 3. Lowpass rolloff
    lowpassRolloff = ctx.createBiquadFilter();
    lowpassRolloff.type = 'lowpass';
    lowpassRolloff.frequency.value = 9000;
    lowpassRolloff.Q.value = 0.7;

    // 4. Reverb (ConvolverNode with synthetic IR)
    reverbConvolver = ctx.createConvolver();
    reverbConvolver.buffer = createReverbIR(currentRoomSize);

    // 5. Dry/wet mix
    dryGain = ctx.createGain();
    dryGain.gain.value = 0.75;

    wetGain = ctx.createGain();
    wetGain.gain.value = 0.25;

    // Wire the chain:
    // lofiInput -> bitcrusher -> tapeWowDelay -> lowpassRolloff
    //   -> (split) -> dryGain ---------> lofiMerge
    //             \-> reverbConvolver -> wetGain -> lofiMerge
    lofiInput.connect(bitcrusher);
    bitcrusher.connect(tapeWowDelay);
    tapeWowDelay.connect(lowpassRolloff);

    lowpassRolloff.connect(dryGain);
    lowpassRolloff.connect(reverbConvolver);

    dryGain.connect(lofiMerge);
    reverbConvolver.connect(wetGain);
    wetGain.connect(lofiMerge);
  }

  // ════════════════════════════════════════════════════════════════════
  // §9  KARPLUS-STRONG SYNTHESIS
  // ════════════════════════════════════════════════════════════════════

  var KS_POOL_SIZE = 6;
  var ksActiveCount = 0;

  function computeKarplusStrong(frequency, duration, decayFactor, blendFactor) {
    var sampleRate = ctx.sampleRate;
    var samples = Math.ceil(sampleRate * duration);
    var buffer = ctx.createBuffer(1, samples, sampleRate);
    var data = buffer.getChannelData(0);

    var period = Math.round(sampleRate / frequency);
    if (period < 2) period = 2;

    // Fill initial period with seeded noise
    for (var i = 0; i < period && i < samples; i++) {
      data[i] = rng() * 2 - 1;
    }

    // Karplus-Strong feedback loop
    for (var j = period; j < samples; j++) {
      var prev = data[j - period];
      var next = (j - period + 1 < samples) ? data[j - period + 1] : prev;
      data[j] = decayFactor * (blendFactor * prev + (1 - blendFactor) * next);
    }

    return buffer;
  }

  /** Pre-computed KS buffer cache: key = MIDI note, value = AudioBuffer */
  var ksBufferCache = {};

  function getKSBuffer(midi, duration) {
    var key = midi + '_' + Math.round(duration * 10);
    if (ksBufferCache[key]) return ksBufferCache[key];

    var freq = midiToFreq(midi);
    // Softer decay for lower notes, brighter for higher
    var decay = midi < 60 ? 0.994 : (midi < 72 ? 0.992 : 0.990);
    var blend = 0.5;
    var buf = computeKarplusStrong(freq, duration, decay, blend);
    // Cap cache at 100 entries to prevent unbounded memory growth
    var cacheKeys = Object.keys(ksBufferCache);
    if (cacheKeys.length >= 100) {
      delete ksBufferCache[cacheKeys[0]];
    }
    ksBufferCache[key] = buf;
    return buf;
  }

  function playKS(freq, duration, time, outputNode, volumeMult) {
    if (!ctx) return;

    var midi = Math.round(69 + 12 * Math.log2(freq / 440));
    var sampleRate = ctx.sampleRate;
    var samples = Math.ceil(sampleRate * duration);
    var buffer = ctx.createBuffer(1, samples, sampleRate);
    var data = buffer.getChannelData(0);

    var period = Math.round(sampleRate / freq);
    if (period < 2) period = 2;

    for (var i = 0; i < period && i < samples; i++) {
      data[i] = rng() * 2 - 1;
    }

    var decayFactor = midi < 60 ? 0.994 : (midi < 72 ? 0.992 : 0.990);
    for (var j = period; j < samples; j++) {
      var prev = data[j - period];
      var next = (j - period + 1 < samples) ? data[j - period + 1] : prev;
      data[j] = decayFactor * (0.5 * prev + 0.5 * next);
    }

    var source = ctx.createBufferSource();
    source.buffer = buffer;

    var gain = ctx.createGain();
    var vol = (volumeMult || 1.0) * 0.3;
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration * 0.95);

    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = currentFilterFreq * tensionFilterMult;
    filter.Q.value = 0.5;

    source.connect(gain);
    gain.connect(filter);
    filter.connect(outputNode || melodySub);
    source.start(time);
    source.stop(time + duration);

    ksActiveCount++;
    source.onended = function () { ksActiveCount--; };
  }

  // ════════════════════════════════════════════════════════════════════
  // §10  FM SYNTHESIS
  // ════════════════════════════════════════════════════════════════════

  var FM_VOICE_COUNT = 4;

  function createFMVoice() {
    var carrier = ctx.createOscillator();
    var modulator = ctx.createOscillator();
    var modGain = ctx.createGain();
    var outputGain = ctx.createGain();
    var outputFilter = ctx.createBiquadFilter();

    carrier.type = 'sine';
    modulator.type = 'sine';
    modGain.gain.value = 0;
    outputGain.gain.value = 0;

    outputFilter.type = 'lowpass';
    outputFilter.frequency.value = currentFilterFreq;
    outputFilter.Q.value = 0.5;

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(outputGain);
    outputGain.connect(outputFilter);
    outputFilter.connect(melodySub);

    carrier.start();
    modulator.start();

    return {
      carrier: carrier,
      modulator: modulator,
      modGain: modGain,
      outputGain: outputGain,
      outputFilter: outputFilter,
      busy: false,
    };
  }

  function initFMVoices() {
    for (var i = 0; i < FM_VOICE_COUNT; i++) {
      fmVoices.push(createFMVoice());
    }
  }

  function getFreeFMVoice() {
    for (var i = 0; i < fmVoices.length; i++) {
      if (!fmVoices[i].busy) return fmVoices[i];
    }
    // All busy — steal the first one
    return fmVoices[0];
  }

  function playFMNote(midi, detuneCents, time, duration, volumeMult) {
    var voice = getFreeFMVoice();
    voice.busy = true;

    var freq = midiToFreq(midi);
    if (detuneCents) {
      freq *= Math.pow(2, detuneCents / 1200);
    }

    var ratio = 2.0 + rng() * 1.0; // mod ratio 2.0-3.0
    var modIndex = 80 + rng() * 120; // modulation index

    // Set frequencies
    voice.carrier.frequency.setValueAtTime(freq, time);
    voice.modulator.frequency.setValueAtTime(freq * ratio, time);

    // Update filter
    voice.outputFilter.frequency.setValueAtTime(currentFilterFreq * tensionFilterMult, time);

    // Modulation envelope: attack to modIndex, then decay to 30%
    voice.modGain.gain.cancelScheduledValues(time);
    voice.modGain.gain.setValueAtTime(0, time);
    voice.modGain.gain.linearRampToValueAtTime(modIndex, time + 0.01);
    voice.modGain.gain.exponentialRampToValueAtTime(Math.max(modIndex * 0.3, 1), time + 0.3);
    voice.modGain.gain.linearRampToValueAtTime(0, time + duration);

    // ADSR amplitude envelope
    var vol = (volumeMult || 1.0) * 0.2;
    var attack = 0.015;
    var decay = 0.1;
    var sustain = vol * 0.6;
    var release = Math.min(0.3, duration * 0.3);

    voice.outputGain.gain.cancelScheduledValues(time);
    voice.outputGain.gain.setValueAtTime(0, time);
    voice.outputGain.gain.linearRampToValueAtTime(vol, time + attack);
    voice.outputGain.gain.linearRampToValueAtTime(sustain, time + attack + decay);
    voice.outputGain.gain.setValueAtTime(sustain, time + duration - release);
    voice.outputGain.gain.linearRampToValueAtTime(0, time + duration);

    // Mark voice as free after note ends
    var releaseTime = (duration + 0.05) * 1000;
    setTimeout(function () { voice.busy = false; }, releaseTime);
  }

  // ════════════════════════════════════════════════════════════════════
  // §11  WAVETABLE PAD SYNTHESIS
  // ════════════════════════════════════════════════════════════════════

  var PAD_VOICE_COUNT = 2; // crossfade pair

  function createPadVoice() {
    // Custom wavetable: warm organ-like with even harmonics rolled off
    var real = new Float32Array([0, 1, 0.5, 0.3, 0, 0.15, 0, 0.08]);
    var imag = new Float32Array(real.length);
    var wave = ctx.createPeriodicWave(real, imag);

    var osc1 = ctx.createOscillator();
    var osc2 = ctx.createOscillator();
    osc1.setPeriodicWave(wave);
    osc2.setPeriodicWave(wave);
    osc2.detune.value = 5; // cents — subtle chorus

    var mix = ctx.createGain();
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2500;
    filter.Q.value = 0.7;

    osc1.connect(mix);
    osc2.connect(mix);
    mix.gain.value = 0;
    mix.connect(filter);
    filter.connect(harmSub);

    osc1.start();
    osc2.start();

    return {
      osc1: osc1,
      osc2: osc2,
      mix: mix,
      filter: filter,
    };
  }

  function initPadVoices() {
    for (var i = 0; i < PAD_VOICE_COUNT; i++) {
      padVoices.push(createPadVoice());
    }
    padActiveIndex = 0;
  }

  /**
   * Play a pad chord by crossfading from active voice to the other.
   * @param {number[]} midiNotes - MIDI notes for the chord
   * @param {number} time - AudioContext time
   * @param {number} fadeDuration - crossfade in seconds
   */
  function playPadChord(midiNotes, time, fadeDuration) {
    if (padVoices.length < 2) return;

    fadeDuration = fadeDuration || 3;

    var oldVoice = padVoices[padActiveIndex];
    padActiveIndex = (padActiveIndex + 1) % PAD_VOICE_COUNT;
    var newVoice = padVoices[padActiveIndex];

    // Set new voice frequencies to lowest two notes
    var baseFreq = midiToFreq(midiNotes[0] || currentRoot);
    var harmFreq = midiToFreq(midiNotes.length > 2 ? midiNotes[2] : midiNotes[0] + 7);

    newVoice.osc1.frequency.setValueAtTime(baseFreq, time);
    newVoice.osc2.frequency.setValueAtTime(harmFreq, time);
    newVoice.filter.frequency.setValueAtTime(
      Math.min(currentFilterFreq * tensionFilterMult, 4000), time
    );

    // Crossfade
    var padVol = 0.12;
    newVoice.mix.gain.cancelScheduledValues(time);
    newVoice.mix.gain.setValueAtTime(0, time);
    newVoice.mix.gain.linearRampToValueAtTime(padVol, time + fadeDuration);

    oldVoice.mix.gain.cancelScheduledValues(time);
    oldVoice.mix.gain.linearRampToValueAtTime(0, time + fadeDuration);
  }

  // ════════════════════════════════════════════════════════════════════
  // §12  DRUM SYNTHESIS
  // ════════════════════════════════════════════════════════════════════

  // 16-step drum patterns per tension level
  // 1 = hit, 0 = rest, 0.5 = ghost note
  var DRUM_PATTERNS = {
    // Level 0 (calm): no drums
    kick:   [
      [],                                          // 0: calm — silent
      [1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0],  // 1: normal
      [1, 0, 0, 0,  0, 0, 1, 0,  1, 0, 0, 0,  0, 0, 1, 0],  // 2: tense
      [1, 0, 1, 0,  0, 0, 1, 0,  1, 0, 1, 0,  0, 1, 0, 0],  // 3: crisis
      [],                                          // 4: siege — silent
    ],
    snare: [
      [],
      [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 0],
      [0, 0, 0, 0,  1, 0, 0, 0.5,  0, 0, 0, 0,  1, 0, 0.5, 0],
      [0, 0, 0, 0.5,  1, 0, 0.5, 0,  0, 0, 0.5, 0,  1, 0, 0, 0.5],
      [],
    ],
    hihat: [
      [],
      [1, 0, 0.5, 0,  1, 0, 0.5, 0,  1, 0, 0.5, 0,  1, 0, 0.5, 0],
      [1, 0.5, 0.5, 0,  1, 0.5, 0.5, 0,  1, 0.5, 0.5, 0.5,  1, 0.5, 0.5, 0],
      [1, 0.5, 1, 0.5,  1, 0.5, 1, 0.5,  1, 0.5, 1, 0.5,  1, 0.5, 1, 0.5],
      [],
    ],
  };

  function playKick(time) {
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.08);
    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
    osc.connect(gain);
    gain.connect(bassSub);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  function playSnare(time, ghost) {
    if (!ctx) return;
    var bufferSize = Math.ceil(ctx.sampleRate * 0.05);
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) {
      data[i] = rng() * 2 - 1;
    }

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1000;
    filter.Q.value = 1.0;
    var gain = ctx.createGain();
    var vol = ghost ? 0.08 : 0.25;
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(melodySub);
    source.start(time);
    source.stop(time + 0.11);
  }

  function playHiHat(time, ghost) {
    if (!ctx) return;
    var bufferSize = Math.ceil(ctx.sampleRate * 0.02);
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) {
      data[i] = rng() * 2 - 1;
    }

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    var filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    filter.Q.value = 1.0;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(ghost ? 0.04 : 0.12, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ambientSub);
    source.start(time);
    source.stop(time + 0.05);
  }

  function scheduleDrums(time, beat) {
    var level = tensionDrumLevel;
    if (level < 0 || level > 4) return;

    // 4 beats per bar, 4 sub-steps per beat = 16 steps
    // We schedule 4 sub-steps for the current beat
    var subStepDuration = transport.secondsPerBeat / 4;

    for (var sub = 0; sub < 4; sub++) {
      var step = beat * 4 + sub;
      var stepTime = time + sub * subStepDuration;

      // Kick
      var kickPat = DRUM_PATTERNS.kick[level];
      if (kickPat && kickPat.length > 0 && kickPat[step]) {
        // Slight humanization: +/- 5ms
        var humanize = (rng() - 0.5) * 0.01;
        playKick(stepTime + humanize);
      }

      // Snare
      var snarePat = DRUM_PATTERNS.snare[level];
      if (snarePat && snarePat.length > 0 && snarePat[step]) {
        var isGhostSnare = snarePat[step] < 1;
        var humanizeS = (rng() - 0.5) * 0.008;
        playSnare(stepTime + humanizeS, isGhostSnare);
      }

      // HiHat
      var hihatPat = DRUM_PATTERNS.hihat[level];
      if (hihatPat && hihatPat.length > 0 && hihatPat[step]) {
        var isGhostHH = hihatPat[step] < 1;
        var humanizeH = (rng() - 0.5) * 0.006;
        playHiHat(stepTime + humanizeH, isGhostHH);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §13  BASS SYNTHESIS (Karplus-Strong, lower octave)
  // ════════════════════════════════════════════════════════════════════

  function scheduleBass(time) {
    if (!currentChordNotes || currentChordNotes.length === 0) return;

    // Bass plays the root of the current chord, one octave down
    var bassMidi = currentChordNotes[0]; // already -12 from buildChordFromDegree
    if (bassMidi < 28) bassMidi += 12;   // don't go too low

    var freq = midiToFreq(bassMidi);
    var duration = transport.secondsPerBeat * 1.8; // sustain across two beats

    // Slight velocity variation
    var vol = 0.25 + rng() * 0.1;

    playKS(freq, duration, time, bassSub, vol);
  }

  // ════════════════════════════════════════════════════════════════════
  // §14  MELODY INSTRUMENT ROUTER
  // ════════════════════════════════════════════════════════════════════

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToName(midi) {
    return NOTE_NAMES[midi % 12] + Math.floor(midi / 12 - 1);
  }

  function playMelodyNote(midi, detuneCents, time, duration, volumeMult) {
    volumeMult = volumeMult || 1.0;

    // Log melody notes on beat 0 (once per bar) to avoid console spam
    if (DEBUG_AUDIO && transport.currentBeat === 0) {
      console.log('[Audio] Note:', midiToName(midi), 'at:', time.toFixed(2), 'bar:', transport.currentBar);
    }

    // Route to active instrument
    switch (currentInstrument) {
      case 'ks':
        var freq = midiToFreq(midi);
        if (detuneCents) {
          freq *= Math.pow(2, detuneCents / 1200);
        }
        playKS(freq, duration, time, melodySub, volumeMult);
        break;

      case 'fm':
        playFMNote(midi, detuneCents, time, duration, volumeMult);
        break;

      case 'pad':
        // Pad instrument: play through FM with very slow attack
        playFMNote(midi, detuneCents, time, duration * 1.5, volumeMult * 0.6);
        break;

      default:
        playKS(midiToFreq(midi), duration, time, melodySub, volumeMult);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §15  CHORD SCHEDULING
  // ════════════════════════════════════════════════════════════════════

  function scheduleChord(chordNotes, time) {
    if (!chordNotes || chordNotes.length < 3) return;

    // Route chord to pad voices for sustained harmony
    playPadChord(chordNotes, time, transport.secondsPerBeat * transport.beatsPerBar);

    // Also play a gentle KS strum of the chord for attack transient
    var strumDelay = 0.03; // 30ms strum spread
    for (var i = 1; i < chordNotes.length; i++) { // skip bass (index 0, handled by bass track)
      var noteFreq = midiToFreq(chordNotes[i]);
      var noteTime = time + i * strumDelay;
      var vol = 0.08 + rng() * 0.04; // very quiet
      playKS(noteFreq, transport.secondsPerBeat * 2, noteTime, harmSub, vol);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §16  VINYL HISS (AMBIENT TEXTURE)
  // ════════════════════════════════════════════════════════════════════

  function startVinylHiss() {
    if (vinylSource) return;

    // Stereo brown noise (random walk) — 5 second buffer
    var bufferSize = ctx.sampleRate * 5;
    var buffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      var lastOut = 0;
      for (var i = 0; i < bufferSize; i++) {
        var white = rng() * 2 - 1;
        lastOut = (lastOut + 0.02 * white) / 1.02;
        data[i] = lastOut * 3.5;
      }
    }

    vinylSource = ctx.createBufferSource();
    vinylSource.buffer = buffer;
    vinylSource.loop = true;

    vinylFilter = ctx.createBiquadFilter();
    vinylFilter.type = 'lowpass';
    vinylFilter.frequency.value = 1200;
    vinylFilter.Q.value = 0.5;

    // Slow LFO modulating vinyl filter cutoff — breathing movement
    vinylLFO = ctx.createOscillator();
    vinylLFO.type = 'sine';
    vinylLFO.frequency.value = 0.08;
    vinylLFOGain = ctx.createGain();
    vinylLFOGain.gain.value = 400;
    vinylLFO.connect(vinylLFOGain);
    vinylLFOGain.connect(vinylFilter.frequency);
    vinylLFO.start();

    vinylGain = ctx.createGain();
    vinylGain.gain.value = tensionVinylGain * hissUserLevel * 2;

    vinylSource.connect(vinylFilter);
    vinylFilter.connect(vinylGain);
    vinylGain.connect(ambientSub);
    vinylSource.start();
  }

  function stopVinylHiss() {
    if (vinylLFO) {
      try { vinylLFO.stop(); } catch (e) { /* ignore */ }
      vinylLFO.disconnect();
      vinylLFO = null;
    }
    if (vinylLFOGain) {
      vinylLFOGain.disconnect();
      vinylLFOGain = null;
    }
    if (vinylSource) {
      try { vinylSource.stop(); } catch (e) { /* ignore */ }
      vinylSource.disconnect();
      vinylSource = null;
    }
    if (vinylGain) {
      vinylGain.disconnect();
      vinylGain = null;
    }
    if (vinylFilter) {
      vinylFilter.disconnect();
      vinylFilter = null;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §17  SCENE-SPECIFIC AMBIENT TEXTURES
  // ════════════════════════════════════════════════════════════════════

  var AMBIENT_CONFIGS = {
    workshop:      { gain: 0.02,  label: 'keyboard clicks' },
    library:       { gain: 0.01,  label: 'page turns' },
    garden:        { gain: 0.015, label: 'bird chirps + breeze' },
    waterfront:    { gain: 0.04,  label: '3-layer water' },
    cave:          { gain: 0.02,  label: 'drips + echo' },
    winterLodge:   { gain: 0.035, label: 'fire crackle pops' },
    harvestField:  { gain: 0.03,  label: 'crickets + wind' },
    cliffOverlook: { gain: 0.05,  label: 'dual-LFO wind gusts' },
  };

  // Per-scene ambient gain multipliers — one-line tuning knob per scene.
  // Multiplied with ambientLevel (master ambient volume) for final gain.
  var SCENE_AMBIENT_GAINS = {
    garden: 0.8,        // birds are delicate
    cave: 1.0,          // drips are sparse, need presence
    winterLodge: 0.9,   // crackle should be warm, not aggressive
    waterfront: 1.0,    // 3-layer water is already balanced internally
    harvestField: 0.7,  // crickets can get annoying, keep subtle
    cliffOverlook: 0.8, // wind shouldn't mask melody
    library: 1.2,       // page turns are too quiet, boost slightly
    workshop: 0.6,      // clicks should be barely there
  };

  /** Compute effective gain for a scene ambient value.
   *  Applies scene multiplier + master ambient level. */
  function ambientGainFor(sceneName, baseGain) {
    var sceneMult = SCENE_AMBIENT_GAINS[sceneName] || 1.0;
    return baseGain * sceneMult * ambientLevel;
  }

  // ── Ambient helpers ──────────────────────────────────────────────

  /** Create a brown noise buffer (random walk, normalized). */
  function createBrownNoiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var white = rng() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5; // normalize
    }
    return buf;
  }

  /** Create a pink noise buffer using Paul Kellet's algorithm. */
  function createPinkNoiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < len; i++) {
      var white = rng() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buf;
  }

  /** Create a white noise buffer. */
  function createWhiteNoiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      d[i] = rng() * 2 - 1;
    }
    return buf;
  }

  /** Track a node for cleanup. Returns the node for chaining. */
  function trackNode(node) {
    ambientNodes.push(node);
    return node;
  }

  /** Create a looped noise source connected to ambientSub, applying gain + DC blocker. */
  function createAmbientNoiseLayer(buffer, filterType, freq, Q, gain) {
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    trackNode(src);

    var filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = freq;
    filt.Q.value = Q;
    trackNode(filt);

    var g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 2);
    trackNode(g);

    var dc = ctx.createBiquadFilter();
    dc.type = 'highpass';
    dc.frequency.value = 20;
    dc.Q.value = 0.7;
    trackNode(dc);

    src.connect(filt);
    filt.connect(g);
    g.connect(dc);
    dc.connect(ambientSub);
    src.start();
    return { source: src, filter: filt, gain: g };
  }

  /**
   * Schedule a repeating ambient event using setTimeout + Web Audio clock.
   * Returns nothing — stores timer IDs in ambientScheduledIds for cleanup.
   * intervalMin/intervalMax in seconds. callback receives (ctx.currentTime).
   */
  function scheduleAmbientLoop(intervalMin, intervalMax, callback) {
    function tick() {
      if (!ctx || !currentAmbientScene) return;
      callback(ctx.currentTime);
      var next = (intervalMin + rng() * (intervalMax - intervalMin)) * 1000;
      var id = setTimeout(tick, next);
      ambientScheduledIds.push(id);
    }
    var firstDelay = (intervalMin + rng() * (intervalMax - intervalMin)) * 1000;
    var id = setTimeout(tick, firstDelay);
    ambientScheduledIds.push(id);
  }

  // ── Scene-specific synthesis ─────────────────────────────────────

  /** Garden: FM bird chirps + gentle wind rustle */
  function startGardenAmbient() {
    var sceneRoot = SCENE_MUSIC.garden.root;
    var scale = SCALES[SCENE_MUSIC.garden.scale];
    var ag = function (v) { return ambientGainFor('garden', v); };

    // Wind rustle layer — brown noise, lowpass 800Hz, very quiet
    createAmbientNoiseLayer(createBrownNoiseBuffer(5), 'lowpass', 800, 0.7, ag(0.008));

    // FM bird chirps: 2-5 note chirps every 5-15 seconds
    scheduleAmbientLoop(5, 15, function (now) {
      var noteCount = 2 + Math.floor(rng() * 4); // 2-5 notes
      for (var i = 0; i < noteCount; i++) {
        var degree = Math.floor(rng() * scale.length);
        var midi = sceneRoot + scale[degree] + (rng() < 0.5 ? 12 : 24);
        var carrierFreq = midiToFreq(midi);
        var chirpStart = now + i * (0.06 + rng() * 0.1);
        var chirpDur = 0.05 + rng() * 0.15; // 50-200ms

        // FM carrier
        var carrier = ctx.createOscillator();
        carrier.type = 'sine';
        carrier.frequency.setValueAtTime(carrierFreq, chirpStart);
        // Frequency sweep up
        carrier.frequency.linearRampToValueAtTime(
          carrierFreq * (1.1 + rng() * 0.3), chirpStart + chirpDur
        );
        trackNode(carrier);

        // FM modulator
        var mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = carrierFreq * (2 + rng() * 3);
        trackNode(mod);

        var modGain = ctx.createGain();
        modGain.gain.setValueAtTime(carrierFreq * 0.5, chirpStart);
        modGain.gain.exponentialRampToValueAtTime(0.01, chirpStart + chirpDur);
        trackNode(modGain);

        mod.connect(modGain);
        modGain.connect(carrier.frequency);

        // Chirp envelope — peak 0.03 (delicate, not jarring)
        var env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, chirpStart);
        env.gain.linearRampToValueAtTime(ag(0.03), chirpStart + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, chirpStart + chirpDur);
        trackNode(env);

        carrier.connect(env);
        env.connect(ambientSub);

        carrier.start(chirpStart);
        carrier.stop(chirpStart + chirpDur + 0.01);
        mod.start(chirpStart);
        mod.stop(chirpStart + chirpDur + 0.01);
      }
    });
  }

  /** Cave: brown noise drips with echo */
  function startCaveAmbient() {
    var ag = function (v) { return ambientGainFor('cave', v); };

    // Very quiet cave reverb bed — brown noise, bandpass 800Hz
    createAmbientNoiseLayer(createBrownNoiseBuffer(5), 'bandpass', 800, 0.5, ag(0.005));

    // Feedback delay for echo effect
    var echoDelay = ctx.createDelay(1.0);
    echoDelay.delayTime.value = 0.3;
    trackNode(echoDelay);

    var echoFeedback = ctx.createGain();
    echoFeedback.gain.value = 0.3;
    trackNode(echoFeedback);

    var echoFilter = ctx.createBiquadFilter();
    echoFilter.type = 'lowpass';
    echoFilter.frequency.value = 2000;
    trackNode(echoFilter);

    var echoOut = ctx.createGain();
    echoOut.gain.value = ag(0.35);  // reduced from 0.6 — echo should support, not dominate
    trackNode(echoOut);

    echoDelay.connect(echoFeedback);
    echoFeedback.connect(echoFilter);
    echoFilter.connect(echoDelay); // feedback loop
    echoDelay.connect(echoOut);
    echoOut.connect(ambientSub);

    // Drip events: short noise bursts every 3-8 seconds
    scheduleAmbientLoop(3, 8, function (now) {
      var dripDur = 0.02 + rng() * 0.03; // 20-50ms
      var len = Math.floor(ctx.sampleRate * dripDur);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        d[i] = (rng() * 2 - 1) * Math.exp(-i / (len * 0.15));
      }

      var src = ctx.createBufferSource();
      src.buffer = buf;
      trackNode(src);

      var bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 2000 + rng() * 3000;
      bandpass.Q.value = 2;
      trackNode(bandpass);

      var dripGain = ctx.createGain();
      dripGain.gain.setValueAtTime(ag(0.025), now);
      dripGain.gain.exponentialRampToValueAtTime(0.0001, now + dripDur + 0.1);
      trackNode(dripGain);

      src.connect(bandpass);
      bandpass.connect(dripGain);
      dripGain.connect(ambientSub);
      dripGain.connect(echoDelay); // feed into echo
      src.start(now);
    });
  }

  /** Winter Lodge: individual fire crackle pops */
  function startWinterLodgeAmbient() {
    var ag = function (v) { return ambientGainFor('winterLodge', v); };

    // Warm base — brown noise, lowpass 400Hz
    var base = createAmbientNoiseLayer(createBrownNoiseBuffer(5), 'lowpass', 400, 0.8, ag(0.012));
    // Expose for fireplace sync (checkFireplaceSync reads ambientTextureGain)
    ambientTextureGain = base.gain;

    // Crackle pops: short noise bursts every 0.5-2 seconds
    scheduleAmbientLoop(0.5, 2, function (now) {
      var popDur = 0.015 + rng() * 0.025; // 15-40ms
      var len = Math.floor(ctx.sampleRate * popDur);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        d[i] = (rng() * 2 - 1) * Math.exp(-i / (len * 0.2));
      }

      var src = ctx.createBufferSource();
      src.buffer = buf;
      trackNode(src);

      var bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1500 + rng() * 2500; // 1500-4000Hz
      bandpass.Q.value = 1.5 + rng() * 2;
      trackNode(bandpass);

      var popGain = ctx.createGain();
      popGain.gain.setValueAtTime(ag(0.01 + rng() * 0.02), now);  // 0.01-0.03 (warm clicks, not aggressive)
      popGain.gain.exponentialRampToValueAtTime(0.0001, now + popDur + 0.05);
      trackNode(popGain);

      src.connect(bandpass);
      bandpass.connect(popGain);
      popGain.connect(ambientSub);
      src.start(now);
    });
  }

  /** Waterfront: 3-layer water synthesis */
  function startWaterfrontAmbient() {
    var ag = function (v) { return ambientGainFor('waterfront', v); };

    // Layer 1: deep rumble — brown noise, lowpass 200Hz
    var rumble = createAmbientNoiseLayer(
      createBrownNoiseBuffer(5), 'lowpass', 200, 0.6, ag(0.02)
    );
    // Slow LFO on rumble gain
    var lfo1 = ctx.createOscillator();
    lfo1.type = 'sine';
    lfo1.frequency.value = 0.08;
    trackNode(lfo1);
    var lfo1Gain = ctx.createGain();
    lfo1Gain.gain.value = 0.008;
    trackNode(lfo1Gain);
    lfo1.connect(lfo1Gain);
    lfo1Gain.connect(rumble.gain.gain);
    lfo1.start();

    // Layer 2: burble — pink noise, bandpass 800Hz
    var burble = createAmbientNoiseLayer(
      createPinkNoiseBuffer(5), 'bandpass', 800, 1.2, ag(0.015)
    );
    var lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.12;
    trackNode(lfo2);
    var lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 0.006;
    trackNode(lfo2Gain);
    lfo2.connect(lfo2Gain);
    lfo2Gain.connect(burble.gain.gain);
    lfo2.start();

    // Layer 3: sparkle — white noise, highpass 3000Hz
    var sparkle = createAmbientNoiseLayer(
      createWhiteNoiseBuffer(5), 'highpass', 3000, 0.5, ag(0.005)
    );
    var lfo3 = ctx.createOscillator();
    lfo3.type = 'sine';
    lfo3.frequency.value = 0.18;
    trackNode(lfo3);
    var lfo3Gain = ctx.createGain();
    lfo3Gain.gain.value = 0.003;
    trackNode(lfo3Gain);
    lfo3.connect(lfo3Gain);
    lfo3Gain.connect(sparkle.gain.gain);
    lfo3.start();
  }

  /** Harvest Field: cricket chirps + gentle wind */
  function startHarvestFieldAmbient() {
    var ag = function (v) { return ambientGainFor('harvestField', v); };

    // Wind layer — brown noise, bandpass 600Hz
    createAmbientNoiseLayer(createBrownNoiseBuffer(5), 'bandpass', 600, 0.8, ag(0.01));

    // Cricket chirps: AM synthesis clusters every 4-10 seconds
    scheduleAmbientLoop(4, 10, function (now) {
      var carrierFreq = 1800 + rng() * 400; // 1800-2200Hz
      var chirpDur = 0.15;
      var clusterNotes = 2 + Math.floor(rng() * 3); // 2-4 chirps in cluster

      for (var c = 0; c < clusterNotes; c++) {
        var t = now + c * (0.18 + rng() * 0.05);

        // Carrier oscillator
        var carrier = ctx.createOscillator();
        carrier.type = 'sine';
        carrier.frequency.value = carrierFreq + rng() * 50;
        trackNode(carrier);

        // AM modulator — square wave at 15-20Hz
        var modFreq = 15 + rng() * 5;
        var amMod = ctx.createOscillator();
        amMod.type = 'square';
        amMod.frequency.value = modFreq;
        trackNode(amMod);

        // AM depth control
        var amGain = ctx.createGain();
        amGain.gain.value = 0.5;
        trackNode(amGain);

        // Carrier gain (AM target)
        var carrierGain = ctx.createGain();
        carrierGain.gain.setValueAtTime(0.5, t);
        trackNode(carrierGain);

        amMod.connect(amGain);
        amGain.connect(carrierGain.gain);
        carrier.connect(carrierGain);

        // Chirp envelope — peak 0.015 (subtle background texture)
        var chirpPeak = ag(0.015);
        var env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(chirpPeak, t + 0.01);
        env.gain.setValueAtTime(chirpPeak, t + chirpDur - 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, t + chirpDur);
        trackNode(env);

        carrierGain.connect(env);
        env.connect(ambientSub);

        carrier.start(t);
        carrier.stop(t + chirpDur + 0.01);
        amMod.start(t);
        amMod.stop(t + chirpDur + 0.01);
      }
    });
  }

  /** Cliff Overlook: dual-LFO wind gusts */
  function startCliffOverlookAmbient() {
    var ag = function (v) { return ambientGainFor('cliffOverlook', v); };
    var sceneRoot = SCENE_MUSIC.cliffOverlook.root;
    var resonantFreq = midiToFreq(sceneRoot) * 0.25; // sub-harmonic resonance

    // Wind base — brown noise through bandpass
    var brownBuf = createBrownNoiseBuffer(5);
    var src = ctx.createBufferSource();
    src.buffer = brownBuf;
    src.loop = true;
    trackNode(src);

    var bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 600;
    bandpass.Q.value = 0.5;
    trackNode(bandpass);

    var windGain = ctx.createGain();
    windGain.gain.value = ag(0.03);  // reduced from 0.035 — gentle presence, not masking melody
    trackNode(windGain);

    var dc = ctx.createBiquadFilter();
    dc.type = 'highpass';
    dc.frequency.value = 20;
    dc.Q.value = 0.7;
    trackNode(dc);

    src.connect(bandpass);
    bandpass.connect(windGain);
    windGain.connect(dc);
    dc.connect(ambientSub);
    src.start();

    // Slow LFO — large gusts (0.05Hz, period ~20s)
    var slowLFO = ctx.createOscillator();
    slowLFO.type = 'sine';
    slowLFO.frequency.value = 0.05 + rng() * 0.02; // slight randomization
    trackNode(slowLFO);
    var slowDepth = ctx.createGain();
    slowDepth.gain.value = ag(0.015);  // reduced from 0.02
    trackNode(slowDepth);
    slowLFO.connect(slowDepth);
    slowDepth.connect(windGain.gain);
    slowLFO.start();

    // Fast LFO — whistling (0.3Hz)
    var fastLFO = ctx.createOscillator();
    fastLFO.type = 'sine';
    fastLFO.frequency.value = 0.3 + rng() * 0.1; // independent rate
    trackNode(fastLFO);
    var fastDepth = ctx.createGain();
    fastDepth.gain.value = ag(0.008);
    trackNode(fastDepth);
    fastLFO.connect(fastDepth);
    fastDepth.connect(windGain.gain);
    fastLFO.start();

    // Slow filter sweep for tonal variation
    var filterLFO = ctx.createOscillator();
    filterLFO.type = 'sine';
    filterLFO.frequency.value = 0.03;
    trackNode(filterLFO);
    var filterDepth = ctx.createGain();
    filterDepth.gain.value = 200;
    trackNode(filterDepth);
    filterLFO.connect(filterDepth);
    filterDepth.connect(bandpass.frequency);
    filterLFO.start();
  }

  /** Library: quiet page-turn sounds */
  function startLibraryAmbient() {
    var ag = function (v) { return ambientGainFor('library', v); };

    // Page turns: bandpass noise 2000-4000Hz, 100ms, every 10-20 seconds
    scheduleAmbientLoop(10, 20, function (now) {
      var turnDur = 0.1;
      var len = Math.floor(ctx.sampleRate * turnDur);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        d[i] = (rng() * 2 - 1) * Math.exp(-i / (len * 0.3));
      }

      var src = ctx.createBufferSource();
      src.buffer = buf;
      trackNode(src);

      var bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 2000 + rng() * 2000; // 2000-4000Hz
      bandpass.Q.value = 0.8;
      trackNode(bandpass);

      var turnGain = ctx.createGain();
      turnGain.gain.setValueAtTime(ag(0.012), now);  // boosted from 0.008 — page turns were inaudible
      turnGain.gain.exponentialRampToValueAtTime(0.0001, now + turnDur + 0.05);
      trackNode(turnGain);

      src.connect(bandpass);
      bandpass.connect(turnGain);
      turnGain.connect(ambientSub);
      src.start(now);
    });
  }

  /** Workshop: subtle keyboard clicks */
  function startWorkshopAmbient() {
    var ag = function (v) { return ambientGainFor('workshop', v); };

    // Mechanical hum base — very quiet brown noise, lowpass 200Hz
    createAmbientNoiseLayer(createBrownNoiseBuffer(5), 'lowpass', 200, 1.0, ag(0.008));

    // Keyboard clicks: highpass noise at 4000Hz, 10-20ms, every 2-4 seconds
    scheduleAmbientLoop(2, 4, function (now) {
      var clickDur = 0.01 + rng() * 0.01; // 10-20ms
      var len = Math.floor(ctx.sampleRate * clickDur);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        d[i] = (rng() * 2 - 1) * Math.exp(-i / (len * 0.25));
      }

      var src = ctx.createBufferSource();
      src.buffer = buf;
      trackNode(src);

      var highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 4000;
      highpass.Q.value = 1.0;
      trackNode(highpass);

      var clickGain = ctx.createGain();
      clickGain.gain.setValueAtTime(ag(0.008), now);  // reduced from 0.015 — barely there
      clickGain.gain.exponentialRampToValueAtTime(0.0001, now + clickDur + 0.02);
      trackNode(clickGain);

      src.connect(highpass);
      highpass.connect(clickGain);
      clickGain.connect(ambientSub);
      src.start(now);
    });
  }

  // ── Stop / Start API ─────────────────────────────────────────────

  function stopAmbientTexture() {
    // Clear all scheduled ambient event timers
    for (var t = 0; t < ambientScheduledIds.length; t++) {
      clearTimeout(ambientScheduledIds[t]);
    }
    ambientScheduledIds = [];

    if (ambientCrackleTimer) {
      clearInterval(ambientCrackleTimer);
      ambientCrackleTimer = null;
    }

    // Disconnect and release all tracked ambient nodes
    for (var n = 0; n < ambientNodes.length; n++) {
      try {
        if (ambientNodes[n].stop) ambientNodes[n].stop();
      } catch (e) { /* already stopped */ }
      try {
        ambientNodes[n].disconnect();
      } catch (e) { /* already disconnected */ }
    }
    ambientNodes = [];

    // Legacy node cleanup (kept for crossfadeAmbient compatibility)
    if (ambientTextureSource) {
      try { ambientTextureSource.stop(); } catch (e) { /* ignore */ }
      ambientTextureSource.disconnect();
      ambientTextureSource = null;
    }
    if (ambientTextureGain) {
      ambientTextureGain.disconnect();
      ambientTextureGain = null;
    }
    if (ambientTextureFilter) {
      ambientTextureFilter.disconnect();
      ambientTextureFilter = null;
    }
    if (ambientDCBlocker) {
      ambientDCBlocker.disconnect();
      ambientDCBlocker = null;
    }
    currentAmbientScene = null;
  }

  function startAmbientTexture(sceneName) {
    if (currentAmbientScene === sceneName) return;
    stopAmbientTexture();

    var config = AMBIENT_CONFIGS[sceneName];
    if (!config) return;

    currentAmbientScene = sceneName;

    // Dispatch to scene-specific synthesis
    switch (sceneName) {
      case 'garden':        startGardenAmbient();        break;
      case 'cave':          startCaveAmbient();          break;
      case 'winterLodge':   startWinterLodgeAmbient();   break;
      case 'waterfront':    startWaterfrontAmbient();     break;
      case 'harvestField':  startHarvestFieldAmbient();   break;
      case 'cliffOverlook': startCliffOverlookAmbient(); break;
      case 'library':       startLibraryAmbient();        break;
      case 'workshop':      startWorkshopAmbient();       break;
    }
  }

  function crossfadeAmbient(sceneName) {
    // Fade out old texture over 1.5s, then start new one
    if (ambientTextureGain && ctx) {
      var now = ctx.currentTime;
      ambientTextureGain.gain.linearRampToValueAtTime(0, now + 1.5);
    }
    setTimeout(function () {
      stopAmbientTexture();
      if (ctx && transport.isPlaying) {
        startAmbientTexture(sceneName);
      }
    }, 1600);
  }

  // ════════════════════════════════════════════════════════════════════
  // §18  SCENE TRANSITIONS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Transition music to a new scene over ~4 bars.
   * Phase 0 (bars 1-2): fade melody volume to 0
   * Phase 1 (bar 3): silence, crossfade ambient textures
   * Phase 2 (bar 4): new key/scale/tempo, fade melody back in
   */
  function setScene(sceneName) {
    if (!SCENE_MUSIC[sceneName]) return;
    if (sceneName === currentSceneName && !transitioning) return;

    var config = SCENE_MUSIC[sceneName];

    transitioning = true;
    transitionTarget = config;
    transitionBarsRemaining = 4;
    transitionPhase = 0;

    // Begin crossfading ambient texture immediately
    crossfadeAmbient(sceneName);

    currentSceneName = sceneName;
  }

  function handleTransitionBeat(time, beat, bar) {
    if (!transitionTarget) return;

    var barsLeft = transitionBarsRemaining;
    var melodyUserGain = SUBMIX_BASE_GAINS.melody * userMelodyLevel;

    if (barsLeft > 2) {
      // Phase 0: fading out melody
      transitionPhase = 0;
      if (melodySub) {
        var fadeVal = Math.max(0.05, (barsLeft - 2) / 2 * melodyUserGain);
        melodySub.gain.linearRampToValueAtTime(fadeVal, time + 0.1);
      }
    } else if (barsLeft === 2) {
      // Phase 1: silence — apply new key/scale
      transitionPhase = 1;
      if (beat === 0) {
        currentRoot = transitionTarget.root;
        currentScale = transitionTarget.scale;
        currentInstrument = transitionTarget.instrument;
        currentFilterFreq = transitionTarget.filter;

        // Reset melody state for new scale
        melodyState = 0;
        lastTwoNotes = [currentRoot, currentRoot];

        // Pick fresh progression for new key
        pickNewProgression();

        // Tempo glide
        var targetTempo = transitionTarget.tempo + tensionTempoOffset;
        transport.tempo = transport.tempo + (targetTempo - transport.tempo) * 0.5;

        if (melodySub) {
          melodySub.gain.linearRampToValueAtTime(0.02, time + 0.1);
        }
      }
    } else if (barsLeft === 1) {
      // Phase 2: fade melody back in
      transitionPhase = 2;
      if (melodySub) {
        melodySub.gain.linearRampToValueAtTime(melodyUserGain, time + transport.secondsPerBeat * 3);
      }
      // Finalize tempo
      transport.tempo = transitionTarget.tempo + tensionTempoOffset;
    }
  }

  function finishTransition() {
    transitioning = false;
    transitionTarget = null;
    transitionPhase = 0;
    transitionBarsRemaining = 0;

    // Ensure submix levels are restored (respecting user mixer levels)
    if (melodySub) melodySub.gain.value = SUBMIX_BASE_GAINS.melody * userMelodyLevel;

    // Update lowpass rolloff for new scene
    if (lowpassRolloff) {
      lowpassRolloff.frequency.value = Math.min(currentFilterFreq * tensionFilterMult, 12000);
    }

    // Glide pad voices to new chord
    if (currentChordNotes) {
      playPadChord(currentChordNotes, ctx.currentTime, 3);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §19  TENSION REACTIVITY
  // ════════════════════════════════════════════════════════════════════

  var TENSION_PARAMS = [
    // 0: calm
    { tempoOffset: -5,  restProb: 0.30, filterMult: 0.72, reverbWet: 0.35, vinylGain: 0.05, drumLevel: 0 },
    // 1: normal
    { tempoOffset: 0,   restProb: 0.20, filterMult: 1.0,  reverbWet: 0.25, vinylGain: 0.03, drumLevel: 1 },
    // 2: tense
    { tempoOffset: 8,   restProb: 0.10, filterMult: 1.4,  reverbWet: 0.18, vinylGain: 0.015, drumLevel: 2 },
    // 3: crisis
    { tempoOffset: 15,  restProb: 0.05, filterMult: 2.0,  reverbWet: 0.10, vinylGain: 0.0,  drumLevel: 3 },
    // 4: siege
    { tempoOffset: -15, restProb: 0.25, filterMult: 0.48, reverbWet: 0.40, vinylGain: 0.06, drumLevel: 0 },
  ];

  /** Lerp helper for smooth parameter transitions */
  function lerpTo(current, target, speed) {
    return current + (target - current) * speed;
  }

  var tensionLerpTimer = null;

  function setTension(level) {
    level = Math.max(0, Math.min(4, Math.floor(level)));
    if (level === currentTension) return;

    currentTension = level;
    var params = TENSION_PARAMS[level];

    var targetTempoOffset = params.tempoOffset;
    var targetRestProb = params.restProb;
    var targetFilterMult = params.filterMult;
    var targetReverbWet = params.reverbWet;
    var targetVinylGain = params.vinylGain;
    var targetDrumLevel = params.drumLevel;

    // Lerp over ~2 seconds (40 steps * 50ms)
    var steps = 40;
    var step = 0;

    var startTempoOffset = tensionTempoOffset;
    var startRestProb = restProbability;
    var startFilterMult = tensionFilterMult;
    var startReverbWet = wetGain ? wetGain.gain.value : 0.25;
    var startVinylGain = vinylGain ? vinylGain.gain.value : 0.03;

    if (tensionLerpTimer) clearInterval(tensionLerpTimer);

    tensionLerpTimer = setInterval(function () {
      step++;
      var t = step / steps;
      // Ease in-out
      var ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      tensionTempoOffset = startTempoOffset + (targetTempoOffset - startTempoOffset) * ease;
      restProbability = startRestProb + (targetRestProb - startRestProb) * ease;
      tensionFilterMult = startFilterMult + (targetFilterMult - startFilterMult) * ease;

      // Update audio nodes
      if (wetGain) {
        var newWet = startReverbWet + (targetReverbWet - startReverbWet) * ease;
        wetGain.gain.value = newWet;
        if (dryGain) dryGain.gain.value = 1.0 - newWet;
      }
      if (vinylGain) {
        var lerpedVinyl = startVinylGain + (targetVinylGain - startVinylGain) * ease;
        vinylGain.gain.value = lerpedVinyl * hissUserLevel * 2;
      }
      if (lowpassRolloff) {
        lowpassRolloff.frequency.value = Math.min(
          currentFilterFreq * tensionFilterMult, 12000
        );
      }

      // Update tempo
      var sceneTempo = SCENE_MUSIC[currentSceneName] ? SCENE_MUSIC[currentSceneName].tempo : 75;
      transport.tempo = sceneTempo + tensionTempoOffset;

      if (step >= steps) {
        clearInterval(tensionLerpTimer);
        tensionLerpTimer = null;
        // Snap drum level (discrete, not lerped)
        tensionDrumLevel = targetDrumLevel;
        tensionVinylGain = targetVinylGain;
      }
    }, 50);

    // Drum level changes partway through
    setTimeout(function () {
      tensionDrumLevel = targetDrumLevel;
    }, 1000);
  }

  // ════════════════════════════════════════════════════════════════════
  // §20  TIME OF DAY
  // ════════════════════════════════════════════════════════════════════

  var TIME_OF_DAY_PARAMS = {
    dawn:  { filterBrightness: 0.85, registerShift: -2, padFilterMult: 0.9 },
    day:   { filterBrightness: 1.0,  registerShift: 0,  padFilterMult: 1.0 },
    dusk:  { filterBrightness: 0.75, registerShift: -1, padFilterMult: 0.8 },
    night: { filterBrightness: 0.6,  registerShift: -3, padFilterMult: 0.65 },
  };

  function setTimeOfDay(phase) {
    var params = TIME_OF_DAY_PARAMS[phase];
    if (!params) return;

    currentTimeOfDay = phase;

    // Adjust master lowpass for brightness
    if (lowpassRolloff && ctx) {
      var baseFreq = currentFilterFreq * tensionFilterMult;
      var targetFreq = Math.min(baseFreq * params.filterBrightness, 12000);
      lowpassRolloff.frequency.linearRampToValueAtTime(targetFreq, ctx.currentTime + 2);
    }

    // Adjust pad filter for warmth
    for (var i = 0; i < padVoices.length; i++) {
      if (padVoices[i] && padVoices[i].filter && ctx) {
        var padTarget = 2500 * params.padFilterMult;
        padVoices[i].filter.frequency.linearRampToValueAtTime(padTarget, ctx.currentTime + 2);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §21  EVENT STINGERS
  // ════════════════════════════════════════════════════════════════════

  function onEvent(eventName, data) {
    if (!ctx || !transport.isPlaying) return;
    var now = ctx.currentTime;

    switch (eventName) {

      case 'taskResolve':
        // Ascending 3-note chime (KS plucks)
        playKS(midiToFreq(currentRoot + 7), 0.5, now, melodySub, 0.35);
        playKS(midiToFreq(currentRoot + 12), 0.5, now + 0.15, melodySub, 0.30);
        playKS(midiToFreq(currentRoot + 16), 0.5, now + 0.30, melodySub, 0.25);
        break;

      case 'taskFail':
        // Descending minor second
        playKS(midiToFreq(currentRoot + 5), 0.6, now, melodySub, 0.3);
        playKS(midiToFreq(currentRoot + 4), 0.8, now + 0.25, melodySub, 0.25);
        break;

      case 'gatoSpawn': {
        // Soft purr sweep: low sine with gentle vibrato
        var purr = ctx.createOscillator();
        purr.type = 'sine';
        purr.frequency.value = 35;

        var purrVibrato = ctx.createOscillator();
        purrVibrato.type = 'sine';
        purrVibrato.frequency.value = 6; // 6Hz vibrato
        var purrVibratoGain = ctx.createGain();
        purrVibratoGain.gain.value = 3; // +/- 3Hz modulation
        purrVibrato.connect(purrVibratoGain);
        purrVibratoGain.connect(purr.frequency);
        purrVibrato.start(now);
        purrVibrato.stop(now + 2.1);

        var purrGain = ctx.createGain();
        purrGain.gain.setValueAtTime(0, now);
        purrGain.gain.linearRampToValueAtTime(0.02, now + 0.3);
        purrGain.gain.linearRampToValueAtTime(0, now + 2);
        purr.connect(purrGain);
        purrGain.connect(ambientSub);
        purr.start(now);
        purr.stop(now + 2.1);
        break;
      }

      case 'goldenHour':
        // Ethereal pad swell: wide chord, long fade
        playPadChord(
          [currentRoot, currentRoot + 7, currentRoot + 12, currentRoot + 19],
          now, 10
        );
        // Also a gentle high shimmer
        playKS(midiToFreq(currentRoot + 24), 3, now + 0.5, harmSub, 0.08);
        playKS(midiToFreq(currentRoot + 31), 3, now + 1.0, harmSub, 0.06);
        break;

      case 'nightfall':
        // Low drone + descending notes
        playPadChord(
          [currentRoot - 12, currentRoot - 5, currentRoot, currentRoot + 7],
          now, 8
        );
        break;

      case 'agentJoin': {
        // Welcome chime: two rising notes
        playKS(midiToFreq(currentRoot + 4), 0.4, now, melodySub, 0.2);
        playKS(midiToFreq(currentRoot + 7), 0.4, now + 0.12, melodySub, 0.2);
        break;
      }

      case 'agentLeave': {
        // Farewell: descending two notes
        playKS(midiToFreq(currentRoot + 7), 0.5, now, melodySub, 0.15);
        playKS(midiToFreq(currentRoot + 4), 0.5, now + 0.2, melodySub, 0.15);
        break;
      }

      case 'messageReceived': {
        // Subtle click/tick
        var clickBuf = ctx.createBuffer(1, 64, ctx.sampleRate);
        var clickData = clickBuf.getChannelData(0);
        for (var ci = 0; ci < 64; ci++) {
          clickData[ci] = (rng() * 2 - 1) * Math.exp(-ci / 8);
        }
        var clickSrc = ctx.createBufferSource();
        clickSrc.buffer = clickBuf;
        var clickGain = ctx.createGain();
        clickGain.gain.value = 0.06;
        clickSrc.connect(clickGain);
        clickGain.connect(melodySub);
        clickSrc.start(now);
        break;
      }

      case 'discovery': {
        // Sparkle: rapid ascending pentatonic arpeggio
        var scale = SCALES[currentScale] || SCALES.minorPentatonic;
        for (var di = 0; di < scale.length; di++) {
          var sparkleFreq = midiToFreq(currentRoot + scale[di] + 12);
          playKS(sparkleFreq, 0.3, now + di * 0.06, melodySub, 0.15);
        }
        break;
      }

      case 'error': {
        // Dissonant buzz
        var errOsc = ctx.createOscillator();
        errOsc.type = 'sawtooth';
        errOsc.frequency.value = midiToFreq(currentRoot + 1); // minor 2nd = dissonance
        var errGain = ctx.createGain();
        errGain.gain.setValueAtTime(0.08, now);
        errGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        var errFilter = ctx.createBiquadFilter();
        errFilter.type = 'lowpass';
        errFilter.frequency.value = 1500;
        errOsc.connect(errFilter);
        errFilter.connect(errGain);
        errGain.connect(melodySub);
        errOsc.start(now);
        errOsc.stop(now + 0.35);
        break;
      }

      default:
        // Unknown event — no sound
        break;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §22  INITIALIZATION & LIFECYCLE
  // ════════════════════════════════════════════════════════════════════

  function initializeInstruments() {
    initFMVoices();
    initPadVoices();
    ksBufferCache = {};
    ksActiveCount = 0;
  }

  function initializeMusicState() {
    var sceneConfig = SCENE_MUSIC[currentSceneName] || SCENE_MUSIC.workshop;
    currentRoot = sceneConfig.root;
    currentScale = sceneConfig.scale;
    currentInstrument = sceneConfig.instrument;
    currentFilterFreq = sceneConfig.filter;
    transport.tempo = sceneConfig.tempo;

    melodyState = 0;
    lastTwoNotes = [currentRoot, currentRoot];
    restProbability = 0.20;

    // Reset Markov temperature
    markovTemperature = 1.0;

    // Reset L-system
    lSystem.current = lSystem.axiom;
    lSystem.generation = 0;
    lSystem.position = 0;

    // Reset submix fadeout tracking
    fadedSubmixName = null;
    fadedSubmixOrigGain = 0;
    fadedSubmixRestoreTime = 0;

    // Reset chord progression variety tracking
    usedProgressionKeys = {};
    phrasesSinceProgressionReset = 0;

    pickNewProgression();
    currentChordNotes = buildChordFromDegree(0);

    // Reset tension to normal
    currentTension = 1;
    var params = TENSION_PARAMS[1];
    tensionTempoOffset = params.tempoOffset;
    tensionFilterMult = params.filterMult;
    tensionReverbWet = params.reverbWet;
    tensionVinylGain = params.vinylGain;
    tensionDrumLevel = params.drumLevel;
  }

  function start(seed) {
    // Seed the PRNG
    seed = seed || (Date.now() ^ 0xDEADBEEF);
    _currentSeed = seed;
    mulberry32(seed);

    if (DEBUG_AUDIO) console.log('[Audio] Starting with seed:', seed);

    ensureContext();

    // Handle suspended AudioContext (must be from user gesture)
    if (ctx.state === 'suspended') {
      ctx.resume().then(function () {
        actualStart();
      });
    } else {
      actualStart();
    }
  }

  function actualStart() {
    if (transport.isPlaying) return;

    initializeInstruments();
    initializeMusicState();

    // Start vinyl hiss
    startVinylHiss();

    // Start ambient texture for current scene
    startAmbientTexture(currentSceneName);

    // Play initial pad chord
    if (currentChordNotes) {
      playPadChord(currentChordNotes, ctx.currentTime, 4);
    }

    // Begin transport
    transport.isPlaying = true;
    transport.currentBeat = 0;
    transport.currentBar = 0;
    transport.currentPhrase = 0;
    transport.nextBeatTime = ctx.currentTime + 0.1; // slight offset to allow setup

    // Start the scheduler
    scheduleAhead();
  }

  function stop() {
    if (!ctx) return;

    transport.isPlaying = false;

    // Clear scheduler
    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
    }

    // Clear tension lerp
    if (tensionLerpTimer) {
      clearInterval(tensionLerpTimer);
      tensionLerpTimer = null;
    }

    // Fade master out over 2 seconds
    if (masterGain && ctx.state === 'running') {
      var now = ctx.currentTime;
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(0, now + 2);

      // After fade, clean up
      setTimeout(function () {
        cleanupAll();
      }, 2200);
    } else {
      cleanupAll();
    }
  }

  function cleanupAll() {
    // Stop vinyl hiss
    stopVinylHiss();

    // Stop ambient textures
    stopAmbientTexture();

    // Stop FM voices
    for (var i = 0; i < fmVoices.length; i++) {
      try {
        fmVoices[i].carrier.stop();
        fmVoices[i].modulator.stop();
        fmVoices[i].outputGain.disconnect();
      } catch (e) { /* ignore */ }
    }
    fmVoices = [];

    // Stop pad voices
    for (var j = 0; j < padVoices.length; j++) {
      try {
        padVoices[j].osc1.stop();
        padVoices[j].osc2.stop();
        padVoices[j].mix.disconnect();
      } catch (e) { /* ignore */ }
    }
    padVoices = [];

    // Stop tape wow LFO
    if (tapeWowLFO) {
      try { tapeWowLFO.stop(); } catch (e) { /* ignore */ }
    }

    // Clear KS cache
    ksBufferCache = {};
    ksActiveCount = 0;

    // Reset transition state
    transitioning = false;
    transitionTarget = null;

    // Reset preset state
    currentPreset = null;
    currentRoomSize = 'medium';
    if (presetLerpTimer) {
      clearInterval(presetLerpTimer);
      presetLerpTimer = null;
    }

    // Close context (not just suspend — avoids leaking AudioContext instances)
    if (ctx) {
      try { ctx.close(); } catch (_) { /* already closed */ }
    }

    // Null out all node references so next start() rebuilds from scratch
    masterGain = null;
    melodySub = null;
    harmSub = null;
    bassSub = null;
    ambientSub = null;
    lofiInput = null;
    bitcrusher = null;
    tapeWowDelay = null;
    tapeWowLFO = null;
    tapeWowDepth = null;
    lowpassRolloff = null;
    reverbConvolver = null;
    dryGain = null;
    wetGain = null;
    lofiMerge = null;
    safetyLimiter = null;
    diagnosticAnalyser = null;
    vinylLFO = null;
    vinylLFOGain = null;
    ctx = null;
  }

  // ════════════════════════════════════════════════════════════════════
  // §23  OPTIONAL INTEGRATION — PixelFireplaceMode
  // ════════════════════════════════════════════════════════════════════

  /**
   * If PixelFireplaceMode exists, sync with it:
   * - When fireplace is active, boost winterLodge ambient
   * - Read fireplace intensity to modulate crackle volume
   */
  function checkFireplaceSync() {
    if (typeof window.PixelFireplaceMode === 'undefined') return;
    if (!ambientTextureGain || currentAmbientScene !== 'winterLodge') return;

    var fireplace = window.PixelFireplaceMode;
    if (typeof fireplace.getIntensity === 'function') {
      var intensity = fireplace.getIntensity();
      if (typeof intensity === 'number' && intensity >= 0 && intensity <= 1) {
        var baseGain = ambientGainFor('winterLodge', AMBIENT_CONFIGS.winterLodge.gain);
        ambientTextureGain.gain.value = baseGain * (0.5 + intensity * 1.5);
      }
    }
  }

  // Poll fireplace sync every 2 seconds
  var fireplaceCheckTimer = null;

  function startFireplaceSync() {
    if (fireplaceCheckTimer) return;
    fireplaceCheckTimer = setInterval(checkFireplaceSync, 2000);
  }

  function stopFireplaceSync() {
    if (fireplaceCheckTimer) {
      clearInterval(fireplaceCheckTimer);
      fireplaceCheckTimer = null;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // §24  OPTIONAL INTEGRATION — PixelSceneConfig
  // ════════════════════════════════════════════════════════════════════

  /**
   * If PixelSceneConfig is loaded, we can auto-detect scene transitions.
   * The pixel-agents.js controller should call setScene() directly,
   * but we also check on phrase boundaries as a fallback.
   */
  function checkSceneSync() {
    if (typeof window.PixelSceneConfig === 'undefined') return;
    // No auto-detection needed — the controller calls setScene() directly.
    // This hook is reserved for future cross-module coordination.
  }

  // ════════════════════════════════════════════════════════════════════
  // §25  OPTIONAL INTEGRATION — PixelProgression
  // ════════════════════════════════════════════════════════════════════

  /**
   * If PixelProgression exists, listen for progression events
   * to trigger stingers automatically.
   */
  function checkProgressionSync() {
    if (typeof window.PixelProgression === 'undefined') return;
    // Reserved hook: PixelProgression can call onEvent() directly.
  }

  // ════════════════════════════════════════════════════════════════════
  // §25b  MOOD PRESETS & ROOM SIZE
  // ════════════════════════════════════════════════════════════════════

  /**
   * Smoothly transition to a mood preset over ~2 seconds.
   * Adjusts submix gains, hiss, reverb wet/dry, filter cutoff, and ambient level.
   * @param {string} name - One of: 'warmLofi', 'rainFocus', 'deepNight', 'gardenMorning'
   */
  function setPreset(name) {
    var preset = PRESETS[name];
    if (!preset) return;

    currentPreset = name;

    // Update user mixer levels from preset (derive multiplier from preset / base)
    userMelodyLevel = Math.min(1, preset.melodySub / SUBMIX_BASE_GAINS.melody);
    userHarmonyLevel = Math.min(1, preset.harmSub / SUBMIX_BASE_GAINS.harmony);
    userBassLevel = Math.min(1, preset.bassSub / SUBMIX_BASE_GAINS.bass);

    // Smooth ramp submix gains over 2 seconds
    if (ctx && melodySub) {
      var rampEnd = ctx.currentTime + 2;
      melodySub.gain.linearRampToValueAtTime(SUBMIX_BASE_GAINS.melody * userMelodyLevel, rampEnd);
      harmSub.gain.linearRampToValueAtTime(SUBMIX_BASE_GAINS.harmony * userHarmonyLevel, rampEnd);
      bassSub.gain.linearRampToValueAtTime(SUBMIX_BASE_GAINS.bass * userBassLevel, rampEnd);
    }

    // Smooth ramp reverb wet/dry over 2 seconds
    if (ctx && wetGain && dryGain) {
      var rampEnd2 = ctx.currentTime + 2;
      wetGain.gain.linearRampToValueAtTime(preset.reverbWet, rampEnd2);
      dryGain.gain.linearRampToValueAtTime(1.0 - preset.reverbWet, rampEnd2);
    }

    // Adjust master lowpass filter cutoff (filterMult applied to scene base)
    if (ctx && lowpassRolloff) {
      var baseFilter = currentFilterFreq * tensionFilterMult;
      var targetFreq = Math.min(baseFilter * preset.filterMult, 12000);
      lowpassRolloff.frequency.linearRampToValueAtTime(targetFreq, ctx.currentTime + 2);
    }

    // Set hiss level via the existing mechanism
    hissUserLevel = Math.max(0, Math.min(1, preset.hissLevel));
    if (vinylGain) {
      vinylGain.gain.value = tensionVinylGain * hissUserLevel * 2;
    }

    // Set ambient level via the existing mechanism
    ambientLevel = Math.max(0, Math.min(1, preset.ambientLevel));
    if (ambientSub) {
      ambientSub.gain.value = SUBMIX_BASE_GAINS.ambient * (ambientLevel / 0.7);
    }

    if (DEBUG_AUDIO) console.log('[Audio] Preset applied:', name, preset.label);

    // Dispatch event so mixer UI can update slider positions
    dispatchMixerUpdate();
  }

  /**
   * Regenerate the reverb impulse response for a different room size.
   * Swaps the ConvolverNode buffer in place — no audio glitch.
   * @param {string} size - 'small' | 'medium' | 'large'
   */
  function setRoomSize(size) {
    if (!ROOM_CONFIGS[size]) return;
    currentRoomSize = size;
    if (reverbConvolver && ctx) {
      reverbConvolver.buffer = createReverbIR(size);
      if (DEBUG_AUDIO) console.log('[Audio] Room size changed:', size);
    }
  }

  /** Dispatch a custom event with current mixer levels for the UI to consume. */
  function dispatchMixerUpdate() {
    try {
      document.dispatchEvent(new CustomEvent('audio:mixer-update', {
        detail: {
          melody: userMelodyLevel,
          harmony: userHarmonyLevel,
          bass: userBassLevel,
          ambient: ambientLevel,
          hiss: hissUserLevel,
        },
      }));
    } catch (_) { /* skip in old browsers */ }
  }

  // ════════════════════════════════════════════════════════════════════
  // §26  PUBLIC API
  // ════════════════════════════════════════════════════════════════════

  window.PixelAudioEngine = {

    /**
     * Initialize AudioContext and begin infinite lofi playback.
     * Must be called from a user gesture (click/tap/keypress).
     * @param {number} [seed] - Optional seed for deterministic music generation.
     */
    start: function (seed) {
      start(seed);
      startFireplaceSync();
    },

    /**
     * Fade out over 2 seconds, suspend AudioContext, clean up all nodes.
     */
    stop: function () {
      stopFireplaceSync();
      stop();
    },

    /**
     * @returns {boolean} Whether the transport is currently playing.
     */
    isPlaying: function () {
      return transport.isPlaying;
    },

    /**
     * Set master volume.
     * @param {number} v - Volume 0..1
     */
    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, v));
      if (masterGain) {
        masterGain.gain.value = volume;
      }
    },

    /**
     * Transition to a new scene's music configuration over ~4 bars.
     * @param {string} sceneName - One of the SCENE_MUSIC keys.
     */
    setScene: setScene,

    /**
     * Set tension level (affects tempo, note density, drums, reverb, vinyl).
     * @param {number} level - 0 (calm) to 4 (siege)
     */
    setTension: setTension,

    /**
     * Adjust tonal brightness and register for time of day.
     * @param {string} phase - 'dawn' | 'day' | 'dusk' | 'night'
     */
    setTimeOfDay: setTimeOfDay,

    /**
     * Trigger a musical stinger for a game/system event.
     * @param {string} eventName - Event identifier.
     * @param {*} [data] - Optional event data (reserved for future use).
     */
    onEvent: onEvent,

    /**
     * Mute all audio output (preserves volume setting for unmute).
     */
    mute: function () {
      if (masterGain) {
        masterGain.gain.value = 0;
      }
    },

    /**
     * Restore audio output to the stored volume level.
     */
    unmute: function () {
      if (masterGain) {
        masterGain.gain.value = volume;
      }
    },

    /**
     * Set the user-controlled hiss level.
     * @param {number} level - 0..1 (0 = silent, 0.5 = legacy default, 1.0 = double)
     */
    setHissLevel: function (level) {
      hissUserLevel = Math.max(0, Math.min(1, level));
      if (vinylGain) {
        vinylGain.gain.value = tensionVinylGain * hissUserLevel * 2;
      }
      dispatchMixerUpdate();
    },

    /**
     * Get the current user hiss level.
     * @returns {number} 0..1
     */
    getHissLevel: function () {
      return hissUserLevel;
    },

    /**
     * Set master ambient volume, independent of the main volume knob.
     * Controls how loud ALL scene ambient textures are relative to music.
     * @param {number} level - 0..1 (default 0.7). 0 = silent ambience, 1 = full.
     */
    setAmbientLevel: function (level) {
      ambientLevel = Math.max(0, Math.min(1, level));
      // Live-update the ambientSub gain so changes take effect immediately
      if (ambientSub) {
        ambientSub.gain.value = SUBMIX_BASE_GAINS.ambient * (ambientLevel / 0.7);
      }
      dispatchMixerUpdate();
    },

    /**
     * Get the current ambient level.
     * @returns {number} 0..1
     */
    getAmbientLevel: function () {
      return ambientLevel;
    },

    /**
     * Set melody submix level (user mixer control).
     * @param {number} level - 0..1 (1.0 = full base gain)
     */
    setMelodyLevel: function (level) {
      userMelodyLevel = Math.max(0, Math.min(1, level));
      if (melodySub && !fadedSubmixName) {
        melodySub.gain.value = SUBMIX_BASE_GAINS.melody * userMelodyLevel;
      }
    },

    /**
     * Set harmony submix level (user mixer control).
     * @param {number} level - 0..1 (1.0 = full base gain)
     */
    setHarmonyLevel: function (level) {
      userHarmonyLevel = Math.max(0, Math.min(1, level));
      if (harmSub && !fadedSubmixName) {
        harmSub.gain.value = SUBMIX_BASE_GAINS.harmony * userHarmonyLevel;
      }
    },

    /**
     * Set bass submix level (user mixer control).
     * @param {number} level - 0..1 (1.0 = full base gain)
     */
    setBassLevel: function (level) {
      userBassLevel = Math.max(0, Math.min(1, level));
      if (bassSub && !fadedSubmixName) {
        bassSub.gain.value = SUBMIX_BASE_GAINS.bass * userBassLevel;
      }
    },

    /**
     * Get current mixer levels for all submix buses.
     * @returns {object} { melody, harmony, bass, ambient, hiss } all 0..1
     */
    getMixerLevels: function () {
      return {
        melody: userMelodyLevel,
        harmony: userHarmonyLevel,
        bass: userBassLevel,
        ambient: ambientLevel,
        hiss: hissUserLevel,
      };
    },

    /**
     * Apply a mood preset. Smoothly transitions submix gains, hiss, reverb,
     * filter cutoff, and ambient level over ~2 seconds.
     * @param {string} name - 'warmLofi' | 'rainFocus' | 'deepNight' | 'gardenMorning'
     */
    setPreset: setPreset,

    /**
     * Get the name of the currently active preset (or null if none).
     * @returns {string|null}
     */
    getPreset: function () {
      return currentPreset;
    },

    /**
     * Change the reverb room size. Regenerates the IR and swaps the buffer.
     * @param {string} size - 'small' | 'medium' | 'large'
     */
    setRoomSize: setRoomSize,

    /**
     * Get the current room size.
     * @returns {string}
     */
    getRoomSize: function () {
      return currentRoomSize;
    },

    /**
     * Get a snapshot of the current engine state for debugging/UI.
     * @returns {object}
     */
    getState: function () {
      return {
        seed: _currentSeed,
        scene: currentSceneName,
        tension: currentTension,
        tempo: transport.tempo,
        key: currentRoot,
        scale: currentScale,
        instrument: currentInstrument,
        bar: transport.currentBar,
        beat: transport.currentBeat,
        phrase: transport.currentPhrase,
        playing: transport.isPlaying,
        timeOfDay: currentTimeOfDay,
        transitioning: transitioning,
        hissLevel: hissUserLevel,
        ambientLevel: ambientLevel,
        ksActiveVoices: ksActiveCount,
        fmVoicesBusy: fmVoices.filter(function (v) { return v.busy; }).length,
        markovTemperature: Math.round(markovTemperature * 100) / 100,
        lSystemGeneration: lSystem.generation,
        lSystemLength: lSystem.current.length,
        fadedSubmix: fadedSubmixName,
        usedProgressions: Object.keys(usedProgressionKeys).length,
        preset: currentPreset,
        roomSize: currentRoomSize,
        mixerLevels: {
          melody: userMelodyLevel,
          harmony: userHarmonyLevel,
          bass: userBassLevel,
          ambient: ambientLevel,
          hiss: hissUserLevel,
        },
      };
    },


    // ── Analyser Access (for PixelAudioViz) ─────────────────────────────

    /** Create an AnalyserNode tapped into lofiMerge -> safetyLimiter.
     *  Caller MUST call _destroyAnalyser() when done.
     *  @param {number} [fftSize=4096]
     *  @returns {AnalyserNode|null} */
    _createAnalyser: function (fftSize) {
      fftSize = fftSize || 4096;
      if (!ctx || ctx.state !== 'running' || !lofiMerge) return null;
      var a = ctx.createAnalyser();
      a.fftSize = fftSize;
      a.smoothingTimeConstant = 0;
      lofiMerge.disconnect(safetyLimiter);
      lofiMerge.connect(a);
      a.connect(safetyLimiter);
      a._vizAttached = true;
      return a;
    },

    /** Release an AnalyserNode and restore direct lofiMerge -> safetyLimiter.
     *  @param {AnalyserNode} a */
    _destroyAnalyser: function (a) {
      if (!a || !a._vizAttached) return;
      try {
        lofiMerge.disconnect(a);
        a.disconnect(safetyLimiter);
        lofiMerge.connect(safetyLimiter);
      } catch (e) { /* ignore */ }
      a._vizAttached = false;
    },

    /** @returns {number} AudioContext sample rate, or 0 if not running. */
    _getSampleRate: function () {
      return ctx ? ctx.sampleRate : 0;
    },

    // ── Audio Diagnostics ──────────────────────────────────────────────

    /**
     * Run audio diagnostics for a given duration.
     * Creates an AnalyserNode tapped after lofiMerge, samples every 100ms,
     * then computes a full spectral/level report.
     * @param {number} [durationSec=10] - How many seconds to sample.
     * @param {function} [callback] - Optional callback(report). Also returns a Promise.
     * @returns {Promise<object>} Diagnostic report JSON.
     */
    diagnose: function (durationSec, callback) {
      durationSec = durationSec || 10;

      if (!ctx || ctx.state !== 'running' || !lofiMerge) {
        var err = { error: 'Audio engine not running. Call start() first.' };
        if (callback) callback(err);
        return Promise.resolve(err);
      }

      return new Promise(function (resolve) {
        var FFT_SIZE = 4096;

        // Create analyser and tap into signal chain: lofiMerge -> analyser -> safetyLimiter
        diagnosticAnalyser = ctx.createAnalyser();
        diagnosticAnalyser.fftSize = FFT_SIZE;
        diagnosticAnalyser.smoothingTimeConstant = 0;

        // Re-wire: lofiMerge -> analyser -> safetyLimiter (was lofiMerge -> safetyLimiter)
        lofiMerge.disconnect(safetyLimiter);
        lofiMerge.connect(diagnosticAnalyser);
        diagnosticAnalyser.connect(safetyLimiter);

        var freqBinCount = diagnosticAnalyser.frequencyBinCount; // FFT_SIZE / 2
        var freqData = new Float32Array(freqBinCount);
        var timeData = new Float32Array(FFT_SIZE);
        var sampleRate = ctx.sampleRate;
        var binHz = sampleRate / FFT_SIZE; // Hz per frequency bin

        // Accumulators
        var totalSamples = 0;
        var clipCount = 0;
        var totalSampleValues = 0; // total time-domain samples processed
        var sumSquared = 0;        // for overall RMS
        var peakLevel = 0;
        var perSecondRMS = [];
        var currentSecondSumSq = 0;
        var currentSecondCount = 0;
        var samplesThisSecond = 0;

        // Spectral accumulators (average dB per band)
        var bandBins = {
          sub:    { lo: 20,    hi: 100,   sum: 0, count: 0 },
          bass:   { lo: 100,   hi: 300,   sum: 0, count: 0 },
          lowMid: { lo: 300,   hi: 1000,  sum: 0, count: 0 },
          mid:    { lo: 1000,  hi: 4000,  sum: 0, count: 0 },
          high:   { lo: 4000,  hi: 10000, sum: 0, count: 0 },
          air:    { lo: 10000, hi: 20000, sum: 0, count: 0 },
        };

        // Spectral centroid accumulator
        var centroidWeightedSum = 0;
        var centroidMagnitudeSum = 0;

        // Silence gap detection
        var SILENCE_THRESHOLD_DB = -60;
        var silenceGaps = [];
        var inSilence = false;
        var silenceStartTime = 0;

        // Loudness windows for dynamic range (per 100ms window)
        var windowRMSValues = [];

        var startTime = performance.now();
        var sampleInterval = 100; // ms

        var timer = setInterval(function () {
          var elapsed = (performance.now() - startTime) / 1000;
          if (elapsed >= durationSec) {
            clearInterval(timer);

            // Restore direct connection: lofiMerge -> safetyLimiter
            try {
              lofiMerge.disconnect(diagnosticAnalyser);
              diagnosticAnalyser.disconnect(safetyLimiter);
              lofiMerge.connect(safetyLimiter);
              diagnosticAnalyser = null;
            } catch (e) { /* ignore disconnect errors */ }

            // Flush final partial second
            if (currentSecondCount > 0) {
              perSecondRMS.push(Math.sqrt(currentSecondSumSq / currentSecondCount));
            }

            // Compute spectral balance (average dB per band)
            var spectralBalance = {};
            var bandNames = Object.keys(bandBins);
            for (var b = 0; b < bandNames.length; b++) {
              var band = bandBins[bandNames[b]];
              var avgDb = band.count > 0 ? band.sum / band.count : -100;
              spectralBalance[bandNames[b]] = Math.round(avgDb * 100) / 100;
            }

            // Spectral centroid
            var spectralCentroid = centroidMagnitudeSum > 0
              ? Math.round(centroidWeightedSum / centroidMagnitudeSum)
              : 0;

            // Close any open silence gap
            if (inSilence) {
              var gapDuration = elapsed - silenceStartTime;
              if (gapDuration > 0.5) {
                silenceGaps.push({
                  start: Math.round(silenceStartTime * 100) / 100,
                  duration: Math.round(gapDuration * 100) / 100,
                });
              }
            }

            // Dynamic range: dB between loudest and quietest 100ms windows
            var dynamicRange = 0;
            if (windowRMSValues.length > 1) {
              var sorted = windowRMSValues.slice().sort(function (a, b) { return a - b; });
              // Exclude bottom 5% (possible silence) for meaningful dynamic range
              var loIdx = Math.floor(sorted.length * 0.05);
              var hiIdx = sorted.length - 1;
              var loRMS = sorted[loIdx] || 1e-10;
              var hiRMS = sorted[hiIdx] || 1e-10;
              dynamicRange = Math.round(20 * Math.log10(hiRMS / Math.max(loRMS, 1e-10)) * 100) / 100;
            }

            var overallRMS = totalSampleValues > 0
              ? Math.round(Math.sqrt(sumSquared / totalSampleValues) * 10000) / 10000
              : 0;

            var report = {
              seed: _currentSeed,
              duration: durationSec,
              sampleRate: sampleRate,
              fftSize: FFT_SIZE,
              samples: totalSamples,
              clipping: {
                count: clipCount,
                ratio: totalSampleValues > 0
                  ? Math.round((clipCount / totalSampleValues) * 100000) / 100000
                  : 0,
              },
              rms: {
                overall: overallRMS,
                perSecond: perSecondRMS.map(function (v) {
                  return Math.round(v * 10000) / 10000;
                }),
              },
              silenceGaps: silenceGaps,
              spectralBalance: spectralBalance,
              spectralCentroid: spectralCentroid,
              peakLevel: Math.round(peakLevel * 10000) / 10000,
              dynamicRange: dynamicRange,
            };

            console.log('[Audio Diagnostics]', JSON.stringify(report, null, 2));
            if (callback) callback(report);
            resolve(report);
            return;
          }

          // ── Sample frequency data ──
          diagnosticAnalyser.getFloatFrequencyData(freqData);

          // Accumulate spectral bands and centroid
          for (var i = 0; i < freqBinCount; i++) {
            var hz = i * binHz;
            var db = freqData[i]; // dB value (typically -100 to 0)
            var magnitude = Math.pow(10, db / 20); // linear magnitude

            // Spectral centroid
            centroidWeightedSum += hz * magnitude;
            centroidMagnitudeSum += magnitude;

            // Band accumulation
            var bKeys = Object.keys(bandBins);
            for (var bk = 0; bk < bKeys.length; bk++) {
              var bn = bandBins[bKeys[bk]];
              if (hz >= bn.lo && hz < bn.hi) {
                bn.sum += db;
                bn.count++;
                break;
              }
            }
          }

          // ── Sample time-domain data ──
          diagnosticAnalyser.getFloatTimeDomainData(timeData);

          var windowSumSq = 0;
          for (var j = 0; j < FFT_SIZE; j++) {
            var s = timeData[j];
            var abs = Math.abs(s);

            // Clipping detection
            if (abs >= 1.0) clipCount++;

            // Peak tracking
            if (abs > peakLevel) peakLevel = abs;

            // RMS accumulators
            sumSquared += s * s;
            currentSecondSumSq += s * s;
            windowSumSq += s * s;
            totalSampleValues++;
            currentSecondCount++;
          }

          // Per-window RMS for dynamic range
          var windowRMS = Math.sqrt(windowSumSq / FFT_SIZE);
          if (windowRMS > 1e-10) windowRMSValues.push(windowRMS);

          // Silence gap detection (per window)
          var windowDb = windowRMS > 0 ? 20 * Math.log10(windowRMS) : -100;
          var elapsedNow = (performance.now() - startTime) / 1000;
          if (windowDb < SILENCE_THRESHOLD_DB) {
            if (!inSilence) {
              inSilence = true;
              silenceStartTime = elapsedNow;
            }
          } else {
            if (inSilence) {
              var gap = elapsedNow - silenceStartTime;
              if (gap > 0.5) {
                silenceGaps.push({
                  start: Math.round(silenceStartTime * 100) / 100,
                  duration: Math.round(gap * 100) / 100,
                });
              }
              inSilence = false;
            }
          }

          // Per-second RMS boundary
          samplesThisSecond++;
          if (samplesThisSecond >= 10) { // 10 intervals of 100ms = 1 second
            if (currentSecondCount > 0) {
              perSecondRMS.push(Math.sqrt(currentSecondSumSq / currentSecondCount));
            }
            currentSecondSumSq = 0;
            currentSecondCount = 0;
            samplesThisSecond = 0;
          }

          totalSamples++;
        }, sampleInterval);
      });
    },

    /**
     * Compare two PRNG seeds by generating 50 rng() values from each.
     * Proves that different seeds produce different random sequences,
     * which means different musical output (all decisions flow through rng()).
     * @param {number} seedA - First seed to test.
     * @param {number} seedB - Second seed to test.
     * @returns {object} { seedA, seedB, seqA (first 10), seqB (first 10), matchRatio, different }
     */
    compareSeed: function (seedA, seedB) {
      var savedState = _rngState;

      mulberry32(seedA);
      var seqA = [];
      for (var i = 0; i < 50; i++) seqA.push(rng());

      mulberry32(seedB);
      var seqB = [];
      for (var i = 0; i < 50; i++) seqB.push(rng());

      // Restore PRNG to previous state
      _rngState = savedState;

      var matches = 0;
      for (var i = 0; i < 50; i++) {
        if (Math.abs(seqA[i] - seqB[i]) < 0.001) matches++;
      }

      var result = {
        seedA: seedA,
        seedB: seedB,
        seqA: seqA.slice(0, 10).map(function (v) { return Math.round(v * 10000) / 10000; }),
        seqB: seqB.slice(0, 10).map(function (v) { return Math.round(v * 10000) / 10000; }),
        matchRatio: matches / 50,
        different: matches === 0,
      };

      console.log(
        '[Audio] Seed comparison:', seedA, 'vs', seedB,
        '— match ratio:', result.matchRatio,
        result.different ? 'DIFFERENT (confirmed)' : 'SUSPICIOUS (possible collision)'
      );

      return result;
    },
  };

})();
