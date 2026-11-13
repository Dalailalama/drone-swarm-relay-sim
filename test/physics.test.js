// Physics unit tests — run with:  node --test test/
// These pin down the model's calibration promises so a PR can't silently
// break them: rated range ↔ zero margin, fade reserve, horizon math,
// momentum-theory endurance staying inside each class's band, the micro's
// pinned to its cited spec.

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

test('momentum-theory endurance (usable pack) stays inside each class\'s band', () => {
  // x8 band moved down with the coaxial shared-disc correction (audit EN-1):
  // the old [38, 55] only held while 8 coaxial rotors counted as 8 free discs.
  // micro: the DJI Mini 4 Pro's 30 min full-pack hover x the 80% usable
  // fraction = 24 min (audit EN-2). q450 and x8 name no single reference
  // aircraft, so theirs are class-plausibility bands, not cited figures.
  const expected = { micro: [22, 26], q450: [17, 27], x8: [30, 42] }; // minutes
  for (const af of A.AIRFRAMES) {
    const e = A.hoverEnduranceMin(af);
    const [lo, hi] = expected[af.id];
    assert.ok(e >= lo && e <= hi,
      af.id + ': computed ' + e.toFixed(1) + ' min, expected ' + lo + '-' + hi);
  }
});

test('micro preset is the DJI Mini 4 Pro on its real disc and pack, and hovers for the published 30 min (audit EN-2)', () => {
  // https://www.dji.com/mini-4-pro/specs: takeoff weight < 249 g; Intelligent
  // Flight Battery 2590 mAh x 7.32 V = 18.96 Wh; "Max Hovering Time: 30
  // minutes", windless, from 100% battery to 0%. Stock 6030F props: 6.0 in
  // diameter, so r ~= 0.076 m.
  const af = A.AIRFRAMES.find(a => a.id === 'micro');
  assert.ok(af.massKg <= 0.249, 'micro mass ' + af.massKg);
  assert.ok(Math.abs(af.rotorRadiusM - 0.076) <= 0.076 * 0.1,
    'micro rotor radius ' + af.rotorRadiusM + ' m, 6030F props are r ~= 0.076 m');
  assert.ok(Math.abs(af.batteryWh - 18.96) < 0.005, 'micro pack ' + af.batteryWh + ' Wh, spec is 18.96 Wh');
  const fullPackHoverMin = af.batteryWh / A.hoverPowerW(af) * 60;
  assert.ok(Math.abs(fullPackHoverMin - 30) <= 2,
    'micro full-pack hover ' + fullPackHoverMin.toFixed(1) + ' min, DJI spec is 30 min');
});

test('forward flight power: equals hover at 0, rises toward max speed', () => {
  for (const af of A.AIRFRAMES) {
    const h = A.hoverPowerW(af);
    assert.ok(Math.abs(A.flightPowerW(af, 0) - h) < 1e-9);
    assert.ok(A.flightPowerW(af, af.maxSpeedMs) > h * 1.2, 'max-speed flight should cost >20% over hover');
  }
});

test('coaxial presets share one disc per stack and pay the coaxial interference loss (audit EN-1)', () => {
  const coax = A.AIRFRAMES.filter(af => af.coaxial);
  assert.ok(coax.length >= 1, 'a preset described as coaxial must be flagged coaxial');
  for (const af of A.AIRFRAMES) {
    if (/coax/i.test(af.note + af.name)) assert.ok(af.coaxial, af.id + ' is described as coaxial but not flagged');
  }
  for (const af of coax) {
    const r2 = Math.PI * af.rotorRadiusM * af.rotorRadiusM;
    assert.ok(Math.abs(A.discAreaM2(af) - af.nRotors / 2 * r2) < 1e-12, af.id + ': one swept disc per coaxial stack');
    const T = af.massKg * 9.81;
    const isolated = Math.pow(T, 1.5) / Math.sqrt(2 * A.AIR_RHO * af.nRotors * r2) / (af.powertrainEff || A.POWERTRAIN_EFF);
    const sharedDisc = isolated * Math.SQRT2;
    const h = A.hoverPowerW(af);
    // Between the ideal isolated-rotor case (no wake interaction) and the
    // coplanar shared-disc bound; Leishman's coaxial value is 1.281 x isolated.
    assert.ok(h > isolated * 1.2 && h < sharedDisc, af.id + ': hover ' + h.toFixed(1) + ' W outside coaxial band');
  }
});

test('every radio preset cites a datasheet source', () => {
  for (const radio of R.RADIOS) {
    assert.ok(radio.source && radio.source.startsWith('https://'), radio.id + ' needs a source URL');
  }
  // These three moved; the old links 404/403. Pinned so a dead one can't return.
  const src = id => R.RADIOS.find(r => r.id === id).source;
  assert.strictEqual(src('sik-v3'), 'https://docs.holybro.com/radio/sik-telemetry-radio-v3');
  assert.strictEqual(src('rfd900x'), 'https://rfdesign.com.au/wp-content/uploads/x-Series-Datasheet-V2.0.pdf');
  assert.strictEqual(src('rajant-es1'), 'https://secure.rajant.com/publicFiles/1479');
});
