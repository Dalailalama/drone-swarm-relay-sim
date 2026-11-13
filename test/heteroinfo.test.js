// Audit finding ui-render/hetero-info-stale-band-warning: the mixed-fleet info
// panel describes the tactical radio, environment and airframe too, but the
// radio/env/airframe handlers never refreshed it, so switching the tactical
// radio to a different band left the red band-mismatch warning suppressed.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

function heteroOn() {
  const ui = loadUI();
  ui.el('heteroChk').click();
  assert.strictEqual(ui.el('heteroChk').checked, true);
  return ui;
}

test('tactical radio change refreshes the band warning', () => {
  const { el, fire } = heteroOn();
  assert.doesNotMatch(el('heteroInfo').innerHTML, /different radio protocol\/band/);
  el('radioSel').value = 'espnow'; fire('radioSel', 'change');
  assert.match(el('heteroInfo').innerHTML, /different radio protocol\/band/);
  assert.match(el('heteroInfo').innerHTML, /ESP-NOW/);
});

test('environment change refreshes the usable ranges', () => {
  const { el, fire } = heteroOn();
  const before = el('heteroInfo').innerHTML;
  el('envSel').value = 'urban'; fire('envSel', 'change');
  assert.notStrictEqual(el('heteroInfo').innerHTML, before);
});

test('tactical airframe change refreshes the tactical line', () => {
  const { el, fire } = heteroOn();
  el('airframeSel').value = 'micro'; fire('airframeSel', 'change');
  const tactical = el('heteroInfo').innerHTML.split('<b>Tactical:</b>')[1];
  assert.ok(tactical, 'tactical line present');
  assert.match(tactical, /Sub-250/);
});

test('a loaded hetero scenario describes the file\'s wing and tactical radios', () => {
  const { ctx, el, fire } = loadUI();
  const sc = { version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 8, hetero: true, relayWing: 3,
    relayAirframe: 'q450', relayRadio: 'espnow', base: { x: 0, y: 0 }, target: { x: 500, y: -120 } };
  el('loadScenarioInput').files = [makeFile('h.json', JSON.stringify(sc))];
  fire('loadScenarioInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, []);
  assert.match(el('heteroInfo').innerHTML, /ESP-NOW/);
  assert.match(el('heteroInfo').innerHTML, /different radio protocol\/band/);
});

// Audit finding ui-render/relay-wing-exceeds-fleet: the wing slider (max 15)
// ignored the fleet size, so count 3 + wing 15 flew three wing drones and no
// tactical ones while the panel still said "Relay wing 15" and described the
// tactical radio.
test('the relay wing always leaves at least one tactical drone, and the panel says how many of each', () => {
  const { ctx, el, fire } = heteroOn();
  el('countRange').value = '3'; fire('countRange', 'input'); fire('countRange', 'change');
  assert.ok(+el('wingRange').max <= 2, 'wing slider max ' + el('wingRange').max + ' for a fleet of 3');
  assert.ok(+el('wingRange').value <= 2);
  assert.strictEqual(el('wingOut').textContent, el('wingRange').value);
  const s = ctx.sim.swarm;
  const wing = [...s.drones].filter(d => d.radio && d.radio.id !== s.radio.id).length;
  assert.strictEqual(wing, +el('wingRange').value, 'the swarm flies the wing the slider shows');
  assert.ok(s.drones.length - wing >= 1, 'at least one tactical drone');
  assert.match(el('heteroInfo').innerHTML, new RegExp('<b>Tactical:</b> ' + (s.drones.length - wing) + ' × '), el('heteroInfo').innerHTML);
  el('countRange').value = '12'; fire('countRange', 'input');
  assert.strictEqual(el('wingRange').max, '11', 'a bigger fleet frees the slider again');

  const sc = { version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 4, hetero: true, relayWing: 15,
    relayAirframe: 'x8', relayRadio: 'rfd900x', base: { x: 0, y: 0 }, target: { x: 500, y: -120 } };
  el('loadScenarioInput').files = [makeFile('w.json', JSON.stringify(sc))];
  fire('loadScenarioInput', 'change');
  assert.strictEqual(el('wingRange').value, '3', 'a file asking for more wing than fleet is clamped');
  assert.strictEqual(el('wingOut').textContent, '3');
});
