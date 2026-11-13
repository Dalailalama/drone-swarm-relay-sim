// The '120×' button delivered about 57× on a 60 Hz display (audit
// ui-render/speed-120x-capped): each frame was capped at 1.0 sim-s, and
// float drift in `simAccum -= 0.05` made that 19 steps, not 20. Under CPU
// load every button overstated, with nothing on screen saying so. The loop
// now steps an integer count within a per-frame time budget, drops a backlog
// it cannot clear, and the clock KPI shows the achieved rate when it falls
// short of the selected one.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

const VSYNC_MS = 1000 / 60;

// Boot, then make every stepSwarm call cost `msPerStep` of (fake) wall time.
function bootWithStepCost(msPerStep) {
  const ui = loadUI();
  const real = ui.ctx.stepSwarm;
  ui.ctx.stepSwarm = (s, dt) => { ui.ctx.__clock.ms += msPerStep; return real(s, dt); };
  for (let i = 0; i < 3; i++) ui.ctx.__raf.pump(VSYNC_MS);   // settle lastT
  return ui;
}
function run(ui, frames) {
  const s = ui.ctx.sim.swarm, sim0 = s.time, wall0 = ui.ctx.__clock.ms;
  for (let i = 0; i < frames; i++) ui.ctx.__raf.pump(VSYNC_MS);
  return { rate: (s.time - sim0) / ((ui.ctx.__clock.ms - wall0) / 1000), frames };
}

test('120x delivers 120x on a 60 Hz display when stepping is cheap', () => {
  const ui = bootWithStepCost(0);
  ui.querySelector('[data-speed="120"]').click();
  const { rate } = run(ui, 120);
  assert.ok(rate >= 0.95 * 120, 'achieved ' + rate.toFixed(1) + 'x');
  assert.match(ui.el('kpiClock').textContent, /^T\+\d\d:\d\d$/, 'no shortfall note when the selected rate is met');
});

test('under CPU load the frame rate holds and the clock shows the achieved rate', () => {
  const ui = bootWithStepCost(2.28);                   // ~120 drones in Chrome
  ui.querySelector('[data-speed="120"]').click();
  run(ui, 60);                                         // let the rate window fill
  const wall0 = ui.ctx.__clock.ms;
  const { rate } = run(ui, 120);
  const fps = 120 / ((ui.ctx.__clock.ms - wall0) / 1000);
  assert.ok(fps >= 30, 'frames must not stall behind the stepping: ' + fps.toFixed(1) + ' fps');
  const m = / · (\d+)×$/.exec(ui.el('kpiClock').textContent);
  assert.ok(m, 'the clock must show the achieved rate: ' + ui.el('kpiClock').textContent);
  assert.ok(Math.abs(+m[1] - rate) <= Math.max(1, 0.05 * rate), 'shown ' + m[1] + 'x, measured ' + rate.toFixed(1) + 'x');
  ui.querySelector('[data-speed="1"]').click();         // a dropped backlog leaves no lag behind
  const slow = run(ui, 60);
  assert.ok(Math.abs(slow.rate - 1) < 0.1, '1x right after 120x: ' + slow.rate.toFixed(2) + 'x');
});
