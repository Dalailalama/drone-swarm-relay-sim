// Map taps select, drags move (audit ui-render/tap-drone-moves-target).
// On a phone (375 CSS px, DPR 2, touch) every orbiting mission drone sits
// inside the target's widened 41.6 px hit radius, and the press grabbed the
// target before the drone hit test ran: a tap on a drone left it unselected
// and teleported the objective to the finger (and into the replay capture).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

const PHONE = { viewport: { width: 375, height: 812 }, devicePixelRatio: 2 };

// Boot on the phone layout and fly the default mission to its orbit.
function phoneAt240() {
  const ui = loadUI(PHONE);
  const s = ui.ctx.sim.swarm;
  while (s.time < 240) ui.ctx.stepSwarm(s, 0.05);
  return ui;
}

// Canvas px -> the clientX/Y a real pointer event would carry (canvas is
// backed at DPR 2 with its box at the origin).
function touch(ui, type, p, id) {
  return ui.fire('map', type, { pointerId: id || 1, pointerType: 'touch', clientX: p.x / 2, clientY: p.y / 2 });
}
const screenOf = (ui, o) => ui.ctx.worldToScreen(ui.ctx.sim.view, ui.el('map'), o.x, o.y);
const targetActions = (s) => (s.userActions || []).filter(a => a.type === 'target');

test('tapping a mission drone near the target selects it and leaves the target alone', () => {
  const ui = phoneAt240();
  const s = ui.ctx.sim.swarm;
  const ts = screenOf(ui, s.target);
  const d = s.drones.find(x => {
    const p = screenOf(ui, x);
    return Math.hypot(p.x - ts.x, p.y - ts.y) / 2 < 41.6 && Math.hypot(p.x - ts.x, p.y - ts.y) / 2 > 12;
  });
  assert.ok(d, 'precondition: a drone orbits inside the target\'s touch hit radius');
  const tgt = { x: s.target.x, y: s.target.y };
  const acts = targetActions(s).length;
  const p = screenOf(ui, d);
  touch(ui, 'pointerdown', p);
  touch(ui, 'pointermove', { x: p.x + 3, y: p.y });   // finger wobble, under the slop
  touch(ui, 'pointerup', { x: p.x + 3, y: p.y });
  assert.deepStrictEqual({ x: s.target.x, y: s.target.y }, tgt, 'the tap must not move the target');
  assert.strictEqual(ui.el('killBtn').textContent, 'Kill ' + d.id, 'the tapped drone is selected');
  assert.strictEqual(targetActions(s).length, acts, 'a tap records no target move');
});

test('dragging the target moves it by the pointer delta, with no jump to the finger', () => {
  const ui = phoneAt240();
  const s = ui.ctx.sim.swarm, view = ui.ctx.sim.view;
  const ts = screenOf(ui, s.target);
  const grab = { x: ts.x + 10, y: ts.y };              // off-centre press: still the target
  const tgt = { x: s.target.x, y: s.target.y };
  touch(ui, 'pointerdown', grab);
  touch(ui, 'pointermove', { x: grab.x + 40, y: grab.y });
  touch(ui, 'pointerup', { x: grab.x + 40, y: grab.y });
  assert.ok(Math.abs(s.target.x - (tgt.x + 40 / view.pxPerM)) < 1e-6, 'moved by exactly the pointer delta');
  assert.ok(Math.abs(s.target.y - tgt.y) < 1e-6);
  assert.ok(targetActions(s).length > 0, 'a real drag is recorded for replay');
});

test('tapping the target centre changes neither the target nor the selection', () => {
  const ui = phoneAt240();
  const s = ui.ctx.sim.swarm;
  const before = ui.el('killBtn').textContent;
  const tgt = { x: s.target.x, y: s.target.y };
  const ts = screenOf(ui, s.target);
  touch(ui, 'pointerdown', ts);
  touch(ui, 'pointerup', ts);
  assert.deepStrictEqual({ x: s.target.x, y: s.target.y }, tgt);
  assert.strictEqual(ui.el('killBtn').textContent, before);
});
