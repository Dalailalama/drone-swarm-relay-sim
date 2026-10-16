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
