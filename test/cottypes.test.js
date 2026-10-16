// Audit: CoT export correctness against the MITRE CoT schema / CoTtypes.xml
// and the atak-civ takcot XSDs.
//  - tak-type-codes-wrong: drones were 'a-.-A-M-H-U' (rotor UTILITY, i.e. a
//    helicopter), the objective a friendly ground combat unit, and the hazard
//    type 'a-n-G-A-c' does not exist; ellipse carried non-schema cx/cy.
//  - tak-how-mg-on-simulated: every atom said how="m-g" (GPS-derived) though
//    it is simulated ("m-s"), and the bridge puts them on a real TAK net.
//  - tak-hae-omitted-schema-invalid: point.xsd makes hae REQUIRED; TAK's
//    unknown value is 9999999 (CotConstants.UNKNOWN_VALUE), for le as well.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['osm.js', 'tak.js']);
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const T = require('../js/tak.js');

function atoms(haeM) {
  const s = ctx.makeSwarm({
    count: 3, airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: R.RADIOS.find(r => r.id === 'rfd900x'),
    envFactor: 1, targetX: 1500, targetY: -400, altitudeM: 70, seed: 44,
    jammers: [{ id: 'JX-1', x: 700, y: -200, erpDbm: 24, band: 'all', altM: 15, on: true }],
    gpsZones: [{ id: 'GZ-1', x: 1300, y: -380, rM: 260, on: true }],
  });
  ctx.stepSwarm(s, 1);
  return ctx.buildCotFromSwarm(s, T.makeTakAnchor(38.8977, -77.0365, 0, 0, haeM), 1730000000);
}
const byUid = (list, uid) => list.find(a => a.includes('uid="' + uid + '"'));

test('CoT type codes: UAV rotor, waypoint objective, drawn-circle hazards', () => {
  const list = atoms(100);
  assert.match(byUid(list, 'SIM-DR-1'), /type="a-f-A-M-H-Q"/);
  assert.match(byUid(list, 'SIM-TGT'), /type="b-m-p-w"/);
  for (const uid of ['SIM-JX-1', 'SIM-GZ-1']) {
    const a = byUid(list, uid);
    assert.match(a, /type="u-d-c-c"/, uid);
    assert.match(a, /<ellipse major="\d+" minor="\d+" angle="0"\/>/, uid);
    assert.doesNotMatch(a, /\bc[xy]="/, uid + ' carries non-schema cx/cy');
  }
});

test('every simulated atom says how="m-s", never GPS-derived m-g', () => {
  for (const a of atoms(100)) {
    assert.match(a, /how="m-s"/);
    assert.doesNotMatch(a, /how="m-g"/);
  }
});

test('unknown vertical datum: hae and le carry the TAK unknown value 9999999', () => {
  for (const a of atoms(null)) {
    const p = a.match(/<point\b[^>]*\/>/)[0];
    for (const name of ['lat', 'lon', 'hae', 'ce', 'le']) assert.match(p, new RegExp(' ' + name + '="'), name + ' missing: ' + p);
    assert.match(p, /hae="9999999\.0"/);
    assert.match(p, /le="9999999\.0"/);
  }
  // A known datum keeps a real hae and the stated vertical error.
  const p = byUid(atoms(100), 'SIM-DR-1').match(/<point\b[^>]*\/>/)[0];
  assert.doesNotMatch(p, /9999999/);
});
