// Interference model physics: the required signal-to-interference ratio is a
// property of the waveform, and each receiver's interference degrades only
// the direction that receiver hears.

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const LORA = R.RADIOS.find(r => r.id === 'lora868');

function makeSw(radio, jammers) {
  return ctx.makeSwarm({
    count: 2,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio,
    envFactor: 1,
    targetX: 2000, targetY: 0,
    altitudeM: 30,
    seed: 3,
    jammers,
  });
}

test('LoRa needs the datasheet SIR (SF10 demodulates 15 dB under noise), FSK keeps +10 dB', () => {
  const s = makeSw(LORA, [{ id: 'JX-1', x: 0, y: 0, erpDbm: 0, band: 'all', altM: 15, on: true }]);
  const pos = { x: 1000, y: 0 };
  const fsk = Object.assign({}, LORA, { jamSirDb: 10 }); // same radio, FSK-class requirement
  const dLora = ctx.interferenceFloorDbm(s, pos, 30, LORA) - ctx.interferenceFloorDbm(s, pos, 30, fsk);
  assert.ok(Math.abs(dLora - -25) < 1e-9, 'lora868 floor must sit 25 dB under the FSK-class floor, got ' + dLora);
  // Presets without an override keep the +10 dB default.
  const sik = Object.assign({}, SIK);
  delete sik.jamSirDb;
  const sk = makeSw(SIK, s.jammers);
  assert.strictEqual(ctx.interferenceFloorDbm(sk, pos, 30, SIK), ctx.interferenceFloorDbm(sk, pos, 30, sik));
  // The red-zone radius uses the same requirement.
  const j = s.jammers[0];
  const n = ctx.pathLossExponent(LORA);
  const want = Math.pow(10, (j.erpDbm - ctx.pl1m(LORA.freqMHz) - 15 - LORA.sensDbm) / (10 * n));
  assert.ok(Math.abs(ctx.jammerDenialRadiusM(s, j) / want - 1) < 1e-9, 'denial radius must use SIR -15 dB');
});
