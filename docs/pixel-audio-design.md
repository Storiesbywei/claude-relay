# Pixel Audio — Procedural Lofi Music System

## Technical Design Document

**Module:** `pixel-audio.js` (~1,765 lines estimated)
**Runtime:** Web Audio API (browser, no dependencies, no audio files)
**Goal:** Infinite, seeded, reactive lofi music for the pixel agents screensaver

---

## 1. Architecture

### Master Bus

```
[Instrument Voices] -> [Submix Bus] -> [Lofi Chain] -> [Master Gain] -> destination
```

**Four submix buses:**

| Bus | Contents | Base Gain |
|-----|----------|-----------|
| melodySub | Karplus-Strong leads, FM bells | 0.30 |
| harmSub | Wavetable pads, FM chords | 0.25 |
| bassSub | FM bass, KS bass notes | 0.20 |
| ambientSub | Scene textures, vinyl hiss, one-shots | 0.25 |

### Voice Pool

| Instrument | Pool Size | Technique |
|-----------|-----------|-----------|
| Karplus-Strong | 6 | Pre-computed AudioBuffers, recycled after decay |
| FM Synth | 4 | Persistent oscillator pairs, envelope-gated |
| Wavetable Pad | 2 | Crossfade between voices for chord changes |
| Ambient | 1 noise + 1 one-shot | Looped buffer + scheduled events |

Total persistent nodes: ~20.

### Lofi Processing Chain (built-in nodes only)

1. **Bitcrusher**: `WaveShaperNode` with 256-step staircase curve (8-bit equivalent)
2. **Tape Wow**: `DelayNode` (5ms) modulated by `OscillatorNode` (0.3 Hz sine, depth 2ms) — ±5 cent pitch wobble
3. **Vinyl Hiss**: Looped bandpass noise (2-8kHz), gain 0.03
4. **High-Freq Rolloff**: `BiquadFilterNode` lowpass, 9kHz, Q 0.7
5. **Room Reverb**: `ConvolverNode` with synthetic 1.5s IR (exponentially decaying bandpass noise). Dry/wet: 0.75/0.25

### Timing

Web Audio scheduler, not setInterval. 50ms look-ahead via requestAnimationFrame (setTimeout fallback for background tabs).

- Tempo: seconds per beat (e.g., 75 BPM = 0.8 s/beat)
- Transport tracks: currentBeat, currentBar, currentPhrase
- Always 4/4 time

---

## 2. Instruments

### Karplus-Strong (Plucked Strings)

**Role:** Primary melody + bass notes. Kalimba/guitar character.

**Method:** Offline pre-computation into AudioBuffer. KS algorithm:
1. Fill delay line (sampleRate/frequency samples) with noise
2. Each output = average(current, previous) in delay line
3. Loss factor 0.996 (melody) / 0.998 (bass)
4. Blend factor 0.5 (bright) / 0.3 (muted)

Post-filter: BiquadFilterNode lowpass, 3000-6000 Hz scene-dependent.

| Range | Frequency | Decay | Blend | Filter |
|-------|-----------|-------|-------|--------|
| Melody | 220-880 Hz | 0.996 | 0.5 | LP 4500 Hz |
| Bass | 55-110 Hz | 0.998 | 0.3 | LP 2000 Hz |

Per-note random detune of ±3 cents for lofi character.

### FM Synthesis (Bells & Keys)

**Role:** Chord stabs, bell accents, electric piano.

Two-operator FM: modulator output -> carrier frequency AudioParam. GainNode between controls mod depth.

| Sound | C:M Ratio | Mod Index | Attack | Release |
|-------|-----------|-----------|--------|---------|
| Electric piano | 1:1 | 150-300 Hz | 0.01s | 1.5s |
| Bell/kalimba | 1:3.5 | 200-500 Hz | 0.001s | 2.0s |
| Warm pad stab | 1:2 | 50-100 Hz | 0.08s | 0.8s |
| Marimba | 1:4 | 100-200 Hz | 0.001s | 0.6s |

Secret sauce: mod index decays faster than amplitude (peak -> 30% over 0.3s). Gives bright attack that mellows.

### Wavetable Pad (Sustained Harmony)

**Role:** Background harmonic bed. Distant synth pad through a window.

Custom PeriodicWave: partials 1 (1.0), 2 (0.5), 3 (0.3), 5 (0.15), 7 (0.08). Even partials above 2: 0.0 (hollow, clarinet-like).

Two slightly detuned oscillators (+5 cents) for width. Very slow ADSR: attack 2s, release 3s. LP filter at 2500 Hz.

Chord changes: frequency glide via exponentialRampToValueAtTime over 3s. Crossfade between voices.

### Drum Synthesis

All procedural:

| Element | Synthesis |
|---------|-----------|
| Kick | Sine sweep 150->40 Hz over 0.08s |
| Snare | Noise burst (0.05s) + sine 180 Hz, bandpass 1kHz |
| Hi-hat | Noise burst (0.02s), highpass 7kHz, very quiet |
| Ghost | Same as above at 30% gain |

Swing: even 16th-steps delayed 30-50ms. Core lofi groove.

---

## 3. Composition Engine

### Scale System

| Scale | Intervals | Mood | Scenes |
|-------|-----------|------|--------|
| Major Pentatonic | 0,2,4,7,9 | Cheerful | garden, harvest |
| Minor Pentatonic | 0,3,5,7,10 | Wistful, lofi | workshop, library |
| Dorian | 0,2,3,5,7,9,10 | Warm minor | waterfront, cliff |
| Mixolydian | 0,2,4,5,7,9,10 | Hopeful | harvest, lodge |
| Aeolian | 0,2,3,5,7,8,10 | Melancholy | cave, winter |
| Lydian | 0,2,4,6,7,9,11 | Dreamy | garden (night) |
| Minor Blues | 0,3,5,6,7,10 | Gritty | crisis/siege |

### Root Keys

| Scene | Key | MIDI |
|-------|-----|------|
| Workshop | D3 | 62 |
| Library | E3 | 64 |
| Garden | G3 | 67 |
| Waterfront | A3 | 69 |
| Cave | C3 | 60 |
| Winter Lodge | F3 | 65 |
| Harvest Field | G3 | 67 |
| Cliff Overlook | A3 | 69 |

### Markov Melody Generator

5-state transition matrix for pentatonic (favors stepwise motion):

```
From\To   0     1     2     3     4
  0    [ 0.05, 0.35, 0.20, 0.10, 0.30 ]
  1    [ 0.30, 0.05, 0.35, 0.15, 0.15 ]
  2    [ 0.15, 0.25, 0.05, 0.35, 0.20 ]
  3    [ 0.10, 0.15, 0.30, 0.05, 0.40 ]
  4    [ 0.40, 0.15, 0.15, 0.25, 0.05 ]
```

- Octave bias: if last 2 notes high, bias down; if low, bias up. Creates melodic arcs.
- Rest probability: 0.25 (calm), 0.15 (normal), 0.08 (tense)
- Phrase resolution: every 8 beats, 40% chance next note is root

### Chord Progressions (curated pools)

**Calm Major:** I-IV-V-I, I-vi-IV-V, I-iii-IV-I
**Calm Minor:** i-iv-v-i, i-VI-III-VII, i-iv-VII-III
**Tense:** i-iv-i-v, i-v-iv-iv, i-VII-iv-v
**Crisis:** i-i-iv-iv (drone), i-bII-i-bII (tritone)

One progression repeats 2-4 phrases, then rotates.

### Rhythm (L-System)

Axiom: `X` -> `K.H.` -> subdivide K/H for complexity.
2 iterations (calm) to 4 (tense). Map to 16-step grid.

---

## 4. Scene Sound Design

| Scene | Instruments | Scale | BPM | Ambient | Mood |
|-------|------------|-------|-----|---------|------|
| Workshop | KS kalimba, FM Rhodes, KS bass | D min penta | 72-78 | Mech hum (60Hz), metallic taps | Focused |
| Library | FM bells (1:3.5), KS fingerpick, quiet pad | E min penta | 65-70 | Page rustle, clock tick | Hushed |
| Garden | KS harp, FM bells, warm pad | G maj penta / Lydian (night) | 70-76 | Bird chirps (FM 1:5), breeze | Pastoral |
| Waterfront | KS nylon guitar, FM chords, lush pad | A Dorian | 72-80 | Waves (modulated noise), water laps | Reflective |
| Cave | FM crystalline bells, sparse KS, dark pad | C Aeolian | 60-66 | Water drips (KS 1500Hz), low rumble | Subterranean |
| Winter Lodge | FM e-piano (1:1), KS gut string, close pad | F Mixolydian | 68-74 | Fire crackle (noise clusters), wind | Hygge |
| Harvest Field | KS banjo, FM major stabs, strong bass | G maj penta / Mixolydian | 76-84 | Wind through grain, distant bird | Golden |
| Cliff Overlook | Pad (primary), sparse KS harp, rare FM | A Dorian / Aeolian (night) | 62-68 | Strong wind (LFO noise), eagle cry | Vast |

---

## 5. Tension Reactivity

| Parameter | Calm (0) | Normal (1) | Tense (2) | Crisis (3) | Siege (4) |
|-----------|----------|------------|-----------|-----------|-----------|
| Scale | Major penta | Scene default | Minor penta | Aeolian | Minor blues |
| Tempo | 65-72 | 72-80 | 80-90 | 90-100 | 55-60 (half-time) |
| Melody density | Sparse | Moderate | Full | Rapid | Sparse, low |
| Pad filter | 1800 Hz | 2500 Hz | 3500 Hz | 5000 Hz | 1200 Hz |
| Reverb wet | 0.35 | 0.25 | 0.18 | 0.10 | 0.40 |
| Vinyl hiss | 0.05 | 0.03 | 0.015 | Off | 0.06 |

All parameters lerp over 4 beats. Scale changes wait for phrase boundary.

---

## 6. Public API

```js
window.PixelAudioEngine = {
  start(seed),              // init AudioContext on user gesture, begin
  stop(),                   // fade out 2s, suspend
  isPlaying(),
  setVolume(0-1),
  setScene(name),           // 4-bar transition
  setTension(0-4),          // parameter lerp
  setTimeOfDay(phase),      // filter/register adjustments
  onEvent(type, data),      // knightSpawn, knightKill, gatoPurr, etc.
  mute(), unmute(),
  getState()                // { scene, tension, tempo, key, bar, phrase, playing }
};
```

---

## 7. Build Phases

| Phase | What | Lines |
|-------|------|-------|
| 1. MVP | AudioContext + KS + scale + Markov + basic lofi chain | ~415 |
| 2. Full palette | FM + pad + drums + chords + full lofi chain | ~540 |
| 3. Reactivity | Tension system + 8 scene configs + transitions + ambients | ~560 |
| 4. Integration | Public API + game events + volume + variation | ~250 |
| **Total** | | **~1,765** |

Pure synthesis. Zero audio files. Zero dependencies.
