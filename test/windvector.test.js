// Finding #2 (review of ffb35e6, B21): feasibility and battery-return math
// used max(1, maxSpeed - |wind|) — a scalar. Two failure modes:
//  * wind >= max airspeed floors an IMPOSSIBLE leg to "1 m/s", so a short
//    upwind return is accepted on battery cost (reviewer's probe);
//  * a fully-downwind mission is billed at near-stall speed and rejected
//    even though the real ground speed is maxV + wind.
// Legs must be solved with the wind VECTOR and rejected explicitly when
// unflyable — the same envelope math the movement integrator already uses.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450'); // 14 m/s max airspeed

function mkSwarm(windX, targetX) {
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.wind = { x: windX, y: 0 };
  return s;
}

test('regression #2: order with an unflyable upwind return leg is rejected', () => {
  // Reviewer probe: full-battery Q450 at x=50, mission at x=100, 16 m/s east
  // wind vs 14 m/s max airspeed. Outbound is a breeze; the westbound return
  // is impossible at ANY battery level — ground speed would be -2 m/s.
  const s = mkSwarm(16, 100);
  const d = s.drones[0];
  d.x = 50; d.y = 0;
  d.energyWh = ctx.usableWh(Q450); // full battery — must not save the order
  const ok = ctx.orderFeasible(s, d, { role: 'mission', target: { x: 100, y: 0 } });
  assert.strictEqual(ok, false, 'accepted a mission whose return leg cannot be flown');
});

test('regression #2: fully-downwind mission is no longer billed at stall speed', () => {
  // Base far east, target on the way: every leg rides a 13 m/s tailwind at
  // ~27 m/s ground speed. The scalar model billed both legs at 1 m/s and
  // rejected on battery; the vector model must accept.
  const s = mkSwarm(13, 100);
  s.base = { x: 2000, y: 0 };
  const d = s.drones[0];
  d.x = 50; d.y = 0;
  d.energyWh = ctx.usableWh(Q450);
  const ok = ctx.orderFeasible(s, d, { role: 'mission', target: { x: 100, y: 0 } });
  assert.strictEqual(ok, true, 'rejected an easy all-downwind mission');
});

test('moderate headwind home stays accepted when battery covers it', () => {
  // 8 m/s wind: home leg is a real but flyable 6 m/s grind. Guards against
  // the fix over-rejecting.
  const s = mkSwarm(8, 100);
  const d = s.drones[0];
  d.x = 50; d.y = 0;
  d.energyWh = ctx.usableWh(Q450);
  const ok = ctx.orderFeasible(s, d, { role: 'mission', target: { x: 100, y: 0 } });
  assert.strictEqual(ok, true, 'rejected a feasible mission in moderate wind');
});

test('regression #2: onboard RTH triggers immediately when the home leg becomes unflyable', () => {
  // Drone 100 m downwind of base in wind above its airspeed: it can never
  // get home, and the honest onboard response is to alarm and turn back NOW
  // rather than burn battery pretending a "1 m/s" return exists.
  const s = mkSwarm(16, 600);
  const d = s.drones[0];
  d.x = 100; d.y = 0; d.vx = 0; d.vy = 0;
  d.mode = 'ok';
  d.energyWh = ctx.usableWh(Q450);
  ctx.stepSwarm(s, 0.05);
  assert.strictEqual(d.mode, 'rtb', 'drone kept flying with an unflyable home leg (mode=' + d.mode + ')');
});
