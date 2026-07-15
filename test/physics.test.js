// Physics unit tests — run with:  node --test test/
// These pin down the model's calibration promises so a PR can't silently
// break them: rated range ↔ zero margin, fade reserve, horizon math,
// momentum-theory endurance staying inside published real-world figures.

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');

test('calibration: link margin is ~0 dB exactly at each radio\'s rated LOS range', () => {
  for (const radio of R.RADIOS) {
    const m = R.linkMarginDb(radio, 1, radio.rangeLosM);
    assert.ok(Math.abs(m) < 0.01, radio.id + ': margin at rated range was ' + m.toFixed(3) + ' dB');
  }
});

test('usable planning range sits below rated range by the fade reserve', () => {
  for (const radio of R.RADIOS) {
    const u = R.usableRangeM(radio, 1);
    assert.ok(u < radio.rangeLosM, radio.id + ': usable must be < rated');
    const marginAtUsable = R.linkMarginDb(radio, 1, u);
    assert.ok(Math.abs(marginAtUsable - R.FADE_MARGIN_DB) < 0.01,
      radio.id + ': margin at usable range should equal the fade reserve');
  }
});

test('margin decreases monotonically with distance', () => {
  const radio = R.RADIOS[0];
  let prev = Infinity;
  for (let d = 10; d <= 1000; d += 10) {
    const m = R.linkMarginDb(radio, 1, d);
    assert.ok(m < prev, 'margin must fall with distance');
    prev = m;
  }
});

test('environment factor scales usable range linearly', () => {
  const radio = R.RADIOS[0];
  const open = R.usableRangeM(radio, 1);
  const urban = R.usableRangeM(radio, 0.2);
  assert.ok(Math.abs(urban - open * 0.2) < 0.01);
});

test('packet success probability: anchor points of the logistic', () => {
  assert.ok(Math.abs(R.pktSuccessProb(2) - 0.5) < 1e-9, '50% at +2 dB');
  assert.ok(R.pktSuccessProb(0) < 0.2, 'poor at 0 dB');
  assert.ok(R.pktSuccessProb(6) > 0.9, 'solid at +6 dB');
  assert.ok(R.pktSuccessProb(20) > 0.999, 'near-perfect at +20 dB');
});

test('radio horizon: 4.12(√h1+√h2) km', () => {
  assert.ok(Math.abs(R.radioHorizonM(2, 50) - 34955) < 50);   // ~35.0 km
  assert.ok(Math.abs(R.radioHorizonM(2, 120) - 50956) < 60);  // ~51.0 km
});

test('chain throughput divides by hop count', () => {
  const radio = R.RADIOS[0];
  assert.strictEqual(R.chainThroughputKbps(radio, 4), radio.airRateKbps / 4);
});

test('momentum-theory endurance lands inside published real-world figures', () => {
  const expected = { micro: [28, 42], q450: [17, 27], x8: [38, 55] }; // minutes
  for (const af of A.AIRFRAMES) {
    const e = A.hoverEnduranceMin(af);
    const [lo, hi] = expected[af.id];
    assert.ok(e >= lo && e <= hi,
      af.id + ': computed ' + e.toFixed(1) + ' min, expected ' + lo + '-' + hi);
  }
});

test('forward flight power: equals hover at 0, rises toward max speed', () => {
  for (const af of A.AIRFRAMES) {
    const h = A.hoverPowerW(af);
    assert.ok(Math.abs(A.flightPowerW(af, 0) - h) < 1e-9);
    assert.ok(A.flightPowerW(af, af.maxSpeedMs) > h * 1.2, 'max-speed flight should cost >20% over hover');
  }
});

test('every radio preset cites a datasheet source', () => {
  for (const radio of R.RADIOS) {
    assert.ok(radio.source && radio.source.startsWith('https://'), radio.id + ' needs a source URL');
  }
});
