// OpenStreetMap import tests — run with:  node --test test/
// Pure parsing only, no network: hand-built Overpass-style fixtures go in,
// sim-frame building boxes come out. Pins the metre projection (x=East,
// y=South), the height precedence chain (tag → floors → default) and the
// honesty of the `estimated` flag our radio physics leans on.

const { test } = require('node:test');
const assert = require('node:assert');

const O = require('../js/osm.js');

const LAT0 = 19.07, LON0 = 72.87;                          // Mumbai
const M_PER_DEG_LAT = 110540;
const K_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);     // ≈105 211 m/deg here

// Closed Overpass way: rectangle whose SW corner is (lat, lon), extending
// dLat north and dLon east. Last point repeats the first, as Overpass sends it.
function rectWay(lat, lon, dLat, dLon, tags) {
  const corners = [[lat, lon], [lat, lon + dLon], [lat + dLat, lon + dLon], [lat + dLat, lon], [lat, lon]];
  return { type: 'way', tags, geometry: corners.map(([la, lo]) => ({ lat: la, lon: lo })) };
}

// A plain ~126 × 99 m building with its SW corner exactly on the origin.
const D_LAT = 0.0009, D_LON = 0.0012;
const EXP_W = D_LON * K_LON, EXP_D = D_LAT * M_PER_DEG_LAT;
const near = (got, want, fracTol) => Math.abs(got - want) <= Math.abs(want) * fracTol;

// --- osmParseHeight ----------------------------------------------------------

test('osmParseHeight reads bare metres, "m" units and imperial units', () => {
  assert.strictEqual(O.osmParseHeight('18.5'), 18.5);
  assert.strictEqual(O.osmParseHeight('18.5 m'), 18.5);
  assert.strictEqual(O.osmParseHeight(' 18.5m '), 18.5);
  assert.ok(Math.abs(O.osmParseHeight('60 ft') - 18.288) < 1e-6, '60 ft is 18.288 m');
  assert.ok(Math.abs(O.osmParseHeight("60'") - 18.288) < 1e-6, "60' is 18.288 m");
  assert.ok(Math.abs(O.osmParseHeight('60 feet') - 18.288) < 1e-6);
});

test('osmParseHeight rejects garbage, blanks and non-positive heights', () => {
  for (const bad of ['Mumbai', '', '   ', '18,5', '12 storeys', null, undefined, '-4', '-4 m', '0']) {
    assert.strictEqual(O.osmParseHeight(bad), null, JSON.stringify(bad) + ' should not parse');
  }
});

// --- osmWayToBuilding: projection --------------------------------------------

test('osmWayToBuilding projects a rectangle to the right size in metres', () => {
  const b = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON), LAT0, LON0);
  assert.ok(near(b.w, EXP_W, 0.01), 'w was ' + b.w.toFixed(2) + ', expected ' + EXP_W.toFixed(2));
  assert.ok(near(b.d, EXP_D, 0.01), 'd was ' + b.d.toFixed(2) + ', expected ' + EXP_D.toFixed(2));
  // independent sanity: 0.0012° of longitude at 19° N really is ~126 m
  assert.ok(b.w > 120 && b.w < 132, 'w should be ~126 m, got ' + b.w.toFixed(1));
  assert.ok(b.d > 95 && b.d < 104, 'd should be ~99 m, got ' + b.d.toFixed(1));
  // corner on the origin ⇒ center sits half a box north-east of it
  assert.ok(near(b.x, EXP_W / 2, 0.01), 'center x');
  assert.ok(near(b.y, -EXP_D / 2, 0.01), 'center y');
});

test('osmWayToBuilding uses the sim frame: x=East, y=South', () => {
  const ne = O.osmWayToBuilding(rectWay(LAT0 + 0.001, LON0 + 0.001, D_LAT, D_LON), LAT0, LON0);
  assert.ok(ne.x > 0, 'east of lon0 must give positive x');
  assert.ok(ne.y < 0, 'north of lat0 must give negative y');
  const sw = O.osmWayToBuilding(rectWay(LAT0 - 0.003, LON0 - 0.003, D_LAT, D_LON), LAT0, LON0);
  assert.ok(sw.x < 0, 'west of lon0 must give negative x');
  assert.ok(sw.y > 0, 'south of lat0 must give positive y');
  // a box centered on the origin lands at the origin
  const mid = O.osmWayToBuilding(rectWay(LAT0 - D_LAT / 2, LON0 - D_LON / 2, D_LAT, D_LON), LAT0, LON0);
  assert.ok(Math.abs(mid.x) < 1e-6 && Math.abs(mid.y) < 1e-6, 'centered box should sit at 0,0');
});

// --- osmWayToBuilding: heights -----------------------------------------------

test('mapped height wins over floor count and is not marked estimated', () => {
  const b = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON, { height: '42.5 m', 'building:levels': '3' }), LAT0, LON0);
  assert.strictEqual(b.heightM, 42.5);
  assert.strictEqual(b.estimated, false);
  const ft = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON, { height: '100 ft' }), LAT0, LON0);
  assert.ok(Math.abs(ft.heightM - 30.48) < 1e-6);
  assert.strictEqual(ft.estimated, false);
  // building:height is the accepted fallback spelling, still measured
  const alt = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON, { 'building:height': '30' }), LAT0, LON0);
  assert.strictEqual(alt.heightM, 30);
  assert.strictEqual(alt.estimated, false);
});

test('floor count alone becomes levels × storey height + 2, flagged estimated', () => {
  const b = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON, { 'building:levels': '12' }), LAT0, LON0);
  assert.strictEqual(b.heightM, 12 * O.OSM_LEVEL_HEIGHT_M + 2);
  assert.strictEqual(b.estimated, true);
});

test('untagged or nonsense-tagged buildings fall back to the low-rise default', () => {
  const bare = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON), LAT0, LON0);
  assert.strictEqual(bare.heightM, O.OSM_DEFAULT_HEIGHT_M);
  assert.strictEqual(bare.estimated, true);
  for (const tags of [{ building: 'yes' }, { height: 'tall' }, { height: '-4' }, { 'building:levels': '0' }]) {
    const b = O.osmWayToBuilding(rectWay(LAT0, LON0, D_LAT, D_LON, tags), LAT0, LON0);
    assert.strictEqual(b.heightM, O.OSM_DEFAULT_HEIGHT_M, JSON.stringify(tags));
    assert.strictEqual(b.estimated, true, JSON.stringify(tags) + ' must admit it is a guess');
  }
});

// --- osmWayToBuilding: rejections --------------------------------------------

test('degenerate ways are rejected instead of becoming zero-size boxes', () => {
  const twoPoints = { type: 'way', geometry: [{ lat: LAT0, lon: LON0 }, { lat: LAT0 + D_LAT, lon: LON0 + D_LON }] };
  assert.strictEqual(O.osmWayToBuilding(twoPoints, LAT0, LON0), null, 'needs ≥3 points');
  assert.strictEqual(O.osmWayToBuilding({ type: 'way', geometry: [] }, LAT0, LON0), null);
  assert.strictEqual(O.osmWayToBuilding({ type: 'way' }, LAT0, LON0), null, 'no geometry (out ids only)');
  assert.strictEqual(O.osmWayToBuilding(null, LAT0, LON0), null);
});

test('sliver footprints (≤2 m on either side) are dropped', () => {
  const thin = rectWay(LAT0, LON0, D_LAT, 0.00001);   // ~1.1 m wide, ~99 m deep
  assert.strictEqual(O.osmWayToBuilding(thin, LAT0, LON0), null, 'thin wall is not a building');
  const flat = rectWay(LAT0, LON0, 0.00001, D_LON);   // ~1.1 m deep
  assert.strictEqual(O.osmWayToBuilding(flat, LAT0, LON0), null);
  // just over the threshold on both sides still survives
  const small = O.osmWayToBuilding(rectWay(LAT0, LON0, 0.00005, 0.00005), LAT0, LON0);
  assert.ok(small && small.w > 2 && small.d > 2, '~5 m hut should survive');
});

test('non-way elements (nodes, relations) are ignored', () => {
  const geometry = rectWay(LAT0, LON0, D_LAT, D_LON).geometry;
  assert.strictEqual(O.osmWayToBuilding({ type: 'node', geometry }, LAT0, LON0), null);
  assert.strictEqual(O.osmWayToBuilding({ type: 'relation', geometry }, LAT0, LON0), null);
});

// --- osmParseBuildings -------------------------------------------------------

test('osmParseBuildings keeps the valid ways, biggest footprint first', () => {
  const json = { elements: [
    rectWay(LAT0, LON0, 0.0005, 0.0006, { 'building:levels': '2' }),      // ~55 × 63 m
    { type: 'node', lat: LAT0, lon: LON0, tags: { building: 'yes' } },    // skipped
    rectWay(LAT0 + 0.002, LON0, 0.0002, 0.0003),                          // ~22 × 32 m
    rectWay(LAT0, LON0 + 0.002, D_LAT, 0.0010, { height: '80' }),         // ~99 × 105 m
    rectWay(LAT0 - 0.002, LON0, D_LAT, 0.00001),                          // sliver, skipped
  ] };
  const { buildings, dropped } = O.osmParseBuildings(json, LAT0, LON0);
  assert.strictEqual(buildings.length, 3, 'node and sliver must not survive');
  assert.strictEqual(dropped, 0, 'well under the cap, so nothing is dropped');
  const areas = buildings.map(b => b.w * b.d);
  for (let i = 1; i < areas.length; i++) {
    assert.ok(areas[i - 1] >= areas[i], 'footprints must be sorted descending: ' + areas.join(' , '));
  }
  assert.strictEqual(buildings[0].heightM, 80, 'the 99 × 105 m block should lead');
  // the cap governs the slice; a small set is returned whole
  assert.ok(O.OSM_MAX_BUILDINGS >= 1000 && Number.isInteger(O.OSM_MAX_BUILDINGS));
  assert.strictEqual(buildings.length, Math.min(3, O.OSM_MAX_BUILDINGS));
  assert.strictEqual(dropped, Math.max(0, 3 - O.OSM_MAX_BUILDINGS));
});

test('empty or missing Overpass payloads give an empty result, not a throw', () => {
  for (const json of [null, undefined, {}, { elements: [] }, { elements: [{ type: 'node' }] }]) {
    const r = O.osmParseBuildings(json, LAT0, LON0);
    assert.deepStrictEqual(r, { buildings: [], dropped: 0 }, JSON.stringify(json));
  }
});

// --- osmClearZones -----------------------------------------------------------

test('osmClearZones removes only the buildings centered inside a zone', () => {
  const inside = { x: 10, y: 5, w: 20, d: 20, heightM: 9 };
  const alsoInside = { x: -20, y: 0, w: 20, d: 20, heightM: 9 };   // inside the 2nd zone
  const onEdge = { x: 0, y: 30, w: 20, d: 20, heightM: 9 };        // exactly rM away: kept
  const far = { x: 400, y: 400, w: 20, d: 20, heightM: 9 };
  const buildings = [inside, onEdge, far, alsoInside];
  const cleared = O.osmClearZones(buildings, [{ x: 0, y: 0, rM: 30 }, { x: -25, y: 0, rM: 10 }]);
  assert.strictEqual(cleared, 2);
  assert.strictEqual(buildings.length, 2);
  assert.strictEqual(buildings[0], onEdge, 'survivors keep their objects and order');
  assert.strictEqual(buildings[1], far);
  assert.deepStrictEqual(far, { x: 400, y: 400, w: 20, d: 20, heightM: 9 }, 'survivors are untouched');
});

test('osmClearZones with no zones or no hits clears nothing', () => {
  const buildings = [{ x: 0, y: 0, w: 10, d: 10, heightM: 9 }, { x: 50, y: 50, w: 10, d: 10, heightM: 9 }];
  assert.strictEqual(O.osmClearZones(buildings, []), 0);
  assert.strictEqual(O.osmClearZones(buildings, [{ x: 1000, y: 1000, rM: 100 }]), 0);
  assert.strictEqual(buildings.length, 2);
});

// --- osmParseLatLon ----------------------------------------------------------

test('osmParseLatLon accepts "lat, lon" pairs', () => {
  assert.deepStrictEqual(O.osmParseLatLon('19.07, 72.87'), { lat: 19.07, lon: 72.87 });
  assert.deepStrictEqual(O.osmParseLatLon('19,72'), { lat: 19, lon: 72 });
  assert.deepStrictEqual(O.osmParseLatLon('  -33.92 ,  18.42  '), { lat: -33.92, lon: 18.42 });
  assert.deepStrictEqual(O.osmParseLatLon('0,0'), { lat: 0, lon: 0 });
});

test('osmParseLatLon rejects place names and out-of-range coordinates', () => {
  for (const bad of ['Mumbai', 'Mumbai, India', '', '19.07', '95, 10', '-91, 10', '10, 190', '10, -181', '19.07 72.87']) {
    assert.strictEqual(O.osmParseLatLon(bad), null, JSON.stringify(bad) + ' should be treated as a place name');
  }
});
