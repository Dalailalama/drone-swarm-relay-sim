// Audit (tools-data-integrations/tak-import-takes-parent-callsign): the
// callsign lookup had no word boundary, so ATAK markers — which put
// <link ... parent_callsign='HOPE'/> before <contact callsign='R 1'/> — were
// all imported under their creator's name. TAK's unknown value 9999999 on
// hae must also import as unknown, not as a 10,000 km altitude.
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../js/tak.js');

// Shape of atak-civ takcot/examples 'Marker - Spot.cot'.
const SPOT = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>" +
  "<event version='2.0' uid='9405e320-9356-41c4-8449-f46990aa17f8' type='b-m-p-s-m' " +
  "time='2020-02-12T13:16:07Z' start='2020-02-12T13:16:05Z' stale='2020-02-13T13:16:05Z' how='h-g-i-g-o'>" +
  "<point lat='39.0981196' lon='-108.7395013' hae='9999999.0' ce='9999999.0' le='9999999.0' />" +
  "<detail><status readiness='true'/>" +
  "<link uid='ANDROID-deadbeef' production_time='2020-02-12T13:16:05Z' type='a-f-G-U-C' parent_callsign='HOPE' relation='p-p'/>" +
  "<contact callsign='R 1'/><precisionlocation altsrc='???'/></detail></event>";

test('imported ATAK marker keeps its own callsign, not the parent_callsign', () => {
  const [m] = T.parseCoTFile(SPOT);
  assert.strictEqual(m.callsign, 'R 1');
});

test('TAK unknown hae 9999999 imports as unknown (null)', () => {
  const [m] = T.parseCoTFile(SPOT);
  assert.strictEqual(m.hae, null);
});
