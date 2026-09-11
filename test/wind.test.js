// Test suite reproducing wind feasibility bugs (B21, B22).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450'); // maxSpeedMs is typically 14 m/s

test('reproduction B21: impossible upwind recovery must be rejected', () => {
  const s = ctx.makeSwarm({
    count: 4,
    airframe: Q450,
    radio: SIK,
    envFactor: 1,
    targetX: 2000, targetY: 0,
    altitudeM: 50,
    seed: 42,
  });

  // Set strong wind exceeding max airspeed blowing away from base (headwind for return)
  // Q450 maxSpeedMs is 14 m/s. Wind is 16 m/s East.
  s.wind = { x: 16, y: 0 };

  const d = s.drones[0];
  d.x = 500; d.y = 0;
  const order = { role: 'mission', target: { x: 2000, y: 0 }, slot: 0, k: 0 };

  // orderFeasible should return false when upwind return is impossible (wind 16 m/s > maxSpeed 14 m/s)
  const feasible = ctx.orderFeasible(s, d, order);
  assert.strictEqual(feasible, false, 'order must be infeasible when return against wind is physically impossible');
});

test('reproduction B22: tailwind must increase ground speed up to airspeed + wind', () => {
  const s = ctx.makeSwarm({
    count: 4,
    airframe: Q450,
    radio: SIK,
    envFactor: 1,
    targetX: 3000, targetY: 0,
    altitudeM: 50,
    seed: 42,
  });

  // Wind 10 m/s blowing East toward target
  s.wind = { x: 10, y: 0 };

  // Step several seconds to allow drone to accelerate toward target
  for (let i = 0; i < 40; i++) ctx.stepSwarm(s, 0.25);

  const d = s.drones[0];
  const maxV = ctx.afOf(s, d).maxSpeedMs; // e.g. 14 m/s
  // With 10 m/s tailwind, ground speed vx should exceed maxV (up to maxV + wind = 24 m/s)
  assert.ok(d.vx > maxV + 1, 'tailwind should increase ground speed beyond max airspeed (' + maxV + ' m/s), got ' + d.vx.toFixed(1));
});
