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

// Audit rf-physics/per-curve-vs-sensitivity-definition: datasheet
// sensitivities are quoted at a low error rate (SX1276 FSK: 0.1% BER), but the
// model puts 0 dB margin at the rated range and delivers ~16% there. The
// chosen semantics (keep the curve, call the rated range the ~84%-loss edge)
// must be stated where the presets and the curve live, with the right numbers.
test('the packet-success curve\'s meaning at datasheet sensitivity is documented', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  assert.ok(Math.abs(R.pktSuccessProb(0) - 0.159) < 0.001, 'pinned: ~16% at 0 dB');
  assert.ok(Math.abs(R.pktSuccessProb(6) - 0.966) < 0.001, 'pinned: ~97% at +6 dB');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js/radios.js'), 'utf8');
  const at = src.indexOf('function pktSuccessProb');
  const doc = src.slice(at - 600, at); // the comment above the curve
  assert.doesNotMatch(doc, /~95% at 6 dB/, 'P(6 dB) is 96.6%');
  assert.match(doc, /~97% at 6 dB/);
  const md = fs.readFileSync(path.join(__dirname, '..', 'RADIOS.md'), 'utf8');
  assert.match(md, /84%-loss/, 'RADIOS.md must say the rated range is the model\'s ~84%-loss edge');
  assert.match(md, /0\.1% BER/);
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

test('forward flight power: equals hover at 0, rises again toward max speed', () => {
  for (const af of A.AIRFRAMES) {
    const h = A.hoverPowerW(af);
    assert.ok(Math.abs(A.flightPowerW(af, 0) - h) < 1e-9);
    assert.ok(A.flightPowerW(af, af.maxSpeedMs) > A.flightPowerW(af, 0.5 * af.maxSpeedMs) * 1.05,
      af.id + ': parasite drag should make max-speed flight dearer than mid-speed cruise');
  }
});

test('forward-flight power is level-flight momentum theory: a translational-lift dip, then the parasite rise (audit EN-3)', () => {
  // Independent reference: Glauert's inflow quartic vi^4 + V^2 vi^2 = vh^4
  // solved by bisection (not the closed form), thrust tilted to carry
  // parasite drag, induced share = the rotor figure of merit, profile share
  // held at hover, parasite D·V through the motor/ESC part of the efficiency.
  const rho = A.AIR_RHO, g = 9.81, fm = A.ROTOR_FM;
  function reference(af, V) {
    const W = af.massKg * g, D = 0.5 * rho * af.dragAreaM2 * V * V, T = Math.hypot(W, D);
    const vh = Math.sqrt(T / (2 * rho * A.discAreaM2(af)));
    let lo = 0, hi = vh;
    for (let i = 0; i < 200; i++) {
      const vi = (lo + hi) / 2;
      if (vi * vi * vi * vi + V * V * vi * vi < vh * vh * vh * vh) lo = vi; else hi = vi;
    }
    const vh0 = Math.sqrt(W / (2 * rho * A.discAreaM2(af)));
    const h = A.hoverPowerW(af);
    return h * (fm * (T * lo) / (W * vh0) + (1 - fm)) + fm * D * V / (af.powertrainEff || A.POWERTRAIN_EFF);
  }
  assert.ok(fm >= 0.5 && fm <= 0.75, 'rotor figure of merit ' + fm + ' outside the small-prop range');
  for (const af of A.AIRFRAMES) {
    assert.ok(af.dragAreaM2 > 0.003 && af.dragAreaM2 < 0.1, af.id + ': CdA ' + af.dragAreaM2 + ' m2 implausible');
    const h = A.hoverPowerW(af);
    let minR = Infinity, minU = 0;
    for (let i = 0; i <= 100; i++) {
      const u = i / 100, p = A.flightPowerW(af, u * af.maxSpeedMs);
      if (p / h < minR) { minR = p / h; minU = u; }
      const ref = reference(af, u * af.maxSpeedMs);
      assert.ok(Math.abs(p - ref) <= ref * 1e-6, af.id + ' at u=' + u + ': ' + p.toFixed(3) + ' W vs reference ' + ref.toFixed(3) + ' W');
    }
    assert.ok(minU >= 0.4 && minU <= 0.8, af.id + ': minimum-power speed at ' + minU + ' x vmax');
    assert.ok(minR <= 0.9, af.id + ': minimum power only ' + ((1 - minR) * 100).toFixed(1) + '% below hover');
  }
  // https://www.dji.com/mini-4-pro/specs: "Max Flight Time: 34 minutes",
  // flown at a constant 21.6 kph (6 m/s), against 30 min hovering. The micro's
  // drag area is fitted to that one cited point of its power curve.
  const micro = A.AIRFRAMES.find(a => a.id === 'micro');
  const cruiseMin = micro.batteryWh / A.flightPowerW(micro, 21.6 / 3.6) * 60;
  assert.ok(Math.abs(cruiseMin - 34) <= 1, 'micro full-pack time at 21.6 km/h ' + cruiseMin.toFixed(1) + ' min, DJI spec is 34 min');
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

// A link's shadow fade started at exactly 0 dB and only grew to the stated
// sigma over a few tau (43 % of it after 1 s), so every link at t=0 and every
// link re-formed after a prune was systematically less faded than documented.
test('a fresh link\'s shadow fade is drawn from the stationary distribution', () => {
  const { loadCore } = require('./helpers/sim.js');
  const ctx = loadCore();
  const s = { time: 0, shadowSigmaDb: 4.5, net: null };
  const first = seed => { s.net = ctx.makeNet(seed); return ctx.fadeDb(s, 'C2', 'DR-1'); };
  const xs = [];
  for (let seed = 1; seed <= 2000; seed++) xs.push(first(seed));
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));
  assert.ok(Math.abs(sd - 4.5) < 0.05 * 4.5, 'first-fade std ' + sd.toFixed(2) + ' dB vs environment sigma 4.5 dB');
  assert.ok(Math.abs(mean) < 0.25, 'first-fade mean ' + mean.toFixed(2) + ' dB');
  assert.strictEqual(first(77), first(77), 'same seed, same first fade');
  // No shadowing: no fade, and no draw — sigma-0 runs keep their RNG stream.
  s.shadowSigmaDb = 0;
  assert.strictEqual(first(77), 0);
  assert.strictEqual(s.net.rng(), ctx.makeNet(77).rng());
});
