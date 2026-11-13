// ATAK / TAK integration tests — CoT atoms must be well-formed, the local
// metres <-> lat/lon conversion honest at mission scales, export->import
// must round-trip, and a real swarm's snapshot covers every live node.

const { test } = require('node:test');
const assert = require('node:assert');

const T = require('../js/tak.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['osm.js', 'tak.js']);

test('local metres <-> lat/lon round-trips inside a metre at 2 km scale', () => {
  const anchor = T.makeTakAnchor(38.8977, -77.0365, 0, 0);
  for (const [x, y] of [[0, 0], [2000, -800], [-1500, 1200], [3500, 2500]]) {
    const ll = T.localToLatLon(anchor, x, y);
    const back = T.latLonToLocal(anchor, ll.lat, ll.lon);
    assert.ok(Math.hypot(back.x - x, back.y - y) < 0.5,
      `(${x},${y}) -> ${ll.lat.toFixed(6)},${ll.lon.toFixed(6)} -> (${back.x.toFixed(2)},${back.y.toFixed(2)})`);
  }
  // South-positive y must go NEGATIVE in latitude.
  const south = T.localToLatLon(anchor, 0, 1000);
  assert.ok(south.lat < anchor.lat, 'y>0 (south) must decrease latitude');
  const east = T.localToLatLon(anchor, 1000, 0);
  assert.ok(east.lon > anchor.lon, 'x>0 (east) must increase longitude');
});

test('longitude wraps at the antimeridian both ways', () => {
  const anchor = T.makeTakAnchor(-17.7, 179.99, 0, 0); // Fiji
  const kLon = require('../js/osm.js').geoMetresPerDeg(anchor.lat).lon;
  const east = T.localToLatLon(anchor, 5000, 0);
  assert.ok(east.lon >= -180 && east.lon <= 180, 'exported lon ' + east.lon + ' is outside point.xsd range');
  assert.ok(Math.abs(east.lon - (179.99 + 5000 / kLon - 360)) < 1e-9, 'wraps to the western hemisphere');
  // A mark 0.02° east across the line is ~2.1 km east, not ~37,900 km west.
  const mark = T.latLonToLocal(anchor, -17.7, -179.99);
  assert.ok(Math.abs(mark.x - 0.02 * kLon) < 1e-3, 'imported x = ' + mark.x.toFixed(1) + ' m');
  const back = T.latLonToLocal(anchor, east.lat, east.lon);
  assert.ok(Math.hypot(back.x - 5000, back.y) < 1e-6, 'round trip across the line');
  // And westward from an anchor just east of the line.
  const west = T.localToLatLon(T.makeTakAnchor(-17.7, -179.99, 0, 0), -5000, 0);
  assert.ok(west.lon > 179 && west.lon <= 180, 'lon ' + west.lon);
});

test('CoT atoms carry required attributes and escape callsigns', () => {
  const xml = T.cotEvent({
    uid: 'SIM-DR-1', cotType: T.TAK_TYPES.drone,
    lat: 38.9, lon: -77.0, haeM: 60.5,
    callsign: 'DR-1 <relay>', nowSec: 1730000000, staleSec: 20,
  });
  assert.ok(xml.startsWith('<event version="2.0"'));
  for (const needle of ['uid="SIM-DR-1"', 'type="a-f-A-M-H-Q"', 'lat="38.9000000"',
    'hae="60.5"', 'callsign="DR-1 &lt;relay&gt;"', 'stale="', 'how="m-s"']) {
    assert.ok(xml.includes(needle), 'missing: ' + needle);
  }
});

test('snapshot covers every alive drone plus GCS, objective and hazards', () => {
  const s = ctx.makeSwarm({
    count: 5,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: R.RADIOS.find(r => r.id === 'rfd900x'),
    envFactor: 1, targetX: 1500, targetY: -400, altitudeM: 70, seed: 44,
    jammers: [{ id: 'JX-1', x: 700, y: -200, erpDbm: 24, band: 'all', altM: 15, on: true },
      { id: 'JX-off', x: 900, y: -300, erpDbm: 24, band: 'all', altM: 15, on: false }],
    gpsZones: [{ id: 'GZ-1', x: 1300, y: -380, rM: 260, on: true }],
  });
  ctx.stepSwarm(s, 1);
  const list = ctx.buildCotFromSwarm(s, T.makeTakAnchor(38.8977, -77.0365));
  assert.ok(list.length > 0);
  const blob = list.join('\n');
  for (let i = 1; i <= 5; i++) assert.ok(blob.includes('SIM-DR-' + i), 'drone DR-' + i + ' missing');
  assert.ok(blob.includes('SIM-GCS') && blob.includes('SIM-TGT'));
  assert.ok(blob.includes('JX-1'), 'active jammer exported');
  assert.ok(!blob.includes('JX-off'), 'toggled-off jammer must NOT export');
  assert.ok(blob.includes('GZ-1'), 'gps zone exported');
});

test('export -> import round-trip preserves identity and position', () => {
  const s = ctx.makeSwarm({
    count: 3, airframe: A.AIRFRAMES.find(a => a.id === 'micro'),
    radio: R.RADIOS.find(r => r.id === 'sik-v3'),
    envFactor: 1, targetX: 400, targetY: -100, altitudeM: 50, seed: 45,
  });
  const anchor = T.makeTakAnchor(38.8977, -77.0365, 0, 0);
  const atoms = ctx.buildCotFromSwarm(s, anchor).join('\n\n');
  const marks = T.parseCoTFile(atoms);
  assert.ok(marks.length >= 5, 'parsed ' + marks.length + ' marks from own export');
  const dr1 = marks.find(m => m.uid === 'SIM-DR-1');
  assert.ok(dr1, 'DR-1 present after round trip');
  const d = s.drones[0];
  const local = T.latLonToLocal(anchor, dr1.lat, dr1.lon);
  assert.ok(Math.hypot(local.x - d.x, local.y - d.y) < 1,
    'round-tripped position within 1 m of truth (' +
    Math.hypot(local.x - d.x, local.y - d.y).toFixed(3) + ' m)');
});

test('parser handles messy third-party CoT files', () => {
  const sample = [
    '<?xml version="1.0"?><events>',
    '<event version="2.0" uid="KMX-911" type="a-f-G-U-C" time="2026-01-01T00:00:00Z" start="2026-01-01T00:00:00Z" stale="2026-01-01T00:05:00Z" how="m-g"><point lat="39.5000000" lon="-76.1000000" hae="12.0" ce="9999999" le="9999999"/><detail><contact callsign="ICP"/></detail></event>',
    '<event uid="NO-POINT"><detail><contact callsign="broken"/></detail></event>',
    '<event version="2.0" uid="KMX-912" type="a-u-G-I" how="m-g"><point lat="39.51" lon="-76.11" hae="0" ce="9" le="9"/><detail><contact callsign="Medevac-2"/></detail><link uid="KMX-911" relation="p-p"/></event>',
    '</events>',
  ].join('\n');
  const marks = T.parseCoTFile(sample);
  assert.strictEqual(marks.length, 2, 'atom without <point> is skipped');
  assert.strictEqual(marks[0].callsign, 'ICP');
  assert.strictEqual(marks[1].callsign, 'Medevac-2');
});

// Import runs on the UI thread with no size limit: every scan must stay
// inside one atom, or a crafted file of unclosed atoms costs O(n²) and
// freezes the tab (3-12 s at 16k atoms before the fix; ~100 ms after).
const COT_BUDGET_MS = 1500;
const timed = fn => { const t0 = Date.now(); const r = fn(); return { r, ms: Date.now() - t0 }; };
const openAtom = i => '<event uid="U' + i + '" type="a-f-G"><point lat="1" lon="2" hae="0"/>' +
  '<detail><contact callsign="C' + i + '"/></detail>';

test('unclosed atoms with one trailing </event> import in linear time', () => {
  let text = '';
  for (let i = 0; i < 16000; i++) text += openAtom(i);
  const { r, ms } = timed(() => T.parseCoTFile(text + '</event>'));
  assert.ok(ms < COT_BUDGET_MS, 'took ' + ms + ' ms');
  assert.strictEqual(r.length, 16000);
  assert.strictEqual(r[0].callsign, 'C0');
  assert.strictEqual(r[15999].callsign, 'C15999');
});

test('unclosed atoms with no </event> at all import in linear time', () => {
  let text = '';
  for (let i = 0; i < 16000; i++) text += openAtom(i);
  const { r, ms } = timed(() => T.parseCoTFile(text));
  assert.ok(ms < COT_BUDGET_MS, 'took ' + ms + ' ms');
  assert.strictEqual(r.length, 16000);
});

test('an <event> or <point> tag that never closes cannot stall the parser', () => {
  const tags = timed(() => T.parseCoTFile('<event uid="x" '.repeat(40000)));
  assert.ok(tags.ms < COT_BUDGET_MS, 'unterminated <event> tags took ' + tags.ms + ' ms');
  assert.strictEqual(tags.r.length, 0);
  const pts = timed(() => T.parseCoTFile('<event uid="p">' + '<point lat="1" '.repeat(40000) + '</event>'));
  assert.ok(pts.ms < COT_BUDGET_MS, 'unterminated <point> tags took ' + pts.ms + ' ms');
  assert.strictEqual(pts.r.length, 0);
  const cts = timed(() => T.parseCoTFile('<event uid="c"><point lat="1" lon="2"/>' + '<contact '.repeat(40000) + '</event>'));
  assert.ok(cts.ms < COT_BUDGET_MS, 'unterminated <contact> tags took ' + cts.ms + ' ms');
  assert.deepStrictEqual(cts.r.map(m => m.callsign), ['c'], 'no contact parsed: the uid names it');
});

test('an unclosed point-less atom does not borrow the next atom\'s point', () => {
  const marks = T.parseCoTFile('<event uid="NOPOINT"><detail><contact callsign="none"/></detail>' +
    openAtom(1) + '</event>');
  assert.deepStrictEqual(marks.map(m => m.uid + '/' + m.callsign), ['U1/C1']);
});
