// Finding #23 (review of ffb35e6, B38): a scenario built around a
// calibrated/custom radio saved only the radio's ID. Reloading the file on
// a fresh page found no such radio and silently fell back to the default —
// the calibrated link model was lost without a word. Custom definitions
// must ride in the export and register on import.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

const CAL = {
  id: 'rfd900x-calibrated', name: 'RFD900x (field-calibrated)', calibrated: true,
  freqMHz: 915, txDbm: 30, sensDbm: -105, antGainDbi: 2, airRateKbps: 224,
  rangeLosM: 31000, refPowerDbm: -28.5, nFit: 2.7, note: 'Calibrated against 400 samples',
};

function loadScenario(ui, sc) {
  ui.fire('loadScenarioBtn', 'click');
  ui.el('loadScenarioInput').files = [makeFile('scenario.json', JSON.stringify(sc))];
  ui.fire('loadScenarioInput', 'change');
}

function saveScenario(ui) {
  const captured = [];
  const U = ui.ctx.URL;
  const orig = U.createObjectURL;
  U.createObjectURL = b => { captured.push(b.__text); return orig(b); };
  ui.fire('saveScenarioBtn', 'click');
  U.createObjectURL = orig;
  assert.strictEqual(captured.length, 1, 'save must produce one file');
  return JSON.parse(captured[0]);
}

test('regression #23: a calibrated radio survives export -> fresh page -> import', () => {
  const ui = loadUI();
  loadScenario(ui, {
    version: 1, radio: CAL.id, radioPreset: CAL, env: 'open', airframe: 'q450',
    count: 4, altitudeM: 60, spacingPct: 80, terrain: 'flat', seed: 3,
    target: { x: 500, y: 0 }, jammers: [],
  });
  assert.strictEqual(ui.ctx.sim.radio.id, CAL.id, 'precondition: calibrated radio selected');

  const saved = saveScenario(ui);
  assert.ok(saved.radioPreset, 'export must embed the custom radio definition');
  assert.strictEqual(saved.radioPreset.id, CAL.id);
  assert.strictEqual(saved.radioPreset.nFit, 2.7, 'the fitted exponent must be in the file');

  // A brand-new page (no calibrated radio registered) loads the export.
  const fresh = loadUI();
  loadScenario(fresh, saved);
  assert.strictEqual(fresh.ctx.sim.radio.id, CAL.id,
    'fresh page silently fell back to ' + fresh.ctx.sim.radio.id + ' instead of the calibrated radio');
  assert.strictEqual(fresh.ctx.sim.radio.nFit, 2.7, 'calibrated model must survive the round trip');
});

test('built-in radios stay id-only in exports (guard)', () => {
  const ui = loadUI();
  const saved = saveScenario(ui); // default boot radio is a built-in
  assert.strictEqual(saved.radioPreset, undefined, 'no need to embed shipped radios');
});
