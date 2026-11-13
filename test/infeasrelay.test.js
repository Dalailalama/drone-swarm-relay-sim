// Audit C2-02: once the route turned infeasible, the k-1 release hysteresis
// kept exactly one relay, and that relay's order carried slotPos:null, so
// the drone minted the straight-line slot (slot+1)/(k+1) along base->target:
// inside the very wall that made the plan infeasible (the #19 fix defeated).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function wall(s) {
  const out = [];
  for (let y = -4000; y <= 4000; y += 180) out.push({ x: 300, y, w: 220, d: 200, heightM: 500 });
  s.terrain.buildings = out;
  ctx.indexBuildings(s.terrain);
}

test('C2-02: a route that turns infeasible releases every relay; none is sent into the wall', () => {
  const s = ctx.makeSwarm({ count: 6, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42 });
  s.terrain = ctx.makeTerrain('flat');
  while (s.time < 120) ctx.stepSwarm(s, 0.25);
  assert.ok(s.c2.relays.length >= 2, 'chain must be built first: ' + JSON.stringify(s.c2.relays));
  wall(s);
  while (s.time < 200) ctx.stepSwarm(s, 0.25);
  assert.strictEqual(s.c2.chainPlan.feasible, false);
  assert.strictEqual(s.c2.relays.length, 0, 'no relay may be kept on a plan with no route: ' + s.c2.relays.join(','));
  for (const d of s.drones) {
    if (d.mode !== 'ok' || d.order.role !== 'relay') continue;
    const g = ctx.goalFor(s, d, 0.25);
    assert.ok(!ctx.insideObstacle(s, g), d.id + ' ordered to relay at ' + Math.round(g.x) + ',' + Math.round(g.y) + ' inside the wall');
  }
});
