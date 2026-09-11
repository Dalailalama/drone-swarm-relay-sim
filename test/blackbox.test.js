// Test suite reproducing black box sample retention without network ACK (B18).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('reproduction B18: black box samples must be retained until delivery and ACK', () => {
  const s = ctx.makeSwarm({
    count: 2,
    airframe: Q450,
    radio: SIK,
    envFactor: 1,
    targetX: 500, targetY: 0,
    altitudeM: 50,
    seed: 42,
  });

  const d = s.drones[0];
  d.deadLog = [
    { seq: 1, x: 100, y: 50 },
    { seq: 2, x: 110, y: 55 },
  ];

  // Move C2/base far away so there is NO route
  s.base.x = -50000; s.base.y = -50000;
  d.nextTlm = s.time; // trigger telemetry

  ctx.stepSwarm(s, 0.25);

  // Since packet had no route and was dropped, deadLog samples must not be discarded!
  assert.ok(d.deadLog && d.deadLog.length >= 2,
    'deadLog samples must be retained when no route exists to deliver them');
});
