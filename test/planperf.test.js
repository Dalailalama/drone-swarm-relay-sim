// #27: chain planning could freeze the sim. A jammer on the objective over
// hills enclosed the goal, so A* exhausted the whole padded box — every
// blocked() probe traced terrain line-of-sight, each cell was re-probed from
// up to 8 neighbours, and the failed plan was recomputed every 5 sim-seconds
// though nothing had changed (30-42 s per plan; 6-10 s UI frames). Far
// objectives built a 40 m grid over 100 km (~1 min per replan). And A*
// treated GPS-denied zones as radio walls, so a zone over the base withheld
// the plan entirely although GNSS denial doesn't touch RF.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function timed(fn) { const t0 = Date.now(); const out = fn(); return { out, ms: Date.now() - t0 }; }

test('#27: a jammer on the objective over hills fails fast, and the failure is not re-searched', () => {
  const ctx = loadCore();
  const tx = 2400, ty = 1800;
  const s = ctx.makeSwarm({ count: 2, airframe: Q450, radio: SIK, envFactor: 1, targetX: tx, targetY: ty, seed: 3,
    terrain: ctx.makeTerrain('rolling', { distM: 3000, targetX: tx, targetY: ty, seed: 3 }),
    jammers: [{ x: tx, y: ty, erpDbm: 42, band: 'all', on: true }] });
  const first = timed(() => ctx.planChain(s));
  assert.ok(first.ms < 3000, `planning took ${first.ms} ms`);
  s.time += 6; // past the replan interval, nothing in the world changed
  const again = timed(() => ctx.planChain(s));
  assert.ok(again.ms < 50, `an unchanged failed plan was searched again (${again.ms} ms)`);
});

test('#27: a 100 km objective plans in bounded time', () => {
  const ctx = loadCore();
  // Urban SiK: usable range is short, so the grid cell bottomed out at 40 m;
  // a diagonal objective makes the search box a square, not a strip.
  const s = ctx.makeSwarm({ count: 10, airframe: Q450, radio: SIK, envFactor: 0.2, targetX: 80000, targetY: 60000, seed: 3 });
  const { out, ms } = timed(() => ctx.planChain(s));
  assert.ok(ms < 3000, `planning a 100 km route took ${ms} ms`);
  assert.ok(out.feasible, 'an open-field route must still be found');
});

test('#27: a GPS-denied zone over the base does not withhold the relay plan', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 10, airframe: Q450, radio: SIK, envFactor: 1, targetX: 600, targetY: -150, seed: 21,
    gpsZones: [{ id: 'GZ', x: 0, y: 0, rM: 150, on: true }] });
  while (s.time < 60) ctx.stepSwarm(s, 0.05);
  const plan = ctx.planChain(s);
  assert.ok(plan.feasible, 'GNSS denial must not make the radio chain infeasible');
  assert.ok(plan.slots.length >= 1, 'a 600 m SiK objective needs relays');
});

test('#27 guard: a jammer mid-corridor is still routed around, not through', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 12, airframe: Q450, radio: SIK, envFactor: 1, targetX: 1400, targetY: 0, seed: 5,
    jammers: [{ x: 700, y: 0, erpDbm: 20, band: 'all', on: true }] });
  const plan = ctx.planChain(s);
  assert.ok(plan.feasible, 'a detour exists');
  const inside = plan.slots.filter(p => ctx.inDenialZone(s, p));
  assert.strictEqual(inside.length, 0, `${inside.length} relay slots planned inside the denial zone`);
});
