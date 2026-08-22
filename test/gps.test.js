// GPS-denied navigation tests — believed-position drift inside denial zones,
// poisoned telemetry, belief-based steering error, and C2 hedging its relay
// plan away from zones it can't trust positions inside.

const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../js/gpsnav.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(); // CORE already includes gpsnav.js
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('gpsDeniedAt: inside / outside / toggled-off zones', () => {
  const zones = [{ x: 500, y: 0, rM: 200, on: true }];
  assert.strictEqual(G.gpsDeniedAt(zones, 600, 0), true);
  assert.strictEqual(G.gpsDeniedAt(zones, 900, 0), false);
  assert.strictEqual(G.gpsDeniedAt([{ x: 500, y: 0, rM: 200, on: false }], 500, 0), false,
    'toggled-off zone denies nothing');
  assert.strictEqual(G.gpsDeniedAt([], 0, 0), false);
});

test('healthy GPS snaps the belief to truth; drift state resets', () => {
  const d = { x: 100, y: 50, vx: 5, vy: -1, belX: 999, belY: -999, dvx: 3, dvy: 4 };
  const b = G.stepBelief(d, 0.25, Math.random, false);
  assert.strictEqual(b.belX, d.x);
  assert.strictEqual(b.belY, d.y);
  assert.strictEqual(b.dvx, 0);
});

test('denied dead reckoning diverges from truth by a plausible, growing amount', () => {
  // Deterministic LCG so the run is repeatable.
  let seedState = 9;
  const detRng = () => {
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
  };
  // A drone flying straight at 10 m/s for 120 s inside a zone.
  const d = { x: 0, y: 0, vx: 10, vy: 0, belX: 0, belY: 0, dvx: 0, dvy: 0 };
  let maxErr = 0;
  for (let t = 0; t < 120; t += 0.25) {
    d.x += d.vx * 0.25; d.y += d.vy * 0.25;
    const b = G.stepBelief(d, 0.25, detRng, true);
    d.belX = b.belX; d.belY = b.belY; d.dvx = b.dvx; d.dvy = b.dvy;
    maxErr = Math.max(maxErr, Math.hypot(d.belX - d.x, d.belY - d.y));
  }
  // Truth travelled 1200 m; the belief must miss by an operationally
  // significant margin — tens of metres, not centimetres, not kilometres.
  assert.ok(maxErr > 20, 'drift must be operationally significant, got ' + maxErr.toFixed(1) + ' m');
  assert.ok(maxErr < 1000, 'drift must stay physically plausible, got ' + maxErr.toFixed(0) + ' m');
});

function runGpsMission(opts, seconds) {
  const s = ctx.makeSwarm(Object.assign({
    count: 6,
    airframe: Q450,
    radio: RFD,
    envFactor: 1,
    targetX: 1400, targetY: -350,
    altitudeM: 60,
    seed: 11,
    // Denial astride the MID-corridor (not the objective — a zone on the
    // objective itself legitimately forces slots into it, mission first).
    gpsZones: [{ id: 'GZ-test', x: 700, y: -180, rM: 280, on: true }],
  }, opts));
  let status = null;
  while (s.time < seconds) status = ctx.stepSwarm(s, 0.25);
  return { s, status };
}

test('drones cross the zone, drift, and poison C2\u2019s picture of them', () => {
  const { s } = runGpsMission({}, 420);
  const denied = s.drones.filter(d => d.hadDenied);
  assert.ok(denied.length >= 1, 'at least one drone must have entered the zone');
  // Peak truth-vs-belief error must be well above the healthy GPS noise floor.
  const peak = Math.max(...denied.map(d => d.peakNavErr || 0));
  assert.ok(peak > 25, 'expected nav error > 25 m while denied, got ' + peak.toFixed(1) + ' m');
  // Any drone STILL inside the zone reports a position that disagrees with
  // truth far more than GNSS noise ever could.
  const still = denied.find(d => d.gpsDenied && s.c2.known[d.id]);
  if (still) {
    const err = Math.hypot(s.c2.known[still.id].x - still.x, s.c2.known[still.id].y - still.y);
    assert.ok(err > 15, 'C2 error for a denied drone should exceed noise, got ' + err.toFixed(1) + ' m');
  }
});

test('C2 hedges: no planned relay slot deep inside an active GPS zone', () => {
  const { s } = runGpsMission({}, 300);
  const plan = s.c2.chainPlan;
  if (!plan || !plan.slots.length) return; // nothing placed — vacuously fine
  for (const slot of plan.slots) {
    for (const z of s.gpsZones) {
      if (z.on === false) continue;
      const dd = Math.hypot(slot.x - z.x, slot.y - z.y);
      assert.ok(dd > z.rM * 0.75,
        'slot placed ' + dd.toFixed(0) + ' m from zone centre (r=' + z.rM + ') — planner must hedge');
    }
  }
});

test('toggling a zone off restores honest navigation instantly', () => {
  const { s } = runGpsMission({ gpsZones: [{ id: 'GZ-x', x: 700, y: -180, rM: 300, on: true }] }, 240);
  s.gpsZones[0].on = false;
  const before = s.drones.map(d => d.gpsDenied);
  ctx.stepSwarm(s, 0.25);
  const after = s.drones.map(d => d.gpsDenied);
  assert.deepStrictEqual(after, before.map(() => false), 'no drone stays denied after toggle-off');
});
