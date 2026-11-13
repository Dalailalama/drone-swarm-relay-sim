// Audit C2-05: "extend only when the current tip is on station and still
// short" was only half implemented. C2 checked that the tip was short of the
// lost centroid, never that it had reached its goto, so a rescuer drafted a
// round ago (still at its origin, far from the centroid) always looked short
// and every round drafted another link, up to RESCUE.maxChain, for a gap one
// link spans.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

test('C2-05: a rescue chain does not grow while its tip is still in transit', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 8, seed: 1, envFactor: 1, altitudeM: 50, targetX: 1000, targetY: 0,
    radio: R.RADIOS.find(r => r.id === 'sik-v3'), airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
  });
  const lost = s.drones[7];
  ctx.killDrone(s, lost);
  s.time = 100;
  // Last heard 150 m out: C2 itself (the anchor) is one link away, so a
  // single rescuer spans the gap. Six mission drones sit ~500 m beyond it.
  s.c2.lost[lost.id] = { x: 150, y: 0, at: s.time - 20 };
  const pos = {};
  s.drones.slice(0, 7).forEach((d, i) => { pos[d.id] = [650 + 10 * i, (i - 3) * 30]; });
  for (let round = 0; round < 3; round++) {
    s.time += 1;
    for (const [id, [x, y]] of Object.entries(pos)) {
      // Nobody moves: the drafted rescuer is still where it was drafted.
      s.c2.known[id] = {
        x, y, battery: 90, cls: 'mission', posAt: s.time, at: s.time,
        role: s.c2.rescuers.includes(id) ? 'rescue' : (s.c2.relays.includes(id) ? 'relay' : 'mission'),
      };
      s.c2.everHeard.add(id);
    }
    s.c2.nextCmd = 0;
    ctx.c2Step(s);
  }
  assert.strictEqual(s.c2.rescuers.length, 1,
    'rescue chain grew to ' + s.c2.rescuers.length + ' while its first link had not moved');
});

test('C2-05: a tip that reached its goto and is still short gets the next link (guard)', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 8, seed: 1, envFactor: 1, altitudeM: 50, targetX: 1000, targetY: 0,
    radio: R.RADIOS.find(r => r.id === 'sik-v3'), airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
  });
  const lost = s.drones[7];
  ctx.killDrone(s, lost);
  s.time = 100;
  s.c2.lost[lost.id] = { x: 0, y: 600, at: s.time - 20 }; // several links out, off the corridor
  const pos = {};
  s.drones.slice(0, 7).forEach((d, i) => { pos[d.id] = [650 + 10 * i, (i - 3) * 30]; });
  const counts = [];
  for (let round = 0; round < 3; round++) {
    s.time += 1;
    for (const [id, [x, y]] of Object.entries(pos)) {
      s.c2.known[id] = {
        x, y, battery: 90, cls: 'mission', posAt: s.time, at: s.time,
        role: s.c2.rescuers.includes(id) ? 'rescue' : (s.c2.relays.includes(id) ? 'relay' : 'mission'),
      };
      s.c2.everHeard.add(id);
    }
    s.c2.nextCmd = 0;
    ctx.c2Step(s);
    counts.push(s.c2.rescuers.length);
    // Every rescuer flies straight to its goto before the next round.
    const orders = s.net.bcasts[s.net.bcasts.length - 1].payload.orders;
    for (const rid of s.c2.rescuers) pos[rid] = [orders[rid].goto.x, orders[rid].goto.y];
  }
  assert.strictEqual(counts.join(','), '1,2,3', 'on-station tips must keep extending');
});
