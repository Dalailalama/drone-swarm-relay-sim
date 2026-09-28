// Soak-audit hygiene findings (issue #26).
//  R5: the learned coverage map's trim (O9) sorted by `at` BEFORE stamping
//      the entry it had just inserted, so the newest cell sorted as the
//      oldest and was evicted — its measurement lost ("never newest" broken).
//  R9: jammerDenialRadiusM tested `j.band - freqMHz` directly: named bands
//      ('sub1g', '2.4g', '5g') and freqMHz-only sources read NaN and counted
//      as in-band — a red zone (and planner padding) for sources that cannot
//      jam the radio. The interference model already used jammerFreqMHz.
//  covSeqApplied: C2's black-box dedup set grew by one entry per dead-zone
//      sample for the whole mission (unbounded).
//  Swap churn: with wind at/above the airframe's max airspeed, a relaunched
//      drone instantly went RTB and re-landed; every 90 s ground cycle then
//      counted as another battery swap.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const ESPNOW = R.RADIOS.find(r => r.id === 'espnow');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('R5: trimming the coverage map never evicts the cell just measured', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 2, airframe: Q450, radio: SIK, envFactor: 1, targetX: 400, targetY: 0, seed: 1 });
  const cell = s.covCellM;
  for (let i = 0; i < 20000; i++) { s.time = 1000 + i * 0.01; ctx.covMark(s, (i % 200) * cell + 1, Math.floor(i / 200) * cell + 1, 'good'); }
  s.time = 5000;
  const x = -999 * cell + 1, y = -999 * cell + 1;
  ctx.covMark(s, x, y, 'bad', 3);
  assert.strictEqual(ctx.covState(s, x, y), 'bad', 'the fresh dead-zone sample was thrown away by the trim');
  assert.ok(s.c2.cov.size <= 18001, 'the trim still sheds the oldest tenth, size ' + s.c2.cov.size);
  assert.ok(!s.c2.cov.has(ctx.covKey(s, 1, 1)), 'the oldest cell goes first');
});

test('R9: the denial radius uses the same band test as the interference model', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 2, airframe: Q450, radio: ESPNOW, envFactor: 1, targetX: 800, targetY: 0, seed: 1 });
  const radius = j => ctx.jammerDenialRadiusM(s, Object.assign({ x: 0, y: 0, erpDbm: 30, on: true }, j));
  for (const j of [{ band: 'sub1g' }, { band: '5g' }, { freqMHz: 915 }, { band: 915 }, { band: 'foo' }]) {
    assert.strictEqual(radius(j), 0, JSON.stringify(j) + ' cannot jam a 2.4 GHz radio yet shows a red zone');
  }
  for (const j of [{ band: 'all' }, { band: '2.4g' }, { freqMHz: 2400 }, { band: 2450 }]) {
    assert.ok(radius(j) > 0, JSON.stringify(j) + ' is in band and must have a denial radius');
  }
});

test('covSeqApplied: black-box dedup memory stays bounded and still dedups', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 2, airframe: Q450, radio: SIK, envFactor: 1, targetX: 600, targetY: 0, altitudeM: 50, seed: 42 });
  const d = s.drones[0];
  const upload = samples => {
    s.c2.inbox.push({ kind: 'tlm', src: d.id, dst: 'C2', payload: { x: 100, y: 0, battery: 90, role: 'mission',
      deadLog: samples, deadLogMaxSeq: Math.max(...samples.map(p => p.seq)), deadLogSession: d.deadLogSession } });
    ctx.c2Step(s);
  };
  const weight = () => { const e = s.c2.cov.get(ctx.covKey(s, 500, 0)); return e ? e.bad : 0; };
  // A long mission: the drone keeps a rolling window of up to 20 unacked samples.
  for (let k = 1; k <= 400; k++) {
    const win = [];
    for (let q = Math.max(1, k - 19); q <= k; q++) win.push({ x: 500, y: 0, seq: q });
    upload(win);
  }
  assert.strictEqual(weight(), 400 * 3, 'each sample applies exactly once');
  const sizes = [...s.c2.covSeqApplied.values()].map(v => (v.seen ? v.seen.size : v.size));
  assert.ok(Math.max(...sizes) <= 64, 'dedup memory grew with mission length: ' + sizes.join(','));
  upload([{ x: 500, y: 0, seq: 3 }]);     // ancient replay (lost ACK long ago)
  upload([{ x: 500, y: 0, seq: 399 }]);   // recent replay
  assert.strictEqual(weight(), 400 * 3, 'a replay re-applied a sample');
  upload([{ x: 500, y: 0, seq: 401 }]);
  assert.strictEqual(weight(), 401 * 3, 'new samples still apply');
});

test('wind at or above airframe max: no relaunch churn, no phantom swaps', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 1, airframe: Q450, radio: SIK, envFactor: 1, targetX: 600, targetY: 0, seed: 42, windX: 15, windY: 0 });
  const d = s.drones[0];
  d.mode = 'landed'; d.x = 10; d.y = 0; d.vx = d.vy = 0; d.swapAt = 1; // downwind of the pad, pack swap due
  for (let i = 0; i < 20 * 200; i++) ctx.stepSwarm(s, 0.05);
  assert.strictEqual(s.stats.swaps || 0, 0, 'relaunch into unflyable wind counted ' + (s.stats.swaps || 0) + ' swaps');
  assert.strictEqual(d.mode, 'landed', 'the crew holds the launch while the wind beats the airframe');
  // Wind drops: the held drone gets its fresh pack and flies — one swap.
  s.wind.x = 5;
  for (let i = 0; i < 20 * 5; i++) ctx.stepSwarm(s, 0.05);
  assert.strictEqual(s.stats.swaps, 1);
  assert.notStrictEqual(d.mode, 'landed');
});
