// Audit finding ui-render/scenario-load-stale-toggle-labels: applyScenario set
// the corridor, agility, LPI and video checkboxes but never rewrote their
// <output> status text, so after loading a pack or mission the text could
// describe the opposite state ('Full DDIL' showed every OFF text with all
// three EW/video toggles ON).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');
const { SCENARIO_PACK } = require('../js/scenarios.js');
const { MISSION_LIBRARY } = require('../js/missions.js');

// What each change handler writes for the current control state.
function expected(ctx, el) {
  const radio = ctx.sim.radio;
  return {
    corridorOut: el('corridorChk').checked ? 'transits follow the chain' : 'straight-line transits',
    agilityOut: el('agilityChk').checked
      ? (radio.hopGainDb ? '+' + radio.hopGainDb + ' dB anti-jam on ' + radio.name.split(' ')[0] : 'no hopping capability on this radio')
      : 'anti-jam spectrum agility',
    lpiOut: el('lpiChk').checked ? '−3 dB budget · +6 dB denial rejection' : 'harder to detect, harder to jam',
    videoOut: el('videoChk').checked ? (+el('videoKbpsRange').value) + ' kbps · C2 schedules who streams' : 'payload competes for the chain',
  };
}

function assertLabels(ctx, el, what) {
  const exp = expected(ctx, el);
  for (const [id, text] of Object.entries(exp)) assert.strictEqual(el(id).textContent, text, what + ': ' + id);
}

test('every pack and mission leaves the toggle status texts matching the toggles', () => {
  SCENARIO_PACK.forEach((p, i) => {
    const { ctx, el, fire } = loadUI();
    el('packSel').value = String(i); fire('packSel', 'change'); el('loadPackBtn').click();
    assertLabels(ctx, el, 'pack ' + p.title);
  });
  MISSION_LIBRARY.forEach((m, i) => {
    const { ctx, el, fire } = loadUI();
    el('missionSel').value = String(i); fire('missionSel', 'change'); el('loadMissionBtn').click();
    assertLabels(ctx, el, 'mission ' + (m.title || m.name));
  });
});

test('corridor off by hand, then a corridor:true pack, reads ON again', () => {
  const idx = SCENARIO_PACK.findIndex(p => p.scenario && p.scenario.corridor === true);
  if (idx < 0) return;
  const { ctx, el, fire } = loadUI();
  el('corridorChk').checked = false; fire('corridorChk', 'change');
  assert.strictEqual(el('corridorOut').textContent, 'straight-line transits');
  el('packSel').value = String(idx); fire('packSel', 'change'); el('loadPackBtn').click();
  assert.strictEqual(el('corridorChk').checked, true);
  assert.strictEqual(el('corridorOut').textContent, 'transits follow the chain');
  assertLabels(ctx, el, 'pack ' + SCENARIO_PACK[idx].title);
});

// Review: the agility copy called every radio 'frequency-hopping' — the off
// label (shown whatever the radio), the 'ON' event-log line and the
// 'Disrupted' pack's blurb, which flies a Doodle Mesh Rider (channel/band
// agility, not FHSS). Of the presets only ELRS hops (RADIOS.md).
test('agility copy does not call a non-FHSS radio frequency-hopping', () => {
  const FHSS = /frequency[- ]hopping|FHSS/i;
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const out = /<output id="agilityOut"[^>]*>([^<]*)<\/output>/.exec(html);
  assert.ok(out, 'agilityOut is in index.html');
  assert.doesNotMatch(out[1], FHSS, 'static agility label');
  for (const p of SCENARIO_PACK) {
    if (p.scenario.radio !== 'elrs24') assert.doesNotMatch(p.blurb, FHSS, p.id + ' flies ' + p.scenario.radio);
  }
  const idx = SCENARIO_PACK.findIndex(p => p.id === 'ddil-disrupted');
  const { ctx, el, fire } = loadUI();
  el('packSel').value = String(idx); fire('packSel', 'change'); el('loadPackBtn').click();
  assert.strictEqual(ctx.sim.radio.id, 'doodle-rm', 'precondition: the Disrupted pack flies the Doodle');
  for (const on of [false, true]) {
    el('agilityChk').checked = on; fire('agilityChk', 'change');
    assert.doesNotMatch(el('agilityOut').textContent, FHSS, 'agility ' + (on ? 'on' : 'off') + ' label');
    const last = ctx.sim.swarm.events[ctx.sim.swarm.events.length - 1].msg;
    assert.match(last, /^Spectrum agility /, 'precondition: the toggle logged ' + last);
    assert.doesNotMatch(last, FHSS, 'event log');
  }
  assert.strictEqual(el('agilityOut').textContent, '+13 dB anti-jam on Doodle', 'the on label names the radio\'s own gain');
});
