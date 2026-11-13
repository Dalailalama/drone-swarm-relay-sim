// Audit (ui-render/carto-tiles-api-key-watermark): CARTO's raster basemaps
// now require an API key; keyless requests return a 200-OK "API KEY
// REQUIRED" watermark tile, so the onload path drew it as the map in 2D and
// 3D. The basemap must come from a keyless provider whose usage policy
// permits this use, and the on-screen credit must name that provider.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

test('basemap tiles come from the keyless OSM standard tile server, not CARTO', () => {
  const ui = loadUI();
  const tileGet = vm.runInContext('tileGet', ui.ctx);
  const e = tileGet(16, 18939, 24658);
  assert.ok(e && e.img, 'tile request created');
  assert.strictEqual(e.img.src, 'https://tile.openstreetmap.org/16/18939/24658.png');
  assert.doesNotMatch(e.img.src, /cartocdn/, 'CARTO raster tiles need an API key');
  // Antimeridian wrap still applies to the keyless URL.
  assert.strictEqual(tileGet(3, -1, 2).img.src, 'https://tile.openstreetmap.org/3/7/2.png');
});

test('map credit names OpenStreetMap only (no CARTO style is drawn any more)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/<div id="mapAttrib"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(m, '#mapAttrib exists');
  assert.match(m[1], /OpenStreetMap/);
  assert.match(m[1], /openstreetmap\.org\/copyright/);
  assert.doesNotMatch(m[1], /CARTO/i);
});

// The veil drawn over the basemap was tuned for CARTO's DARK tiles (~#262626
// under it: the cream map labels read ~11:1). The OSM standard style is
// light (#f2efe9 land), and under the same 30% veil those labels fell to
// ~1.5:1, unreadable on the real map in 2D and on the 3D drape.
function rgbOf(css) {
  const h = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css);
  if (h) return { c: [1, 2, 3].map(i => parseInt(h[i], 16)), a: 1 };
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css);
  assert.ok(m, 'unparsed colour ' + css);
  return { c: [+m[1], +m[2], +m[3]], a: m[4] == null ? 1 : +m[4] };
}
function contrastOf(fg, bg) {
  const lum = c => c.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// Paint the fills recorded after the tiles over OSM's land colour.
function overLand(fills) {
  let c = [242, 239, 233];
  for (const f of fills) { const { c: k, a } = rgbOf(f); c = c.map((v, i) => (1 - a) * v + a * k[i]); }
  return c;
}
function recordAfterTiles(g) {
  const fills = [];
  let drew = false;
  g.drawImage = () => { drew = true; };
  g.fillRect = () => { if (drew) fills.push(g.fillStyle); };
  return fills;
}

test('the veil over the light OSM tiles keeps the map labels legible, in 2D and on the 3D drape', () => {
  const { ctx, document } = loadUI();
  ctx.tileGet = () => ({ ok: true, img: {} });
  const text = rgbOf(vm.runInContext('COLORS', ctx).text).c;
  const anchor = { lat: 40, lon: -74, x: 0, y: 0 };

  const cv = document.createElement('canvas');
  cv.width = 400; cv.height = 300;
  const fills2d = recordAfterTiles(cv.getContext('2d'));
  assert.ok(ctx.drawTiles(cv.getContext('2d'), cv, { cx: 0, cy: 0, pxPerM: 1 }, anchor));
  assert.ok(fills2d.length, 'a veil is drawn over the tiles');
  const r2d = contrastOf(text, overLand(fills2d));
  assert.ok(r2d >= 4.5, '2D map label contrast on OSM land ' + r2d.toFixed(2) + ':1');

  const mk = document.createElement;
  let fills3d = null;
  document.createElement = tag => {
    const e = mk(tag);
    if (String(tag).toLowerCase() === 'canvas') fills3d = recordAfterTiles(e.getContext('2d'));
    return e;
  };
  assert.ok(ctx.buildGroundTexture(anchor, -800, -800, 800, 800, 0), 'the 3D ground texture is built');
  const r3d = contrastOf(text, overLand(fills3d));
  assert.ok(r3d >= 4.5, '3D drape label contrast on OSM land ' + r3d.toFixed(2) + ':1');
});
