// Basemap projection tests — run with:  node --test test/
// Pure arithmetic, no network and no <img>: only the four coordinate
// functions the tile drawer leans on. Pins the Web-Mercator round trip,
// the sim frame's sign convention (x=East, y=South, shared with js/osm.js),
// the anchor identity that keeps the map glued to the swarm, and the zoom
// ladder's clamps — a seam or a drift here silently mis-places every tile.

const { test } = require('node:test');
const assert = require('node:assert');

const T = require('../js/tiles.js');

const ANCHOR = { lat: 28.63, lon: 77.21, x: 263, y: -66 };   // Delhi, pinned off-origin
const DEG_TOL = 1e-6;                                        // ~0.1 m of latitude
const M_TOL = 1e-6;

// --- Web Mercator: tileFromLatLon ↔ tileToLatLon -----------------------------

test('lat/lon → tile → lat/lon round-trips at every zoom we serve', () => {
  const cases = [
    [0, 0, 3],              // equator / prime meridian
    [28.63, 77.21, 16],     // Delhi, the anchor's own zoom
    [35.66, 139.70, 15],    // Tokyo
    [60, -120, 10],         // high latitude, western hemisphere
    [-33.92, 18.42, 12],    // Cape Town, southern hemisphere
  ];
  for (const [lat, lon, z] of cases) {
    const t = T.tileFromLatLon(lat, lon, z);
    const n = Math.pow(2, z);
    assert.ok(t.x >= 0 && t.x <= n && t.y >= 0 && t.y <= n, `${lat},${lon} must land on the z${z} grid`);
    const back = T.tileToLatLon(t.x, t.y, z);
    assert.ok(Math.abs(back.lat - lat) < DEG_TOL, `lat drifted ${Math.abs(back.lat - lat)} at z${z}`);
    assert.ok(Math.abs(back.lon - lon) < DEG_TOL, `lon drifted ${Math.abs(back.lon - lon)} at z${z}`);
  }
});

test('tileToLatLon pins the projection corner: tile (0,0,0) is the NW of the world', () => {
  const nw = T.tileToLatLon(0, 0, 0);
  assert.ok(Math.abs(nw.lat - 85.0511287798) < 1e-9, 'Mercator cut-off latitude, got ' + nw.lat);
  assert.strictEqual(nw.lon, -180);
  const se = T.tileToLatLon(1, 1, 0);                       // opposite corner of the single z0 tile
  assert.ok(Math.abs(se.lat + 85.0511287798) < 1e-9, 'southern cut-off, got ' + se.lat);
  assert.strictEqual(se.lon, 180);
  // Tile y grows southward, so north of a tile row means a smaller ty.
  const north = T.tileFromLatLon(29, 77.21, 16), south = T.tileFromLatLon(28, 77.21, 16);
  assert.ok(north.y < south.y, 'tile y must grow south');
});

test('null island sits exactly at the centre of the grid at any zoom', () => {
  for (const z of [0, 3, 8, 16, 19]) {
    const t = T.tileFromLatLon(0, 0, z);
    const half = Math.pow(2, z) / 2;
    assert.strictEqual(t.x, half, 'lon 0 is half the grid at z' + z);
    assert.strictEqual(t.y, half, 'lat 0 is half the grid at z' + z);
  }
});

// --- Local sim frame ↔ lat/lon -----------------------------------------------

test('local ↔ lat/lon round-trips around the anchor', () => {
  for (const [dx, dy] of [[0, 0], [1000, 0], [0, 1000], [-1234.5, 987.6], [5, -5], [-40000, 40000]]) {
    const x = ANCHOR.x + dx, y = ANCHOR.y + dy;
    const ll = T.tileLocalToLatLon(ANCHOR, x, y);
    const back = T.tileLatLonToLocal(ANCHOR, ll.lat, ll.lon);
    assert.ok(Math.abs(back.x - x) < M_TOL, `x drifted ${Math.abs(back.x - x)} m at ${dx},${dy}`);
    assert.ok(Math.abs(back.y - y) < M_TOL, `y drifted ${Math.abs(back.y - y)} m at ${dx},${dy}`);
  }
});

test('the sim frame is x=East, y=South', () => {
  const north = T.tileLatLonToLocal(ANCHOR, ANCHOR.lat + 0.01, ANCHOR.lon);
  assert.ok(north.y < ANCHOR.y, 'north of the anchor must have a smaller y');
  assert.strictEqual(north.x, ANCHOR.x, 'due north must not move x');
  const east = T.tileLatLonToLocal(ANCHOR, ANCHOR.lat, ANCHOR.lon + 0.01);
  assert.ok(east.x > ANCHOR.x, 'east of the anchor must have a larger x');
  assert.strictEqual(east.y, ANCHOR.y, 'due east must not move y');
  // the inverse tells the same story from the other side
  assert.ok(T.tileLocalToLatLon(ANCHOR, ANCHOR.x, ANCHOR.y + 100).lat < ANCHOR.lat, '+y is southward');
  assert.ok(T.tileLocalToLatLon(ANCHOR, ANCHOR.x + 100, ANCHOR.y).lon > ANCHOR.lon, '+x is eastward');
  // 0.01° of latitude is ~1105 m, and longitude shrinks by cos(lat) at 28.63° N
  assert.ok(Math.abs((ANCHOR.y - north.y) - 1105.4) < 1, 'metres per degree of latitude');
  assert.ok(east.x - ANCHOR.x < 1105.4, 'a degree of longitude is shorter than one of latitude here');
});

test('the anchor maps to itself exactly, in both directions', () => {
  const ll = T.tileLocalToLatLon(ANCHOR, ANCHOR.x, ANCHOR.y);
  assert.strictEqual(ll.lat, ANCHOR.lat);
  assert.strictEqual(ll.lon, ANCHOR.lon);
  const local = T.tileLatLonToLocal(ANCHOR, ANCHOR.lat, ANCHOR.lon);
  assert.strictEqual(local.x, ANCHOR.x);
  assert.strictEqual(local.y, ANCHOR.y);
});

// --- tileZoomFor --------------------------------------------------------------

test('tileZoomFor clamps to the served zoom range', () => {
  assert.strictEqual(T.tileZoomFor(ANCHOR.lat, 0.00001), T.TILE_MIN_Z, 'absurdly zoomed out');
  assert.strictEqual(T.tileZoomFor(ANCHOR.lat, 1000), T.TILE_MAX_Z, 'absurdly zoomed in');
  assert.ok(T.TILE_MIN_Z < T.TILE_MAX_Z && Number.isInteger(T.TILE_MIN_Z) && Number.isInteger(T.TILE_MAX_Z));
  for (const px of [0.0001, 0.01, 0.5, 2, 17, 500]) {
    const z = T.tileZoomFor(ANCHOR.lat, px);
    assert.ok(Number.isInteger(z) && z >= T.TILE_MIN_Z && z <= T.TILE_MAX_Z, 'z was ' + z + ' at ' + px + ' px/m');
  }
});

test('tileZoomFor hits z16 when one tile pixel is one canvas pixel at the equator', () => {
  const pxPerM = Math.pow(2, 16) / T.TILE_EQUATOR_M;
  assert.strictEqual(T.tileZoomFor(0, pxPerM), 16);
  // one octave of canvas scale is one zoom level
  assert.strictEqual(T.tileZoomFor(0, pxPerM * 2), 17);
  assert.strictEqual(T.tileZoomFor(0, pxPerM / 2), 15);
  // in between it takes the *nearest* zoom, never the next one up or down
  assert.strictEqual(T.tileZoomFor(0, pxPerM * 1.1), 16, 'slightly sharper still wants z16');
  assert.strictEqual(T.tileZoomFor(0, pxPerM * 1.9), 17, 'nearly double wants z17');
  assert.strictEqual(T.tileZoomFor(0, pxPerM * 0.55), 15, 'nearly half wants z15');
});

test('higher latitude never asks for a sharper tile than the equator', () => {
  for (const pxPerM of [Math.pow(2, 16) / T.TILE_EQUATOR_M, 0.002, 0.05, 1, 30]) {
    const eq = T.tileZoomFor(0, pxPerM);
    let prev = eq;
    for (const lat of [15, 28.63, 45, 60, 75, 85, -60, -85]) {
      const z = T.tileZoomFor(lat, pxPerM);
      assert.ok(z <= eq, `z${z} at ${lat}° beats the equator's z${eq} at ${pxPerM} px/m`);
      if (lat > 0) {
        assert.ok(z <= prev, 'zoom must fall monotonically with latitude');
        prev = z;
      }
    }
  }
});

// --- All four together --------------------------------------------------------

test('local → lat/lon → tile → lat/lon → local returns within 0.5 m a km out', () => {
  const z = 16;
  for (const [dx, dy] of [[1000, 0], [0, 1000], [-1000, 0], [0, -1000], [707.1, 707.1], [-707.1, -707.1]]) {
    const x = ANCHOR.x + dx, y = ANCHOR.y + dy;
    const ll = T.tileLocalToLatLon(ANCHOR, x, y);
    const t = T.tileFromLatLon(ll.lat, ll.lon, z);
    const ll2 = T.tileToLatLon(t.x, t.y, z);
    const back = T.tileLatLonToLocal(ANCHOR, ll2.lat, ll2.lon);
    const err = Math.hypot(back.x - x, back.y - y);
    assert.ok(err < 0.5, `drifted ${err.toFixed(3)} m at ${dx},${dy}`);
  }
});
