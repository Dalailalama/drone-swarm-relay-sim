// ATAK / TAK integration tests — CoT atoms must be well-formed, the local
// metres <-> lat/lon conversion honest at mission scales, export->import
// must round-trip, and a real swarm's snapshot covers every live node.

const { test } = require('node:test');
const assert = require('node:assert');

const T = require('../js/tak.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['tak.js']);

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

test('CoT atoms carry required attributes and escape callsigns', () => {
  const xml = T.cotEvent({
    uid: 'SIM-DR-1', cotType: T.TAK_TYPES.drone,
    lat: 38.9, lon: -77.0, haeM: 60.5,
    callsign: 'DR-1 <relay>', nowSec: 1730000000, staleSec: 20,
  });
  assert.ok(xml.startsWith('<event version="2.0"'));
  for (const needle of ['uid="SIM-DR-1"', 'type="a-f-A-M-H-U"', 'lat="38.9000000"',
    'hae="60.5"', 'callsign="DR-1 &lt;relay&gt;"', 'stale="', 'how="m-g"']) {
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
