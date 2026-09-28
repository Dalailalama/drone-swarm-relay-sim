// Regression for #19: drawn links (the labelled chain `hops` and the mesh
// `links`) took their colour and dB label from the instantaneous margin, which
// rides the shadow-fading process. A link sitting near the 6 dB fade line
// flipped green/amber many times a minute and its label changed every frame
// (measured 0.8-20 colour flips and 240-620 label changes per link-minute —
// five times that per real minute at the default 5x). The fix is display-only:
// routing, uptime and `connected` keep reading raw margins.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const DT = 0.05;
const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const stateOf = m => (m >= R.FADE_MARGIN_DB ? 'ok' : m >= 0 ? 'degraded' : 'lost');

// One mission drone parked where its link to C2 sits exactly on the fade line
// (slant range == usable range), under open-field shadowing (sigma 2.5 dB).
function edgeLink(seed) {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 1, seed, radio: SIK, airframe: Q450, envFactor: 1, shadowSigmaDb: 2.5,
    altitudeM: 50, targetX: 800, targetY: 0,
  });
  const d = s.drones[0];
  const U = ctx.usableRangeM(SIK, 1);
  const dz = 50 - 6; // drone AGL minus the C2 mast
  d.x = d.belX = Math.sqrt(U * U - dz * dz); d.y = d.belY = 0; d.vx = d.vy = 0;
  return { ctx, s, d };
}

test('#19: a link riding the fade line does not flicker on the map', () => {
  const { ctx, s, d } = edgeLink(31);
  let raw = null, drawn = null, rawFlips = 0, drawnFlips = 0, rawLabels = 0, drawnLabels = 0;
  let prevRawLabel = null, prevDrawnLabel = null, lastHop = null;
  for (let i = 0; i < 2400; i++) { // 120 s
    s.time += DT;
    ctx.stepFades(s, DT);
    const st = ctx.chainStatus(s);
    const hop = st.hops.find(h => h.b.id === d.id || h.a.id === d.id);
    assert.ok(hop, 'the C2 <-> drone hop is always drawn');
    const m = Math.max(-99, ctx.liveMarginDb(s, 'C2', d.id));
    const rs = stateOf(m);
    if (raw !== null && rs !== raw) rawFlips++;
    if (drawn !== null && hop.state !== drawn) drawnFlips++;
    raw = rs; drawn = hop.state;
    const rl = Math.round(m), dl = Math.round(hop.marginDb);
    if (prevRawLabel !== null && rl !== prevRawLabel) rawLabels++;
    if (prevDrawnLabel !== null && dl !== prevDrawnLabel) drawnLabels++;
    prevRawLabel = rl; prevDrawnLabel = dl;
    // the mesh link for the same pair must agree with the labelled hop
    const link = st.links.find(l => l.b.id === d.id);
    if (link) assert.strictEqual(link.state, hop.state, `t=${s.time.toFixed(2)}: link and hop disagree`);
    lastHop = { hop, m };
  }
  assert.ok(rawFlips >= 20, 'setup: the raw margin must actually cross the fade line often, got ' + rawFlips);
  assert.ok(drawnFlips <= rawFlips / 5,
    `drawn colour flipped ${drawnFlips} times in 120 s (raw margin crossed ${rawFlips} times)`);
  assert.ok(drawnLabels <= rawLabels / 3,
    `drawn dB label changed ${drawnLabels} times in 120 s (raw ${rawLabels})`);
  assert.strictEqual(lastHop.hop.rawMarginDb, lastHop.m, 'the instantaneous margin rides along as rawMarginDb');
});

test('#19: a link that truly dies shows red at once (guard)', () => {
  const { ctx, s, d } = edgeLink(32);
  for (let i = 0; i < 40; i++) { s.time += DT; ctx.stepFades(s, DT); ctx.chainStatus(s); }
  d.x = d.belX = 60000; // far past the radio horizon: hard-dead
  s.time += DT;
  const st = ctx.chainStatus(s);
  const hop = st.hops.find(h => h.b.id === d.id || h.a.id === d.id);
  assert.strictEqual(hop.state, 'lost', 'a hard-dead hop must draw red on the very next frame');
  assert.strictEqual(Math.round(hop.marginDb), -99, 'and label its real (floored) margin');
});
