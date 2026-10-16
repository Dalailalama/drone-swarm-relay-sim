// Audit (tools-data-integrations/tak-georef-not-submetre,
// devex-tests-ci/tak-lon-scale-mismatch): TAK, OSM and the tile basemap each
// carried their own equirectangular constants — TAK used 110540 m/deg for
// longitude while OSM/tiles used 111320, and 110540 is below the true
// meridian degree everywhere — so a drone over an imported OSM building 3 km
// east of the anchor was exported ~21 m off it. One WGS-84 local scale must
// be shared by all three frames.
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../js/tak.js');
const O = require('../js/osm.js');
const TL = require('../js/tiles.js');

// Published WGS-84 metres per degree (meridian arc / parallel) at latitude.
const WGS84 = {
  0: { lat: 110574.3, lon: 111319.5 },
  45: { lat: 111131.8, lon: 78846.8 },
  60: { lat: 111412.3, lon: 55799.0 },
};

test('TAK export is within 1 m of WGS-84 at 3 km E and N (lat 0, 45, 60)', () => {
  for (const [latS, k] of Object.entries(WGS84)) {
    const lat = Number(latS);
    const a = T.makeTakAnchor(lat, 10, 0, 0);
    const e = T.localToLatLon(a, 3000, 0);
    const n = T.localToLatLon(a, 0, -3000);
    const eErr = Math.abs((e.lon - 10) * k.lon - 3000);
    const nErr = Math.abs((n.lat - lat) * k.lat - 3000);
    assert.ok(eErr < 1, 'lat ' + lat + ': 3 km east off by ' + eErr.toFixed(2) + ' m');
    assert.ok(nErr < 1, 'lat ' + lat + ': 3 km north off by ' + nErr.toFixed(2) + ' m');
  }
});

test('TAK, tiles and OSM import share one local frame', () => {
  const lat0 = 28.6315, lon0 = 77.2167;           // Connaught Place
  const a = T.makeTakAnchor(lat0, lon0, 0, 0);
  for (const [x, y] of [[2931, 0], [0, -2500], [-1800, 1200]]) {
    const t = T.localToLatLon(a, x, y);
    const g = TL.tileLocalToLatLon({ lat: lat0, lon: lon0, x: 0, y: 0 }, x, y);
    assert.ok(Math.abs(t.lat - g.lat) < 1e-9 && Math.abs(t.lon - g.lon) < 1e-9,
      'tak and tiles disagree at (' + x + ',' + y + ')');
  }
  // An OSM building 0.03 deg east, exported back through TAK, lands on itself.
  const d = 0.0002, lonB = lon0 + 0.03;
  const way = { type: 'way', tags: { building: 'yes' }, geometry: [
    { lat: lat0, lon: lonB }, { lat: lat0, lon: lonB + d }, { lat: lat0 + d, lon: lonB + d },
    { lat: lat0 + d, lon: lonB }, { lat: lat0, lon: lonB }] };
  const b = O.osmWayToBuilding(way, lat0, lon0);
  const ll = T.localToLatLon(a, b.x, b.y);
  const eastErrM = Math.abs(ll.lon - (lonB + d / 2)) * 111320 * Math.cos(lat0 * Math.PI / 180);
  assert.ok(eastErrM < 0.5, 'OSM building exported ' + eastErrM.toFixed(1) + ' m east-west off');
});
