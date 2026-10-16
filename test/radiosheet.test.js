// Radio presets are pinned to the vendor figures RADIOS.md cites — a preset
// number that drifts from its datasheet (or a sensitivity quoted at the wrong
// air rate) silently shifts every calibrated range in the sim.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../js/radios.js');

const byId = id => R.RADIOS.find(r => r.id === id);

test('SiK V3 sensitivity is the Holybro figure at its 64 kbps air rate', () => {
  const sik = byId('sik-v3');
  assert.strictEqual(sik.airRateKbps, 64);
  assert.strictEqual(sik.sensDbm, -105, 'Holybro V3 spec: -105 dBm @64kbps');
});

test('RFD900x air rate and sensitivity are one row of the x-Series V2.0 table', () => {
  const rfd = byId('rfd900x');
  assert.strictEqual(rfd.airRateKbps, 224);
  assert.strictEqual(rfd.sensDbm, -93, 'x-Series datasheet V2.0 p32: 224 kbit/s -93 dBm');
  assert.strictEqual(rfd.antGainDbi, 3, 'the datasheet stock dipole is 3 dBi');
});

test('MANET presets use the vendor datasheet sensitivity / TX figures', () => {
  // SC4400E datasheet: -102 dBm @ 5 MHz BW; -98 dBm appears nowhere.
  assert.strictEqual(byId('silvus-sc4400').sensDbm, -102);
  // Rajant ES1 spec sheet: "Max. RF Transmit Power 29 dBm ± 2 dB".
  assert.strictEqual(byId('rajant-es1').txDbm, 29);
});

test('RADIOS.md documents every preset, with its source', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'RADIOS.md'), 'utf8');
  for (const r of R.RADIOS) {
    const row = md.split('\n').find(l => l.startsWith('| ' + r.name + ' |'));
    assert.ok(row, r.id + ' has no row in the RADIOS.md table');
    assert.ok(row.includes(r.source), r.id + ' row must cite ' + r.source);
  }
  // hopGainDb has no vendor figure: each value must be listed and labelled.
  const hop = md.slice(md.indexOf('`hopGainDb`'));
  assert.ok(md.includes('`hopGainDb`') && /modelling estimate/.test(hop));
  for (const r of R.RADIOS.filter(x => x.hopGainDb)) {
    const line = hop.split('\n').find(l => l.includes('**' + r.name + '**'));
    assert.ok(line && line.includes(r.hopGainDb + ' dB (estimate)'), r.id + ' hopGainDb not documented');
  }
});

test('hop gain is not presented as a datasheet figure in the code', () => {
  for (const f of ['js/swarm.js', 'js/radios.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/datasheet-class/.test(src), f + ' calls hopGainDb datasheet-class; it is a modelling estimate');
  }
  // Silvus documents single-frequency TDD with interference cancellation /
  // avoidance, not frequency hopping.
  assert.ok(!/frequency-hopping|FHSS/i.test(
    fs.readFileSync(path.join(__dirname, '..', 'js/radios.js'), 'utf8').split("id: 'silvus-sc4400'")[1].split('},')[0]));
});
