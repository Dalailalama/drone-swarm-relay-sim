// Audit (rf-physics/model-md-rf-spec-mismatch, devex-tests-ci/model-md-contradicts-code,
// energy-airframes/EN-4, network-scheduler/NET-03): MODEL.md documented an
// environment exponent 2.0 + (1-eta)*1.6, a dBm-minus-dB margin, a thermal
// noise term, an avionics draw, C_D*A_front drag, g = 9.80665, gusts, a
// random-walk drift, same-channel collisions and a 1% LoRa duty cycle, none of
// which the code has. These checks pin the spec to the code's constants.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { GPS_DENIED } = require('../js/gpsnav.js');
const { loadCore } = require('./helpers/sim.js');

const md = fs.readFileSync(path.join(__dirname, '..', 'MODEL.md'), 'utf8');

test('MODEL.md drops the formulas the code does not implement', () => {
  for (const [re, why] of [
    [/\(1 - \\eta\) \\cdot 1\.6/, 'no environment-dependent exponent: eta divides the distance'],
    [/Thermal noise floor/, 'there is no kTB term; noise is inside the datasheet sensitivity'],
    [/I_\{\\text\{ext\}\}/, 'the margin does not subtract a dBm interference power'],
    [/P_\{\\text\{avionics\}\}/, 'there is no avionics term'],
    [/A_\{\\text\{front\}\}/, 'drag uses the preset dragAreaM2'],
    [/9\.80665/, 'the code uses g = 9.81'],
    [/temporal gusts/, 'wind is one constant vector'],
    [/induce packet collisions/, 'channels are serialized, with no collision model'],
    [/1% duty cycle\)/, 'the LoRa preset is the 10% sub-band'],
  ]) assert.doesNotMatch(md, re, why);
});

test('MODEL.md quotes the constants the code runs', () => {
  const ctx = loadCore();
  const c = vm.runInContext('({ FADE, JAM_SNR_OFFSET_DB, ERP_TO_EIRP_DB, AGILITY, BATTERY })', ctx);
  assert.strictEqual(c.FADE.tauSec, 10);
  assert.match(md, /\\tau = 10\\,\\text\{s\}/);
  assert.strictEqual(c.JAM_SNR_OFFSET_DB, 10);
  assert.match(md, /default \+10 dB/);
  assert.strictEqual(c.ERP_TO_EIRP_DB, 2.15);
  assert.match(md, /\+ 2\.15 \+ G_\{\\text\{rx\}\}/);
  assert.strictEqual(c.AGILITY.lpiCostDb, 3);
  assert.strictEqual(c.AGILITY.lpiDenyReductionDb, 6);
  assert.match(md, /L_\{\\text\{LPI\}\} = 3\\,\\text\{dB\}/);
  assert.match(md, /plus 6 dB when LPI mode is on/);
  assert.strictEqual(c.BATTERY.homeMargin, 1.3);
  assert.strictEqual(c.BATTERY.reserveFrac, 0.07);
  assert.match(md, /0\.07\\,E_\{\\text\{usable\}\}/);

  assert.strictEqual(R.pktSuccessProb(2), 0.5);
  assert.match(md, /\\frac\{M - 2\}\{1\.2\}/);
  assert.strictEqual(R.RADIOS.find(r => r.id === 'lora868').dutyCycle, 0.1);
  assert.match(md, /10% duty in the 869\.4–869\.65 MHz sub-band/);
  const fmt = f => (Number.isInteger(f) ? f.toFixed(1) : String(f));
  for (const e of R.ENVIRONMENTS) {
    assert.ok(md.includes(e.id + ' ' + fmt(e.factor)), e.id + ' factor ' + e.factor + ' not quoted');
    assert.ok(md.includes(e.id + ' ' + e.shadowSigmaDb + ' dB'), e.id + ' sigma ' + e.shadowSigmaDb + ' not quoted');
  }

  assert.strictEqual(A.BATT_USABLE_FRAC, 0.8);
  assert.match(md, /0\.8\\,E_\{\\text\{nominal\}\}/);
  assert.strictEqual(A.ROTOR_FM, 0.65);
  assert.match(md, /\\text\{FM\} = 0\.65/);
  assert.strictEqual(A.POWERTRAIN_EFF, 0.55);
  assert.match(md, /g = 9\.81\\,/);
  assert.strictEqual(GPS_DENIED.tauSec, 25);
  assert.strictEqual(GPS_DENIED.driftSigmaMs, 1.2);
  assert.match(md, /\\sigma_\{\\text\{drift\}\} = 1\.2\\,\\text\{m\/s\}/);
  assert.match(md, /\\tau = 25\\,\\text\{s\}/);
});

test('MODEL.md path-loss closed form matches linkMarginDb for every preset and environment', () => {
  // P_rx - S = P_tx + 2G - PL1m(f) - 10 n log10(max(1, d/eta)) - S
  for (const r of R.RADIOS) {
    const n = R.pathLossExponent(r);
    for (const e of R.ENVIRONMENTS) {
      for (const d of [1, 50, 300, 2500, 40000]) {
        const doc = r.txDbm + 2 * r.antGainDbi - (32.44 + 20 * Math.log10(r.freqMHz) - 60) -
          10 * n * Math.log10(Math.max(1, d / e.factor)) - r.sensDbm;
        assert.ok(Math.abs(R.linkMarginDb(r, e.factor, d) - doc) < 1e-9, r.id + ' ' + e.id + ' ' + d + ' m');
      }
    }
    assert.ok(Math.abs(R.linkMarginDb(r, 1, r.rangeLosM)) < 1e-9, r.id + ': margin is 0 dB at rangeLosM');
  }
});
