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
});

test('telemetry from a denied drone poisons C2’s picture: C2 tracks the belief, not truth', () => {
  // Sampled DURING the run: by the end no drone is still inside the zone, so
  // an end-of-run check never executes. Every tick a drone is denied and its
  // belief has drifted well past GNSS noise, ask which one C2's picture sits
  // closer to.
  const s = ctx.makeSwarm({
    count: 6, airframe: Q450, radio: RFD, envFactor: 1,
    targetX: 1400, targetY: -350, altitudeM: 60, seed: 11,
    gpsZones: [{ id: 'GZ-test', x: 700, y: -180, rM: 280, on: true }],
  });
  let samples = 0, poisoned = 0;
  while (s.time < 420) {
    ctx.stepSwarm(s, 0.25);
    for (const d of s.drones) {
      const k = s.c2.known[d.id];
      if (!d.gpsDenied || !k || Math.hypot(d.belX - d.x, d.belY - d.y) <= 25) continue;
      samples++;
      if (Math.hypot(k.x - d.belX, k.y - d.belY) < Math.hypot(k.x - d.x, k.y - d.y)) poisoned++;
    }
  }
  assert.ok(samples >= 20, 'expected drifted denied drones known to C2, got ' + samples + ' samples');
  assert.ok(poisoned > samples / 2,
    'C2 should hold the drifted belief, not truth: ' + poisoned + '/' + samples + ' samples');
});

test('C2 hedges: no planned relay slot deep inside an active GPS zone', () => {
  // SiK (not the 40 km RFD900x) with 12 drones, so the objective actually
  // needs relay slots and the hedge has something to act on.
  const { s } = runGpsMission({ radio: SIK, count: 12 }, 300);
  const plan = s.c2.chainPlan;
  assert.ok(plan && plan.slots.length >= 1, 'the mission must need relay slots for this check to mean anything');
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

// Audit swarm-onboard/NAV-01: dead reckoning integrated the TRUE ground
// velocity, so a GNSS-denied drone knew the wind perfectly — even a wind
// that rose after the fix was lost. It now integrates airspeed plus the
// wind estimate it held when GNSS went away.
function lcg(seed) {
  let st = seed;
  return () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
}

test('NAV-01: a wind that rises after GNSS is lost drifts the drone where its belief cannot follow', () => {
  // Calm when the fix dropped; then 10 m/s from the west. Zero airspeed, so
  // the drone is blown 600 m east in a minute — its belief knows only calm.
  const rng = lcg(9);
  const wind = { x: 10, y: 0 };
  const d = { x: 0, y: 0, vx: 10, vy: 0, belX: 0, belY: 0, dvx: 0, dvy: 0, windEstX: 0, windEstY: 0 };
  for (let t = 0; t < 60; t += 0.25) {
    d.x += d.vx * 0.25;
    const b = G.stepBelief(d, 0.25, rng, true, wind);
    d.belX = b.belX; d.belY = b.belY; d.dvx = b.dvx; d.dvy = b.dvy;
  }
  const err = Math.hypot(d.belX - d.x, d.belY - d.y);
  assert.ok(err > 400 && err < 800, 'nav error ' + err.toFixed(0) + ' m — expected ~600 m of unmodelled wind');
});

test('NAV-01: an unchanged wind cancels exactly — only the OU drift remains', () => {
  const run = (windArg, est) => {
    const rng = lcg(9);
    const d = { x: 0, y: 0, vx: 10, vy: 0, belX: 0, belY: 0, dvx: 0, dvy: 0, windEstX: est, windEstY: 0 };
    for (let t = 0; t < 60; t += 0.25) {
      d.x += d.vx * 0.25;
      const b = G.stepBelief(d, 0.25, rng, true, windArg);
      d.belX = b.belX; d.belY = b.belY; d.dvx = b.dvx; d.dvy = b.dvy;
    }
    return [d.belX, d.belY];
  };
  assert.deepStrictEqual(run({ x: 10, y: 0 }, 10), run(undefined, 0));
});

test('NAV-01: while GNSS is healthy the wind estimate tracks the wind', () => {
  const b = G.stepBelief({ x: 1, y: 2, vx: 0, vy: 0, belX: 0, belY: 0, dvx: 0, dvy: 0 }, 0.05, Math.random, false, { x: 3, y: -4 });
  assert.strictEqual(b.windEstX, 3);
  assert.strictEqual(b.windEstY, -4);
});

test('NAV-01: in the sim the wind estimate freezes at GNSS loss and resumes with the fix', () => {
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: RFD, envFactor: 1, targetX: 600, targetY: 0,
    altitudeM: 60, seed: 11, windX: 3, windY: 0,
    gpsZones: [{ id: 'GZ-w', x: 0, y: 0, rM: 5000, on: true }],
  });
  const d = s.drones[0];
  ctx.stepSwarm(s, 0.05);
  s.wind.x = 8; // the wind rises after the fix is gone
  for (let i = 0; i < 20; i++) ctx.stepSwarm(s, 0.05);
  assert.strictEqual(d.windEstX, 3, 'a denied drone cannot track a wind change');
  s.gpsZones[0].on = false;
  ctx.stepSwarm(s, 0.05);
  assert.strictEqual(d.windEstX, 8, 'with GNSS back the estimate catches up');
});
