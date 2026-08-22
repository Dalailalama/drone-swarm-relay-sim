// Anti-jam spectrum agility + LPI/LPD tests — the quantified-recovery story:
// hopping radios shed a datasheet-class amount of interference, LPI trades
// link budget for survivability, and the net effect is measurable uptime.

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const AGILITY = ctx.consts.AGILITY;

// The frequency-hopping radio under test: Doodle Labs Mesh Rider, +13 dB.
const DOODLE = R.RADIOS.find(r => r.id === 'doodle-rm');

function makeSw(opts) {
  return ctx.makeSwarm(Object.assign({
    count: 4,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: DOODLE,
    envFactor: 1,
    targetX: 2000, targetY: -500,
    altitudeM: 60,
    seed: 5,
    // Deterministic jammer near the launch circle so DR-1 (spawned at
    // (60, 0), ~149 m away) is firmly jammed but not blacked out.
    jammers: [{ id: 'JX-1', x: 200, y: -50, erpDbm: 24, band: 'all', altM: 15, on: true }],
  }, opts));
}

function marginC2ToFirst(s) {
  for (const d of s.drones) if (ctx.alive(d)) return ctx.liveMarginDb(s, 'C2', d.id);
  return -Infinity;
}

test('frequency-agile presets carry a realistic hop gain; plain radios do not', () => {
  const agile = R.RADIOS.filter(r => r.hopGainDb);
  const ids = agile.map(r => r.id).sort();
  assert.deepStrictEqual(ids, ['doodle-rm', 'elrs24', 'silvus-sc4400'],
    'exactly the FHSS/MANET presets should declare hop gain');
  for (const r of agile) {
    assert.ok(r.hopGainDb >= 10 && r.hopGainDb <= 18,
      r.id + ' hop gain ' + r.hopGainDb + ' dB outside plausible 10-18 dB band');
  }
});

test('spectrum agility recovers margin under jamming — bounded by hop gain', () => {
  const mOff = marginC2ToFirst(makeSw({}));
  const mOn = marginC2ToFirst(makeSw({ spectrumAgility: true }));
  const gain = mOn - mOff;
  assert.ok(gain > 1, 'expected clear recovery under jamming, got ' + gain.toFixed(1) + ' dB');
  assert.ok(gain <= DOODLE.hopGainDb + 0.01,
    'recovery must not exceed the preset\u2019s hop gain: ' + gain.toFixed(1) + ' dB');
});

test('agility changes nothing on a clean spectrum', () => {
  const mk = agil => makeSw({ spectrumAgility: agil, jammers: [] });
  const a = marginC2ToFirst(mk(false)), b = marginC2ToFirst(mk(true));
  assert.ok(Math.abs(a - b) < 0.5, 'no jammer, no difference — got ' + (a - b).toFixed(2) + ' dB');
});

test('LPI mode pays exactly its budget cost when nobody is jamming', () => {
  const off = makeSw({ jammers: [] });
  const on = makeSw({ jammers: [], lpiMode: true });
  const diff = marginC2ToFirst(off) - marginC2ToFirst(on);
  assert.ok(Math.abs(diff - AGILITY.lpiCostDb) < 0.01,
    'clean-spectrum LPI cost should be exactly ' + AGILITY.lpiCostDb + ' dB, got ' + diff.toFixed(2));
});

test('under heavy jamming LPI nets positive (cost < denial rejection)', () => {
  const off = makeSw({ spectrumAgility: true });
  const on = makeSw({ spectrumAgility: true, lpiMode: true });
  const net = marginC2ToFirst(on) - marginC2ToFirst(off);
  const expected = AGILITY.lpiDenyReductionDb - AGILITY.lpiCostDb; // +3 dB
  assert.ok(Math.abs(net - expected) < 0.01,
    'LPI net effect under fire should be exactly +' + expected + ' dB, got ' + net.toFixed(2));
});

test('denial zone shrinks when the chain radio hops', () => {
  const sOff = makeSw({});
  const sOn = makeSw({ spectrumAgility: true });
  const rOff = ctx.jammerDenialRadiusM(sOff, sOff.jammers[0]);
  const rOn = ctx.jammerDenialRadiusM(sOn, sOn.jammers[0]);
  assert.ok(rOn < rOff * 0.9,
    'agile chain must see a smaller denied zone: ' + rOff.toFixed(0) + ' -> ' + rOn.toFixed(0) + ' m');
});

test('uptime accounting: an agile swarm holds the link through jamming longer', () => {
  function run(agility) {
    const s = makeSw({
      count: 8,
      spectrumAgility: agility,
      envFactor: 0.45,           // suburban: margins are honest, not luxurious
      targetX: 2600, targetY: -650,
      jammers: [{ id: 'JX-mid', x: 1200, y: -300, erpDbm: 22, band: 'all', altM: 15, on: true }],
    });
    let st = null;
    while (s.time < 240) st = ctx.stepSwarm(s, 0.25);
    return 100 * s.stats.connSec / s.stats.tSec;
  }
  const upOn = run(true), upOff = run(false);
  assert.ok(upOn >= upOff,
    'agility must never hurt uptime: on=' + upOn.toFixed(1) + '% off=' + upOff.toFixed(1) + '%');
});
