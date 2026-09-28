// Regression for #15: the line-of-sight densifier bisected a blocked hop and
// re-walked until clean or capped. When a building — not the hop's length —
// blocks the line, no midpoint ever clears it, so the bisection converged on
// the building's edge and stacked slots there (city reproduction: 12 slots,
// 9 of them within 20 m, every drone drafted as a relay, none left for the
// mission). A single flyable 48 m building under a 50 m flight level is
// enough: it is not an obstacle (A* flies straight over it), but with the
// 5 m clearance it blocks every hop that crosses it.

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

function planOver(buildingX) {
  const ctx = loadCore();
  const terrain = ctx.indexBuildings({
    seed: 1, groundAmpM: 0, groundScaleM: 1,
    buildings: [{ x: buildingX, y: 0, w: 30, d: 30, heightM: 48 }],
  });
  const s = ctx.makeSwarm({
    terrain, count: 10, seed: 7, altitudeM: 50, envFactor: 1,
    radio: R.RADIOS.find(r => r.id === 'sik-v3'),
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    targetX: 600, targetY: 0,
  });
  const plan = ctx.planChain(s);
  const nodes = [s.base, ...plan.slots, s.target];
  const hops = nodes.slice(1).map((n, i) => Math.hypot(n.x - nodes[i].x, n.y - nodes[i].y));
  return { plan, hops, sepM: vm.runInContext('DRONE.separationM', ctx) };
}

test('#15: a building that blocks line of sight never stacks relay slots', () => {
  for (const bx of [180, 240, 300, 372]) {
    const { plan, hops, sepM } = planOver(bx);
    const minHop = Math.min(...hops);
    assert.ok(minHop >= 2 * sepM,
      `building at x=${bx}: planned hops ${hops.map(Math.round).join(',')} m — ` +
      `${plan.slots.length} slots, the closest pair ${minHop.toFixed(0)} m apart (< 2x separation)`);
  }
});

test('#15: long blocked hops are still densified (guard)', () => {
  // 600 m / 175 m span plans 3 slots; the building blocks the hops that
  // cross it, and those are long enough to be worth a relay in the middle.
  const { plan } = planOver(300);
  assert.ok(plan.slots.length > 3, 'expected LOS densification to add slots, got ' + plan.slots.length);
  assert.ok(plan.slots.length < 12, 'densification must not run to the slot cap, got ' + plan.slots.length);
});
