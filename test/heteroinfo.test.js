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

// A browser range input clamps its value to max, and the reset to defaults
// had just set the wing's max to (10-drone fleet - 1) = 9. Setting the
// file's relay wing BEFORE its fleet size clamped a 12-drone wing from a
// 20-drone scenario to 9, so the loaded mission flew a different fleet
// than the file describes.
test('a loaded scenario keeps a relay wing larger than the default fleet allows', () => {
  const { ctx, el, fire } = loadUI({ rangeClamp: true });
  const sc = { version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 20, hetero: true, relayWing: 12,
    relayAirframe: 'x8', relayRadio: 'rfd900x', base: { x: 0, y: 0 }, target: { x: 500, y: -120 } };
  el('loadScenarioInput').files = [makeFile('w12.json', JSON.stringify(sc))];
  fire('loadScenarioInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, []);
  assert.strictEqual(el('wingRange').value, '12', 'the wing slider shows the file\'s wing');
  assert.strictEqual(el('wingOut').textContent, '12');
  const s = ctx.sim.swarm;
  assert.strictEqual(s.drones.length, 20);
  assert.strictEqual(s.relayIdx.length, 12, 'the swarm flies the file\'s 12-drone wing');
});

// The same clamp on the reset to defaults: after a 3-drone fleet (wing max
// 2) the default wing of 4 was written while max was still 2, so a scenario
// that does not name a wing size got a 2-drone wing instead of the default.
test('a scenario without a wing size gets the default wing even after a small fleet', () => {
  const { ctx, el, fire } = loadUI({ rangeClamp: true });
  el('countRange').value = '3'; fire('countRange', 'input'); fire('countRange', 'change');
  assert.strictEqual(el('wingRange').max, '2', 'precondition: a 3-drone fleet caps the wing at 2');
  const sc = { version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 10, hetero: true,
    relayAirframe: 'x8', relayRadio: 'rfd900x', base: { x: 0, y: 0 }, target: { x: 500, y: -120 } };
  el('loadScenarioInput').files = [makeFile('nowing.json', JSON.stringify(sc))];
  fire('loadScenarioInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, []);
  assert.strictEqual(el('wingRange').value, '4', 'the default relay wing');
  assert.strictEqual(ctx.sim.swarm.relayIdx.length, 4);
});
