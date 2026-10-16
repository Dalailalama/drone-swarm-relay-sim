// Audit (tools-data-integrations/osm-drops-multipolygon-buildings): the
// Overpass query asked only for building WAYS, and the parser rejected
// anything else. Buildings mapped as multipolygon relations carry their tags
// on the relation with untagged outer ways, so they vanished (~26% of the
// building footprint in central Berlin) and radio/LOS went straight through.
const { test } = require('node:test');
const assert = require('node:assert');
const O = require('../js/osm.js');

const LAT0 = 52.517, LON0 = 13.3889;                    // Berlin Mitte
const pt = (lat, lon) => ({ lat, lon });

test('a multipolygon building relation becomes a building, tags from the relation', () => {
  // Outer ring split across two untagged ways (as mappers often do), plus an
  // inner courtyard that must not create a second box.
  const a = pt(LAT0, LON0), b = pt(LAT0, LON0 + 0.001);
  const c = pt(LAT0 + 0.0008, LON0 + 0.001), d = pt(LAT0 + 0.0008, LON0);
  const rel = {
    type: 'relation', tags: { building: 'yes', type: 'multipolygon', height: '30' },
    members: [
      { type: 'way', role: 'outer', geometry: [a, b, c] },
      { type: 'way', role: 'outer', geometry: [a, d, c] },   // reversed half
      { type: 'way', role: 'inner', geometry: [
        pt(LAT0 + 0.0003, LON0 + 0.0003), pt(LAT0 + 0.0003, LON0 + 0.0006),
        pt(LAT0 + 0.0005, LON0 + 0.0006), pt(LAT0 + 0.0003, LON0 + 0.0003)] },
    ],
  };
  const { buildings } = O.osmParseBuildings({ elements: [rel] }, LAT0, LON0);
  assert.strictEqual(buildings.length, 1, 'one box per outer ring');
  const k = O.geoMetresPerDeg(LAT0);
  assert.strictEqual(buildings[0].heightM, 30);
  assert.ok(Math.abs(buildings[0].w - 0.001 * k.lon) < 1e-6);
  assert.ok(Math.abs(buildings[0].d - 0.0008 * k.lat) < 1e-6);
});

test('building=no is not a building', () => {
  const w = { type: 'way', tags: { building: 'no' }, geometry: [
    pt(LAT0, LON0), pt(LAT0, LON0 + 0.001), pt(LAT0 + 0.001, LON0 + 0.001), pt(LAT0, LON0)] };
  assert.strictEqual(O.osmParseBuildings({ elements: [w] }, LAT0, LON0).buildings.length, 0);
});

test('the Overpass query asks for building relations and skips building=no', () => {
  const q = O.osmBuildingQuery(LAT0, LON0, 500);
  assert.match(q, /relation\["building"\]\["type"="multipolygon"\]\(around:500,/);
  assert.match(q, /way\["building"\]\["building"!="no"\]\(around:500,/);
  assert.match(q, /out geom;$/);
});
