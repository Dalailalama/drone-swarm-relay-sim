// Heterogeneous fleet tests — mixed airframes + mixed radios in one mission.
// Covers the pure link math (js/fleet.js), the class-assignment spread, and
// full headless integration: a relay wing on long-range radios must form and
// hold a chain that tactical short-range drones alone could not.

const { test } = require('node:test');
const assert = require('node:assert');

const F = require('../js/fleet.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
const ESP = R.RADIOS.find(r => r.id === 'espnow'); // 2.4 GHz — different band
const X8 = A.AIRFRAMES.find(a => a.id === 'x8');
const MICRO = A.AIRFRAMES.find(a => a.id === 'micro');

test('mixed margin with identical radios equals the classic single-radio margin', () => {
  for (const d of [10, 100, 299, 1000, 5000]) {
    assert.ok(Math.abs(F.mixedLinkMarginDb(SIK, SIK, 1, d) - R.linkMarginDb(SIK, 1, d)) < 1e-9,
      'identical radios at ' + d + ' m must collapse to linkMarginDb');
  }
});

test('mixed link budget is the worse direction, not an average', () => {
  // RFD900x transmits 10 dB hotter than SiK; the SiK->RFD direction is weaker.
  const a2b = F.rssiDirectionalDb(RFD, SIK, 1, 1000) - SIK.sensDbm;
  const b2a = F.rssiDirectionalDb(SIK, RFD, 1, 1000) - RFD.sensDbm;
  assert.ok(b2a < a2b, 'SiK TX direction should be the weak one');
  assert.strictEqual(F.mixedLinkMarginDb(RFD, SIK, 1, 1000), Math.min(a2b, b2a));
});

// Audit rf-physics/per-radio-n-as-channel-physics: each direction used the
// TRANSMITTER's fitted exponent, so one air path lost 51.6 dB more one way
// than the other at 300 m (SiK<->RFD900x).
test('a mixed link\'s path loss is reciprocal: one air path, one exponent', () => {
  const pl = (tx, rx, d) => tx.txDbm + tx.antGainDbi + rx.antGainDbi - F.rssiDirectionalDb(tx, rx, 1, d);
  let pairs = 0;
  for (const ra of R.RADIOS) for (const rb of R.RADIOS) {
    if (ra === rb || !F.bandCompatible(ra, rb)) continue;
    pairs++;
    for (const d of [100, 300, 3000]) {
      assert.ok(Math.abs(pl(ra, rb, d) - pl(rb, ra, d)) < 1e-9,
        ra.id + '<->' + rb.id + ' at ' + d + ' m: ' + pl(ra, rb, d).toFixed(1) + ' vs ' + pl(rb, ra, d).toFixed(1) + ' dB');
    }
  }
  assert.ok(pairs >= 2, 'expected at least the SiK/RFD900x pair');
  // The larger (conservative) exponent is the SiK's, so the binding SiK-TX
  // direction — and the link margin — are unchanged to the bit.
  for (const d of [100, 300, 3000]) {
    const n = R.pathLossExponent(SIK);
    assert.ok(n > R.pathLossExponent(RFD));
    const sikTx = SIK.txDbm + SIK.antGainDbi + RFD.antGainDbi - (R.pl1m(SIK.freqMHz) + 10 * n * Math.log10(d)) - RFD.sensDbm;
    assert.strictEqual(F.mixedLinkMarginDb(SIK, RFD, 1, d), sikTx);
  }
});

test('radios in different bands cannot link at all', () => {
  assert.strictEqual(F.mixedLinkMarginDb(SIK, ESP, 1, 5), -Infinity);
  assert.strictEqual(F.bandCompatible(SIK, RFD), true, '915 vs 915 MHz is fine');
});

test('radios link only when they share an air protocol, not merely a nearby frequency (audit)', () => {
  const LORA = R.RADIOS.find(r => r.id === 'lora868');
  const ELRS = R.RADIOS.find(r => r.id === 'elrs24');
  const DOODLE = R.RADIOS.find(r => r.id === 'doodle-rm');
  const XBEE = R.RADIOS.find(r => r.id === 'xbee900');
  assert.strictEqual(F.mixedLinkMarginDb(SIK, LORA, 1, 200), -Infinity, 'SiK GFSK cannot demodulate LoRa CSS');
  assert.strictEqual(F.bandCompatible(ESP, DOODLE), false);
  assert.strictEqual(F.bandCompatible(ESP, ELRS), false);
  assert.strictEqual(F.bandCompatible(LORA, XBEE), false);
  assert.strictEqual(F.bandCompatible(SIK, RFD), true, 'RFD900x speaks the SiK protocol');
  assert.ok(F.mixedLinkMarginDb(SIK, RFD, 1, 20) > 0);
  // An un-keyed custom preset still links to copies of itself.
  const custom = { id: 'my-radio', freqMHz: 433, txDbm: 20, sensDbm: -110, antGainDbi: 2, airRateKbps: 10, rangeLosM: 2000 };
  assert.strictEqual(F.bandCompatible(custom, Object.assign({}, custom)), true);
});

test('relay-wing class assignment spreads evenly and stays deterministic', () => {
  const a = F.relayClassIndices(10, 4);
  const b = F.relayClassIndices(10, 4);
  assert.deepStrictEqual(a, b, 'deterministic');
  assert.strictEqual(a.length, 4);
  assert.deepStrictEqual(a, [...new Set(a)], 'no duplicates');
  // gaps between consecutive indices should be near-uniform (spread, not clumped)
  const gaps = a.map((v, i) => (i ? v - a[i - 1] : v)).slice(1);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'evenly spaced: ' + a.join(','));
  // capped at fleet size
  assert.deepStrictEqual(F.relayClassIndices(3, 99).length, 3);
  assert.deepStrictEqual(F.relayClassIndices(10, 0), []);
});

function runHeteroMission(opts, seconds) {
  const s = ctx.makeSwarm(Object.assign({
    count: 8,
    airframe: MICRO,
    radio: SIK,
    envFactor: 1,
    targetX: 2600, targetY: -650,
    altitudeM: 60,
    seed: 7,
    // Relay wing: endurance airframe + 40 km radio
    relayWing: 3,
    relayAirframe: X8,
    relayRadio: RFD,
  }, opts));
  let status = null;
  while (s.time < seconds) status = ctx.stepSwarm(s, 0.25);
  return { s, status };
}

const TACT_REACH = ctx.usableRangeM(SIK, 1) * 0.8;

test('heterogeneous mission forms a chain from relay-wing units', () => {
  // Long horizon: an X8 needs ~3 min to physically fly 2.5 km out to station.
  const { s, status } = runHeteroMission({}, 260);
  assert.ok(status.connected, 'end-to-end link through the wing must exist');
  assert.ok(status.relayCount >= 1, 'long mission needs relays');
  for (const id of s.c2.relays) {
    const d = s.drones.find(x => x.id === id);
    assert.strictEqual(d.cls, 'relay',
      id + ' elected as relay but is tactical — C2 must prefer wing units');
  }
  // Handoff constraint: the deepest relay must sit inside TACTICAL reach of
  // the objective, or the short-legged flock can't hang off the chain.
  const tail = s.drones.find(x => x.id === s.c2.relays[s.c2.relays.length - 1]);
  const dTailTarget = Math.hypot(tail.x - s.target.x, tail.y - s.target.y);
  assert.ok(dTailTarget <= TACT_REACH * 1.45,
    'tail relay ' + dTailTarget.toFixed(0) + ' m from target exceeds tactical reach ' +
    TACT_REACH.toFixed(0) + ' m — flock would be marooned');
  // The tactical flock still exists and flies micros.
  const missionDrones = s.drones.filter(d => d.cls === 'mission');
  assert.ok(missionDrones.length >= 4);
  for (const d of missionDrones) assert.strictEqual(d.af.id, 'micro');
});

test('longer mission densifies the backhaul with multiple wing relays', () => {
  // A 12 km-rated Mesh Rider wing on a 9 km mission: even wing hops need
  // bridging, plus the tactical tail slot — expect a real multi-hop chain.
  const DOODLE = R.RADIOS.find(r => r.id === 'doodle-rm');
  const { s, status } = runHeteroMission({
    targetX: 9000, targetY: -1800,
    relayRadio: DOODLE,
  }, 240);
  // 9 km at wing speed is still in transit at T+240 — the subject here is
  // the multi-hop BACKHAUL (relay densification), not objective arrival.
  assert.ok(status.fleetConnected, 'multi-hop wing backhaul must close');
  assert.ok(status.relayCount >= 2, 'expected >=2 relays, got ' + status.relayCount);
  for (const id of s.c2.relays) {
    const d = s.drones.find(x => x.id === id);
    assert.strictEqual(d.cls, 'relay', id + ' must be a wing unit');
  }
});

test('tactical-only fleet cannot bridge the same distance the wing can', () => {
  // Same mission, no relay wing: SiK usable range (~300 m open field at
  // 6 dB fade... actually ~250 m) cannot span 2.6 km even with every drone relayed.
  const { status } = runHeteroMission({ relayWing: 0, relayAirframe: null, relayRadio: null }, 90);
  assert.strictEqual(status.connected, false,
    'short-range radios alone must NOT close a 2.6 km chain');
});

test('per-drone energy uses its own airframe (wing burns X8 watts)', () => {
  // With the coaxial shared-disc correction (audit EN-1) an X8 and a micro
  // hover for about the same time, so compare Wh drawn, not % left: a 2.9 kg
  // X8 pulls >10x the micro's watts, and % must be against its OWN pack.
  const { s } = runHeteroMission({}, 300); // 5 minutes of flight
  const wing = s.drones.filter(d => d.cls === 'relay');
  const tac = s.drones.filter(d => d.cls === 'mission' && ctx.alive(d));
  assert.ok(wing.length && tac.length);
  const used = d => A.usableWh(d.af) - d.energyWh;
  const wingWh = wing.reduce((a, d) => a + used(d), 0) / wing.length;
  const tacWh = tac.reduce((a, d) => a + used(d), 0) / tac.length;
  assert.ok(wingWh > 5 * tacWh,
    'X8 wing (' + wingWh.toFixed(1) + ' Wh) should draw far more than micros (' + tacWh.toFixed(1) + ' Wh)');
  for (const d of wing.concat(tac)) {
    assert.ok(Math.abs(d.batteryPct - d.energyWh / A.usableWh(d.af) * 100) < 0.5, d.id + ' % against own pack');
  }
});

test('telemetry carries fleet class so C2 knows who is who', () => {
  const { s } = runHeteroMission({}, 30);
  const classes = Object.values(s.c2.known).map(k => k.cls);
  assert.ok(classes.includes('relay'), 'C2 must have heard from a wing unit');
  assert.ok(classes.includes('mission'), 'C2 must have heard from a tactical unit');
});

test('decline log reports battery % against the drone\'s own airframe, not the fleet\'s (audit EN-7)', () => {
  const s = ctx.makeSwarm({
    count: 8, airframe: MICRO, radio: SIK, envFactor: 1,
    targetX: 2600, targetY: -650, altitudeM: 60, seed: 7,
    relayWing: 3, relayAirframe: X8, relayRadio: RFD,
  });
  const drained = s.drones.find(d => d.af && d.af.id === 'x8');
  while (s.time < 2) ctx.stepSwarm(s, 0.05);
  drained.energyWh = 25; // ~13% of the X8's own usable pack
  // A slot beyond the objective: costlier than the (no longer closing)
  // mission it is flying, so the commitment rule declines it. A cheaper slot
  // it would now take instead (audit C2-06).
  drained.inbox.push({ kind: 'cmd', src: 'C2', dst: drained.id, payload: {
    role: 'relay', slot: 0, k: 1, upstream: 'C2', slotPos: { x: 9000, y: -2250 },
    c2: { x: s.base.x, y: s.base.y, at: s.time }, target: { x: s.target.x, y: s.target.y } } });
  ctx.droneComms(s, drained);
  const declines = s.events.filter(e => e.msg.startsWith(drained.id + ' declines'));
  assert.ok(declines.length, 'the drained X8 must decline');
  for (const e of declines) {
    const pct = Number(e.msg.match(/\((\d+)% battery\)/)[1]);
    assert.ok(pct <= 100, 'battery % above 100: ' + e.msg);
    assert.strictEqual(pct, Math.round(25 / A.usableWh(X8) * 100), e.msg);
  }
});

// The page always passes the relay-radio selector (RFD900x by default), even
// with the relay wing off. No drone carries that radio, yet the routing span
// prefilter widened to its range and C2 sent a second broadcast on it when
// it could not hear the tactical radio — so a page run and its capture replay
// (which drops the unflown radio) diverged, and an ESP-NOW fleet lost half
// its deliveries to a radio nobody flies.
test('a relay radio that no drone flies (wing 0) changes nothing', () => {
  const run = (radio, extra) => {
    const s = ctx.makeSwarm(Object.assign({
      count: 6, airframe: A.AIRFRAMES.find(a => a.id === 'q450'), radio,
      envFactor: 0.2, shadowSigmaDb: 6.5, targetX: 420, targetY: -160, altitudeM: 60, seed: 77,
      jammers: [{ x: 210, y: -60, erpDbm: 18, band: 'all', altM: 15, on: true }],
    }, extra));
    while (s.time < 90) ctx.stepSwarm(s, 0.05);
    return s.net.delivered + ' ' + s.drones.map(d => d.x + ',' + d.y).join(';');
  };
  for (const radio of [SIK, ESP]) {
    assert.strictEqual(run(radio, { relayWing: 0, relayAirframe: X8, relayRadio: RFD }), run(radio, {}),
      radio.id + ' fleet diverged because of an unflown relay radio');
  }
});
