// Audit ui-render/ghost-marker-undefined-color: drawLostMarkers painted with
// COLORS.lost, which did not exist. A canvas ignores an unparsable colour, so
// the ghost ring and '?' inherited whatever style was set last (often the
// link-OK green). Its "drone nearby" test also used a bare 26 px, which is
// only 13 CSS px at DPR 2.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

// A canvas-like context whose style setters drop non-string values, the way
// a real canvas drops colours it cannot parse.
function strictCtx() {
  let stroke = '#8fd960', fill = '#8fd960';
  const log = { strokes: [], texts: [] };
  const c = {
    get strokeStyle() { return stroke; }, set strokeStyle(v) { if (typeof v === 'string') stroke = v; },
    get fillStyle() { return fill; }, set fillStyle(v) { if (typeof v === 'string') fill = v; },
    lineWidth: 1, font: '', textAlign: 'start',
    beginPath() {}, arc() {}, setLineDash() {},
    stroke() { log.strokes.push(stroke); },
    fillText(t) { log.texts.push({ t, fill }); },
  };
  return { c, log };
}

test('lost-drone ghost is drawn in the lost colour, and the nearby test scales with DPR', () => {
  const { ctx } = loadUI();
  ctx.window.uiScale = 2;
  const cv = { width: 800, height: 600 };
  const view = { cx: 0, cy: 0, pxPerM: 1 };
  const s = { c2: { lost: { 'DR-1': { x: 0, y: 0 } } }, drones: [] };

  const a = strictCtx();
  ctx.drawLostMarkers(a.c, cv, view, s);
  assert.deepStrictEqual(a.log.strokes, ['#e06050'], 'ghost ring is red, not the last link colour');
  const q = a.log.texts.find(t => t.t === '?');
  assert.ok(q && q.fill === '#e06050', "the '?' is red");
  const lbl = a.log.texts.find(t => /last seen/.test(t.t));
  assert.ok(lbl && lbl.fill === '#8a887a', 'the label stays dim');

  // A drone 40 canvas px (20 CSS px at DPR 2) from the ghost suppresses the label.
  s.drones = [{ x: 40, y: 0 }];
  const b = strictCtx();
  ctx.drawLostMarkers(b.c, cv, view, s);
  assert.strictEqual(b.log.texts.length, 0, 'label suppressed when a drone sits on its ghost');
});
