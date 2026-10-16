// Sim-to-real calibration loop tests — round-trip honesty: synthesize field
// data FROM a radio preset's own model (with noise), fit it back, and the
// recovered exponent and range must match. Plus CSV messiness handling.

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../js/radios.js');
const C = require('../js/calibrate.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');

// Deterministic gaussian-ish noise
let seedState = 12345;
function noise() {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return (seedState / 0x7fffffff - 0.5) * 2; // ±1, zero-mean-ish
}

function syntheticLog(preset, envFactor, sigmaDb) {
  const rows = [];
  for (let d = 5; d <= 400; d *= 1.35) {
    const rssi = R.rssiAt(preset, envFactor, d) + sigmaDb * noise();
    rows.push({ dM: d, rssiDbm: rssi });
  }
  return rows;
}

test('CSV parser: distance+rssi columns, junk rows dropped and counted', () => {
  const csv = [
    '# field walk log',
    'time,dist,rssi',
    '0,10,-55.2',
    '', // blank skipped
    '1,25,-61.0',
    '2,abc,-70',      // malformed distance -> dropped
    '3,, -80',        // missing distance -> dropped
    '4,50,-66.3',
    '5,0.5,-40',      // inside the noise floor -> dropped with a note
    '6,120,-71.8',
  ].join('\n');
  const p = C.parseFlightLogCsv(csv);
  assert.strictEqual(p.samples.length, 4);
  assert.strictEqual(p.dropped, 3);
  assert.ok(p.notes.some(n => n.includes('1 m')), 'notes the sub-metre drops');
});

test('CSV parser: x,y[,z] positions measure from the first row as origin', () => {
  const csv = [
    'x,y,z,rssi_dbm',
    '100,100,5,-50',   // origin row — not a sample
    '200,100,5,-58',   // 100 m away
    '100,300,5,-64',   // 200 m away
  ].join('\n');
  const p = C.parseFlightLogCsv(csv);
  assert.strictEqual(p.samples.length, 2);
  assert.ok(Math.abs(p.samples[0].dM - 100) < 0.01);
  assert.ok(Math.abs(p.samples[1].dM - 200) < 0.01);
});

test('CSV parser: refuses files it cannot understand, with a human reason', () => {
  const p = C.parseFlightLogCsv('foo,bar\n1,2\n3,4\n');
  assert.strictEqual(p.samples.length, 0);
  assert.ok(p.notes.length >= 1);
  const e = C.parseFlightLogCsv('');
  assert.ok(e.notes.includes('empty file'));
});

test('round trip: fitting data generated FROM a preset recovers its exponent', () => {
  const truth = R.pathLossExponent(SIK);
  const samples = syntheticLog(SIK, 1, 1.0); // ±~0.6 dB effective noise
  const fit = C.fitPathLoss(samples);
  assert.ok(fit.ok, 'fit should succeed');
  assert.ok(Math.abs(fit.n - truth) < 0.05,
    'recovered n=' + fit.n.toFixed(3) + ', expected ' + truth.toFixed(3));
  assert.ok(fit.r2 > 0.98, 'clean synthetic data must fit tightly, R²=' + fit.r2.toFixed(3));
  assert.ok(fit.rmse < 1.5, 'RMSE near the injected noise level, got ' + fit.rmse.toFixed(2));
});

test('calibrated preset re-derives range so the MODEL reproduces the measurement', () => {
  // Simulate a harsher world: same hardware but measured n steeper than datasheet.
  const samples = syntheticLog(SIK, 0.45, 1.0); // suburban factor steepens apparent n? No —
  // rssiAt already divides by envFactor internally... to simulate REAL measurement in
  // clutter we refit against raw distances: generate with factor 1 but add extra loss slope.
  void samples;
  const cluttered = [];
  for (let d = 5; d <= 300; d *= 1.3) {
    cluttered.push({
      dM: d,
      rssiDbm: SIK.txDbm + 2 * SIK.antGainDbi -
        (R.pl1m(SIK.freqMHz) + 10 * (R.pathLossExponent(SIK) + 0.6) * Math.log10(d)) + 0.8 * noise(),
    });
  }
  const fit = C.fitPathLoss(cluttered);
  assert.ok(Math.abs(fit.n - (R.pathLossExponent(SIK) + 0.6)) < 0.05,
    'injected +0.6 clutter recovered');
  const cal = C.calibratePreset(fit, SIK);
  // The model's own calibration identity: pathLossExponent(calibrated) === fitted n.
  assert.ok(Math.abs(R.pathLossExponent(cal) - fit.n) < 1e-9,
    'model exponent of the calibrated preset must equal the measurement');
  assert.ok(cal.rangeLosM < SIK.rangeLosM,
    'steeper decay must shorten the derived rated range: ' + cal.rangeLosM + ' vs ' + SIK.rangeLosM);
});

test('validation report carries the numbers a skeptical engineer needs', () => {
  const samples = syntheticLog(SIK, 1, 0.8);
  const fit = C.fitPathLoss(samples);
  const parsed = { samples, dropped: 2, notes: ['dropped samples inside the 1 m noise floor'] };
  const md = C.validationReportMd(fit, SIK, samples, parsed);
  for (const needle of [
    '# RF model calibration report',
    'path-loss exponent',
    'RMSE',
    'R²',
    'Calibrated preset',
    '| Distance | Samples |',
    'planning-grade',
  ]) {
    assert.ok(md.includes(needle), 'report missing: ' + needle);
  }
});

test('tiny or degenerate datasets fail loudly instead of lying', () => {
  const few = C.fitPathLoss([{ dM: 10, rssiDbm: -60 }, { dM: 20, rssiDbm: -65 }]);
  assert.strictEqual(few.ok, false);
  const sameSpot = C.fitPathLoss([
    { dM: 10, rssiDbm: -60 }, { dM: 10.001, rssiDbm: -60 }, { dM: 10.002, rssiDbm: -60 },
    { dM: 10.003, rssiDbm: -60 }, { dM: 10.004, rssiDbm: -60 },
  ]);
  assert.strictEqual(sameSpot.ok, false, 'no spread -> no fit');
});

// Seeded Box-Muller gaussian for the statistical gates below.
function gaussFrom(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
function fieldLog(g, count, dLo, dHi, n, A, sigma) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = dLo * Math.pow(dHi / dLo, i / (count - 1));
    out.push({ dM: d, rssiDbm: A - 10 * n * Math.log10(d) + sigma * g() });
  }
  return out;
}

test('regression: 1000 samples at one single distance are degenerate, not a fit', () => {
  for (const dM of [150, 1234.5, 77.7]) {
    const g = gaussFrom(7);
    const samples = [];
    for (let i = 0; i < 1000; i++) samples.push({ dM, rssiDbm: -90 + 3 * g() });
    const fit = C.fitPathLoss(samples);
    assert.strictEqual(fit.ok, false, dM + ' m accepted as n=' + fit.n);
    assert.ok(/degenerate/.test(fit.reason), fit.reason);
  }
});

test('regression: a narrow distance span cannot determine n (no noise-only presets)', () => {
  let wrongAccepted = 0;
  for (let t = 0; t < 200; t++) {
    const fit = C.fitPathLoss(fieldLog(gaussFrom(1000 + t), 20, 100, 120, 2.7, -30, 6));
    if (fit.ok && Math.abs(fit.n - 2.7) > 1) wrongAccepted++;
  }
  assert.strictEqual(wrongAccepted, 0, wrongAccepted + ' narrow-span fits accepted with |n-2.7|>1');
});

test('wide-span fits pass and their 95% CI on n covers the truth', () => {
  let covered = 0;
  for (let t = 0; t < 50; t++) {
    const fit = C.fitPathLoss(fieldLog(gaussFrom(5000 + t), 100, 10, 2000, 2.7, -30, 6));
    assert.ok(fit.ok, 'trial ' + t + ': ' + fit.reason);
    assert.ok(fit.nCi95 > 0 && fit.nCi95 <= 0.5, 'CI half-width ' + fit.nCi95);
    if (Math.abs(fit.n - 2.7) <= fit.nCi95) covered++;
  }
  assert.ok(covered >= 45, 'CI covered the truth in only ' + covered + '/50');
  const samples = fieldLog(gaussFrom(1), 100, 10, 2000, 2.7, -30, 6);
  const fit = C.fitPathLoss(samples);
  const md = C.validationReportMd(fit, SIK, samples, null);
  assert.ok(md.includes('95% CI'), 'report must state the uncertainty on n');
});
