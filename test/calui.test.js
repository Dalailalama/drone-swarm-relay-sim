// Calibration panel UI: the fit readout and the failure reasons must be
// visible. calResult starts hidden in index.html (so the empty panel takes no
// space at boot); every branch that writes into it has to reveal it.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

// Clean two-decade dist,rssi log: n = 2.7, A = -30 dBm, tiny deterministic wobble.
function csvFor(n, A) {
  const rows = ['dist,rssi'];
  let k = 0;
  for (let d = 10; d <= 2000; d *= 1.25) {
    rows.push(d.toFixed(2) + ',' + (A - 10 * n * Math.log10(d) + ((k++ % 3) - 1) * 0.5).toFixed(2));
  }
  return rows.join('\n');
}

function loadCsv(ui, name, text) {
  ui.el('calFileInput').files = [makeFile(name, text, 'text/csv')];
  ui.fire('calFileInput', 'change');
}

test('calibration: loaded, fitted and failed states are all visible in the panel', () => {
  const ui = loadUI();
  const res = ui.el('calResult');
  assert.strictEqual(res.style.display, 'none', 'empty panel hidden at boot');

  loadCsv(ui, 'walk.csv', csvFor(2.7, -30));
  assert.notStrictEqual(res.style.display, 'none', 'load message hidden');
  assert.ok(res.textContent.includes('ready to fit'));

  ui.fire('calFitBtn', 'click');
  assert.notStrictEqual(res.style.display, 'none', 'fit readout hidden');
  assert.ok(res.innerHTML.includes('Fit complete'), res.innerHTML);
  assert.strictEqual(ui.el('calOutRow').style.display, 'flex');

  loadCsv(ui, 'bad.csv', 'hello,world');
  ui.fire('calFitBtn', 'click');
  assert.notStrictEqual(res.style.display, 'none', 'failure reason hidden');
  assert.ok(res.innerHTML.includes('Fit failed'), res.innerHTML);
  assert.strictEqual(ui.el('calOutRow').style.display, 'none');
});

// Audit calibrate-ui-silent-reject: the panel used to say 'Fit complete' while
// registerRadioPreset silently refused the preset (n in (6.5,8), intercept
// outside -120..40, range outside the sanitizer bounds).
function radioOptionCount(ui) { return ui.el('radioSel').children.length; }

for (const [label, n, A] of [['n = 7.0', 7.0, -30], ['n = 1.25 (range beyond sanitizer bound)', 1.25, -30]]) {
  test('regression: a fit the preset sanitizer refuses is reported as rejected (' + label + ')', () => {
    const ui = loadUI();
    const before = radioOptionCount(ui);
    loadCsv(ui, 'walk.csv', csvFor(n, A));
    ui.fire('calFitBtn', 'click');
    const html = ui.el('calResult').innerHTML;
    if (radioOptionCount(ui) === before) {
      assert.ok(!html.includes('Fit complete'), 'says Fit complete but registered nothing: ' + html);
      assert.ok(/rejected|failed/i.test(html), html);
      assert.strictEqual(ui.el('calOutRow').style.display, 'none', 'downloads offered for a rejected preset');
    }
  });
}

test('calibration: an empty file says so instead of staying silent', () => {
  const ui = loadUI();
  loadCsv(ui, 'empty.csv', '');
  const res = ui.el('calResult');
  assert.notStrictEqual(res.style.display, 'none');
  assert.ok(res.textContent.includes('empty'), res.textContent);
  assert.strictEqual(ui.el('calFitBtn').disabled, true);
});
