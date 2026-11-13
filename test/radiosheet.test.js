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

// Audit radio-datasheets/RAD-7: -108 dBm is ExpressLRS's 250 Hz LoRa figure
// (150 Hz is -112 dBm), and its MAVLink page gives ~590 B/s down + ~300 B/s
// up at 250 Hz (~7 kbps); the preset said 150 Hz and 5 kbps.
test('ExpressLRS sensitivity and telemetry rate are both the 250 Hz figures', () => {
  const elrs = byId('elrs24');
  assert.strictEqual(elrs.sensDbm, -108, 'expresslrs.org signal-health: 250Hz LoRa -108 dBm');
  assert.strictEqual(elrs.airRateKbps, 7, '(590 + 300) B/s at 250 Hz is ~7 kbps of MAVLink');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js/radios.js'), 'utf8').split("id: 'elrs24'")[1].split('},')[0];
  assert.match(src, /250 Hz packet rate/);
  assert.doesNotMatch(src, /150 Hz packet rate|\/ 150 Hz/, 'the preset is not the 150 Hz mode');
  const md = fs.readFileSync(path.join(__dirname, '..', 'RADIOS.md'), 'utf8');
  assert.match(md.split(/\r?\n/).find(l => l.startsWith('| ' + elrs.name + ' |')), /250 Hz/);
  assert.match(md, /expresslrs\.org\/software\/mavlink/, 'cite the MAVLink capacity table');
});

// Audit radio-datasheets/RAD-8: every preset sits inside the band its
// hardware is sold for (Digi: XBee-PRO 900HP is 902-928 MHz, not 900).
test('every ISM preset frequency lies inside its band', () => {
  const bands = {
    'sik-v3': [902, 928], rfd900x: [902, 928], xbee900: [902, 928],
    espnow: [2400, 2483.5], elrs24: [2400, 2483.5], 'doodle-rm': [2400, 2483.5], 'rajant-es1': [2400, 2483.5],
    lora868: [863, 870],
  };
  for (const [id, [lo, hi]] of Object.entries(bands)) {
    const f = byId(id).freqMHz;
    assert.ok(f >= lo && f <= hi, id + ' freqMHz ' + f + ' is outside ' + lo + '-' + hi + ' MHz');
  }
  const md = fs.readFileSync(path.join(__dirname, '..', 'RADIOS.md'), 'utf8');
  assert.match(md.split(/\r?\n/).find(l => l.startsWith('| XBee-PRO 900HP |')), /902–928 MHz/);
  assert.doesNotMatch(md, /15\.5 km/, 'Digi rates 14 km (9 mi) at 10 kbps, not 15.5 km');
});

// Audit radio-datasheets/RAD-9: the cited Espressif page does publish a range
// (200 m in open space); the preset's 300 m is a community figure above it.
test('ESP-NOW notes quote Espressif\'s own 200 m figure', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'RADIOS.md'), 'utf8');
  assert.doesNotMatch(md, /doesn't publish an official range/);
  assert.match(md, /Espressif[^.]*200 m/);
  assert.match(md.split(/\r?\n/).find(l => l.startsWith('| ESP32 ESP-NOW (2.4 GHz) |')), /300 m \(community estimate\)/);
});

// Audit radio-datasheets/RAD-10: Holybro lists the SiK V3 pair at $58.99.
test('the SiK V3 price note matches the Holybro list price', () => {
  assert.doesNotMatch(byId('sik-v3').note, /\$40/);
  assert.match(byId('sik-v3').note, /~\$60\/pair/);
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
