// 'Chain throughput' KPI used the tactical radio's air rate for every hop
// (audit ui-render/kpi-throughput-ignores-hop-radios). In a mixed fleet (the
// Full DDIL pack, or just 'Mixed fleet' on) the backhaul hop flies the relay
// wing's rfd900x (224 kbps), not the tactical SiK (64 kbps), so the KPI
// understated capacity about 3.5x.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

// The KPI's own text back to kbps.
function kpiKbps(text) {
  const m = /^([\d.]+) (k|M)bps$/.exec(text);
  assert.ok(m, 'unexpected KPI text ' + JSON.stringify(text));
  return +m[1] * (m[2] === 'M' ? 1000 : 1);
}

test('chain throughput uses each hop\'s own radio on a mixed fleet', () => {
  const { ctx, el } = loadUI();
  el('heteroChk').click();                             // default relay wing: x8 on rfd900x
  const s = ctx.sim.swarm;
  while (s.time < 60) ctx.stepSwarm(s, 0.05);
  for (let k = 0; k < 2; k++) ctx.__raf.pump(250);   // one panel refresh
  const st = ctx.chainStatus(s);
  assert.ok(st.fleetConnected && st.hops.length, 'precondition: a connected chain');
  const radios = st.hops.map(h => ctx.txRadioOf(s, h.a.id, h.b.id));
  assert.ok(radios.some(r => r.id !== s.radio.id), 'precondition: the chain flies a non-tactical radio');
  // Expected: hops sharing a channel split its airtime; channels run in parallel.
  const inv = {};
  for (const r of radios) {
    const k = ctx.channelKeyOf(r);
    inv[k] = (inv[k] || 0) + 1 / (r.airRateKbps * (r.dutyCycle ?? 1));
  }
  const want = Math.min(...Object.values(inv).map(x => 1 / x)) * Math.max(0, 1 - s.net.utilization);
  const got = kpiKbps(el('kpiThroughput').textContent);
  assert.ok(Math.abs(got - want) <= Math.max(1, want * 0.02),
    'KPI ' + got + ' kbps, per-hop capacity ' + want.toFixed(1) + ' kbps');
});

test('a single-radio chain still reads air rate / hops', () => {
  const { ctx, el } = loadUI();
  const s = ctx.sim.swarm;
  while (s.time < 120) ctx.stepSwarm(s, 0.05);
  for (let k = 0; k < 2; k++) ctx.__raf.pump(250);
  const st = ctx.chainStatus(s);
  assert.ok(st.fleetConnected, 'precondition: connected');
  const want = s.radio.airRateKbps / Math.max(1, st.hops.length) * Math.max(0, 1 - s.net.utilization) * (s.radio.dutyCycle ?? 1);
  const got = kpiKbps(el('kpiThroughput').textContent);
  assert.ok(Math.abs(got - want) <= Math.max(1, want * 0.02), got + ' vs ' + want);
});
