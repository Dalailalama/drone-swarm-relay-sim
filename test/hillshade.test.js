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

// The layer key holds the seed and relief height but not the hill
// wavelength, which follows the C2->target span. Re-dialling the city on
// 'Hills + city' after the objective moved swaps in hills with the same seed
// and height but a new wavelength, and the world-anchored layer (no longer
// rebuilt by a pan) kept shading the old hills under the drones.
test('a regenerated terrain with the same seed and relief redraws the hillshade', () => {
  const { ctx, el, fire, document } = loadUI();
  el('terrainSel').value = 'mixed'; fire('terrainSel', 'change');
  const s = ctx.sim.swarm;
  const cv = document.createElement('canvas');
  cv.width = 400; cv.height = 300;
  const g = cv.getContext('2d');
  const draws = [];
  g.drawImage = (img) => { draws.push(img); };
  const view = { cx: s.base.x, cy: s.base.y, pxPerM: 0.5 };
  ctx.drawTerrain(g, cv, view, s);
  const t0 = s.terrain;

  s.target.x += 2000;                                  // a dragged objective
  el('cityDensityRange').value = 70; fire('cityDensityRange', 'input');
  ctx.__timers.run();                                  // the debounced regeneration
  assert.notStrictEqual(s.terrain, t0, 'precondition: the city was regenerated');
  assert.ok(s.terrain.seed === t0.seed && s.terrain.groundAmpM === t0.groundAmpM, 'precondition: same seed and relief');
  assert.notStrictEqual(s.terrain.groundScaleM, t0.groundScaleM, 'precondition: different hills');
  ctx.drawTerrain(g, cv, view, s);
  assert.notStrictEqual(draws[draws.length - 1], draws[0], 'the new hills are shaded, not the cached old ones');
});
