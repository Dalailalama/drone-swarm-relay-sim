// Regression for #17: covAdjust shifted a bad slot in whole coverage-cell
// steps, and a cell is 15% of usable range — 3.3 km on an RFD900x. Dodging a
// 420 m GPS-denied zone threw the relay slot 3.3 km off the corridor, where no
// drone could afford it: every elected drone declined in turn and C2 cycled
// the roster (DDIL "GPS-denied crossing": 30 declines + 30 benchings in 700 s).

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('#17: a long-range slot sidesteps a GPS-denied zone by metres, not a coverage cell', () => {
  const ctx = loadCore();
  const zone = { x: 1600, y: -350, rM: 420, on: true };
  const s = ctx.makeSwarm({
    count: 8, seed: 4101, radio: R.RADIOS.find(r => r.id === 'rfd900x'), airframe: Q450,
    envFactor: 1, altitudeM: 80, targetX: 3200, targetY: -700, gpsZones: [zone],
  });
  assert.ok(s.covCellM > 3000, 'setup: long-range radios map coverage in km-sized cells');
  const nominal = { x: 1600, y: -350 };             // the planned slot, dead centre of the zone
  const adj = ctx.covAdjust(s, nominal);
  const moved = Math.hypot(adj.x - nominal.x, adj.y - nominal.y);
  assert.ok(!ctx.badPlan(s, adj), 'the adjusted slot must be outside the zone');
  assert.ok(moved <= zone.rM + 80,
    `slot moved ${moved.toFixed(0)} m to clear a ${zone.rM} m zone (to ${adj.x.toFixed(0)},${adj.y.toFixed(0)})`);
  // ...which keeps it affordable: a drone at two-thirds charge accepts it.
  const d = s.drones[0];
  d.energyWh = 0.67 * ctx.usableWh(Q450);
  assert.ok(ctx.orderFeasible(s, d, { role: 'relay', slot: 0, k: 1, slotPos: adj, target: s.target }),
    'a 67%-charged drone must be able to accept the adjusted slot');
});

test('#17: short-range radios keep whole-cell steps (guard)', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 4, seed: 9, radio: R.RADIOS.find(r => r.id === 'sik-v3'), airframe: Q450,
    envFactor: 1, altitudeM: 50, targetX: 500, targetY: 0,
  });
  assert.ok(s.covCellM < 40, 'setup: SiK cells are finer than the 40 m step');
  const pos = { x: 250, y: 5 };
  ctx.covMark(s, pos.x, pos.y, 'bad', 3);
  const adj = ctx.covAdjust(s, pos);
  // Spine runs along +x, so the first candidate is one cell to the +y side.
  assert.ok(Math.abs(adj.x - pos.x) < 1e-9 && Math.abs(adj.y - (pos.y + s.covCellM)) < 1e-9,
    `expected one cell perpendicular, got ${adj.x},${adj.y}`);
});
