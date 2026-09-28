// Regressions for #16 — chain healing after a relay dies.
//  1. A dead radio doesn't beacon, but the upstream-beacon tracker read the
//     live link budget straight through death (liveMarginDb never checks
//     alive()), so the drone below a killed relay kept "hearing" full margin
//     and its tether never closed the gap. Measured on a 6-relay chain: the
//     link stayed down 100-175 s after a single kill.
//  2. C2 kept hunting a silent drone for RESCUE.memorySec (180 s) even when a
//     live drone already sat on its last-known position — one that would hear
//     it if it were there — pulling up to three mission drones off the
//     objective for nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const DT = 0.05;
const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

// Relay UP at 100 m (off C2), relay D at 200 m hanging off UP, D's slot
// further out so its goal is outbound. C2 is frozen: orders stay as placed.
function chainOfTwo() {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 2, seed: 3, radio: SIK, airframe: Q450, envFactor: 1, altitudeM: 50, targetX: 800, targetY: 0 });
  s.c2.nextCmd = Infinity;
  const [up, d] = s.drones;
  const place = (dr, x) => { dr.x = dr.belX = x; dr.y = dr.belY = 0; dr.vx = dr.vy = 0; };
  place(up, 100); place(d, 200);
  const target = { x: 800, y: 0 };
  up.order = { role: 'relay', slot: 0, k: 2, upstream: 'C2', target, slotPos: { x: 100, y: 0 } };
  d.order = { role: 'relay', slot: 1, k: 2, upstream: up.id, target, slotPos: { x: 300, y: 0 } };
  d.neighborKnown[up.id] = { x: 100, y: 0, at: 0, receivedAt: 0 };
  for (let i = 0; i < 20; i++) ctx.stepSwarm(s, DT); // settle the beacon EMA on the live link
  const stopDb = ctx.plannedHopMarginDb(s, d) - ctx.consts.TETHER.stopBelowPlanDb;
  return { ctx, s, up, d, stopDb };
}

test('#16: a dead upstream reads as no signal, so the tether closes the gap', () => {
  const { ctx, s, up, d, stopDb } = chainOfTwo();
  ctx.killDrone(s, up);
  for (let i = 0; i < 60; i++) ctx.stepSwarm(s, DT); // 3 s
  assert.ok(d.upMarginEma < stopDb,
    `3 s after its upstream died, ${d.id} still tracks ${d.upMarginEma.toFixed(1)} dB (tether floor ${stopDb.toFixed(1)} dB)`);
  assert.ok(d.tethered, 'the tether must engage and close up toward the gap');
});

test('#16: a live upstream at the same spacing does not trip the tether (guard)', () => {
  const { ctx, s, d, stopDb } = chainOfTwo();
  for (let i = 0; i < 60; i++) ctx.stepSwarm(s, DT);
  assert.ok(d.upMarginEma > stopDb, 'healthy 100 m hop must read above the floor, got ' + d.upMarginEma.toFixed(1));
  assert.ok(!d.tethered);
});

// C2 knows two fresh drones (40 m and 150 m out) and has been missing a third
// for 20 s — past the rescue grace — last heard at lostX.
function c2With(lostX) {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 3, seed: 11, radio: SIK, airframe: Q450, envFactor: 1, altitudeM: 50, targetX: 500, targetY: 0 });
  const [a, b, x] = s.drones;
  s.time = 100;
  const know = (d, px) => {
    d.x = px; d.y = 0;
    s.c2.known[d.id] = { x: px, y: 0, battery: 90, role: 'mission', cls: 'mission', posAt: s.time, at: s.time };
    s.c2.everHeard.add(d.id); s.c2.wasFresh[d.id] = true;
  };
  know(a, 40); know(b, 150);
  ctx.killDrone(s, x);
  s.c2.lost[x.id] = { x: lostX, y: 0, at: s.time - 20 };
  s.c2.nextCmd = 0;
  ctx.c2Step(s);
  return { s, x };
}

test('#16: C2 calls off the search when a live drone already covers the lost position', () => {
  const { s, x } = c2With(170); // the drone at 150 m sits 20 m from the last-known point
  assert.strictEqual(s.c2.rescuers.length, 0,
    'no rescuer should be pulled off the mission, got ' + s.c2.rescuers.join(','));
  assert.ok(!s.c2.lost[x.id], 'the covered search must be struck off');
});

test('#16: an uncovered last-known position still gets a rescuer (guard)', () => {
  const { s, x } = c2With(480); // nearest live drone 330 m away
  assert.strictEqual(s.c2.rescuers.length, 1, 'rescue dispatch must still fire');
  assert.ok(s.c2.lost[x.id]);
});
