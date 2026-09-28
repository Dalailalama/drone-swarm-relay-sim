// Soak-audit finding R1 (issue #23): an objective exactly on the base made
// makeTerrain('rolling'|'mixed') scale its hills by distM = 0, so
// fbm(x / 0) returned NaN everywhere: every altitude, line-of-sight test and
// link margin became NaN. Unicast (margin > 0) always failed — C2 never heard
// a drone 60 m away — while stepBcasts, which only rejected `m <= 0`,
// delivered broadcasts at ANY range. The batch API accepted the config
// (mission 0,0) and reported 0 % uptime as if it were physics.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('R1: hills stay finite when the objective sits on the base', () => {
  const ctx = loadCore();
  for (const name of ['rolling', 'mixed']) {
    for (const distM of [0, 1e-9, 5]) {
      const t = ctx.makeTerrain(name, { distM, targetX: 0, targetY: 0, seed: 7 });
      for (const [x, y] of [[0, 0], [10, 5], [-250, 900]]) {
        assert.ok(Number.isFinite(ctx.terrainGroundAt(t, x, y)),
          name + ' distM=' + distM + ': ground at (' + x + ',' + y + ') = ' + ctx.terrainGroundAt(t, x, y));
      }
    }
  }
});

test('R1: a target-on-base mission over hills keeps a working C2 link', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 4, airframe: Q450, radio: SIK, envFactor: 1, targetX: 0, targetY: 0, seed: 7,
    terrain: ctx.makeTerrain('rolling', { distM: 0, targetX: 0, targetY: 0, seed: 7 }),
  });
  for (let i = 0; i < 20 * 40; i++) ctx.stepSwarm(s, 0.05);
  for (const d of s.drones) {
    assert.ok(Number.isFinite(d.upMarginEma), d.id + ' upMarginEma = ' + d.upMarginEma);
    assert.ok(Number.isFinite(ctx.liveMarginDb(s, 'C2', d.id)) || ctx.liveMarginDb(s, 'C2', d.id) === -Infinity, d.id + ' margin is NaN');
  }
  assert.ok(Object.keys(s.c2.known).length > 0, 'C2 never heard a single drone orbiting 60 m away');
});

test('R1: a NaN link margin never delivers a broadcast', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 4, airframe: Q450, radio: SIK, envFactor: 1, targetX: 300, targetY: 0, seed: 3 });
  ctx.liveMarginDb = () => NaN; // what a NaN world produced for every link
  for (let i = 0; i < 20 * 5; i++) ctx.stepSwarm(s, 0.05);
  assert.strictEqual(s.net.delivered, 0, 'packets were delivered over NaN-margin links');
  assert.ok(s.drones.every(d => d.bcastSeen === 0), 'a drone accepted a broadcast over a NaN link');
});
