// Red-team adversary tests — the hunter must be honest (sensor-driven,
// speed-limited, holds when nobody transmits) and effective (it converges
// on traffic and measurably hurts a static chain).

const { test } = require('node:test');
const assert = require('node:assert');

const ADV = require('../js/adversary.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['adversary.js']);

test('trafficCentroid: recency-weighted mean, null with no fresh contacts', () => {
  const c = ADV.trafficCentroid([
    { x: 0, y: 0, age: 100 },    // age 0 at "now" — weight 1
    { x: 100, y: 20, age: 99 },  // age 1 — weight e^(-1/8)
    { x: 9999, y: 9999, age: 5 },// stale long before "now"
  ], 100);
  const w1 = Math.exp(-1 / ADV.ADVERSARY.weightTauSec);
  assert.ok(Math.abs(c.x - (100 * w1) / (1 + w1)) < 1e-6,
    'x must be the recency-weighted mean, got ' + c.x.toFixed(2));
  assert.ok(Math.abs(c.y - (20 * w1) / (1 + w1)) < 1e-6);
  assert.strictEqual(ADV.trafficCentroid([{ x: 5, y: 5, age: 0 }], 500), null,
    'nothing inside the sense window -> no target');
});

test('adversaryStep: displacement capped by speed, holds at the emitter', () => {
  const far = ADV.adversaryStep({ x: 0, y: 0 }, { x: 10000, y: 0 }, 9, 1);
  assert.ok(Math.abs(far.x - 9) < 1e-9, 'moves exactly speed*dt toward target');
  const near = ADV.adversaryStep({ x: 90, y: 0 }, { x: 100, y: 0 }, 9, 10);
  assert.strictEqual(near.x, 90, 'inside hold-off radius it stops jittering');
});

function makeSw(opts) {
  return ctx.makeSwarm(Object.assign({
    count: 8,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: R.RADIOS.find(r => r.id === 'rfd900x'),
    envFactor: 1,
    targetX: 2200, targetY: -550,
    altitudeM: 60,
    seed: 33,
    jammers: [{ id: 'JX-hunt', x: -900, y: 700, erpDbm: 26, band: 'all', altM: 15, on: true }],
    adversaryMode: true,
  }, opts));
}

test('hunter converges on the swarm\u2019s corridor from far away', () => {
  const s = makeSw({});
  let st = null;
  while (s.time < 150) st = ctx.stepSwarm(s, 0.25);
  const j = s.jammers[0];
  // Traffic lives along base->target; start point (-900,700) is ~1.6 km off it.
  const dStart = Math.hypot(-900 - 1100, 700 + 275);   // to corridor midpoint
  const dEnd = Math.hypot(j.x - 1100, j.y + 275);
  assert.ok(dEnd < dStart * 0.55,
    'hunter must close most of the gap: ' + dStart.toFixed(0) + ' -> ' + dEnd.toFixed(0) + ' m');
  assert.ok(s.advStats.movedM > 300, 'movement accounting: ' + s.advStats.movedM.toFixed(0) + ' m');
});

test('without red-team mode the source sits exactly where placed', () => {
  const s = makeSw({ adversaryMode: false });
  let st = null;
  while (s.time < 60) st = ctx.stepSwarm(s, 0.25);
  assert.strictEqual(s.jammers[0].x, -900);
  assert.strictEqual(s.jammers[0].y, 700);
});

test('silent swarm gives the hunter nothing to chase', () => {
  const s = makeSw({ count: 2 });
  s.net.txAt['DR-1'] = -999;   // transmissions only in the deep past
  s.drones.forEach(d => { d.mode = 'landed'; }); // no alive talkers
  const before = { x: s.jammers[0].x, y: s.jammers[0].y };
  ctx.stepAdversaries(s, 1);
  assert.strictEqual(s.jammers[0].x, before.x);
});

test('hunted swarm loses uptime versus static jammer of equal power', () => {
  function run(adaptive) {
    const s = makeSw({ adversaryMode: adaptive, envFactor: 0.45 });
    let st = null;
    while (s.time < 240) st = ctx.stepSwarm(s, 0.25);
    return 100 * s.stats.connSec / s.stats.tSec;
  }
  const hunted = run(true), still = run(false);
  assert.ok(hunted <= still + 1,
    'a moving hunter should not help the swarm: hunted=' + hunted.toFixed(1) +
    '% static=' + still.toFixed(1) + '%');
});
