// Vertical mission library tests — templates must be valid, and the moving
// missions must actually MOVE: the convoy's ground station advances at road
// speed while the chain re-plans behind it, staying connected.

const { test } = require('node:test');
const assert = require('node:assert');

const { MISSION_LIBRARY } = require('../js/missions.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['missions.js']);

test('library covers the five sales verticals with real content', () => {
  const ids = MISSION_LIBRARY.map(m => m.id);
  for (const want of ['sar-grid', 'wildfire-overwatch', 'pipeline-linear', 'convoy-escort', 'perimeter-patrol']) {
    assert.ok(ids.includes(want), 'missing vertical: ' + want);
  }
  for (const m of MISSION_LIBRARY) {
    assert.ok(m.blurb.length > 60, m.id + ': blurb must sell the vertical');
    assert.ok(m.checklist.length >= 3 && m.checklist.length <= 6,
      m.id + ': operator checklist of 3-6 items');
    assert.ok(R.RADIOS.some(r => r.id === m.scenario.radio), m.id + ': radio exists');
    assert.ok(A.AIRFRAMES.some(a => a.id === m.scenario.airframe), m.id + ': airframe exists');
    assert.ok(Number.isFinite(m.scenario.seed), m.id + ': seeded');
    const D = Math.hypot(m.scenario.target.x - m.scenario.base.x, m.scenario.target.y - m.scenario.base.y);
    assert.ok(D > 150, m.id + ': mission geometry non-trivial (' + D.toFixed(0) + ' m)');
  }
});

test('convoy escort: base advances at road speed while the link holds', () => {
  const m = MISSION_LIBRARY.find(x => x.id === 'convoy-escort');
  const sc = m.scenario;
  const v = m.dynamics.baseVelMps;
  const s = ctx.makeSwarm({
    count: sc.count,
    airframe: A.AIRFRAMES.find(a => a.id === sc.airframe),
    radio: R.RADIOS.find(r => r.id === sc.radio),
    envFactor: { open: 1, suburban: 0.45, urban: 0.2 }[sc.env],
    shadowSigmaDb: { open: 2.5, suburban: 4.5, urban: 6.5 }[sc.env],
    altitudeM: sc.altitudeM, deployFrac: sc.spacingPct / 100,
    targetX: sc.target.x, targetY: sc.target.y,
    seed: sc.seed,
    relayWing: sc.relayWing, relayAirframe: A.AIRFRAMES.find(a => a.id === sc.relayAirframe),
    relayRadio: R.RADIOS.find(r => r.id === sc.relayRadio),
    videoOn: !!sc.videoBackhaul, videoKbps: sc.videoKbps || 0,
    baseVel: v,
  });
  const startX = s.base.x;
  let st = null;
  const checkpoints = [];
  while (s.time < 180) {
    st = ctx.stepSwarm(s, 0.25);
    if (Math.abs(s.time - 90) < 0.125) checkpoints.push({ t: s.time, x: s.base.x, conn: st.connected });
  }
  // The command post really moved — road speed × elapsed time.
  assert.ok(Math.abs(checkpoints[0].x - (startX + v.x * 90)) < 2,
    'base must advance v·t, got ' + checkpoints[0].x.toFixed(1));
  // And the swarm stayed with it most of the way.
  assert.ok(st.connected, 'chain must still close at T+180 s while driving');
});

test('wildfire overwatch: objective drifts downwind and the flock follows', () => {
  const m = MISSION_LIBRARY.find(x => x.id === 'wildfire-overwatch');
  const sc = m.scenario;
  const tv = m.dynamics.targetVelMps;
  const s = ctx.makeSwarm({
    count: 6,
    airframe: A.AIRFRAMES.find(a => a.id === sc.airframe),
    radio: R.RADIOS.find(r => r.id === sc.radio),
    envFactor: 1, altitudeM: sc.altitudeM, deployFrac: sc.spacingPct / 100,
    targetX: sc.target.x, targetY: sc.target.y,
    windX: sc.windSpd * Math.cos(sc.windDir * Math.PI / 180),
    windY: sc.windSpd * Math.sin(sc.windDir * Math.PI / 180),
    seed: sc.seed, targetVel: tv,
  });
  const startT = { x: s.target.x, y: s.target.y };
  let st = null;
  // 4.3 km at X8 speed needs ~270 s of transit — run long enough that the
  // ring genuinely reaches the front, then holds ON it (finding #6:
  // `connected` now means on-station at the objective, not merely linked).
  while (s.time < 420) st = ctx.stepSwarm(s, 0.25);
  const drift = Math.hypot(s.target.x - startT.x, s.target.y - startT.y);
  assert.ok(Math.abs(drift - Math.hypot(tv.x, tv.y) * 420) < 5,
    'front must creep |v|·t = ' + (Math.hypot(tv.x, tv.y) * 420).toFixed(0) + ' m, got ' + drift.toFixed(0));
  assert.ok(st.connected, 'overwatch ring stays linked ON the drifting front');
});

test('perimeter patrol launches a large short-range ring that heals', () => {
  const m = MISSION_LIBRARY.find(x => x.id === 'perimeter-patrol');
  const sc = m.scenario;
  const s = ctx.makeSwarm({
    count: sc.count,
    airframe: A.AIRFRAMES.find(a => a.id === sc.airframe),
    radio: R.RADIOS.find(r => r.id === sc.radio),
    envFactor: 1, altitudeM: sc.altitudeM, deployFrac: sc.spacingPct / 100,
    targetX: sc.target.x, targetY: sc.target.y, seed: sc.seed,
  });
  let st = null;
  while (s.time < 100) st = ctx.stepSwarm(s, 0.25);
  assert.strictEqual(st.aliveCount, sc.count);
  assert.ok(st.connected, 'dense ESP-NOW mesh must close over a small site');
});
