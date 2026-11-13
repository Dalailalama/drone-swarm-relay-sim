// TAK panel state in the page.
//  ui-render/tak-list-stale-after-relaunch: imported CoT marks lived only on
//      the swarm, so any relaunch dropped them from the map while the panel
//      kept listing them with 'objective' buttons that silently did nothing.
//  ui-render/tak-stream-error-overwritten: a failed 'Stream to TAK' showed
//      'bridge closed' (onclose ran after onerror), and the click itself set
//      no 'connecting' state.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

const COT = [
  '<?xml version="1.0"?><events>',
  '<event version="2.0" uid="H-1" type="a-h-G" how="m-g"><point lat="38.9000000" lon="-77.0300000" hae="0" ce="9" le="9"/><detail><contact callsign="Hostile-1"/></detail></event>',
  '<event version="2.0" uid="F-2" type="a-f-G" how="m-g"><point lat="38.8990000" lon="-77.0340000" hae="0" ce="9" le="9"/><detail><contact callsign="Friendly-2"/></detail></event>',
  '</events>',
].join('\n');

const objButtons = el => (el('takList').innerHTML.match(/class="tak-obj"/g) || []).length;

test('imported CoT marks survive a relaunch, and every listed objective button still works', () => {
  const { ctx, el, fire } = loadUI();
  el('takImportInput').files = [makeFile('marks.xml', COT, 'application/xml')];
  fire('takImportInput', 'change');
  assert.strictEqual(ctx.sim.swarm.takMarks.length, 2);
  const before = ctx.sim.swarm.takMarks.map(m => [m.callsign, m.x, m.y].join(':')).join(' ');
  el('resetBtn').click();
  const s = ctx.sim.swarm;
  assert.strictEqual(s.takMarks.length, objButtons(el), 'the list must describe the marks the map draws');
  assert.strictEqual(s.takMarks.length, 2, 'geographic marks outlive a relaunch');
  assert.strictEqual(s.takMarks.map(m => [m.callsign, m.x, m.y].join(':')).join(' '), before, 'same anchor, same place');
  const btn = { dataset: { i: '1' } };
  btn.closest = () => btn;
  fire('takList', 'click', { target: btn });
  assert.ok(s.target.x === s.takMarks[1].x && s.target.y === s.takMarks[1].y, 'the objective button moves the target');

  el('takClearBtn').click();
  el('resetBtn').click();
  assert.strictEqual(ctx.sim.swarm.takMarks.length, 0);
  assert.strictEqual(el('takList').textContent, '', 'an empty list after Clear marks + relaunch');
  assert.strictEqual(el('takClearBtn').style.display, 'none');
});

test('a TAK stream that never connects says the bridge is unreachable, after saying it is connecting', () => {
  const { ctx, el } = loadUI();
  el('takConnectBtn').click();
  assert.match(el('takStatus').textContent, /^connecting to /, 'the click shows a connecting state');
  const ws = ctx.__sockets[ctx.__sockets.length - 1];
  ws.onerror({ type: 'error' });
  ws.close();                                          // browsers fire close right after error
  assert.match(el('takStatus').textContent, /unreachable/, el('takStatus').textContent);

  el('takConnectBtn').click();                         // a stream that did open and then drops
  const ws2 = ctx.__sockets[ctx.__sockets.length - 1];
  ws2.__open();
  ws2.close();
  assert.match(el('takStatus').textContent, /closed/);
});
