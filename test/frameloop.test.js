// Soak-audit finding R7 (issue #21): any exception inside main.js frame()
// skipped its trailing requestAnimationFrame(frame), so ONE bad frame ended
// the render loop for good — a frozen page with nothing on screen saying
// why. (Seen live: an extreme objective made planChain's Map overflow.)
// The loop must always re-queue, and the error must be surfaced once, not
// once per frame.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

test('R7: a throwing frame keeps the render loop alive and reports the error once', () => {
  const { ctx, el } = loadUI();
  const realStep = ctx.stepSwarm;
  const logged = [];
  const origErr = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    ctx.stepSwarm = () => { throw new RangeError('Map maximum size exceeded'); };
    for (let i = 0; i < 5; i++) {
      try { ctx.__raf.pump(100); } catch (_) { /* old code: the throw escapes the frame */ }
    }
    assert.ok(ctx.__raf.pending > 0, 'the frame must be re-queued after an exception');
    const events = ctx.sim.swarm.events.filter(e => /Map maximum size exceeded/.test(e.msg));
    assert.strictEqual(events.length, 1, 'the error must be surfaced once, not every frame');
    assert.strictEqual(logged.filter(l => /Map maximum size exceeded/.test(l)).length, 1, 'console gets it once');
    assert.match(el('statusPill').textContent, /error/i, 'the status pill must say something went wrong');

    // Once the fault clears, the same loop resumes simulating.
    ctx.stepSwarm = realStep;
    const t0 = ctx.sim.swarm.time;
    for (let i = 0; i < 5; i++) ctx.__raf.pump(100);
    assert.ok(ctx.sim.swarm.time > t0, 'the loop must keep stepping after recovery');
  } finally {
    console.error = origErr;
    ctx.stepSwarm = realStep;
  }
});
