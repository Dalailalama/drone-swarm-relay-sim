// Audit ui-render/hillshade-regenerated-every-pan-frame: the 2D hillshade
// layer was keyed on the rounded view centre, so every pan frame rebuilt the
// whole per-pixel ImageData (2 terrainGroundAt calls per pixel, 44-63 ms in
// Chrome). Panning must reuse one world-anchored buffer and only shift where
// it is drawn; it is rebuilt when the view leaves it or the zoom changes.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

test('panning hilly terrain reuses the hillshade layer instead of regenerating it', () => {
  const { ctx, document } = loadUI();
  const s = ctx.sim.swarm;
  s.terrain.groundAmpM = 80;
  s.terrain.buildings = [];
  const cv = document.createElement('canvas');
  cv.width = 400; cv.height = 300;
  const g = cv.getContext('2d');
  const draws = [];
  g.drawImage = (img, x, y, w, h) => { draws.push({ img, x, y, w, h }); };
  const realGround = ctx.terrainGroundAt;
  let calls = 0;
  ctx.terrainGroundAt = function () { calls++; return realGround.apply(this, arguments); };

  const view = { cx: 0, cy: 0, pxPerM: 0.5 };
  ctx.drawTerrain(g, cv, view, s);
  const full = calls;
  assert.ok(full > 0, 'first frame builds the layer');
  const first = draws[0];

  for (let i = 1; i <= 30; i++) {
    view.cx += 5 / view.pxPerM; // 5 px pan per frame
    ctx.drawTerrain(g, cv, view, s);
  }
  assert.ok(calls - full <= full, '30 pan frames cost ' + (calls - full) + ' ground samples; one rebuild is ' + full);
  // Whenever the layer was reused, it must have moved with the pan.
  for (let i = 1; i < draws.length; i++) {
    if (draws[i].img !== draws[i - 1].img) continue;
    assert.ok(Math.abs(draws[i].x - (draws[i - 1].x - 5)) < 1e-6, 'a reused layer shifts 5 px left per frame');
    assert.strictEqual(draws[i].y, draws[i - 1].y);
  }
  // It covers the whole canvas.
  for (const d of draws) {
    assert.ok(d.x <= 0 && d.y <= 0 && d.x + d.w >= cv.width && d.y + d.h >= cv.height, 'layer covers the canvas');
  }
  assert.ok(first.w >= cv.width && first.h >= cv.height);

  // A zoom change still rebuilds.
  const before = calls;
  view.pxPerM *= 2;
  ctx.drawTerrain(g, cv, view, s);
  assert.ok(calls > before, 'zooming regenerates the layer');
});
