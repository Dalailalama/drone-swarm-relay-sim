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
