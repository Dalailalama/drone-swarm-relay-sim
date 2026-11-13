// Relink listen window vs the announced order cadence (review). A drone on
// the link-loss ladder listens at each relink point for FAILSAFE.relinkWaitSec
// — a fixed 35 s even when C2 has announced a much slower order round (slow
// unicast LoRa), so the window could be shorter than ONE round and the drone
// moved on before C2 could even reach it. The hold rule already scales with
// the announced cadence (three order rounds, never under its floor); the
// listen window must do the same.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const DT = 0.05; // SIM_DT_SEC
const SLOW = { tlmSec: 30, cmdSec: 20 }; // one order round every 20 s

function mk() {
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 3,
  });
  s.c2.nextCmd = Infinity; // C2 stays silent
  s.time = 500;
  const d = s.drones[0];
  d.linkCadence = { ...SLOW };
  d.lastC2 = 0;
  d.x = d.belX = 1000; d.y = d.belY = 0; d.vx = d.vy = 0;
  return { s, d };
}

test('at a relink point a drone listens for at least three announced order rounds', () => {
  const { s, d } = mk();
  d.mode = 'relink'; d.relinkAttempt = 1;
  d.relinkGoalX = 1000; d.relinkGoalY = 0; // already at the point
  d.relinkUntil = null; d.relinkGiveUpAt = s.time + 1000;
  const t0 = s.time;
  ctx.stepSwarm(s, DT);
  assert.ok(d.relinkUntil != null, 'the drone must have arrived');
  const wait = d.relinkUntil - t0;
  assert.ok(wait >= 3 * SLOW.cmdSec,
    'listened ' + wait.toFixed(1) + ' s — under three ' + SLOW.cmdSec + ' s order rounds');
});

test('an unreachable relink point allows the same scaled listen time on top of its transit', () => {
  const { s, d } = mk();
  d.lastLinkX = 500; d.lastLinkY = 0; // attempt 1 retreats 500 m
  d.mode = 'hold'; d.holdX = 1000; d.holdY = 0;
  const t0 = s.time;
  ctx.stepSwarm(s, DT);
  assert.strictEqual(d.mode, 'relink', 'the silence is long past the hold-to-relink timeout');
  const transit = ctx.consts.FAILSAFE.relinkTransitFactor * 500 / Q450.maxSpeedMs;
  assert.ok(d.relinkGiveUpAt - t0 >= transit + 3 * SLOW.cmdSec - 1,
    'gives up ' + (d.relinkGiveUpAt - t0).toFixed(1) + ' s out — under transit ' + transit.toFixed(1) +
    ' s plus three ' + SLOW.cmdSec + ' s order rounds');
});

test('on the default cadence the listen window keeps its 35 s floor (guard)', () => {
  const { s, d } = mk();
  d.linkCadence = null;
  d.mode = 'relink'; d.relinkAttempt = 1;
  d.relinkGoalX = 1000; d.relinkGoalY = 0;
  d.relinkUntil = null; d.relinkGiveUpAt = s.time + 1000;
  const t0 = s.time;
  ctx.stepSwarm(s, DT);
  assert.ok(Math.abs(d.relinkUntil - t0 - ctx.consts.FAILSAFE.relinkWaitSec) < 2 * DT,
    'listened ' + (d.relinkUntil - t0).toFixed(2) + ' s on the default cadence');
});
