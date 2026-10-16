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

test('each receiver\'s interference degrades only the direction it hears (mixed link)', () => {
  const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
  const s = makeSw(SIK, [{ id: 'JX-1', x: 0, y: 0, erpDbm: 30, band: 'all', altM: 15, on: true }]);
  s.terrain = ctx.makeTerrain('flat');
  // A tower shadows the jammer from the RFD relay only.
  s.terrain.buildings = [{ x: 50, y: 60, w: 20, d: 20, heightM: 100 }];
  ctx.indexBuildings(s.terrain);
  const [a, b] = s.drones;
  a.radio = RFD; a.x = 100; a.y = 120; a.altM = 30;
  b.radio = SIK; b.x = 100; b.y = 0; b.altM = 30;
  s._marginCache = null;
  const altA = ctx.nodeAltAbsM(s, a.id, a), altB = ctx.nodeAltAbsM(s, b.id, b);
  const pen = (pos, alt, r) => Math.max(0, ctx.interferenceFloorDbm(s, pos, alt, r) - r.sensDbm);
  const pa = pen(a, altA, RFD), pb = pen(b, altB, SIK);
  assert.strictEqual(pa, 0, 'the tower must shadow the jammer from the RFD end');
  assert.ok(pb > 30, 'the SiK end must be heavily jammed, got ' + pb);
  const slant = Math.hypot(Math.hypot(a.x - b.x, a.y - b.y), altA - altB);
  const fade = ctx.fadeDb(s, a.id, b.id);
  const want = Math.min(
    ctx.rssiDirectionalDb(RFD, SIK, s.envFactor, slant) - SIK.sensDbm + fade - pb,
    ctx.rssiDirectionalDb(SIK, RFD, s.envFactor, slant) - RFD.sensDbm + fade - pa);
  const got = ctx.liveMarginDb(s, a.id, b.id);
  assert.ok(want > 0, 'per-direction physics keeps this link alive');
  assert.ok(Math.abs(got - want) < 1e-9, 'liveMarginDb ' + got + ' must equal the per-direction min ' + want);
});
