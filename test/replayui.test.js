// 'Replay capture…' ran the whole mission synchronously in the FileReader
// callback (about 1 s per 10-minute capture at 10 drones, ~27 s at 120) and
// then only logged one line; the replayed result was thrown away (audit
// ui-render/replay-button-blocking-and-invisible). It now runs in slices
// between frames with progress on the button, and reports whether the
// replay reproduced the capture's own deliveries.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');
const { startReplay, replayMission } = require('../js/replay.js');
const { loadCore } = require('./helpers/sim.js');

function exportedCapture(simSec) {
  const ui = loadUI();
  ui.el('captureChk').click();
  const s = ui.ctx.sim.swarm;
  while (s.time < simSec) ui.ctx.stepSwarm(s, 0.05);
  ui.el('exportBtn').click();
  return { ui, dl: ui.ctx.__downloads[ui.ctx.__downloads.length - 1] };
}

test('the in-page replay yields between slices and ends with a parity summary', () => {
  const { ui, dl } = exportedCapture(60);
  const { ctx, el, fire } = ui;
  const label = el('replayBtn').textContent;
  el('replayInput').files = [makeFile(dl.name, dl.text)];
  fire('replayInput', 'change');
  const said = () => ctx.sim.swarm.events.find(e => /Replayed capture/.test(e.msg));
  assert.ok(!said(), 'the replay must not finish inside the file callback');
  assert.ok(ctx.__timers.queue.length > 0, 'the next slice is queued, so the page keeps rendering');
  assert.ok(el('replayBtn').disabled, 'no second replay while one runs');
  assert.match(el('replayBtn').textContent, /^Replaying… \d+%$/);
  ctx.__raf.pump(16);                                  // the live sim still runs meanwhile
  let slices = 1;
  for (; slices < 200 && el('replayBtn').disabled; slices++) ctx.__timers.run();
  assert.ok(slices > 2, 'a 60 s capture takes several slices');
  assert.deepStrictEqual(ctx.__alerts, []);
  assert.ok(!el('replayBtn').disabled && el('replayBtn').textContent === label, 'the button comes back');
  const line = said();
  assert.ok(line, 'the result is reported');
  assert.match(line.msg, /matches the capture: (\d+) vs \1 deliveries/, line.msg);
  const res = ctx.sim.lastReplay;
  assert.ok(res && res.swarm && res.parity && res.parity.captured > 0, 'the replayed state is kept for inspection');
});

test('a sliced replay steps the same trajectory as a one-shot replay', () => {
  const { dl } = exportedCapture(20);
  const one = replayMission(dl.text, { core: loadCore() });
  const run = startReplay(dl.text, { core: loadCore() });
  let slices = 0;
  while (!run.advance(7)) slices++;
  const sliced = run.result();
  assert.ok(slices > 10);
  assert.strictEqual(sliced.time, one.time);
  assert.strictEqual(sliced.delivered, one.delivered);
  // JSON first: the two runs' objects come from different vm realms.
  assert.strictEqual(JSON.stringify(sliced.dronePositions), JSON.stringify(one.dronePositions));
  assert.strictEqual(one.parity.replayed, one.parity.captured, 'the capture reproduces');
});
