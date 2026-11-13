// The hop table's loss column read 1 - P(smoothed margin), so a hop whose
// packets see a margin at or below 0 dB showed 56%, 84% or 92% loss while
// net.js commitPacket delivers nothing there (`margin > 0 && roll`). The
// column must read 100% whenever the instantaneous margin the delivery gate
// tests (rawMarginDb) is at or below 0 dB.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

// [margin text, loss text] for each hop row of the panel.
function hopRows(el) {
  const rows = [];
  const re = /<td>(-?\d+) dB<\/td><td>(.*?)<\/td><\/tr>/g;
  let m;
  while ((m = re.exec(el('hopsBody').innerHTML))) rows.push([+m[1], m[2]]);
  return rows;
}

test('a hop the delivery gate refuses reads 100% loss', () => {
  const { ctx, el } = loadUI();
  const s = ctx.sim.swarm;
  while (s.time < 60) ctx.stepSwarm(s, 0.05);
  for (let k = 0; k < 2; k++) ctx.__raf.pump(250);
  assert.ok(hopRows(el).length > 1 && hopRows(el).every(r => r[1] === '<1%'), 'precondition: a healthy chain ' + el('hopsBody').innerHTML);
  // Every link now sits just below the gate: the smoothed label still shows
  // the recent healthy margin, but no packet can get through.
  for (const raw of [-1, 0]) {
    ctx.liveMarginDb = () => raw;
    for (let k = 0; k < 2; k++) ctx.__raf.pump(250);
    const rows = hopRows(el);
    assert.ok(rows.length > 0, 'hop rows still drawn');
    for (const [dB, loss] of rows) assert.strictEqual(loss, '100%', raw + ' dB raw, ' + dB + ' dB shown: ' + el('hopsBody').innerHTML);
  }
  // Just above the gate the column is the logistic loss again, not 100%.
  ctx.liveMarginDb = () => 0.5;
  for (let k = 0; k < 2; k++) ctx.__raf.pump(250);
  const st = ctx.chainStatus(s);
  assert.ok(st.hops.length && st.hops.every(h => h.rawMarginDb === 0.5));
  const rows = hopRows(el);
  for (let i = 0; i < rows.length; i++) {
    assert.notStrictEqual(rows[i][1], '100%', 'margin above 0 dB is not a certain loss');
  }
});
