// Audit finding ui-render/target-distance-slider-ignores-base: the 'Target
// distance' slider placed the target at (dist, -dist/4) from the WORLD ORIGIN
// and printed fmtDist(dist), so once C2 had moved (convoy mission, a dragged
// C2) the target landed behind C2 and the readout was not the C2→target range.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

const span = s => Math.hypot(s.target.x - s.base.x, s.target.y - s.base.y);

test('readout at boot is the true C2→target range', () => {
  const { ctx, el } = loadUI();
  assert.strictEqual(el('distOut').textContent, ctx.fmtDist(span(ctx.sim.swarm)));
});

test('slider measures from a moved C2, along the current bearing', () => {
  const { ctx, el, fire } = loadUI();
  const s = ctx.sim.swarm;
  const D = s.target.x - s.base.x; // boot geometry: target at (D, -D/4) from C2 at 100%
  const brg0 = Math.atan2(s.target.y - s.base.y, s.target.x - s.base.x);
  // Move C2 and the objective together, as a convoy does.
  s.base.x += 3900; s.base.y -= 840; s.target.x += 3900; s.target.y -= 840;
  el('distRange').value = 60; fire('distRange', 'input');
  const want = 0.6 * D * Math.hypot(1, 0.25);
  assert.ok(Math.abs(span(s) - want) < 1e-6, 'C2→target ' + span(s) + ' m, wanted ' + want);
  const brg = Math.atan2(s.target.y - s.base.y, s.target.x - s.base.x);
  assert.ok(Math.abs(brg - brg0) < 1e-9, 'bearing from C2 is kept');
  assert.strictEqual(el('distOut').textContent, ctx.fmtDist(span(s)));
});

test('at the default geometry the slider still lands where it always did', () => {
  const { ctx, el, fire } = loadUI();
  const s = ctx.sim.swarm;
  const d = 0.6 * (s.target.x - s.base.x);
  el('distRange').value = 60; fire('distRange', 'input');
  assert.ok(Math.abs(s.target.x - d) < 1e-6 && Math.abs(s.target.y + d * 0.25) < 1e-6, JSON.stringify(s.target));
});
