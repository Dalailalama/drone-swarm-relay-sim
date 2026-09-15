// Scale tests — 100+ node fleets must work correctly and stay inside a
// generous wall-clock guard. Fine-grained numbers live in bench/BASELINE.md;
// this file only catches catastrophic regressions (like an accidental
// return to per-packet Dijkstra or O(n²) separation).

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();

test('C2 routing tree produces valid upstream paths', () => {
  const s = ctx.makeSwarm({
    count: 12,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: R.RADIOS.find(r => r.id === 'rfd900x'),
    envFactor: 1, targetX: 2000, targetY: -500, altitudeM: 60, seed: 77,
  });
  let st = null;
  while (s.time < 30) st = ctx.stepSwarm(s, 0.25);
  const tree = ctx.c2Tree(s);
  for (const d of s.drones) {
    if (!ctx.alive(d)) continue;
    const path = ctx.pathToC2(s, d.id);
    if (!path) continue; // genuinely disconnected drones are allowed
    assert.strictEqual(path[path.length - 1], 'C2', 'path must terminate at C2');
    assert.strictEqual(path[0], d.id);
    assert.ok(new Set(path).size === path.length, 'no cycles in tree path');
  }
});

test('100-drone fleet flies a real mission and closes the chain', () => {
  const s = ctx.makeSwarm({
    count: 100,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: R.RADIOS.find(r => r.id === 'rfd900x'),
    envFactor: 1,
    targetX: 2400, targetY: -600,
    altitudeM: 70, seed: 78,
    videoOn: true, videoKbps: 250,
  });
  const t0 = Date.now();
  let st = null;
  while (s.time < 90) st = ctx.stepSwarm(s, 0.25);
  const wallS = (Date.now() - t0) / 1000;

  assert.strictEqual(st.aliveCount, 100, 'whole fleet alive at T+90 s');
  // T+90 s is mid-transit on a 2.4 km corridor — this test is about the
  // BACKHAUL closing at 100-node scale, not objective arrival (finding #6
  // split the two: `connected` now means on-station at the objective).
  assert.ok(st.fleetConnected, 'backhaul chain must close for a 100-node fleet');
  assert.ok(st.freshCount >= 80, 'C2 should be in contact with most of the fleet, got ' + st.freshCount);
  assert.ok(s.net.vid.framesDelivered > 10, 'payload stream survives at scale');
  // Loose perf guard: ~360 ticks of a 100-drone sim must not take minutes.
  // The committed baseline is ~44 ms/tick on the dev machine (~16 s here);
  // 60 s of wall clock means something went superlinear again.
  assert.ok(wallS < 60,
    '100-node run took ' + wallS.toFixed(1) + 's wall — superlinear regression (baseline ~16 s)');
});
