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

test('radios in different bands cannot link at all', () => {
  assert.strictEqual(F.mixedLinkMarginDb(SIK, ESP, 1, 5), -Infinity);
  assert.strictEqual(F.bandCompatible(SIK, RFD), true, '915 vs 915 MHz is fine');
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

test('per-drone energy uses its own airframe (wing lasts longer)', () => {
  const { s } = runHeteroMission({}, 300); // 5 minutes of flight
  const wing = s.drones.filter(d => d.cls === 'relay');
  const tac = s.drones.filter(d => d.cls === 'mission' && ctx.alive(d));
  assert.ok(wing.length && tac.length);
  const wingPct = wing.reduce((a, d) => a + d.batteryPct, 0) / wing.length;
  const tacPct = tac.reduce((a, d) => a + d.batteryPct, 0) / tac.length;
  assert.ok(wingPct > tacPct,
    'X8 wing (' + wingPct.toFixed(1) + '%) should drain slower than micros (' + tacPct.toFixed(1) + '%)');
});

test('telemetry carries fleet class so C2 knows who is who', () => {
  const { s } = runHeteroMission({}, 30);
  const classes = Object.values(s.c2.known).map(k => k.cls);
  assert.ok(classes.includes('relay'), 'C2 must have heard from a wing unit');
  assert.ok(classes.includes('mission'), 'C2 must have heard from a tactical unit');
});
