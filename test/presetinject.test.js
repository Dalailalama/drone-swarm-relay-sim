// Finding #7 (review of ffb35e6, B7): scenario JSON can carry radio preset
// objects — and those flowed unvalidated into RADIOS and unescaped into the
// spec card's innerHTML. A file could inject HTML through preset.note,
// silently overwrite a built-in radio's physics by reusing its id, and park
// garbage (non-numeric fields) inside the link-budget math.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadUI, makeFile } = require('./helpers/dom.js');

// Top-level `const RADIOS` in the vm doesn't attach to the context global —
// evaluate inside the context to reach the LIVE array main.js mutates.
function radiosOf(ui) { return vm.runInContext('RADIOS', ui.ctx); }

function loadScenario(ui, sc) {
  ui.fire('loadScenarioBtn', 'click');
  ui.el('loadScenarioInput').files = [makeFile('scenario.json', JSON.stringify(sc))];
  ui.fire('loadScenarioInput', 'change');
}

const BASE = {
  version: 1, env: 'open', airframe: 'q450', count: 4, altitudeM: 60,
  spacingPct: 80, terrain: 'flat', seed: 9, target: { x: 500, y: 0 }, jammers: [],
};

test('regression #7: markup in an imported preset note renders as text, not HTML', () => {
  const ui = loadUI();
  loadScenario(ui, Object.assign({}, BASE, {
    radio: 'evil-1',
    radioPreset: {
      id: 'evil-1', name: 'Evil Radio', note: '<img src=x onerror=window.__pwned=1>INJECTED',
      freqMHz: 915, txDbm: 20, sensDbm: -110, antGainDbi: 2, airRateKbps: 64, rangeLosM: 5000,
    },
  }));
  const card = ui.el('specCard').innerHTML;
  assert.ok(!card.includes('<img'), 'preset.note injected live HTML into the spec card');
  assert.ok(card.includes('INJECTED'), 'the note text itself should still render');
});

test('regression #7: an import reusing a built-in id cannot rewrite its physics', () => {
  const ui = loadUI();
  const stockTx = radiosOf(ui).find(r => r.id === 'sik-v3').txDbm;
  loadScenario(ui, Object.assign({}, BASE, {
    radio: 'sik-v3',
    radioPreset: {
      id: 'sik-v3', name: 'Totally SiK', note: 'trust me',
      freqMHz: 915, txDbm: 59, sensDbm: -140, antGainDbi: 2, airRateKbps: 64, rangeLosM: 4.9e6,
    },
  }));
  const stock = radiosOf(ui).find(r => r.id === 'sik-v3');
  assert.strictEqual(stock.txDbm, stockTx,
    'a scenario file silently rewrote the built-in SiK to ' + stock.txDbm + ' dBm');
});

test('regression #7: non-numeric preset fields never reach the physics', () => {
  const ui = loadUI();
  loadScenario(ui, Object.assign({}, BASE, {
    radio: 'junk-1',
    radioPreset: {
      id: 'junk-1', name: 'Junk', note: 'n',
      freqMHz: 'toString', txDbm: { a: 1 }, sensDbm: null, antGainDbi: [],
      airRateKbps: 'bad', rangeLosM: -5,
    },
  }));
  for (const r of radiosOf(ui)) {
    for (const k of ['freqMHz', 'txDbm', 'sensDbm', 'airRateKbps', 'rangeLosM']) {
      assert.ok(isFinite(r[k]),
        'radio ' + r.id + ' carries non-finite ' + k + ': ' + String(r[k]));
    }
  }
});

test('a well-formed calibrated preset still registers and selects (guard)', () => {
  const ui = loadUI();
  loadScenario(ui, Object.assign({}, BASE, {
    radio: 'rfd900x-calibrated',
    radioPreset: {
      id: 'rfd900x-calibrated', name: 'RFD900x (field-calibrated)', calibrated: true,
      freqMHz: 915, txDbm: 30, sensDbm: -105, antGainDbi: 2, airRateKbps: 224,
      rangeLosM: 31000, refPowerDbm: -28.5, nFit: 2.7, note: 'Calibrated against 400 samples',
    },
  }));
  assert.strictEqual(ui.ctx.sim.radio.id, 'rfd900x-calibrated', 'calibrated preset must be selectable');
  assert.strictEqual(ui.ctx.sim.radio.nFit, 2.7, 'fit exponent must survive import');
});
