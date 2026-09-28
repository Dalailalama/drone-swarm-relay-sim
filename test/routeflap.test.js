// Route damping in the C2 routing tree (#8). Undamped, ETX riding the
// shadow-fading process made on-station drones flip parents constantly
// (252 changes in 3 min at UI defaults, 127 of them straight back within
// 3 s). The damping must stop that without delaying failover or pinning a
// needless relay hop.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const DT = 0.05;

test('#8: on-station drones keep their routes instead of flapping', () => {
  const { ctx } = loadUI();
  const s = ctx.sim.swarm;
  while (s.time < 90) ctx.stepSwarm(s, DT);
  const hist = new Map();
  let changes = 0, flickers = 0;
  const t0 = s.time;
  while (s.time < t0 + 180) {
    ctx.stepSwarm(s, DT);
    const tree = ctx.c2Tree(s);
    for (const d of s.drones) {
      if (!ctx.alive(d)) continue;
      const p = tree.prev.get(d.id) || null;
      const h = hist.get(d.id) || [];
      if (h.length && h[h.length - 1].p === p) continue;
      if (h.length) changes++;
      h.push({ t: s.time, p });
      if (h.length >= 3 && h[h.length - 3].p === p && s.time - h[h.length - 2].t < 3) flickers++;
      hist.set(d.id, h);
    }
  }
  assert.ok(flickers <= 2, `routes flipped straight back ${flickers} times in 180 s`);
  assert.ok(changes <= 100, `routes changed ${changes} times in 180 s on station`);
});

// A hand-placed mesh on flat ground: C2, two relays, a mission drone.
function mesh() {
  const ctx = loadCore();
  const radio = R.RADIOS.find(r => r.id === 'rfd900x');
  const s = ctx.makeSwarm({
    count: 4, seed: 5, radio, airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    envFactor: 1, targetX: 3000, targetY: 0, altitudeM: 60,
  });
  const U = ctx.usableRangeM(radio, 1);
  const place = (d, x, y) => { d.x = s.base.x + x * U; d.y = s.base.y + y * U; d.vx = d.vy = 0; d.mode = 'ok'; };
  const [a, b, n, m] = s.drones;
  const rebuild = dt => {
    s.time += dt;
    if (s._marginCache) s._marginCache.clear();
    return ctx.c2Tree(s);
  };
  return { ctx, s, a, b, n, m, place, rebuild };
}

test('#8: a dead parent is replaced at the next rebuild, hold-down or not', () => {
  const { s, a, b, n, m, place, rebuild } = mesh();
  place(a, 0.5, 0.05); place(b, 0.5, -0.05); place(m, 1.0, 0); n.mode = 'landed';
  let tree = rebuild(1);
  const parent = tree.prev.get(m.id);
  assert.ok(parent === a.id || parent === b.id, 'mission drone must route through a relay, got ' + parent);
  // Kill that relay 0.6 s after adoption — deep inside the hold-down window.
  (parent === a.id ? a : b).mode = 'dead';
  tree = rebuild(0.6);
  const other = parent === a.id ? b.id : a.id;
  assert.strictEqual(tree.prev.get(m.id), other, 'failover must not wait out the hold-down');
  assert.ok(Number.isFinite(tree.dist.get(m.id)), 'the replacement route must carry a finite true cost');
});

test('#8: damping never pins a needless relay hop for good', () => {
  const { s, a, b, n, m, place, rebuild } = mesh();
  // Relay A, mission neighbour N beyond it, M farther out: M hangs off N.
  place(a, 0.5, 0); place(n, 1.1, 0); place(m, 1.7, 0); b.mode = 'landed';
  let tree = rebuild(1);
  assert.strictEqual(tree.prev.get(m.id), n.id, 'setup: M starts two hops out, via N');
  // M flies in just past A (still far from C2): hanging off A directly now
  // saves a whole transmission (ETX ~2.0 vs ~3.1 via N).
  place(m, 0.9, 0);
  tree = rebuild(1);
  assert.strictEqual(tree.prev.get(m.id), n.id, 'a route adopted 1 s ago is held (hold-down)');
  tree = rebuild(5);
  assert.strictEqual(tree.prev.get(m.id), a.id, 'after the hold-down, M must shed the needless hop');
});
