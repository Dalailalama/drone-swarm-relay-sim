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
  const want = Math.pow(10, (j.erpDbm + 2.15 + LORA.antGainDbi - ctx.pl1m(LORA.freqMHz) - 15 - LORA.sensDbm) / (10 * n));
  assert.ok(Math.abs(ctx.jammerDenialRadiusM(s, j) / want - 1) < 1e-9, 'denial radius must use SIR -15 dB');
});

test('each receiver\'s interference degrades only the direction it hears (mixed link)', () => {
  const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
  const s = makeSw(SIK, [{ id: 'JX-1', x: 0, y: 0, erpDbm: 5, band: 'all', altM: 15, on: true }]);
  s.terrain = ctx.makeTerrain('flat');
  // A tower shadows the jammer from the RFD relay only.
  s.terrain.buildings = [{ x: 50, y: 60, w: 20, d: 20, heightM: 100 }];
  ctx.indexBuildings(s.terrain);
  const [a, b] = s.drones;
  a.radio = RFD; a.x = 100; a.y = 120; a.altM = 30;
  b.radio = SIK; b.x = 100; b.y = 0; b.altM = 30;
  s._marginCache = null;
  const altA = ctx.nodeAltAbsM(s, a.id, a), altB = ctx.nodeAltAbsM(s, b.id, b);
  const nCh = ctx.channelExponent(RFD, SIK); // the link's one exponent
  const pen = (pos, alt, r) => { // noise and interference add in power
    const f = ctx.interferenceFloorDbm(s, pos, alt, r, nCh);
    return f > -Infinity ? 10 * Math.log10(1 + Math.pow(10, (f - r.sensDbm) / 10)) : 0;
  };
  const pa = pen(a, altA, RFD), pb = pen(b, altB, SIK);
  assert.strictEqual(pa, 0, 'the tower must shadow the jammer from the RFD end');
  assert.ok(pb > 10, 'the SiK end must be heavily jammed, got ' + pb);
  const slant = Math.hypot(Math.hypot(a.x - b.x, a.y - b.y), altA - altB);
  const fade = ctx.fadeDb(s, a.id, b.id);
  const toSik = ctx.rssiDirectionalDb(RFD, SIK, s.envFactor, slant) - SIK.sensDbm + fade - pb;
  const toRfd = ctx.rssiDirectionalDb(SIK, RFD, s.envFactor, slant) - RFD.sensDbm + fade - pa;
  const got = ctx.liveMarginDb(s, a.id, b.id);
  // The RFD's 10 dB hotter transmitter and the SiK's 12 dB better sensitivity
  // leave the jammed direction spare margin: the clean direction still binds.
  assert.ok(toSik > toRfd && toRfd > 0, 'the SiK end\'s jamming must cost only its own direction');
  assert.ok(Math.abs(got - toRfd) < 1e-9, 'liveMarginDb ' + got + ' must equal the per-direction min ' + toRfd);
});

// Audit rf-physics/per-radio-n-as-channel-physics: on a mixed link the signal
// now crosses the air with the link's one exponent (the larger fit), and the
// jammer reaching either receiver of that link uses the same law — the RFD
// end no longer hears the jammer over its own gentle 2.1 exponent while its
// SiK partner's signal fades at 3.9.
test('on a mixed link, interference and signal share the link\'s path-loss exponent', () => {
  const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
  const s = makeSw(SIK, [{ id: 'JX-1', x: 250, y: 200, erpDbm: 12, band: 'all', altM: 15, on: true }]);
  s.terrain = ctx.makeTerrain('flat');
  // A tower shadows the jammer from the SiK end only.
  s.terrain.buildings = [{ x: 175, y: 100, w: 30, d: 30, heightM: 100 }];
  ctx.indexBuildings(s.terrain);
  const [a, b] = s.drones;
  a.radio = RFD; a.x = 100; a.y = 120; a.altM = 30;
  b.radio = SIK; b.x = 100; b.y = 0; b.altM = 30;
  s._marginCache = null;
  const nCh = Math.max(R.pathLossExponent(SIK), R.pathLossExponent(RFD));
  const altA = ctx.nodeAltAbsM(s, a.id, a), altB = ctx.nodeAltAbsM(s, b.id, b);
  assert.strictEqual(ctx.interferenceFloorDbm(s, b, altB, SIK), -Infinity, 'the tower must shadow the jammer from the SiK end');
  const pb = 0;
  // The RFD end, from first principles: EIRP + G_rx - PL(link exponent), +10 dB SIR.
  const j = s.jammers[0];
  const jSlant = Math.hypot(Math.hypot(a.x - j.x, a.y - j.y), altA - 15);
  const fa = j.erpDbm + 2.15 + RFD.antGainDbi - (R.pl1m(RFD.freqMHz) + 10 * nCh * Math.log10(jSlant)) + 10;
  const pa = 10 * Math.log10(1 + Math.pow(10, (fa - RFD.sensDbm) / 10));
  assert.ok(pa > 1, 'the RFD end must hear the jammer, got ' + pa);
  const slant = Math.hypot(Math.hypot(a.x - b.x, a.y - b.y), altA - altB);
  const fade = ctx.fadeDb(s, a.id, b.id);
  const want = Math.min(
    ctx.rssiDirectionalDb(RFD, SIK, s.envFactor, slant) - SIK.sensDbm + fade - pb,
    ctx.rssiDirectionalDb(SIK, RFD, s.envFactor, slant) - RFD.sensDbm + fade - pa);
  const got = ctx.liveMarginDb(s, a.id, b.id);
  assert.ok(want > 0, 'the link survives a jammer it hears over the shared exponent, margin ' + want);
  assert.ok(Math.abs(got - want) < 1e-9, 'liveMarginDb ' + got + ' must use the link exponent for J: ' + want);
});

// Audit rf-physics/jammer-missing-rx-gain-erp: the signal path counts both
// antennas (txDbm + G_tx + G_rx - PL) but the jammer path counted neither the
// receive antenna nor the ERP -> EIRP conversion (ERP is dipole-referenced:
// EIRP = ERP + 2.15 dB), so every jammer arrived 4-5 dB too weak.
test('a jammer radiating a node\'s EIRP from the node\'s spot arrives exactly at that node\'s RSSI', () => {
  const s = makeSw(SIK, []);
  s.terrain = ctx.makeTerrain('flat');
  const erp = SIK.txDbm + SIK.antGainDbi - 2.15; // same EIRP as a SiK node
  s.jammers = [{ id: 'JX-1', x: 0, y: 0, erpDbm: erp, band: 'all', altM: 15, on: true }];
  for (const d of [50, 300, 2000]) {
    const floor = ctx.interferenceFloorDbm(s, { x: d, y: 0 }, 15, SIK);
    const sig = R.rssiAt(SIK, 1, d);
    assert.ok(Math.abs(floor - 10 - sig) < 1e-9,
      'at ' + d + ' m the jammer arrives at ' + (floor - 10).toFixed(2) + ' dBm, the node at ' + sig.toFixed(2) + ' dBm');
  }
  // The drawn red-zone radius is the inDenialZone boundary (flat ground,
  // receiver at the jammer's height, so the slant equals the ground range).
  s.altitudeM = 15;
  const j = { id: 'JX-2', x: 0, y: 0, erpDbm: 0, band: 'all', altM: 15, on: true };
  s.jammers = [j];
  const r = ctx.jammerDenialRadiusM(s, j);
  assert.ok(ctx.inDenialZone(s, { x: r * 0.999, y: 0 }) && !ctx.inDenialZone(s, { x: r * 1.001, y: 0 }),
    'denial radius ' + r.toFixed(1) + ' m must match the inDenialZone boundary');
});

// Audit rf-physics/noise-plus-interference-dB-max: the receiver's own noise
// (sensitivity) and the interference-derived floor add in milliwatts. A dB
// max() read 0 dB below the floor and was 3.01 dB optimistic at F = S.
test('noise and interference add in power: 3.01 dB when the floor equals sensitivity', () => {
  const s = makeSw(SIK, []);
  s.terrain = ctx.makeTerrain('flat');
  const pos = { x: 400, y: 0 };
  const j = { id: 'JX-1', x: 0, y: 0, erpDbm: 0, band: 'all', altM: 15, on: true };
  s.jammers = [j];
  const f0 = ctx.interferenceFloorDbm(s, pos, 15, SIK); // the floor is linear in erpDbm
  for (const [above, want] of [[0, 3.0103], [-10, 0.4139], [20, 20.0432]]) {
    j.erpDbm = SIK.sensDbm + above - f0;
    const got = ctx.endPenaltyDb(s, pos, 15, SIK);
    assert.ok(Math.abs(got - want) < 0.01, 'floor ' + above + ' dB vs sensitivity: penalty ' + got.toFixed(4) + ' dB, want ' + want);
    const link = ctx.interferencePenaltyDb(s, pos, 15, { x: -400, y: 0 }, 15, SIK, SIK);
    assert.ok(Math.abs(link - want) < 0.01, 'link penalty ' + link.toFixed(4) + ' dB, want ' + want);
  }
  j.on = false;
  assert.strictEqual(ctx.endPenaltyDb(s, pos, 15, SIK), 0, 'no active source, no penalty');
  j.on = true; j.band = 2400;
  assert.strictEqual(ctx.endPenaltyDb(s, pos, 15, SIK), 0, 'out-of-band source, no penalty');
});
