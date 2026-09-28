// Regression for #18 (rescue half): every command round C2 re-sorted the
// rescue chain by each rescuer's (GPS-noisy) projection toward the lost group
// and re-picked the anchor as the nearest fresh drone. Bunched rescuers and
// near-equidistant anchors swapped on the noise alone, so each rescuer's
// upstream — and with it its goal — rotated every second.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

test('#18: rescue upstreams hold steady under GPS noise', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 6, seed: 21, envFactor: 1, altitudeM: 50, targetX: 500, targetY: 0,
    radio: R.RADIOS.find(r => r.id === 'sik-v3'), airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
  });
  const [n1, n2, r1, r2, r3, lost] = s.drones;
  // Two anchor candidates equidistant from the lost group, three rescuers
  // bunched within ~2 m along the axis, the lost drone last heard at x=400
  // (nothing live near it, so the search stays on).
  const truth = { [n1.id]: [60, 20], [n2.id]: [60, -20], [r1.id]: [200, 0], [r2.id]: [201, 5], [r3.id]: [199.5, -5] };
  ctx.killDrone(s, lost);
  s.time = 100;
  s.c2.lost[lost.id] = { x: 400, y: 0, at: s.time - 20 };
  s.c2.rescuers = [r1.id, r2.id, r3.id];
  const rng = ctx.mulberry32(99);
  const ups = {};
  let changes = 0;
  for (let round = 0; round < 20; round++) {
    s.time += 1;
    for (const [id, [x, y]] of Object.entries(truth)) {
      s.c2.known[id] = {
        x: x + 1.5 * ctx.gaussian(rng), y: y + 1.5 * ctx.gaussian(rng), battery: 90, cls: 'mission',
        role: s.c2.rescuers.includes(id) ? 'rescue' : 'mission', posAt: s.time, at: s.time,
      };
      s.c2.everHeard.add(id);
    }
    s.c2.nextCmd = 0;
    ctx.c2Step(s);
    const orders = s.net.bcasts[s.net.bcasts.length - 1].payload.orders;
    for (const rid of [r1.id, r2.id, r3.id]) {
      const up = orders[rid] && orders[rid].upstream;
      assert.ok(orders[rid] && orders[rid].role === 'rescue', `round ${round}: ${rid} must stay on the rescue chain`);
      if (ups[rid] !== undefined && ups[rid] !== up) changes++;
      ups[rid] = up;
    }
  }
  assert.ok(changes <= 1, `rescuers' upstreams changed ${changes} times in 20 rounds with nothing but GPS noise moving`);
});
