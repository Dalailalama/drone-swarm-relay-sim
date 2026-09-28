// Regression for #8: the map drew ONE route — to the flock drone nearest the
// flock centroid, which is effectively random on the orbit ring — so drones
// with perfectly good links looked orphaned and the drawn chain ended at a
// drone far from the relay the flock actually hangs off. Runs the real UI
// boot with its default settings, the scenario from the report.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

const DT = 0.05;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function bootOnStation() {
  const { ctx } = loadUI();
  const s = ctx.sim.swarm;
  let st = null;
  while (s.time < 90) st = ctx.stepSwarm(s, DT);
  assert.ok(st && st.connected, 'the default mission must be on station by t=90 s');
  return { ctx, s };
}

const onChain = d => d.mode === 'ok' || d.mode === 'hold';

test('#8: every live drone\'s real link is drawn, not one representative path', () => {
  const { ctx, s } = bootOnStation();
  for (let k = 0; k < 20; k++) {
    for (let i = 0; i < 100; i++) ctx.stepSwarm(s, DT);
    const st = ctx.chainStatus(s);
    assert.ok(Array.isArray(st.links), 'chainStatus must expose the live routing links');
    for (const d of s.drones) {
      if (!ctx.alive(d)) continue;
      const path = ctx.pathToC2(s, d.id);
      if (!path) continue;
      const up = path[1];
      assert.ok(st.links.some(l => l.b.id === d.id && l.a.id === up),
        `t=${s.time.toFixed(1)}: ${d.id} routes via ${up} but that link is not drawn`);
    }
  }
});

test('#8: the labelled chain ends where the route enters the flock, and holds steady', () => {
  const { ctx, s } = bootOnStation();
  const t0 = s.time;
  let samples = 0, entry = 0;
  const ends = [];
  while (s.time < t0 + 180) {
    ctx.stepSwarm(s, DT);
    const st = ctx.chainStatus(s);
    if (!st.connected || st.hops.length < 2) continue;
    const last = st.hops[st.hops.length - 1];
    // Flock drones hanging off the same node as the drawn endpoint: the
    // nearest of them is where the eye expects the labelled chain to end.
    const siblings = s.drones.filter(d => ctx.alive(d) && onChain(d) && d.order.role === 'mission' &&
      (ctx.pathToC2(s, d.id) || [])[1] === last.a.id);
    if (!siblings.length) continue;
    const nearestM = Math.min(...siblings.map(d => dist(d, last.a)));
    samples++;
    if (dist(last.b, last.a) <= nearestM + 35) entry++;
    if (!ends.length || ends[ends.length - 1].id !== last.b.id) ends.push({ t: s.time, id: last.b.id });
  }
  assert.ok(samples > 1000, 'expected a long on-station window, got ' + samples + ' samples');
  const entryPct = 100 * entry / samples;
  assert.ok(entryPct >= 90,
    `drawn chain ended at the flock drone nearest its last relay only ${entryPct.toFixed(0)}% of the time`);
  // Flicker: A -> B -> A with B shown for under 3 s.
  let flickers = 0;
  for (let i = 2; i < ends.length; i++) {
    if (ends[i].id === ends[i - 2].id && ends[i].t - ends[i - 1].t < 3) flickers++;
  }
  assert.ok(flickers <= 1, `labelled chain endpoint flickered back and forth ${flickers} times`);
});
