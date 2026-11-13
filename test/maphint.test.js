// Browser check (review): the first-run tip is a flex row of text + "Got it",
// but the global `select, button { width: 100% }` rule stretched the button
// across the whole tip, squeezing the text into a ~55 px column (the tip grew
// to ~330 px tall and covered the map). The tip's own button rule must undo
// the global width.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the first-run tip button does not inherit the global 100% button width', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
  assert.match(css, /select,\s*button\s*\{[^}]*width:\s*100%/, 'global button width rule moved; re-check this test');
  const rule = css.match(/#mapHint\s+button\s*\{([^}]*)\}/);
  assert.ok(rule, '#mapHint button rule exists');
  assert.match(rule[1], /width:\s*auto/, '#mapHint button must reset width so the tip text gets the row');
});
