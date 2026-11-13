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

// audit swarm-onboard/SCN-01: ddil-intermittent's urban clutter factor left
// SiK 42 m of usable range — 18 relays for its span with 12 drones — so no
// drone ever reached the objective. Every bundled scenario and mission must
// be flyable with the fleet it ships: the planner's relay count for the
// span (chain radio, clutter factor, LPI budget cost, radio horizon, hop
// spacing) leaves at least one drone for the mission; a relay wing also
// holds the tactical hand-off slot at the objective.
const { MISSION_LIBRARY } = require('../js/missions.js');
const { runScenarioSeed } = require('../tools/compare.js');

// planChain's slot count over a straight base->objective path.
const relaysForSpan = (D, span) => Math.max(0, Math.ceil(D / span) - 1);

test('every bundled scenario and mission has enough drones for the relay chain its span needs', () => {
  const C2_MAST_M = 6;
  for (const { id, scenario: sc } of [...SCENARIO_PACK, ...MISSION_LIBRARY]) {
    const env = R.ENVIRONMENTS.find(e => e.id === sc.env);
    const chain = R.RADIOS.find(r => r.id === (sc.hetero ? sc.relayRadio : sc.radio));
    const lossDb = ctx.planLossDb({ lpiMode: !!sc.lpiMode });
    const usable = Math.min(R.usableRangeM(chain, env.factor, lossDb), R.radioHorizonM(C2_MAST_M, sc.altitudeM));
    const D = Math.hypot(sc.target.x - sc.base.x, sc.target.y - sc.base.y);
    const k = relaysForSpan(D, usable * sc.spacingPct / 100);
    if (sc.hetero) assert.ok(k + 1 <= sc.relayWing, `${id}: ${k} wing relays + the hand-off slot vs a wing of ${sc.relayWing}`);
    else assert.ok(k < sc.count, `${id}: ${k} relays for ${D.toFixed(0)} m vs ${sc.count} drones`);
  }
});

// The shipped batch study (README: node tools/batch.js --config
// batch/example.json) copied ddil-intermittent's SiK-over-a-modelled-city
// setup with the urban clutter factor SCN-01 removed there: 42 m of usable
// range, 15 relays for the span with 12 drones, so every cell read 0% uptime.
test('the example batch study has enough drones for the relay chain in every sweep cell', () => {
  const cfg = require('../batch/example.json');
  const env = R.ENVIRONMENTS.find(e => e.id === cfg.env);
  const chain = R.RADIOS.find(r => r.id === cfg.radio);
  const D = Math.hypot(cfg.mission.targetX, cfg.mission.targetY); // the batch base is fixed at 0,0
  for (const cell of cfg.sweep) {
    const alt = cell.altitudeM ?? cfg.altitudeM ?? 70;
    const usable = Math.min(R.usableRangeM(chain, env.factor, ctx.planLossDb({ lpiMode: false })), R.radioHorizonM(6, alt));
    const k = relaysForSpan(D, usable * (cell.spacingPct ?? cfg.spacingPct ?? 80) / 100);
    assert.ok(k < cfg.count, `${cell.name}: ${k} relays for ${D.toFixed(0)} m vs ${cfg.count} drones`);
  }
});

test('ddil-intermittent reaches its objective and the link flickers rather than holding or never forming', () => {
  const p = SCENARIO_PACK.find(x => x.id === 'ddil-intermittent');
  let S = null, drops = 0, was = false;
  const wrapped = Object.create(ctx);
  wrapped.stepSwarm = (s, dt) => {
    S = s;
    const st = ctx.stepSwarm(s, dt);
    if (was && !st.connected) drops++;
    was = st.connected;
    return st;
  };
  runScenarioSeed(wrapped, p, p.scenario.seed, 300);
  assert.ok(S.stats.connSec > 60, 'objective covered for ' + S.stats.connSec.toFixed(0) + ' s of 300');
  assert.ok(drops >= 1, 'objective contact must drop at least once (the I in DDIL)');
});

// audit swarm-onboard/SCN-02: ddil-full's tactical micros flew 95 m SiK legs,
// lost C2 about 250 m out and cycled hold/relink by the base for 15 minutes
// while only wing units ever reached the objective (0-9% objective uptime).
// A minute in, every micro must still be in contact and well on its way.
test('ddil-full tactical micros stay in contact and leave the base area', () => {
  const p = SCENARIO_PACK.find(x => x.id === 'ddil-full');
  let S = null;
  const wrapped = Object.create(ctx);
  wrapped.stepSwarm = (s, dt) => { S = s; return ctx.stepSwarm(s, dt); };
  runScenarioSeed(wrapped, p, p.scenario.seed, 60);
  const micros = S.drones.filter(d => d.cls === 'mission');
  assert.strictEqual(micros.length, p.scenario.count - p.scenario.relayWing);
  for (const d of micros) {
    assert.strictEqual(d.mode, 'ok', d.id + ' is in ' + d.mode);
    assert.ok(Math.hypot(d.x - S.base.x, d.y - S.base.y) > 400, d.id + ' is still by the base');
  }
});

// A jammer that "squats beside the corridor" must not deny the ground station
// or the objective outright: ddil-full's 18 dBm source denied a 3.9 km disc of
// the wing's band, so on most terrain seeds the chain had nowhere to go.
// Flat ground too: terrain only ever shadows a source, so a layout clear on
// flat ground is clear on every seed. ddil-disrupted's 21 dBm source denied a
// ~1.55 km disc ~1.1 km from its base, kept clear only by a hill on seed 4102:
// on compare's seeds 101-105 the base or the objective was denied on four.
const buildScenario = (p, terrain) => {
  let S = null;
  const wrapped = Object.create(ctx);
  wrapped.makeSwarm = opts => (S = ctx.makeSwarm(opts));
  runScenarioSeed(wrapped, { ...p, scenario: { ...p.scenario, terrain } }, p.scenario.seed, 0); // built as the page builds it, never stepped
  return S;
};

test('no bundled jammer denies the base or the objective of its own scenario, on its seed or on flat ground', () => {
  for (const p of SCENARIO_PACK) {
    if (!(p.scenario.jammers || []).length) continue;
    for (const terrain of [p.scenario.terrain, 'flat']) {
      const S = buildScenario(p, terrain);
      const at = p.id + ' on ' + terrain;
      assert.ok(!ctx.inDenialZone(S, S.base), at + ': base inside a denial zone');
      assert.ok(!ctx.inDenialZone(S, S.target), at + ': objective inside a denial zone');
      if (terrain !== 'flat') continue;
      for (const j of S.jammers) {
        const r = ctx.jammerDenialRadiusM(S, j);
        assert.ok(Math.hypot(j.x - S.base.x, j.y - S.base.y) > r, at + ': base inside the drawn disc of ' + j.x + ',' + j.y);
        assert.ok(Math.hypot(j.x - S.target.x, j.y - S.target.y) > r, at + ': objective inside the drawn disc of ' + j.x + ',' + j.y);
      }
    }
  }
});

// ...while the emitters still block the direct corridor (the blurb): on flat
// ground the straight chain's relay slot is denied, and C2's plan bends
// around the denial instead of failing or flying through it.
test('ddil-disrupted blocks the direct corridor on flat ground and the planned chain bends around it', () => {
  const p = SCENARIO_PACK.find(x => x.id === 'ddil-disrupted');
  const S = buildScenario(p, 'flat');
  const B = S.base, T = S.target, L = Math.hypot(T.x - B.x, T.y - B.y);
  assert.ok(ctx.inDenialZone(S, { x: (B.x + T.x) / 2, y: (B.y + T.y) / 2 }), 'the direct corridor is open');
  const plan = ctx.planChain(S);
  assert.ok(plan.feasible !== false && plan.slots.length > 0, 'no chain around the denial');
  const off = q => Math.abs((q.x - B.x) * (T.y - B.y) - (q.y - B.y) * (T.x - B.x)) / L;
  for (const q of plan.slots) assert.ok(!ctx.inDenialZone(S, q), 'slot ' + q.x.toFixed(0) + ',' + q.y.toFixed(0) + ' is jammed');
  assert.ok(Math.max(...plan.slots.map(off)) > 200, 'the chain runs straight down the corridor');
});
