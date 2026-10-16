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
  assert.doesNotMatch(el('heteroInfo').innerHTML, /different band/);
  el('radioSel').value = 'espnow'; fire('radioSel', 'change');
  assert.match(el('heteroInfo').innerHTML, /different band/);
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
  assert.match(el('heteroInfo').innerHTML, /different band/);
});
