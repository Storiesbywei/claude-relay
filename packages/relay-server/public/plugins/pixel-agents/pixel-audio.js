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
//   .mute() / .unmute()
//   .getState()      — snapshot of current engine state

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
      getState: function () { return { playing: false }; },
    };
    return;
  }

  // ════════════════════════════════════════════════════════════════════
  // §1  SEEDED PRNG — mulberry32
  // ════════════════════════════════════════════════════════════════════

  var _rngState = 0;

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
  var lofiMerge = null;   // GainNode merging dry + wet before master

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

  // Ambient texture
  var ambientTextureSource = null;
  var ambientTextureGain = null;
  var ambientTextureFilter = null;
  var ambientCrackleTimer = null;
  var currentAmbientScene = null;

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
    currentProgression = pool[Math.floor(rng() * pool.length)];
    currentChordIndex = 0;
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
    // Rest check
    if (rng() < restProbability) return null;

    var matrix = getMarkovMatrix();
    var scaleLen = matrix.length;

    // Clamp state to matrix size
    if (melodyState >= scaleLen) melodyState = 0;

    var weights = matrix[melodyState];
    var r = rng();
    var next = 0;
    for (var i = 0; i < weights.length; i++) {
      r -= weights[i];
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
    // Occasionally pick a new chord progression
    if (rng() < 0.25) {
      pickNewProgression();
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

    // ── Lofi chain output merge (dry + wet -> master) ──
    lofiMerge = ctx.createGain();
    lofiMerge.gain.value = 1.0;
    lofiMerge.connect(masterGain);

    // ── Build lofi processing chain ──
    buildLofiChain();

    // ── Submix buses -> lofi input ──
    melodySub = ctx.createGain();
    melodySub.gain.value = 0.30;
    melodySub.connect(lofiInput);

    harmSub = ctx.createGain();
    harmSub.gain.value = 0.25;
    harmSub.connect(lofiInput);

    bassSub = ctx.createGain();
    bassSub.gain.value = 0.20;
    bassSub.connect(lofiInput);

    ambientSub = ctx.createGain();
    ambientSub.gain.value = 0.25;
    ambientSub.connect(lofiInput);
  }

  // ════════════════════════════════════════════════════════════════════
  // §8  LOFI PROCESSING CHAIN
  // ════════════════════════════════════════════════════════════════════

  function createBitcrushCurve(bits) {
    var steps = Math.pow(2, bits);
    var len = 65536;
    var curve = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      var x = (i / len) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  }

  function createReverbIR(duration, decay) {
    var length = Math.ceil(ctx.sampleRate * duration);
    var buffer = ctx.createBuffer(2, length, ctx.sampleRate);

    // Bandpass-filtered decaying noise (300-6000 Hz character)
    // We generate full-spectrum noise then rely on the convolver's natural roll-off.
    // For extra realism, apply a simple IIR envelope per channel.
    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      var decayRate = ctx.sampleRate * decay;
      // Simple state for low-pass filtering the noise (softens highs)
      var prev = 0;
      var lpCoeff = 0.7; // lower = darker reverb tail
      for (var i = 0; i < length; i++) {
        var noise = Math.random() * 2 - 1; // true random OK for IR — not musical
        var envelope = Math.exp(-i / decayRate);
        // One-pole lowpass
        var filtered = lpCoeff * noise + (1 - lpCoeff) * prev;
        prev = filtered;
        data[i] = filtered * envelope;
      }
    }
    return buffer;
  }

  function buildLofiChain() {
    // Input node
    lofiInput = ctx.createGain();
    lofiInput.gain.value = 1.0;

    // 1. Bitcrusher (256-step staircase waveshaper = 8 bits)
    bitcrusher = ctx.createWaveShaper();
    bitcrusher.curve = createBitcrushCurve(8);
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
    reverbConvolver.buffer = createReverbIR(1.5, 0.6);

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

  function playMelodyNote(midi, detuneCents, time, duration, volumeMult) {
    volumeMult = volumeMult || 1.0;

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

    var bufferSize = ctx.sampleRate * 2;
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) {
      data[i] = rng() * 2 - 1;
    }

    vinylSource = ctx.createBufferSource();
    vinylSource.buffer = buffer;
    vinylSource.loop = true;

    vinylFilter = ctx.createBiquadFilter();
    vinylFilter.type = 'bandpass';
    vinylFilter.frequency.value = 5000;
    vinylFilter.Q.value = 0.5;

    vinylGain = ctx.createGain();
    vinylGain.gain.value = tensionVinylGain;

    vinylSource.connect(vinylFilter);
    vinylFilter.connect(vinylGain);
    vinylGain.connect(ambientSub);
    vinylSource.start();
  }

  function stopVinylHiss() {
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
    workshop:      { filterType: 'lowpass',  freq: 200,  gain: 0.02,  Q: 1.0,  label: 'mechanical hum' },
    library:       { filterType: 'bandpass', freq: 3000, gain: 0.01,  Q: 0.8,  label: 'quiet rustle' },
    garden:        { filterType: 'bandpass', freq: 4000, gain: 0.015, Q: 0.6,  label: 'breeze' },
    waterfront:    { filterType: 'bandpass', freq: 1200, gain: 0.04,  Q: 0.4,  label: 'waves' },
    cave:          { filterType: 'bandpass', freq: 800,  gain: 0.02,  Q: 0.5,  label: 'drips' },
    winterLodge:   { filterType: 'bandpass', freq: 2000, gain: 0.035, Q: 0.7,  label: 'fire crackle' },
    harvestField:  { filterType: 'bandpass', freq: 1500, gain: 0.03,  Q: 0.5,  label: 'wind in grain' },
    cliffOverlook: { filterType: 'lowpass',  freq: 1000, gain: 0.05,  Q: 0.3,  label: 'wind' },
  };

  function stopAmbientTexture() {
    if (ambientCrackleTimer) {
      clearInterval(ambientCrackleTimer);
      ambientCrackleTimer = null;
    }
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
    currentAmbientScene = null;
  }

  function startAmbientTexture(sceneName) {
    if (currentAmbientScene === sceneName) return;
    stopAmbientTexture();

    var config = AMBIENT_CONFIGS[sceneName];
    if (!config) return;

    currentAmbientScene = sceneName;

    // Create noise buffer (2 seconds, looped)
    var bufferSize = ctx.sampleRate * 2;
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);

    if (sceneName === 'waterfront') {
      // Wave-like: modulated noise with slow amplitude variation baked in
      for (var w = 0; w < bufferSize; w++) {
        var waveMod = 0.5 + 0.5 * Math.sin(2 * Math.PI * w / (ctx.sampleRate * 0.7));
        data[w] = (rng() * 2 - 1) * waveMod;
      }
    } else if (sceneName === 'cave') {
      // Sparse drip-like: mostly silence with occasional transients
      for (var d = 0; d < bufferSize; d++) {
        if (rng() < 0.002) {
          // Drip transient
          var dripLen = Math.min(Math.floor(rng() * 200 + 100), bufferSize - d);
          for (var dl = 0; dl < dripLen && (d + dl) < bufferSize; dl++) {
            data[d + dl] = (rng() * 2 - 1) * Math.exp(-dl / 40);
          }
          d += dripLen;
        } else {
          data[d] = (rng() * 2 - 1) * 0.02; // very quiet background
        }
      }
    } else {
      // Generic filtered noise
      for (var n = 0; n < bufferSize; n++) {
        data[n] = rng() * 2 - 1;
      }
    }

    ambientTextureSource = ctx.createBufferSource();
    ambientTextureSource.buffer = buffer;
    ambientTextureSource.loop = true;

    ambientTextureFilter = ctx.createBiquadFilter();
    ambientTextureFilter.type = config.filterType;
    ambientTextureFilter.frequency.value = config.freq;
    ambientTextureFilter.Q.value = config.Q;

    ambientTextureGain = ctx.createGain();
    ambientTextureGain.gain.value = 0;
    // Fade in over 2 seconds
    ambientTextureGain.gain.linearRampToValueAtTime(config.gain, ctx.currentTime + 2);

    ambientTextureSource.connect(ambientTextureFilter);
    ambientTextureFilter.connect(ambientTextureGain);
    ambientTextureGain.connect(ambientSub);
    ambientTextureSource.start();

    // Winter lodge fire crackle: modulate gain randomly for intermittent crackling
    if (sceneName === 'winterLodge') {
      ambientCrackleTimer = setInterval(function () {
        if (!ambientTextureGain || !ctx) return;
        var now = ctx.currentTime;
        var baseGain = config.gain;
        // Crackle: random gain spikes
        if (rng() < 0.3) {
          // Pop/crackle spike
          var spike = baseGain * (1.5 + rng() * 2.0);
          ambientTextureGain.gain.setValueAtTime(spike, now);
          ambientTextureGain.gain.exponentialRampToValueAtTime(
            Math.max(baseGain, 0.001), now + 0.03 + rng() * 0.04
          );
        } else {
          // Gentle flicker
          var flicker = baseGain * (0.5 + rng() * 1.0);
          ambientTextureGain.gain.setValueAtTime(flicker, now);
          ambientTextureGain.gain.linearRampToValueAtTime(baseGain, now + 0.08);
        }
      }, 50 + Math.floor(rng() * 50)); // 50-100ms interval
    }

    // Garden / harvest field: slow breeze modulation
    if (sceneName === 'garden' || sceneName === 'harvestField') {
      ambientCrackleTimer = setInterval(function () {
        if (!ambientTextureFilter || !ctx) return;
        var now = ctx.currentTime;
        var baseFreq = config.freq;
        var drift = baseFreq * (0.8 + rng() * 0.4);
        ambientTextureFilter.frequency.linearRampToValueAtTime(drift, now + 0.5);
      }, 500);
    }

    // Cliff overlook: wind gusts
    if (sceneName === 'cliffOverlook') {
      ambientCrackleTimer = setInterval(function () {
        if (!ambientTextureGain || !ctx) return;
        var now = ctx.currentTime;
        var baseGain = config.gain;
        if (rng() < 0.15) {
          // Wind gust
          var gustPeak = baseGain * (2.0 + rng() * 2.0);
          var gustDuration = 0.5 + rng() * 1.5;
          ambientTextureGain.gain.linearRampToValueAtTime(gustPeak, now + gustDuration * 0.3);
          ambientTextureGain.gain.linearRampToValueAtTime(baseGain, now + gustDuration);
        }
      }, 300);
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

    if (barsLeft > 2) {
      // Phase 0: fading out melody
      transitionPhase = 0;
      if (melodySub) {
        var fadeVal = Math.max(0.05, (barsLeft - 2) / 2 * 0.30);
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
        melodySub.gain.linearRampToValueAtTime(0.30, time + transport.secondsPerBeat * 3);
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

    // Ensure submix levels are restored
    if (melodySub) melodySub.gain.value = 0.30;

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
        vinylGain.gain.value = startVinylGain + (targetVinylGain - startVinylGain) * ease;
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
    mulberry32(seed);

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

    // Suspend context
    if (ctx && ctx.state === 'running') {
      ctx.suspend();
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
        var baseGain = AMBIENT_CONFIGS.winterLodge.gain;
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
     * Get a snapshot of the current engine state for debugging/UI.
     * @returns {object}
     */
    getState: function () {
      return {
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
        ksActiveVoices: ksActiveCount,
        fmVoicesBusy: fmVoices.filter(function (v) { return v.busy; }).length,
      };
    },
  };

})();
