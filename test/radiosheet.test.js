// Radio presets are pinned to the vendor figures RADIOS.md cites — a preset
// number that drifts from its datasheet (or a sensitivity quoted at the wrong
// air rate) silently shifts every calibrated range in the sim.
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../js/radios.js');

const byId = id => R.RADIOS.find(r => r.id === id);

test('SiK V3 sensitivity is the Holybro figure at its 64 kbps air rate', () => {
  const sik = byId('sik-v3');
  assert.strictEqual(sik.airRateKbps, 64);
  assert.strictEqual(sik.sensDbm, -105, 'Holybro V3 spec: -105 dBm @64kbps');
});

test('RFD900x air rate and sensitivity are one row of the x-Series V2.0 table', () => {
  const rfd = byId('rfd900x');
  assert.strictEqual(rfd.airRateKbps, 224);
  assert.strictEqual(rfd.sensDbm, -93, 'x-Series datasheet V2.0 p32: 224 kbit/s -93 dBm');
  assert.strictEqual(rfd.antGainDbi, 3, 'the datasheet stock dipole is 3 dBi');
});

test('MANET presets use the vendor datasheet sensitivity / TX figures', () => {
  // SC4400E datasheet: -102 dBm @ 5 MHz BW; -98 dBm appears nowhere.
  assert.strictEqual(byId('silvus-sc4400').sensDbm, -102);
  // Rajant ES1 spec sheet: "Max. RF Transmit Power 29 dBm ± 2 dB".
  assert.strictEqual(byId('rajant-es1').txDbm, 29);
});
