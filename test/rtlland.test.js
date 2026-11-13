// Audit swarm-onboard/ONB-01: a drone that ran out the link-loss ladder flew
// home in 'rtl' and never landed — the landing gate only took 'rtb' (and
// only measured against the LIVE true base). With C2 silent it hovered over
// the pad until the pack was empty (dead at t≈1300 s, 0.2 m from base), and
// an RTB drone flying to its last-KNOWN home after the operator moved in
// radio silence died the same way 3 km from the new base.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const DT = 0.05; // SIM_DT_SEC

function mk() {
  return ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
}

function runUntilDown(s, d, maxSec) {
  while (s.time < maxSec && d.mode !== 'landed' && d.mode !== 'dead') ctx.stepSwarm(s, DT);
}

test('ONB-01: an rtl drone that reaches home with C2 still silent lands for a swap instead of hovering to death', () => {
  const s = mk();
  const d = s.drones[0];
  s.c2.nextCmd = Infinity; // C2 never transmits
  runUntilDown(s, d, 1500);
  assert.strictEqual(d.mode, 'landed', 'ended ' + d.mode + ' at t=' + s.time.toFixed(0) + ' s');
  assert.ok(!s.events.some(e => /battery exhausted/.test(e.msg)), 'the drone must not run its pack flat over the pad');
  assert.ok(d.swapAt != null, 'home is where the crew is — the battery swap must start');
});

test('ONB-01: an RTB drone landing at a stale last-known home lands without a phantom swap', () => {
  const s = mk();
  const d = s.drones[0];
  s.c2.nextCmd = Infinity;
  d.x = d.belX = 3000; d.y = d.belY = 0; d.vx = d.vy = 0;
  d.mode = 'rtb';
  s.base.x = 0; s.base.y = 3000; // operator relocates while the drone is deaf
  runUntilDown(s, d, 1500);
  assert.strictEqual(d.mode, 'landed', 'ended ' + d.mode + ' at t=' + s.time.toFixed(0) + ' s');
  assert.ok(Math.hypot(d.x, d.y) < 25, 'it lands where it last knew home was');
  assert.strictEqual(d.swapAt, null, 'no ground crew at the stale home — no battery swap');
  for (let i = 0; i < 2400; i++) ctx.stepSwarm(s, DT);
  assert.strictEqual(d.mode, 'landed', 'nobody relaunches a drone the crew never reached');
});

test('ONB-01: smart-RTH also watches an rtl drone, so a long silent trek home turns into a committed RTB', () => {
  const s = mk();
  const d = s.drones[0];
  s.c2.nextCmd = Infinity;
  d.x = d.belX = 3000; d.y = d.belY = 0;
  d.mode = 'rtl';
  d.energyWh = A.usableWh(Q450) * 0.05;
  ctx.updateBattery(s, d, DT, 0);
  assert.strictEqual(d.mode, 'rtb');
});
