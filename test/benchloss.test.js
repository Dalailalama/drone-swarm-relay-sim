// Review (round-4 follow-up): bench/run.js reported droppedPct from the
// aggregate s.net counters, which fold in video fragments (the bench flies
// with video on), while tools/batch.js and tools/compare.js and the
// after-action report all use the control-plane figure (controlLossPct).
// Same column name, two different quantities.
const { test } = require('node:test');
const assert = require('node:assert');

test('bench droppedPct is the control-plane loss, video fragments excluded', () => {
  const sim = require('./helpers/sim.js');
  const realLoad = sim.loadCore;
  let swarm = null;
  sim.loadCore = (...a) => {
    const ctx = realLoad(...a);
    const make = ctx.makeSwarm;
    ctx.makeSwarm = (o) => (swarm = make(o));
    return ctx;
  };
  const { runOnce } = require('../bench/run.js');
  sim.loadCore = realLoad;

  const r = runOnce(10, 0);
  assert.ok(swarm, 'the bench built a swarm through the shared harness');

  let cd = 0, cx = 0;
  for (const k in swarm.net.byKind) {
    if (k === 'vid') continue;
    cd += swarm.net.byKind[k].delivered; cx += swarm.net.byKind[k].dropped;
  }
  const control = 100 * cx / Math.max(1, cd + cx);
  const aggregate = 100 * swarm.net.dropped / Math.max(1, swarm.net.delivered + swarm.net.dropped);

  assert.ok(swarm.net.byKind.vid && swarm.net.byKind.vid.delivered + swarm.net.byKind.vid.dropped > 0,
    'the bench scenario streams video');
  assert.notStrictEqual(control, aggregate, 'premise: video changes the loss figure, else this test proves nothing');
  assert.ok(Math.abs(r.droppedPct - control) < 1e-9,
    'droppedPct ' + r.droppedPct + ' is not the control-plane loss ' + control + ' (aggregate is ' + aggregate + ')');
});
