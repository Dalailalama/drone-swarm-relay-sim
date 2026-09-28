// #14: at scale the C2 order flood saturated the channel. Every node re-sent
// the order table once (N+1 copies) while C2 issued a new round every second,
// and telemetry intervals and C2's freshness window ignored fleet size — so on
// SiK the channel pinned at 100 %, C2 heard a fraction of the fleet, struck
// healthy relays off as "stale" and reshuffled the chain over and over.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function swarm(ctx, count, extra) {
  return ctx.makeSwarm(Object.assign({ count, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 700, targetY: -150, altitudeM: 50, seed: 43 }, extra || {}));
}

test('#14: a 30-drone SiK swarm leaves channel headroom and C2 keeps contact', () => {
  const ctx = loadCore();
  const s = swarm(ctx, 30);
  let util = 0, fresh = 0, n = 0;
  while (s.time < 150) {
    ctx.stepSwarm(s, 0.05);
    if (s.time <= 60) continue;
    const st = ctx.chainStatus(s);
    util += s.net.utilization; fresh += st.freshCount / Math.max(1, st.aliveCount); n++;
  }
  const reshuffles = s.events.filter(e => e.t > 60 && e.kind === 'relay').length;
  assert.ok(util / n <= 0.85, `channel pinned: mean utilization ${(util / n).toFixed(2)}`);
  assert.ok(fresh / n >= 0.8, `C2 heard only ${(100 * fresh / n).toFixed(0)}% of the fleet`);
  assert.ok(reshuffles <= 3, `relay roster reshuffled ${reshuffles} times after deployment`);
});

test('#14: in a dense cluster a flood is re-sent a handful of times, not once per drone', () => {
  const ctx = loadCore();
  const s = swarm(ctx, 20);
  s.drones.forEach((d, i) => { d.x = 100 + (i % 5) * 8; d.y = Math.floor(i / 5) * 8; });
  s.time = 0;
  ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 300);
  for (let t = 0; t <= 10; t += 0.05) { s.time = t; ctx.stepNet(s, 0.05); }
  // Only this flood is on the air, so a drone with an emission time re-sent it.
  const forwards = s.drones.filter(d => s.net.txAt[d.id] != null).length;
  assert.ok(s.drones.every(d => d.bcastSeen >= 1), 'every drone must still get the orders');
  assert.ok(forwards <= 5, `${forwards} of 20 co-located drones re-sent the same table`);
});

test('#14: suppression never starves a sparse relay line', () => {
  const ctx = loadCore();
  const s = swarm(ctx, 6);
  s.drones.forEach((d, i) => { d.x = 180 * (i + 1); d.y = 0; });
  s.time = 0;
  ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 300);
  for (let t = 0; t <= 10; t += 0.05) { s.time = t; ctx.stepNet(s, 0.05); }
  const missed = s.drones.filter(d => !(d.bcastSeen >= 1)).map(d => d.id);
  assert.strictEqual(missed.length, 0, 'orders never reached ' + missed.join(', '));
});

test('#14: small fleets keep their original cadence', () => {
  const ctx = loadCore();
  const s = swarm(ctx, 10);
  assert.strictEqual(ctx.cmdIntervalSec(s, 10), 1.0);
  assert.strictEqual(ctx.tlmIntervalSec(s), 2.0);
});
