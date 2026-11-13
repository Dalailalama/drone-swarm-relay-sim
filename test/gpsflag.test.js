// Audit C2-08: drones tell C2 when they have lost their GNSS fix
// (gps:'denied' in telemetry) but nothing read the flag. C2 painted every
// report 'good' at the reported (dead-reckoned) position, up to ~290 m from
// where the drone really was, and the same positions called off rescue
// searches, anchored rescue chains and scored relay elections.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function swarm() {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 6, airframe: Q450, radio: SIK, envFactor: 1, targetX: 1000, targetY: 0, seed: 7 });
  s.time = 100;
  return { ctx, s };
}

function report(s, id, x, y, gps) {
  return { src: id, payload: { x, y, gps, battery: 90, role: 'mission', cls: 'mission', posAt: s.time } };
}

test('C2-08: a GPS-denied report paints no good coverage at its dead-reckoned position', () => {
  const { ctx, s } = swarm();
  s.c2.inbox.push(report(s, s.drones[0].id, 700, 400, 'denied'));
  ctx.c2Step(s);
  const e = s.c2.cov.get(ctx.covKey(s, 700, 400));
  assert.ok(!e || e.good === 0, 'denied position marked good ' + (e && e.good) + 'x');
  // guard: a report with a fix is still a coverage measurement
  s.c2.inbox.push(report(s, s.drones[1].id, 900, -400, 'ok'));
  ctx.c2Step(s);
  assert.ok(s.c2.cov.get(ctx.covKey(s, 900, -400)).good > 0);
});

function lostNear(gps) {
  const { ctx, s } = swarm();
  const lost = s.drones[5];
  ctx.killDrone(s, lost);
  s.c2.lost[lost.id] = { x: 500, y: 0, at: s.time - 20 };
  // The only drone C2 hears near the last-known point reports from 20 m away.
  s.c2.inbox.push(report(s, s.drones[0].id, 520, 0, gps));
  s.c2.nextCmd = 0;
  ctx.c2Step(s);
  return { s, lostId: lost.id };
}

test('C2-08: a search is not called off on the word of a GPS-denied position', () => {
  const { s, lostId } = lostNear('denied');
  assert.ok(lostId in s.c2.lost, 'search called off because a dead-reckoned position claimed to cover it');
});

test('C2-08: a drone with a fix at the last-known point still calls the search off (guard)', () => {
  const { s, lostId } = lostNear('ok');
  assert.ok(!(lostId in s.c2.lost));
});
