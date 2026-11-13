// Relink transit allowance vs the wind (review). An attempt that cannot
// reach its relink point expires after relinkTransitFactor x its transit
// time plus the listen time — but the transit was sized on AIRSPEED, so in a
// strong headwind a point the drone was steadily closing on expired before
// it got there and the ladder fell back a step it never needed. The
// allowance must be sized on the ground speed along the leg, the same
// w.u + sqrt(V^2 - w_perp^2) the energy feasibility flies.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const DT = 0.05; // SIM_DT_SEC

test('in a strong headwind a reachable relink point is reached before the attempt expires', () => {
  // Wind blows away from base at 70 % of airspeed: the 1000 m retreat to the
  // last-link point closes at ~4.2 m/s ground speed, well past the
  // airspeed-sized allowance (2 x 1000 / 14 + 35 = 178 s).
  const w = 0.7 * Q450.maxSpeedMs;
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 3, windX: w, windY: 0,
  });
  const d = s.drones[0];
  s.c2.nextCmd = Infinity; // C2 stays silent
  s.time = 100; d.lastC2 = 0;
  d.x = d.belX = 1500; d.y = d.belY = 0; d.vx = w; d.vy = 0;
  d.lastLinkX = 500; d.lastLinkY = 0;
  d.mode = 'hold'; d.holdX = 1500; d.holdY = 0;
  let arrivedAt = null, relinkAt = null;
  while (s.time < 700 && arrivedAt == null && d.relinkAttempt <= 1 && d.mode !== 'rtb') {
    ctx.stepSwarm(s, DT);
    if (relinkAt == null && d.mode === 'relink') relinkAt = s.time;
    if (d.mode === 'relink' && d.relinkAttempt === 1 && d.relinkUntil != null) arrivedAt = s.time;
  }
  assert.ok(relinkAt != null, 'the ladder must reach relink');
  assert.notStrictEqual(d.mode, 'rtb', 'the battery is not the limit here');
  assert.ok(arrivedAt != null,
    'attempt 1 expired at t=' + s.time.toFixed(0) + ' s (' + (s.time - relinkAt).toFixed(0) +
    ' s after relink began) ' + Math.hypot(d.belX - 500, d.belY).toFixed(0) + ' m short of a point it was closing on');
});

test('with no wind the allowance is unchanged: twice the airspeed transit plus the listen time (guard)', () => {
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 3,
  });
  const d = s.drones[0];
  s.time = 100;
  d.x = d.belX = 1500; d.y = d.belY = 0;
  d.relinkGoalX = 500; d.relinkGoalY = 0;
  const F = ctx.consts.FAILSAFE;
  const expect = s.time + F.relinkTransitFactor * 1000 / Q450.maxSpeedMs + F.relinkWaitSec;
  assert.ok(Math.abs(ctx.relinkGiveUpAt(s, d) - expect) < 1e-9);
});

test('a leg the drone cannot fly at all still expires, so the ladder moves on (guard)', () => {
  // Headwind above airspeed: ground speed along the leg is zero.
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 3, windX: Q450.maxSpeedMs + 2, windY: 0,
  });
  const d = s.drones[0];
  s.time = 100;
  d.x = d.belX = 1500; d.y = d.belY = 0;
  d.relinkGoalX = 500; d.relinkGoalY = 0;
  assert.ok(Number.isFinite(ctx.relinkGiveUpAt(s, d)), 'an unflyable leg must still have a finite deadline');
});
