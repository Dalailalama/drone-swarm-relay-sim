// Audit calibrated-preset-jammer-intercept: a field-calibrated preset's signal
// uses the fitted intercept A (refPowerDbm), but the jammer floor and denial
// radius used the free-space 1 m loss with the fitted slope. Convention now:
// the datasheet txDbm/antGainDbi stay the hardware's own figures and the
// fitted residual against them is CHANNEL loss, shared by every emitter on
// that channel — jammers included.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const C = require('../js/calibrate.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const JAM_SNR_OFFSET_DB = vm.runInContext('JAM_SNR_OFFSET_DB', ctx);

function calibrated(refA) {
  const samples = [];
  for (let d = 10; d <= 2000; d *= 1.2) samples.push({ dM: d, rssiDbm: refA - 30 * Math.log10(d) });
  const fit = C.fitPathLoss(samples);
  assert.ok(fit.ok, fit.reason);
  return C.calibratePreset(fit, SIK);
}

function swarmWith(radio) {
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.spectrumAgility = false; s.lpiMode = false;
  return s;
}

for (const refA of [-20, -30, 5]) {
  test('regression: same-EIRP jammer at the TX spot lands exactly on the calibrated RSSI (A = ' + refA + ' dBm)', () => {
    const cal = calibrated(refA);
    const s = swarmWith(cal);
    // erpDbm is ERP (dipole-referenced): EIRP = ERP + 2.15 dB. The receive
    // antenna counts for the jammer exactly as it does for the signal.
    s.jammers = [{ x: 0, y: 0, erpDbm: cal.txDbm + cal.antGainDbi - 2.15, band: 'all', altM: 15, on: true }];
    const jAlt = ctx.terrainGroundAt(s.terrain, 0, 0) + 15;
    const rxAlt = ctx.terrainGroundAt(s.terrain, 500, 0) + 15;
    const floor = ctx.interferenceFloorDbm(s, { x: 500, y: 0 }, rxAlt, cal);
    const slant = Math.hypot(500, jAlt - rxAlt);
    const sig = R.rssiAt(cal, 1, slant);
    assert.ok(Math.abs(floor - JAM_SNR_OFFSET_DB - sig) < 1e-9,
      'jammer arrives at ' + (floor - JAM_SNR_OFFSET_DB).toFixed(2) +
      ' dBm vs the calibrated signal ' + sig.toFixed(2) + ' dBm from the same spot and EIRP');
  });
}

test('regression: denial radius follows the measured intercept (lower A -> smaller radius)', () => {
  const hi = calibrated(-20), lo = calibrated(-30);
  const j = { x: 0, y: 0, erpDbm: 20, band: 'all', altM: 15, on: true };
  const rHi = ctx.jammerDenialRadiusM(swarmWith(hi), j);
  const rLo = ctx.jammerDenialRadiusM(swarmWith(lo), j);
  const expect = Math.pow(10, -10 / (10 * hi.nFit));
  assert.ok(Math.abs(rLo / rHi - expect) < 1e-6, 'ratio ' + (rLo / rHi) + ' vs ' + expect);
});

test('datasheet presets keep the free-space 1 m loss in the jammer model', () => {
  const s = swarmWith(SIK);
  const j = { x: 0, y: 0, erpDbm: 20, band: 'all', altM: 15, on: true };
  const n = R.pathLossExponent(SIK);
  const eirpRx = 20 + 2.15 + SIK.antGainDbi; // ERP -> EIRP, plus the receive antenna
  const expect = Math.pow(10, (eirpRx - R.pl1m(SIK.freqMHz) + JAM_SNR_OFFSET_DB - SIK.sensDbm) / (10 * n));
  assert.strictEqual(ctx.jammerDenialRadiusM(s, j), expect);
});
