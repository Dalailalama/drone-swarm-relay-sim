// Audit C2-03: when the base and the objective fall in the same A* cell
// (cells are usable/4, ~5.5 km on an RFD900x wing), the path reconstruction
// unshifted the base and then OVERWROTE it with the target: path=[target],
// pathLen 0. A mixed fleet then got no tactical-tail slot, so a CLOSER
// objective left the whole short-range flock unrouted.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
const X8 = A.AIRFRAMES.find(a => a.id === 'x8');
const MICRO = A.AIRFRAMES.find(a => a.id === 'micro');

function mixed(D) {
  return ctx.makeSwarm({ count: 8, airframe: MICRO, radio: SIK, envFactor: 1, targetX: D, targetY: 0, seed: 3,
    relayWing: 3, relayAirframe: X8, relayRadio: RFD });
}

test('C2-03: base and objective in one A* cell still plan the real path and the tactical tail slot', () => {
  const s = mixed(800);
  const plan = ctx.planChain(s);
  assert.ok(Math.abs(plan.pathLen - 800) < 1, 'pathLen ' + plan.pathLen + ' must be the 800 m base->objective path');
  assert.ok(plan.slots.length >= 1, 'a mixed fleet needs a tail slot inside tactical reach of the objective');
  const tactReach = ctx.usableRangeM(SIK, 1) * s.deployFrac;
  const tail = plan.slots[plan.slots.length - 1];
  assert.ok(Math.hypot(tail.x - s.target.x, tail.y - s.target.y) <= tactReach,
    'tail slot must sit inside tactical reach of the objective');
});

test('C2-03: a homogeneous fleet with the objective in the base cell plans the straight path', () => {
  const s = ctx.makeSwarm({ count: 4, airframe: X8, radio: RFD, envFactor: 1, targetX: 900, targetY: 300, seed: 3 });
  const plan = ctx.planChain(s);
  assert.ok(Math.abs(plan.pathLen - Math.hypot(900, 300)) < 1, 'pathLen ' + plan.pathLen);
  assert.strictEqual(plan.slots.length, 0, 'well inside one hop: no relays');
});

test('C2-03: at a close objective the tactical flock on station is routed through the chain', () => {
  const s = mixed(800);
  let routed = 0;
  while (s.time < 240) {
    ctx.stepSwarm(s, 0.25);
    if (s.time < 200) continue;
    const tree = ctx.c2Tree(s);
    for (const d of s.drones) {
      if (d.cls === 'relay' || d.mode !== 'ok' || d.order.role !== 'mission') continue;
      if (Math.hypot(d.x - s.target.x, d.y - s.target.y) < 150 && tree.prev.has(d.id)) routed++;
    }
  }
  assert.ok(routed > 0, 'no tactical mission drone on station had a route to C2');
});
