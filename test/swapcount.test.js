// Finding #29 (review of ffb35e6, B28): the lifetime swap counter keyed on
// log-message text and matched BOTH 'swap in progress' (landing) and
// 'swapped' (relaunch) — one physical battery swap reported as two. Count
// the completed state transition, once.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('regression #29: one complete battery swap counts exactly once', () => {
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  const d = s.drones[0];
  d.mode = 'rtb'; d.x = 5; d.y = 0; d.vx = 0; d.vy = 0; // over the pad, coming in
  // Land -> 90 s ground-crew swap -> relaunch: the full cycle, one swap.
  for (let i = 0; i < 480; i++) ctx.stepSwarm(s, 0.25); // 120 s
  assert.ok(d.mode !== 'landed', 'drone must have relaunched (mode=' + d.mode + ')');
  assert.strictEqual(s.stats.swaps || 0, 1,
    'one physical swap must count once, got ' + (s.stats.swaps || 0));
});
