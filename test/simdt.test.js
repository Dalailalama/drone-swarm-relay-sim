// Finding #28 (review of ffb35e6, B11): the browser stepped at 0.05 s while
// batch and the benchmark stepped at 0.25 s — equal seeds and settings did
// NOT reproduce identical trajectories across runtimes, and the committed
// ms/tick baseline measured a simulator the product doesn't run. One step
// policy, defined once, consumed everywhere.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('regression #28: the step policy is defined once and shared', () => {
  const { SIM_DT_SEC } = require('../js/swarm.js');
  assert.strictEqual(SIM_DT_SEC, 0.05, 'canonical step must exist in shared code');
  // Both non-browser runtimes consume the shared constant…
  assert.ok(/SIM_DT_SEC/.test(src('tools/batch.js')), 'batch must use the shared step');
  assert.ok(/SIM_DT_SEC/.test(src('bench/run.js')), 'benchmark must use the shared step');
  assert.ok(/FIXED_SIM_STEP_SEC = SIM_DT_SEC/.test(src('js/main.js')), 'browser must use the shared step');
  // …and none of them keeps a private hardcoded one.
  assert.ok(!/stepSwarm\(s, 0\.25\)/.test(src('tools/batch.js')), 'batch still hardcodes dt 0.25');
  assert.ok(!/stepSwarm\(s, 0\.25\)/.test(src('bench/run.js')), 'bench still hardcodes dt 0.25');
});

test('regression #28: batch runs replay the browser-step trajectory exactly', () => {
  // Two independently-loaded contexts, same seed/settings, both stepped at
  // the shared dt: positions must match to the bit — that is what "equal
  // seeds reproduce identical trajectories" means.
  const { loadCore } = require('./helpers/sim.js');
  const { SIM_DT_SEC } = require('../js/swarm.js');
  const R = require('../js/radios.js');
  const A = require('../js/airframes.js');
  const mk = () => {
    const ctx = loadCore();
    const s = ctx.makeSwarm({
      count: 5, airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
      radio: R.RADIOS.find(r => r.id === 'sik-v3'), envFactor: 1,
      targetX: 500, targetY: -100, altitudeM: 50, seed: 77,
    });
    return { ctx, s };
  };
  const a = mk(), b = mk();
  for (let t = 0; t < 30; t += SIM_DT_SEC) {
    a.ctx.stepSwarm(a.s, SIM_DT_SEC);
    b.ctx.stepSwarm(b.s, SIM_DT_SEC);
  }
  for (let i = 0; i < a.s.drones.length; i++) {
    assert.strictEqual(a.s.drones[i].x, b.s.drones[i].x, 'x diverged for drone ' + i);
    assert.strictEqual(a.s.drones[i].y, b.s.drones[i].y, 'y diverged for drone ' + i);
  }
  assert.strictEqual(a.s.net.delivered, b.s.net.delivered, 'traffic history diverged');
});
