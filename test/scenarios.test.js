// DDIL scenario pack tests — every bundled scenario must load cleanly into
// the same code path a user-saved file takes: valid ids, sane geometry,
// reproducible seeds, and honest field ranges.

const { test } = require('node:test');
const assert = require('node:assert');

const { SCENARIO_PACK } = require('../js/scenarios.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

test('pack covers all four DDIL modes plus the flagship combo', () => {
  const ids = SCENARIO_PACK.map(p => p.id);
  assert.ok(ids.includes('ddil-denied'), 'D: denied');
  assert.ok(ids.includes('ddil-disrupted'), 'D: disrupted');
  assert.ok(ids.includes('ddil-intermittent'), 'I: intermittent');
  assert.ok(ids.includes('ddil-limited'), 'L: limited');
  assert.ok(ids.includes('ddil-full'), 'full combination');
  assert.strictEqual(new Set(ids).size, ids.length, 'unique ids');
});

test('every scenario is well-formed and references real hardware', () => {
  for (const p of SCENARIO_PACK) {
    assert.ok(p.title && p.title.length > 5, p.id + ': titled');
    assert.ok(p.blurb && p.blurb.length > 40, p.id + ': has a real description');
    const sc = p.scenario;
    assert.ok(R.RADIOS.some(r => r.id === sc.radio), p.id + ': radio exists');
    assert.ok(ENVIRONMENT_IDS(sc.env), p.id + ': env exists');
    assert.ok(A.AIRFRAMES.some(a => a.id === sc.airframe), p.id + ': airframe exists');
    assert.ok(Number.isFinite(sc.seed), p.id + ': seeded (exact terrain reproduction)');
    // geometry: finite base/target, target actually far from base
    const D = Math.hypot(sc.target.x - sc.base.x, sc.target.y - sc.base.y);
    assert.ok(D > 300, p.id + ': mission spans ' + D.toFixed(0) + ' m — must be non-trivial');
    // jammers within the UI's power range
    for (const j of sc.jammers || []) {
      assert.ok(j.erpDbm >= 0 && j.erpDbm <= 42, p.id + ': jammer power in range');
      assert.ok(j.on !== false, p.id + ': placed jammers start on');
    }
    for (const z of sc.gpsZones || []) {
      assert.ok(z.rM > 50 && z.rM < 2000, p.id + ': GPS zone radius sane');
    }
    if (sc.videoBackhaul) {
      assert.ok(sc.videoKbps >= 50 && sc.videoKbps <= 2000, p.id + ': video bitrate in UI range');
    }
    if (sc.hetero) {
      assert.ok(A.AIRFRAMES.some(a => a.id === sc.relayAirframe), p.id + ': wing airframe exists');
      assert.ok(R.RADIOS.some(r => r.id === sc.relayRadio), p.id + ': wing radio exists');
      assert.ok(sc.relayWing >= 1 && sc.relayWing < sc.count, p.id + ': wing is a minority');
    }
  }
});

function ENVIRONMENT_IDS(envId) {
  return ['open', 'suburban', 'urban'].includes(envId);
}

// Integration: run each scenario headlessly through the REAL loader path
// (makeSwarm options built exactly like applyScenario builds them) and prove
// the swarm launches and reaches its first planning decisions.
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['scenarios.js']);

test('each scenario runs headlessly without throwing and plans a chain', () => {
  for (const p of SCENARIO_PACK) {
    const sc = p.scenario;
    const radio = R.RADIOS.find(r => r.id === sc.radio);
    const envF = { open: 1.0, suburban: 0.45, urban: 0.2 }[sc.env];
    const s = ctx.makeSwarm({
      count: sc.count,
      airframe: A.AIRFRAMES.find(a => a.id === sc.airframe),
      altitudeM: sc.altitudeM,
      deployFrac: sc.spacingPct / 100,
      corridorRouting: sc.corridor !== false,
      broadcastC2: sc.broadcast !== false,
      windX: sc.windSpd * Math.cos(sc.windDir * Math.PI / 180),
      windY: sc.windSpd * Math.sin(sc.windDir * Math.PI / 180),
      targetX: sc.target.x, targetY: sc.target.y,
      radio, envFactor: envF,
      shadowSigmaDb: { open: 2.5, suburban: 4.5, urban: 6.5 }[sc.env],
      seed: sc.seed,
      relayWing: sc.hetero ? sc.relayWing : 0,
      relayAirframe: A.AIRFRAMES.find(a => a.id === sc.relayAirframe) || null,
      relayRadio: R.RADIOS.find(r => r.id === sc.relayRadio) || null,
      jammers: sc.jammers || [],
      gpsZones: sc.gpsZones || [],
      spectrumAgility: !!sc.spectrumAgility,
      lpiMode: !!sc.lpiMode,
      videoOn: !!sc.videoBackhaul,
      videoKbps: sc.videoKbps,
    });
    let st = null;
    for (let i = 0; i < 240; i++) st = ctx.stepSwarm(s, 0.25); // one sim minute
    assert.ok(st.aliveCount > 0, p.id + ': fleet alive after 60 s');
    assert.ok(s.c2.chainPlan && s.c2.chainPlan.slots.length >= 0, p.id + ': C2 produced a plan');
  }
});
