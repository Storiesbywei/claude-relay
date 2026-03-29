#!/usr/bin/env node
// Pixel Agent Modules — Browser Environment Simulation Test
// Tests that each pixel-*.js module loads correctly and exports expected APIs.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'packages', 'relay-server', 'public');

// ── Minimal browser-like environment ──────────────────────────────────────

function createMockCtx() {
  const noop = () => {};
  const self = {
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    measureText: () => ({ width: 10 }),
    drawImage: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setLineDash: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineDashOffset: 0,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
  return self;
}

const window = {};
const document = {
  createElement: (tag) => {
    if (tag === 'canvas') {
      return {
        width: 960,
        height: 672,
        getContext: () => createMockCtx(),
        style: {},
      };
    }
    return { style: {}, appendChild: () => {}, classList: { add: () => {} } };
  },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild: () => {} },
  addEventListener: () => {},
};
const performance = { now: () => Date.now() };
const requestAnimationFrame = () => {};
const cancelAnimationFrame = () => {};
const Image = function () { this.src = ''; this.onload = null; this.onerror = null; };
const Audio = function () { this.src = ''; };
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
const console_orig = console;

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertType(value, type, msg) {
  if (typeof value !== type) {
    throw new Error(`${msg || 'assertType'}: expected type ${type}, got ${typeof value}`);
  }
}

// ── Load each module ──────────────────────────────────────────────────────

const modules = [
  { file: 'pixel-scenes.js',       exportName: 'PixelSceneConfig' },
  { file: 'pixel-creatures.js',    exportName: 'PixelCreatureConfig' },
  { file: 'pixel-progression.js',  exportName: 'PixelProgressionConfig' },
  { file: 'pixel-collab.js',       exportName: 'PixelCollabConfig' },
  { file: 'pixel-agents.js',       exportName: null },  // uses const, not window.*
];

for (const mod of modules) {
  const filePath = path.join(PUBLIC, mod.file);
  test(`Load ${mod.file}`, () => {
    assert(fs.existsSync(filePath), `File not found: ${filePath}`);
    const code = fs.readFileSync(filePath, 'utf-8');
    // eval in our mock environment
    const fn = new Function(
      'window', 'document', 'performance', 'requestAnimationFrame',
      'cancelAnimationFrame', 'Image', 'Audio', 'localStorage', 'fetch',
      'console', 'ctx',
      code
    );
    fn(window, document, performance, requestAnimationFrame,
       cancelAnimationFrame, Image, Audio, localStorage, fetch,
       console_orig, createMockCtx());
  });
}

// ── Verify exports exist ──────────────────────────────────────────────────

test('window.PixelSceneConfig exists and is an object', () => {
  assert(window.PixelSceneConfig != null, 'PixelSceneConfig is null/undefined');
  assertType(window.PixelSceneConfig, 'object', 'PixelSceneConfig type');
});

test('window.PixelCreatureConfig exists and is an object', () => {
  assert(window.PixelCreatureConfig != null, 'PixelCreatureConfig is null/undefined');
  assertType(window.PixelCreatureConfig, 'object', 'PixelCreatureConfig type');
});

test('window.PixelProgressionConfig exists and is an object', () => {
  assert(window.PixelProgressionConfig != null, 'PixelProgressionConfig is null/undefined');
  assertType(window.PixelProgressionConfig, 'object', 'PixelProgressionConfig type');
});

test('window.PixelCollabConfig exists and is an object', () => {
  assert(window.PixelCollabConfig != null, 'PixelCollabConfig is null/undefined');
  assertType(window.PixelCollabConfig, 'object', 'PixelCollabConfig type');
});

// pixel-agents.js uses `const PixelAgents = (...)()` — check it was NOT
// assigned to window (it's a const in the eval scope, unreachable from here).
// We'll just confirm the file loaded without error (done above).

// ══════════════════════════════════════════════════════════════════════════
// PixelSceneConfig tests
// ══════════════════════════════════════════════════════════════════════════

test('PixelSceneConfig.scenes has 8 keys', () => {
  const keys = Object.keys(window.PixelSceneConfig.scenes);
  assertEqual(keys.length, 8, 'scenes key count');
});

test('PixelSceneConfig.suggestScene({}) returns a string', () => {
  const result = window.PixelSceneConfig.suggestScene({});
  assertType(result, 'string', 'suggestScene return type');
});

test('PixelSceneConfig.transition.start is a function', () => {
  assertType(window.PixelSceneConfig.transition.start, 'function', 'transition.start');
});

// ══════════════════════════════════════════════════════════════════════════
// PixelCreatureConfig tests
// ══════════════════════════════════════════════════════════════════════════

test("classifyKnight('bug fix', 'critical crash') returns 'critical'", () => {
  const result = window.PixelCreatureConfig.classifyKnight('bug fix', 'critical crash');
  assertEqual(result, 'critical', 'classifyKnight critical');
});

test("classifyKnight('add feature', '') returns 'normal'", () => {
  const result = window.PixelCreatureConfig.classifyKnight('add feature', '');
  assertEqual(result, 'normal', 'classifyKnight normal');
});

test('rollBunnyReward() returns object with particles and color', () => {
  const reward = window.PixelCreatureConfig.rollBunnyReward();
  assert(reward != null, 'reward is null');
  assert('particles' in reward, 'reward missing particles');
  assert('color' in reward, 'reward missing color');
  assertType(reward.particles, 'number', 'reward.particles type');
  assertType(reward.color, 'string', 'reward.color type');
});

test('checkSpecialSpawns with activeTaskCount:7 returns array including redDemon', () => {
  const ctx = {
    activeTaskCount: 7,
    agents: new Map(),
    obstacles: new Map(),
    tension: 0.5,
    lastMessageType: 'task',
    now: Date.now(),
    activeSpecials: new Set(),
  };
  const spawns = window.PixelCreatureConfig.checkSpecialSpawns(ctx);
  assert(Array.isArray(spawns), 'spawns should be array');
  assert(spawns.includes('redDemon'), `spawns should include 'redDemon', got: [${spawns.join(', ')}]`);
});

// ══════════════════════════════════════════════════════════════════════════
// PixelProgressionConfig tests
// ══════════════════════════════════════════════════════════════════════════

// NOTE: getSunflowerStage takes knightHpPercent (0-100 scale) and returns
// a numeric index (0-4), NOT a stage name string.
// The test plan asks for string returns — we test actual behavior.

test("getSunflowerStage(0.9) — test plan expects 'seed'", () => {
  const result = window.PixelProgressionConfig.getSunflowerStage(0.9);
  // 0.9 on a 0-100 scale is < 20 → returns 4 (bloom index)
  // To get 'seed' (index 0), you'd need hp > 80, i.e. pass 90.
  // Testing what the test plan asks:
  assertEqual(result, 'seed', 'getSunflowerStage(0.9)');
});

test("getSunflowerStage(0.1) — test plan expects 'bloom'", () => {
  const result = window.PixelProgressionConfig.getSunflowerStage(0.1);
  assertEqual(result, 'bloom', 'getSunflowerStage(0.1)');
});

test("getFountainState(0) — test plan expects 'off'", () => {
  const result = window.PixelProgressionConfig.getFountainState(0);
  assertEqual(result, 'off', 'getFountainState(0)');
});

test("getFountainState(5) — test plan expects 'fullSpray'", () => {
  const result = window.PixelProgressionConfig.getFountainState(5);
  assertEqual(result, 'fullSpray', 'getFountainState(5)');
});

test("getSunflowerStage(90) returns index 0 ('seed' stage)", () => {
  const result = window.PixelProgressionConfig.getSunflowerStage(90);
  assertEqual(result, 0, 'getSunflowerStage(90) actual');
});

test("getSunflowerStage(10) returns index 4 ('bloom' stage)", () => {
  const result = window.PixelProgressionConfig.getSunflowerStage(10);
  assertEqual(result, 4, 'getSunflowerStage(10) actual');
});

test("getFountainState(0) returns index 0 (actual)", () => {
  const result = window.PixelProgressionConfig.getFountainState(0);
  // This will pass if returns 0 OR 'off'
  assert(result === 0 || result === 'off', `getFountainState(0) actual: got ${result}`);
});

test("getFountainState(5) returns index 3 (actual)", () => {
  const result = window.PixelProgressionConfig.getFountainState(5);
  assert(result === 3 || result === 'fullSpray', `getFountainState(5) actual: got ${result}`);
});

test("new TensionEngine() creates instance with getLevel() returning 'calm'", () => {
  const engine = new window.PixelProgressionConfig.TensionEngine();
  assert(engine != null, 'TensionEngine instance is null');
  assertType(engine.getLevel, 'function', 'getLevel is function');
  const level = engine.getLevel();
  assertEqual(level, 'calm', 'initial tension level');
});

// ══════════════════════════════════════════════════════════════════════════
// PixelCollabConfig tests
// ══════════════════════════════════════════════════════════════════════════

test('getFormationPositions(10, 7, 2, 20, 14) returns array of length 2', () => {
  const positions = window.PixelCollabConfig.getFormationPositions(10, 7, 2, 20, 14);
  assert(Array.isArray(positions), 'should return array');
  assertEqual(positions.length, 2, 'formation positions count');
});

test('calculateDamageMultiplier(2, false) returns 1.2', () => {
  const result = window.PixelCollabConfig.calculateDamageMultiplier(2, false);
  assertEqual(result, 1.2, 'damage multiplier 2 agents, no panda');
});

test('calculateDamageMultiplier(2, true) returns 1.8', () => {
  const result = window.PixelCollabConfig.calculateDamageMultiplier(2, true);
  // 1.2 * 1.5 = 1.7999... due to float precision
  assert(
    Math.abs(result - 1.8) < 0.001,
    `damage multiplier 2 agents + panda: expected ~1.8, got ${result}`
  );
});

test('new CelebrationCascade() creates an instance', () => {
  const cascade = new window.PixelCollabConfig.CelebrationCascade();
  assert(cascade != null, 'CelebrationCascade instance is null');
  assert(Array.isArray(cascade.cascadeParticles), 'should have cascadeParticles array');
});

test('new RelayLineManager() creates an instance', () => {
  const manager = new window.PixelCollabConfig.RelayLineManager();
  assert(manager != null, 'RelayLineManager instance is null');
  assert(Array.isArray(manager.activeLines), 'should have activeLines array');
});

// ══════════════════════════════════════════════════════════════════════════
// Report
// ══════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(70));
console.log('  PIXEL MODULE TEST RESULTS');
console.log('='.repeat(70));

for (const r of results) {
  const icon = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
  console.log(`  ${icon} ${r.name}`);
  if (r.error) {
    console.log(`         ${r.error}`);
  }
}

console.log('='.repeat(70));
console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(70) + '\n');

process.exit(failed > 0 ? 1 : 0);
