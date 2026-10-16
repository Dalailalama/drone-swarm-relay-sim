// Audit ui-render/jammer-selection-halo-never-drawn: render() forwarded the
// selected DRONE to drawJammers, so `j === selected` never held and the
// documented dashed halo on the selected interference source was dead code;
// GPS zones had no selection mark at all, and both map labels lacked the id
// the panel names ("editing JX-2"). The halo must ring exactly the selected
// source/zone, and its label must carry the id.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

function recordMap(el) {
  const c = el('map').getContext('2d');
  const log = { halos: [], texts: [] };
  let lastArc = null;
  const arc = c.arc, stroke = c.stroke, fillText = c.fillText;
  c.arc = function (x, y, r) { lastArc = { x, y, r }; return arc.apply(this, arguments); };
  c.stroke = function () {
    if (c.strokeStyle === '#e8e6da' && lastArc) log.halos.push(lastArc);
    return stroke.apply(this, arguments);
  };
  c.fillText = function (t, x, y) { log.texts.push({ t: String(t), x, y }); return fillText.apply(this, arguments); };
  log.reset = () => { log.halos.length = 0; log.texts.length = 0; };
  return log;
}

test('selected interference source and GPS zone get a halo and an id label on the 2D map', () => {
  const { ctx, el, fire } = loadUI();
  const U = ctx.window.uiScale || 1;
  fire('addJammerBtn', 'click');
  fire('addJammerBtn', 'click');
  const [j1, j2] = ctx.sim.swarm.jammers;
  const log = recordMap(el);
  ctx.__raf.pump(16);

  const jHalos = log.halos.filter(h => Math.abs(h.r - 15 * U) < 1e-9);
  assert.strictEqual(jHalos.length, 1, 'exactly one jammer halo (the selected source)');
  const lbl2 = log.texts.find(t => t.t.includes(j2.id));
  const lbl1 = log.texts.find(t => t.t.includes(j1.id));
  assert.ok(lbl1 && lbl2, 'both source labels must name their id');
  assert.ok(Math.abs(jHalos[0].x - lbl2.x) < 1e-6, 'the halo rings the selected source ' + j2.id);
  assert.ok(Math.abs(jHalos[0].x - lbl1.x) > 1e-6, 'and not the other one');

  fire('addGpsZoneBtn', 'click');
  const z = ctx.sim.swarm.gpsZones[ctx.sim.swarm.gpsZones.length - 1];
  log.reset();
  ctx.__raf.pump(16);
  assert.strictEqual(log.halos.filter(h => Math.abs(h.r - 15 * U) < 1e-9).length, 0,
    'adding a zone deselects the source, so its halo goes');
  const zHalos = log.halos.filter(h => Math.abs(h.r - 14 * U) < 1e-9);
  assert.strictEqual(zHalos.length, 1, 'the selected GPS zone gets a halo');
  const zl = log.texts.find(t => t.t.includes(z.id) && /GPS DENIED/.test(t.t));
  assert.ok(zl, 'the zone label names its id');
  assert.ok(Math.abs(zHalos[0].x - zl.x) < 1e-6, 'the halo rings the selected zone');
});
